import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendLine, canonicalHash, readText, type StateErrorCode } from "../src/storage.js";
import { buildGraph } from "../src/graph.js";
import { EventLog } from "../src/events.js";
import {
  ADA,
  PROFILE,
  V1,
  WORKER,
  actorFor,
  assertStatePathRefused,
  createdRoot,
  expectStateError,
  handLog,
  observationOf,
  temporaryDirectory,
  withCwd,
  writeLog,
} from "./helpers.js";

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

test("[LOG-01] [LOG-11] a folder in the state path that group or others may write is refused before the log touches the disk", () => {
  const base = temporaryDirectory();
  for (const mode of [0o775, 0o757]) {
    const open = join(base, `open-${mode.toString(8)}`);
    mkdirSync(open);
    const stateDir = join(open, "state");
    createdRoot(stateDir, "L");
    chmodSync(open, mode);
    assertStatePathRefused(stateDir, `ancestor ${mode.toString(8)}`);
    expectStateError(() => new EventLog(join(open, "fresh"), PROFILE, V1).create("r1", { graph: buildGraph("L"), actor: ADA }), "STATE_DIR_INVALID", `fresh ${mode.toString(8)}`);
    assert.deepEqual(readdirSync(open), ["state"]);
    chmodSync(open, 0o700);
    chmodSync(stateDir, mode);
    assertStatePathRefused(stateDir, `state directory ${mode.toString(8)}`);
  }
});

test("[LOG-01] [LOG-11] a sticky folder others may write is accepted above the state directory only when the next folder down already exists", () => {
  const base = temporaryDirectory();
  const sticky = join(base, "sticky");
  mkdirSync(sticky);
  chmodSync(sticky, 0o1777);
  const own = join(sticky, "own");
  mkdirSync(own, { mode: 0o700 });
  const stateDir = join(own, "state");
  const log = createdRoot(stateDir, "L", ["TASK_CLASSIFIED"]);
  log.recordObservation("r1", { actor: WORKER, observation: observationOf({ root_id: "r1" }), payload_ref: "observations/one.json" });
  assert.deepEqual(
    log.events("r1").map((event) => event.event_type),
    ["task.created", "transition.TASK_RECEIVED.TASK_CLASSIFIED", "provider.observed"],
  );
  assert.equal(new EventLog(stateDir, PROFILE, V1).state("r1").state, "TASK_CLASSIFIED");
  // a state directory not created yet right under the sticky folder: another user could create that name first
  expectStateError(() => new EventLog(join(sticky, "state"), PROFILE, V1).create("r1", { graph: buildGraph("L"), actor: ADA }), "STATE_DIR_INVALID", "missing under sticky");
  assert.deepEqual(readdirSync(sticky), ["own"]);
  // the sticky folder as the state directory: another user could put a log or a lock in it
  writeLog(sticky, "r1", handLog("r1", "L", []));
  assertStatePathRefused(sticky, "sticky state directory");
});

test("[LOG-01] [LOG-11] a folder of another user in the state path is refused; without process.getuid (Windows) only the link check runs", () => {
  const base = temporaryDirectory();
  const stateDir = join(base, "state");
  createdRoot(stateDir, "L");
  const wide = join(base, "wide");
  mkdirSync(wide);
  const wideState = join(wide, "state");
  createdRoot(wideState, "L");
  chmodSync(wide, 0o777);
  const getuid = process.getuid;
  let withoutGetuid: unknown[] = [];
  try {
    // the folders of this user now belong to "another user"; the folders of root above them still pass
    process.getuid = () => 4242;
    assertStatePathRefused(stateDir, "another owner");
    process.getuid = undefined;
    withoutGetuid = new EventLog(wideState, PROFILE, V1).events("r1");
  } finally {
    process.getuid = getuid;
  }
  assert.equal(withoutGetuid.length, 1);
  assert.equal(new EventLog(stateDir, PROFILE, V1).events("r1").length, 1);
  assertStatePathRefused(wideState, "with process.getuid");
});

test("[LOG-01] [LOG-11] the state path is checked before the mutex, so a refused path never reaches the lock", () => {
  const base = temporaryDirectory();
  const held = JSON.stringify({ pid: 1, created_at: "2026-10-08T00:00:00.000Z" });
  // a lock already in place: a write that took the mutex before checking the path would fail with ROOT_LOCKED instead
  const open = join(base, "open");
  mkdirSync(open);
  const stateDir = join(open, "state");
  createdRoot(stateDir, "L");
  writeFileSync(join(stateDir, "r1.lock"), held);
  chmodSync(open, 0o757);
  const realState = join(base, "real-parent", "state");
  createdRoot(realState, "L");
  writeFileSync(join(realState, "r1.lock"), held);
  symlinkSync(join(base, "real-parent"), join(base, "linked-parent"));
  const graphHash = canonicalHash(buildGraph("L"));
  const cases: Array<[string, StateErrorCode]> = [
    [stateDir, "STATE_DIR_INVALID"],
    [join(base, "linked-parent", "state"), "SYMLINK_REJECTED"],
  ];
  for (const [directory, code] of cases) {
    const log = new EventLog(directory, PROFILE, V1);
    expectStateError(
      () => log.transition("r1", { to: "TASK_CLASSIFIED", expected_revision: 0, graph_hash: graphHash, actor: { kind: "harness", id: "v9.9.9" } }),
      code,
      `transition ${directory}`,
    );
    expectStateError(
      () => log.recordObservation("r1", { actor: WORKER, observation: observationOf({ root_id: "r1" }), payload_ref: "observations/one.json" }),
      code,
      `observation ${directory}`,
    );
    expectStateError(() => log.create("r1", { graph: buildGraph("L"), actor: ADA }), code, `create ${directory}`);
  }
  for (const directory of [stateDir, realState]) {
    assert.equal(readFileSync(join(directory, "r1.lock"), "utf8"), held);
    assert.equal(readFileSync(join(directory, "r1.jsonl"), "utf8").split("\n").length, 2);
  }
});

test("[LOG-01] [LOG-02] a state directory or a folder above it that is a file is refused before the log touches the disk", () => {
  const base = temporaryDirectory();
  const plain = join(base, "plain");
  writeFileSync(plain, "keep\n");
  const graphHash = canonicalHash(buildGraph("L"));
  for (const stateDir of [plain, join(plain, "state")]) {
    const log = new EventLog(stateDir, PROFILE, V1);
    expectStateError(() => log.create("r1", { graph: buildGraph("L"), actor: ADA }), "STATE_DIR_INVALID", `create ${stateDir}`);
    expectStateError(() => log.events("r1"), "STATE_DIR_INVALID", `events ${stateDir}`);
    expectStateError(() => log.state("r1"), "STATE_DIR_INVALID", `state ${stateDir}`);
    expectStateError(
      () => log.transition("r1", { to: "TASK_CLASSIFIED", expected_revision: 0, graph_hash: graphHash, actor: actorFor("TASK_RECEIVED", "TASK_CLASSIFIED") }),
      "STATE_DIR_INVALID",
      `transition ${stateDir}`,
    );
    expectStateError(
      () => log.recordObservation("r1", { actor: WORKER, observation: observationOf({ root_id: "r1" }), payload_ref: "observations/one.json" }),
      "STATE_DIR_INVALID",
      `observation ${stateDir}`,
    );
  }
  assert.equal(readFileSync(plain, "utf8"), "keep\n");
  assert.deepEqual(readdirSync(base), ["plain"]);
});
