// Development-only checkpoint: opens a fresh root at GAP_DEFINED by replaying
// the validated understanding artifacts of an existing root through the real
// WorkflowService, so Phase 3 work can be exercised without re-running the
// understanding providers. Nothing here is reachable from the CLI or MCP surface.
import { AgentBus } from "../src/agent-bus/index.js";
import type { AgentProvider, AgentResult } from "../src/contracts.js";
import type { ExecutionSandbox } from "../src/execution/sandbox.js";
import { configuredExecutor } from "../src/execution/sandbox.js";
import { Storage, hash } from "../src/storage.js";
import { expectedChildren, manifest } from "../src/workflow/artifacts.js";
import { STAGES } from "../src/workflow/contracts.js";
import type { WorkflowArtifact } from "../src/workflow/contracts.js";
import { WorkflowService } from "../src/workflow/service.js";

export const REPLAY_ACTOR = "gap-checkpoint-replay";
export const REPLAY_EVENT = "workflow.understanding.replayed";
export interface GapCheckpointInput { storage_root: string; source_root: string; target_root: string; executor?: ExecutionSandbox; routing_escalations?: Record<string, string> }
interface ReplaySource { suffix: string; artifact: WorkflowArtifact; result: AgentResult }

function replaySources(bus: AgentBus, sourceRoot: string): ReplaySource[] {
  // Understanding is immutable once the runtime recorded GAP_DEFINED; the source may have advanced since.
  if (!bus.events.list(sourceRoot).some(e => e.event_type === "task.transitioned" && e.payload.to === "GAP_DEFINED")) throw new Error("SOURCE_GAP_REQUIRED: " + sourceRoot);
  const m = manifest(bus, sourceRoot), artifacts = new WorkflowService(bus).artifacts(sourceRoot);
  return STAGES.flatMap(stage => {
    const suffixes = stage === "discovery" ? m.request.discovery.map(n => n.name) : [stage];
    return expectedChildren(m, stage, bus).map((child, index) => {
      const artifact = artifacts.find(a => a.child_task === child);
      if (!artifact) throw new Error("SOURCE_ARTIFACT_MISSING: " + child);
      return { suffix: suffixes[index], artifact, result: bus.result(child) };
    });
  });
}

export async function bootstrapGapCheckpoint(input: GapCheckpointInput) {
  const executor = input.executor ?? configuredExecutor();
  const inspector = new AgentBus(new Storage(input.storage_root), {}, REPLAY_ACTOR, "master-orchestrator", executor);
  const sources = replaySources(inspector, input.source_root);
  const request = { ...manifest(inspector, input.source_root).request, task_id: input.target_root, ...(input.routing_escalations ? { routing_escalations: input.routing_escalations } : {}) };
  const replay: AgentProvider = { async execute(req) {
    const capsule = req.capsule, prefix = input.target_root + "-";
    if (capsule.parent_task_id !== input.target_root || !capsule.task_id.startsWith(prefix)) throw new Error("REPLAY_TARGET_ONLY: " + capsule.task_id);
    const source = sources.find(s => s.suffix === capsule.task_id.slice(prefix.length));
    if (!source || source.artifact.role !== capsule.role) throw new Error("REPLAY_SOURCE_MISSING: " + capsule.task_id);
    req.observe?.({ exit_code: 0, replay: true, provider_invoked: false, replay_source: { root: input.source_root, child_task: source.artifact.child_task, artifact_hash: source.artifact.content_hash, result_hash: hash(source.result) } });
    return { ...source.result, task_id: capsule.task_id };
  } };
  const bus = new AgentBus(new Storage(input.storage_root), { codex: replay, claude: replay }, REPLAY_ACTOR, "master-orchestrator", executor);
  const service = new WorkflowService(bus);
  await service.start(request, true);
  if (bus.events.get(input.target_root).state !== "GAP_DEFINED") throw new Error("CHECKPOINT_INCOMPLETE: " + input.target_root);
  const produced = service.artifacts(input.target_root);
  bus.events.append(input.target_root, REPLAY_EVENT, {
    source_root: input.source_root,
    artifacts: sources.map(s => ({ stage: s.artifact.stage, source_child: s.artifact.child_task, source_hash: s.artifact.content_hash,
      target_child: input.target_root + "-" + s.suffix, target_hash: produced.find(a => a.child_task === input.target_root + "-" + s.suffix)!.content_hash })),
  }, REPLAY_ACTOR);
  return service.show(input.target_root);
}
