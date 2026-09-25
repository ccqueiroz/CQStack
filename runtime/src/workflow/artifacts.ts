import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import type { AgentBus } from "../agent-bus/index.js";
import { WORKSPACE_ROOT, hash, scopePath, within, id } from "../storage.js";
import { validate } from "../validation/index.js";
import { checkFileEvidence } from "../validation/evidence.js";
import type { TaskState, TaskCapsule } from "../contracts.js";
import type { WorkflowArtifact, WorkflowManifest, WorkflowOutput, Stage } from "./contracts.js";
import { STAGES } from "./contracts.js";
import { childCapsule, selectedInputs } from "./adapters.js";
import { checkFlowOutput, checkFlowResultEvidence } from "./producers/flow.js";
export const WORKSPACE = WORKSPACE_ROOT;
export const STATES: Record<Stage, TaskState> = { "task-sense": "TASK_SENSE_COMPLETE", discovery: "DISCOVERY_COMPLETE", flow: "FLOW_COMPLETE", truth: "TRUTH_VERIFIED", gap: "GAP_DEFINED" };
export function manifest(bus: AgentBus, root: string): WorkflowManifest {
  const value = bus.storage.read<WorkflowManifest>("workflows", id(root), "manifest.json");
  const created = bus.events.list(root).find(e => e.event_type === "workflow.created");
  if (![1, 2, 3].includes(value.adapter_revision ?? 1)) throw new Error("WORKFLOW_ADAPTER_REVISION_UNSUPPORTED");
  if (!created || created.payload.manifest_hash !== hash(value) || value.request.task_id !== root ||
      hash(bus.events.get(root).capsule) !== hash(value.root_capsule)) throw new Error("WORKFLOW_MANIFEST_MISMATCH");
  if (value.routing && hash(value.routing) !== hash(bus.routing(root))) throw new Error("WORKFLOW_MANIFEST_MISMATCH");
  return value;
}
export function snapshot(paths: string[], forbidden: string[], optional: string[] = []): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(path: string) {
    const name = relative(WORKSPACE, path);
    if (forbidden.some(f => within(scopePath(WORKSPACE, f), path))) return;
    if (name.split("/").some(p => [".git", "node_modules", ".env"].includes(p) || p.startsWith(".env."))) throw new Error("FORBIDDEN_WORKFLOW_SOURCE");
    scopePath(WORKSPACE, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) for (const child of readdirSync(path).sort()) walk(join(path, child));
    else if (stat.isFile()) result[name] = hash(readFileSync(path).toString("base64"));
  }
  paths.forEach(p => {
    const path = scopePath(WORKSPACE, p);
    if (optional.includes(p) && !existsSync(path)) result[relative(WORKSPACE, path)] = "absent";
    else walk(path);
  });
  return result;
}
export function resolveChild(bus: AgentBus, root: string, base: string): string {
  return bus.events.list(root).filter(e => e.event_type === "workflow.child.replaced" && e.payload.original_child === base).at(-1)?.payload.replacement_child as string ?? base;
}
export function expectedChildren(m: WorkflowManifest, stage: Stage, bus?: AgentBus): string[] {
  const children = stage === "discovery" ? m.request.discovery.map(n => `${m.request.task_id}-${n.name}`) : [`${m.request.task_id}-${stage}`];
  return bus ? children.map(c => resolveChild(bus, m.request.task_id, c)) : children;
}
function citationLocations(source: string): string[] {
  return source.split(";").flatMap(citation => {
    const match = /^(.*?):([0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*)$/.exec(citation.trim());
    if (!match) throw new Error("EVIDENCE_FILE_LINE_REQUIRED");
    return match[2].split(",").flatMap(range => {
      const [start, end = start] = range.split("-").map(Number);
      return Array.from({ length: end - start + 1 }, (_, i) => `${match[1]}:${start + i}`);
    });
  });
}
export function checkOutput(output: WorkflowOutput, capsule: TaskCapsule, inputs: WorkflowArtifact[]): void {
  validate(`workflow-${output.stage}`, output);
  if (!capsule.constraints.includes(`WORKFLOW_STAGE:${output.stage}`)) throw new Error("WORKFLOW_STAGE_MISMATCH");
  function evidence(node: any): void {
    if (!node || typeof node !== "object") return;
    if (typeof node.source === "string" && typeof node.assertion === "string") {
      // Discovery may cite its own explicit read scope as operational evidence,
      // never as a confirmed system claim. Multi-line/file citations are checked
      // in full rather than truncated to their first location.
      if (output.stage === "discovery" && output.content.evidence.includes(node) && node.source === "capsule.allowed_paths / capsule.required_context") return;
      checkFileEvidence(node.source, capsule, WORKSPACE);
    }
    for (const value of Object.values(node)) evidence(value);
  }
  if (output.stage === "flow") checkFlowOutput(output, inputs);
  if (output.stage !== "task-sense") evidence(output.content);
  if (output.stage === "truth") {
    const confirmed = output.content.confirmed as Array<{id: string}>;
    const ids = confirmed.map(c => c.id);
    const allIds = ["confirmed", "rejected", "contradicted", "unverified"].flatMap(k => output.content[k].map((c: any) => c.id));
    if (new Set(allIds).size !== allIds.length || !output.content.actual_system_truth.every((c: string) => ids.includes(c))) throw new Error("TRUTH_UNSUPPORTED_CONFIRMATION");
  }
  if (output.stage === "gap") {
    const truth = inputs.find(a => a.stage === "truth")?.output.content;
    if (!truth || inputs.length !== 1) throw new Error("GAP_REQUIRES_VERIFIED_TRUTH");
    for (const key of ["missing_behaviors", "missing_integrations", "missing_contracts", "confirmed_non_gaps"]) {
      for (const gap of output.content[key]) {
        if (!gap.truth_claim_ids.every((c: string) => truth.actual_system_truth.includes(c))) throw new Error("GAP_UNVERIFIED_CLAIM");
        const sources = new Set(truth.confirmed.filter((c: any) => gap.truth_claim_ids.includes(c.id)).flatMap((c: any) => c.evidence.flatMap((e: any) => citationLocations(e.source))));
        if (!gap.evidence.every((e: any) => citationLocations(e.source).every(location => sources.has(location)))) throw new Error("GAP_EVIDENCE_NOT_IN_TRUTH");
      }
    }
  }
}
export function readArtifact(bus: AgentBus, root: string, child: string, seen = new Set<string>()): WorkflowArtifact {
  const a = bus.storage.read<WorkflowArtifact>("workflows", id(root), "artifacts", id(child) + ".json");
  return validateArtifact(bus, root, child, a, seen);
}
export function validateArtifact(bus: AgentBus, root: string, child: string, a: WorkflowArtifact, seen = new Set<string>()): WorkflowArtifact {
  if (seen.has(child)) throw new Error("ARTIFACT_REFERENCE_CYCLE");
  seen.add(child);
  const m = manifest(bus, root);
  if (seen.size === 1 && hash(m.repository_snapshot) !== hash(snapshot(m.request.allowed_paths, m.request.forbidden_paths))) throw new Error("WORKFLOW_SOURCE_CHANGED");
  if (!STAGES.includes(a.stage) || !expectedChildren(m, a.stage, bus).includes(child)) throw new Error("UNEXPECTED_WORKFLOW_CHILD");
  const { content_hash, ...body } = a;
  const result = bus.result(child), c = bus.events.get(child).capsule;
  const route = bus.events.list(child).find(e => e.event_type === "agent.delegated")?.payload;
  if (hash(body) !== content_hash || a.root_task !== root || a.child_task !== child || c.parent_task_id !== root || a.role !== c.role ||
      a.source_agent_result.task_id !== child || a.source_agent_result.content_hash !== hash(result) || hash(a.output) !== hash(result.workflow_output) ||
      a.stage !== a.output.stage || a.provider !== route?.provider || a.model_alias !== route?.model_alias || a.model !== route?.model || result.status !== "completed" ||
      !bus.events.list(child).some(e => e.event_type === "agent.completed" && e.payload.result_hash === hash(result))) throw new Error("WORKFLOW_ARTIFACT_PROVENANCE_INVALID");
  const inputs = a.input_artifact_references.map(ref => {
    const input = readArtifact(bus, root, ref.child_task, new Set(seen));
    if (input.content_hash !== ref.content_hash) throw new Error("INPUT_ARTIFACT_HASH_MISMATCH");
    return input;
  });
  const required = selectedInputs(a.stage, STAGES.flatMap(stage => expectedChildren(m, stage, bus).map(child_task => ({ stage, child_task } as WorkflowArtifact)))).map(a => a.child_task);
  if (hash(required) !== hash(inputs.map(a => a.child_task))) throw new Error("WORKFLOW_INPUT_SET_MISMATCH");
  const node = m.request.discovery.find(n => resolveChild(bus, root, root + "-" + n.name) === child);
  const expected = childCapsule(m.request, a.stage, inputs, node, m.adapter_revision ?? 1);
  expected.task_id = resolveChild(bus, root, expected.task_id);
  if (hash(c) !== hash(expected)) throw new Error("CHILD_CAPSULE_INCOMPATIBLE");
  checkOutput(a.output, c, inputs);
  // Top-level AgentResult.evidence obeys the stage rule as well: Flow only inherited
  // sources, Gap only Truth-confirmed locations, Discovery and Truth allowed file:line.
  if (a.stage === "flow") checkFlowResultEvidence(result.evidence, inputs);
  else if (a.stage === "gap") {
    const truth = inputs[0].output.content as any;
    const confirmed = new Set<string>(truth.confirmed.filter((claim: any) => truth.actual_system_truth.includes(claim.id)).flatMap((claim: any) => claim.evidence.flatMap((e: any) => citationLocations(e.source))));
    for (const e of result.evidence) if (!citationLocations(e.source).every(location => confirmed.has(location))) throw new Error("GAP_EVIDENCE_NOT_IN_TRUTH: " + e.source);
  } else if (a.stage === "discovery" || a.stage === "truth") for (const e of result.evidence) checkFileEvidence(e.source, c, WORKSPACE);
  return a;
}
export function assertWorkflowTransition(bus: AgentBus, root: string, to: TaskState): void {
  const m = manifest(bus, root);
  if (to === "TASK_CLASSIFIED") return;
  if (["BLOCKED", "FAILED"].includes(to)) return;
  const stage = (Object.keys(STATES) as Stage[]).find(s => STATES[s] === to);
  if (!stage) throw new Error("WORKFLOW_STOPS_AT_GAP");
  for (const child of expectedChildren(m, stage, bus)) {
    const a = readArtifact(bus, root, child);
    if (a.stage !== stage || !bus.events.list(root).some(e => e.event_type === "workflow.artifact.created" && e.payload.child_task === child && e.payload.content_hash === a.content_hash)) throw new Error("WORKFLOW_STAGE_ARTIFACT_REQUIRED");
  }
}
