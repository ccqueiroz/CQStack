import type { AgentBus } from "../agent-bus/index.js";
import type { AgentResult, TaskCapsule } from "../contracts.js";
import { hash, id } from "../storage.js";
import { manifest, snapshot } from "./artifacts.js";
import { WorkflowService } from "./service.js";
import { hasEngineering, records, readEngineeringArtifact } from "./engineering/artifacts.js";

const paths = [".cartera/harness/runtime/src", ".cartera/harness/runtime/tests", ".cartera/harness/schemas", ".cartera/harness/config", ".cartera/harness/roles", ".cartera/harness/cli", ".cartera/harness/mcp", "AGENTS.md", "CLAUDE.md", ".cartera/harness/README.md", ".cartera/harness/scripts/verify-phase-2-preservation.py", ".cartera/harness/artifacts/phase-2-completion-workspace-preservation.json"];
export function reviewSubject(bus: AgentBus, root: string) {
  const m = manifest(bus, root);
  const engineering=hasEngineering(bus,root)?records(bus,root).map(e=>readEngineeringArtifact(bus,root,String(e.payload.path))):[];
  const subject = { manifest: m, artifacts: new WorkflowService(bus).artifacts(root), ...(engineering.length?{engineering}:{}), harness_source_hashes: snapshot(paths, []) };
  return { subject, subject_hash: hash(subject) };
}
export async function reviewWorkflow(bus: AgentBus, root: string, task: string, execute = false) {
  if (bus.callerRole !== "master-orchestrator") throw new Error("WORKERS_DO_NOT_ORCHESTRATE_WORKERS");
  if (!["GAP_DEFINED","DONE"].includes(bus.events.get(root).state)) throw new Error("GAP_REQUIRED_FOR_ARCHITECTURE_REVIEW");
  const subject = reviewSubject(bus, root);
  const m = manifest(bus, root);
  const capsule: TaskCapsule = {
    task_id: id(task), parent_task_id: root, role: "adversarial-reviewer",
    responsibility: "Independently and adversarially review the currently supported harness source and persisted workflow proof. Reopen source; do not trust the implementation report or builder. Check actual Claude/Codex execution; every child route must match the persisted root routing snapshot, and any frontier model outside master-orchestrator must come only from an explicit root escalation recorded with its route_reason, schema/identity/scope checks, mixed root, focused Discovery, isolated Truth, verified-only Gap, artifact-backed state, context, resume/failure/concurrency safety, CLI/MCP shared core, preserved applications. If engineering artifacts exist, independently check opsx proposal, PO decisions, proposal revisions, independent proposal review, approved-proposal-only Apply, future-phase blocking, worktree-only fixture writes, scope/deviation quarantine, real test evidence, independent Apply review, zero-gap no-op and DONE gating. Phase 3 is supported only through its official gates: api-contract-system for a frontend/backend contract pair, with contract definition, review and lock before implementation. Verify that visual approval, database change, external resource and any other unsupported capability remain blocked by BLOCKED_BY_FUTURE_PHASE/FUTURE_PHASE_NOT_AUTHORIZED. Report concrete defects with file:line. Never modify anything or delegate. Return review_result bound to supplied subject_hash; no automatic global success.",
    goal: "Review the completed read-only workflow and its implementing runtime. An approved verdict requires no material correctness/safety defects. Distinguish limitations from confirmed defects. Keep output concise, with specific reproducible findings.",
    inputs: [JSON.stringify({ root_task: root, subject_hash: subject.subject_hash })],
    required_context: [".cartera/harness/runtime/src/workflow/service.ts", ".cartera/harness/runtime/src/workflow/artifacts.ts", ".cartera/harness/runtime/src/workflow/adapters.ts", ".cartera/harness/runtime/src/agent-bus/index.ts", ...(hasEngineering(bus,root)?[".cartera/harness/runtime/src/workflow/engineering/service.ts",".cartera/harness/runtime/src/workflow/engineering/artifacts.ts",".cartera/harness/runtime/src/workflow/engineering/adapters.ts",".cartera/harness/runtime/src/workflow/engineering/fixture.ts"]:[])],
    allowed_paths: [...new Set([...paths, ...m.request.allowed_paths, ".cartera/harness/state/provider-observations", ".cartera/harness/state/events", ".cartera/harness/state/results", ".cartera/harness/state/workflows", ".cartera/harness/state/worktrees", ".cartera/harness/state/engineering-verifications", ".cartera/harness/state/ownership", ".cartera/harness/state/quarantine", ".cartera/harness/state/fixtures/registration.json", ".cartera/harness/artifacts/phase-2-workspace-preservation.json", ".cartera/harness/artifacts/phase-2-tests.tap", ".cartera/harness/artifacts/phase-2-completion-tests.tap"])],
    forbidden_paths: m.request.forbidden_paths, existing_patterns: [], api_contract_reference: null, visual_lock_reference: null,
    constraints: ["CORE_UNDERSTANDING_V1", "HARNESS_ARCHITECTURE_REVIEW", "READ_ONLY", "No environment/service access. No test execution. Never read credentials. Use only relevant task IDs in persisted state. No orchestrator transcript is supplied.", "Use only commands that do not create temporary files: cat, rg, sed, nl, or python3 -c / node -e. Do not use here-documents, here-strings, output redirections, or temp files. The user explicitly authorized this read-only review approach after the previous here-document permission failure."],
    acceptance_criteria: ["Independent evidence and explicit verdict", "Resume is required for valid, compatible persisted artifacts. Corrupt/truncated files and stale locks retain the Phase 1 fail-closed operator-inspection boundary: no automatic overwrite, deletion, or claim of universal crash recovery. Challenge unsafe behavior, misleading recovery claims, and defects affecting intact compatible state. Phase 1 mechanisms remain canonical unless a verified defect requires replacement."], owned_tests: [], permissions: "read-only", worktree: null, expected_output: "agent-result",
  };
  if (!execute) return { capsule, subject_hash: subject.subject_hash, route: bus.route(root, capsule.role) };
  bus.init(capsule);
  bus.events.append(root, "workflow.child.created", { child_task: task, capsule_hash: hash(capsule), stage: "architecture-review" });
  const result = await bus.delegateWorkflow(task) as AgentResult;
  if (!result.review_result || result.review_result.subject_hash !== subject.subject_hash || reviewSubject(bus, root).subject_hash !== subject.subject_hash) throw new Error("REVIEW_SUBJECT_CHANGED");
  bus.events.append(root, "workflow.architecture.reviewed", { reviewer_task: task, verdict: result.review_result.verdict, result_hash: hash(result), subject_hash: subject.subject_hash });
  return result;
}
