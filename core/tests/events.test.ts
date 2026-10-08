import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateError, canonicalHash, type StateErrorCode } from "../src/storage.js";
import { buildGraph, type RootState, type Track } from "../src/graph.js";
import { EVENT_SCHEMA, EventLog, eventViolations, type HarnessVersion } from "../src/events.js";
import { PROFILE_FILE_NAME, loadProfile, type ProjectProfile } from "../src/profile.js";

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
