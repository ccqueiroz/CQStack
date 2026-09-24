import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBus } from "../src/agent-bus/index.js";
import { ExecutionGrants } from "../src/execution/grants.js";
import { HARNESS_ROOT, Storage, hash } from "../src/storage.js";
import { smokeCapsule } from "../src/providers/smoke.js";
import { invoke, TOOL_DESCRIPTORS } from "../src/surface.js";
import type { AgentExecutionRequest, AgentResult, TaskCapsule, ResolvedRole } from "../src/contracts.js";

const mode = "orchestrated-read-only-diagnosis";
const source = ".cartera/harness/runtime/src/execution/grants.ts";
const issuer = "trusted-operator-cli";

function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "cartera-diagnostic-grants-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const storage = new Storage(directory);
  let calls = 0;
  const double = { async execute(r: AgentExecutionRequest) {
    calls++;
    assert.equal(storage.read<any>("execution-grant-consumptions", r.capsule.task_id + ".json").usage_state, "consumed");
    return result(r.capsule);
  } };
  const bus = new AgentBus(storage, { codex: double, claude: double });
  const root: TaskCapsule = { ...smokeCapsule("codex", "DIAG-ROOT"), role: "master-orchestrator", constraints: ["CORE_UNDERSTANDING_ROOT_V1"] };
  const child: TaskCapsule = { ...smokeCapsule("codex", "DIAG-CHILD"), parent_task_id: root.task_id, role: "truth",
    responsibility: "Read the grant policy and report one source-backed observation", goal: "Read-only diagnosis",
    allowed_paths: [source], required_context: [source], constraints: ["Read only authorized source; do not execute tests, write, or delegate."] };
  bus.init(root); bus.init(child);
  const route = bus.routeFor(child);
  const grants = new ExecutionGrants(storage, () => bus.runtime.model_execution_enabled);
  const issue = () => grants.issue(child, root, route, mode, issuer, "Explicit operator diagnostic grant");
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(HARNESS_ROOT, "dist/cli/main.js"), "execution-grant", child.task_id, "Operator diagnostic authorization", ...args],
    { encoding: "utf8", env: { ...process.env, CARTERA_HARNESS_STATE: storage.root } });
  return { storage, bus, root, child, route, grants, issue, cli, calls: () => calls };
}

function result(c: TaskCapsule): AgentResult {
  return { task_id: c.task_id, role: c.role, status: "completed", summary: "Read-only policy observation",
    changed_files: [], evidence: [{ assertion: "Grant policy uses task and route contracts", source: source + ":1", observation: "Imports TaskCapsule and ResolvedRole" }],
    tests_executed: [], tests_not_executed: [], api_contract_status: "not_applicable", visual_lock_status: "not_applicable",
    scope_expanded: false, deviations: [], risks: [], known_issues: [], requested_followups: [] };
}

test("operator CLI explicitly grants an exact diagnostic capsule without executing it; a fresh bus consumes it once", async t => {
  const f = fixture(t);
  const output = f.cli("--mode", mode, "--capsule-hash", hash(f.child));
  assert.equal(output.status, 0, output.stderr);
  const grant = JSON.parse(output.stdout);
  assert.equal(grant.execution_mode, mode);
  assert.equal(grant.issuer, issuer);
  assert.equal(grant.capsule_hash, hash(f.child));
  assert.equal(grant.root_capsule_hash, hash(f.root));
  assert.equal(grant.route_hash, hash(f.route));
  assert.equal(grant.permission_ceiling, "read-only");
  assert.equal(f.calls(), 0);
  const consumer = new AgentBus(f.storage, f.bus.providers);
  await invoke(consumer, "agent_delegate", { task_id: f.child.task_id });
  assert.equal(f.storage.exists("execution-grant-consumptions", f.child.task_id + ".json"), false);
  await invoke(consumer, "agent_delegate", { task_id: f.child.task_id, dry_run: false });
  assert.deepEqual(consumer.result(f.child.task_id), result(f.child));
  assert.equal(consumer.events.list(f.child.task_id).filter(e => e.event_type === "agent.result.validated").length, 1);
  await assert.rejects(new AgentBus(f.storage, f.bus.providers).delegate(f.child.task_id, false), /EXECUTION_GRANT_CONSUMED/);
  assert.equal(f.calls(), 1);
  assert.equal(consumer.runtime.model_execution_enabled, false);
});

test("the persisted Fable diagnostic capsule is eligible in isolated test storage only under its root's persisted route, without issuing a real grant", t => {
  const f = fixture(t), task = "PHASE2-LIFECYCLE-DIAG-truth-review-lifecycle";
  const readCapsule = (name: string): TaskCapsule => JSON.parse(readFileSync(join(HARNESS_ROOT, "state/events", name + ".jsonl"), "utf8").split("\n")[0]).payload.capsule;
  const c = readCapsule(task), root = readCapsule(c.parent_task_id!);
  assert.equal(hash(c), "3b06266d8b3ae60d41be1ca2023e0ee5aae8360481ef9067f3b877cd51b95b11");
  // The legacy root predates routing snapshots; its historical route lives in the codex profile.
  const route = f.bus.router.resolve(c.role, "codex");
  assert.throws(() => f.grants.issue(c, root, route, mode, issuer, "No persisted route yet"), /ROUTING_SNAPSHOT_REQUIRED/);
  f.storage.create(["routing", root.task_id + ".json"], f.bus.router.snapshot(root.task_id, "codex"));
  const grant = f.grants.issue(c, root, route, mode, issuer, "Isolated policy eligibility test only");
  assert.deepEqual(f.grants.eligible(c, root, route), grant);
  assert.throws(() => f.grants.eligible(c, root, f.bus.router.resolve(c.role, "claude")), /BINDING_MISMATCH/);
  assert.equal(f.calls(), 0);
});

const ineligible: Array<[string, (c: TaskCapsule, root: TaskCapsule, route: ResolvedRole) => void]> = [
  ["write permission", c => { c.permissions = "restricted-path-write"; }],
  ["worktree", c => { c.worktree = {} as any; }],
  ["owned tests", c => { c.owned_tests = ["npm test"]; }],
  ["API Contract", c => { c.api_contract_reference = { id: "api", version: "1", content_hash: "a".repeat(64) }; }],
  ["Visual Lock", c => { c.visual_lock_reference = { id: "visual", version: "1", content_hash: "a".repeat(64) }; }],
  ["unrelated root", c => { c.parent_task_id = "OTHER"; }],
  ["nested root", (_c, root) => { root.parent_task_id = "OTHER"; }],
  ["worker root", (_c, root) => { root.role = "truth"; }],
  ["writable root", (_c, root) => { root.permissions = "workspace-write"; }],
  ["root worktree", (_c, root) => { root.worktree = {} as any; }],
  ["another read-only role", (c, _root, r) => { c.role = "gap"; r.role.role = "gap"; }],
  ["role route mismatch", (_c, _root, r) => { r.role.role = "gap"; }],
  ["write-capable role", (_c, _root, r) => { r.role.mutation_permission = "workspace-write"; }],
  ["delegation-capable role", (_c, _root, r) => { r.role.allowed_capabilities.push("delegate"); }],
  ["application scope", c => { c.allowed_paths = ["cartera-backend"]; }],
  ["blanket harness scope", c => { c.allowed_paths = [".cartera/harness/"]; }],
  ["blanket repository scope", c => { c.allowed_paths = ["."]; }],
  ["empty scope", c => { c.allowed_paths = []; }],
  ["forbidden scope", c => { c.forbidden_paths.push(source); }],
  ["out-of-scope context", c => { c.required_context = [".cartera/harness/README.md"]; }],
  ["forbidden context", c => { c.allowed_paths = [".cartera/harness/runtime/src/"]; c.forbidden_paths.push(source); }],
  ["Git metadata", c => { c.allowed_paths = [".cartera/harness/.git"]; }],
  ["path traversal", c => { c.allowed_paths = [".cartera/harness/../../cartera-backend"]; }],
];
for (const [name, change] of ineligible) test(`diagnostic mode rejects ${name} at issuance`, t => {
  const f = fixture(t), c = structuredClone(f.child), root = structuredClone(f.root), route = structuredClone(f.route);
  change(c, root, route);
  assert.throws(() => f.grants.issue(c, root, route, mode, issuer, "Test refusal"), /EXECUTION_GRANT_|INVALID_SCOPE_PATH/);
  assert.equal(f.storage.exists("execution-grants", c.task_id + ".json"), false);
  assert.equal(f.calls(), 0);
});

const mismatches: Array<[string, (c: TaskCapsule, root: TaskCapsule, route: ResolvedRole) => void]> = [
  ["capsule hash", c => { c.goal += " changed"; }],
  ["root hash", (_c, root) => { root.goal += " changed"; }],
  ["root id", (_c, root) => { root.task_id = "OTHER"; }],
  ["parent id", c => { c.parent_task_id = "OTHER"; }],
  ["role", c => { c.role = "gap"; }],
  ["provider", (_c, _root, r) => { r.provider = r.provider === "codex" ? "claude" : "codex"; }],
  ["model alias", (_c, _root, r) => { r.model_alias = "other-alias"; }],
  ["resolved model", (_c, _root, r) => { r.model = "different-model"; }],
  ["provider command", (_c, _root, r) => { r.provider_command = "other-command"; }],
  ["role route capabilities", (_c, _root, r) => { r.role.allowed_capabilities.push("delegate"); }],
  ["different allowed scope", c => { c.allowed_paths.push(".cartera/harness/README.md"); }],
  ["different forbidden scope", c => { c.forbidden_paths = []; }],
  ["escalated permission", c => { c.permissions = "workspace-write"; }],
  ["added worktree", c => { c.worktree = {} as any; }],
  ["added tests", c => { c.owned_tests.push("npm test"); }],
  ["added API lock", c => { c.api_contract_reference = {} as any; }],
  ["added visual lock", c => { c.visual_lock_reference = {} as any; }],
];
for (const [name, change] of mismatches) test(`diagnostic grant denies changed ${name} at consumption`, t => {
  const f = fixture(t), grant = f.issue(), c = structuredClone(f.child), root = structuredClone(f.root), route = structuredClone(f.route);
  change(c, root, route);
  assert.throws(() => f.grants.consume(c, root, route, grant), /EXECUTION_GRANT_BINDING_MISMATCH/);
  assert.equal(f.storage.exists("execution-grant-consumptions", f.child.task_id + ".json"), false);
  assert.equal(f.calls(), 0);
});

test("a copied diagnostic grant cannot authorize a different child", async t => {
  const f = fixture(t), grant = f.issue(), other = { ...f.child, task_id: "OTHER-CHILD" };
  f.bus.init(other);
  await assert.rejects(f.bus.delegate(other.task_id, false), /MODEL_EXECUTION_DISABLED/);
  f.storage.create(["execution-grants", other.task_id + ".json"], grant);
  await assert.rejects(f.bus.delegate(other.task_id, false), /EXECUTION_GRANT_BINDING_MISMATCH/);
  assert.equal(f.calls(), 0);
});

test("diagnostic grants pin the root's persisted truth route, never a live re-resolution", t => {
  const f = fixture(t);
  const persisted = f.bus.routing(f.root.task_id)!.routes.truth;
  f.bus.router.models[persisted.model_alias].model = "operator-reconfigured-model";
  const live = f.bus.router.resolve("truth");
  assert.notEqual(live.model, persisted.model);
  assert.throws(() => f.grants.issue(f.child, f.root, live, mode, issuer, "Live route must not be granted"), /EXECUTION_GRANT_ROUTE_MISMATCH/);
  const grant = f.grants.issue(f.child, f.root, f.route, mode, issuer, "Pin the persisted route");
  assert.equal(grant.model, persisted.model);
  assert.deepEqual(f.grants.eligible(f.child, f.root, f.route), grant);
  assert.throws(() => f.grants.eligible(f.child, f.root, live), /BINDING_MISMATCH/);
});

test("global unrelated execution stays disabled before and after diagnostic grant consumption", async t => {
  const f = fixture(t), unrelated = { ...f.child, task_id: "UNRELATED" };
  f.bus.init(unrelated);
  await assert.rejects(f.bus.delegate(f.child.task_id, false), /MODEL_EXECUTION_DISABLED/);
  f.issue(); await assert.rejects(f.bus.delegate(unrelated.task_id, false), /MODEL_EXECUTION_DISABLED/);
  await f.bus.delegate(f.child.task_id, false);
  await assert.rejects(f.bus.delegate(unrelated.task_id, false), /MODEL_EXECUTION_DISABLED/);
  assert.equal(f.bus.runtime.model_execution_enabled, false);
  assert.equal(f.calls(), 1);
});

test("diagnostic mode requires global execution disabled at both issuance and consumption", async t => {
  const f = fixture(t);
  f.bus.runtime.model_execution_enabled = true;
  assert.throws(f.issue, /DIAGNOSIS_OPERATOR_REQUIRED/);
  f.bus.runtime.model_execution_enabled = false;
  f.issue(); f.bus.runtime.model_execution_enabled = true;
  await assert.rejects(f.bus.delegate(f.child.task_id, false), /DIAGNOSIS_OPERATOR_REQUIRED/);
  assert.equal(f.calls(), 0);
});

test("diagnostic mode requires the trusted operator issuer at issuance and consumption", t => {
  const f = fixture(t);
  assert.throws(() => f.grants.issue(f.child, f.root, f.route, mode, "fable", "Not operator"), /DIAGNOSIS_OPERATOR_REQUIRED/);
  const grant = f.issue();
  writeFileSync(f.storage.path("execution-grants", f.child.task_id + ".json"), JSON.stringify({ ...grant, issuer: "fable" }));
  assert.throws(() => f.grants.eligible(f.child, f.root, f.route), /DIAGNOSIS_OPERATOR_REQUIRED/);
});

test("MCP cannot mint a diagnostic grant or inject a grant, mode or issuer into delegation", async t => {
  const f = fixture(t);
  assert.ok(TOOL_DESCRIPTORS.every(d => !d.name.includes("grant")));
  await assert.rejects(invoke(f.bus, "execution_grant", { task_id: f.child.task_id, mode, issuer }), /UNKNOWN_TOOL/);
  for (const extra of [{ execution_grant: {} }, { mode }, { issuer }])
    await assert.rejects(invoke(f.bus, "agent_delegate", { task_id: f.child.task_id, dry_run: false, ...extra }), /INVALID_ARGUMENTS/);
  assert.equal(f.storage.exists("execution-grants", f.child.task_id + ".json"), false);
});

test("the CLI requires explicit diagnostic mode and the exact reviewed capsule hash", t => {
  const f = fixture(t);
  for (const args of [[], ["--mode", mode], ["--mode", mode, "--capsule-hash", "0".repeat(64)], ["--mode", "fixed-smoke", "--capsule-hash", hash(f.child)]]) {
    const output = f.cli(...args);
    assert.equal(output.status, 1);
    assert.match(output.stderr, /HANDOFF_SCOPE_REQUIRED|USAGE|CAPSULE_HASH_MISMATCH/);
    assert.equal(f.storage.exists("execution-grants", f.child.task_id + ".json"), false);
  }
});

test("a separate process cannot reuse a diagnostic grant consumed before a crash window", t => {
  const f = fixture(t), grant = f.issue();
  f.grants.consume(f.child, f.root, f.route, grant);
  const output = spawnSync(process.execPath, [join(HARNESS_ROOT, "dist/cli/main.js"), "delegate", f.child.task_id, "--execute"],
    { encoding: "utf8", env: { ...process.env, CARTERA_HARNESS_STATE: f.storage.root } });
  assert.equal(output.status, 1);
  assert.match(output.stderr, /EXECUTION_GRANT_CONSUMED/);
  assert.equal(f.bus.events.list(f.child.task_id).some(e => e.event_type === "agent.started"), false);
});

for (const [name, provider, error] of [
  ["provider failure", async (_c: TaskCapsule) => { throw new Error("PROVIDER_FAILURE"); }, /PROVIDER_FAILURE/],
  ["invalid AgentResult", async (c: TaskCapsule) => ({ ...result(c), status: "invalid" } as any), /INVALID_AGENT_RESULT/],
  ["reported test execution", async (c: TaskCapsule) => ({ ...result(c), tests_executed: [{ command: "npm test", exit_code: 0, evidence: "Unauthorized test execution" }] }), /DIAGNOSTIC_TEST_EXECUTION_FORBIDDEN/],
  ["out-of-scope evidence", async (c: TaskCapsule) => ({ ...result(c), evidence: [{ assertion: "Outside", source: ".cartera/harness/README.md:1", observation: "Outside capsule" }] }), /EVIDENCE_OUTSIDE_SCOPE/],
  ["read-only mutation", async (c: TaskCapsule) => ({ ...result(c), changed_files: [source] }), /READ_ONLY_MUTATION/],
] as const) test(`diagnostic ${name} never restores consumed authority`, async t => {
  const f = fixture(t); f.issue();
  f.bus.providers[f.route.provider] = { execute: r => provider(r.capsule) };
  await assert.rejects(f.bus.delegate(f.child.task_id, false), error);
  assert.equal(f.storage.exists("results", f.child.task_id + ".json"), false);
  await assert.rejects(new AgentBus(f.storage).delegate(f.child.task_id, false), /EXECUTION_GRANT_CONSUMED/);
});
