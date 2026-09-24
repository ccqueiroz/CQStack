// Phase 1 internal contract. Coordinate changes through the master orchestrator.
export type Permission =
  | "read-only"
  | "workspace-write"
  | "restricted-path-write";
export interface ArtifactReference {
  id: string;
  version: string;
  content_hash: string;
}
export interface WorktreeDescriptor {
  id: string;
  task_id: string;
  role: string;
  repository: string;
  path: string;
  base_ref: string;
  base_commit: string;
  contract_version: string | null;
  created_at: string;
}
export interface TaskCapsule {
  task_id: string;
  parent_task_id: string | null;
  role: string;
  responsibility: string;
  goal: string;
  inputs: string[];
  required_context: string[];
  allowed_paths: string[];
  forbidden_paths: string[];
  existing_patterns: string[];
  api_contract_reference: ArtifactReference | null;
  visual_lock_reference: ArtifactReference | null;
  constraints: string[];
  acceptance_criteria: string[];
  owned_tests: string[];
  permissions: Permission;
  worktree: WorktreeDescriptor | null;
  expected_output: "agent-result";
}
export interface Evidence {
  assertion: string;
  source: string;
  observation: string;
}
export interface AgentResult {
  api_contract?: ApiContract | null;
  proposal?: import("./workflow/engineering/contracts.js").Proposal | null;
  proposal_deviation?: { reason: string; affected_unit: string; expected_behavior: string; required_change: string } | null;
  workflow_output?: import("./workflow/contracts.js").WorkflowOutput | null;
  task_id: string;
  role: string;
  status:
    | "completed"
    | "blocked"
    | "failed"
    | "needs_review"
    | "needs_contract_change"
    | "needs_scope_expansion"
    | "proposal_deviation";
  summary: string;
  changed_files: string[];
  evidence: Evidence[];
  tests_executed: { command: string; exit_code: number; evidence: string }[];
  tests_not_executed: { command: string; reason: string }[];
  api_contract_status: "not_applicable" | "unchanged" | "change_requested";
  visual_lock_status: "not_applicable" | "unchanged" | "approval_required";
  scope_expanded: boolean;
  deviations: string[];
  risks: string[];
  known_issues: string[];
  requested_followups: {
    reason: string;
    required_paths: string[];
    required_behavior: string;
    impact: string;
  }[];
  review_result?: ReviewResult;
}
export interface MaintenanceEdit {
  relative_path: string;
  expected_before_hash: string | null;
  content: string;
}
export interface MaintenancePatchResult {
  kind: "maintenance-patch";
  edits: MaintenanceEdit[];
  agent_result: AgentResult;
}
export interface RoleDefinition {
  role: string;
  purpose: string;
  allowed_capabilities: string[];
  mutation_permission: Permission;
  required_artifacts: string[];
  expected_output_schema: "agent-result";
  governance: string[];
}
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];
export const MODEL_CLASSES = ["orchestration", "reasoning", "deep-reasoning", "mechanical"] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];
// A frontier model (the profile's orchestration model) serves another class only
// through one of these explicit, root-level escalations; never by default or on failure.
export const FRONTIER_ESCALATION_REASONS = ["extreme-review", "extreme-architecture", "extreme-debugging", "extreme-visual-reasoning"] as const;
export type FrontierEscalationReason = (typeof FRONTIER_ESCALATION_REASONS)[number];
export type RouteReason = FrontierEscalationReason | "explicit-orchestration";
export interface ResolvedRoute {
  provider: string;
  // Absent in snapshots persisted before model classes existed.
  model_class?: ModelClass;
  model_alias: string;
  model: string;
  effort: Effort | null;
  // Present only on frontier routes.
  route_reason?: RouteReason;
}
export interface RoutingSnapshot {
  version: 1;
  root_task_id: string;
  profile: string;
  resolved_at: string;
  routes: Record<string, ResolvedRoute>;
}
export interface ResolvedRole extends ResolvedRoute {
  provider_command?: string;
  role: RoleDefinition;
}
export interface AgentExecutionRequest {
  observe?: (observation: Record<string, unknown>) => void;
  capsule: TaskCapsule;
  route: ResolvedRole;
  cwd: string;
  prompt: string;
  result_schema_path: string;
  timeout_ms: number;
  signal?: AbortSignal;
}
export interface AgentProvider {
  execute(request: AgentExecutionRequest): Promise<AgentResult | MaintenancePatchResult>;
}
export interface ProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  timeout_ms: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}
export interface ProcessResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  signal: string | null;
}
export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;
export const TASK_STATES = [
  "TASK_RECEIVED",
  "TASK_CLASSIFIED",
  "TASK_SENSE_COMPLETE",
  "DISCOVERY_COMPLETE",
  "FLOW_COMPLETE",
  "TRUTH_VERIFIED",
  "GAP_DEFINED",
  "PROPOSAL_CREATED",
  "PROPOSAL_APPROVED",
  "API_CONTRACT_REQUIRED",
  "API_CONTRACT_DEFINED",
  "API_CONTRACT_REVIEWED",
  "API_CONTRACT_LOCKED",
  "VISUAL_REVIEW_REQUIRED",
  "WAITING_FOR_VISUAL_APPROVAL",
  "VISUAL_LOCKED",
  "IMPLEMENTATION_RUNNING",
  "LOCAL_VERIFICATION",
  "INTEGRATION",
  "FEATURE_E2E",
  "UX_REVIEW",
  "ADVERSARIAL_REVIEW",
  "REVIEW_GATE_APPLY",
  "DONE",
  "BLOCKED",
  "FAILED",
] as const;
export type TaskState = (typeof TASK_STATES)[number];
export interface TaskRecord {
  capsule: TaskCapsule;
  state: TaskState;
  revision: number;
  updated_at: string;
}
export interface TaskEvent {
  event_id: string;
  task_id: string;
  timestamp: string;
  actor: string;
  role: string;
  event_type: string;
  payload: Record<string, unknown>;
}
export interface LockDescriptor {
  contract_id: string;
  task_id: string;
  version: string;
  status: "locked";
  content_hash: string;
  approved_timestamp: string;
  backend_reviewer: string;
  frontend_reviewer: string;
  source_artifact: string;
}
export interface ApiContract {
  contract_id: string;
  task_id: string;
  version: string;
  method: string;
  path: string;
  path_parameters: Record<string, unknown>;
  query_parameters: Record<string, unknown>;
  headers: Record<string, unknown>;
  request_body: Record<string, unknown> | null;
  success_status: number;
  success_schema: Record<string, unknown> | null;
  errors: { status: number; code: string; schema: Record<string, unknown> }[];
  nullable_semantics: string;
  optional_semantics: string;
  dates: string;
  money: string;
  enums: Record<string, string[]>;
  pagination: Record<string, unknown> | null;
}
export interface ContractChange {
  request_id: string;
  task_id: string;
  reason: string;
  current_contract: ArtifactReference;
  proposed_change: Record<string, unknown>;
  frontend_impact: string;
  backend_impact: string;
}
export interface ReviewResult {
  task_id: string;
  reviewer: string;
  role: string;
  subject_hash: string;
  verdict: "approved" | "rejected" | "changes_required" | "blocked_by_future_phase" | "blocked";
  evidence: Evidence[];
  findings: string[];
  details?: { finding: string; severity: "blocking" | "warning" | "info"; section: string; evidence: Evidence[]; required_change: string }[];
  future_gates?: string[];
}
