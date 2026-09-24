import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBus } from "../src/agent-bus/index.js";
import { HARNESS_ROOT, Storage, hash } from "../src/storage.js";
import { Router } from "../src/router/index.js";
import { WorkflowService, config } from "../src/workflow/service.js";
import { ExecutionGrants } from "../src/execution/grants.js";
import { ClaudeProvider } from "../src/providers/claude.js";
import { CodexProvider } from "../src/providers/codex.js";
import { smokeCapsule } from "../src/providers/smoke.js";
import { reviewWorkflow } from "../src/workflow/review.js";
import type { AgentExecutionRequest, AgentResult, ResolvedRoute, TaskCapsule } from "../src/contracts.js";
import type { WorkflowOutput, WorkflowRequest } from "../src/workflow/contracts.js";

const source = ".cartera/harness/README.md";
const router = new Router();
const roles = router.roles.map(r => r.role);

// The single role → model class + effort source every profile resolves.
const ROLE_CLASSES: Record<string, [string, string]> = {
  "master-orchestrator": ["orchestration", "high"],
  "task-sense": ["reasoning", "medium"],
  "discovery-backend": ["reasoning", "medium"],
  "discovery-frontend": ["reasoning", "medium"],
  "discovery-design-system": ["reasoning", "medium"],
  "discovery-tests": ["reasoning", "medium"],
  flow: ["reasoning", "medium"],
  truth: ["reasoning", "medium"],
  gap: ["reasoning", "medium"],
  "opsx-propose-reviewer": ["reasoning", "medium"],
  "api-contract-backend-reviewer": ["reasoning", "medium"],
  "api-contract-frontend-reviewer": ["reasoning", "medium"],
  "opsx-apply-reviewer": ["reasoning", "medium"],
  "backend-worker": ["reasoning", "medium"],
  "frontend-worker": ["reasoning", "medium"],
  "opsx-implementation-worker": ["reasoning", "medium"],
  "ux-guardian": ["reasoning", "medium"],
  "visual-worker": ["reasoning", "medium"],
  // The harness executes owned tests; what is left to this role is writing them.
  "test-worker": ["reasoning", "medium"],
  "opsx-proposer": ["deep-reasoning", "high"],
  "api-contract-architect": ["deep-reasoning", "high"],
  "adversarial-reviewer": ["deep-reasoning", "high"],
  "visual-architect": ["deep-reasoning", "high"],
  "mechanical-worker": ["mechanical", "low"],
  "provider-smoke-claude": ["mechanical", "low"],
};
const PROFILE_MODELS: Record<string, Record<string, [string, string, string]>> = {
  claude: {
    orchestration: ["claude", "fable-5.1", "claude-fable-5-1[1m]"],
    reasoning: ["claude", "opus-5.5", "claude-opus-5-5"],
    "deep-reasoning": ["claude", "opus-5.5", "claude-opus-5-5"],
    mechanical: ["claude", "sonnet-5", "claude-sonnet-5"],
  },
  codex: {
    orchestration: ["codex", "astra", "gpt-6-astra"],
    reasoning: ["codex", "sol", "gpt-5.6-sol"],
    "deep-reasoning": ["codex", "sol", "gpt-5.6-sol"],
    mechanical: ["codex", "luna", "gpt-5.6-luna"],
  },
};
const expected = (profile: string, role: string, reason?: string) => {
  const [modelClass, effort] = ROLE_CLASSES[role];
  const [provider, model_alias, model] = PROFILE_MODELS[profile][reason ? "orchestration" : modelClass];
  const route_reason = reason ?? (modelClass === "orchestration" ? "explicit-orchestration" : undefined);
  return { provider, model_class: modelClass, model_alias, model, effort, ...(route_reason ? { route_reason } : {}) };
};

function request(task_id: string, routing_profile?: string): WorkflowRequest {
  return { task_id, user_request: "Document the currently declared shared runtime architecture; do not implement changes.", task_type: "analysis",
    repository_scope: [".cartera/harness"], allowed_paths: [source], forbidden_paths: [], constraints: ["Read only"],
    discovery: [{ name: "discovery-code", role: "discovery-backend", paths: [source] }], ...(routing_profile ? { routing_profile } : {}) };
}
function evidence() { return [{ assertion: "The README declares a shared runtime", source: source + ":1", observation: "README title" }]; }
function output(stage: string): WorkflowOutput {
  const claim = { id: "C1", assertion: "Shared runtime declared", evidence: evidence() };
  const content: Record<string, any> = {
    "task-sense": { intent: "Document runtime", explicit_requirements: ["Document declared runtime"], implicit_requirements: [], out_of_scope: ["Implementation"], ambiguities: [], likely_domains: ["harness"], likely_frontend_impact: false, likely_backend_impact: false, possible_api_impact: false, possible_visual_impact: false },
    discovery: { scope: [source], files_inspected: [source], symbols: [], patterns: [], existing_behavior: [claim], tests_found: [], contracts_found: [], dependencies: [], evidence: evidence(), uncertainties: [], ambiguity_triage: [] },
    flow: { entry_points: [claim], steps: [claim], components: [], data_transformations: [], side_effects: [], external_dependencies: [], error_paths: [], frontend_backend_edges: [], persistence_edges: [], evidence: evidence(), unknowns: [] },
    truth: { confirmed: [claim], rejected: [], contradicted: [], unverified: [], missing_evidence: [], actual_system_truth: ["C1"] },
    gap: { missing_behaviors: [], missing_integrations: [], missing_contracts: [], affected_surfaces: [], confirmed_non_gaps: [{ assertion: "Architecture already declared", truth_claim_ids: ["C1"], evidence: evidence() }], out_of_scope: ["Implementation"], unknowns: [], evidence: evidence() },
  };
  return { stage: stage as WorkflowOutput["stage"], content: content[stage] };
}
function result(c: TaskCapsule): AgentResult {
  const stage = c.constraints.find(x => x.startsWith("WORKFLOW_STAGE:"))?.split(":")[1];
  return { task_id: c.task_id, role: c.role, status: "completed", summary: "Evidence inspected", changed_files: [], evidence: evidence(),
    tests_executed: [], tests_not_executed: [], api_contract_status: "not_applicable", visual_lock_status: "not_applicable", scope_expanded: false, deviations: [], risks: [], known_issues: [], requested_followups: [], ...(stage ? { workflow_output: output(stage) } : {}) };
}
async function fixture(failOnce?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cartera-routing-test-")));
  const calls: AgentExecutionRequest[] = [];
  let failed = false;
  const provider = { async execute(r: AgentExecutionRequest) {
    if (r.capsule.constraints.includes("READ_ONLY_SMOKE")) { r.observe?.({ exit_code: 0, test_double: true }); return result(r.capsule); }
    calls.push(r);
    if (failOnce && r.capsule.role === failOnce && !failed) { failed = true; throw new Error("TRANSIENT_PROVIDER_FAILURE"); }
    return result(r.capsule);
  } };
  const bus = new AgentBus(new Storage(root), { codex: provider, claude: provider });
  bus.runtime.repositories.push(".cartera/harness");
  const [codex, claude] = config().provider_smoke_tasks;
  await bus.smoke("codex", codex, true); await bus.smoke("claude", claude, true);
  return { bus, service: new WorkflowService(bus), calls, clean: () => rmSync(root, { recursive: true, force: true }) };
}
const pick = (route: ResolvedRoute) => ({ provider: route.provider, ...(route.model_class ? { model_class: route.model_class } : {}), model_alias: route.model_alias, model: route.model, effort: route.effort, ...(route.route_reason ? { route_reason: route.route_reason } : {}) });

test("both profiles resolve every role through the single role → class + effort table", () => {
  assert.deepEqual(Object.keys(ROLE_CLASSES).sort(), [...roles].sort());
  assert.deepEqual(Object.keys(router.profiles.roles).sort(), [...roles].sort());
  for (const role of roles) assert.deepEqual(Object.keys(router.profiles.roles[role]).sort(), ["effort", "model_class"], `${role} names a class, never a concrete model`);
  for (const profile of ["claude", "codex"]) {
    assert.deepEqual(Object.keys(router.profiles.profiles[profile]).sort(), ["deep-reasoning", "mechanical", "orchestration", "reasoning"], `${profile} resolves only classes`);
    for (const role of roles) {
      const route = router.resolve(role, profile);
      assert.deepEqual(pick(route), expected(profile, role), `${profile}/${role}`);
      assert.doesNotMatch(route.model_alias + " " + route.model, /haiku/i, role);
      assert.notEqual(route.model_alias, "opus", `${role} never routes a new root to the historical floating opus alias`);
      assert.ok(route.effort !== "xhigh" && route.effort !== "max", role);
      if (role !== "master-orchestrator") assert.notEqual(route.model_alias, PROFILE_MODELS[profile].orchestration[1], `${profile}/${role} never defaults to the frontier model`);
    }
  }
  assert.deepEqual(router.models.opus, { provider: "claude", model: "opus" }, "the historical alias stays registered for old snapshots");
});

function harnessCopy(edit: (profiles: any, models: any) => void): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cartera-model-class-")));
  cpSync(join(HARNESS_ROOT, "roles"), join(root, "roles"), { recursive: true });
  cpSync(join(HARNESS_ROOT, "governance"), join(root, "governance"), { recursive: true });
  mkdirSync(join(root, "config"));
  const read = (file: string) => JSON.parse(readFileSync(join(HARNESS_ROOT, "config", file), "utf8"));
  const profiles = read("routing-profiles.json"), models = read("models.json");
  edit(profiles, models);
  writeFileSync(join(root, "config", "routing-profiles.json"), JSON.stringify(profiles));
  writeFileSync(join(root, "config", "models.json"), JSON.stringify(models));
  writeFileSync(join(root, "config", "providers.json"), readFileSync(join(HARNESS_ROOT, "config", "providers.json")));
  return root;
}

for (const [profile, current, next] of [["codex", "sol", "fake-sol-next"], ["claude", "opus-5.5", "fake-opus-next"]]) {
  test(`swapping ${current} for ${next} re-routes every reasoning and deep-reasoning role of the ${profile} profile without editing any role`, () => {
    const root = harnessCopy((profiles, models) => {
      models[next] = { provider: profile, model: next };
      for (const modelClass of ["reasoning", "deep-reasoning"]) { assert.equal(profiles.profiles[profile][modelClass], current); profiles.profiles[profile][modelClass] = next; }
    });
    try {
      const swapped = new Router(root);
      assert.deepEqual(swapped.profiles.roles, router.profiles.roles, "no role route was edited");
      const moved = roles.filter(role => ["reasoning", "deep-reasoning"].includes(ROLE_CLASSES[role][0]));
      assert.equal(moved.length, 22);
      for (const role of moved) assert.deepEqual(pick(swapped.resolve(role, profile)), { ...expected(profile, role), model_alias: next, model: next }, role);
      for (const role of roles.filter(role => !moved.includes(role))) assert.deepEqual(pick(swapped.resolve(role, profile)), expected(profile, role), role);
      const other = profile === "codex" ? "claude" : "codex";
      for (const role of roles) assert.deepEqual(pick(swapped.resolve(role, other)), expected(other, role), `${other}/${role} did not move`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("routing fails closed: a role without class, an unresolved class, a per-role model or a frontier default never falls back", () => {
  const cases: Array<[(profiles: any) => void, RegExp]> = [
    [profiles => { delete profiles.roles.truth; }, /ROLE_CLASS_MISSING: truth/],
    [profiles => { profiles.roles.truth = { model_class: "reasoning", model_alias: "sol", effort: "medium" }; }, /ROLE_ROUTE_INVALID: truth/],
    [profiles => { profiles.roles.truth = { model_alias: "sol", effort: "medium" }; }, /ROLE_ROUTE_INVALID: truth/],
    [profiles => { profiles.roles.truth = { model_class: "premium", effort: "medium" }; }, /UNKNOWN_MODEL_CLASS: premium/],
    [profiles => { profiles.roles.truth = { model_class: "reasoning", effort: null }; }, /INVALID_EFFORT/],
    [profiles => { profiles.roles.implementer = { model_class: "reasoning", effort: "medium" }; }, /UNKNOWN_ROLE: implementer/],
    [profiles => { profiles.profiles.codex.review = "sol"; }, /UNKNOWN_MODEL_CLASS: review/],
    [profiles => { delete profiles.profiles.codex.mechanical; }, /MODEL_CLASS_UNRESOLVED: codex\/mechanical/],
    [profiles => { delete profiles.profiles.claude["deep-reasoning"]; }, /MODEL_CLASS_UNRESOLVED: claude\/deep-reasoning/],
    [profiles => { profiles.profiles.codex.reasoning = "missing-alias"; }, /UNKNOWN_MODEL_ALIAS/],
    [profiles => { profiles.profiles.codex["deep-reasoning"] = "astra"; }, /FRONTIER_AS_DEFAULT_FORBIDDEN: codex\/deep-reasoning/],
    [profiles => { profiles.profiles.claude.reasoning = "fable-5.1"; }, /FRONTIER_AS_DEFAULT_FORBIDDEN: claude\/reasoning/],
    [profiles => { profiles.profiles.claude.mechanical = "fable"; }, /FRONTIER_AS_DEFAULT_FORBIDDEN: claude\/mechanical/],
  ];
  for (const [edit, error] of cases) {
    const root = harnessCopy(edit);
    try { assert.throws(() => new Router(root), error); } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("a frontier model serves another class only through an explicit escalation recorded with its reason", () => {
  for (const profile of ["claude", "codex"]) {
    const escalations = { "adversarial-reviewer": "extreme-review", "api-contract-architect": "extreme-architecture", "backend-worker": "extreme-debugging", "visual-architect": "extreme-visual-reasoning" };
    const snapshot = router.snapshot("ESCALATED", profile, escalations);
    for (const role of roles) assert.deepEqual(snapshot.routes[role], expected(profile, role, escalations[role as keyof typeof escalations]), `${profile}/${role}`);
    assert.deepEqual(snapshot.routes["adversarial-reviewer"], { ...expected(profile, "adversarial-reviewer"), model_alias: PROFILE_MODELS[profile].orchestration[1], model: PROFILE_MODELS[profile].orchestration[2], route_reason: "extreme-review" });
    const frontier = Object.entries(router.snapshot("PLAIN", profile).routes).filter(([, route]) => route.model_alias === PROFILE_MODELS[profile].orchestration[1]);
    assert.deepEqual(frontier.map(([role, route]) => [role, route.route_reason]), [["master-orchestrator", "explicit-orchestration"]]);
    assert.throws(() => router.snapshot("X", profile, { truth: "changes_required" }), /UNKNOWN_ESCALATION_REASON: changes_required/);
    assert.throws(() => router.snapshot("X", profile, { truth: "explicit-orchestration" }), /UNKNOWN_ESCALATION_REASON/);
    assert.throws(() => router.snapshot("X", profile, { "mechanical-worker": "extreme-debugging" }), /FRONTIER_ESCALATION_CLASS_DENIED: mechanical-worker/);
    assert.throws(() => router.snapshot("X", profile, { "master-orchestrator": "extreme-review" }), /FRONTIER_ESCALATION_CLASS_DENIED: master-orchestrator/);
    assert.throws(() => router.snapshot("X", profile, { implementer: "extreme-review" }), /UNKNOWN_ROLE/);
  }
});

test("an escalation is fixed in the root snapshot, reused on resume and never re-resolved for children", async () => {
  const f = await fixture();
  try {
    await f.service.start({ ...request("RT-ESCALATED", "codex"), routing_escalations: { truth: "extreme-review" } });
    const persisted = f.bus.routing("RT-ESCALATED")!;
    assert.deepEqual(persisted.routes.truth, expected("codex", "truth", "extreme-review"));
    assert.deepEqual(persisted.routes.gap, expected("codex", "gap"));
    await f.service.resume("RT-ESCALATED", true);
    const truthCalls = f.calls.filter(c => c.capsule.role === "truth");
    assert.equal(truthCalls.length, 1);
    assert.deepEqual(pick(truthCalls[0].route), persisted.routes.truth);
    for (const call of f.calls) assert.deepEqual(pick(call.route), persisted.routes[call.capsule.role]);
    assert.deepEqual(f.bus.routing("RT-ESCALATED"), persisted);
    await assert.rejects(f.service.start({ ...request("RT-ESCALATED-BAD"), routing_escalations: { truth: "status-not-completed" } }));
    assert.equal(f.bus.events.list("RT-ESCALATED-BAD").length, 0);
    const child = { ...smokeCapsule("claude", "RT-ESCALATED-CHILD"), parent_task_id: "RT-ESCALATED" };
    assert.throws(() => f.bus.init(child, undefined, { truth: "extreme-review" }), /ROUTING_ESCALATION_ROOT_ONLY/);
  } finally { f.clean(); }
});

test("an escalated adversarial reviewer runs on the frontier model under a capsule that audits the routing snapshot instead of forbidding it", async () => {
  const f = await fixture();
  try {
    await f.service.start({ ...request("RT-REVIEW-ESCALATED", "claude"), routing_escalations: { "adversarial-reviewer": "extreme-review" } });
    await f.service.resume("RT-REVIEW-ESCALATED", true);
    const { capsule, route } = await reviewWorkflow(f.bus, "RT-REVIEW-ESCALATED", "RT-REVIEW-ESCALATED-review") as Awaited<ReturnType<typeof reviewWorkflow>> & { capsule: TaskCapsule; route: ResolvedRoute };
    assert.deepEqual(pick(route), expected("claude", "adversarial-reviewer", "extreme-review"));
    assert.equal(route.model_alias, "fable-5.1");
    assert.equal(route.route_reason, "extreme-review");
    assert.match(capsule.responsibility, /persisted root routing snapshot/);
    assert.match(capsule.responsibility, /explicit root escalation recorded with its route_reason/);
    assert.match(capsule.responsibility, /visual approval, database change, external resource and any other unsupported capability remain blocked/);
    const text = JSON.stringify(capsule);
    assert.doesNotMatch(text, /no Fable/);
    assert.doesNotMatch(text, /Phase 3 workflow was activated/);
    assert.doesNotMatch(text, /PHASE2_ARCHITECTURE_REVIEW/);
    assert.ok(capsule.constraints.includes("HARNESS_ARCHITECTURE_REVIEW"));
    assert.ok(capsule.constraints.includes("READ_ONLY"));
    assert.equal(capsule.permissions, "read-only");
    assert.equal(capsule.worktree, null);
    assert.match(capsule.responsibility, /Never modify anything or delegate/);
    assert.match(capsule.acceptance_criteria.join(" "), /fail-closed operator-inspection boundary: no automatic overwrite, deletion, or claim of universal crash recovery/);
  } finally { f.clean(); }
});

test("the workflow manifest persists the resolved role → provider → model → effort snapshot once", async () => {
  const f = await fixture();
  try {
    await f.service.start(request("RT-MANIFEST"));
    const manifest = f.bus.storage.read<any>("workflows", "RT-MANIFEST", "manifest.json");
    const persisted = f.bus.routing("RT-MANIFEST")!;
    assert.equal(manifest.routing.profile, f.bus.router.profiles.default_profile);
    assert.deepEqual(manifest.routing, persisted);
    assert.deepEqual(Object.keys(manifest.routing.routes).sort(), [...roles].sort());
    for (const role of roles) {
      assert.deepEqual(manifest.routing.routes[role], pick(f.bus.router.resolve(role, manifest.routing.profile)));
      assert.deepEqual(Object.keys(manifest.routing.routes[role]).sort(), ["effort", "model", "model_alias", "model_class", "provider", ...(role === "master-orchestrator" ? ["route_reason"] : [])]);
    }
    const shown = f.service.show("RT-MANIFEST");
    for (const node of shown.nodes) assert.equal(node.provider, manifest.routing.routes[node.role].provider);
    await f.service.resume("RT-MANIFEST", true);
    for (const call of f.calls) assert.deepEqual(pick(call.route), manifest.routing.routes[call.capsule.role]);
    for (const artifact of f.service.artifacts("RT-MANIFEST")) {
      const route = manifest.routing.routes[artifact.role];
      assert.equal(artifact.provider, route.provider); assert.equal(artifact.model, route.model);
    }
  } finally { f.clean(); }
});

test("retry and replay reuse the persisted routes even after the default profile changes", async () => {
  const f = await fixture("truth");
  try {
    await f.service.start(request("RT-REPLAY"));
    const persisted = f.bus.routing("RT-REPLAY")!;
    assert.equal(persisted.profile, "claude");
    f.bus.router.profiles.default_profile = "codex";
    assert.equal(f.bus.router.resolve("truth").provider, "codex");
    await assert.rejects(f.service.resume("RT-REPLAY", true), /WORKFLOW_STAGE_FAILED/);
    const retry = f.service.replaceFailedChild("RT-REPLAY", "RT-REPLAY-truth", "Transient provider failure");
    assert.equal(retry.replacement_child, "RT-REPLAY-truth-retry-1");
    const shown = await f.service.resume("RT-REPLAY", true);
    assert.equal(shown.state, "GAP_DEFINED");
    const truthCalls = f.calls.filter(c => c.capsule.role === "truth");
    assert.deepEqual(truthCalls.map(c => c.capsule.task_id), ["RT-REPLAY-truth", "RT-REPLAY-truth-retry-1"]);
    for (const call of f.calls) assert.deepEqual(pick(call.route), persisted.routes[call.capsule.role]);
    assert.ok(f.calls.every(c => c.route.provider === "claude"));
    assert.deepEqual(f.bus.routing("RT-REPLAY"), persisted);
    assert.deepEqual(f.bus.storage.read<any>("workflows", "RT-REPLAY", "manifest.json").routing, persisted);
    const replayed = f.calls.length;
    await f.service.resume("RT-REPLAY", true);
    assert.equal(f.calls.length, replayed);
  } finally { f.clean(); }
});

test("a root keeps its snapshot after its class is re-pointed while a new root resolves through the new registry", async () => {
  const f = await fixture();
  try {
    await f.service.start(request("RT-CLASS-OLD"));
    const old = f.bus.routing("RT-CLASS-OLD")!;
    assert.equal(old.routes.truth.model_class, "reasoning");
    assert.equal(old.routes.truth.model, "claude-opus-5-5");
    f.bus.router.models["fake-opus-next"] = { provider: "claude", model: "fake-opus-next" };
    f.bus.router.profiles.profiles.claude.reasoning = "fake-opus-next";
    await f.service.start(request("RT-CLASS-NEW"));
    const fresh = f.bus.routing("RT-CLASS-NEW")!;
    assert.deepEqual(fresh.routes.truth, { provider: "claude", model_class: "reasoning", model_alias: "fake-opus-next", model: "fake-opus-next", effort: "medium" });
    assert.deepEqual(fresh.routes.gap.model, "fake-opus-next");
    assert.deepEqual(fresh.routes["opsx-proposer"], old.routes["opsx-proposer"], "deep-reasoning did not move");
    await f.service.resume("RT-CLASS-OLD", true);
    const oldCalls = f.calls.filter(c => c.capsule.task_id.startsWith("RT-CLASS-OLD"));
    assert.ok(oldCalls.length > 0);
    for (const call of oldCalls) { assert.deepEqual(pick(call.route), old.routes[call.capsule.role]); assert.notEqual(call.route.model, "fake-opus-next"); }
    assert.deepEqual(f.bus.routing("RT-CLASS-OLD"), old);
    assert.deepEqual(f.bus.storage.read<any>("workflows", "RT-CLASS-OLD", "manifest.json").routing, old);
  } finally { f.clean(); }
});

test("a snapshot persisted before model classes existed still materializes its concrete route unchanged", async () => {
  const f = await fixture();
  try {
    f.bus.init({ ...smokeCapsule("claude", "RT-LEGACY"), role: "truth" });
    const file = f.bus.storage.path("routing", "RT-LEGACY.json");
    const legacy = JSON.parse(readFileSync(file, "utf8"));
    for (const route of Object.values<any>(legacy.routes)) { delete route.model_class; delete route.route_reason; if (route.provider === "claude") Object.assign(route, route.model === "claude-fable-5-1[1m]" ? { model_alias: "opus", model: "opus" } : { model_alias: "sonnet", model: "sonnet" }); }
    writeFileSync(file, JSON.stringify(legacy));
    const route = f.bus.route("RT-LEGACY", "truth");
    assert.deepEqual(pick(route), { provider: "claude", model_alias: "sonnet", model: "sonnet", effort: "medium" });
    assert.equal(route.model_class, undefined);
    assert.deepEqual(pick(f.bus.route("RT-LEGACY", "master-orchestrator")), { provider: "claude", model_alias: "opus", model: "opus", effort: "high" });
  } finally { f.clean(); }
});

test("a new root task may select another profile while existing roots keep theirs", async () => {
  const f = await fixture();
  try {
    await f.service.start(request("RT-DEFAULT"));
    await f.service.start(request("RT-CODEX", "codex"));
    assert.equal(f.bus.routing("RT-DEFAULT")!.profile, "claude");
    assert.equal(f.bus.routing("RT-CODEX")!.profile, "codex");
    for (const role of roles) assert.deepEqual(f.bus.routing("RT-CODEX")!.routes[role], pick(f.bus.router.resolve(role, "codex")));
    await f.service.resume("RT-CODEX", true);
    for (const call of f.calls) assert.deepEqual(pick(call.route), f.bus.routing("RT-CODEX")!.routes[call.capsule.role]);
    assert.deepEqual(f.calls.map(c => c.route.provider), ["codex", "codex", "codex", "codex", "codex"]);
    assert.deepEqual(f.bus.storage.read<any>("workflows", "RT-CODEX", "manifest.json").routing, f.bus.routing("RT-CODEX"));
    await assert.rejects(f.service.start(request("RT-UNKNOWN", "gemini")), /UNKNOWN_ROUTING_PROFILE/);
    assert.equal(f.bus.events.list("RT-UNKNOWN").length, 0);
    const child = { ...smokeCapsule("claude", "RT-CHILD"), parent_task_id: "RT-DEFAULT" };
    assert.throws(() => f.bus.init(child, "codex"), /ROUTING_PROFILE_ROOT_ONLY/);
    assert.equal(f.bus.events.list("RT-CHILD").length, 0);
  } finally { f.clean(); }
});

test("permission scopes, owned worktrees and grants stay independent of the resolved provider", async () => {
  for (const profile of ["claude", "codex"]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cartera-routing-scope-")));
    try {
      const calls: string[] = [];
      const provider = { async execute(r: AgentExecutionRequest) { calls.push(r.capsule.task_id); return result(r.capsule); } };
      const bus = new AgentBus(new Storage(root), { codex: provider, claude: provider });
      const base = { ...smokeCapsule("claude", "SCOPE-" + profile), role: "discovery-backend", constraints: [] as string[] };
      assert.throws(() => bus.init({ ...base, permissions: "workspace-write" }, profile), /ROLE_PERMISSION_DENIED/);
      bus.init(base, profile);
      assert.equal(bus.routing(base.task_id)!.profile, profile);
      const worker: TaskCapsule = { ...base, task_id: "WRITE-" + profile, role: "backend-worker", permissions: "restricted-path-write" };
      bus.init(worker, profile);
      bus.runtime.model_execution_enabled = true;
      bus.executionPolicy.write_application_execution = true;
      bus.transition(worker.task_id, "TASK_CLASSIFIED", 0);
      bus.transition(worker.task_id, "IMPLEMENTATION_RUNNING", 1);
      await assert.rejects(bus.delegate(worker.task_id, false), /OWNED_WORKTREE_REQUIRED/);
      bus.runtime.model_execution_enabled = false;
      const diagnosticRoot: TaskCapsule = { ...smokeCapsule("claude", "DIAG-" + profile), role: "master-orchestrator", constraints: ["CORE_UNDERSTANDING_ROOT_V1"] };
      const child: TaskCapsule = { ...smokeCapsule("claude", "DIAG-CHILD-" + profile), parent_task_id: diagnosticRoot.task_id, role: "truth" };
      bus.init(diagnosticRoot, profile); bus.init(child);
      const grants = new ExecutionGrants(bus.storage, () => bus.runtime.model_execution_enabled);
      const other = bus.router.resolve("truth", profile === "claude" ? "codex" : "claude");
      assert.throws(() => grants.issue(child, diagnosticRoot, other, "orchestrated-read-only-diagnosis", "trusted-operator-cli", "Other profile"), /EXECUTION_GRANT_ROUTE_MISMATCH/);
      const grant = grants.issue(child, diagnosticRoot, bus.routeFor(child), "orchestrated-read-only-diagnosis", "trusted-operator-cli", "Persisted route");
      assert.deepEqual({ provider: grant.provider, model_alias: grant.model_alias, model: grant.model }, { provider: other.provider === "codex" ? "claude" : "codex", model_alias: bus.routing(diagnosticRoot.task_id)!.routes.truth.model_alias, model: bus.routing(diagnosticRoot.task_id)!.routes.truth.model });
      assert.deepEqual(calls, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("provider adapters consume the resolved effort and stay silent when it is null", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "cartera-routing-effort-")));
  try {
    const schema = join(directory, "schema.json");
    writeFileSync(schema, "{}");
    const capsule = smokeCapsule("claude", "EFFORT");
    const done = result(capsule);
    const seen: string[][] = [];
    const runner = async (input: { args: string[] }) => { seen.push(input.args); return { exit_code: 0, stdout: JSON.stringify({ structured_output: done }), stderr: "", signal: null }; };
    const execution = (effort: ResolvedRoute["effort"], model: string) => ({ capsule, cwd: directory, prompt: "p", result_schema_path: schema, timeout_ms: 1000,
      route: { provider: "test", model_alias: model, model, effort, role: {} as never } });
    await new ClaudeProvider(runner as never).execute(execution("high", "opus"));
    await new ClaudeProvider(runner as never).execute(execution(null, "sonnet"));
    assert.deepEqual(seen[0].slice(seen[0].indexOf("--model"), seen[0].indexOf("--model") + 4), ["--model", "opus", "--effort", "high"]);
    assert.ok(!seen[1].includes("--effort"));
    const codexRunner = async (input: { args: string[] }) => { seen.push(input.args); return { exit_code: 0, stdout: JSON.stringify(done), stderr: "", signal: null }; };
    await new CodexProvider(codexRunner as never).execute(execution("medium", "gpt-5.6-sol"));
    await new CodexProvider(codexRunner as never).execute(execution(null, "gpt-5.6-sol"));
    assert.ok(seen[2].includes('model_reasoning_effort="medium"'));
    assert.ok(seen[3].every(arg => !arg.includes("model_reasoning_effort")));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("role definitions carry no provider or model and the router validates profile completeness", () => {
  for (const role of router.roles) assert.deepEqual(Object.keys(role).filter(k => /provider|model|fallback/.test(k)), []);
  assert.deepEqual(Object.keys(router.profiles.profiles).sort(), ["claude", "codex"]);
  assert.equal(hash(router.snapshot("A", "codex").routes), hash(router.snapshot("B", "codex").routes));
});
