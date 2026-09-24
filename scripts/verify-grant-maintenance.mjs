import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { HARNESS_ROOT, hash } from "../dist/runtime/src/storage.js";

const artifact = name => join(HARNESS_ROOT, "artifacts", name);
const read = path => JSON.parse(readFileSync(path, "utf8"));
const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const baseline = read(artifact("grant-maintenance-baseline.json"));
const unchanged = ["runtime/tests/execution-grants.test.ts", "runtime/tests/smoke.test.ts", "config/runtime.json", "config/models.json", "roles/registry.json"];
for (const file of unchanged) assert.equal(digest(join(HARNESS_ROOT, file)), baseline[file], file);
const subject = read(artifact("grant-maintenance-review-manifest.json"));
for (const [file, expected] of Object.entries(subject)) assert.equal(digest(join(HARNESS_ROOT, file)), expected, file);
const task = "PHASE2-LIFECYCLE-DIAG-truth-review-lifecycle";
const events = readFileSync(join(HARNESS_ROOT, "state/events", task + ".jsonl"), "utf8").trim().split("\n").map(JSON.parse);
assert.equal(hash(events[0].payload.capsule), "3b06266d8b3ae60d41be1ca2023e0ee5aae8360481ef9067f3b877cd51b95b11");
assert.deepEqual(events.map(e => e.event_type), ["task.created"]);
for (const directory of ["execution-grants", "execution-grant-consumptions", "results"])
  assert.equal(existsSync(join(HARNESS_ROOT, "state", directory, task + ".json")), false, directory);
assert.equal(read(join(HARNESS_ROOT, "config/runtime.json")).model_execution_enabled, false);
const tap = readFileSync(artifact("grant-maintenance-all-tests-final.tap"), "utf8");
const count = key => Number(new RegExp(`^# ${key} (\\d+)$`, "m").exec(tap)?.[1]);
assert.equal(count("fail"), 0);
assert.equal(count("tests"), count("pass"));
assert.ok(count("tests") > 108);
const report = { verification: "PASS", global_model_execution_enabled: false, unchanged_files: unchanged,
  reviewed_subject_hashes: subject, child_task_id: task, capsule_hash: hash(events[0].payload.capsule),
  real_grant_issued: false, diagnosis_executed: false, tests: { previous: 108, new: count("tests") - 108, passed: count("pass"), failed: count("fail") } };
writeFileSync(artifact("grant-maintenance-verification.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
