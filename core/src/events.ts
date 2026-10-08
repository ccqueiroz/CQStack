import { Ajv } from "ajv";
import { ROOT_STATES, TRACKS, type Graph, type RootState, type Track } from "./graph.js";
import type { Observation } from "./observation.js";
import type { ProjectProfile } from "./profile.js";
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { ID_PATTERN, StateError, appendLine, asWritten, assertTrustedPath, canonicalHash, readText, syncFolder, withMutex } from "./storage.js";

export type ActorKind = "harness" | "human" | "worker";
export interface Actor {
  kind: ActorKind;
  id: string;
  role?: string;
}

export interface HarnessVersion {
  tag: string | null;
  commit: string;
}

export interface Event {
  seq: number;
  ts: string;
  root_id: string;
  task_id: string;
  event_type: string;
  actor: Actor;
  reason?: string;
  cause_event_id?: string;
  graph?: Graph;
  graph_hash: string;
  harness_version: HarnessVersion;
  session_id?: string;
  item_id?: string;
  payload_ref?: string;
  payload_hash?: string;
}

export interface RootView {
  root_id: string;
  track: Track;
  state: RootState;
  revision: number;
  graph_hash: string;
}

const objectSchema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const TEXT_SCHEMA = { type: "string", minLength: 1 };
const ID_SCHEMA = { type: "string", pattern: ID_PATTERN.source };
const HASH_SCHEMA = { type: "string", pattern: "^[0-9a-f]{64}$" };
const STATE_SCHEMA = { enum: [...ROOT_STATES] };
const STATE_ALTERNATIVES = ROOT_STATES.join("|");

export const EVENT_SCHEMA = {
  type: "object",
  properties: {
    seq: { type: "integer", minimum: 1 },
    ts: TEXT_SCHEMA,
    root_id: ID_SCHEMA,
    task_id: ID_SCHEMA,
    event_type: {
      type: "string",
      pattern: `^(?:task\\.created|provider\\.observed|transition\\.(?:${STATE_ALTERNATIVES})\\.(?:${STATE_ALTERNATIVES}))$`,
    },
    actor: objectSchema({ kind: { enum: ["harness", "human", "worker"] }, id: TEXT_SCHEMA, role: TEXT_SCHEMA }, ["kind", "id"]),
    reason: TEXT_SCHEMA,
    cause_event_id: TEXT_SCHEMA,
    graph: objectSchema(
      {
        track: { enum: [...TRACKS] },
        stages: { type: "array", uniqueItems: true, items: ID_SCHEMA },
        edges: { type: "array", items: objectSchema({ from: STATE_SCHEMA, to: STATE_SCHEMA }, ["from", "to"]) },
      },
      ["track", "stages", "edges"],
    ),
    graph_hash: HASH_SCHEMA,
    harness_version: objectSchema(
      {
        tag: { type: ["string", "null"], minLength: 1 },
        commit: { type: "string", pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" },
      },
      ["tag", "commit"],
    ),
    session_id: TEXT_SCHEMA,
    item_id: ID_SCHEMA,
    payload_ref: TEXT_SCHEMA,
    payload_hash: HASH_SCHEMA,
  },
  required: ["seq", "ts", "root_id", "task_id", "event_type", "actor", "graph_hash", "harness_version"],
  additionalProperties: false,
  dependencies: {
    graph: { type: "object", properties: { event_type: { const: "task.created" } } },
    payload_ref: ["payload_hash"],
    payload_hash: ["payload_ref"],
  },
};

const ajv = new Ajv({ allErrors: true, strict: true });
const validateEvent = ajv.compile(EVENT_SCHEMA);
// the graph alone, so create refuses a graph with no JSON text (asWritten gives undefined) before canonicalHash throws a TypeError on it
const validateGraph = ajv.compile(EVENT_SCHEMA.properties.graph);
// the shape observeProcess returns, checked for the same reason before the observation is hashed into payload_hash
const NUMBER_SCHEMA = { type: "number" };
const TEXT_LIST_SCHEMA = { type: "array", items: { type: "string" } };
const validateObservation = ajv.compile(
  objectSchema(
    {
      root_id: ID_SCHEMA,
      item_id: ID_SCHEMA,
      command: { type: "string" },
      timeout_ms: NUMBER_SCHEMA,
      elapsed_ms: NUMBER_SCHEMA,
      exit_code: { type: ["number", "null"] },
      signal: { type: ["string", "null"] },
      prompt_bytes: NUMBER_SCHEMA,
      prompt_hash: HASH_SCHEMA,
      stdout_bytes: NUMBER_SCHEMA,
      stdout_hash: HASH_SCHEMA,
      stderr_bytes: NUMBER_SCHEMA,
      stderr_hash: HASH_SCHEMA,
      stderr: { type: "string" },
      errors: TEXT_LIST_SCHEMA,
      tool_calls: TEXT_LIST_SCHEMA,
    },
    ["root_id", "command", "timeout_ms", "elapsed_ms", "exit_code", "signal", "prompt_bytes", "prompt_hash", "stdout_bytes",
      "stdout_hash", "stderr_bytes", "stderr_hash", "stderr", "errors", "tool_calls"],
  ),
);

export function eventViolations(value: unknown): string[] {
  if (validateEvent(value)) return [];
  return (validateEvent.errors ?? []).map((error) => {
    const field = error.params.additionalProperty;
    return `${error.instancePath || "/"} ${error.message}${field === undefined ? "" : ` (${field})`}`;
  });
}

const HUMAN_TARGETS: readonly string[] = ["DECIDED", "PLAN_APPROVED", "LOTE_MERGED"];
const ID_RULES: Record<ActorKind, string> = {
  human: "the profile commit_identity.email",
  harness: "the harness tag, or the commit outside a tag",
  worker: `a task id matching ${ID_PATTERN.source}`,
};

function kindOf(eventType: string): ActorKind {
  if (eventType === "task.created") return "human";
  if (eventType === "provider.observed") return "worker";
  const [, from, to] = eventType.split(".");
  return HUMAN_TARGETS.includes(to) || from === "NEEDS_HUMAN" ? "human" : "harness";
}

function requireActor(actor: Actor | null | undefined): Actor {
  if (typeof actor !== "object" || actor === null)
    throw new StateError("ACTOR_REQUIRED", "Every event needs an actor {kind, id, role?}; there is no default.");
  return actor;
}

const isEdge = (graph: Graph, from: string, to: string) => graph.edges.some((edge) => edge.from === from && edge.to === to);

// The revision counts transitions only, so an observation between two transitions never makes it stale.
function deriveView(rootId: string, events: Event[]): RootView {
  const graph = events[0].graph!;
  let state: RootState = "TASK_RECEIVED";
  let revision = 0;
  for (const event of events) {
    if (!event.event_type.startsWith("transition.")) continue;
    const [, from, to] = event.event_type.split(".");
    if (from !== state || !isEdge(graph, from, to))
      throw new StateError("TRANSITION_NOT_IN_GRAPH", `Recorded transition is not an edge of the recorded graph: ${from} -> ${to}`);
    state = to as RootState;
    revision += 1;
  }
  return { root_id: rootId, track: graph.track, state, revision, graph_hash: events[0].graph_hash };
}

export class EventLog {
  private readonly stateDir: string;
  private readonly profile: ProjectProfile;
  private readonly harnessVersion: HarnessVersion;

  constructor(stateDir: string | undefined, profile: ProjectProfile, harnessVersion: HarnessVersion) {
    // normalized only: the disk resolves "link/.." through the link, while join() drops it as text
    if (typeof stateDir !== "string" || stateDir.trim() === "" || !isAbsolute(stateDir) || normalize(stateDir) !== stateDir)
      throw new StateError("STATE_DIR_INVALID", `State directory must be a non-empty, absolute, normalized path: ${String(stateDir)}`);
    this.stateDir = stateDir;
    this.profile = profile;
    // copied here and into each event, so neither the caller nor a returned event changes the version read at boot; copied as its JSON
    // line carries it, so the harness actor id is checked against the version the events write (none, or null: an empty version)
    this.harnessVersion = (asWritten({ ...harnessVersion }) ?? {}) as HarnessVersion;
  }

  create(rootId: string, request: { graph?: Graph | null; actor?: Actor | null }): Event {
    const { log, lock } = this.files(rootId);
    // a request that is not an object has none of its fields, so it gets the code of the first missing one
    const { graph, actor } = request ?? {};
    if (graph === undefined || graph === null)
      throw new StateError("GRAPH_MISSING", `Root has no graph recorded in task.created: ${rootId}`);
    const author = requireActor(actor);
    const recorded = asWritten(graph) as Graph;
    if (!validateGraph(recorded)) throw new StateError("EVENT_SCHEMA_VIOLATION", `Graph does not match the schema of task.created: ${rootId}`);
    assertTrustedPath(log);
    // sealed before the folder exists: seq is always 1 and the seal reads no log, so its refusals leave no folder behind
    const event = this.seal(rootId, { seq: 1, event_type: "task.created", actor: author, graph: recorded, graph_hash: canonicalHash(recorded) });
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      // recursive mkdir gives EEXIST when the state directory is a file and ENOTDIR when a folder above it is
      if (["EEXIST", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw new StateError("STATE_DIR_INVALID", `State directory or a folder above it is not a folder: ${this.stateDir}`);
      throw error;
    }
    return withMutex(lock, () => {
      if (existsSync(log)) {
        this.read(rootId, log);
        throw new StateError("ROOT_EXISTS", `Root already has task.created: ${log}`);
      }
      appendLine(log, JSON.stringify(event));
      // ponytail: folders mkdirSync made above the state folder are not synced; sync them if a first create must survive a power loss
      syncFolder(this.stateDir);
      return event;
    });
  }

  transition(
    rootId: string,
    request: { to: RootState; expected_revision: number; graph_hash: string; actor?: Actor | null },
  ): Event {
    const { log, lock } = this.files(rootId);
    const author = requireActor(request?.actor);
    // read once: a getter could pass the edge check with one target and write another
    const { to, expected_revision, graph_hash } = request;
    assertTrustedPath(log);
    // checked before the mutex, so a missing state directory never gets a lock file
    if (!existsSync(log)) throw new StateError("ROOT_NOT_FOUND", `Root has no event log: ${log}`);
    return withMutex(lock, () => {
      const { events, view } = this.read(rootId, log);
      if (graph_hash !== view.graph_hash)
        throw new StateError("GRAPH_MISMATCH", `Graph differs from the one recorded in task.created: ${rootId}`);
      if (expected_revision !== view.revision)
        throw new StateError(
          "REVISION_STALE",
          `Expected revision ${expected_revision}, current revision is ${view.revision}: ${rootId}`,
        );
      if (!isEdge(events[0].graph!, view.state, to))
        throw new StateError("TRANSITION_NOT_IN_GRAPH", `Transition is not an edge of the recorded graph: ${view.state} -> ${to}`);
      const event = this.seal(rootId, {
        seq: events.length + 1,
        event_type: `transition.${view.state}.${to}`,
        actor: author,
        graph_hash: view.graph_hash,
      });
      appendLine(log, JSON.stringify(event));
      return event;
    });
  }

  recordObservation(rootId: string, request: { actor?: Actor | null; observation: Observation; payload_ref: string }): Event {
    const { log, lock } = this.files(rootId);
    const author = requireActor(request?.actor);
    const given = request.observation;
    const written = asWritten(given) as Observation | undefined;
    // with no JSON text the attribution is read as given, so a malformed item_id keeps its code
    const observation = written === undefined ? given : written;
    const itemId = observation?.item_id;
    if (observation?.root_id !== rootId || (itemId !== undefined && !(typeof itemId === "string" && ID_PATTERN.test(itemId))))
      throw new StateError(
        "OBSERVATION_ATTRIBUTION_INVALID",
        "Observation needs the root_id of its root and, when given, a valid item_id",
      );
    if (!validateObservation(written))
      throw new StateError("OBSERVATION_INPUT_INVALID", "Observation needs a process request and outcome with the documented field types");
    assertTrustedPath(log);
    if (!existsSync(log)) throw new StateError("ROOT_NOT_FOUND", `Root has no event log: ${log}`);
    return withMutex(lock, () => {
      const { events } = this.read(rootId, log);
      const event = this.seal(rootId, {
        seq: events.length + 1,
        event_type: "provider.observed",
        actor: author,
        graph_hash: events[0].graph_hash,
        ...(observation.item_id === undefined ? {} : { item_id: observation.item_id }),
        payload_ref: request.payload_ref,
        payload_hash: canonicalHash(observation),
      });
      appendLine(log, JSON.stringify(event));
      return event;
    });
  }

  events(rootId: string): Event[] {
    return this.read(rootId, this.files(rootId).log).events;
  }

  state(rootId: string): RootView {
    return this.read(rootId, this.files(rootId).log).view;
  }

  // The kind comes from the event type, in code (decision 43); a different caller kind is refused, never rewritten.
  private seal(rootId: string, fields: Omit<Event, "ts" | "root_id" | "task_id" | "harness_version">): Event {
    const expectedKind = kindOf(fields.event_type);
    const { seq, event_type, ...rest } = fields;
    const event = { seq, ts: new Date().toISOString(), root_id: rootId, task_id: rootId, event_type, ...rest, harness_version: { ...this.harnessVersion } };
    const written = asWritten(event) as Event | undefined;
    // with no JSON text nothing is written, so the actor is checked as given and keeps the code of its field
    const actor = requireActor((written ?? event).actor);
    if (actor.kind !== expectedKind)
      throw new StateError("ACTOR_KIND_MISMATCH", `${fields.event_type} is written by kind ${expectedKind}, not ${String(actor.kind)}`);
    const idIsValid =
      expectedKind === "human"
        ? actor.id === this.profile?.commit_identity?.email
        : expectedKind === "harness"
          ? actor.id === (this.harnessVersion.tag ?? this.harnessVersion.commit)
          : typeof actor.id === "string" && ID_PATTERN.test(actor.id);
    if (!idIsValid) throw new StateError("ACTOR_ID_INVALID", `Actor id for kind ${expectedKind} must be ${ID_RULES[expectedKind]}: ${String(actor.id)}`);
    const violations = eventViolations(written);
    if (violations.length > 0) throw new StateError("EVENT_SCHEMA_VIOLATION", `Event does not match the schema: ${violations.join("; ")}`);
    return written as Event;
  }

  private files(rootId: unknown): { log: string; lock: string } {
    // typeof first: ID_PATTERN.test(undefined) would test the text "undefined"
    if (typeof rootId !== "string" || !ID_PATTERN.test(rootId))
      throw new StateError("ROOT_ID_INVALID", `Root id must match ${ID_PATTERN.source}: ${String(rootId)}`);
    return { log: join(this.stateDir, `${rootId}.jsonl`), lock: join(this.stateDir, `${rootId}.lock`) };
  }

  private read(rootId: string, file: string): { events: Event[]; view: RootView } {
    assertTrustedPath(file);
    let text: string;
    try {
      text = readText(file);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw new StateError("ROOT_NOT_FOUND", `Root has no event log: ${file}`);
      throw error;
    }
    if (!text.endsWith("\n")) throw new StateError("LOG_TRUNCATED", `Event log does not end with a newline: ${file}`);
    const events = text
      .slice(0, -1)
      .split("\n")
      .map((line, index) => {
        const invalid = (reason: string) =>
          new StateError("LOG_LINE_INVALID", `Event log line ${index + 1} is invalid: ${file}: ${reason}`);
        let event: Event;
        try {
          event = JSON.parse(line);
        } catch {
          throw invalid("not JSON");
        }
        const violations = eventViolations(event);
        if (violations.length > 0) throw invalid(violations.join("; "));
        if (event.root_id !== rootId) throw invalid(`root_id ${event.root_id} is not ${rootId}`);
        return event;
      });
    const created = events[0];
    if (created.event_type !== "task.created" || created.graph === undefined)
      throw new StateError("GRAPH_MISSING", `Root has no graph recorded in task.created: ${rootId}`);
    // the graph is checked against its own hash in the same event, not against other events (decision 38: no hash chain)
    if (canonicalHash(created.graph) !== created.graph_hash || events.some((event) => event.graph_hash !== created.graph_hash))
      throw new StateError("GRAPH_MISMATCH", `Graph differs from the one recorded in task.created: ${rootId}`);
    // checked after the first event and the graph_hash of every event, so those two keep their own codes
    const recreated = events.findIndex((event, index) => index > 0 && event.event_type === "task.created");
    if (recreated !== -1)
      throw new StateError("LOG_LINE_INVALID", `Event log line ${recreated + 1} is invalid: ${file}: task.created is only the first line`);
    // (root_id, seq) is the event identity and the root is the only task, so seq is the line number and task_id the root id
    const misplaced = events.findIndex((event, index) => event.seq !== index + 1 || event.task_id !== rootId);
    if (misplaced !== -1)
      throw new StateError("LOG_LINE_INVALID", `Event log line ${misplaced + 1} is invalid: ${file}: seq is not the line number or task_id is not the root`);
    return { events, view: deriveView(rootId, events) };
  }
}
