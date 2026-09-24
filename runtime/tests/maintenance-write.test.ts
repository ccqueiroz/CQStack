import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs, { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { HARNESS_ROOT as SOURCE_ROOT, Storage, hash } from "../src/storage.js";
import { CodexProvider } from "../src/providers/codex.js";
import type { AgentExecutionRequest, AgentResult, MaintenanceEdit, TaskCapsule } from "../src/contracts.js";

// Every destructive probe targets a disposable copy, never the operator workspace.
const workspace = realpathSync(mkdtempSync(join(tmpdir(), "cartera-maintenance-suite-")));
const harness = join(workspace, ".cartera/harness");
cpSync(SOURCE_ROOT, harness, { recursive: true, verbatimSymlinks: true, filter: source =>
  source !== join(SOURCE_ROOT, "state") && source !== join(SOURCE_ROOT, "artifacts") });
after(() => rmSync(workspace, { recursive: true, force: true }));
for (const directory of ["cartera-frontend/.git", "cartera-backend", ".cartera/harness/state"])
  mkdirSync(join(workspace, directory), { recursive: true });
const { AgentBus } = await import(pathToFileURL(join(harness, "dist/runtime/src/agent-bus/index.js")).href) as typeof import("../src/agent-bus/index.js");
const { ExecutionGrants } = await import(pathToFileURL(join(harness, "dist/runtime/src/execution/grants.js")).href) as typeof import("../src/execution/grants.js");
const paths = [
  ".cartera/harness/runtime/src/agent-bus/index.ts",
  ".cartera/harness/runtime/src/execution/grants.ts",
  ".cartera/harness/cli/main.ts",
  ".cartera/harness/runtime/tests/maintenance-write.test.ts",
];
const digest = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
const absolute = (path: string) => join(workspace, path);

function capsule(task_id: string, parent_task_id: string | null, role: string, permissions: TaskCapsule["permissions"], constraints: string[] = []): TaskCapsule {
  return { task_id, parent_task_id, role, responsibility: "maintenance", goal: "maintenance", inputs: [],
    required_context: [paths[0]], allowed_paths: paths, forbidden_paths: [".git", ".cartera/harness/state"],
    existing_patterns: [], api_contract_reference: null, visual_lock_reference: null, constraints,
    acceptance_criteria: [], owned_tests: [], permissions, worktree: null, expected_output: "agent-result" };
}
function result(c: TaskCapsule, changed_files: string[] = []): AgentResult {
  return { task_id: c.task_id, role: c.role, status: "completed", summary: "maintenance", changed_files,
    evidence: [{ assertion: "Maintenance source inspected", source: paths[0] + ":1", observation: "Source exists in the isolated harness" }],
    tests_executed: [], tests_not_executed: [], api_contract_status: "not_applicable", visual_lock_status: "not_applicable",
    scope_expanded: false, deviations: [], risks: [], known_issues: [], requested_followups: [] };
}
function patch(c: TaskCapsule, edits: MaintenanceEdit[], changed_files = edits.map(e => e.relative_path)) {
  return { kind: "maintenance-patch" as const, edits, agent_result: result(c, changed_files) };
}
function edit(path = paths[0]): MaintenanceEdit {
  const content = readFileSync(absolute(path), "utf8");
  return { relative_path: path, expected_before_hash: digest(content), content: content + "\n// Maintenance test edit.\n" };
}
function unchangedEdit(): MaintenanceEdit {
  const content = readFileSync(absolute(paths[0]), "utf8");
  return { relative_path: paths[0], expected_before_hash: digest(content), content };
}
function fixture(owned_tests: string[] = [], stateParent = tmpdir(), routingProfile?: string) {
  const directory = realpathSync(mkdtempSync(join(stateParent, "cartera-maintenance-state-")));
  const storage = new Storage(directory), root = capsule("ROOT", null, "truth", "read-only"), child = capsule("CHILD", "ROOT", "opsx-implementation-worker", "restricted-path-write", ["CORE_ENGINEERING_V1", "CORE_INTERNAL_MAINTENANCE_V1"]);
  child.owned_tests = owned_tests;
  let calls = 0;
  const double = { async execute(request: AgentExecutionRequest) {
    calls++;
    assert.equal(storage.read<any>("execution-grant-consumptions", "CHILD.json").usage_state, "consumed");
    return patch(request.capsule, [unchangedEdit()]);
  } };
  const bus = new AgentBus(storage, { codex: double, claude: double });
  bus.init(root, routingProfile); bus.init(child);
  bus.transition("CHILD", "TASK_CLASSIFIED", 0); bus.transition("CHILD", "IMPLEMENTATION_RUNNING", 1);
  const grants = new ExecutionGrants(storage), route = bus.routeFor(child);
  const grant = grants.issue(child, root, route, "maintenance-write", "trusted-operator-cli", "approved internal maintenance");
  return { storage, bus, root, child, route, grants, grant, calls: () => calls, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
function noResult(f: ReturnType<typeof fixture>) {
  assert.equal(f.storage.exists("results", "CHILD.json"), false);
  assert.ok(!f.bus.events.list("CHILD").some(e => e.event_type === "agent.result.validated" || e.event_type === "agent.completed"));
}
async function rejectEdit(candidate: MaintenanceEdit, expected: RegExp, f = fixture()) {
  const before = paths.map(path => readFileSync(absolute(path)));
  try {
    f.bus.providers[f.route.provider] = { async execute(c) { return patch(c.capsule, [candidate]); } };
    await assert.rejects(f.bus.delegate("CHILD", false), expected);
    noResult(f);
    paths.forEach((path, i) => assert.deepEqual(readFileSync(absolute(path)), before[i]));
  } finally { f.cleanup(); }
}
function assertReadOnlyRequest(request: { args: string[]; cwd: string }) {
  assert.equal(request.cwd, workspace);
  assert.equal(request.args[request.args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(request.args.includes('approval_policy="never"'));
  assert.ok(request.args.includes("--ignore-user-config"));
  for (const flag of ["workspace-write", "danger-full-access", "--add-dir", "--full-auto", "--dangerously-bypass-approvals-and-sandbox"])
    assert.ok(!request.args.includes(flag), `Write authority must not include ${flag}`);
}

for (const [id, name, path] of [
  ["01", "Git metadata", "cartera-frontend/.git/config"],
  ["02", "Agent Bus state", ".cartera/harness/state/forged.json"],
  ["03", "frontend", "cartera-frontend/unauthorized.ts"],
  ["04", "backend", "cartera-backend/unauthorized.ts"],
] as const) test(`TM-${id}: rejects edits to ${name}`, async () => {
  await rejectEdit({ relative_path: path, expected_before_hash: null, content: "unauthorized" }, /MAINTENANCE_EDIT_SCOPE_VIOLATION/);
  assert.equal(existsSync(absolute(path)), false);
});

test("TM-05: rejects path traversal", async () => {
  for (const path of ["../escape.ts", ".cartera/harness/../escape.ts", "..\\escape.ts"])
    await rejectEdit({ relative_path: path, expected_before_hash: null, content: "escape" }, /MAINTENANCE_EDIT_PATH_INVALID/);
});

test("TM-06: rejects absolute paths", async () => {
  await rejectEdit({ relative_path: absolute(paths[0]), expected_before_hash: null, content: "escape" }, /MAINTENANCE_EDIT_PATH_INVALID/);
});

test("TM-07: rejects an allowed path that is a symlink", async () => {
  const f = fixture();
  const target = absolute(paths[3]), original = readFileSync(target), referent = absolute(paths[1]);
  const before = readFileSync(referent);
  try {
    rmSync(target); symlinkSync(referent, target);
    await rejectEdit({ relative_path: paths[3], expected_before_hash: digest(before), content: "escape" }, /SYMLINK_PATH_REJECTED|MAINTENANCE_EDIT_SYMLINK/, f);
    assert.deepEqual(readFileSync(referent), before);
  } finally { rmSync(target, { force: true }); writeFileSync(target, original); }
});

test("TM-08: rejects an ancestor symlink", async () => {
  const f = fixture();
  const directory = dirname(absolute(paths[2])), moved = directory + "-probe";
  fs.renameSync(directory, moved);
  try {
    symlinkSync(moved, directory);
    await rejectEdit({ relative_path: paths[2], expected_before_hash: digest(readFileSync(absolute(paths[2]))), content: "escape" }, /SYMLINK_PATH_REJECTED|MAINTENANCE_EDIT_SYMLINK/, f);
  } finally { rmSync(directory); fs.renameSync(moved, directory); }
});

test("TM-09: external and transient symlink attacks receive no provider write authority", async () => {
  const external = realpathSync(mkdtempSync(join(tmpdir(), "cartera-maintenance-external-")));
  const target = join(external, "target"), link = join(harness, "runtime/tests/escape-link");
  writeFileSync(target, "outside workspace");
  try {
    const f = fixture();
    try {
      symlinkSync(target, link);
      await assert.rejects(f.bus.delegate("CHILD", false), /SYMLINK_TARGET_OUTSIDE_WORKSPACE/);
      assert.equal(f.calls(), 0); noResult(f);
    } finally { rmSync(link); f.cleanup(); }
    const transient = fixture([], tmpdir(), "codex");
    try {
      let observed = false;
      transient.bus.providers.codex = new CodexProvider(async request => {
        observed = true; assertReadOnlyRequest(request);
        // The provider receives no writable directory even when no link exists at preflight.
        assert.ok(!request.args.includes("--add-dir"));
        return { exit_code: 0, signal: null, stderr: "", stdout: JSON.stringify(patch(transient.child, [unchangedEdit()])) };
      });
      await transient.bus.delegate("CHILD", false);
      assert.equal(observed, true); assert.equal(existsSync(link), false);
      assert.equal(readFileSync(target, "utf8"), "outside workspace");
    } finally { transient.cleanup(); }
  } finally { rmSync(external, { recursive: true, force: true }); }
});

test("TM-10: an edit omitted from changed_files is rejected and rolled back", async () => {
  const f = fixture(), before = readFileSync(absolute(paths[0]));
  try {
    f.bus.providers[f.route.provider] = { async execute(c) { return patch(c.capsule, [edit()], []); } };
    await assert.rejects(f.bus.delegate("CHILD", false), /MAINTENANCE_CHANGED_FILES_MISMATCH/);
    assert.deepEqual(readFileSync(absolute(paths[0])), before); noResult(f);
  } finally { writeFileSync(absolute(paths[0]), before); f.cleanup(); }
});

test("TM-11: rejects a mismatched expected_before_hash", async () => {
  await rejectEdit({ ...edit(), expected_before_hash: "0".repeat(64) }, /MAINTENANCE_EDIT_HASH_MISMATCH/);
});

test("TM-12: rejects an unauthorized new file", async () => {
  const path = ".cartera/harness/runtime/tests/unauthorized-new.ts";
  await rejectEdit({ relative_path: path, expected_before_hash: null, content: "unauthorized" }, /MAINTENANCE_EDIT_SCOPE_VIOLATION/);
  assert.equal(existsSync(absolute(path)), false);
});

test("TM-13: creates an authorized new file safely", async () => {
  const f = fixture(), path = paths[3], target = absolute(path), before = readFileSync(target);
  try {
    rmSync(target);
    f.bus.providers[f.route.provider] = { async execute(c) { return patch(c.capsule, [{ relative_path: path, expected_before_hash: null, content: "// New authorized test file.\n" }]); } };
    const output = await f.bus.delegate("CHILD", false) as AgentResult;
    assert.deepEqual(output.changed_files, [path]);
    assert.equal(readFileSync(target, "utf8"), "// New authorized test file.\n");
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.deepEqual(f.storage.read("results", "CHILD.json"), output);
  } finally { writeFileSync(target, before); f.cleanup(); }
});

test("TM-14: all four authorized files can be changed by the patch applier", async () => {
  const f = fixture(), originals = paths.map(path => readFileSync(absolute(path)));
  try {
    const edits = paths.map(path => edit(path));
    f.bus.providers[f.route.provider] = { async execute(c) { return patch(c.capsule, edits); } };
    const output = await f.bus.delegate("CHILD", false) as AgentResult;
    assert.deepEqual(output.changed_files, paths);
    edits.forEach(e => assert.equal(readFileSync(absolute(e.relative_path), "utf8"), e.content));
    assert.deepEqual(f.storage.read("results", "CHILD.json"), output);
  } finally { paths.forEach((path, i) => writeFileSync(absolute(path), originals[i])); f.cleanup(); }
});

test("empty maintenance patches are observed and rejected before application or owned tests", async () => {
  const marker = ".cartera/harness/runtime/tests/empty-owned-test-ran";
  const f = fixture([`printf 'unexpected test execution' > ${marker}`]);
  const before = paths.map(path => readFileSync(absolute(path)));
  const returned = patch(f.child, []);
  try {
    f.bus.providers[f.route.provider] = { async execute() { return returned; } };
    await assert.rejects(f.bus.delegate("CHILD", false), /^Error: MAINTENANCE_PATCH_EMPTY$/);
    noResult(f);
    assert.equal(existsSync(absolute(marker)), false);
    paths.forEach((path, i) => assert.deepEqual(readFileSync(absolute(path)), before[i]));
    const events = f.bus.events.list("CHILD");
    assert.ok(!events.some(e => e.event_type === "maintenance.owned_test.failed"));
    const observed = events.find(e => e.event_type === "maintenance.patch.observed")!;
    const artifact = f.storage.read<any>(observed.payload.artifact as string);
    assert.deepEqual(artifact, { task_id: "CHILD", capsule_hash: hash(f.child), patch: returned });
    assert.equal(observed.payload.content_hash, hash(artifact));
  } finally { rmSync(absolute(marker), { force: true }); f.cleanup(); }
});

test("nonempty maintenance patches run normally with pre-application observations inside workspace state", async t => {
  const f = fixture(["printf 'owned test ran\\n'"], join(harness, "state"));
  const original = readFileSync(absolute(paths[0]));
  const returned = patch(f.child, [edit()]);
  const create = f.storage.create.bind(f.storage);
  let observedBeforeApply = false;
  t.mock.method(f.storage, "create", (parts: string[], value: unknown) => {
    if (parts[0] === "maintenance-patch-observations") {
      assert.deepEqual(readFileSync(absolute(paths[0])), original);
      assert.deepEqual(value, { task_id: "CHILD", capsule_hash: hash(f.child), patch: returned });
      observedBeforeApply = true;
    }
    return create(parts, value);
  });
  try {
    // Prepare the existing provider schema before execution, independently of the observation.
    (f.bus as unknown as { providerSchema(c: TaskCapsule, provider: string): string }).providerSchema(f.child, f.route.provider);
    f.bus.providers[f.route.provider] = { async execute() { return returned; } };
    const output = await f.bus.delegate("CHILD", false) as AgentResult;
    assert.equal(observedBeforeApply, true);
    assert.equal(output.status, "completed");
    assert.deepEqual(output.tests_executed, []);
    const executed = f.bus.events.list("CHILD").find(e => e.event_type === "maintenance.owned_test.executed")!;
    assert.deepEqual(executed.payload.tests, [{ command: "printf 'owned test ran\\n'", exit_code: 0 }]);
    assert.equal(readFileSync(absolute(paths[0]), "utf8"), returned.edits[0].content);
    const event = f.bus.events.list("CHILD").find(e => e.event_type === "maintenance.patch.observed")!;
    const observation = f.storage.read<any>(event.payload.artifact as string);
    assert.equal(event.payload.content_hash, hash(observation));
    assert.deepEqual(observation.patch, returned);
  } finally { writeFileSync(absolute(paths[0]), original); f.cleanup(); }
});

test("TM-15: maintenance provider has zero workspace write authority", async () => {
  const f = fixture([], tmpdir(), "codex"); let calls = 0;
  try {
    f.bus.providers.codex = new CodexProvider(async request => {
      calls++; assertReadOnlyRequest(request);
      assert.match(request.stdin, /read-only mode/);
      assert.match(request.stdin, /Never modify the workspace/);
      return { exit_code: 0, signal: null, stderr: "", stdout: JSON.stringify(patch(f.child, [unchangedEdit()])) };
    });
    await f.bus.delegate("CHILD", false); assert.equal(calls, 1);
  } finally { f.cleanup(); }
  // An injected provider that violates the read-only contract cannot publish a result.
  const rogue = fixture(), before = readFileSync(absolute(paths[0]));
  try {
    rogue.bus.providers[rogue.route.provider] = { async execute(c) { writeFileSync(absolute(paths[0]), "rogue write"); return patch(c.capsule, []); } };
    await assert.rejects(rogue.bus.delegate("CHILD", false), /MAINTENANCE_PROVIDER_WRITE_FORBIDDEN/); noResult(rogue);
  } finally { writeFileSync(absolute(paths[0]), before); rogue.cleanup(); }
});

test("TM-16: maintenance grants remain one-shot after success or provider failure", async () => {
  for (const failure of [false, true]) {
    const f = fixture(); let calls = 0;
    try {
      f.bus.providers[f.route.provider] = { async execute(c) { calls++; if (failure) throw new Error("PROVIDER_FAILURE"); return patch(c.capsule, [unchangedEdit()]); } };
      if (failure) { await assert.rejects(f.bus.delegate("CHILD", false), /PROVIDER_FAILURE/); noResult(f); }
      else await f.bus.delegate("CHILD", false);
      await assert.rejects(new AgentBus(f.storage, f.bus.providers).delegate("CHILD", false), /EXECUTION_GRANT_CONSUMED/);
      assert.equal(calls, 1);
      assert.equal(f.storage.read<any>("execution-grant-consumptions", "CHILD.json").usage_state, "consumed");
    } finally { f.cleanup(); }
  }
});

test("TM-17: global model execution remains disabled", async () => {
  const f = fixture(), config = readFileSync(join(harness, "config/runtime.json"));
  try {
    assert.equal(f.bus.runtime.model_execution_enabled, false);
    await f.bus.delegate("CHILD", false);
    assert.equal(f.bus.runtime.model_execution_enabled, false);
    assert.equal(new AgentBus(f.storage).runtime.model_execution_enabled, false);
    await assert.rejects(f.bus.delegate("ROOT", false), /MODEL_EXECUTION_DISABLED/);
    assert.deepEqual(readFileSync(join(harness, "config/runtime.json")), config);
    assert.equal(JSON.parse(config.toString()).model_execution_enabled, false);
  } finally { f.cleanup(); }
});

test("TM-18: frontend and backend still require owned worktrees", async () => {
  const f = fixture();
  try {
    for (const [role, id] of [["frontend-worker", "FRONT"], ["backend-worker", "BACK"]] as const) {
      const c = capsule(id, null, role, "restricted-path-write");
      f.bus.init(c); f.bus.transition(id, "TASK_CLASSIFIED", 0); f.bus.transition(id, "IMPLEMENTATION_RUNNING", 1);
      f.bus.runtime.model_execution_enabled = true; f.bus.executionPolicy.write_application_execution = true;
      await assert.rejects(f.bus.delegate(id, false), /OWNED_WORKTREE_REQUIRED/);
      assert.equal(f.storage.exists("results", id + ".json"), false);
    }
    assert.equal(f.calls(), 0);
  } finally { f.bus.runtime.model_execution_enabled = false; f.cleanup(); }
});

test("TM-19: AgentResult is persisted only after complete validation", async () => {
  for (const mode of ["identity", "schema", "evidence", "scope"] as const) {
    const f = fixture(), before = readFileSync(absolute(paths[0]));
    try {
      f.bus.providers[f.route.provider] = { async execute(c) {
        noResult(f); const output = patch(c.capsule, [edit()]);
        if (mode === "identity") output.agent_result.task_id = "WRONG";
        if (mode === "schema") output.agent_result.status = "invalid" as any;
        if (mode === "evidence") output.agent_result.evidence[0].source = paths[0] + ":99999999";
        if (mode === "scope") output.agent_result.scope_expanded = true;
        return output;
      } };
      await assert.rejects(f.bus.delegate("CHILD", false), /AGENT_RESULT_IDENTITY_MISMATCH|INVALID_AGENT_RESULT|EVIDENCE_LINE_MISSING|SCOPE_EXPANSION_PERFORMED/);
      noResult(f); assert.deepEqual(readFileSync(absolute(paths[0])), before);
      await assert.rejects(f.bus.delegate("CHILD", false), /EXECUTION_GRANT_CONSUMED/);
    } finally { writeFileSync(absolute(paths[0]), before); f.cleanup(); }
  }
});

test("TM-20: application and owned-test failures restore authorized files", async t => {
  await t.test("application failure rolls back earlier edits and cleans temporary files", async t => {
    const f = fixture(), originals = paths.map(path => readFileSync(absolute(path)));
    const directories = [...new Set(paths.map(path => dirname(absolute(path))))];
    const entries = directories.map(path => readdirSync(path).sort());
    const rename = fs.renameSync; let renames = 0;
    const mocked = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      renames++;
      if (renames === 2) {
        assert.notDeepEqual(readFileSync(absolute(paths[0])), originals[0]);
        throw new Error("INJECTED_APPLICATION_FAILURE");
      }
      return rename(from, to);
    });
    syncBuiltinESMExports();
    try {
      f.bus.providers[f.route.provider] = { async execute(c) { return patch(c.capsule, paths.map(path => edit(path))); } };
      await assert.rejects(f.bus.delegate("CHILD", false), /INJECTED_APPLICATION_FAILURE/);
      assert.equal(renames, 2); noResult(f);
      paths.forEach((path, i) => assert.deepEqual(readFileSync(absolute(path)), originals[i]));
      directories.forEach((path, i) => assert.deepEqual(readdirSync(path).sort(), entries[i]));
    } finally {
      mocked.mock.restore(); syncBuiltinESMExports();
      paths.forEach((path, i) => writeFileSync(absolute(path), originals[i])); f.cleanup();
    }
  });
  await t.test("owned-test output is persisted before rollback and remains available after files are restored", async t => {
    const target = absolute(paths[3]), originals = paths.map(path => readFileSync(absolute(path)));
    const command = "printf 'owned-test stdout after apply\\n'; printf 'owned-test failure after apply\\n' >&2; exit 19";
    const f = fixture([command]);
    const create = f.storage.create.bind(f.storage);
    let persistedBeforeRollback = false;
    t.mock.method(f.storage, "create", (parts: string[], value: unknown) => {
      if (parts[0] === "maintenance-test-failures") {
        assert.notDeepEqual(readFileSync(absolute(paths[0])), originals[0]);
        assert.equal(readFileSync(target, "utf8"), "// New file before failed test.\n");
        persistedBeforeRollback = true;
      }
      return create(parts, value);
    });
    try {
      rmSync(target);
      const returned = patch(f.child, [edit(), { relative_path: paths[3], expected_before_hash: null, content: "// New file before failed test.\n" }]);
      f.bus.providers[f.route.provider] = { async execute() { return returned; } };
      await assert.rejects(f.bus.delegate("CHILD", false), /MAINTENANCE_OWNED_TEST_FAILED/);
      noResult(f); assert.deepEqual(readFileSync(absolute(paths[0])), originals[0]); assert.equal(existsSync(target), false);
      assert.equal(persistedBeforeRollback, true);
      const events = f.bus.events.list("CHILD");
      const observed = events.find(e => e.event_type === "maintenance.patch.observed")!;
      const observation = f.storage.read<any>(observed.payload.artifact as string);
      assert.equal(observed.payload.content_hash, hash(observation));
      assert.deepEqual(observation, { task_id: "CHILD", capsule_hash: hash(f.child), patch: returned });
      const failure = events.find(e => e.event_type === "maintenance.owned_test.failed")!;
      assert.ok(failure);
      assert.ok(events.indexOf(observed) < events.indexOf(failure));
      const artifact = f.storage.read(failure.payload.artifact as string);
      assert.deepEqual(artifact, {
        task_id: "CHILD", capsule_hash: hash(f.child), command, exit_code: 19,
        stdout: "owned-test stdout after apply\n", stderr: "owned-test failure after apply\n",
        applied_paths: [paths[0], paths[3]],
      });
      assert.equal(failure.payload.content_hash, hash(artifact));
      assert.ok(events.indexOf(failure) < events.findIndex(e => e.event_type === "agent.failed"));
      await assert.rejects(f.bus.delegate("CHILD", false), /EXECUTION_GRANT_CONSUMED/);
    } finally { paths.forEach((path, i) => writeFileSync(absolute(path), originals[i])); f.cleanup(); }
  });
});

test("maintenance grant rejects wrong role, worktree, marker, permission, or paths", () => {
  const f = fixture();
  try {
    for (const bad of [
      { ...f.child, role: "backend-worker" }, { ...f.child, worktree: {} as any },
      { ...f.child, constraints: ["CORE_ENGINEERING_V1"] }, { ...f.child, permissions: "workspace-write" as const },
      { ...f.child, allowed_paths: [] },
    ]) assert.throws(() => f.grants.issue(bad, f.root, f.route, "maintenance-write", "trusted-operator-cli", "test"), /EXECUTION_GRANT_(MAINTENANCE_SCOPE_REQUIRED|ROLE_MISMATCH)/);
  } finally { f.cleanup(); }
});

test("trusted operator CLI issues maintenance-write without invoking the provider", () => {
  const f = fixture();
  try {
    rmSync(f.storage.path("execution-grants", "CHILD.json"));
    const stdout = execFileSync(process.execPath, [join(harness, "dist/cli/main.js"), "execution-grant", "CHILD", "approved maintenance", "--mode", "maintenance-write", "--capsule-hash", hash(f.child)], { encoding: "utf8", env: { ...process.env, CARTERA_HARNESS_STATE: f.storage.root } });
    const grant = JSON.parse(stdout);
    assert.equal(grant.maintenance_write, true);
    assert.equal(grant.execution_mode, "orchestrated-read-only-diagnosis"); assert.equal(f.calls(), 0);
  } finally { f.cleanup(); }
});

for (const [name, allowed_paths] of [
  ["A", [paths[0]]],
  ["B", [".cartera/harness/runtime/src/workflow/engineering/adapters.ts", ".cartera/harness/runtime/src/workflow/review.ts"]],
] as const) test(`canonical maintenance flow grants capsule ${name} only its own paths`, async () => {
  const f = fixture();
  const child = { ...f.child, task_id: `CAPSULE_${name}`, allowed_paths: [...allowed_paths], required_context: [allowed_paths[0]] };
  const original = readFileSync(absolute(allowed_paths[0]));
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [join(harness, "dist/cli/main.js"), ...args],
    { encoding: "utf8", env: { ...process.env, CARTERA_HARNESS_STATE: f.storage.root } }));
  try {
    f.bus.init(child);
    const prepared = cli("maintenance", "prepare", child.task_id, "--capsule-hash", hash(child));
    assert.equal(prepared.state, "IMPLEMENTATION_RUNNING");
    assert.equal(prepared.revision, 2);
    assert.deepEqual(f.bus.events.list(child.task_id).filter(e => e.event_type === "task.transitioned").map(e => [e.payload.from, e.payload.to]),
      [["TASK_RECEIVED", "TASK_CLASSIFIED"], ["TASK_CLASSIFIED", "IMPLEMENTATION_RUNNING"]]);
    assert.equal(f.storage.exists("execution-grants", child.task_id + ".json"), false);
    assert.equal(f.calls(), 0);
    assert.equal(cli("maintenance", "prepare", child.task_id, "--capsule-hash", hash(child)).revision, 2);
    const grant = cli("execution-grant", child.task_id, "approved scoped maintenance", "--mode", "maintenance-write", "--capsule-hash", hash(child));
    assert.equal(grant.capsule_hash, hash(child));
    assert.equal(grant.maintenance_write, true);
    assert.equal(f.calls(), 0);
    assert.throws(() => f.grants.eligible({ ...child, allowed_paths: [...child.allowed_paths, ".cartera/harness/README.md"] }, f.root, f.route), /EXECUTION_GRANT_BINDING_MISMATCH/);
    f.bus.providers[f.route.provider] = { async execute(request) {
      const output = patch(request.capsule, [edit(allowed_paths[0])]);
      output.agent_result.evidence[0].source = allowed_paths[0] + ":1";
      return output;
    } };
    const output = await f.bus.delegate(child.task_id, false) as AgentResult;
    assert.deepEqual(output.changed_files, [allowed_paths[0]]);
    assert.equal(output.status, "completed");
    assert.deepEqual(f.bus.result(child.task_id), output);
    await assert.rejects(f.bus.delegate(child.task_id, false), /EXECUTION_GRANT_CONSUMED/);
  } finally { writeFileSync(absolute(allowed_paths[0]), original); f.cleanup(); }
});

for (const [name, rejected] of [
  ["paths outside the harness", ["cartera-backend/unauthorized.ts", ".cartera/harness-other/file.ts"]],
  ["Git metadata", [".git/config", ".cartera/harness/.git/config", ".cartera/harness/runtime/.git/config"]],
  ["Agent Bus state", [".cartera/harness/state", ".cartera/harness/state/forged.json", ".cartera/harness/./state/forged.json"]],
] as const) test(`maintenance grants reject ${name} even when explicitly allowed by the capsule`, () => {
  const f = fixture();
  try {
    for (const path of rejected) {
      const child = { ...f.child, task_id: "INVALID_SCOPE", allowed_paths: [path], required_context: [], forbidden_paths: [] };
      assert.throws(() => f.grants.issue(child, f.root, f.route, "maintenance-write", "trusted-operator-cli", "test"), /EXECUTION_GRANT_MAINTENANCE_PATH_REQUIRED/);
      assert.equal(f.storage.exists("execution-grants", child.task_id + ".json"), false);
    }
  } finally { f.cleanup(); }
});

test("maintenance grant issuance rejects tasks before IMPLEMENTATION_RUNNING", () => {
  const f = fixture();
  const child = { ...f.child, task_id: "UNPREPARED" };
  try {
    f.bus.init(child);
    for (const state of ["TASK_RECEIVED", "TASK_CLASSIFIED"] as const) {
      assert.equal(f.bus.events.get(child.task_id).state, state);
      assert.throws(() => f.grants.issue(child, f.root, f.route, "maintenance-write", "trusted-operator-cli", "test"), /IMPLEMENTATION_STATE_REQUIRED/);
      assert.throws(() => execFileSync(process.execPath, [join(harness, "dist/cli/main.js"), "execution-grant", child.task_id, "approved maintenance", "--mode", "maintenance-write", "--capsule-hash", hash(child)],
        { encoding: "utf8", stdio: "pipe", env: { ...process.env, CARTERA_HARNESS_STATE: f.storage.root } }),
        (error: any) => error.status === 1 && /UNEXECUTED_HANDOFF_CHILD_REQUIRED/.test(error.stderr));
      assert.equal(f.storage.exists("execution-grants", child.task_id + ".json"), false);
      assert.equal(f.calls(), 0);
      if (state === "TASK_RECEIVED") f.bus.transition(child.task_id, "TASK_CLASSIFIED", 0);
    }
  } finally { f.cleanup(); }
});

test("maintenance grant keeps the worker tests_executed claim and records owned test runs separately", async () => {
  const command = "printf 'owned-test evidence\\n'";
  const f = fixture([command]);
  try {
    const output = await f.bus.delegate("CHILD", false) as AgentResult;
    assert.deepEqual(output.tests_executed, [], "the worker claimed nothing and its claim stays untouched");
    assert.deepEqual(f.storage.read("results", "CHILD.json"), output);
    const executed = f.bus.events.list("CHILD").filter(e => e.event_type === "maintenance.owned_test.executed");
    assert.equal(executed.length, 1);
    assert.deepEqual(executed[0].payload.tests, [{ command, exit_code: 0 }]);
    const record = f.storage.read<any>(executed[0].payload.artifact as string);
    assert.equal(executed[0].payload.content_hash, hash(record));
    assert.equal(record.capsule_hash, hash(f.child));
    assert.match(record.tests[0].evidence, /owned-test evidence/);
  } finally { f.cleanup(); }
});

test("undeclared direct provider writes to operational, application, and extra harness files are rejected", async () => {
  for (const path of [
    "cartera-frontend/.git/maintenance-probe", "cartera-frontend/maintenance-probe", "cartera-backend/maintenance-probe",
    ".cartera/harness/runtime/tests/maintenance-probe", ".cartera/harness/state/events/CHILD.jsonl",
    ".cartera/harness/state/provider-observations/CHILD-forged.json", ".cartera/harness/state/execution-grant-consumptions/CHILD.json",
  ]) {
    const target = absolute(path), f = fixture();
    mkdirSync(dirname(target), { recursive: true });
    try {
      f.bus.providers[f.route.provider] = { async execute(c) { writeFileSync(target, "undeclared provider write"); return patch(c.capsule, []); } };
      await assert.rejects(f.bus.delegate("CHILD", false), /MAINTENANCE_PROVIDER_WRITE_FORBIDDEN/); noResult(f);
    } finally { rmSync(target, { force: true }); f.cleanup(); }
  }
});

test("an internal symlink does not prevent a validated edit to its regular target", async () => {
  const f = fixture(), target = absolute(paths[0]), before = readFileSync(target);
  const link = join(harness, "runtime/tests/internal-probe");
  try {
    symlinkSync(target, link);
    const change = edit();
    f.bus.providers[f.route.provider] = { async execute(c) { return patch(c.capsule, [change]); } };
    const output = await f.bus.delegate("CHILD", false) as AgentResult;
    assert.deepEqual(output.changed_files, [paths[0]]);
    assert.equal(readFileSync(link, "utf8"), change.content);
  } finally { rmSync(link, { force: true }); writeFileSync(target, before); f.cleanup(); }
});

test("broken and escaping-chain symlinks fail before the provider runs", async () => {
  const external = realpathSync(mkdtempSync(join(tmpdir(), "cartera-maintenance-chain-")));
  const target = join(external, "target"); writeFileSync(target, "external target");
  const link = join(harness, "runtime/tests/link-probe"), chain = join(harness, "runtime/tests/chain-probe");
  try {
    for (const broken of [false, true]) {
      const f = fixture();
      try {
        if (broken) symlinkSync(join(workspace, "missing-target"), link);
        else { symlinkSync(target, chain); symlinkSync(chain, link); }
        await assert.rejects(f.bus.delegate("CHILD", false), /SYMLINK_TARGET_(OUTSIDE_WORKSPACE|INVALID)/);
        assert.equal(f.calls(), 0); noResult(f);
      } finally { rmSync(link, { force: true }); rmSync(chain, { force: true }); f.cleanup(); }
    }
  } finally { rmSync(external, { recursive: true, force: true }); }
});
