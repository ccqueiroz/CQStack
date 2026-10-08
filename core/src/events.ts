import { Ajv } from "ajv";
import { ROOT_STATES, TRACKS, type Graph, type RootState, type Track } from "./graph.js";
import type { ProjectProfile } from "./profile.js";
import { readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { ID_PATTERN, StateError, assertNoSymlinks, canonicalHash } from "./storage.js";

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

const validateEvent = new Ajv({ allErrors: true, strict: true }).compile(EVENT_SCHEMA);

export function eventViolations(value: unknown): string[] {
  if (validateEvent(value)) return [];
  return (validateEvent.errors ?? []).map((error) => {
    const field = error.params.additionalProperty;
    return `${error.instancePath || "/"} ${error.message}${field === undefined ? "" : ` (${field})`}`;
  });
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
    this.harnessVersion = harnessVersion;
  }

  events(rootId: string): Event[] {
    return this.read(rootId, this.files(rootId).log).events;
  }

  state(rootId: string): RootView {
    return this.read(rootId, this.files(rootId).log).view;
  }

  private files(rootId: unknown): { log: string } {
    // typeof first: ID_PATTERN.test(undefined) would test the text "undefined"
    if (typeof rootId !== "string" || !ID_PATTERN.test(rootId))
      throw new StateError("ROOT_ID_INVALID", `Root id must match ${ID_PATTERN.source}: ${String(rootId)}`);
    return { log: join(this.stateDir, `${rootId}.jsonl`) };
  }

  private read(rootId: string, file: string): { events: Event[]; view: RootView } {
    assertNoSymlinks(file);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
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
    return { events, view: deriveView(rootId, events) };
  }
}
