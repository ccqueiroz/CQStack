import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateError, appendLine, canonicalHash, readText, type StateErrorCode } from "../src/storage.js";
import { buildGraph, type RootState, type Track } from "../src/graph.js";
import { EVENT_SCHEMA, EventLog, eventViolations, type Actor, type Event, type HarnessVersion } from "../src/events.js";
import { PROFILE_FILE_NAME, loadProfile, type ProjectProfile } from "../src/profile.js";
import { observeProcess, type Observation } from "../src/observation.js";

const V1: HarnessVersion = { tag: "v9.9.9", commit: "1".repeat(40) };
const V2: HarnessVersion = { tag: null, commit: "2".repeat(40) };

const temporaryDirectories: string[] = [];
after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "cqstack-events-")));
  temporaryDirectories.push(directory);
  return directory;
}

function fictitiousProfile(): ProjectProfile {
  const projectRoot = temporaryDirectory();
  writeFileSync(
    join(projectRoot, PROFILE_FILE_NAME),
    JSON.stringify({
      project_id: "acme-toy",
      language: { default: "en", by_artifact: {} },
      commit_identity: { name: "Ada Example", email: "ada@example.com" },
      providers_required: ["alpha-llm"],
      repositories: [{ id: "app", path: "." }],
      knowledge_store: { deliveries_dir: "deliveries" },
    }),
  );
  return loadProfile(projectRoot);
}
const PROFILE = fictitiousProfile();

function expectStateError(action: () => unknown, code: StateErrorCode, label = ""): void {
  assert.throws(action, (error: unknown) => error instanceof StateError && error.code === code, `${code} ${label}`);
}

function withCwd(directory: string, action: () => void): void {
  const original = process.cwd();
  process.chdir(directory);
  try {
    action();
  } finally {
    process.chdir(original);
  }
}

function handLog(rootId: string, track: Track, path: RootState[], version: HarnessVersion = V1): Record<string, unknown>[] {
  const graph = buildGraph(track);
  const graphHash = canonicalHash(graph);
  const events: Record<string, unknown>[] = [
    {
      seq: 1,
      ts: "2026-10-07T00:00:00.000Z",
      root_id: rootId,
      task_id: rootId,
      event_type: "task.created",
      actor: { kind: "human", id: "ada@example.com" },
      graph,
      graph_hash: graphHash,
      harness_version: version,
    },
  ];
  let from: RootState = "TASK_RECEIVED";
  for (const to of path) {
    events.push({
      seq: events.length + 1,
      ts: "2026-10-07T00:00:01.000Z",
      root_id: rootId,
      task_id: rootId,
      event_type: `transition.${from}.${to}`,
      actor: { kind: "harness", id: "v9.9.9" },
      graph_hash: graphHash,
      harness_version: version,
    });
    from = to;
  }
  return events;
}

function observedLine(rootId: string, seq: number, graphHash: string): Record<string, unknown> {
  return {
    seq,
    ts: "2026-10-07T00:00:02.000Z",
    root_id: rootId,
    task_id: rootId,
    event_type: "provider.observed",
    actor: { kind: "worker", id: "child-1" },
    graph_hash: graphHash,
    harness_version: V1,
    item_id: "item-1",
    payload_ref: "observations/one.json",
    payload_hash: "c".repeat(64),
  };
}

function writeLog(stateDir: string, rootId: string, events: unknown[], tail = "\n"): string {
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, `${rootId}.jsonl`);
  writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n") + tail);
  return file;
}
const GRAPH_L = buildGraph("L");

function createdEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 1,
    ts: "2026-10-07T00:00:00.000Z",
    root_id: "r1",
    task_id: "r1",
    event_type: "task.created",
    actor: { kind: "human", id: "ada@example.com" },
    graph: GRAPH_L,
    graph_hash: canonicalHash(GRAPH_L),
    harness_version: V1,
    ...overrides,
  };
}

function transitionEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 2,
    ts: "2026-10-07T00:00:01.000Z",
    root_id: "r1",
    task_id: "r1",
    event_type: "transition.TASK_RECEIVED.TASK_CLASSIFIED",
    actor: { kind: "harness", id: "v9.9.9" },
    graph_hash: canonicalHash(GRAPH_L),
    harness_version: V1,
    ...overrides,
  };
}

function without(event: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...event };
  delete copy[key];
  return copy;
}

function assertValid(event: unknown): void {
  assert.deepEqual(eventViolations(event), [], JSON.stringify(event));
}

function assertInvalid(event: unknown): void {
  assert.notDeepEqual(eventViolations(event), [], JSON.stringify(event));
}

test("[ACTOR-01] an event without actor fails the schema", () => {
  assertValid(createdEvent());
  assertValid(transitionEvent());
  assertInvalid(without(createdEvent(), "actor"));
  assertInvalid(without(transitionEvent(), "actor"));
});

test("[ACTOR-02] an actor kind missing or outside harness, human and worker fails the schema", () => {
  assertInvalid(createdEvent({ actor: { id: "ada@example.com" } }));
  for (const kind of ["admin", "Human", "", null]) assertInvalid(createdEvent({ actor: { kind, id: "ada@example.com" } }));
  for (const kind of ["harness", "human", "worker"]) assertValid(createdEvent({ actor: { kind, id: "ada@example.com" } }));
});

test("[ACTOR-03] an actor id missing or empty fails the schema", () => {
  assertInvalid(createdEvent({ actor: { kind: "human" } }));
  for (const id of ["", 7]) assertInvalid(createdEvent({ actor: { kind: "human", id } }));
  assertValid(createdEvent({ actor: { kind: "human", id: "x" } }));
});

test("[ACTOR-04] an actor with a field outside kind, id and role, or an empty role, fails the schema", () => {
  assertInvalid(createdEvent({ actor: { kind: "human", id: "ada@example.com", email: "ada@example.com" } }));
  assertInvalid(createdEvent({ actor: { kind: "human", id: "ada@example.com", role: "" } }));
  assertValid(createdEvent({ actor: { kind: "human", id: "ada@example.com", role: "implementer" } }));
});

test("[VER-02] harness_version without the tag key or without commit fails the schema; tag null with a commit passes", () => {
  assertInvalid(without(createdEvent(), "harness_version"));
  const invalidVersions: unknown[] = [
    { commit: "1".repeat(40) },
    { tag: "v1" },
    { tag: "", commit: "1".repeat(40) },
    { tag: 1, commit: "1".repeat(40) },
    ...[39, 41, 63, 65].map((length) => ({ tag: "v1", commit: "1".repeat(length) })),
    { tag: "v1", commit: "A".repeat(40) },
    { tag: "v1", commit: "g".repeat(40) },
    { tag: "v1", commit: "1".repeat(40), extra: true },
  ];
  for (const harness_version of invalidVersions) assertInvalid(createdEvent({ harness_version }));
  assertValid(createdEvent({ harness_version: { tag: null, commit: "1".repeat(40) } }));
  assertValid(createdEvent({ harness_version: { tag: "v1", commit: "a".repeat(64) } }));
  for (const digit of ["0", "9", "a", "f"]) assertValid(createdEvent({ harness_version: { tag: "v1", commit: digit.repeat(40) } }));
  for (const digit of ["A", "g"]) assertInvalid(createdEvent({ harness_version: { tag: "v1", commit: digit.repeat(64) } }));
  for (const digit of ["0", "9", "f"]) assertValid(createdEvent({ harness_version: { tag: "v1", commit: digit.repeat(64) } }));
});

test("[GRAPH-10] an event other than task.created with graph fails the schema; task.created without graph passes it", () => {
  assertInvalid(transitionEvent({ graph: GRAPH_L }));
  assertInvalid(transitionEvent({ event_type: "provider.observed", graph: GRAPH_L }));
  assertValid(without(createdEvent(), "graph"));
});

test("[PROOF-02] the schema properties are the slice subset of the section 17 Event names", () => {
  const section17EventNames = [
    "seq", "ts", "root_id", "task_id", "event_type", "actor", "reason", "cause_event_id", "graph", "graph_hash",
    "provider", "model", "harness_version", "prompt_version", "session_id", "item_id", "request_id", "input",
    "output", "cache_read", "cache_write_5m", "cache_write_1h", "cost_usd", "pricing_version", "payload_ref",
    "payload_hash",
  ];
  const properties = Object.keys(EVENT_SCHEMA.properties).sort();
  assert.deepEqual(properties, [
    "actor", "cause_event_id", "event_type", "graph", "graph_hash", "harness_version", "item_id", "payload_hash",
    "payload_ref", "reason", "root_id", "seq", "session_id", "task_id", "ts",
  ]);
  for (const property of properties) assert.ok(section17EventNames.includes(property), property);
});

test("[LOG-04] [LOG-05] an event outside the field forms of the slice fails the schema", () => {
  for (const seq of [0, -1, 1.5, "1"]) assertInvalid(createdEvent({ seq }));
  for (const ts of ["", 5]) assertInvalid(createdEvent({ ts }));
  for (const field of ["root_id", "task_id", "item_id"]) {
    for (const value of ["A", "-a", "", "a".repeat(65)]) assertInvalid(createdEvent({ [field]: value }));
    for (const value of ["a".repeat(64), "z9_-"]) assertValid(createdEvent({ [field]: value }));
  }
  for (const event_type of [
    "agent.started",
    "",
    "task.createdx",
    "transition.TASK_RECEIVED",
    "transition.TASK_RECEIVED.BOGUS",
    "transition.BOGUS.TASK_CLASSIFIED",
    "xtransition.TASK_RECEIVED.TASK_CLASSIFIED",
    "transition.TASK_RECEIVED.TASK_CLASSIFIEDx",
    "transition-TASK_RECEIVED-TASK_CLASSIFIED",
    "taskXcreated",
    "providerXobserved",
    "transitionXTASK_RECEIVED.TASK_CLASSIFIED",
    "transition.TASK_RECEIVEDXTASK_CLASSIFIED",
    "transition.TASK_RECEIVED.",
    "transition..TASK_CLASSIFIED",
  ]) {
    assertInvalid(transitionEvent({ event_type }));
  }
  for (const event_type of ["transition.NEEDS_HUMAN.DONE", "transition.DONE.TASK_RECEIVED", "provider.observed"]) {
    assertValid(transitionEvent({ event_type }));
  }
  for (const field of ["seq", "ts", "root_id", "task_id", "event_type", "graph_hash"]) assertInvalid(without(createdEvent(), field));
  for (const length of [63, 65]) assertInvalid(createdEvent({ graph_hash: "a".repeat(length) }));
  for (const digit of ["A", "g"]) assertInvalid(createdEvent({ graph_hash: digit.repeat(64) }));
  for (const digit of ["0", "9", "a", "f"]) assertValid(createdEvent({ graph_hash: digit.repeat(64) }));
  const invalidGraphs: unknown[] = [
    { ...GRAPH_L, track: "X" },
    { track: "L", edges: GRAPH_L.edges },
    { stages: [], edges: GRAPH_L.edges },
    { track: "L", stages: [] },
    { ...GRAPH_L, edges: [...GRAPH_L.edges, { to: "DONE" }] },
    { ...GRAPH_L, stages: ["Bad"] },
    { ...GRAPH_L, stages: ["a", "a"] },
    { ...GRAPH_L, edges: [...GRAPH_L.edges, { from: "BOGUS", to: "DONE" }] },
    { ...GRAPH_L, edges: [...GRAPH_L.edges, { from: "DONE" }] },
    { ...GRAPH_L, edges: [...GRAPH_L.edges, { from: "DONE", to: "DONE", label: "x" }] },
    { ...GRAPH_L, extra: true },
  ];
  for (const graph of invalidGraphs) assertInvalid(createdEvent({ graph }));
  for (const field of ["reason", "cause_event_id", "session_id"]) {
    assertInvalid(transitionEvent({ [field]: "" }));
    assertValid(transitionEvent({ [field]: "x" }));
  }
  const payloadHash = "b".repeat(64);
  assertInvalid(transitionEvent({ payload_ref: "", payload_hash: payloadHash }));
  assertValid(transitionEvent({ payload_ref: "x", payload_hash: payloadHash }));
  assertInvalid(transitionEvent({ payload_ref: "x" }));
  assertInvalid(transitionEvent({ payload_hash: payloadHash }));
  assertInvalid(transitionEvent({ payload_ref: "x", payload_hash: "b".repeat(63) }));
  assertInvalid(transitionEvent({ event_id: "e1" }));
  assertInvalid(transitionEvent({ provider: "alpha-llm" }));
});

test("[LOG-02] a state directory that is missing, empty, relative or not normalized is refused without creating anything", () => {
  const cwd = temporaryDirectory();
  withCwd(cwd, () => {
    for (const stateDir of [undefined, "", "   ", "state", "./state", "../state"]) {
      expectStateError(() => new EventLog(stateDir, PROFILE, V1), "STATE_DIR_INVALID", String(stateDir));
    }
  });
  assert.deepEqual(readdirSync(cwd), []);
  // "link/.." is resolved by the disk through the link, while join() drops it as text: the two would name different folders
  const base = temporaryDirectory();
  mkdirSync(join(base, "outside", "dir"), { recursive: true });
  mkdirSync(join(base, "inside"));
  symlinkSync(join(base, "outside", "dir"), join(base, "inside", "link"));
  for (const stateDir of [`${base}/inside/link/../state`, `${base}/inside/../state`, `${base}/inside/./state`, `${base}//inside/state`]) {
    expectStateError(() => new EventLog(stateDir, PROFILE, V1), "STATE_DIR_INVALID", stateDir);
  }
  assert.deepEqual(readdirSync(join(base, "outside")), ["dir"]);
  assert.deepEqual(readdirSync(base).sort(), ["inside", "outside"]);
});

test("[LOG-10] a root id outside the id format is refused without touching the disk", () => {
  const stateDir = join(temporaryDirectory(), "state");
  const log = new EventLog(stateDir, PROFILE, V1);
  const invalid = [undefined, "", "A", "aB", "-a", "_a", "a.b", "a/b", "..", "a b", "\u00e9", "a".repeat(65)];
  for (const rootId of invalid) {
    expectStateError(() => log.events(rootId as string), "ROOT_ID_INVALID", String(rootId));
    expectStateError(() => log.state(rootId as string), "ROOT_ID_INVALID", String(rootId));
  }
  for (const rootId of ["a", "0", "9", "z", "a".repeat(64), "a-b_c", "a0z9", "x-", "x_"]) {
    expectStateError(() => log.events(rootId), "ROOT_NOT_FOUND", rootId);
    expectStateError(() => log.state(rootId), "ROOT_NOT_FOUND", rootId);
  }
  assert.equal(existsSync(stateDir), false);
});

test("[LOG-04] reading returns every event of the root in file order; a root without log is not found", () => {
  const stateDir = temporaryDirectory();
  const events = handLog("r1", "L", ["TASK_CLASSIFIED"]);
  events.push(observedLine("r1", 3, events[0].graph_hash as string));
  writeLog(stateDir, "r1", events);
  const log = new EventLog(stateDir, PROFILE, V1);
  assert.deepEqual(log.events("r1"), events);
  expectStateError(() => log.events("r2"), "ROOT_NOT_FOUND");
});

test("[LOG-05] a line that is not JSON, fails the schema or belongs to another root fails the read", () => {
  const stateDir = temporaryDirectory();
  const log = new EventLog(stateDir, PROFILE, V1);
  const lines = handLog("r1", "L", ["TASK_CLASSIFIED", "TASK_SENSE_COMPLETE", "DISCOVERY_COMPLETE", "FLOW_COMPLETE"]).map(
    (event) => JSON.stringify(event),
  );
  const { actor: _actor, ...withoutActor } = JSON.parse(lines[2]);
  const badLines = ["not json", "", JSON.stringify(withoutActor), JSON.stringify({ ...JSON.parse(lines[2]), root_id: "other" })];
  for (const position of [2, 4, 0]) {
    for (const bad of badLines) {
      const text = lines.map((line, index) => (index === position ? bad : line)).join("\n") + "\n";
      writeFileSync(join(stateDir, "r1.jsonl"), text);
      expectStateError(() => log.events("r1"), "LOG_LINE_INVALID", `line ${position + 1}: ${bad.slice(0, 20)}`);
      expectStateError(() => log.state("r1"), "LOG_LINE_INVALID", `line ${position + 1}: ${bad.slice(0, 20)}`);
    }
  }
});

test("[LOG-06] a log that does not end with a newline fails the read", () => {
  const stateDir = temporaryDirectory();
  const log = new EventLog(stateDir, PROFILE, V1);
  const events = handLog("r1", "L", ["TASK_CLASSIFIED"]);
  const texts = ["", "x", events.map((event) => JSON.stringify(event)).join("\n"), JSON.stringify(events[0])];
  for (const text of texts) {
    writeFileSync(join(stateDir, "r1.jsonl"), text);
    expectStateError(() => log.events("r1"), "LOG_TRUNCATED", JSON.stringify(text.slice(0, 20)));
    expectStateError(() => log.state("r1"), "LOG_TRUNCATED", JSON.stringify(text.slice(0, 20)));
  }
});

test("[GRAPH-12] a log whose first event is not task.created with graph fails with GRAPH_MISSING", () => {
  const stateDir = temporaryDirectory();
  const log = new EventLog(stateDir, PROFILE, V1);
  const [created, transition] = handLog("r1", "L", ["TASK_CLASSIFIED"]);
  const graphHash = created.graph_hash as string;
  const { graph: _graph, ...createdWithoutGraph } = created;
  const logs = [
    [observedLine("r1", 1, graphHash), created],
    [createdWithoutGraph, transition],
    [{ ...transition, seq: 1 }, { ...created, seq: 2 }],
  ];
  for (const events of logs) {
    writeLog(stateDir, "r1", events);
    expectStateError(() => log.events("r1"), "GRAPH_MISSING", String(events[0].event_type));
    expectStateError(() => log.state("r1"), "GRAPH_MISSING", String(events[0].event_type));
  }
});

test("[GRAPH-15] a log whose task.created graph does not match its graph_hash, or with an event whose graph_hash differs, fails with GRAPH_MISMATCH", () => {
  const stateDir = temporaryDirectory();
  const log = new EventLog(stateDir, PROFILE, V1);
  const events = handLog("r1", "L", ["TASK_CLASSIFIED", "TASK_SENSE_COMPLETE", "DISCOVERY_COMPLETE", "FLOW_COMPLETE"]);
  const otherHash = canonicalHash(buildGraph("S"));
  for (const position of [1, 2, 4]) {
    writeLog(stateDir, "r1", events.map((event, index) => (index === position ? { ...event, graph_hash: otherHash } : event)));
    expectStateError(() => log.events("r1"), "GRAPH_MISMATCH", `line ${position + 1}`);
    expectStateError(() => log.state("r1"), "GRAPH_MISMATCH", `line ${position + 1}`);
  }
  const graph = events[0].graph as ReturnType<typeof buildGraph>;
  const editedGraphs = [
    { ...graph, edges: graph.edges.map((edge, index) => (index === 0 ? { from: "TASK_RECEIVED", to: "DONE" } : edge)) },
    { ...graph, edges: [...graph.edges, { from: "TASK_RECEIVED", to: "DONE" }] },
    { ...graph, track: "S" },
    { ...graph, stages: ["late"] },
  ];
  for (const edited of editedGraphs) {
    writeLog(stateDir, "r1", [{ ...events[0], graph: edited }, ...events.slice(1)]);
    expectStateError(() => log.events("r1"), "GRAPH_MISMATCH", JSON.stringify(edited).slice(0, 40));
    expectStateError(() => log.state("r1"), "GRAPH_MISMATCH", JSON.stringify(edited).slice(0, 40));
  }
});

test("[GRAPH-17] a log with a recorded transition that leaves another state or is not an edge of its graph fails the read", () => {
  const stateDir = temporaryDirectory();
  const log = new EventLog(stateDir, PROFILE, V1);
  const events = handLog("r1", "L", ["TASK_CLASSIFIED", "TASK_SENSE_COMPLETE", "DISCOVERY_COMPLETE", "FLOW_COMPLETE"]);
  const replaced: Array<[number, string]> = [
    [1, "transition.TASK_RECEIVED.DONE"],
    [2, "transition.TASK_CLASSIFIED.DONE"],
    [2, "transition.TASK_RECEIVED.TASK_CLASSIFIED"],
    [4, "transition.DISCOVERY_COMPLETE.GAP_DEFINED"],
    [4, "transition.TRUTH_VERIFIED.GAP_DEFINED"],
  ];
  for (const [position, event_type] of replaced) {
    writeLog(stateDir, "r1", events.map((event, index) => (index === position ? { ...event, event_type } : event)));
    expectStateError(() => log.events("r1"), "TRANSITION_NOT_IN_GRAPH", `line ${position + 1}: ${event_type}`);
    expectStateError(() => log.state("r1"), "TRANSITION_NOT_IN_GRAPH", `line ${position + 1}: ${event_type}`);
  }
  writeLog(stateDir, "r1", events);
  assert.equal(log.state("r1").state, "FLOW_COMPLETE");
});

test("[GRAPH-18] a log with task.created after the first line fails the read", () => {
  const stateDir = temporaryDirectory();
  const log = new EventLog(stateDir, PROFILE, V1);
  const events = handLog("r1", "L", ["TASK_CLASSIFIED", "TASK_SENSE_COMPLETE", "DISCOVERY_COMPLETE", "FLOW_COMPLETE"]);
  const created = events[0];
  // with the graph_hash of the first one: the same graph again, and the S graph that would change the track
  for (const again of [{ ...created }, { ...created, graph: buildGraph("S") }]) {
    for (const position of [1, 3, 5]) {
      writeLog(stateDir, "r1", [...events.slice(0, position), again, ...events.slice(position)]);
      expectStateError(() => log.events("r1"), "LOG_LINE_INVALID", `line ${position + 1}: ${JSON.stringify(again.graph).slice(0, 20)}`);
      expectStateError(() => log.state("r1"), "LOG_LINE_INVALID", `line ${position + 1}: ${JSON.stringify(again.graph).slice(0, 20)}`);
    }
  }
  const otherHash = { ...created, graph: buildGraph("S"), graph_hash: canonicalHash(buildGraph("S")) };
  writeLog(stateDir, "r1", [...events, otherHash]);
  expectStateError(() => log.events("r1"), "GRAPH_MISMATCH", "another graph_hash");
  writeLog(stateDir, "r1", events);
  assert.equal(log.state("r1").state, "FLOW_COMPLETE");
});

test("[VER-03] events written by different harness versions are read", () => {
  const stateDir = temporaryDirectory();
  const third: HarnessVersion = { tag: "v0.0.1", commit: "a".repeat(64) };
  const events = handLog("r1", "L", ["TASK_CLASSIFIED", "TASK_SENSE_COMPLETE"]);
  events[1].harness_version = V2;
  events[2].harness_version = third;
  writeLog(stateDir, "r1", events);
  const log = new EventLog(stateDir, PROFILE, { tag: "v5.0.0", commit: "5".repeat(40) });
  assert.deepEqual(
    log.events("r1").map((event) => event.harness_version),
    [V1, V2, third],
  );
  assert.equal(log.state("r1").revision, 2);
});

test("[LOG-11] a symbolic link in the state path is refused without reading", () => {
  const base = temporaryDirectory();
  const realState = join(base, "real-state");
  const events = handLog("r1", "L", []);
  writeLog(realState, "r1", events);
  const linkedState = join(base, "linked-state");
  symlinkSync(realState, linkedState);
  const fileLinkState = join(base, "file-link-state");
  mkdirSync(fileLinkState);
  symlinkSync(join(realState, "r1.jsonl"), join(fileLinkState, "r1.jsonl"));
  const realParent = join(base, "real-parent");
  writeLog(join(realParent, "state"), "r1", events);
  const linkedParent = join(base, "linked-parent");
  symlinkSync(realParent, linkedParent);
  for (const stateDir of [linkedState, fileLinkState, join(linkedParent, "state")]) {
    const log = new EventLog(stateDir, PROFILE, V1);
    expectStateError(() => log.events("r1"), "SYMLINK_REJECTED", stateDir);
    expectStateError(() => log.state("r1"), "SYMLINK_REJECTED", stateDir);
  }
  assert.deepEqual(new EventLog(realState, PROFILE, V1).events("r1"), events);
});

test("[LOG-08] [TRACK-02] the state is derived only from the events re-read from the file", () => {
  const stateDir = temporaryDirectory();
  const events = handLog("r1", "S", ["TASK_CLASSIFIED", "TASK_SENSE_COMPLETE", "DISCOVERY_COMPLETE"]);
  const graphHash = events[0].graph_hash as string;
  events.splice(2, 0, observedLine("r1", 3, graphHash));
  events.forEach((event, index) => (event.seq = index + 1));
  writeLog(stateDir, "r1", events);
  const expected = { root_id: "r1", track: "S", state: "DISCOVERY_COMPLETE", revision: 3, graph_hash: graphHash };
  assert.deepEqual(new EventLog(stateDir, PROFILE, V1).state("r1"), expected);
  const log = new EventLog(stateDir, PROFILE, V1);
  assert.deepEqual(log.state("r1"), expected);
  const next = { ...events[1], seq: 6, event_type: "transition.DISCOVERY_COMPLETE.PLAN_PROPOSED" };
  writeLog(stateDir, "r1", [...events, next]);
  assert.deepEqual(log.state("r1"), { ...expected, state: "PLAN_PROPOSED", revision: 4 });
  writeLog(stateDir, "r2", handLog("r2", "M", []));
  assert.deepEqual(log.state("r2"), {
    root_id: "r2",
    track: "M",
    state: "TASK_RECEIVED",
    revision: 0,
    graph_hash: canonicalHash(buildGraph("M")),
  });
});

test("[LOG-01] reading uses only the state directory it received", () => {
  const decoy = temporaryDirectory();
  writeLog(decoy, "r1", handLog("r1", "M", ["TASK_CLASSIFIED"]));
  writeLog(decoy, "r9", handLog("r9", "M", []));
  const stateDir = temporaryDirectory();
  const events = handLog("r1", "S", []);
  writeLog(stateDir, "r1", events);
  withCwd(decoy, () => {
    const log = new EventLog(stateDir, PROFILE, V1);
    assert.deepEqual(log.events("r1"), events);
    assert.equal(log.state("r1").track, "S");
    expectStateError(() => log.events("r9"), "ROOT_NOT_FOUND");
  });
});

const ADA: Actor = { kind: "human", id: "ada@example.com" };

test("[GRAPH-08] [ACTOR-07] [ACTOR-08] [VER-01] creating a root writes task.created with the graph, its canonical hash, the human author and the harness version", () => {
  const stateDir = join(temporaryDirectory(), "nested", "state");
  const log = new EventLog(stateDir, PROFILE, V1);
  const graph = buildGraph("M", ["prototype"]);
  const actor: Actor = { kind: "human", id: "ada@example.com", role: "requester" };
  const event = log.create("r1", { graph, actor });
  assert.equal(event.seq, 1);
  assert.equal(event.root_id, "r1");
  assert.equal(event.task_id, "r1");
  assert.equal(event.event_type, "task.created");
  assert.deepEqual(event.actor, actor);
  assert.deepEqual(event.graph, graph);
  assert.equal(event.graph_hash, canonicalHash(graph));
  assert.deepEqual(event.harness_version, V1);
  assert.equal(typeof event.ts, "string");
  assert.notEqual(event.ts, "");
  const file = join(stateDir, "r1.jsonl");
  assert.equal(existsSync(file), true);
  assert.deepEqual(log.events("r1"), [event]);
  assert.equal(readFileSync(file, "utf8"), JSON.stringify(event) + "\n");
});

test("[GRAPH-11] creating without a graph is refused with GRAPH_MISSING and no file", () => {
  const stateDir = temporaryDirectory();
  const log = new EventLog(stateDir, PROFILE, V1);
  expectStateError(() => log.create("r1", { actor: ADA }), "GRAPH_MISSING", "absent");
  expectStateError(() => log.create("r1", { graph: null, actor: ADA }), "GRAPH_MISSING", "null");
  assert.deepEqual(readdirSync(stateDir), []);
});

test("[ACTOR-05] creating without an actor is refused, with no default author", () => {
  const stateDir = temporaryDirectory();
  const log = new EventLog(stateDir, PROFILE, V1);
  const graph = buildGraph("L");
  expectStateError(() => log.create("r1", { graph }), "ACTOR_REQUIRED", "absent");
  expectStateError(() => log.create("r1", { graph, actor: null }), "ACTOR_REQUIRED", "null");
  expectStateError(() => log.create("r1", { graph, actor: "human" as unknown as Actor }), "ACTOR_REQUIRED", "text");
  assert.deepEqual(readdirSync(stateDir), []);
});

test("[ACTOR-06] [ACTOR-07] a caller kind other than human is refused for task.created", () => {
  const stateDir = temporaryDirectory();
  const log = new EventLog(stateDir, PROFILE, V1);
  const graph = buildGraph("L");
  const actors = [
    { kind: "worker", id: "ada@example.com" },
    { kind: "harness", id: "ada@example.com" },
    { kind: "admin", id: "ada@example.com" },
    { id: "ada@example.com" },
  ];
  for (const actor of actors) {
    expectStateError(() => log.create("r1", { graph, actor: actor as Actor }), "ACTOR_KIND_MISMATCH", JSON.stringify(actor));
  }
  assert.equal(existsSync(join(stateDir, "r1.jsonl")), false);
  assert.equal(existsSync(join(stateDir, "r1.lock")), false);
});

test("[ACTOR-08] a human id other than the profile email is refused", () => {
  const stateDir = temporaryDirectory();
  const log = new EventLog(stateDir, PROFILE, V1);
  for (const id of ["eve@example.com", "ADA@example.com", ""]) {
    expectStateError(() => log.create("r1", { graph: buildGraph("L"), actor: { kind: "human", id } }), "ACTOR_ID_INVALID", id);
  }
  assert.equal(existsSync(join(stateDir, "r1.jsonl")), false);
});

test("[TRACK-01] creating a root that already has task.created is refused and the file stays byte for byte", () => {
  const stateDir = temporaryDirectory();
  const log = new EventLog(stateDir, PROFILE, V1);
  log.create("r1", { graph: buildGraph("S"), actor: ADA });
  const file = join(stateDir, "r1.jsonl");
  assert.equal(existsSync(file), true);
  const before = readFileSync(file);
  expectStateError(() => log.create("r1", { graph: buildGraph("L"), actor: ADA }), "ROOT_EXISTS");
  assert.deepEqual(readFileSync(file), before);
  assert.equal(log.state("r1").track, "S");
});

test("[LOG-07] [GRAPH-13] creating on a truncated log or on one without graph fails and adds no byte", () => {
  const stateDir = temporaryDirectory();
  const log = new EventLog(stateDir, PROFILE, V1);
  const [created] = handLog("r1", "L", []);
  const cases: Array<[string, StateErrorCode]> = [
    ["", "LOG_TRUNCATED"],
    [JSON.stringify(created), "LOG_TRUNCATED"],
    [JSON.stringify(observedLine("r1", 1, created.graph_hash as string)) + "\n", "GRAPH_MISSING"],
  ];
  for (const [text, code] of cases) {
    const file = join(stateDir, "r1.jsonl");
    writeFileSync(file, text);
    expectStateError(() => log.create("r1", { graph: buildGraph("L"), actor: ADA }), code, JSON.stringify(text.slice(0, 20)));
    assert.equal(readFileSync(file, "utf8"), text);
    assert.equal(existsSync(join(stateDir, "r1.lock")), false);
  }
});

test("[LOG-12] the log creates the state directory with 0700 and the root file with 0600", () => {
  const stateDir = join(temporaryDirectory(), "a", "b", "state");
  new EventLog(stateDir, PROFILE, V1).create("r1", { graph: buildGraph("L"), actor: ADA });
  const file = join(stateDir, "r1.jsonl");
  assert.equal(existsSync(stateDir), true);
  assert.equal(existsSync(file), true);
  assert.equal(statSync(stateDir).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("[LOG-11] creating under a symbolic link is refused without writing", () => {
  const base = temporaryDirectory();
  const realState = join(base, "real-state");
  mkdirSync(realState);
  const linkedState = join(base, "linked-state");
  symlinkSync(realState, linkedState);
  const realParent = join(base, "real-parent");
  mkdirSync(realParent);
  const linkedParent = join(base, "linked-parent");
  symlinkSync(realParent, linkedParent);
  for (const stateDir of [linkedState, join(linkedParent, "state")]) {
    const log = new EventLog(stateDir, PROFILE, V1);
    expectStateError(() => log.create("r1", { graph: buildGraph("L"), actor: ADA }), "SYMLINK_REJECTED", stateDir);
  }
  assert.deepEqual(readdirSync(realState), []);
  assert.deepEqual(readdirSync(realParent), []);
});

test("[LOCK-01] [LOCK-02] a create while the root mutex exists is refused and changes neither the log nor the mutex", () => {
  const stateDir = temporaryDirectory();
  const log = new EventLog(stateDir, PROFILE, V1);
  const lockText = JSON.stringify({ pid: process.pid, created_at: "2026-10-07T00:00:00.000Z" });
  writeFileSync(join(stateDir, "r1.lock"), lockText);
  expectStateError(() => log.create("r1", { graph: buildGraph("L"), actor: ADA }), "ROOT_LOCKED", "r1");
  assert.equal(existsSync(join(stateDir, "r1.jsonl")), false);
  assert.equal(readFileSync(join(stateDir, "r1.lock"), "utf8"), lockText);
  log.create("r2", { graph: buildGraph("L"), actor: ADA });
  const file = join(stateDir, "r2.jsonl");
  assert.equal(existsSync(file), true);
  const before = readFileSync(file);
  writeFileSync(join(stateDir, "r2.lock"), lockText);
  expectStateError(() => log.create("r2", { graph: buildGraph("S"), actor: ADA }), "ROOT_LOCKED", "r2");
  assert.deepEqual(readFileSync(file), before);
  assert.equal(readFileSync(join(stateDir, "r2.lock"), "utf8"), lockText);
});

test("[LOCK-03] the mutex is removed after a create that succeeds and after one that fails inside it", () => {
  const stateDir = temporaryDirectory();
  const log = new EventLog(stateDir, PROFILE, V1);
  log.create("r1", { graph: buildGraph("L"), actor: ADA });
  assert.equal(existsSync(join(stateDir, "r1.jsonl")), true);
  assert.equal(existsSync(join(stateDir, "r1.lock")), false);
  expectStateError(() => log.create("r1", { graph: buildGraph("L"), actor: ADA }), "ROOT_EXISTS", "second");
  assert.equal(existsSync(join(stateDir, "r1.lock")), false);
  expectStateError(() => log.create("r1", { graph: buildGraph("L"), actor: ADA }), "ROOT_EXISTS", "third");
});

test("[LOG-01] [LOG-03] creating writes only under the state directory, as one JSON line at the end", () => {
  const decoy = temporaryDirectory();
  const stateDir = temporaryDirectory();
  withCwd(decoy, () => new EventLog(stateDir, PROFILE, V1).create("r1", { graph: buildGraph("L"), actor: ADA }));
  const file = join(stateDir, "r1.jsonl");
  assert.equal(existsSync(file), true);
  assert.deepEqual(readdirSync(decoy), []);
  assert.deepEqual(readdirSync(stateDir), ["r1.jsonl"]);
  const text = readFileSync(file, "utf8");
  assert.ok(text.endsWith("\n"));
  assert.equal(text.split("\n").length, 2);
});

test("[VER-02] a malformed harness version stops every create", () => {
  const stateDir = temporaryDirectory();
  const versions = [{ tag: "", commit: "1".repeat(40) }, { tag: null, commit: "x" }, { commit: "1".repeat(40) }];
  for (const version of versions) {
    const log = new EventLog(stateDir, PROFILE, version as HarnessVersion);
    expectStateError(() => log.create("r1", { graph: buildGraph("L"), actor: ADA }), "EVENT_SCHEMA_VIOLATION", JSON.stringify(version));
  }
  assert.equal(existsSync(join(stateDir, "r1.jsonl")), false);
  assert.equal(existsSync(join(stateDir, "r1.lock")), false);
});

test("[GRAPH-07] [GRAPH-08] stages that are not a list are kept as given, and creating with them is refused", () => {
  const stateDir = temporaryDirectory();
  const log = new EventLog(stateDir, PROFILE, V1);
  for (const stages of ["ab", "prototype"]) {
    const graph = buildGraph("L", stages as unknown as string[]);
    assert.equal(graph.stages, stages);
    expectStateError(() => log.create("r1", { graph, actor: ADA }), "EVENT_SCHEMA_VIOLATION", stages);
  }
  // shapes the canonical hash cannot take: a bigint, an object that holds itself, a list that holds itself
  const cyclic: Record<string, unknown> = { ...buildGraph("L") };
  cyclic.loop = cyclic;
  const selfHolding: unknown[] = [];
  selfHolding.push(selfHolding);
  const malformed = [buildGraph("L", 1n as unknown as string[]), cyclic, buildGraph("L", selfHolding as string[])];
  malformed.forEach((graph, index) => {
    expectStateError(() => log.create("r1", { graph: graph as ReturnType<typeof buildGraph>, actor: ADA }), "EVENT_SCHEMA_VIOLATION", `shape ${index + 1}`);
  });
  assert.deepEqual(readdirSync(stateDir), []);
});

const HUMAN_EDGES_ORACLE = [
  "GAP_DEFINED>DECIDED",
  "PLAN_PROPOSED>PLAN_APPROVED",
  "PR_OPEN>LOTE_MERGED",
  "NEEDS_HUMAN>LOTE_RUNNING",
  "NEEDS_HUMAN>DONE",
];
const L_PATH_TO_GAP: RootState[] = ["TASK_CLASSIFIED", "TASK_SENSE_COMPLETE", "DISCOVERY_COMPLETE", "FLOW_COMPLETE", "TRUTH_VERIFIED", "GAP_DEFINED"];

function actorFor(from: RootState, to: RootState, version: HarnessVersion = V1): Actor {
  return HUMAN_EDGES_ORACLE.includes(`${from}>${to}`) ? ADA : { kind: "harness", id: version.tag ?? version.commit };
}

function createdRoot(stateDir: string, track: Track, path: RootState[] = [], version: HarnessVersion = V1): EventLog {
  const log = new EventLog(stateDir, PROFILE, version);
  log.create("r1", { graph: buildGraph(track), actor: ADA });
  advance(log, path, version);
  return log;
}

function advance(log: EventLog, path: RootState[], version: HarnessVersion = V1): Event[] {
  return path.map((to) => {
    const view = log.state("r1");
    return log.transition("r1", {
      to,
      expected_revision: view.revision,
      graph_hash: view.graph_hash,
      actor: actorFor(view.state, to, version),
    });
  });
}

function bytesOf(stateDir: string): Buffer {
  const file = join(stateDir, "r1.jsonl");
  assert.equal(existsSync(file), true);
  return readFileSync(file);
}

test("[GRAPH-09] [ACTOR-10] [VER-01] a harness transition carries the task.created graph_hash, the tag as actor id and the harness version", () => {
  const stateDir = temporaryDirectory();
  const log = createdRoot(stateDir, "L");
  const graphHash = canonicalHash(buildGraph("L"));
  const actor: Actor = { kind: "harness", id: "v9.9.9" };
  const event = log.transition("r1", { to: "TASK_CLASSIFIED", expected_revision: 0, graph_hash: graphHash, actor });
  assert.equal(event.seq, 2);
  assert.equal(event.event_type, "transition.TASK_RECEIVED.TASK_CLASSIFIED");
  assert.equal(event.graph_hash, graphHash);
  assert.deepEqual(event.actor, actor);
  assert.deepEqual(event.harness_version, V1);
  assert.equal("graph" in event, false);
  assert.deepEqual(log.events("r1")[1], event);
  assert.equal(log.state("r1").state, "TASK_CLASSIFIED");
  assert.equal(log.state("r1").revision, 1);
});

test("[ACTOR-12] outside a tag the harness actor id is the commit, and on a tag it is the tag", () => {
  const offTag = temporaryDirectory();
  const offTagLog = createdRoot(offTag, "L", [], V2);
  const graphHash = canonicalHash(buildGraph("L"));
  const request = { to: "TASK_CLASSIFIED" as RootState, expected_revision: 0, graph_hash: graphHash };
  expectStateError(() => offTagLog.transition("r1", { ...request, actor: { kind: "harness", id: "v9.9.9" } }), "ACTOR_ID_INVALID", "tag off a tag");
  assert.equal(offTagLog.transition("r1", { ...request, actor: { kind: "harness", id: "2".repeat(40) } }).actor.id, "2".repeat(40));
  const onTag = temporaryDirectory();
  const onTagLog = createdRoot(onTag, "L");
  expectStateError(() => onTagLog.transition("r1", { ...request, actor: { kind: "harness", id: "1".repeat(40) } }), "ACTOR_ID_INVALID", "commit on a tag");
});

test("[ACTOR-09] transitions to DECIDED, PLAN_APPROVED and LOTE_MERGED and out of NEEDS_HUMAN are human, with the profile email", () => {
  const stateDir = temporaryDirectory();
  const log = createdRoot(stateDir, "L");
  const path: RootState[] = [
    ...L_PATH_TO_GAP,
    "DECIDED",
    "PLAN_PROPOSED",
    "PLAN_APPROVED",
    "CONTRACT_FROZEN",
    "LOTE_RUNNING",
    "PR_OPEN",
    "LOTE_MERGED",
    "LOTE_RUNNING",
    "NEEDS_HUMAN",
    "LOTE_RUNNING",
    "PR_OPEN",
    "NEEDS_HUMAN",
    "DONE",
  ];
  const events = advance(log, path);
  assert.equal(log.state("r1").state, "DONE");
  const expectedKinds = [
    "harness", "harness", "harness", "harness", "harness", "harness",
    "human", "harness", "human", "harness", "harness", "harness", "human",
    "harness", "harness", "human", "harness", "harness", "human",
  ];
  assert.deepEqual(events.map((event) => event.actor.kind), expectedKinds);
  for (const event of events.filter((item) => item.actor.kind === "human")) assert.equal(event.actor.id, "ada@example.com");
  const second = createdRoot(temporaryDirectory(), "L");
  const tail = advance(second, [...path.slice(0, 13), "DONE"]);
  assert.equal(second.state("r1").state, "DONE");
  assert.deepEqual(tail.map((event) => event.actor.kind), [...expectedKinds.slice(0, 13), "harness"]);
});

test("[ACTOR-06] a caller kind other than the one of the transition is refused", () => {
  const stateDir = temporaryDirectory();
  const log = createdRoot(stateDir, "L");
  const graphHash = canonicalHash(buildGraph("L"));
  const before = bytesOf(stateDir);
  for (const actor of [ADA, { kind: "worker", id: "child-1" } as Actor]) {
    expectStateError(
      () => log.transition("r1", { to: "TASK_CLASSIFIED", expected_revision: 0, graph_hash: graphHash, actor }),
      "ACTOR_KIND_MISMATCH",
      actor.kind,
    );
  }
  assert.deepEqual(bytesOf(stateDir), before);
  advance(log, L_PATH_TO_GAP);
  const atGap = bytesOf(stateDir);
  expectStateError(
    () => log.transition("r1", { to: "DECIDED", expected_revision: 6, graph_hash: graphHash, actor: { kind: "harness", id: "v9.9.9" } }),
    "ACTOR_KIND_MISMATCH",
    "harness to DECIDED",
  );
  assert.deepEqual(bytesOf(stateDir), atGap);
});

test("[ACTOR-05] a transition without actor is refused, with no default author", () => {
  const stateDir = temporaryDirectory();
  const log = createdRoot(stateDir, "L");
  const graphHash = canonicalHash(buildGraph("L"));
  const before = bytesOf(stateDir);
  expectStateError(() => log.transition("r1", { to: "TASK_CLASSIFIED", expected_revision: 0, graph_hash: graphHash }), "ACTOR_REQUIRED", "absent");
  expectStateError(
    () => log.transition("r1", { to: "TASK_CLASSIFIED", expected_revision: 0, graph_hash: graphHash, actor: null }),
    "ACTOR_REQUIRED",
    "null",
  );
  assert.deepEqual(bytesOf(stateDir), before);
});

test("[LOG-09] [LOCK-03] a transition with a stale expected revision is refused without writing and leaves no mutex", () => {
  const stateDir = temporaryDirectory();
  const log = createdRoot(stateDir, "L", ["TASK_CLASSIFIED"]);
  const graphHash = canonicalHash(buildGraph("L"));
  const before = bytesOf(stateDir);
  const actor: Actor = { kind: "harness", id: "v9.9.9" };
  for (const expected_revision of [0, 2, -1]) {
    expectStateError(
      () => log.transition("r1", { to: "TASK_SENSE_COMPLETE", expected_revision, graph_hash: graphHash, actor }),
      "REVISION_STALE",
      String(expected_revision),
    );
    assert.deepEqual(bytesOf(stateDir), before);
    assert.equal(existsSync(join(stateDir, "r1.lock")), false);
  }
  assert.equal(log.transition("r1", { to: "TASK_SENSE_COMPLETE", expected_revision: 1, graph_hash: graphHash, actor }).seq, 3);
  assert.equal(existsSync(join(stateDir, "r1.lock")), false);
});

test("[GRAPH-14] a transition with another graph_hash, or on a graph that no longer has its graph_hash, is refused with GRAPH_MISMATCH", () => {
  const stateDir = temporaryDirectory();
  const log = createdRoot(stateDir, "L");
  const before = bytesOf(stateDir);
  const actor: Actor = { kind: "harness", id: "v9.9.9" };
  for (const graph_hash of [canonicalHash(buildGraph("S")), "0".repeat(64), ""]) {
    expectStateError(
      () => log.transition("r1", { to: "TASK_CLASSIFIED", expected_revision: 0, graph_hash, actor }),
      "GRAPH_MISMATCH",
      graph_hash,
    );
  }
  assert.deepEqual(bytesOf(stateDir), before);
  const [created] = log.events("r1");
  const edges = [...created.graph!.edges, { from: "TASK_RECEIVED" as RootState, to: "DONE" as RootState }];
  writeLog(stateDir, "r1", [{ ...created, graph: { ...created.graph!, edges } }]);
  const edited = bytesOf(stateDir);
  expectStateError(
    () => log.transition("r1", { to: "DONE", expected_revision: 0, graph_hash: created.graph_hash, actor }),
    "GRAPH_MISMATCH",
    "graph edited under the recorded graph_hash",
  );
  assert.deepEqual(bytesOf(stateDir), edited);
});

test("[GRAPH-16] [TRACK-03] a transition that is not an edge of the recorded graph is refused", () => {
  const actor: Actor = { kind: "harness", id: "v9.9.9" };
  const lDir = temporaryDirectory();
  const lLog = createdRoot(lDir, "L");
  const lHash = canonicalHash(buildGraph("L"));
  const lBefore = bytesOf(lDir);
  for (const to of ["DONE", "TASK_SENSE_COMPLETE", "TRUTH_VERIFIED", "BOGUS"]) {
    expectStateError(
      () => lLog.transition("r1", { to: to as RootState, expected_revision: 0, graph_hash: lHash, actor }),
      "TRANSITION_NOT_IN_GRAPH",
      to,
    );
  }
  assert.deepEqual(bytesOf(lDir), lBefore);
  const sDir = temporaryDirectory();
  const sLog = createdRoot(sDir, "S", ["TASK_CLASSIFIED", "TASK_SENSE_COMPLETE", "DISCOVERY_COMPLETE"]);
  const sHash = canonicalHash(buildGraph("S"));
  const sBefore = bytesOf(sDir);
  for (const to of ["FLOW_COMPLETE", "GAP_DEFINED"] as RootState[]) {
    expectStateError(() => sLog.transition("r1", { to, expected_revision: 3, graph_hash: sHash, actor }), "TRANSITION_NOT_IN_GRAPH", to);
  }
  assert.deepEqual(bytesOf(sDir), sBefore);
  assert.equal(sLog.transition("r1", { to: "PLAN_PROPOSED", expected_revision: 3, graph_hash: sHash, actor }).seq, 5);
});

test("[LOG-08] [TRACK-02] after accepted transitions the state is the one re-read from the file, with the track of task.created", () => {
  const stateDir = temporaryDirectory();
  createdRoot(stateDir, "S", ["TASK_CLASSIFIED", "TASK_SENSE_COMPLETE", "DISCOVERY_COMPLETE", "PLAN_PROPOSED"]);
  assert.deepEqual(new EventLog(stateDir, PROFILE, V2).state("r1"), {
    root_id: "r1",
    track: "S",
    state: "PLAN_PROPOSED",
    revision: 4,
    graph_hash: canonicalHash(buildGraph("S")),
  });
});

test("[LOG-07] [GRAPH-13] [LOCK-01] a transition on a missing, truncated or graphless log, or on a locked root, adds no byte", () => {
  const actor: Actor = { kind: "harness", id: "v9.9.9" };
  const graphHash = canonicalHash(buildGraph("L"));
  const request = { to: "TASK_CLASSIFIED" as RootState, expected_revision: 0, graph_hash: graphHash, actor };
  const missing = join(temporaryDirectory(), "state");
  expectStateError(() => new EventLog(missing, PROFILE, V1).transition("r1", request), "ROOT_NOT_FOUND");
  assert.equal(existsSync(missing), false);
  const stateDir = temporaryDirectory();
  const log = new EventLog(stateDir, PROFILE, V1);
  const [created] = handLog("r1", "L", []);
  const cases: Array<[string, StateErrorCode]> = [
    [JSON.stringify(created), "LOG_TRUNCATED"],
    [JSON.stringify(observedLine("r1", 1, graphHash)) + "\n", "GRAPH_MISSING"],
  ];
  for (const [text, code] of cases) {
    writeFileSync(join(stateDir, "r1.jsonl"), text);
    expectStateError(() => log.transition("r1", request), code);
    assert.equal(readFileSync(join(stateDir, "r1.jsonl"), "utf8"), text);
    assert.equal(existsSync(join(stateDir, "r1.lock")), false);
  }
  writeFileSync(join(stateDir, "r1.jsonl"), JSON.stringify(created) + "\n");
  const lockText = JSON.stringify({ pid: process.pid, created_at: "2026-10-07T00:00:00.000Z" });
  writeFileSync(join(stateDir, "r1.lock"), lockText);
  expectStateError(() => log.transition("r1", request), "ROOT_LOCKED");
  assert.equal(readFileSync(join(stateDir, "r1.jsonl"), "utf8"), JSON.stringify(created) + "\n");
  assert.equal(readFileSync(join(stateDir, "r1.lock"), "utf8"), lockText);
});

test("[LOG-03] [VER-04] a second harness version appends without changing earlier bytes, and each event keeps its version", () => {
  const stateDir = temporaryDirectory();
  createdRoot(stateDir, "L", ["TASK_CLASSIFIED", "TASK_SENSE_COMPLETE"]);
  const before = bytesOf(stateDir);
  const second = new EventLog(stateDir, PROFILE, V2);
  advance(second, ["DISCOVERY_COMPLETE"], V2);
  const after = bytesOf(stateDir);
  assert.deepEqual(after.subarray(0, before.length), before);
  assert.deepEqual(
    second.events("r1").map((event) => event.harness_version),
    [V1, V1, V1, V2],
  );
});

test("[PROOF-01] editing the ts or the actor role of earlier events breaks neither the read nor the next write", () => {
  const stateDir = temporaryDirectory();
  const log = createdRoot(stateDir, "L", ["TASK_CLASSIFIED", "TASK_SENSE_COMPLETE"]);
  const edited = log.events("r1").map((event, index) => {
    if (index === 0) return { ...event, ts: "2001-01-01T00:00:00.000Z" };
    if (index === 1) return { ...event, ts: "2001-01-01T00:00:01.000Z", actor: { ...event.actor, role: "edited" } };
    return event;
  });
  writeLog(stateDir, "r1", edited);
  assert.deepEqual(log.events("r1"), edited);
  const view = log.state("r1");
  assert.equal(
    log.transition("r1", { to: "DISCOVERY_COMPLETE", expected_revision: view.revision, graph_hash: view.graph_hash, actor: actorFor(view.state, "DISCOVERY_COMPLETE") }).seq,
    4,
  );
});

const WORKER: Actor = { kind: "worker", id: "child-1", role: "implementer" };

function observationOf(attribution: { root_id?: string; item_id?: string }): Observation {
  return observeProcess(
    attribution,
    { command: "provider-cli", stdin: "prompt", timeout_ms: 1000 },
    { exit_code: 0, stdout: "", stderr: "", signal: null },
    3,
  );
}

test("[ACTOR-11] [OBS-01] [OBS-02] [GRAPH-09] [LOG-03] a worker observation event records the child_task_id, the item, the payload and the root graph_hash", () => {
  const stateDir = temporaryDirectory();
  const log = createdRoot(stateDir, "L", ["TASK_CLASSIFIED"]);
  const before = bytesOf(stateDir);
  const observation = observationOf({ root_id: "r1", item_id: "item-1" });
  const event = log.recordObservation("r1", { actor: WORKER, observation, payload_ref: "observations/r1-1.json" });
  assert.equal(event.seq, 3);
  assert.equal(event.event_type, "provider.observed");
  assert.deepEqual(event.actor, WORKER);
  assert.equal(event.item_id, "item-1");
  assert.equal(event.payload_ref, "observations/r1-1.json");
  assert.equal(event.payload_hash, canonicalHash(observation));
  assert.equal(event.graph_hash, canonicalHash(buildGraph("L")));
  assert.equal(event.task_id, "r1");
  assert.deepEqual(event.harness_version, V1);
  assert.deepEqual(bytesOf(stateDir).subarray(0, before.length), before);
  assert.deepEqual(log.events("r1")[2], event);
  assert.equal(log.state("r1").revision, 1);
  const second = log.recordObservation("r1", { actor: WORKER, observation: observationOf({ root_id: "r1" }), payload_ref: "observations/r1-2.json" });
  assert.equal("item_id" in second, false);
  assert.equal("item_id" in log.events("r1")[3], false);
});

test("[ACTOR-11] [ACTOR-06] a worker id outside the task id format or a kind other than worker is refused", () => {
  const stateDir = temporaryDirectory();
  const log = createdRoot(stateDir, "L");
  const before = bytesOf(stateDir);
  const request = { observation: observationOf({ root_id: "r1" }), payload_ref: "observations/one.json" };
  for (const id of ["Child-1", "", "a".repeat(65), 1, null, undefined]) {
    const actor = { kind: "worker", id } as unknown as Actor;
    expectStateError(() => log.recordObservation("r1", { ...request, actor }), "ACTOR_ID_INVALID", String(id));
  }
  for (const actor of [ADA, { kind: "harness", id: "v9.9.9" } as Actor]) {
    expectStateError(() => log.recordObservation("r1", { ...request, actor }), "ACTOR_KIND_MISMATCH", actor.kind);
  }
  assert.deepEqual(bytesOf(stateDir), before);
});

test("[ACTOR-05] an observation without actor is refused, with no default author", () => {
  const stateDir = temporaryDirectory();
  const log = createdRoot(stateDir, "L");
  const before = bytesOf(stateDir);
  const request = { observation: observationOf({ root_id: "r1" }), payload_ref: "observations/one.json" };
  expectStateError(() => log.recordObservation("r1", request), "ACTOR_REQUIRED", "absent");
  expectStateError(() => log.recordObservation("r1", { ...request, actor: null }), "ACTOR_REQUIRED", "null");
  assert.deepEqual(bytesOf(stateDir), before);
});

test("[OBS-01] [LOG-05] an observation of another root or an empty payload_ref is refused without writing", () => {
  const stateDir = temporaryDirectory();
  const log = createdRoot(stateDir, "L");
  const before = bytesOf(stateDir);
  expectStateError(
    () => log.recordObservation("r1", { actor: WORKER, observation: observationOf({ root_id: "r2" }), payload_ref: "observations/one.json" }),
    "OBSERVATION_ATTRIBUTION_INVALID",
    "other root",
  );
  expectStateError(
    () => log.recordObservation("r1", { actor: WORKER, observation: undefined as unknown as Observation, payload_ref: "observations/one.json" }),
    "OBSERVATION_ATTRIBUTION_INVALID",
    "absent",
  );
  expectStateError(
    () => log.recordObservation("r1", { actor: WORKER, observation: observationOf({ root_id: "r1" }), payload_ref: "" }),
    "EVENT_SCHEMA_VIOLATION",
    "empty payload_ref",
  );
  assert.deepEqual(bytesOf(stateDir), before);
});

test("[LOG-07] [GRAPH-13] [LOCK-01] an observation on a missing, truncated or graphless log, or on a locked root, adds no byte", () => {
  const graphHash = canonicalHash(buildGraph("L"));
  const request = { actor: WORKER, observation: observationOf({ root_id: "r1" }), payload_ref: "observations/one.json" };
  const missing = join(temporaryDirectory(), "state");
  expectStateError(() => new EventLog(missing, PROFILE, V1).recordObservation("r1", request), "ROOT_NOT_FOUND");
  assert.equal(existsSync(missing), false);
  const stateDir = temporaryDirectory();
  const log = new EventLog(stateDir, PROFILE, V1);
  const [created] = handLog("r1", "L", []);
  const cases: Array<[string, StateErrorCode]> = [
    [JSON.stringify(created), "LOG_TRUNCATED"],
    [JSON.stringify(observedLine("r1", 1, graphHash)) + "\n", "GRAPH_MISSING"],
  ];
  for (const [text, code] of cases) {
    writeFileSync(join(stateDir, "r1.jsonl"), text);
    expectStateError(() => log.recordObservation("r1", request), code);
    assert.equal(readFileSync(join(stateDir, "r1.jsonl"), "utf8"), text);
    assert.equal(existsSync(join(stateDir, "r1.lock")), false);
  }
  writeFileSync(join(stateDir, "r1.jsonl"), JSON.stringify(created) + "\n");
  const lockText = JSON.stringify({ pid: process.pid, created_at: "2026-10-07T00:00:00.000Z" });
  writeFileSync(join(stateDir, "r1.lock"), lockText);
  expectStateError(() => log.recordObservation("r1", request), "ROOT_LOCKED");
  assert.equal(readFileSync(join(stateDir, "r1.jsonl"), "utf8"), JSON.stringify(created) + "\n");
  assert.equal(readFileSync(join(stateDir, "r1.lock"), "utf8"), lockText);
});

test("[LOG-10] a root id outside the id format is refused by every write without creating the state directory", () => {
  const stateDir = join(temporaryDirectory(), "state");
  const log = new EventLog(stateDir, PROFILE, V1);
  const graph = buildGraph("L");
  const observation = observationOf({ root_id: "r1" });
  const invalid = [undefined, "", "A", "aB", "-a", "_a", "a.b", "a/b", "..", "a b", "\u00e9", "a".repeat(65)];
  for (const rootId of invalid) {
    const label = String(rootId);
    expectStateError(() => log.create(rootId as string, { graph, actor: ADA }), "ROOT_ID_INVALID", `create ${label}`);
    expectStateError(
      () => log.transition(rootId as string, { to: "TASK_CLASSIFIED", expected_revision: 0, graph_hash: canonicalHash(graph), actor: actorFor("TASK_RECEIVED", "TASK_CLASSIFIED") }),
      "ROOT_ID_INVALID",
      `transition ${label}`,
    );
    expectStateError(
      () => log.recordObservation(rootId as string, { actor: WORKER, observation, payload_ref: "observations/one.json" }),
      "ROOT_ID_INVALID",
      `observation ${label}`,
    );
  }
  assert.equal(existsSync(stateDir), false);
});

test("[LOG-05] a line whose seq is not its line number or whose task_id is not the root fails the read and every write", () => {
  const stateDir = temporaryDirectory();
  const log = new EventLog(stateDir, PROFILE, V1);
  const events = handLog("r1", "L", ["TASK_CLASSIFIED", "TASK_SENSE_COMPLETE"]);
  const graphHash = events[0].graph_hash as string;
  events.push(observedLine("r1", 4, graphHash));
  const edits: Array<[string, Array<[number, Record<string, unknown>]>]> = [
    ["seq repeated", [[1, { seq: 1 }]]],
    ["seq skipped", [[1, { seq: 3 }], [2, { seq: 4 }], [3, { seq: 5 }]]],
    ["seq out of order", [[1, { seq: 3 }], [2, { seq: 2 }]]],
    ["seq of the first line", [[0, { seq: 2 }]]],
    ["seq of the last line", [[3, { seq: 3 }]]],
    ["task_id of the first line", [[0, { task_id: "r2" }]]],
    ["task_id of a transition", [[2, { task_id: "r2" }]]],
    ["task_id of the last line", [[3, { task_id: "r2" }]]],
  ];
  for (const [label, changes] of edits) {
    const edited = events.map((event) => ({ ...event }));
    for (const [index, change] of changes) Object.assign(edited[index], change);
    writeLog(stateDir, "r1", edited);
    const before = bytesOf(stateDir);
    expectStateError(() => log.events("r1"), "LOG_LINE_INVALID", label);
    expectStateError(() => log.state("r1"), "LOG_LINE_INVALID", label);
    expectStateError(() => log.create("r1", { graph: buildGraph("L"), actor: ADA }), "LOG_LINE_INVALID", `create ${label}`);
    expectStateError(
      () => log.transition("r1", { to: "DISCOVERY_COMPLETE", expected_revision: 2, graph_hash: graphHash, actor: actorFor("TASK_SENSE_COMPLETE", "DISCOVERY_COMPLETE") }),
      "LOG_LINE_INVALID",
      `transition ${label}`,
    );
    expectStateError(
      () => log.recordObservation("r1", { actor: WORKER, observation: observationOf({ root_id: "r1" }), payload_ref: "observations/two.json" }),
      "LOG_LINE_INVALID",
      `observation ${label}`,
    );
    assert.deepEqual(bytesOf(stateDir), before);
    assert.equal(existsSync(join(stateDir, "r1.lock")), false);
  }
  writeLog(stateDir, "r1", events);
  const next = log.transition("r1", { to: "DISCOVERY_COMPLETE", expected_revision: 2, graph_hash: graphHash, actor: actorFor("TASK_SENSE_COMPLETE", "DISCOVERY_COMPLETE") });
  assert.equal(next.seq, 5);
  assert.deepEqual(log.events("r1").map((event) => event.seq), [1, 2, 3, 4, 5]);
});

test("[GRAPH-11] [ACTOR-05] a write request that is not an object is refused before the disk", () => {
  const requests: unknown[] = [null, undefined, 5, "graph", true, 1n];
  const missing = join(temporaryDirectory(), "state");
  const fresh = new EventLog(missing, PROFILE, V1);
  for (const request of requests) {
    expectStateError(() => fresh.create("r1", request as never), "GRAPH_MISSING", `create ${String(request)}`);
    expectStateError(() => fresh.transition("r1", request as never), "ACTOR_REQUIRED", `transition ${String(request)}`);
    expectStateError(() => fresh.recordObservation("r1", request as never), "ACTOR_REQUIRED", `observation ${String(request)}`);
  }
  assert.equal(existsSync(missing), false);
  const stateDir = temporaryDirectory();
  const log = createdRoot(stateDir, "L");
  const before = bytesOf(stateDir);
  for (const request of requests) {
    expectStateError(() => log.transition("r1", request as never), "ACTOR_REQUIRED", `transition ${String(request)}`);
    expectStateError(() => log.recordObservation("r1", request as never), "ACTOR_REQUIRED", `observation ${String(request)}`);
  }
  assert.deepEqual(bytesOf(stateDir), before);
  assert.equal(existsSync(join(stateDir, "r1.lock")), false);
});

test("[OBS-03] [OBS-07] an observation that is incomplete or has a field of another type is refused before the hash, without writing", () => {
  const stateDir = temporaryDirectory();
  const log = createdRoot(stateDir, "L");
  const before = bytesOf(stateDir);
  const base = observationOf({ root_id: "r1", item_id: "item-1" }) as unknown as Record<string, unknown>;
  const record = (observation: unknown) => () =>
    log.recordObservation("r1", { actor: WORKER, observation: observation as Observation, payload_ref: "observations/one.json" });
  // shapes the canonical hash cannot take: a bigint, an object that holds itself, a list that holds itself
  const holdsItself: Record<string, unknown> = { a: 1 };
  holdsItself.self = holdsItself;
  const listHoldsItself: unknown[] = [];
  listHoldsItself.push(listHoldsItself);
  for (const item_id of ["Item", "", 1, null, 1n, holdsItself, ["item-1"]]) {
    expectStateError(record({ ...base, item_id }), "OBSERVATION_ATTRIBUTION_INVALID", `item_id ${String(item_id)}`);
  }
  const numbers = ["1", null, NaN, Infinity, -Infinity, 1n, holdsItself, [1]];
  const texts = [1, null, ["provider-cli"], 1n, holdsItself];
  const hashes = ["x", "A".repeat(64), "a".repeat(63), "a".repeat(65), 1, null, 1n, ["a".repeat(64)]];
  const lists = ["m1", null, [1], [null], [1n], [["m1"]], [holdsItself], listHoldsItself];
  const malformed: Record<string, unknown[]> = {
    command: texts,
    timeout_ms: numbers,
    elapsed_ms: numbers,
    exit_code: ["0", NaN, Infinity, -Infinity, 1n, holdsItself, [0]],
    signal: [1, ["SIGTERM"], 1n, holdsItself],
    prompt_bytes: numbers,
    prompt_hash: hashes,
    stdout_bytes: numbers,
    stdout_hash: hashes,
    stderr_bytes: numbers,
    stderr_hash: hashes,
    stderr: texts,
    errors: lists,
    tool_calls: lists,
  };
  for (const [field, values] of Object.entries(malformed)) {
    for (const value of values) {
      expectStateError(record({ ...base, [field]: value }), "OBSERVATION_INPUT_INVALID", `${field} ${String(value)}`);
    }
    const incomplete = { ...base };
    delete incomplete[field];
    expectStateError(record(incomplete), "OBSERVATION_INPUT_INVALID", `${field} missing`);
  }
  expectStateError(record({ ...base, env: { CQSTACK_FAKE_NAME_7: "fake-value-7" } }), "OBSERVATION_INPUT_INVALID", "extra field");
  expectStateError(record({ ...base, loop: holdsItself }), "OBSERVATION_INPUT_INVALID", "extra field that holds itself");
  assert.deepEqual(bytesOf(stateDir), before);
  assert.equal(existsSync(join(stateDir, "r1.lock")), false);
  const accepted = [
    observationOf({ root_id: "r1" }),
    observeProcess(
      { root_id: "r1", item_id: "item-2" },
      { command: "", stdin: "", timeout_ms: 0.5 },
      { exit_code: null, stdout: JSON.stringify({ type: "error", message: "m1" }), stderr: "", signal: "SIGTERM" },
      2.5,
    ),
  ];
  for (const observation of accepted) {
    const event = log.recordObservation("r1", { actor: WORKER, observation, payload_ref: "observations/two.json" });
    assert.equal(event.payload_hash, canonicalHash(observation));
  }
  assert.equal(log.events("r1").length, 3);
});

test("[VER-01] [VER-02] [VER-04] each event keeps the harness version given to the constructor, whatever is changed in the argument or in a returned event", () => {
  const stateDir = temporaryDirectory();
  const version: HarnessVersion = { tag: "v9.9.9", commit: "1".repeat(40) };
  const log = new EventLog(stateDir, PROFILE, version);
  version.tag = "v0.0.0";
  version.commit = "f".repeat(40);
  const created = log.create("r1", { graph: buildGraph("L"), actor: ADA });
  assert.deepEqual(created.harness_version, V1);
  created.harness_version.tag = "v1.1.1";
  created.harness_version.commit = "e".repeat(40);
  const toClassified = (id: string) => () =>
    log.transition("r1", { to: "TASK_CLASSIFIED", expected_revision: 0, graph_hash: created.graph_hash, actor: { kind: "harness", id } });
  expectStateError(toClassified("v1.1.1"), "ACTOR_ID_INVALID", "tag changed in a returned event");
  expectStateError(toClassified("v0.0.0"), "ACTOR_ID_INVALID", "tag changed in the constructor argument");
  const moved = toClassified("v9.9.9")();
  assert.deepEqual(moved.harness_version, V1);
  assert.notEqual(moved.harness_version, created.harness_version);
  assert.notEqual(moved.harness_version, version);
  assert.deepEqual(log.events("r1").map((event) => event.harness_version), [V1, V1]);
  const before = bytesOf(stateDir);
  // without a tag or commit no harness id can match; with a field more the tag matches and the schema refuses the version
  const malformed: Array<[unknown, StateErrorCode]> = [
    [null, "ACTOR_ID_INVALID"],
    [undefined, "ACTOR_ID_INVALID"],
    ["v9.9.9", "ACTOR_ID_INVALID"],
    [1n, "ACTOR_ID_INVALID"],
    [{ ...V1, extra: "x" }, "EVENT_SCHEMA_VIOLATION"],
  ];
  for (const [other, transitionCode] of malformed) {
    const otherLog = new EventLog(stateDir, PROFILE, other as HarnessVersion);
    expectStateError(() => otherLog.create("r2", { graph: buildGraph("L"), actor: ADA }), "EVENT_SCHEMA_VIOLATION", `create ${String(other)}`);
    expectStateError(
      () => otherLog.transition("r1", { to: "TASK_SENSE_COMPLETE", expected_revision: 1, graph_hash: created.graph_hash, actor: { kind: "harness", id: "v9.9.9" } }),
      transitionCode,
      `transition ${String(other)}`,
    );
  }
  assert.deepEqual(bytesOf(stateDir), before);
  assert.equal(existsSync(join(stateDir, "r2.jsonl")), false);
  assert.deepEqual(readdirSync(stateDir).sort(), ["r1.jsonl"]);
});

test("[ACTOR-08] a human write under a profile without commit_identity.email is refused", () => {
  const stateDir = temporaryDirectory();
  const seeded = createdRoot(stateDir, "L", L_PATH_TO_GAP);
  const view = seeded.state("r1");
  const before = bytesOf(stateDir);
  const holdsItself: Record<string, unknown> = {};
  holdsItself.self = holdsItself;
  const profiles: unknown[] = [null, undefined, 5, "ada@example.com", 1n, {}, { commit_identity: null }, { commit_identity: {} }, holdsItself, [PROFILE]];
  for (const profile of profiles) {
    const log = new EventLog(stateDir, profile as ProjectProfile, V1);
    expectStateError(() => log.create("r2", { graph: buildGraph("L"), actor: ADA }), "ACTOR_ID_INVALID", `create ${String(profile)}`);
    expectStateError(
      () => log.transition("r1", { to: "DECIDED", expected_revision: view.revision, graph_hash: view.graph_hash, actor: ADA }),
      "ACTOR_ID_INVALID",
      `decide ${String(profile)}`,
    );
  }
  assert.deepEqual(bytesOf(stateDir), before);
  assert.deepEqual(readdirSync(stateDir).sort(), ["r1.jsonl"]);
});

test("[GRAPH-18] a task.created after the first line fails the read even with the seq of its line", () => {
  const stateDir = temporaryDirectory();
  const log = new EventLog(stateDir, PROFILE, V1);
  const events = handLog("r1", "L", ["TASK_CLASSIFIED", "TASK_SENSE_COMPLETE", "DISCOVERY_COMPLETE", "FLOW_COMPLETE"]);
  const created = events[0];
  for (const again of [{ ...created }, { ...created, graph: buildGraph("S") }]) {
    for (const position of [1, 3, 5]) {
      const inserted = [...events.slice(0, position), again, ...events.slice(position)].map((event, index) => ({ ...event, seq: index + 1 }));
      writeLog(stateDir, "r1", inserted);
      expectStateError(() => log.events("r1"), "LOG_LINE_INVALID", `line ${position + 1}: ${JSON.stringify(again.graph).slice(0, 20)}`);
      expectStateError(() => log.state("r1"), "LOG_LINE_INVALID", `line ${position + 1}: ${JSON.stringify(again.graph).slice(0, 20)}`);
    }
  }
  writeLog(stateDir, "r1", events);
  assert.equal(log.state("r1").state, "FLOW_COMPLETE");
});

// values whose JSON is not what a check of the value reads: fields only on the prototype, or a toJSON that JSON.stringify calls
function inheriting<T extends object>(fields: T): T {
  return Object.create(fields) as T;
}

function withToJson<T extends object>(value: T, json: unknown, enumerable = false): T {
  return Object.defineProperty({ ...value }, "toJSON", { value: () => json, enumerable }) as T;
}

test("[ACTOR-05] [ACTOR-06] [ACTOR-08] [ACTOR-11] [GRAPH-08] [OBS-01] [OBS-07] each write checks the event as its JSON line carries it, so an inherited field or a toJSON is refused and the root stays readable and writable", () => {
  const stateDir = temporaryDirectory();
  const log = createdRoot(stateDir, "L", L_PATH_TO_GAP);
  const view = log.state("r1");
  const before = bytesOf(stateDir);
  const holdsItself: Record<string, unknown> = {};
  holdsItself.self = holdsItself;
  const humanActors: Array<[unknown, StateErrorCode]> = [
    [inheriting(ADA), "ACTOR_KIND_MISMATCH"],
    [withToJson(ADA, { kind: "human", id: "eve@example.com" }), "ACTOR_ID_INVALID"],
    [withToJson(ADA, { kind: "human", id: "eve@example.com" }, true), "ACTOR_ID_INVALID"],
    [withToJson(ADA, { kind: "worker", id: "child-1" }), "ACTOR_KIND_MISMATCH"],
    [withToJson(ADA, null), "ACTOR_REQUIRED"],
    [withToJson(ADA, "human"), "ACTOR_REQUIRED"],
    [withToJson(ADA, undefined), "ACTOR_REQUIRED"],
    [{ ...ADA, role: holdsItself }, "EVENT_SCHEMA_VIOLATION"],
    [{ ...ADA, role: Symbol("lead") }, "EVENT_SCHEMA_VIOLATION"],
  ];
  humanActors.forEach(([actor, code], index) => {
    expectStateError(() => log.create("r2", { graph: buildGraph("L"), actor: actor as Actor }), code, `create actor ${index}`);
    expectStateError(
      () => log.transition("r1", { to: "DECIDED", expected_revision: view.revision, graph_hash: view.graph_hash, actor: actor as Actor }),
      code,
      `decide actor ${index}`,
    );
  });
  const graphL = buildGraph("L");
  const graphs = [
    inheriting(graphL),
    withToJson(graphL, { ...graphL, stages: ["Bad Stage"] }),
    withToJson(graphL, undefined),
    { ...graphL, stages: Object.defineProperty(["design"], "toJSON", { value: () => "ab" }) },
    { ...graphL, extra: () => graphL },
  ];
  graphs.forEach((graph, index) => {
    expectStateError(() => log.create("r2", { graph, actor: ADA }), "EVENT_SCHEMA_VIOLATION", `graph ${index}`);
  });
  const observation = observationOf({ root_id: "r1", item_id: "item-1" });
  const workerActors: Array<[unknown, StateErrorCode]> = [
    [inheriting(WORKER), "ACTOR_KIND_MISMATCH"],
    [withToJson(WORKER, { kind: "worker", id: "Child-1" }), "ACTOR_ID_INVALID"],
    [withToJson(WORKER, null), "ACTOR_REQUIRED"],
    [{ kind: "worker", id: 1n }, "ACTOR_ID_INVALID"],
    [{ ...WORKER, role: holdsItself }, "EVENT_SCHEMA_VIOLATION"],
  ];
  workerActors.forEach(([actor, code], index) => {
    expectStateError(() => log.recordObservation("r1", { actor: actor as Actor, observation, payload_ref: "observations/one.json" }), code, `worker ${index}`);
  });
  const observations: Array<[Observation, StateErrorCode]> = [
    [inheriting(observation), "OBSERVATION_ATTRIBUTION_INVALID"],
    [withToJson(observation, { ...observation, root_id: "r2" }), "OBSERVATION_ATTRIBUTION_INVALID"],
    [withToJson(observation, { ...observation, item_id: "Item" }), "OBSERVATION_ATTRIBUTION_INVALID"],
    [withToJson(observation, { ...observation, stderr: 1 }), "OBSERVATION_INPUT_INVALID"],
    [withToJson(observation, undefined), "OBSERVATION_INPUT_INVALID"],
    [{ ...observation, item_id: (() => "item-1") as unknown as string }, "OBSERVATION_ATTRIBUTION_INVALID"],
    [{ ...observation, signal: NaN as unknown as string }, "OBSERVATION_INPUT_INVALID"],
  ];
  observations.forEach(([given, code], index) => {
    expectStateError(() => log.recordObservation("r1", { actor: WORKER, observation: given, payload_ref: "observations/one.json" }), code, `observation ${index}`);
  });
  const notFinite = new EventLog(stateDir, PROFILE, { tag: NaN as unknown as string, commit: "1".repeat(40) });
  expectStateError(() => notFinite.create("r2", { graph: buildGraph("L"), actor: ADA }), "EVENT_SCHEMA_VIOLATION", "tag NaN");
  assert.deepEqual(bytesOf(stateDir), before);
  assert.deepEqual(readdirSync(stateDir).sort(), ["r1.jsonl"]);
  assert.deepEqual(log.state("r1"), view);
  log.transition("r1", { to: "DECIDED", expected_revision: view.revision, graph_hash: view.graph_hash, actor: ADA });
  log.recordObservation("r1", { actor: WORKER, observation, payload_ref: "observations/one.json" });
  assert.deepEqual(log.events("r1").slice(-2).map((event) => event.event_type), ["transition.GAP_DEFINED.DECIDED", "provider.observed"]);
  assert.equal(log.state("r1").state, "DECIDED");
});

test("[GRAPH-08] [OBS-01] [OBS-02] the graph hash and the payload hash are taken from the JSON a write carries, and the line read back is that JSON", () => {
  const stateDir = temporaryDirectory();
  const log = new EventLog(stateDir, PROFILE, V1);
  const graphS = buildGraph("S");
  const created = log.create("r1", { graph: withToJson(buildGraph("L"), graphS), actor: ADA });
  assert.deepEqual(created.graph, graphS);
  assert.equal(created.graph_hash, canonicalHash(graphS));
  assert.deepEqual(log.state("r1"), { root_id: "r1", track: "S", state: "TASK_RECEIVED", revision: 0, graph_hash: canonicalHash(graphS) });
  const observation = observationOf({ root_id: "r1", item_id: "item-1" });
  const carried = { ...observation, item_id: "item-9", stderr: "carried" };
  const event = log.recordObservation("r1", { actor: WORKER, observation: withToJson(observation, carried), payload_ref: "observations/one.json" });
  assert.equal(event.item_id, "item-9");
  assert.equal(event.payload_hash, canonicalHash(carried));
  assert.deepEqual(log.events("r1"), [created, event]);
});

test("[LOG-11] a link put in place of the log file after the path check is refused by the open itself, without reading or writing through it", () => {
  const base = temporaryDirectory();
  const outside = join(base, "outside.jsonl");
  writeFileSync(outside, "keep\n");
  const stateDir = join(base, "state");
  mkdirSync(stateDir);
  const swapped = join(stateDir, "r1.jsonl");
  symlinkSync(outside, swapped);
  const dangling = join(stateDir, "r2.jsonl");
  symlinkSync(join(base, "created-through-link.jsonl"), dangling);
  for (const link of [swapped, dangling]) {
    expectStateError(() => appendLine(link, "{}"), "SYMLINK_REJECTED", `append ${link}`);
    expectStateError(() => readText(link), "SYMLINK_REJECTED", `read ${link}`);
  }
  assert.equal(readFileSync(outside, "utf8"), "keep\n");
  assert.equal(existsSync(join(base, "created-through-link.jsonl")), false);
});

test("[ACTOR-04] [GRAPH-08] [LOG-03] the schema reads the actor as the line carries it, and a write returns exactly the line it appended", () => {
  const stateDir = temporaryDirectory();
  const log = createdRoot(stateDir, "L", L_PATH_TO_GAP);
  const view = log.state("r1");
  const before = bytesOf(stateDir);
  for (const json of [{ ...ADA, role: "" }, { ...ADA, team: "core" }]) {
    expectStateError(() => log.create("r2", { graph: buildGraph("L"), actor: withToJson(ADA, json) }), "EVENT_SCHEMA_VIOLATION", `create ${JSON.stringify(json)}`);
    expectStateError(
      () => log.transition("r1", { to: "DECIDED", expected_revision: view.revision, graph_hash: view.graph_hash, actor: withToJson(ADA, json) }),
      "EVENT_SCHEMA_VIOLATION",
      `decide ${JSON.stringify(json)}`,
    );
  }
  const observation = observationOf({ root_id: "r1" });
  const worker = withToJson(WORKER, { ...WORKER, role: "" });
  expectStateError(() => log.recordObservation("r1", { actor: worker, observation, payload_ref: "observations/one.json" }), "EVENT_SCHEMA_VIOLATION", "worker role");
  assert.deepEqual(bytesOf(stateDir), before);
  assert.deepEqual(readdirSync(stateDir).sort(), ["r1.jsonl"]);
  // accepted: a toJSON that gives another value on each call is read once, and the line, its graph_hash and the returned event agree
  let calls = 0;
  const graphL = buildGraph("L");
  const shifting = Object.defineProperty({ ...graphL }, "toJSON", { value: () => (++calls === 1 ? graphL : buildGraph("S")) });
  const fresh = new EventLog(temporaryDirectory(), PROFILE, V1);
  const created = fresh.create("r1", { graph: shifting, actor: withToJson({ ...ADA, role: "lead" }, ADA) });
  assert.deepEqual(created.actor, ADA);
  assert.deepEqual(fresh.events("r1"), [created]);
  assert.equal(fresh.state("r1").track, "L");
});

test("[ACTOR-10] [VER-01] [VER-02] the harness actor id is checked against the version as the events write it", () => {
  const stateDir = temporaryDirectory();
  const commit = "1".repeat(40);
  const log = new EventLog(stateDir, PROFILE, { tag: "v9.9.9", commit, toJSON: () => ({ tag: "v1.0.0", commit }) } as HarnessVersion);
  const created = log.create("r1", { graph: buildGraph("L"), actor: ADA });
  assert.deepEqual(created.harness_version, { tag: "v1.0.0", commit });
  const move = (id: string) => () =>
    log.transition("r1", { to: "TASK_CLASSIFIED", expected_revision: 0, graph_hash: created.graph_hash, actor: { kind: "harness", id } });
  expectStateError(move("v9.9.9"), "ACTOR_ID_INVALID", "tag of the version as given");
  move("v1.0.0")();
  assert.deepEqual(log.events("r1").map((event) => [event.actor.id, event.harness_version.tag]), [["ada@example.com", "v1.0.0"], ["v1.0.0", "v1.0.0"]]);
  const before = bytesOf(stateDir);
  // a version whose JSON is null, or that has no JSON text, is kept empty: the schema refuses it on create and the id rule on a harness move
  for (const other of [{ ...V1, toJSON: () => null }, { ...V1, tag: 1n }]) {
    const otherLog = new EventLog(stateDir, PROFILE, other as unknown as HarnessVersion);
    expectStateError(() => otherLog.create("r2", { graph: buildGraph("L"), actor: ADA }), "EVENT_SCHEMA_VIOLATION", `create ${String(other.tag)}`);
    expectStateError(
      () => otherLog.transition("r1", { to: "TASK_SENSE_COMPLETE", expected_revision: 1, graph_hash: created.graph_hash, actor: { kind: "harness", id: "v9.9.9" } }),
      "ACTOR_ID_INVALID",
      `move ${String(other.tag)}`,
    );
  }
  assert.deepEqual(bytesOf(stateDir), before);
  assert.deepEqual(readdirSync(stateDir).sort(), ["r1.jsonl"]);
});
