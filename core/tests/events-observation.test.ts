import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalHash, type StateErrorCode } from "../src/storage.js";
import { buildGraph } from "../src/graph.js";
import { EventLog, type Actor } from "../src/events.js";
import { observeProcess, type Observation } from "../src/observation.js";
import {
  ADA,
  PROFILE,
  V1,
  WORKER,
  bytesOf,
  createdRoot,
  expectStateError,
  handLog,
  observationOf,
  observedLine,
  temporaryDirectory,
} from "./helpers.js";

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
