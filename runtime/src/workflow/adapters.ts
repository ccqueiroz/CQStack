import type { TaskCapsule } from "../contracts.js";
import { hash } from "../storage.js";
import type { WorkflowRequest, WorkflowArtifact, Stage, DiscoveryNode } from "./contracts.js";

const LEGACY_SEMANTICS: Record<Stage, string> = {
  "task-sense": "Adapt .claude/commands/task-sense.md: interpret ONLY the verbatim request, never inspect application code. Preserve explicit versus implicit requirements, scope exclusions and stable DQ IDs. Technical statements in the request are claims to verify. No solution or architecture invention.",
  discovery: "Adapt .claude/commands/discover.md: inspect current local evidence for only this responsibility. Cite exact workspace file:line for each factual claim. Record identifiers, patterns, contracts, tests and uncertainties; triage every supplied DQ as factual/policy, closed/open with evidence. Do not propose solutions or infer staging/production. Missing evidence stays uncertain. No services or tests are executed.",
  flow: "Adapt .claude/commands/flow.md: reconstruct today's execution step by step, with evidence per hop and decision/error path. You may independently reopen scoped code when discovery is insufficient (Phase 2 extension). Only applicable frontend/backend/persistence edges; use empty arrays otherwise. Do not invent an end-to-end flow or solution.",
  truth: "Adapt .claude/commands/truth.md, fixing its cumulative context weakness: you are a fresh independent reviewer. Actively challenge every prior claim and original technical assertion. REOPEN scoped code independently. Prior artifacts are claims, not ground truth. Reject or contradict false findings; unsupported claims belong in unverified. Each confirmed claim needs exact file:line evidence. actual_system_truth contains ONLY IDs from your confirmed array. No private reasoning or orchestrator transcript is supplied or needed. Do not design a solution.",
  gap: "Adapt .claude/commands/gap.md: compare requested behavior with independently verified current behavior. Phase 2 explicitly defers its solution tiers/PO design choice to opsx:propose. Report ONLY verified missing behavior/integration/contracts, affected surfaces, confirmed non-gaps, out of scope and unknowns. Each gap/non-gap must cite truth_claim_ids from actual_system_truth and use their evidence. Never promote unverified/rejected/contradicted findings into gaps. Empty missing arrays are correct when already satisfied. STOP at Gap; never invoke propose/apply or create tech debt work.",
};
// Frozen: roots record adapter_revision 2 and workflow show recomputes their capsules from this text.
export const REV2_SEMANTICS: Record<Stage, string> = { ...LEGACY_SEMANTICS,
  gap: LEGACY_SEMANTICS.gap + " Result status: when you deliver workflow_output with the required verified evidence, return AgentResult.status=\"completed\"; known_issues and unknowns document limits, they never change the status. Return status=\"blocked\" only when the required evidence to produce the Gap is missing. Never return needs_review from the Gap stage: this stage delivers a verified artifact, it is not a subject awaiting review.",
  "task-sense": "Adapt .claude/commands/task-sense.md: interpret ONLY the verbatim request, never inspect application code. Preserve explicit versus implicit requirements, scope exclusions and stable DQ IDs. Technical statements in the request are claims to verify. Mark an ambiguity blocking=true ONLY when it concerns the task, the product or the code and must be answered to define the implementation. Never mark as blocking, and preferably do not raise, operational harness questions: creation or existence of worktrees, provider or model, routing, grants, workflow execution or AgentBus internal state. Those belong to the orchestrator, not to Discovery. No solution or architecture invention.",
  flow: "Adapt .claude/commands/flow.md: synthesize today's execution step by step, with evidence per hop and decision/error path, using ONLY the supplied validated Task Sense and Discovery artifacts. Reconstruct exclusively the functional/technical flow of the analyzed system that those artifacts describe. The goal and constraints may also describe the harness orchestration pipeline (Proposal, API Contract Architect, reviewers, API Contract Lock, workers, review-gate, worktrees, providers, DONE); that pipeline is orchestration metadata, never hops of the analyzed system: never turn its steps into entry_points, steps, components or edges, and never require evidence for them. If the Discovery artifacts describe the system flow, synthesize that flow even when the goal also describes the harness pipeline. Do not reopen, read or search code, do not redo Discovery and do not gather new evidence; reuse the file:line evidence already present in the Discovery artifacts, copying each source exactly. The runtime rejects any evidence.source, in workflow_output or AgentResult.evidence, that is not present byte for byte in the supplied Task Sense and Discovery artifacts; a directory, a listing or a path of a file that does not exist yet is never a source. Absence of a file or behavior is not a Flow finding: name it in unknowns as text without evidence and leave it to Truth and Gap. Only applicable frontend/backend/persistence edges; use empty arrays otherwise. If the supplied artifacts are insufficient to describe the system flow itself, return AgentResult status=blocked, evidence=[], omit workflow_output and name the missing evidence in known_issues; never block because harness execution steps lack evidence. Do not invent an end-to-end flow or solution.",
  discovery: "Adapt .claude/commands/discover.md: inspect current local evidence for only this responsibility. Cite exact workspace file:line for each factual claim. Record identifiers, patterns, contracts, tests and uncertainties; triage every supplied DQ exactly once as factual/policy and closed/open/not_applicable with evidence. Use not_applicable ONLY when the question falls outside this child's explicit responsibility; explain why and cite scoped evidence establishing that boundary. A question relevant to your scope but lacking evidence stays open. Do not propose solutions or infer staging/production. No services or tests are executed.",
};
// Revision 3 states each operational rule once per capsule: read-only, language and the
// generic evidence format live in REV3_OPERATIONAL_CONSTRAINTS and evidencePreflight, never here.
export const REV3_SEMANTICS: Record<Stage, string> = { ...REV2_SEMANTICS,
  discovery: "Adapt .claude/commands/discover.md: inspect current local evidence for only this responsibility. Record identifiers, patterns, contracts, tests and uncertainties; triage every supplied DQ exactly once as factual/policy and closed/open/not_applicable with evidence. Use not_applicable ONLY when the question falls outside this child's explicit responsibility; explain why and cite scoped evidence establishing that boundary. A question relevant to your scope but lacking evidence stays open. Do not propose solutions or infer staging/production.",
  flow: REV2_SEMANTICS.flow.replace("If the supplied artifacts are insufficient to describe the system flow itself, return AgentResult status=blocked, evidence=[], omit workflow_output and name the missing evidence in known_issues;", "If the supplied artifacts are insufficient to describe the system flow itself, or contain no citable source at all, the only valid result is AgentResult status=blocked with evidence=[] and no workflow_output, naming the missing evidence in known_issues;"),
  truth: REV2_SEMANTICS.truth.replace(" Each confirmed claim needs exact file:line evidence.", ""),
};
export const SEMANTICS = REV3_SEMANTICS;
const REV2_OPERATIONAL_CONSTRAINT = "Return workflow_output with the stage and structured content matching the supplied schema. Return only evidence-backed assertions, concise output in Portuguese. You must not write files, run tests/servers, access services, delegate, or read credentials. Source evidence uses exact workspace-relative file:line. Task Sense evidence may cite original-task.";
export const REV3_OPERATIONAL_CONSTRAINTS = {
  output: "Return workflow_output with the stage and structured content matching the supplied schema, containing only evidence-backed assertions.",
  language: "Write concise output in Portuguese.",
  readOnly: "Read-only: never write files, run tests or servers, access services, delegate or read credentials.",
  taskSenseEvidence: "Task Sense evidence cites original-task.",
};
function rev3Constraints(stage: Stage): string[] {
  const rules = REV3_OPERATIONAL_CONSTRAINTS;
  return [rules.output, rules.language, rules.readOnly, ...(stage === "task-sense" ? [rules.taskSenseEvidence] : [])];
}
export type EvidenceStage = "discovery" | "truth" | "gap";
const EVIDENCE_PREFLIGHT_PATH_RULE: Record<EvidenceStage, string> = {
  discovery: "The path before the colon MUST be copied byte for byte from one item of capsule.allowed_paths, for example .cartera/harness/state/fixtures/apply-demo/tests/pagination.test.mjs:5 when that item is in allowed_paths; never relativize it to your working directory, the fixture or the repository, never shorten it to tests/file.mjs, and never normalize or rewrite it.",
  truth: "The path before the colon MUST be an existing workspace-relative file: byte for byte a file item of capsule.allowed_paths, or a file located inside a directory item of capsule.allowed_paths, for example .cartera/harness/state/fixtures/apply-demo/src/pagination.mjs:1 when .cartera/harness/state/fixtures/apply-demo/src is in allowed_paths; never the directory item itself, never a path relativized to your working directory, the fixture or the repository, and never a shortened, normalized or rewritten path.",
  gap: "Every source MUST be copied byte for byte from the evidence of a confirmed Truth claim whose id you cite in truth_claim_ids and that appears in actual_system_truth, for example .cartera/harness/state/fixtures/apply-demo/src/pagination.mjs:1 when that exact source is in that claim's evidence; Gap gathers no new evidence, so never cite a directory item of capsule.allowed_paths such as .cartera/harness/state/fixtures/apply-demo/src, never a path without line, never a line absent from the cited Truth evidence, and never a relativized, shortened, normalized or rewritten path.",
};
const EVIDENCE_PREFLIGHT_STAGE_RULE: Record<EvidenceStage, string> = {
  discovery: "A triage item without file evidence keeps evidence=[] and stays open or policy; never cite the capsule to close it.",
  truth: "To assert that a file, symbol or behavior is absent, cite positive verifiable evidence that supports the conclusion: an existing line of an allowed file whose content shows what exists instead (for example the only import, export, call or test present). A directory listing, a glob, a command, a path without line or the absence of a match is not file evidence. Without such positive evidence the claim belongs in unverified with evidence=[]; never invent a source to keep it. Put a claim in confirmed ONLY when sufficient verifiable file:line evidence supports it; the request, prior artifacts and capsule fields such as capsule.artifacts are claims, not evidence.",
  gap: "To report a missing behavior, integration, contract or file (for example a module that does not exist yet), cite only the confirmed Truth evidence that shows what exists instead, such as the current signature, import or test at an existing line. A directory listing, a glob, a command, a path without line, a capsule field or the absence of a match is not evidence. When no confirmed Truth claim supports the absence, name it in unknowns as text without evidence; never invent a source to keep it as a gap.",
};
const EVIDENCE_PREFLIGHT_OUTPUTS: Record<EvidenceStage, string> = {
  discovery: "nested evidence, ambiguity_triage and tests_found",
  truth: "confirmed, rejected, contradicted and unverified",
  gap: "missing_behaviors, missing_integrations, missing_contracts, confirmed_non_gaps and the top-level evidence array",
};
export function evidencePreflight(stage: EvidenceStage): string {
  return `Evidence preflight for ${stage}: read the scoped files yourself with numbered output (for example, nl -ba). Cite only lines actually read and verified during this execution; the request, prior artifacts, capsule fields and memory are not file evidence. Every evidence.source MUST be exactly one allowed file followed by one existing line or verified range. ${EVIDENCE_PREFLIGHT_PATH_RULE[stage]} Never use a capsule field such as capsule.constraints, a logical name, a label, a directory or several paths in one source. Put each cited file in its own evidence entry. If no allowed_paths item can support the evidence, return status=blocked instead of adapting the path. ${EVIDENCE_PREFLIGHT_STAGE_RULE[stage]} Before returning any path:line, confirm that the line exists and its content supports the observation. For ranges or multiple citations, verify every referenced line, including the end of each range; never guess, extrapolate or pad line numbers. Apply this check to AgentResult.evidence and every citation in workflow_output, including ${EVIDENCE_PREFLIGHT_OUTPUTS[stage]}. If no verifiable evidence is available, return AgentResult status=blocked, evidence=[], omit workflow_output and explain the missing evidence in known_issues; never invent a line to complete the output.`;
}
export function selectedInputs(stage: Stage, artifacts: WorkflowArtifact[]): WorkflowArtifact[] {
  const wanted: Record<Stage, Stage[]> = { "task-sense": [], discovery: ["task-sense"], flow: ["task-sense", "discovery"], truth: ["task-sense", "discovery", "flow"], gap: ["truth"] };
  return artifacts.filter(a => wanted[stage].includes(a.stage));
}
const SEMANTICS_BY_REVISION: Record<1 | 2 | 3, Record<Stage, string>> = { 1: LEGACY_SEMANTICS, 2: REV2_SEMANTICS, 3: REV3_SEMANTICS };
export function childCapsule(request: WorkflowRequest, stage: Stage, artifacts: WorkflowArtifact[], node?: DiscoveryNode, revision: 1 | 2 | 3 = 3): TaskCapsule {
  const inputs = selectedInputs(stage, artifacts);
  const paths = stage === "task-sense" ? [] : node?.paths ?? request.allowed_paths;
  const context = {
    original_task: request.user_request, task_type: request.task_type,
    repository_scope: request.repository_scope, constraints: request.constraints,
    forbidden_scope: request.forbidden_paths,
    artifacts: inputs.map(a => ({ reference: { child_task: a.child_task, content_hash: a.content_hash }, output: a.output })),
  };
  return {
    task_id: `${request.task_id}-${node?.name ?? stage}`,
    parent_task_id: request.task_id, role: node?.role ?? stage,
    responsibility: SEMANTICS_BY_REVISION[revision][stage], goal: request.user_request,
    inputs: [JSON.stringify(context)], required_context: stage === "flow" && revision >= 2 ? [] : paths, allowed_paths: paths,
    forbidden_paths: request.forbidden_paths, existing_patterns: [],
    api_contract_reference: null, visual_lock_reference: null,
    constraints: [...request.constraints, "CORE_UNDERSTANDING_V1", `WORKFLOW_STAGE:${stage}`, `INPUT_HASH:${hash(context)}`,
      ...(stage === "discovery" || stage === "truth" || stage === "gap" ? [evidencePreflight(stage)] : []),
      ...(revision === 3 ? rev3Constraints(stage) : [REV2_OPERATIONAL_CONSTRAINT])],
    acceptance_criteria: ["Structured artifact with scoped evidence; uncertainties explicit; no invented work"],
    owned_tests: [], permissions: "read-only", worktree: null, expected_output: "agent-result",
  };
}
