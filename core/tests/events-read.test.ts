import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalHash } from "../src/storage.js";
import { buildGraph } from "../src/graph.js";
import { EventLog, type HarnessVersion } from "../src/events.js";
import {
  ADA,
  PROFILE,
  V1,
  V2,
  WORKER,
  actorFor,
  bytesOf,
  expectStateError,
  handLog,
  observationOf,
  observedLine,
  temporaryDirectory,
  writeLog,
} from "./helpers.js";

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
