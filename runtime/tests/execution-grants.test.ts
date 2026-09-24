import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBus } from "../src/agent-bus/index.js";
import { ExecutionGrants } from "../src/execution/grants.js";
import { Storage, hash, HARNESS_ROOT } from "../src/storage.js";
import { smokeCapsule } from "../src/providers/smoke.js";
import { invoke, TOOL_DESCRIPTORS } from "../src/surface.js";
import type { AgentExecutionRequest, AgentResult, TaskCapsule, ResolvedRole } from "../src/contracts.js";

function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "cartera-grants-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const storage = new Storage(directory);
  let calls = 0;
  const double = { async execute(r: AgentExecutionRequest) {
    calls++;
    assert.equal(storage.read<any>("execution-grant-consumptions", r.capsule.task_id + ".json").usage_state, "consumed");
    return result(r.capsule);
  } };
  const bus = new AgentBus(storage, { codex: double, claude: double });
  const root = smokeCapsule("codex", "ROOT");
  const child = { ...smokeCapsule("codex", "CHILD"), parent_task_id: root.task_id };
  bus.init(root); bus.init(child);
  const route = bus.routeFor(child);
  const grants = new ExecutionGrants(storage);
  const issue = () => grants.issue(child, root, route, "read-only-harness", "trusted-bootstrap", "User-authorized handoff");
  return { storage, bus, child, root, route, grants, issue, calls: () => calls };
}

function result(c: TaskCapsule): AgentResult {
  return { task_id: c.task_id, role: c.role, status: "completed", summary: "Shared runtime",
    changed_files: [], evidence: [{ assertion: "Shared runtime", source: ".cartera/harness/README.md:3", observation: "CLI and MCP share a runtime" }],
    tests_executed: [], tests_not_executed: [], api_contract_status: "not_applicable", visual_lock_status: "not_applicable",
    scope_expanded: false, deviations: [], risks: [], known_issues: [], requested_followups: [] };
}

test("a trusted grant survives a new bus and executes through the public delegation surface once", async t => {
  const f = fixture(t), grant = f.issue();
  assert.equal(f.bus.runtime.model_execution_enabled, false);
  assert.deepEqual(f.grants.eligible(f.child, f.root, f.route), grant);
  const consumer = new AgentBus(f.storage, f.bus.providers);
  await invoke(consumer, "agent_delegate", { task_id: "CHILD" });
  assert.equal(f.calls(), 0);
  assert.equal(f.storage.exists("execution-grant-consumptions", "CHILD.json"), false);
  const output = await invoke(consumer, "agent_delegate", { task_id: "CHILD", dry_run: false });
  assert.deepEqual(output, consumer.result("CHILD"));
  const events = consumer.events.list("CHILD");
  assert.ok(events.some(e => e.event_type === "agent.result.validated" && e.payload.result_hash === hash(output)));
  assert.ok(events.some(e => e.event_type === "agent.completed"));
  assert.equal(events.filter(e => e.event_type === "execution.grant.consumed").length, 1);
  const restarted = new AgentBus(f.storage, f.bus.providers);
  await assert.rejects(invoke(restarted, "agent_delegate", { task_id: "CHILD", dry_run: false }), /EXECUTION_GRANT_CONSUMED/);
  assert.throws(f.issue, /EEXIST/);
  assert.equal(f.calls(), 1);
  assert.equal(restarted.runtime.model_execution_enabled, false);
});

test("global execution stays disabled for unrelated tasks before and after a granted execution", async t => {
  const f = fixture(t);
  await invoke(f.bus, "agent_delegate", { task_id: "CHILD" });
  await assert.rejects(f.bus.delegate("CHILD", false), /MODEL_EXECUTION_DISABLED/);
  f.issue(); await f.bus.delegate("CHILD", false);
  await assert.rejects(f.bus.delegate("ROOT", false), /MODEL_EXECUTION_DISABLED/);
  assert.equal(f.calls(), 1);
  assert.equal(f.bus.runtime.model_execution_enabled, false);
});

const mismatches: Array<[string, (c: TaskCapsule, root: TaskCapsule, route: ResolvedRole) => void]> = [
  ["capsule hash", c => { c.goal += " altered"; }],
  ["role", c => { c.role = "discovery-tests"; }],
  ["provider", (_c, _root, r) => { r.provider = r.provider === "codex" ? "claude" : "codex"; }],
  ["permission escalation", c => { c.permissions = "workspace-write"; }],
  ["root task", c => { c.parent_task_id = "OTHER"; }],
  ["root capsule", (_c, root) => { root.goal += " altered"; }],
  ["model alias", (_c, _root, r) => { r.model_alias = "other-alias"; }],
  ["resolved model", (_c, _root, r) => { r.model = "other-model"; }],
  ["provider command", (_c, _root, r) => { r.provider_command = "other-command"; }],
  ["route permission ceiling", (_c, _root, r) => { r.role.mutation_permission = "workspace-write"; }],
];
for (const [name, mutate] of mismatches) test(`grant denies a changed ${name} without invoking a provider`, t => {
  const f = fixture(t); f.issue();
  const c = structuredClone(f.child), root = structuredClone(f.root), route = structuredClone(f.route);
  mutate(c, root, route);
  assert.throws(() => f.grants.eligible(c, root, route), /EXECUTION_GRANT_BINDING_MISMATCH/);
  assert.equal(f.calls(), 0);
  assert.equal(f.storage.exists("execution-grant-consumptions", "CHILD.json"), false);
});

test("a grant copied to a different task cannot authorize that task", async t => {
  const f = fixture(t), grant = f.issue();
  const other = { ...f.child, task_id: "OTHER" }; f.bus.init(other);
  await assert.rejects(f.bus.delegate("OTHER", false), /MODEL_EXECUTION_DISABLED/);
  f.storage.create(["execution-grants", "OTHER.json"], grant);
  await assert.rejects(f.bus.delegate("OTHER", false), /EXECUTION_GRANT_BINDING_MISMATCH/);
  assert.equal(f.calls(), 0);
});

test("grant issuance is limited to exact smoke or a read-only README child on the root's persisted route", t => {
  const f = fixture(t);
  for (const c of [
    { ...f.child, permissions: "workspace-write" as const },
    { ...f.child, allowed_paths: ["cartera-backend"] },
    { ...f.child, allowed_paths: [".cartera/harness"] },
    { ...f.child, owned_tests: ["npm test"] },
    { ...f.child, parent_task_id: null },
  ]) assert.throws(() => f.grants.issue(c, f.root, f.route, "read-only-harness", "bootstrap", "test"), /EXECUTION_GRANT/);
  assert.throws(() => f.grants.issue(f.child, f.root, { ...f.route, provider: f.route.provider === "codex" ? "claude" : "codex" }, "read-only-harness", "bootstrap", "test"), /EXECUTION_GRANT_ROUTE_MISMATCH/);
  assert.throws(() => f.grants.issue(f.child, f.root, { ...f.route, effort: "max" }, "read-only-harness", "bootstrap", "test"), /EXECUTION_GRANT_ROUTE_MISMATCH/);
  assert.throws(() => f.grants.issue(f.child, f.root, f.route, "fixed-smoke", "bootstrap", "test"), /SMOKE_MISMATCH/);
  assert.throws(() => f.grants.issue(f.child, f.root, f.route, "read-only-harness", "", ""), /ISSUER_REASON_REQUIRED/);
});

test("MCP cannot mint grants or inject authority into delegation arguments or capsules", async t => {
  const f = fixture(t);
  assert.ok(TOOL_DESCRIPTORS.every(tool => !tool.name.includes("grant") && !tool.name.includes("smoke")));
  await assert.rejects(invoke(f.bus, "execution_grant_issue", { task_id: "CHILD" }), /UNKNOWN_TOOL/);
  await assert.rejects(invoke(f.bus, "agent_delegate", { task_id: "CHILD", dry_run: false, execution_grant: {} }), /INVALID_ARGUMENTS/);
  assert.throws(() => f.bus.init({ ...f.child, task_id: "INJECTED", execution_grant: {} }));
  const worker = new AgentBus(f.storage, f.bus.providers, "worker", "mechanical-worker");
  f.issue(); await assert.rejects(worker.delegate("CHILD", false), /WORKERS_DO_NOT_ORCHESTRATE/);
  assert.equal(f.calls(), 0);
});

test("provider failure consumes the grant permanently without persisting success", async t => {
  const f = fixture(t); f.issue();
  f.bus.providers[f.route.provider] = { async execute() { throw new Error("PROVIDER_FAILURE"); } };
  await assert.rejects(f.bus.delegate("CHILD", false), /PROVIDER_FAILURE/);
  assert.equal(f.storage.exists("results", "CHILD.json"), false);
  await assert.rejects(new AgentBus(f.storage).delegate("CHILD", false), /EXECUTION_GRANT_CONSUMED/);
});

test("two consumers that observed an available grant cannot both consume it", t => {
  const f = fixture(t), grant = f.issue(), second = new ExecutionGrants(f.storage);
  assert.ok(second.eligible(f.child, f.root, f.route));
  f.grants.consume(f.child, f.root, f.route, grant);
  assert.throws(() => second.consume(f.child, f.root, f.route, grant), /EXECUTION_GRANT_CONSUMED/);
});

test("a changed execution mode is denied", t => {
  const f = fixture(t), grant = f.issue();
  writeFileSync(f.storage.path("execution-grants", "CHILD.json"), JSON.stringify({ ...grant, execution_mode: "workspace-write" }));
  assert.throws(() => f.grants.eligible(f.child, f.root, f.route), /EXECUTION_GRANT_MODE_INVALID/);
  assert.equal(f.calls(), 0);
});

test("the trusted operator CLI issues a persisted grant without executing the child", t => {
  const f = fixture(t);
  const stdout = execFileSync(process.execPath, [join(HARNESS_ROOT, "dist/cli/main.js"), "execution-grant", "CHILD", "Explicit test bootstrap"],
    { encoding: "utf8", env: { ...process.env, CARTERA_HARNESS_STATE: f.storage.root } });
  const grant = JSON.parse(stdout);
  assert.equal(grant.issuer, "trusted-operator-cli");
  assert.equal(grant.capsule_hash, hash(f.child));
  assert.equal(f.bus.events.list("CHILD").at(-1)?.event_type, "execution.grant.issued");
  assert.equal(f.storage.exists("execution-grant-consumptions", "CHILD.json"), false);
  assert.equal(f.calls(), 0);
});

for (const [name, change, error] of [
  ["identity", (r: AgentResult) => { r.task_id = "WRONG"; }, /IDENTITY_MISMATCH/],
  ["scope", (r: AgentResult) => { r.scope_expanded = true; }, /SCOPE_EXPANSION_PERFORMED/],
  ["write", (r: AgentResult) => { r.changed_files = [".cartera/harness/README.md"]; }, /READ_ONLY_MUTATION/],
  ["evidence scope", (r: AgentResult) => { r.evidence[0].source = "cartera-backend/README.md:1"; }, /EVIDENCE_OUTSIDE_SCOPE/],
  ["evidence line", (r: AgentResult) => { r.evidence[0].source = ".cartera/harness/README.md:999999"; }, /EVIDENCE_LINE_MISSING/],
  ["schema", (r: AgentResult) => { r.status = "invalid" as any; }, /INVALID_AGENT_RESULT/],
] as const) test(`a grant never bypasses result ${name} validation`, async t => {
  const f = fixture(t); f.issue();
  f.bus.providers[f.route.provider] = { async execute() { const r = result(f.child); change(r); return r; } };
  await assert.rejects(f.bus.delegate("CHILD", false), error);
  assert.equal(f.storage.exists("results", "CHILD.json"), false);
  await assert.rejects(f.bus.delegate("CHILD", false), /EXECUTION_GRANT_CONSUMED/);
});
