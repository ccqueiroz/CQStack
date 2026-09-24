import type { AgentResult, Evidence } from "../../contracts.js";
import { assertClosedEvidence, closedEvidenceAllowlist } from "../../validation/evidence.js";
import type { WorkflowArtifact, WorkflowOutput } from "../contracts.js";

const FLOW_EVIDENCE_NOT_IN_INPUTS = "FLOW_EVIDENCE_NOT_IN_INPUTS";
// Only Discovery may cite its own read scope (workflow/artifacts.ts); Flow never inherits it.
const DISCOVERY_ONLY_SOURCE = "capsule.allowed_paths / capsule.required_context";
// Shared by the runtime check and the wire pin so both offer the same sources.
export function flowEvidenceAllowlistOf(taskSenseAndDiscovery: unknown[]): Set<string> {
  const allowlist = closedEvidenceAllowlist(taskSenseAndDiscovery);
  allowlist.delete(DISCOVERY_ONLY_SOURCE);
  return allowlist;
}
export function flowEvidenceAllowlist(inputs: WorkflowArtifact[]): Set<string> {
  return flowEvidenceAllowlistOf(inputs.filter(a => a.stage === "task-sense" || a.stage === "discovery").map(a => a.output.content));
}
export function checkFlowOutput(output: WorkflowOutput, inputs: WorkflowArtifact[]): void {
  if (output.stage !== "flow") throw new Error("WORKFLOW_STAGE_MISMATCH");
  assertClosedEvidence(output.content, flowEvidenceAllowlist(inputs), FLOW_EVIDENCE_NOT_IN_INPUTS);
}
export function checkFlowResultEvidence(evidence: Evidence[], inputs: WorkflowArtifact[]): void {
  assertClosedEvidence(evidence, flowEvidenceAllowlist(inputs), FLOW_EVIDENCE_NOT_IN_INPUTS);
}
export function isFlowCapsule(constraints: string[]): boolean {
  return constraints.includes("WORKFLOW_STAGE:flow");
}
export type FlowResult = Pick<AgentResult, "evidence">;
