import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { createBus, type Bus } from "../src/bus.js";
import type { Actor, Event, HarnessVersion, RootView } from "../src/events.js";
import { buildGraph } from "../src/graph.js";
import { canonicalHash } from "../src/storage.js";
import { TOOL_DESCRIPTORS, invoke } from "../src/tools.js";
import { ADA, expectStateError, fakeClone, handLog, temporaryDirectory, writeLog, writeProject } from "./helpers.js";

interface ToolBus {
  bus: Bus;
  version: HarnessVersion;
  stateDir: string;
  harness: Actor;
}

async function toolBus(): Promise<ToolBus> {
  const { cloneRoot, version } = fakeClone();
  const home = temporaryDirectory();
  const bus = await createBus({ projectRoot: writeProject(), cloneRoot, homeDir: home });
  return { bus, version, stateDir: join(home, ".cqstack", "projects", "acme-toy", "state"), harness: { kind: "harness", id: version.tag! } };
}

type Opened = { event: Event; view: RootView };
function init(bus: Bus, root_id = "r1", track?: string): Opened {
  const opened = invoke(bus, "task_init", { root_id, ...(track === undefined ? {} : { track }), actor: ADA }) as Opened;
  assert.equal(opened.event?.event_type, "task.created");
  return opened;
}
const rootFile = (stateDir: string, rootId = "r1") => join(stateDir, `${rootId}.jsonl`);
const bytesOf = (stateDir: string, rootId = "r1") => {
  assert.equal(existsSync(rootFile(stateDir, rootId)), true);
  return readFileSync(rootFile(stateDir, rootId));
};

test("[TOOL-01] the descriptors are exactly task_init, task_state and task_events, each with a closed object schema", () => {
  assert.deepEqual(
    TOOL_DESCRIPTORS.map((tool) => tool.name),
    ["task_init", "task_state", "task_events"],
  );
  const shapes = TOOL_DESCRIPTORS.map(({ inputSchema }) => [
    inputSchema.type,
    inputSchema.additionalProperties,
    Object.keys(inputSchema.properties as object),
    inputSchema.required,
  ]);
  assert.deepEqual(shapes, [
    ["object", false, ["root_id", "track", "actor"], ["root_id"]],
    ["object", false, ["root_id", "to", "expected_revision", "graph_hash", "actor"], ["root_id", "to", "expected_revision", "graph_hash"]],
    ["object", false, ["root_id"], ["root_id"]],
  ]);
  for (const tool of TOOL_DESCRIPTORS) assert.ok(tool.description.length > 0, tool.name);
});

test("[TOOL-02] a tool outside the three is refused with TOOL_UNKNOWN and writes nothing", async () => {
  const { bus, stateDir } = await toolBus();
  for (const name of ["task_get", "", "TASK_INIT", "task_init ", "__proto__", "toString", "constructor", undefined, null, 1])
    expectStateError(() => invoke(bus, name, { root_id: "r1", actor: ADA }), "TOOL_UNKNOWN", String(name));
  assert.deepEqual(readdirSync(stateDir), [".gitignore"]);
});

test("[TOOL-03] arguments outside the schema of the tool are refused with TOOL_ARGUMENTS_INVALID and write nothing", async () => {
  const { bus, stateDir, harness } = await toolBus();
  const graphHash = canonicalHash(buildGraph("L"));
  const state = { root_id: "r1", to: "TASK_CLASSIFIED", expected_revision: 0, graph_hash: graphHash, actor: harness };
  const cases: Array<[tool: string, args: unknown]> = [
    ...[undefined, null, [], "x", 1, true, {}].map((args): [string, unknown] => ["task_init", args]),
    ["task_init", { root_id: "r1", actor: ADA, stages: ["prototype"] }],
    ["task_init", { root_id: "r1", actor: ADA, graph: buildGraph("S") }],
    ["task_init", JSON.parse('{"root_id": "r1", "actor": {"kind": "human", "id": "ada@example.com"}, "__proto__": {"track": "S"}}')],
    ...["s", "", "LL", null, 1].map((track): [string, unknown] => ["task_init", { root_id: "r1", track, actor: ADA }]),
    ...["R1", "a".repeat(65), "../x", "", 1, null].map((root_id): [string, unknown] => ["task_init", { root_id, actor: ADA }]),
    ...[[], "ada@example.com", 1, { kind: "robot", id: "x" }, { kind: "human", id: "" }, { kind: "human" }, { id: "ada@example.com" },
      { ...ADA, extra: 1 }, { ...ADA, role: "" }].map((actor): [string, unknown] => ["task_init", { root_id: "r1", actor }]),
    ...[undefined, null, [], {}].map((args): [string, unknown] => ["task_state", args]),
    ...(["root_id", "to", "expected_revision", "graph_hash"] as const).map((field): [string, unknown] => [
      "task_state",
      Object.fromEntries(Object.entries(state).filter(([key]) => key !== field)),
    ]),
    ...["NOPE", "task_classified", "", null].map((to): [string, unknown] => ["task_state", { ...state, to }]),
    ...[1.5, -1, 2 ** 53, "0", null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, BigInt(0)].map((expected_revision): [string, unknown] => [
      "task_state",
      { ...state, expected_revision },
    ]),
    ...["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), 1].map((graph_hash): [string, unknown] => ["task_state", { ...state, graph_hash }]),
    ["task_state", { ...state, extra: true }],
    ["task_state", { ...state, actor: [] }],
    ...[undefined, null, [], {}, { root_id: "R1" }, { root_id: "r1", extra: 1 }].map((args): [string, unknown] => ["task_events", args]),
  ];
  for (const [tool, args] of cases) expectStateError(() => invoke(bus, tool, args), "TOOL_ARGUMENTS_INVALID", `${tool} ${inspect(args)}`);
  assert.deepEqual(readdirSync(stateDir), [".gitignore"]);
});

test("[TOOL-04] [TOOL-05] task_init records task.created with the graph of the track, L when absent, and returns the event and the view", async () => {
  const { bus, stateDir, version } = await toolBus();
  for (const [rootId, track, expected] of [["r1", "S", "S"], ["r2", undefined, "L"], ["r3", "M", "M"]] as const) {
    const { event, view } = init(bus, rootId, track);
    assert.equal(existsSync(rootFile(stateDir, rootId)), true);
    assert.equal(event.event_type, "task.created");
    assert.deepEqual(event.graph, buildGraph(expected, []));
    assert.deepEqual(event.actor, ADA);
    assert.deepEqual(event.harness_version, version);
    assert.deepEqual(event, bus.log.events(rootId)[0]);
    assert.deepEqual(view, { root_id: rootId, track: expected, state: "TASK_RECEIVED", revision: 0, graph_hash: canonicalHash(buildGraph(expected, [])) });
  }
});

test("[TOOL-06] task_init and task_state without an actor are refused with ACTOR_REQUIRED and write nothing", async () => {
  const { bus, stateDir } = await toolBus();
  expectStateError(() => invoke(bus, "task_init", { root_id: "r1" }), "ACTOR_REQUIRED", "absent");
  expectStateError(() => invoke(bus, "task_init", { root_id: "r1", actor: null }), "ACTOR_REQUIRED", "null");
  assert.deepEqual(readdirSync(stateDir), [".gitignore"]);
  const { view } = init(bus);
  const before = bytesOf(stateDir);
  const state = { root_id: "r1", to: "TASK_CLASSIFIED", expected_revision: view.revision, graph_hash: view.graph_hash };
  expectStateError(() => invoke(bus, "task_state", state), "ACTOR_REQUIRED", "state absent");
  expectStateError(() => invoke(bus, "task_state", { ...state, actor: null }), "ACTOR_REQUIRED", "state null");
  assert.deepEqual(bytesOf(stateDir), before);
});

test("[TOOL-07] an actor of the wrong kind or id is refused with ACTOR_KIND_MISMATCH or ACTOR_ID_INVALID and writes nothing", async () => {
  const { bus, stateDir, harness } = await toolBus();
  expectStateError(() => invoke(bus, "task_init", { root_id: "r1", actor: { kind: "worker", id: "child-1" } }), "ACTOR_KIND_MISMATCH", "worker");
  expectStateError(() => invoke(bus, "task_init", { root_id: "r1", actor: harness }), "ACTOR_KIND_MISMATCH", "harness");
  expectStateError(() => invoke(bus, "task_init", { root_id: "r1", actor: { kind: "human", id: "eve@example.com" } }), "ACTOR_ID_INVALID", "other email");
  assert.deepEqual(readdirSync(stateDir), [".gitignore"]);
  const { view } = init(bus);
  const before = bytesOf(stateDir);
  const state = { root_id: "r1", to: "TASK_CLASSIFIED", expected_revision: view.revision, graph_hash: view.graph_hash };
  expectStateError(() => invoke(bus, "task_state", { ...state, actor: ADA }), "ACTOR_KIND_MISMATCH", "human on a harness edge");
  expectStateError(() => invoke(bus, "task_state", { ...state, actor: { kind: "harness", id: "v0.0.0" } }), "ACTOR_ID_INVALID", "other tag");
  assert.deepEqual(bytesOf(stateDir), before);
});

test("[TOOL-08] task_state records a transition along the recorded graph and returns the event and the view", async () => {
  const { bus, stateDir, harness } = await toolBus();
  const { view } = init(bus);
  const { event, view: next } = invoke(bus, "task_state", {
    root_id: "r1",
    to: "TASK_CLASSIFIED",
    expected_revision: view.revision,
    graph_hash: view.graph_hash,
    actor: harness,
  }) as Opened;
  assert.equal(bytesOf(stateDir).toString().split("\n").length, 3);
  assert.equal(event.event_type, "transition.TASK_RECEIVED.TASK_CLASSIFIED");
  assert.deepEqual(event.actor, harness);
  assert.deepEqual(event, bus.log.events("r1")[1]);
  assert.deepEqual(next, { ...view, state: "TASK_CLASSIFIED", revision: 1 });
});

test("[TOOL-09] [E7] a refused task_state or a repeated task_init returns the code of the log and leaves the root file byte for byte", async () => {
  const { bus, stateDir, harness } = await toolBus();
  const { view } = init(bus);
  const state = { root_id: "r1", to: "TASK_CLASSIFIED", expected_revision: view.revision, graph_hash: view.graph_hash, actor: harness };
  const before = bytesOf(stateDir);
  const refusals: Array<[args: Record<string, unknown>, code: Parameters<typeof expectStateError>[1]]> = [
    [{ ...state, graph_hash: canonicalHash(buildGraph("M")) }, "GRAPH_MISMATCH"],
    [{ ...state, expected_revision: 5 }, "REVISION_STALE"],
    [{ ...state, expected_revision: Number.MAX_SAFE_INTEGER }, "REVISION_STALE"],
    [{ ...state, to: "DONE" }, "TRANSITION_NOT_IN_GRAPH"],
    [{ ...state, root_id: "r9" }, "ROOT_NOT_FOUND"],
  ];
  for (const [args, code] of refusals) expectStateError(() => invoke(bus, "task_state", args), code, JSON.stringify(args));
  expectStateError(() => invoke(bus, "task_init", { root_id: "r1", track: "S", actor: ADA }), "ROOT_EXISTS");
  assert.deepEqual(bytesOf(stateDir), before);
  writeFileSync(join(stateDir, "r1.lock"), "{}");
  expectStateError(() => invoke(bus, "task_state", state), "ROOT_LOCKED");
  assert.deepEqual(bytesOf(stateDir), before);
  init(bus, "r2");
  appendFileSync(rootFile(stateDir, "r2"), '{"partial"');
  const truncatedTwo = bytesOf(stateDir, "r2");
  expectStateError(() => invoke(bus, "task_state", { ...state, root_id: "r2" }), "LOG_TRUNCATED");
  assert.deepEqual(bytesOf(stateDir, "r2"), truncatedTwo);
});

test("[TOOL-10] [E10] task_events returns the events of the log in file order, equal to what the log reads, as a copy", async () => {
  const { bus, harness } = await toolBus();
  let { view } = init(bus);
  for (const to of ["TASK_CLASSIFIED", "TASK_SENSE_COMPLETE"])
    ({ view } = invoke(bus, "task_state", { root_id: "r1", to, expected_revision: view.revision, graph_hash: view.graph_hash, actor: harness }) as Opened);
  const read = invoke(bus, "task_events", { root_id: "r1" }) as { events: Event[]; view: RootView };
  assert.deepEqual(read.events, bus.log.events("r1"));
  assert.deepEqual(read.events.map((event) => event.seq), [1, 2, 3]);
  assert.deepEqual(read.view, view);
  read.events[0].event_type = "changed";
  read.events.pop();
  assert.deepEqual((invoke(bus, "task_events", { root_id: "r1" }) as { events: Event[] }).events, bus.log.events("r1"));
  assert.equal(bus.log.events("r1")[0].event_type, "task.created");
});

test("[TOOL-11] task_events of a missing, truncated or invalid root returns the code of the log", async () => {
  const { bus, stateDir } = await toolBus();
  expectStateError(() => invoke(bus, "task_events", { root_id: "r9" }), "ROOT_NOT_FOUND");
  writeLog(stateDir, "r2", handLog("r2", "L", []), "");
  expectStateError(() => invoke(bus, "task_events", { root_id: "r2" }), "LOG_TRUNCATED");
  writeFileSync(rootFile(stateDir, "r3"), "not json\n");
  expectStateError(() => invoke(bus, "task_events", { root_id: "r3" }), "LOG_LINE_INVALID");
  writeLog(stateDir, "r4", handLog("r4", "L", ["TASK_CLASSIFIED"]).slice(1).map((event) => ({ ...event, seq: 1 })));
  expectStateError(() => invoke(bus, "task_events", { root_id: "r4" }), "GRAPH_MISSING");
  const mismatched = handLog("r5", "L", ["TASK_CLASSIFIED"]);
  mismatched[1].graph_hash = "b".repeat(64);
  writeLog(stateDir, "r5", mismatched);
  expectStateError(() => invoke(bus, "task_events", { root_id: "r5" }), "GRAPH_MISMATCH");
});
