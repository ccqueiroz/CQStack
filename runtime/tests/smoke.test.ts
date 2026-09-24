import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBus } from "../src/agent-bus/index.js";
import { Storage } from "../src/storage.js";
import { smokeCapsule } from "../src/providers/smoke.js";
import type { AgentProvider, TaskCapsule } from "../src/contracts.js";
import { checkFileEvidence } from "../src/validation/evidence.js";
import { WORKSPACE } from "../src/workflow/artifacts.js";

test("fixed smoke uses delegate validation and persistence while normal execution stays disabled", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cartera-smoke-test-")));
  let calls = 0;
  const provider: AgentProvider = { async execute(r) {
    calls++;
    assert.equal(r.capsule.permissions, "read-only");
    assert.equal(r.capsule.worktree, null);
    assert.deepEqual(r.capsule.allowed_paths, [".cartera/harness/README.md"]);
    return { task_id: r.capsule.task_id, role: r.capsule.role, status: "completed", summary: "Shared runtime",
      changed_files: [], evidence: [{ assertion: "Shared runtime", source: ".cartera/harness/README.md:3", observation: "CLI and MCP" }],
      tests_executed: [], tests_not_executed: [], api_contract_status: "not_applicable", visual_lock_status: "not_applicable",
      scope_expanded: false, deviations: [], risks: [], known_issues: [], requested_followups: [] };
  }};
  try {
    const bus = new AgentBus(new Storage(root), { codex: provider, claude: provider });
    await bus.smoke("codex", "PLAN");
    assert.equal(calls, 0);
    for (const name of ["codex", "claude"]) {
      const task = "SMOKE-" + name;
      await bus.smoke(name, task, true);
      assert.equal(bus.result(task).task_id, task);
      assert.ok(bus.events.list(task).some(e => e.event_type === "agent.completed"));
      assert.equal(bus.events.list(task).at(-1)?.event_type, "provider.smoke.passed");
      await assert.rejects(bus.delegate(task, false), /MODEL_EXECUTION_DISABLED/);
      await assert.rejects(bus.smoke(name, task, true));
    }
    assert.equal(calls, 2);
    assert.equal(bus.runtime.model_execution_enabled, false);
    bus.init(smokeCapsule("codex", "ARBITRARY"));
    await assert.rejects(bus.delegate("ARBITRARY", false), /MODEL_EXECUTION_DISABLED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed smoke does not open execution or persist a passing gate", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cartera-smoke-test-")));
  try {
    const bus = new AgentBus(new Storage(root), { codex: { async execute() { throw new Error("AUTH_FAILED"); } } });
    await assert.rejects(bus.smoke("codex", "FAIL", true), /AUTH_FAILED/);
    assert.equal(bus.events.list("FAIL").at(-1)?.event_type, "agent.failed");
    assert.equal(bus.storage.exists("results", "FAIL.json"), false);
    await assert.rejects(bus.delegate("FAIL", false), /MODEL_EXECUTION_DISABLED/);
    await assert.rejects(bus.smoke("fable", "NO", true), /UNKNOWN_SMOKE_PROVIDER/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A Luna smoke (P2C-SMOKE-CODEX-20260924-01) cited the README without a line and failed the harness check.
test("smoke wire requires a file:line citation that the harness evidence check accepts", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cartera-smoke-test-")));
  try {
    const bus = new AgentBus(new Storage(root));
    for (const provider of ["codex", "claude"]) {
      const capsule = smokeCapsule(provider, "WIRE-" + provider);
      const wire = JSON.parse(readFileSync((bus as unknown as { providerSchema(c: TaskCapsule, provider: string): string }).providerSchema(capsule, provider), "utf8"));
      const pattern = new RegExp(wire.properties.evidence.items.properties.source.pattern);
      for (const accepted of [".cartera/harness/README.md:3", ".cartera/harness/README.md:1-3", ".cartera/harness/README.md:1,3"]) {
        assert.match(accepted, pattern, provider);
        assert.doesNotThrow(() => checkFileEvidence(accepted, capsule, WORKSPACE));
      }
      for (const rejected of [".cartera/harness/README.md", "README.md:3", ".cartera/harness/docs/usage.md:1"]) assert.doesNotMatch(rejected, pattern, provider);
      assert.throws(() => checkFileEvidence(".cartera/harness/README.md", capsule, WORKSPACE), /EVIDENCE_FILE_LINE_REQUIRED/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
