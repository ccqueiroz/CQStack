import type { AgentResult, Evidence, WorktreeDescriptor } from "../../contracts.js";
export interface Reference { child_task: string; content_hash: string }
export interface Unit {
  id: string; role: string; repository: string; responsibility: string;
  allowed_paths: string[]; forbidden_paths: string[]; acceptance_criteria: string[];
  owned_test_ids: string[]; depends_on: string[]; evidence: Evidence[];
}
export interface OwnedTest { id: string; unit_id: string; command: "node"; args: string[]; purpose: string }
export interface Proposal {
  proposal_id: string; root_task_id: string; version: number; previous_proposal_hash: string | null;
  goal: string; verified_gap_refs: Reference[]; solution_summary: string; no_op: boolean;
  affected_repositories: string[]; affected_slices: string[]; affected_files_or_areas: string[];
  implementation_units: Unit[]; dependencies: string[]; ordering: string[]; parallelizable_units: string[][];
  tests_required: OwnedTest[]; risks: string[]; scope_boundaries: string[]; out_of_scope: string[];
  requires_api_contract: boolean; requires_visual_approval: boolean;
  requires_database_change: boolean; requires_external_resource: boolean;
  open_decisions: string[]; evidence: Evidence[];
}
export interface Artifact<T = any> {
  kind: "proposal" | "proposal-review" | "apply" | "apply-review";
  root_task: string; child_task: string; role: string; provider: string; model_alias: string; model: string;
  created_at: string; source_agent_result: Reference; input_artifact_references: Reference[];
  content: T; content_hash: string;
}
interface ApplyResultBase {
  proposal_id: string; implementation_unit: string; task_id: string; status: AgentResult["status"];
  changed_files: string[];
  evidence: Evidence[]; deviations: string[]; scope_expansion_requested: boolean; known_issues: string[];
  worktree: WorktreeDescriptor; checkpoint: string; verification_hash: string;
}
type WorkerTestClaims = Pick<AgentResult, "tests_executed" | "tests_not_executed">;
// Published before verification truth alignment: its test fields are the worker's claims.
export interface LegacyApplyResult extends ApplyResultBase, WorkerTestClaims { version?: undefined }
export interface ApplyResultV2 extends ApplyResultBase {
  version: 2;
  verification: { passed: boolean; commands: { command: string; exit_code: number | null }[] };
  worker_claims: WorkerTestClaims;
}
export type ApplyResult = LegacyApplyResult | ApplyResultV2;
export interface EngineeringManifest {
  version: 1; root_task: string; understanding_manifest_hash: string;
  gap: Reference; truth: Reference; compatibility_hash: string;
}
