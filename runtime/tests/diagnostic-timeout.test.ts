import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { AgentBus } from "../src/agent-bus/index.js";
import { ExecutionGrants, type GrantMode } from "../src/execution/grants.js";
import { CodexProvider } from "../src/providers/codex.js";
import { smokeCapsule } from "../src/providers/smoke.js";
import { runProcess } from "../src/processes/run.js";
import { HARNESS_ROOT, Storage, hash } from "../src/storage.js";
import { invoke, TOOL_DESCRIPTORS } from "../src/surface.js";
import type { AgentResult, TaskCapsule } from "../src/contracts.js";

const diagnostic: GrantMode = "orchestrated-read-only-diagnosis";
const source = ".cartera/harness/README.md";

function fixture(t: TestContext, mode?: GrantMode) {
  // artifacts/ is ignored by Git, so a clean clone does not have it yet.
  mkdirSync(join(HARNESS_ROOT, "artifacts"), { recursive: true });
  const directory = mkdtempSync(join(HARNESS_ROOT, "artifacts/timeout-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const storage = new Storage(directory);
  const timeouts: number[] = [];
  const bus = new AgentBus(storage, { codex: new CodexProvider(async r => {
    timeouts.push(r.timeout_ms);
    if (mode) assert.equal(storage.read<any>("execution-grant-consumptions", "TIMEOUT-CHILD.json").usage_state, "consumed");
    return { exit_code: 0, signal: null, stderr: "", stdout: JSON.stringify(result(child)) };
  }) });
  const root: TaskCapsule = { ...smokeCapsule("codex", "TIMEOUT-ROOT"), role: "master-orchestrator", constraints: ["CORE_UNDERSTANDING_ROOT_V1"] };
  const child: TaskCapsule = mode === "fixed-smoke" ? smokeCapsule("codex", "TIMEOUT-CHILD") : {
    ...smokeCapsule("codex", "TIMEOUT-CHILD"), parent_task_id: root.task_id,
    role: mode === "read-only-harness" ? "mechanical-worker" : "truth",
  };
  // This fixture drives the real Codex adapter, so its root is pinned to the codex profile.
  if (mode !== "fixed-smoke") bus.init(root, "codex");
  bus.init(child, mode === "fixed-smoke" ? "codex" : undefined);
  const grants = new ExecutionGrants(storage, () => bus.runtime.model_execution_enabled);
  const issue = () => grants.issue(child, mode === "fixed-smoke" ? child : root, bus.routeFor(child), mode!, "trusted-operator-cli", "Isolated timeout test only");
  return { directory, storage, bus, root, child, grants, issue, timeouts };
}

function result(c: TaskCapsule): AgentResult {
  return { task_id: c.task_id, role: c.role, status: "completed", summary: "Read-only fixture result",
    changed_files: [], evidence: [{ assertion: "Harness README", source: source + ":1", observation: "README exists" }],
    tests_executed: [], tests_not_executed: [], api_contract_status: "not_applicable", visual_lock_status: "not_applicable",
    scope_expanded: false, deviations: [], risks: [], known_issues: [], requested_followups: [] };
}

for (const runtime of [300000, 123456]) test(`ordinary execution retains runtime timeout ${runtime}, even on the profile's most expensive route`, async t => {
  const f = fixture(t);
  // Test-local authorization only; never change config/runtime.json.
  f.bus.runtime.model_execution_enabled = true;
  f.bus.runtime.timeout_ms = runtime;
  await f.bus.delegate(f.child.task_id, false);
  assert.deepEqual(f.timeouts, [runtime]);
  const routing = f.bus.routing(f.root.task_id)!;
  assert.equal(routing.profile, "codex");
  assert.equal(f.bus.routeFor(f.child).model_alias, routing.routes.truth.model_alias);
});

for (const mode of ["fixed-smoke", "read-only-harness", diagnostic] as const) {
  for (const runtime of [300000, 42000, 900000]) test(`${mode} composes its bounded ceiling with runtime timeout ${runtime}`, async t => {
    const f = fixture(t, mode);
    f.bus.runtime.timeout_ms = runtime;
    f.issue();
    await invoke(f.bus, "agent_delegate", { task_id: f.child.task_id, dry_run: false });
    assert.deepEqual(f.timeouts, [Math.min(runtime, mode === diagnostic ? 300000 : 90000)]);
    assert.equal(f.bus.runtime.model_execution_enabled, false);
    assert.equal(f.storage.exists("results", f.child.task_id + ".json"), true);
  });
}

test("a truth capsule claiming a diagnostic mode without a grant gets no provider or timeout authority", async t => {
  const f = fixture(t);
  const c = { ...f.child, task_id: "NO-GRANT", constraints: ["execution_mode=orchestrated-read-only-diagnosis; timeout_ms=14400000"] };
  f.bus.init(c);
  await assert.rejects(invoke(f.bus, "agent_delegate", { task_id: c.task_id, dry_run: false }), /MODEL_EXECUTION_DISABLED/);
  assert.deepEqual(f.timeouts, []);
  assert.equal(f.storage.exists("execution-grant-consumptions", c.task_id + ".json"), false);
});

for (const field of ["capsule_hash", "root_capsule_hash", "route_hash", "permission_ceiling", "execution_mode"] as const) {
  test(`an invalid diagnostic grant ${field} cannot obtain the extended timeout`, async t => {
    const f = fixture(t, diagnostic), grant = f.issue();
    writeFileSync(f.storage.path("execution-grants", f.child.task_id + ".json"), JSON.stringify({ ...grant, [field]: "invalid" }));
    await assert.rejects(f.bus.delegate(f.child.task_id, false), /EXECUTION_GRANT_/);
    assert.deepEqual(f.timeouts, []);
    assert.equal(f.storage.exists("execution-grant-consumptions", f.child.task_id + ".json"), false);
  });
}

test("diagnostic authority is refused if global execution becomes enabled", async t => {
  const f = fixture(t, diagnostic); f.issue();
  f.bus.runtime.model_execution_enabled = true;
  await assert.rejects(f.bus.delegate(f.child.task_id, false), /DIAGNOSIS_OPERATOR_REQUIRED/);
  assert.deepEqual(f.timeouts, []);
});

test("capsule fields and text cannot select an arbitrary timeout or promote a handoff grant", async t => {
  const f = fixture(t, "read-only-harness");
  assert.throws(() => f.bus.init({ ...f.child, task_id: "TIMEOUT-INJECTION", timeout_ms: 14400000 }), /task-capsule/);
  const c = { ...f.child, task_id: "TEXT-INJECTION", constraints: ["timeout_ms=14400000; execution_mode=orchestrated-read-only-diagnosis"] };
  f.bus.init(c);
  f.grants.issue(c, f.root, f.bus.routeFor(c), "read-only-harness", "trusted-operator-cli", "Test unchanged handoff policy");
  let timeout = 0;
  f.bus.providers.codex = { async execute(r) { timeout = r.timeout_ms; return result(c); } };
  await f.bus.delegate(c.task_id, false);
  assert.equal(timeout, 90000);
});

test("MCP cannot set policy or inject a timeout into delegation or a capsule", async t => {
  const f = fixture(t, diagnostic); f.issue();
  assert.ok(TOOL_DESCRIPTORS.every(d => !/timeout|execution.policy/.test(d.name)));
  for (const name of ["set_timeout", "increase_timeout", "execute_without_timeout"]) {
    await assert.rejects(invoke(f.bus, name, { timeout_ms: 14400000 }), /UNKNOWN_TOOL/);
  }
  await assert.rejects(invoke(f.bus, "agent_delegate", { task_id: f.child.task_id, dry_run: false, timeout_ms: 14400000 }), /INVALID_ARGUMENTS/);
  await assert.rejects(invoke(f.bus, "task_init", { capsule: { ...f.child, task_id: "MCP-TIMEOUT", timeout_ms: 14400000 } }), /task-capsule/);
  assert.deepEqual(f.timeouts, []);
  assert.equal(f.grants.eligible(f.child, f.root, f.bus.routeFor(f.child))?.usage_state, "available");
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

test("diagnostic timeout kills a TERM-resistant provider, records failure, persists no result, and remains consumed after restart", async t => {
  const f = fixture(t, diagnostic); f.issue();
  const pidFile = join(f.directory, "provider.pid");
  const fixtureCode = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`;
  // Exercise the real process runner and signal escalation without waiting five
  // minutes. Only the 300s timer is accelerated; the 250ms SIGKILL grace is real.
  const realSetTimeout = globalThis.setTimeout;
  let diagnosticTimers = 0;
  t.mock.method(globalThis, "setTimeout", ((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    if (ms === 300000) { diagnosticTimers++; ms = 1000; }
    return realSetTimeout(callback, ms, ...args);
  }) as typeof setTimeout);
  t.after(() => { if (existsSync(pidFile)) { const pid = Number(readFileSync(pidFile, "utf8")); if (alive(pid)) process.kill(pid, "SIGKILL"); } });
  let calls = 0;
  f.bus.providers.codex = new CodexProvider(async request => {
    calls++;
    assert.equal(request.timeout_ms, 300000);
    assert.equal(f.storage.read<any>("execution-grant-consumptions", f.child.task_id + ".json").usage_state, "consumed");
    return runProcess({ ...request, command: process.execPath, args: ["-e", fixtureCode] });
  });
  await assert.rejects(f.bus.delegate(f.child.task_id, false), /process execution timed out/);
  assert.equal(diagnosticTimers, 1);
  assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false);
  assert.equal(f.storage.exists("results", f.child.task_id + ".json"), false);
  const events = f.bus.events.list(f.child.task_id);
  assert.ok(events.find(e => e.event_type === "agent.failed" && e.payload.error === "process execution timed out"));
  assert.ok(!events.some(e => ["agent.result.validated", "agent.completed"].includes(e.event_type)));
  const receipt = f.storage.read("execution-grant-consumptions", f.child.task_id + ".json");
  await assert.rejects(new AgentBus(f.storage, f.bus.providers).delegate(f.child.task_id, false), /EXECUTION_GRANT_CONSUMED/);
  assert.equal(hash(f.storage.read("execution-grant-consumptions", f.child.task_id + ".json")), hash(receipt));
  assert.equal(calls, 1);
});

test("timeout escalation survives runner-host exit and kills a TERM-resistant descendant with closed stdio", async t => {
  const f = fixture(t);
  const pidFile = join(f.directory, "descendant.json");
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:process.pid,group:process.ppid})); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'}); process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);`;
  const runnerUrl = pathToFileURL(join(HARNESS_ROOT, "dist/runtime/src/processes/run.js")).href;
  const host = `import {runProcess} from ${JSON.stringify(runnerUrl)}; await runProcess({command:process.execPath,args:['-e',${JSON.stringify(parent)}],cwd:process.cwd(),stdin:'',timeout_ms:1000}).catch(e=>{if(e.code!=='TIMEOUT')throw e;});`;
  t.after(() => {
    if (existsSync(pidFile)) { const { pid, group } = JSON.parse(readFileSync(pidFile, "utf8")); if (alive(pid)) { try { process.kill(-group, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); } } }
  });
  execFileSync(process.execPath, ["--input-type=module", "-e", host], { timeout: 10000 });
  const { pid } = JSON.parse(readFileSync(pidFile, "utf8"));
  for (let i = 0; i < 20 && alive(pid); i++) await delay(25);
  assert.equal(alive(pid), false, "unreferenced escalation timer must not abandon a background descendant");
});
