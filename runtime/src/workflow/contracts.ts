import type { Evidence, RoutingSnapshot, TaskCapsule } from "../contracts.js";
export const STAGES = ["task-sense", "discovery", "flow", "truth", "gap"] as const;
export type Stage = typeof STAGES[number];
export interface Claim { id: string; assertion: string; evidence: Evidence[] }
export interface WorkflowOutput { stage: Stage; content: Record<string, any> }
export interface DiscoveryNode { name: string; role: string; paths: string[] }
export interface WorkflowRequest {
  task_id: string;
  user_request: string;
  task_type: string | null;
  repository_scope: string[];
  allowed_paths: string[];
  forbidden_paths: string[];
  constraints: string[];
  discovery: DiscoveryNode[];
  routing_profile?: string;
  routing_escalations?: Record<string, string>;
}
export interface WorkflowManifest {
  version: "core-understanding-v1";
  adapter_revision?: 1 | 2 | 3;
  request: WorkflowRequest;
  root_capsule: TaskCapsule;
  compatibility_hash: string;
  repository_snapshot: Record<string, string>;
  routing?: RoutingSnapshot;
}
export interface WorkflowArtifact {
  root_task: string;
  child_task: string;
  stage: Stage;
  role: string;
  provider: string;
  model_alias: string;
  model: string;
  created_at: string;
  source_agent_result: { task_id: string; content_hash: string };
  input_artifact_references: { child_task: string; content_hash: string }[];
  output: WorkflowOutput;
  content_hash: string;
}
