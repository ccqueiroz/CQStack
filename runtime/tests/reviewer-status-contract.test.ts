import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBus } from "../src/agent-bus/index.js";
import type { AgentExecutionRequest, AgentResult } from "../src/contracts.js";
import { Storage, hash } from "../src/storage.js";
import { WorkflowService, config } from "../src/workflow/service.js";
import { reviewWorkflow } from "../src/workflow/review.js";
import type { WorkflowOutput } from "../src/workflow/contracts.js";

const rootTask = "REVIEWER-STATUS";
const source = ".cartera/harness/README.md";
const evidence = [{ assertion: "The README declares a shared runtime", source: source + ":1", observation: "The harness README was inspected" }];
const reviewerRoles = ["opsx-propose-reviewer", "opsx-apply-reviewer", "adversarial-reviewer"] as const;
type ReviewerRole = typeof reviewerRoles[number];

function result(request: AgentExecutionRequest): AgentResult {
  return {
    task_id: request.capsule.task_id, role: request.capsule.role, status: "completed",
    summary: "Assigned inspection completed", changed_files: [], evidence,
    tests_executed: [], tests_not_executed: [], api_contract_status: "not_applicable",
    visual_lock_status: "not_applicable", scope_expanded: false, deviations: [],
    risks: [], known_issues: [], requested_followups: [],
  };
}

function output(stage: string): WorkflowOutput {
  const claim = { id: "C1", assertion: "Shared runtime declared", evidence };
  const content: Record<string, WorkflowOutput["content"]> = {
    "task-sense": { intent: "Document the shared runtime", explicit_requirements: ["Verify existing documentation"], implicit_requirements: [], out_of_scope: ["Implementation"], ambiguities: [], likely_domains: ["harness"], likely_frontend_impact: false, likely_backend_impact: false, possible_api_impact: false, possible_visual_impact: false },
    discovery: { scope: [source], files_inspected: [source], symbols: [], patterns: [], existing_behavior: [claim], tests_found: [], contracts_found: [], dependencies: [], evidence, uncertainties: [], ambiguity_triage: [] },
    flow: { entry_points: [claim], steps: [claim], components: [], data_transformations: [], side_effects: [], external_dependencies: [], error_paths: [], frontend_backend_edges: [], persistence_edges: [], evidence, unknowns: [] },
    truth: { confirmed: [claim], rejected: [], contradicted: [], unverified: [], missing_evidence: [], actual_system_truth: ["C1"] },
    gap: { missing_behaviors: [], missing_integrations: [], missing_contracts: [], affected_surfaces: [], confirmed_non_gaps: [{ assertion: "The runtime is already documented", truth_claim_ids: ["C1"], evidence }], out_of_scope: ["Implementation"], unknowns: [], evidence },
  };
  return { stage: stage as WorkflowOutput["stage"], content: content[stage] };
}

function fixture(targetRole: string, status: AgentResult["status"]) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "cartera-reviewer-status-")));
  const calls: AgentExecutionRequest[] = [];
  const provider = { async execute(request: AgentExecutionRequest) {
    const value = result(request), c = request.capsule;
    if (c.constraints.includes("READ_ONLY_SMOKE")) {
      request.observe?.({ exit_code: 0, test_double: true });
      return value;
    }
    calls.push(request);
    const stage = c.constraints.find(item => item.startsWith("WORKFLOW_STAGE:"))?.split(":")[1];
    if (stage) value.workflow_output = output(stage);
    else if (c.role === "opsx-proposer") {
      const pkg = JSON.parse(c.inputs[0]);
      const gap = pkg.artifacts.find((artifact: any) => artifact.output.stage === "gap");
      value.proposal = {
        ...pkg.proposal_identity, goal: c.goal, verified_gap_refs: [gap.reference],
        solution_summary: "Existing documentation satisfies the request", no_op: true,
        affected_repositories: [], affected_slices: [], affected_files_or_areas: [],
        implementation_units: [], dependencies: [], ordering: [], parallelizable_units: [],
        tests_required: [], risks: [], scope_boundaries: ["Documentation inspection only"],
        out_of_scope: ["Implementation"], requires_api_contract: false,
        requires_visual_approval: false, requires_database_change: false,
        requires_external_resource: false, open_decisions: [], evidence,
      };
    } else if (c.role.endsWith("-reviewer")) {
      value.review_result = {
        task_id: rootTask, reviewer: c.task_id, role: c.role,
        subject_hash: JSON.parse(c.inputs[0]).subject_hash, verdict: "approved",
        evidence, findings: [], details: [], future_gates: [],
      };
    }
    if (c.role === targetRole) value.status = status;
    return value;
  } };
  const bus = new AgentBus(new Storage(directory), { codex: provider, claude: provider });
  bus.runtime.repositories.push(".cartera/harness");
  const service = new WorkflowService(bus);
  return {
    bus, calls,
    async review(role: ReviewerRole) {
      const smokeTasks = config().provider_smoke_tasks;
      await bus.smoke("codex", smokeTasks[0], true);
      await bus.smoke("claude", smokeTasks[1], true);
      await service.start({
        task_id: rootTask, user_request: "Verify the existing shared runtime documentation without implementation.",
        task_type: "analysis", repository_scope: [".cartera/harness"], allowed_paths: [source],
        forbidden_paths: [], constraints: ["Read only"],
        discovery: [{ name: "discovery-code", role: "discovery-backend", paths: [source] }],
      }, true);
      if (role === "adversarial-reviewer") return reviewWorkflow(bus, rootTask, "ARCHITECTURE-REVIEW", true);
      await service.propose(rootTask, true, "Keep the verified empty Gap as a no-op proposal");
      await service.proposalReview(rootTask, true);
      if (role === "opsx-apply-reviewer") {
        await service.apply(rootTask, true);
        await service.applyReview(rootTask, true);
      }
    },
    clean: () => rmSync(directory, { recursive: true, force: true }),
  };
}

for (const role of reviewerRoles) {
  test(`${role} accepts and persists completed with review_result`, async () => {
    const f = fixture(role, "completed");
    try {
      await f.review(role);
      const request = f.calls.find(call => call.capsule.role === role)!;
      assert.ok(request);
      const task = request.capsule.task_id, saved = f.bus.result(task);
      assert.equal(saved.status, "completed");
      assert.equal(saved.review_result?.role, role);
      assert.equal(saved.review_result?.verdict, "approved");
      assert.ok(f.bus.events.list(task).some(event => event.event_type === "agent.result.validated" && event.payload.result_hash === hash(saved)));
      assert.ok(f.bus.events.list(task).some(event => event.event_type === "agent.completed"));
      assert.deepEqual(JSON.parse(readFileSync(request.result_schema_path, "utf8")).properties.status.enum, ["completed"], `${role} wire schema pins completed`);
      assert.doesNotMatch(request.capsule.responsibility, /AgentResult\.status="completed"|needs_review is for subjects/, "the status rule is a pin, never prose");
    } finally { f.clean(); }
  });

  test(`${role} rejects needs_review with review_result before validation and persistence`, async () => {
    const f = fixture(role, "needs_review");
    try {
      await assert.rejects(f.review(role), /REVIEWER_STATUS_MUST_BE_COMPLETED/);
      const request = f.calls.find(call => call.capsule.role === role)!;
      assert.ok(request);
      const task = request.capsule.task_id;
      assert.equal(f.bus.storage.exists("results", task + ".json"), false);
      const events = f.bus.events.list(task);
      assert.ok(events.some(event => event.event_type === "agent.started"));
      assert.ok(events.some(event => event.event_type === "agent.failed"));
      assert.ok(!events.some(event => ["agent.result.validated", "agent.completed"].includes(event.event_type)));
    } finally { f.clean(); }
  });
}

test("engineering reviewers are pinned to completed and the proposer to its honest stops while understanding roles keep needs_review", async () => {
  const f = fixture("opsx-apply-reviewer", "completed");
  try {
    await f.review("opsx-apply-reviewer");
    const status = (role: string) => JSON.parse(readFileSync(f.calls.find(call => call.capsule.role === role)!.result_schema_path, "utf8")).properties.status.enum as string[];
    for (const role of ["opsx-propose-reviewer", "opsx-apply-reviewer"]) assert.deepEqual(status(role), ["completed"], role);
    assert.deepEqual(status("opsx-proposer"), ["completed", "blocked", "failed"]);
    for (const role of ["task-sense", "discovery-backend", "flow", "truth", "gap"]) assert.ok(status(role).includes("needs_review"), `${role} keeps needs_review`);
  } finally { f.clean(); }
});

test("a subject awaiting review retains needs_review and is persisted", async () => {
  const f = fixture("discovery-backend", "needs_review");
  try {
    f.bus.runtime.model_execution_enabled = true;
    f.bus.init({
      task_id: "SUBJECT", parent_task_id: null, role: "discovery-backend",
      responsibility: "Inspect the runtime documentation", goal: "Return evidence for independent review",
      inputs: [], required_context: [source], allowed_paths: [source], forbidden_paths: [],
      existing_patterns: [], api_contract_reference: null, visual_lock_reference: null,
      constraints: [], acceptance_criteria: ["Report inspected evidence"], owned_tests: [],
      permissions: "read-only", worktree: null, expected_output: "agent-result",
    });
    const value = await f.bus.delegate("SUBJECT", false) as AgentResult;
    assert.equal(value.status, "needs_review");
    assert.equal(value.review_result, undefined);
    assert.deepEqual(f.bus.result("SUBJECT"), value);
    assert.ok(f.bus.events.list("SUBJECT").some(event => event.event_type === "agent.result.validated"));
  } finally { f.clean(); }
});
