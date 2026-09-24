import { readFileSync, readdirSync, openSync, closeSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Ajv } from "ajv";
import type { AgentBus } from "../agent-bus/index.js";
import type { TaskCapsule, AgentResult } from "../contracts.js";
import { FRONTIER_ESCALATION_REASONS } from "../contracts.js";
import { escalationsOf } from "../router/index.js";
import { HARNESS_ROOT, hash, id, scopePath, within } from "../storage.js";
import { childCapsule, selectedInputs, SEMANTICS } from "./adapters.js";
import { STAGES, type Stage, type WorkflowArtifact, type WorkflowManifest, type WorkflowRequest, type WorkflowOutput } from "./contracts.js";
import { WORKSPACE, STATES, manifest, snapshot, expectedChildren, readArtifact, validateArtifact, checkOutput, resolveChild } from "./artifacts.js";
import { EngineeringStages } from "./engineering/service.js";
import { hasEngineering } from "./engineering/artifacts.js";

const strings = { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true };
export const REQUEST_SCHEMA = { type: "object", additionalProperties: false,
  required: ["task_id", "user_request", "task_type", "repository_scope", "allowed_paths", "forbidden_paths", "constraints", "discovery"],
  properties: { task_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$" }, user_request: { type: "string", minLength: 1, maxLength: 12000 }, task_type: { type: ["string", "null"] },
    repository_scope: { ...strings, minItems: 1 }, allowed_paths: { ...strings, minItems: 1 }, forbidden_paths: strings, constraints: strings, routing_profile: { type: "string", minLength: 1 },
    routing_escalations: { type: "object", minProperties: 1, propertyNames: { minLength: 1 }, additionalProperties: { enum: [...FRONTIER_ESCALATION_REASONS] } },
    discovery: { type: "array", minItems: 1, maxItems: 6, items: { type: "object", additionalProperties: false, required: ["name", "role", "paths"], properties: {
      name: { type: "string", pattern: "^discovery-[a-z0-9-]{1,25}$" }, role: { enum: ["discovery-backend", "discovery-frontend", "discovery-design-system", "discovery-tests"] }, paths: { ...strings, minItems: 1 },
    } } },
  },
};
const validRequest = new Ajv({ allErrors: true }).compile(REQUEST_SCHEMA);
export function config(): { concurrency: number; timeout_ms: number; max_context_bytes: number; provider_smoke_tasks: string[] } {
  const c = JSON.parse(readFileSync(join(HARNESS_ROOT, "config/workflow.json"), "utf8"));
  if (!Number.isInteger(c.concurrency) || c.concurrency < 1 || c.concurrency > 4 || !Number.isInteger(c.timeout_ms) || c.timeout_ms < 1000 || c.timeout_ms > 300000 || !Number.isInteger(c.max_context_bytes) || c.max_context_bytes < 1000 || c.max_context_bytes > 100000 || !Array.isArray(c.provider_smoke_tasks)) throw new Error("INVALID_WORKFLOW_CONFIG");
  return c;
}
export function assertLiveGate(bus: AgentBus): void {
  const providers = new Set<string>();
  for (const task of config().provider_smoke_tasks) {
    const result = bus.result(task), events = bus.events.list(task);
    const passed = events.find(e => e.event_type === "provider.smoke.passed" && e.payload.result_hash === hash(result));
    const observed = events.find(e => e.event_type === "provider.observed");
    if (!passed || !observed || result.status !== "completed" || result.changed_files.length || result.scope_expanded) throw new Error("LIVE_PROVIDER_GATE_REQUIRED");
    const observation = bus.storage.read<any>("provider-observations", String(observed.payload.artifact));
    if (hash(observation) !== observed.payload.content_hash || observation.exit_code !== 0 || /fable/i.test(observation.model) || observation.task_id !== task) throw new Error("LIVE_PROVIDER_GATE_REQUIRED");
    providers.add(observation.provider);
  }
  if (!providers.has("claude") || !providers.has("codex")) throw new Error("LIVE_PROVIDER_GATE_REQUIRED");
}
export function compatibilityHash(bus: AgentBus): string {
  const schemas = Object.fromEntries(readdirSync(join(HARNESS_ROOT, "schemas")).filter(f => f.endsWith(".schema.json")).sort().map(f => [f, readFileSync(join(HARNESS_ROOT, "schemas", f), "utf8")]));
  const roles = ["task-sense", "discovery-backend", "discovery-frontend", "discovery-design-system", "discovery-tests", "flow", "truth", "gap"].map(r => bus.router.role(r));
  const governance = Object.fromEntries(readdirSync(join(HARNESS_ROOT, "governance")).filter(f => f.endsWith(".md")).sort().map(f => [f, readFileSync(join(HARNESS_ROOT, "governance", f), "utf8")]));
  return hash({ version: "core-understanding-v1", schemas, roles, governance, implementation_hash: implementationHash(), semantics: SEMANTICS, max_context_bytes: config().max_context_bytes });
}
export function implementationHash(root = HARNESS_ROOT): string {
  const files: Record<string, string> = {};
  function walk(directory: string) {
    if (!existsSync(join(root, directory))) return;
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.(ts|js)$/.test(entry.name)) files[path] = hash(readFileSync(join(root, path), "utf8"));
    }
  }
  for (const directory of ["runtime/src", "cli", "mcp", "dist/runtime/src", "dist/cli", "dist/mcp"]) walk(directory);
  return hash(files);
}
export async function bounded<T>(jobs: (() => Promise<T>)[], concurrency: number): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= jobs.length) return;
      try { results[index] = { status: "fulfilled", value: await jobs[index]() }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  }));
  return results;
}
export class WorkflowService {
  constructor(readonly bus: AgentBus) {}
  propose(root:string,execute=false,decision?:string,revise=false) { return new EngineeringStages(this.bus).propose(root,execute,decision,revise); }
  proposal(root:string) { return new EngineeringStages(this.bus).show(root); }
  proposalReview(root:string,execute=false) { return new EngineeringStages(this.bus).reviewProposal(root,execute); }
  apply(root:string,execute=false) { return new EngineeringStages(this.bus).apply(root,execute); }
  applyReview(root:string,execute=false) { return new EngineeringStages(this.bus).reviewApply(root,execute); }
  engineeringRetry(root:string,child:string,reason:string) { return new EngineeringStages(this.bus).retry(root,child,reason); }
  allArtifacts(root:string) { return [...this.artifacts(root),...(hasEngineering(this.bus,root)?new EngineeringStages(this.bus).artifacts(root):[])]; }
  private authority() { if (this.bus.callerRole !== "master-orchestrator") throw new Error("WORKERS_DO_NOT_ORCHESTRATE_WORKERS"); }
  async start(value: unknown, execute = false) {
    this.authority();
    if (!validRequest(value)) throw new Error("INVALID_WORKFLOW_REQUEST: " + JSON.stringify(validRequest.errors));
    const r = structuredClone(value) as unknown as WorkflowRequest;
    for (const repo of r.repository_scope) if (!this.bus.runtime.repositories.includes(repo)) throw new Error("UNREGISTERED_REPOSITORY");
    for (const p of [...r.allowed_paths, ...r.forbidden_paths]) scopePath(WORKSPACE, p);
    for (const p of r.allowed_paths) if (!r.repository_scope.some(repo => within(scopePath(WORKSPACE, repo), scopePath(WORKSPACE, p))) || r.forbidden_paths.some(f => within(scopePath(WORKSPACE, f), scopePath(WORKSPACE, p)))) throw new Error("WORKFLOW_SCOPE_VIOLATION");
    if (new Set(r.discovery.map(n => n.name)).size !== r.discovery.length) throw new Error("DUPLICATE_DISCOVERY_NODE");
    for (const node of r.discovery) {
      if (this.bus.router.role(node.role).mutation_permission !== "read-only") throw new Error("READ_ONLY_WORKFLOW_REQUIRED");
      for (const p of node.paths) if (!r.allowed_paths.some(a => within(scopePath(WORKSPACE, a), scopePath(WORKSPACE, p))) || r.forbidden_paths.some(f => within(scopePath(WORKSPACE, f), scopePath(WORKSPACE, p)))) throw new Error("DISCOVERY_SCOPE_VIOLATION");
    }
    const root: TaskCapsule = { ...childCapsule(r, "task-sense", []), task_id: r.task_id, parent_task_id: null, role: "master-orchestrator", responsibility: "Coordinate the read-only understanding workflow through GAP_DEFINED", allowed_paths: r.allowed_paths, required_context: [], inputs: [r.user_request], constraints: [...r.constraints, "CORE_UNDERSTANDING_ROOT_V1", `WORKFLOW_REQUEST_HASH:${hash(r)}`] };
    this.bus.router.profile(r.routing_profile);
    const lock = this.bus.storage.path("workflow-execution-" + id(r.task_id) + ".lock");
    const fd = openSync(lock, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, root: r.task_id, created_at: new Date().toISOString() }));
    try {
      const events = this.bus.events.list(r.task_id);
      if (!events.length) this.bus.init(root, r.routing_profile, r.routing_escalations);
      else {
        if (events.some(e => e.event_type === "workflow.created")) throw new Error("TASK_EXISTS");
        if (events.length !== 1 || events[0].event_type !== "task.created" || hash(this.bus.events.get(r.task_id).capsule) !== hash(root)) throw new Error("ROOT_INITIALIZATION_INCOMPATIBLE");
      }
      const routing = this.bus.routing(r.task_id);
      if (!routing || (r.routing_profile && routing.profile !== r.routing_profile) || hash(escalationsOf(routing)) !== hash(r.routing_escalations ?? {})) throw new Error("ROOT_INITIALIZATION_INCOMPATIBLE");
      const m: WorkflowManifest = { version: "core-understanding-v1", adapter_revision: 3, request: r, root_capsule: root, compatibility_hash: compatibilityHash(this.bus), repository_snapshot: snapshot(r.allowed_paths, r.forbidden_paths), routing };
      if (this.bus.storage.exists("workflows", r.task_id, "manifest.json")) {
        if (hash(this.bus.storage.read("workflows", r.task_id, "manifest.json")) !== hash(m)) throw new Error("ROOT_INITIALIZATION_INCOMPATIBLE");
      } else this.bus.storage.create(["workflows", id(r.task_id), "manifest.json"], m);
      this.bus.events.append(r.task_id, "workflow.created", { manifest_hash: hash(m), version: m.version, recovered: events.length > 0 });
    } finally { closeSync(fd); unlinkSync(lock); }
    return execute ? this.resume(r.task_id, true) : this.show(r.task_id);
  }
  artifacts(root: string): WorkflowArtifact[] {
    const m = manifest(this.bus, root);
    return STAGES.flatMap(s => expectedChildren(m, s, this.bus)).filter(c => this.bus.storage.exists("workflows", root, "artifacts", c + ".json")).map(c => readArtifact(this.bus, root, c));
  }
  show(root: string) {
    const m = manifest(this.bus, root);
    const artifacts = this.artifacts(root);
    return { task_id: root, state: this.bus.events.get(root).state, version: m.version, routing_profile: m.routing?.profile ?? null,
      ...(hasEngineering(this.bus,root)?{engineering:new EngineeringStages(this.bus).show(root)}:{}),
      nodes: STAGES.flatMap(stage => expectedChildren(m, stage, this.bus).map(child => {
        const a = artifacts.find(a => a.child_task === child), events = this.bus.events.list(child);
        const role = stage === "discovery" ? m.request.discovery.find(n => resolveChild(this.bus, root, root + "-" + n.name) === child)!.role : stage;
        const route = events.find(e => e.event_type === "agent.delegated")?.payload ?? m.routing?.routes[role] ?? { provider: null, model_alias: null };
        const failure = [...events].reverse().find(e => e.event_type === "agent.failed");
        const stageFailure = this.bus.events.list(root).filter(e => e.event_type === "workflow.stage.failed").flatMap(e => e.payload.failures as any[]).find(f => f.child_task === child);
        return { stage, child_task: child, role, provider: route.provider, model_alias: route.model_alias,
          status: a ? "completed" : failure || stageFailure ? "failed" : events.some(e => e.event_type === "agent.started") ? "awaiting-artifact" : "pending",
          error: a ? null : failure?.payload ?? stageFailure ?? null, isolated: stage === "truth", artifact_hash: a?.content_hash ?? null };
      })) };
  }
  async resume(root: string, execute = false, retryProviderTask?: string) {
    this.authority();
    const m = manifest(this.bus, root);
    if(hasEngineering(this.bus,root)) { await new EngineeringStages(this.bus).resume(root,execute); return this.show(root); }
    if (!execute) return this.show(root);
    // A completed workflow is inspected, never re-executed. No migration of
    // its immutable manifest is needed to read already validated artifacts.
    if (this.bus.events.get(root).state === "GAP_DEFINED" && !retryProviderTask) return this.show(root);
    assertLiveGate(this.bus);
    if (m.compatibility_hash !== compatibilityHash(this.bus)) throw new Error("WORKFLOW_VERSION_INCOMPATIBLE");
    if (hash(m.repository_snapshot) !== hash(snapshot(m.request.allowed_paths, m.request.forbidden_paths))) throw new Error("WORKFLOW_SOURCE_CHANGED");
    if (["FAILED", "BLOCKED", "DONE"].includes(this.bus.events.get(root).state)) throw new Error("TASK_TERMINAL");
    const lock = this.bus.storage.path("workflow-execution-" + id(root) + ".lock");
    const fd = openSync(lock, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, root, created_at: new Date().toISOString() }));
    try {
      if (retryProviderTask) {
        const childEvents = this.bus.events.list(retryProviderTask);
        const observationRef = [...childEvents].reverse().find(e => e.event_type === "provider.observed");
        const observation = observationRef ? this.bus.storage.read<any>("provider-observations", String(observationRef.payload.artifact)) : null;
        const retries = childEvents.filter(e => e.event_type === "workflow.provider-retry.authorized").length;
        if (!STAGES.flatMap(s => expectedChildren(m, s, this.bus)).includes(retryProviderTask) || this.bus.storage.exists("results", id(retryProviderTask) + ".json") || retries >= 2 || !observation || observation.exit_code !== 1 || !observation.errors?.some((e: string) => e.includes("invalid_json_schema")) || hash(observation) !== observationRef!.payload.content_hash) throw new Error("PROVIDER_RETRY_NOT_ALLOWED");
        this.bus.events.append(retryProviderTask, "workflow.provider-retry.authorized", { reason: "Explicit retry after pre-inference schema rejection", attempt: retries + 2 });
      }
      if (this.bus.events.get(root).state === "TASK_RECEIVED") this.bus.transition(root, "TASK_CLASSIFIED", this.bus.events.get(root).revision);
      for (const stage of STAGES) {
        const artifacts = this.artifacts(root);
        const stageIndex = STAGES.findIndex(s => STATES[s] === this.bus.events.get(root).state);
        if (stageIndex >= STAGES.indexOf(stage)) {
          for (const child of expectedChildren(m, stage, this.bus)) if (!artifacts.some(a => a.child_task === child)) throw new Error("COMPLETED_STAGE_ARTIFACT_MISSING");
          continue;
        }
        if (stage === "flow") this.assertAmbiguities(artifacts);
        const nodes = stage === "discovery" ? m.request.discovery : [undefined];
        const settled = await bounded(nodes.map(node => async () => {
          const c = childCapsule(m.request, stage, artifacts, node, m.adapter_revision ?? 1);
          c.task_id = resolveChild(this.bus, root, c.task_id);
          const existing = artifacts.find(a => a.child_task === c.task_id);
          if (existing) {
            if (!this.bus.events.list(root).some(e => e.event_type === "workflow.artifact.created" && e.payload.content_hash === existing.content_hash)) this.bus.events.append(root, "workflow.artifact.created", { child_task: c.task_id, stage, content_hash: existing.content_hash, recovered: true });
            return existing;
          }
          if (Buffer.byteLength(JSON.stringify(c)) > config().max_context_bytes) throw new Error("WORKFLOW_CONTEXT_BUDGET_EXCEEDED");
          const events = this.bus.events.list(c.task_id);
          if (!events.length) {
            this.bus.init(c);
          } else if (hash(this.bus.events.get(c.task_id).capsule) !== hash(c)) throw new Error("CHILD_CAPSULE_INCOMPATIBLE");
          const authorization = this.bus.events.list(root).find(e => e.event_type === "workflow.child.created" && e.payload.child_task === c.task_id);
          if (authorization && (authorization.payload.capsule_hash !== hash(c) || authorization.payload.stage !== stage)) throw new Error("CHILD_AUTHORIZATION_INCOMPATIBLE");
          if (!authorization) {
            if (events.some(e => e.event_type !== "task.created")) throw new Error("CHILD_AUTHORIZATION_MISSING_AFTER_EXECUTION");
            this.bus.events.append(root, "workflow.child.created", { child_task: c.task_id, capsule_hash: hash(c), stage, recovered: events.length > 0 });
          }
          let result: AgentResult;
          if (this.bus.storage.exists("results", c.task_id + ".json")) result = this.bus.recoverWorkflowResult(c.task_id);
          else {
            if (events.some(e => e.event_type === "agent.started" || e.event_type === "agent.failed") && retryProviderTask !== c.task_id) throw new Error("EXPLICIT_NEW_TASK_REQUIRED_AFTER_FAILURE: " + c.task_id);
            result = await this.bus.delegateWorkflow(c.task_id) as AgentResult;
          }
          if (result.status !== "completed" || !result.workflow_output) throw new Error("WORKFLOW_CHILD_NOT_COMPLETED: " + c.task_id);
          const inputs = selectedInputs(stage, artifacts);
          checkOutput(result.workflow_output, c, inputs);
          if (hash(m.repository_snapshot) !== hash(snapshot(m.request.allowed_paths, m.request.forbidden_paths))) throw new Error("WORKFLOW_SOURCE_CHANGED");
          const route = this.bus.events.list(c.task_id).find(e => e.event_type === "agent.delegated")!.payload;
          const body: Omit<WorkflowArtifact, "content_hash"> = { root_task: root, child_task: c.task_id, stage, role: c.role,
            provider: String(route.provider), model_alias: String(route.model_alias), model: String(route.model), created_at: new Date().toISOString(),
            source_agent_result: { task_id: c.task_id, content_hash: hash(result) }, input_artifact_references: inputs.map(a => ({ child_task: a.child_task, content_hash: a.content_hash })), output: result.workflow_output };
          const artifact = { ...body, content_hash: hash(body) };
          validateArtifact(this.bus, root, c.task_id, artifact);
          this.bus.storage.create(["workflows", root, "artifacts", c.task_id + ".json"], artifact);
          this.bus.events.append(root, "workflow.artifact.created", { child_task: c.task_id, stage, content_hash: artifact.content_hash });
          return artifact;
        }), config().concurrency);
        const failures = settled.flatMap((r, i) => r.status === "rejected" ? [{ child_task: expectedChildren(m, stage, this.bus)[i], error: r.reason instanceof Error ? r.reason.message : String(r.reason) }] : []);
        if (failures.length) {
          this.bus.events.append(root, "workflow.stage.failed", { stage, failures });
          throw new Error("WORKFLOW_STAGE_FAILED: " + JSON.stringify(failures));
        }
        this.bus.transition(root, STATES[stage], this.bus.events.get(root).revision);
      }
      return this.show(root);
    } finally { closeSync(fd); unlinkSync(lock); }
  }
  private assertAmbiguities(artifacts: WorkflowArtifact[]) {
    const sense = artifacts.find(a => a.stage === "task-sense")!.output.content;
    const discoveries = artifacts.filter(a => a.stage === "discovery");
    const triage = discoveries.flatMap(a => a.output.content.ambiguity_triage);
    for (const q of sense.ambiguities) {
      const answers = triage.filter(t => t.id === q.id);
      if (discoveries.some(d => d.output.content.ambiguity_triage.filter((a: any) => a.id === q.id).length !== 1) || !answers.length || (q.blocking && (
        !answers.some(a => a.kind === "factual" && a.status === "closed" && a.evidence.length) ||
        answers.some(a => a.kind !== "factual" || a.status === "open" || !a.evidence.length)
      ))) throw new Error("WORKFLOW_AMBIGUITY_UNRESOLVED: " + q.id);
    }
  }
  replaceFailedChild(root: string, child: string, reason: string) {
    this.authority();
    const lock = this.bus.storage.path("workflow-execution-" + id(root) + ".lock");
    const fd = openSync(lock, "wx", 0o600);
    try {
    const m = manifest(this.bus, root);
    if (!reason.trim()) throw new Error("EXPLICIT_RETRY_REASON_REQUIRED");
    const stage = STAGES.find(s => expectedChildren(m, s, this.bus).includes(child));
    if (!stage || this.bus.storage.exists("workflows", root, "artifacts", id(child) + ".json")) throw new Error("ONLY_FAILED_CHILD_CAN_BE_REPLACED");
    const events = this.bus.events.list(root);
    if (!this.bus.events.list(child).some(e => e.event_type === "agent.failed") && !events.some(e => e.event_type === "workflow.stage.failed" && (e.payload.failures as any[]).some(f => f.child_task === child))) throw new Error("ONLY_FAILED_CHILD_CAN_BE_REPLACED");
    const base = expectedChildren(m, stage).find(c => resolveChild(this.bus, root, c) === child)!;
    const attempts = events.filter(e => e.event_type === "workflow.child.replaced" && e.payload.original_child === base).length;
    if (attempts >= 2) throw new Error("EXPLICIT_RETRY_LIMIT_REACHED");
    const replacement = id(`${base}-retry-${attempts + 1}`);
    this.bus.events.append(root, "workflow.child.replaced", { original_child: base, previous_child: child, replacement_child: replacement, reason });
    return { root_task: root, failed_child: child, replacement_child: replacement, execute: false };
    } finally { closeSync(fd); unlinkSync(lock); }
  }
}
