import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalHash, type StateErrorCode } from "../src/storage.js";
import { buildGraph, type RootState } from "../src/graph.js";
import { EventLog, type Actor, type HarnessVersion } from "../src/events.js";
import type { ProjectProfile } from "../src/profile.js";
import type { Observation } from "../src/observation.js";
import {
  ADA,
  L_PATH_TO_GAP,
  PROFILE,
  V1,
  V2,
  WORKER,
  actorFor,
  advance,
  bytesOf,
  createdRoot,
  expectStateError,
  handLog,
  inheriting,
  observationOf,
  observedLine,
  temporaryDirectory,
  withToJson,
  writeLog,
} from "./helpers.js";

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

test("[VER-01] [ACTOR-10] the version is converted from its own fields, so a toJSON the copy does not carry is not read", () => {
  const stateDir = temporaryDirectory();
  const version = Object.defineProperty({ ...V1 }, "toJSON", { value: () => ({ tag: "v1.0.0", commit: V1.commit }) });
  const log = new EventLog(stateDir, PROFILE, version);
  const created = log.create("r1", { graph: buildGraph("L"), actor: ADA });
  assert.deepEqual(created.harness_version, V1);
  const moved = log.transition("r1", { to: "TASK_CLASSIFIED", expected_revision: 0, graph_hash: created.graph_hash, actor: { kind: "harness", id: "v9.9.9" } });
  assert.deepEqual(moved.harness_version, V1);
  assert.deepEqual(log.events("r1"), [created, moved]);
});

test("[GRAPH-16] [GRAPH-17] [LOG-08] each transition field is read from the caller once, so the edge checked is the edge written", () => {
  const stateDir = temporaryDirectory();
  const log = createdRoot(stateDir, "L");
  const view = log.state("r1");
  const reads = { to: 0, expected_revision: 0, graph_hash: 0 };
  // the target is an edge on the first read and a state off the graph on every later read
  const request = {
    actor: { kind: "harness" as const, id: "v9.9.9" },
    get to(): RootState {
      return ++reads.to === 1 ? "TASK_CLASSIFIED" : "TASK_SENSE_COMPLETE";
    },
    get expected_revision() {
      reads.expected_revision += 1;
      return view.revision;
    },
    get graph_hash() {
      reads.graph_hash += 1;
      return view.graph_hash;
    },
  };
  const moved = log.transition("r1", request);
  assert.equal(moved.event_type, "transition.TASK_RECEIVED.TASK_CLASSIFIED");
  assert.deepEqual(reads, { to: 1, expected_revision: 1, graph_hash: 1 });
  assert.deepEqual(log.events("r1").slice(1), [moved]);
  assert.deepEqual(log.state("r1"), { ...view, state: "TASK_CLASSIFIED", revision: 1 });
});
