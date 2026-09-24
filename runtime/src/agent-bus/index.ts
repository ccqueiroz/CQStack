import {
  readFileSync,
  readdirSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import type {
  AgentProvider,
  AgentResult,
  ResolvedRole,
  RoutingSnapshot,
  TaskCapsule,
  TaskState,
  ReviewResult,
  ArtifactReference,
  ApiContract,
  ContractChange,
  MaintenanceEdit,
  MaintenancePatchResult,
} from "../contracts.js";
import {
  HARNESS_ROOT,
  Storage,
  hash,
  scopePath,
  within,
  id,
} from "../storage.js";
import { Router } from "../router/index.js";
import type { RoutingEscalations } from "../router/index.js";
import { EventStore } from "../events/index.js";
import { assertTransition } from "../state/index.js";
import { LockService } from "../locks/index.js";
import { WorktreeManager } from "../worktrees/index.js";
import { CodexProvider } from "../providers/codex.js";
import { ClaudeProvider } from "../providers/claude.js";
import { validate, parseAgentResult } from "../validation/index.js";
import { smokeCapsule } from "../providers/smoke.js";
import { assertWorkflowTransition, manifest } from "../workflow/artifacts.js";
import { assertLiveGate, config as workflowConfig } from "../workflow/service.js";
import type { Stage } from "../workflow/contracts.js";
import { reviewSubject } from "../workflow/review.js";
import { assertEngineeringChild } from "../workflow/engineering/adapters.js";
import { hasEngineering, assertEngineeringTransition, applySubject, approvedProposal, isContractPair, approvedContract, gapIsEmpty, reviewEvidenceAllowlist, proposalScopePatterns } from "../workflow/engineering/artifacts.js";
import { registerFixtureRepository } from "../workflow/engineering/fixture.js";
import { configuredExecutor, type ExecutionSandbox } from "../execution/sandbox.js";
import { ExecutionGrants, isInternalMaintenanceCapsule } from "../execution/grants.js";
import { executionGrantTimeout } from "../execution/timeouts.js";
import { checkFileEvidence } from "../validation/evidence.js";
import { flowEvidenceAllowlistOf, isFlowCapsule } from "../workflow/producers/flow.js";
import { runProcess } from "../processes/run.js";

const WIRE_STRIPPED_KEYWORDS = ["$id", "$schema", "allOf", "uniqueItems", "pattern"];
// Keywords each provider CLI accepted without rejection in the P2.1 probes (Claude Code
// 2.1.280); canonical validation still enforces them after parsing. Claude rejects a
// top-level allOf, the only place the canonical schema uses it. Codex (codex-cli 0.156.1,
// isolated probes 2026-09-23/24) rejects allOf, if, uniqueItems and any lookaround regex,
// which the canonical relativePath pattern needs; it accepts $id and $schema, but they
// carry no constraint, and maxItems, which reaches it through the pins, not this list.
// An unlisted provider keeps the full strip.
export const PROVIDER_WIRE_KEYWORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  claude: new Set(["pattern", "uniqueItems"]),
  codex: new Set(),
};

function snapshot(root: string, skipSymlinks = false): Record<string, string> {
  const files: Record<string, string> = {};
  function walk(path: string) {
    const rootStat = lstatSync(path);
    if (rootStat.isSymbolicLink()) {
      if (skipSymlinks) return;
      throw new Error("SYMLINK_WORKTREE_REJECTED");
    }
    if (rootStat.isFile()) {
      files[relative(root, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
      return;
    }
    for (const name of readdirSync(path)) {
      const p = join(path, name),
        stat = lstatSync(p);
      if (stat.isSymbolicLink()) {
        if (skipSymlinks) {
          files[relative(root, p)] = `symlink:${readlinkSync(p)}`;
          continue;
        }
        throw new Error("SYMLINK_WORKTREE_REJECTED");
      }
      if (stat.isDirectory()) walk(p);
      else if (stat.isFile())
        files[relative(root, p)] = createHash("sha256")
          .update(readFileSync(p))
          .digest("hex");
    }
  }
  walk(root);
  return files;
}
function validateSymlinkTargets(root: string): void {
  const workspaceRoot = realpathSync(root);
  function walk(path: string): void {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      let target: string;
      try {
        target = realpathSync(path);
      } catch {
        throw new Error("SYMLINK_TARGET_INVALID");
      }
      if (!within(workspaceRoot, target)) throw new Error("SYMLINK_TARGET_OUTSIDE_WORKSPACE");
      return;
    }
    if (!stat.isDirectory()) return;
    for (const name of readdirSync(path)) walk(join(path, name));
  }
  walk(root);
}
function differences(
  before: Record<string, string>,
  after: Record<string, string>
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((p) => before[p] !== after[p])
    .sort();
}
function validateMaintenanceEdit(edit: MaintenanceEdit, c: TaskCapsule, cwd: string): string {
  if (!edit.relative_path || edit.relative_path.startsWith("/") || edit.relative_path.split(/[\\/]/).includes("..") || edit.relative_path.includes("\\")) throw new Error("MAINTENANCE_EDIT_PATH_INVALID");
  const normalized = edit.relative_path.split("/").filter(Boolean).join("/");
  if (normalized !== edit.relative_path || !c.allowed_paths.includes(normalized)) throw new Error("MAINTENANCE_EDIT_SCOPE_VIOLATION");
  const absolute = scopePath(cwd, normalized);
  const root = realpathSync(cwd);
  if (!within(root, absolute)) throw new Error("MAINTENANCE_EDIT_ESCAPE");
  const parts = normalized.split("/");
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    if (!existsSync(current)) {
      if (i !== parts.length - 1) throw new Error("MAINTENANCE_EDIT_PARENT_MISSING");
      break;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("MAINTENANCE_EDIT_SYMLINK");
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error("MAINTENANCE_EDIT_PARENT_NOT_DIRECTORY");
    if (i === parts.length - 1 && !stat.isFile()) throw new Error("MAINTENANCE_EDIT_NOT_REGULAR_FILE");
  }
  const exists = existsSync(absolute);
  if (exists) {
    const actual = createHash("sha256").update(readFileSync(absolute)).digest("hex");
    if (edit.expected_before_hash !== actual) throw new Error("MAINTENANCE_EDIT_HASH_MISMATCH");
  } else if (edit.expected_before_hash !== null) throw new Error("MAINTENANCE_EDIT_NEW_FILE_HASH");
  return absolute;
}
function applyMaintenanceEdits(edits: MaintenanceEdit[], c: TaskCapsule, cwd: string): () => void {
  const backups = new Map<string, Buffer | null>();
  const applied: string[] = [];
  try {
    for (const edit of edits) {
      const target = validateMaintenanceEdit(edit, c, cwd);
      backups.set(target, existsSync(target) ? readFileSync(target) : null);
      const parent = join(target, "..");
      const temp = join(parent, `.${id(c.task_id)}-${hash(edit)}.tmp`);
      writeFileSync(temp, edit.content, { flag: "wx", mode: 0o600 });
      try {
        validateMaintenanceEdit(edit, c, cwd);
        renameSync(temp, target);
      } finally {
        if (existsSync(temp)) unlinkSync(temp);
      }
      applied.push(target);
    }
  } catch (error) {
    for (const target of applied) {
      const backup = backups.get(target);
      if (backup === null) unlinkSync(target);
      else if (backup) writeFileSync(target, backup);
    }
    throw error;
  }
  return () => {
    for (const target of applied) {
      const backup = backups.get(target);
      if (backup === null) unlinkSync(target);
      else if (backup) writeFileSync(target, backup);
    }
  };
}
async function runMaintenanceTests(c: TaskCapsule, cwd: string, onFailure: (failure: {
  command: string; exit_code: number | null; stdout: string; stderr: string;
}) => void): Promise<{ command: string; exit_code: number; evidence: string }[]> {
  const results: { command: string; exit_code: number; evidence: string }[] = [];
  for (const command of c.owned_tests) {
    const output = await runProcess({ command: "/bin/sh", args: ["-lc", command], cwd, stdin: "", timeout_ms: 120000 });
    results.push({ command, exit_code: output.exit_code ?? 1, evidence: output.stderr || output.stdout || "completed" });
    if (output.exit_code !== 0) {
      onFailure({ command, exit_code: output.exit_code, stdout: output.stdout, stderr: output.stderr });
      throw new Error("MAINTENANCE_OWNED_TEST_FAILED");
    }
  }
  return results;
}
export const IMPLEMENTATION_ROLES = ["opsx-implementation-worker", "frontend-worker", "backend-worker"];
export function assertScope(
  capsule: TaskCapsule,
  path: string,
  cwd: string
): void {
  const p = scopePath(cwd, path);
  if (
    path.split("/").includes(".git") ||
    !capsule.allowed_paths.some((a) => within(scopePath(cwd, a), p)) ||
    capsule.forbidden_paths.some((f) => within(scopePath(cwd, f), p))
  )
    throw new Error("SCOPE_VIOLATION: " + path);
}
export class AgentBus {
  private readonly executionGrants: ExecutionGrants;
  private readonly workflowGrants = new Map<string, string>();
  private readonly engineeringGrants = new Map<string, string>();
  readonly executionPolicy: { write_application_execution: boolean } = JSON.parse(readFileSync(join(HARNESS_ROOT,"config/execution.json"),"utf8"));
  readonly events: EventStore;
  readonly locks: LockService;
  readonly worktrees: WorktreeManager;
  readonly router: Router;
  readonly runtime: {
    model_execution_enabled: boolean;
    timeout_ms: number;
    repositories: string[];
  };
  constructor(
    readonly storage = new Storage(join(HARNESS_ROOT, "state")),
    readonly providers: Record<string, AgentProvider> = {
      codex: new CodexProvider(),
      claude: new ClaudeProvider(),
    },
    readonly actor = "cockpit",
    readonly callerRole = "master-orchestrator",
    readonly executionSandbox: ExecutionSandbox = configuredExecutor()
  ) {
    this.executionGrants = new ExecutionGrants(storage, () => this.runtime.model_execution_enabled);
    this.events = new EventStore(storage, () => this.authority());
    this.locks = new LockService(
      storage,
      () => this.authority(),
      (r, t, h) => this.verifyReview(r, t, h)
    );
    this.worktrees = new WorktreeManager(storage, () => this.authority());
    this.router = new Router();
    this.runtime = JSON.parse(
      readFileSync(join(HARNESS_ROOT, "config/runtime.json"), "utf8")
    );
    registerFixtureRepository(this);
  }
  private authority(): void {
    if (this.callerRole !== "master-orchestrator")
      throw new Error("WORKERS_DO_NOT_ORCHESTRATE_WORKERS");
  }
  init(value: unknown, routingProfile?: string, routingEscalations?: RoutingEscalations) {
    this.authority();
    const capsule = validate<TaskCapsule>("task-capsule", value);
    this.validateCapsule(capsule);
    if (capsule.parent_task_id) this.events.get(capsule.parent_task_id);
    if (capsule.parent_task_id && routingProfile !== undefined) throw new Error("ROUTING_PROFILE_ROOT_ONLY");
    if (capsule.parent_task_id && routingEscalations !== undefined) throw new Error("ROUTING_ESCALATION_ROOT_ONLY");
    // The route is resolved once per root task and never re-resolved for its children.
    const routing = capsule.parent_task_id ? null : this.router.snapshot(capsule.task_id, routingProfile, routingEscalations);
    if (capsule.worktree) {
      this.worktrees.validate(capsule.worktree);
      if (
        capsule.worktree.task_id !== capsule.task_id ||
        capsule.worktree.role !== capsule.role
      )
        throw new Error("WORKTREE_TASK_MISMATCH");
    }
    const task = this.events.create(capsule);
    if (routing) this.storage.create(["routing", id(capsule.task_id) + ".json"], routing);
    if (capsule.worktree) {
      this.events.append(capsule.task_id, "worktree.created", {
        worktree: capsule.worktree,
      });
    }
    return task;
  }
  routing(root: string): RoutingSnapshot | null {
    const file = id(root) + ".json";
    if (!this.storage.exists("routing", file)) return null;
    const snapshot = this.storage.read<RoutingSnapshot>("routing", file);
    if (snapshot.version !== 1 || snapshot.root_task_id !== root) throw new Error("ROUTING_SNAPSHOT_INVALID: " + root);
    return snapshot;
  }
  route(root: string, role: string): ResolvedRole {
    const snapshot = this.routing(root);
    if (!snapshot) throw new Error("ROUTING_SNAPSHOT_REQUIRED: " + root);
    const route = snapshot.routes[role];
    if (!route) throw new Error("ROUTE_NOT_IN_SNAPSHOT: " + role);
    return this.router.materialize(role, route);
  }
  routeFor(capsule: TaskCapsule): ResolvedRole {
    let root = capsule;
    for (let depth = 0; root.parent_task_id; depth++) {
      if (depth >= 8) throw new Error("TASK_HIERARCHY_TOO_DEEP");
      root = this.events.get(root.parent_task_id).capsule;
    }
    return this.route(root.task_id, capsule.role);
  }
  private validateCapsule(capsule: TaskCapsule): void {
    const role = this.router.role(capsule.role);
    if(capsule.role.startsWith("opsx-")&&!capsule.constraints.includes("CORE_ENGINEERING_V1")) throw new Error("ENGINEERING_CHILD_REQUIRED");
    if (capsule.role === "master-orchestrator" && !(capsule.constraints.includes("CORE_UNDERSTANDING_ROOT_V1") && capsule.permissions === "read-only" && !capsule.worktree && !capsule.parent_task_id))
      throw new Error("WORKER_ROLE_REQUIRED");
    if (
      capsule.permissions !== "read-only" &&
      capsule.permissions !== role.mutation_permission
    )
      throw new Error("ROLE_PERMISSION_DENIED");
    const cwd = capsule.worktree?.path ?? resolve(HARNESS_ROOT, "../..");
    for (const p of [
      ...capsule.allowed_paths,
      ...capsule.forbidden_paths,
      ...capsule.required_context,
    ])
      scopePath(cwd, p);
    for (const p of capsule.allowed_paths)
      if (p.split("/").includes(".git"))
        throw new Error("GIT_MUTATION_FORBIDDEN");
  }
  plan(task: string) {
    const { capsule, state } = this.events.get(task);
    this.validateCapsule(capsule);
    const route = this.routeFor(capsule);
    return {
      task_id: task,
      state,
      role: capsule.role,
      provider: route.provider,
      model_alias: route.model_alias,
      model: route.model,
      effort: route.effort,
      worktree: capsule.worktree,
      allowed_paths: capsule.allowed_paths,
      forbidden_paths: capsule.forbidden_paths,
      required_artifacts: route.role.required_artifacts,
      permissions: capsule.permissions,
      model_execution_enabled: this.runtime.model_execution_enabled,
    };
  }
  private prerequisites(c: TaskCapsule) {
    const required = this.router.role(c.role).required_artifacts;
    if (c.api_contract_reference) {
      if (c.role.startsWith("api-contract-") && c.role.endsWith("-reviewer")) {
        const { contract } = this.locks.get(c.api_contract_reference);
        if (hash(contract) !== c.api_contract_reference.content_hash)
          throw new Error("CONTRACT_HASH_MISMATCH");
      } else this.locks.require(c.api_contract_reference);
    } else if (required.includes("api-contract"))
      throw new Error("API_CONTRACT_REQUIRED");
    if (
      c.constraints.includes("API_CONTRACT_REQUIRED") &&
      !c.api_contract_reference
    )
      throw new Error("API_CONTRACT_LOCK_REQUIRED");
    if (
      c.constraints.includes("VISUAL_REVIEW_REQUIRED") &&
      !c.visual_lock_reference
    )
      throw new Error("VISUAL_LOCK_REQUIRED");
    if (c.visual_lock_reference) this.locks.visual(c.visual_lock_reference);
    else if (required.includes("visual-lock"))
      throw new Error("VISUAL_LOCK_REQUIRED");
  }
  async delegate(
    task: string,
    dryRun = true,
    signal?: AbortSignal
  ): Promise<unknown> {
    this.authority();
    const plan = this.plan(task);
    if (dryRun) return plan;
    if (plan.role === "master-orchestrator") throw new Error("WORKER_ROLE_REQUIRED");
    const { capsule: c, state } = this.events.get(task);
    const route = this.routeFor(c),
      cwd = c.worktree?.path ?? resolve(HARNESS_ROOT, "../..");
    const provider = this.providers[route.provider];
    if (!provider) throw new Error("PROVIDER_UNAVAILABLE: " + route.provider);
    const rootCapsule = c.parent_task_id ? this.events.get(c.parent_task_id).capsule : c;
    const executionGrant = this.executionGrants.eligible(c, rootCapsule, route);
    if (!this.runtime.model_execution_enabled &&
        !executionGrant &&
        this.workflowGrants.get(task) !== hash(this.events.get(task).capsule) &&
        this.engineeringGrants.get(task) !== hash(this.events.get(task).capsule))
      throw new Error("MODEL_EXECUTION_DISABLED");
    const maintenanceGrant = executionGrant?.maintenance_write === true;
    if (c.constraints.includes("CORE_ENGINEERING_V1") && !isInternalMaintenanceCapsule(c)) assertEngineeringChild(this,task);
    if (c.permissions !== "read-only" && !maintenanceGrant && this.engineeringGrants.get(task) !== hash(c) && !this.executionPolicy.write_application_execution) throw new Error("APPLICATION_WRITE_DISABLED");
    if (["DONE", "FAILED", "BLOCKED"].includes(state))
      throw new Error("TASK_TERMINAL");
    if (this.storage.exists("results", id(task) + ".json"))
      throw new Error("RESULT_ALREADY_EXISTS");
    this.prerequisites(c);
    if (c.permissions !== "read-only" && state !== "IMPLEMENTATION_RUNNING")
      throw new Error("IMPLEMENTATION_STATE_REQUIRED");
    if (c.permissions !== "read-only" && !c.worktree && !maintenanceGrant)
      throw new Error("OWNED_WORKTREE_REQUIRED");
    if (c.worktree) {
      if (this.storage.exists("quarantine", c.worktree.id + ".json"))
        throw new Error("QUARANTINED_WORKTREE");
      this.worktrees.validate(c.worktree);
      if (c.permissions !== "read-only") this.worktrees.assertClean(c.worktree);
      if (c.worktree.task_id !== task || c.worktree.role !== c.role)
        throw new Error("WORKTREE_TASK_MISMATCH");
    }
    const executionLock = this.storage.path("execution-" + id(task) + ".lock");
    const fd = openSync(executionLock, "wx", 0o600);
    let rollback: (() => void) | null = null;
    try {
      // A different process may have finished between the initial result check
      // and acquisition of this lock. Never invoke the provider twice.
      if (this.storage.exists("results", id(task) + ".json")) throw new Error("RESULT_ALREADY_EXISTS");
      let snapshotBefore = c.permissions !== "read-only" && !maintenanceGrant ? snapshot(cwd) : null;
      for (const p of c.required_context) {
        const path = scopePath(cwd, p);
        if (!existsSync(path))
          throw new Error("REQUIRED_CONTEXT_MISSING: " + p);
        if (c.forbidden_paths.some((f) => within(scopePath(cwd, f), path)))
          throw new Error("FORBIDDEN_CONTEXT");
      }
      const governance = this.router.role(c.role).governance
        .map((f) => readFileSync(join(HARNESS_ROOT, "governance", f), "utf8"))
        .join("\n");
      const prompt =
        governance +
        (maintenanceGrant
          ? "\nExecute exactly this capsule in read-only mode. Return only a maintenance-patch JSON envelope with kind, edits, and agent_result. Never modify the workspace.\n"
          : "\nExecute exactly this capsule. You are a worker, never delegate or invoke agent CLIs. Return only AgentResult JSON. Read only the listed necessary context. Do not modify Git metadata, governance, state, locks or instructions.\n") +
        JSON.stringify({
          capsule: c,
          artifacts: {
            api_contract: c.api_contract_reference
              ? this.locks.get(c.api_contract_reference).contract
              : null,
            visual_lock: c.visual_lock_reference
              ? this.locks.visual(c.visual_lock_reference)
              : null,
            review_subject:
              c.role === "adversarial-reviewer" && c.parent_task_id
                ? this.events.get(c.parent_task_id).capsule.constraints.includes("CORE_UNDERSTANDING_ROOT_V1") ? reviewSubject(this, c.parent_task_id) : {
                    result: this.result(c.parent_task_id),
                    subject_hash: hash(this.result(c.parent_task_id)),
                  }
                : null,
          },
        });
      if (executionGrant) {
        const receipt = this.executionGrants.consume(this.events.get(task).capsule, this.events.get(rootCapsule.task_id).capsule, this.routeFor(c), executionGrant);
        this.events.append(task, "execution.grant.consumed", receipt, this.actor);
      }
      this.events.append(task, "agent.delegated", { ...plan, ...(executionGrant ? { execution_grant_hash: hash(executionGrant) } : {}) }, this.actor);
      const startedEvent = this.events.append(
        task,
        "agent.started",
        { provider: route.provider },
        this.actor,
        c.role
      );
      if (maintenanceGrant) {
        validateSymlinkTargets(cwd);
        snapshotBefore = snapshot(cwd, true);
      }
      const pendingObservations: Array<Record<string, unknown>> = [];
      const persistObservation = (observation: Record<string, unknown>) => {
        const artifact = { task_id: task, role: c.role, provider: route.provider, model_alias: route.model_alias, model: route.model, created_at: new Date().toISOString(), ...observation };
        const name = `${id(task)}-${hash(artifact)}.json`;
        this.storage.create(["provider-observations", name], artifact);
        this.events.append(task, "provider.observed", { artifact: name, content_hash: hash(artifact) }, this.actor, c.role);
      };
      const raw = await provider.execute({
        capsule: c,
        route,
        cwd,
        prompt,
        result_schema_path: this.providerSchema(c, route.provider),
        timeout_ms: executionGrant ? executionGrantTimeout(this.runtime.timeout_ms, executionGrant) : this.workflowGrants.has(task) || this.engineeringGrants.has(task) ? workflowConfig().timeout_ms : this.runtime.timeout_ms,
        signal,
        observe: (observation) => {
          if (maintenanceGrant) pendingObservations.push(observation);
          else persistObservation(observation);
        },
      });
      const providerSnapshotAfter = maintenanceGrant ? snapshot(cwd, true) : null;
      if (maintenanceGrant) validateSymlinkTargets(cwd);
      const providerChanges = snapshotBefore && providerSnapshotAfter
        ? differences(snapshotBefore, providerSnapshotAfter)
        : null;
      if (maintenanceGrant && providerChanges?.length) throw new Error("MAINTENANCE_PROVIDER_WRITE_FORBIDDEN");
      const patch = maintenanceGrant ? raw as MaintenancePatchResult : null;
      if (maintenanceGrant && (!patch || patch.kind !== "maintenance-patch" || !Array.isArray(patch.edits) || !patch.agent_result)) throw new Error("MAINTENANCE_PATCH_INVALID");
      let appliedTests: { command: string; exit_code: number; evidence: string }[] = [];
      if (maintenanceGrant && patch) {
        const observation = { task_id: task, capsule_hash: hash(c), patch };
        const observationName = `${id(task)}-${hash(observation)}.json`;
        this.storage.create(["maintenance-patch-observations", observationName], observation);
        this.events.append(task, "maintenance.patch.observed", {
          artifact: `maintenance-patch-observations/${observationName}`, content_hash: hash(observation),
        }, this.actor, c.role);
        // Account only for these exact bus-owned writes; all other snapshot entries
        // retain their original baseline and scope checks.
        for (const path of [this.storage.path("maintenance-patch-observations", observationName), this.storage.path("events", task + ".jsonl")]) {
          if (snapshotBefore && within(cwd, path))
            snapshotBefore[relative(cwd, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
        }
        if (patch.edits.length === 0) throw new Error("MAINTENANCE_PATCH_EMPTY");
        for (const edit of patch.edits) validateMaintenanceEdit(edit, c, cwd);
        rollback = applyMaintenanceEdits(patch.edits, c, cwd);
        const appliedSnapshot = snapshot(cwd, true);
        const appliedChanges = snapshotBefore ? differences(snapshotBefore, appliedSnapshot) : [];
        for (const p of appliedChanges) assertScope(c, p, cwd);
        appliedTests = await runMaintenanceTests(c, cwd, failure => {
          const artifact = {
            task_id: task, capsule_hash: hash(c), ...failure,
            applied_paths: patch.edits.map(edit => edit.relative_path),
          };
          const name = `${id(task)}-${hash(artifact)}.json`;
          this.storage.create(["maintenance-test-failures", name], artifact);
          this.events.append(task, "maintenance.owned_test.failed", {
            artifact: `maintenance-test-failures/${name}`, content_hash: hash(artifact),
          }, this.actor, c.role);
        });
      }
      const snapshotAfter = maintenanceGrant ? snapshot(cwd, true) : null;
      const snapshotChanges = snapshotBefore && snapshotAfter
        ? differences(snapshotBefore, snapshotAfter)
        : null;
      if (maintenanceGrant && snapshotChanges) {
        for (const p of snapshotChanges) assertScope(c, p, cwd);
      }
      const result = parseAgentResult(JSON.stringify(maintenanceGrant ? (patch as MaintenancePatchResult).agent_result : raw));
      // Owned test runs are the harness's own record; result.tests_executed stays the worker's claim.
      if (maintenanceGrant && appliedTests.length) {
        const record = { task_id: task, capsule_hash: hash(c), tests: appliedTests };
        const name = `${id(task)}-${hash(record)}.json`;
        this.storage.create(["maintenance-test-runs", name], record);
        this.events.append(task, "maintenance.owned_test.executed", {
          artifact: `maintenance-test-runs/${name}`, content_hash: hash(record),
          tests: appliedTests.map(({ command, exit_code }) => ({ command, exit_code })),
        }, this.actor, c.role);
      }
      if (c.role === "adversarial-reviewer" || c.role.endsWith("-reviewer")) {
        if (!result.review_result) throw new Error("REVIEW_ARTIFACT_REQUIRED");
        if (result.status !== "completed")
          throw new Error("REVIEWER_STATUS_MUST_BE_COMPLETED");
      }
      if (result.review_result) {
        const review = result.review_result;
        validate("review-result", review);
        if (
          !c.parent_task_id ||
          review.task_id !== c.parent_task_id ||
          review.reviewer !== c.task_id ||
          review.role !== c.role
        )
          throw new Error("REVIEW_PROVENANCE_MISMATCH");
      }
      if (result.task_id !== task || result.role !== c.role)
        throw new Error("AGENT_RESULT_IDENTITY_MISMATCH");
      if (result.scope_expanded) throw new Error("SCOPE_EXPANSION_PERFORMED");
      for (const p of result.changed_files) assertScope(c, p, cwd);
      if (maintenanceGrant && patch && hash([...new Set(result.changed_files)].sort()) !== hash([...new Set(patch.edits.map(edit => edit.relative_path))].sort())) throw new Error("MAINTENANCE_CHANGED_FILES_MISMATCH");
      if (c.permissions === "read-only" && result.changed_files.length)
        throw new Error("READ_ONLY_MUTATION");
      if (executionGrant?.execution_mode === "orchestrated-read-only-diagnosis" && !maintenanceGrant && result.tests_executed.length)
        throw new Error("DIAGNOSTIC_TEST_EXECUTION_FORBIDDEN");
      if (executionGrant) for (const evidence of result.evidence) checkFileEvidence(evidence.source, c, cwd);
      if (snapshotBefore && !maintenanceGrant) {
        const changed = snapshotChanges ?? differences(snapshotBefore, snapshot(cwd));
        for (const p of changed) assertScope(c, p, cwd);
        if (hash(changed) !== hash([...new Set(result.changed_files)].sort()))
          throw new Error("CHANGED_FILES_EVIDENCE_MISMATCH");
      }
      if (c.worktree) this.worktrees.validate(c.worktree);
      this.prerequisites(c);
      for (const observation of pendingObservations) persistObservation(observation);
      this.events.append(task, "agent.result.validated", {
        result_hash: hash(result), capsule_hash: hash(c),
        execution_event_id: startedEvent.event_id,
      }, this.actor, c.role);
      this.storage.create(["results", id(task) + ".json"], result);
      if (c.worktree && c.permissions !== "read-only" && (result.status !== "completed" || result.deviations.length || result.proposal_deviation) && !this.storage.exists("quarantine",c.worktree.id+".json")) {
        this.storage.create(["quarantine",c.worktree.id+".json"],{task_id:task,worktree_id:c.worktree.id,reason:result.status,timestamp:new Date().toISOString()});
      }
      if (result.status === "needs_scope_expansion")
        this.events.append(
          task,
          "scope.expansion.requested",
          { requests: result.requested_followups },
          this.actor,
          c.role
        );
      this.events.append(
        task,
        result.status === "failed" ? "agent.failed" : "agent.completed",
        {
          result_status: result.status,
          result_hash: hash(result),
          verification: "worker-claim-requires-review",
        },
        this.actor,
        c.role
      );
      rollback = null;
      return result;
    } catch (error) {
      if (rollback) {
        try { rollback(); } catch { /* preserve original failure */ }
      }
      if (
        c.worktree &&
        c.permissions !== "read-only" &&
        !this.storage.exists("quarantine", c.worktree.id + ".json")
      )
        this.storage.create(["quarantine", c.worktree.id + ".json"], {
          task_id: task,
          worktree_id: c.worktree.id,
          reason: error instanceof Error ? error.message : "UNKNOWN_ERROR",
          timestamp: new Date().toISOString(),
        });
      this.events.append(
        task,
        "agent.failed",
        { error: error instanceof Error ? error.message : "UNKNOWN_ERROR" },
        this.actor,
        c.role
      );
      throw error;
    } finally {
      closeSync(fd);
      unlinkSync(executionLock);
    }
  }
  async delegateWorkflow(task: string) {
    this.authority();
    assertLiveGate(this);
    const c = this.events.get(task).capsule;
    if (!c.parent_task_id || c.permissions !== "read-only" || c.worktree || !c.constraints.includes("CORE_UNDERSTANDING_V1")) throw new Error("READ_ONLY_WORKFLOW_REQUIRED");
    manifest(this, c.parent_task_id);
    if (!this.events.list(c.parent_task_id).some(e => e.event_type === "workflow.child.created" && e.payload.child_task === task && e.payload.capsule_hash === hash(c))) throw new Error("WORKFLOW_CHILD_NOT_AUTHORIZED");
    this.workflowGrants.set(task, hash(c));
    try { return await this.delegate(task, false); }
    finally { this.workflowGrants.delete(task); }
  }
  async delegateEngineering(task: string) {
    this.authority(); assertLiveGate(this); assertEngineeringChild(this,task);
    const c=this.events.get(task).capsule;
    this.engineeringGrants.set(task,hash(c));
    try { return await this.delegate(task,false) as AgentResult; }
    finally { this.engineeringGrants.delete(task); }
  }
  recoverWorkflowResult(task: string): AgentResult {
    this.authority();
    const c = this.events.get(task).capsule;
    if (!c.parent_task_id || c.permissions !== "read-only" || c.worktree || !(c.constraints.includes("CORE_UNDERSTANDING_V1") || c.constraints.includes("CORE_ENGINEERING_V1"))) throw new Error("READ_ONLY_WORKFLOW_REQUIRED");
    if(c.constraints.includes("CORE_ENGINEERING_V1")) assertEngineeringChild(this,task);
    manifest(this, c.parent_task_id);
    if (!this.events.list(c.parent_task_id).some(e => e.event_type === "workflow.child.created" && e.payload.child_task === task && e.payload.capsule_hash === hash(c))) throw new Error("WORKFLOW_CHILD_NOT_AUTHORIZED");
    const lock = this.storage.path("execution-" + id(task) + ".lock");
    const fd = openSync(lock, "wx", 0o600);
    try {
      const result = this.result(task);
      if (result.task_id !== task || result.role !== c.role || result.status !== "completed" || result.scope_expanded || result.changed_files.length) throw new Error("WORKFLOW_RESULT_NOT_RECOVERABLE");
      const events = this.events.list(task);
      if (events.some(e => e.event_type === "agent.completed" && e.role === c.role && e.payload.result_hash === hash(result))) return result;
      const started = events.filter(e => e.event_type === "agent.started").at(-1);
      const receipt = events.find(e => e.event_type === "agent.result.validated" && e.role === c.role &&
        e.payload.result_hash === hash(result) && e.payload.capsule_hash === hash(c) && e.payload.execution_event_id === started?.event_id);
      if (!started || !receipt) throw new Error("WORKFLOW_RESULT_VALIDATION_RECEIPT_REQUIRED");
      this.events.append(task, "agent.completed", {
        result_status: result.status, result_hash: hash(result),
        verification: "worker-claim-requires-review", recovered: true,
        validation_event_id: receipt.event_id,
      }, this.actor, c.role);
      return result;
    } finally { closeSync(fd); unlinkSync(lock); }
  }
  async smoke(provider: string, task: string, execute = false) {
    this.authority();
    const capsule = smokeCapsule(provider, id(task));
    // A provider smoke is intrinsically bound to that provider's profile.
    const route = this.router.resolve(capsule.role, provider);
    if (route.provider !== provider) throw new Error("SMOKE_ROUTE_MISMATCH");
    if (!execute) return { capsule, route, execution: "disabled; pass --execute for this fixed smoke only" };
    this.init(capsule, provider);
    this.events.append(task, "provider.smoke.authorized", { capsule_hash: hash(capsule), model_alias: route.model_alias });
    const grant = this.executionGrants.issue(capsule, capsule, route, "fixed-smoke", this.actor, "Explicit fixed provider smoke execution");
    this.events.append(task, "execution.grant.issued", { grant_hash: hash(grant), grant });
    const result = await this.delegate(task, false) as AgentResult;
    if (result.status !== "completed") throw new Error("SMOKE_NOT_COMPLETED");
    this.events.append(task, "provider.smoke.passed", { result_hash: hash(result), provider, model_alias: route.model_alias });
    return result;
  }
  // Relations the gates verify byte for byte are pinned in the wire schema so
  // the provider is constrained at inference instead of failing afterwards.
  private pinDeterministicFields(document: any, capsule: TaskCapsule): void {
    const pin = (node: any, value: string) => { node.enum = [value]; };
    pin(document.properties.task_id, capsule.task_id);
    pin(document.properties.role, capsule.role);
    document.properties.scope_expanded = { type: "boolean", const: false };
    // A read-only capsule never mutates: the runtime rejects any changed file it claims.
    if (capsule.permissions === "read-only") document.properties.changed_files.maxItems = 0;
    // Each role's gate accepts a fixed status set: reviewers publish only completed,
    // read-only producers may stop honestly, workers lose only needs_review.
    const status = document.properties.status;
    if (capsule.role === "adversarial-reviewer" || capsule.role.endsWith("-reviewer")) pin(status, "completed");
    else if (["opsx-proposer", "api-contract-architect"].includes(capsule.role)) status.enum = ["completed", "blocked", "failed"];
    else if (IMPLEMENTATION_ROLES.includes(capsule.role)) status.enum = status.enum.filter((s: string) => s !== "needs_review");
    const review = document.properties.review_result;
    if (review && capsule.parent_task_id) {
      pin(review.properties.task_id, capsule.parent_task_id);
      pin(review.properties.reviewer, capsule.task_id);
      pin(review.properties.role, capsule.role);
    }
    // Every evidence.source node of the wire is reached the way assertClosedEvidence
    // walks a result; consumers of closed evidence receive their allowlist as an enum.
    const forEachSource = (apply: (source: any) => void, node: any = document): void => {
      if (!node || typeof node !== "object") return;
      if (node.properties?.source && node.properties?.assertion) apply(node.properties.source);
      for (const value of Object.values(node)) forEachSource(apply, value);
    };
    const pinSources = (allowlist: Set<string>) => forEachSource(source => { source.enum = [...allowlist].sort(); });
    if (isFlowCapsule(capsule.constraints) && capsule.inputs.length === 1) {
      const artifacts: { output: { stage: string; content: unknown } }[] = JSON.parse(capsule.inputs[0]).artifacts;
      const allowlist = flowEvidenceAllowlistOf(artifacts.filter(a => a.output.stage === "task-sense" || a.output.stage === "discovery").map(a => a.output.content));
      // enum: [] would make every citation impossible; with nothing to cite, the only
      // satisfiable result is the honest stop the runtime accepts.
      if (allowlist.size) pinSources(allowlist);
      else { pin(status, "blocked"); document.properties.evidence.maxItems = 0; document.properties.workflow_output = { type: "null" }; }
    }
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lines = "[0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*";
    // A fixed smoke is checked by checkFileEvidence: each citation is an allowed file with line(s).
    if (capsule.constraints.includes("READ_ONLY_SMOKE")) {
      const citation = `(?:${capsule.allowed_paths.map(escape).join("|")}):${lines}`;
      forEachSource(source => { source.pattern = `^\\s*${citation}(?:\\s*;\\s*${citation})*\\s*$`; });
    }
    if (!capsule.constraints.includes("CORE_ENGINEERING_V1") || capsule.inputs.length !== 1) return;
    let pkg: any;
    try { pkg = JSON.parse(capsule.inputs[0]); } catch { return; }
    if (review && typeof pkg.subject_hash === "string") pin(review.properties.subject_hash, pkg.subject_hash);
    if (["opsx-propose-reviewer", "api-contract-frontend-reviewer", "api-contract-backend-reviewer"].includes(capsule.role)) pinSources(reviewEvidenceAllowlist(capsule));
    // The proposer and the workers gather new evidence, so their sources cannot be
    // enumerated; the wire carries the shape evidenceInScope accepts instead: an allowed
    // path (workspace-relative for the proposer, worktree-relative for workers) with
    // line(s), or a received artifact:/task: reference, several separated by ';'.
    if ((capsule.role === "opsx-proposer" && pkg.action === "proposal") || (IMPLEMENTATION_ROLES.includes(capsule.role) && pkg.action === "apply")) {
      const references = [...pkg.input_references.map((r: { child_task: string }) => `artifact:${r.child_task}`), `task:${capsule.parent_task_id}`];
      const citation = `(?:(?:${capsule.allowed_paths.map(escape).join("|")})(?:/[^:;]*)?:${lines}|${references.map(escape).join("|")})`;
      forEachSource(source => { source.pattern = `^\\s*${citation}(?:\\s*;\\s*${citation})*\\s*$`; });
    }
    // Apply review must leave no future gate; proposal review may name only the
    // API contract gate, and only for an eligible frontend/backend pair.
    if (review && pkg.action === "apply-review") review.properties.future_gates.maxItems = 0;
    if (review && pkg.action === "proposal-review") {
      if (isContractPair(pkg.proposal)) review.properties.future_gates.items.enum = ["api-contract-system"];
      else review.properties.future_gates.maxItems = 0;
    }
    const proposal = document.properties.proposal;
    if (proposal && pkg.action === "proposal" && capsule.parent_task_id) {
      const identity = pkg.proposal_identity;
      pin(proposal.properties.proposal_id, identity.proposal_id);
      pin(proposal.properties.root_task_id, identity.root_task_id);
      proposal.properties.version = { type: "integer", minimum: identity.version, maximum: identity.version };
      proposal.properties.previous_proposal_hash = identity.previous_proposal_hash === null
        ? { type: "null" } : { type: "string", enum: [identity.previous_proposal_hash] };
      const gap = pkg.artifacts.find((a: any) => a.output.stage === "gap").reference;
      const refs = proposal.properties.verified_gap_refs;
      refs.minItems = 1; refs.maxItems = 1;
      pin(refs.items.properties.child_task, gap.child_task);
      pin(refs.items.properties.content_hash, gap.content_hash);
      proposal.properties.no_op.const = gapIsEmpty(this, capsule.parent_task_id);
      proposal.properties.affected_repositories.items.enum = [...pkg.repository_scope];
      proposal.properties.implementation_units.items.properties.repository.enum = [...pkg.repository_scope];
      const scope = proposalScopePatterns(capsule.allowed_paths, pkg.repository_scope);
      proposal.properties.affected_files_or_areas.items.pattern = scope.areas;
      if (scope.units) proposal.properties.implementation_units.items.properties.allowed_paths.items.pattern = scope.units;
    }
    const contract = document.properties.api_contract;
    if (contract && pkg.action === "api-contract") {
      pin(contract.properties.contract_id, pkg.contract_identity.contract_id);
      pin(contract.properties.task_id, pkg.contract_identity.task_id);
      pin(contract.properties.version, pkg.contract_identity.version);
    }
    if (pkg.action === "apply" && capsule.owned_tests.length) {
      document.properties.tests_executed.items.properties.command.enum = [...capsule.owned_tests];
      document.properties.tests_not_executed.items.properties.command.enum = [...capsule.owned_tests];
    }
  }
  private providerSchema(capsule: TaskCapsule, provider: string): string {
    const preserved = PROVIDER_WIRE_KEYWORDS[provider] ?? new Set<string>();
    const docs: Record<string, any> = {};
    const expand = (node: any, base: string): any => {
      if (Array.isArray(node)) return node.map((n) => expand(n, base));
      if (!node || typeof node !== "object") return node;
      if (node.$ref) {
        const [file, fragment] = node.$ref.split("#");
        const target = file || base;
        docs[target] ??= JSON.parse(
          readFileSync(join(HARNESS_ROOT, "schemas", target), "utf8")
        );
        let value = docs[target];
        for (const part of (fragment ?? "").split("/").slice(1))
          value = value[part.replace(/~1/g, "/").replace(/~0/g, "~")];
        return expand(value, target);
      }
      return Object.fromEntries(
        Object.entries(node)
          .filter(([k]) => !WIRE_STRIPPED_KEYWORDS.includes(k) || preserved.has(k))
          .map(([k, v]) => [k, expand(v, base)])
      );
    };
    const document = expand(
      JSON.parse(
        readFileSync(
          join(HARNESS_ROOT, "schemas", "agent-result.schema.json"),
          "utf8"
        )
      ),
      "agent-result.schema.json"
    );
    // Canonical payloads admit null; the wire re-derives that from the role's status set below.
    for (const payload of ["proposal", "api_contract"]) document.properties[payload] = document.properties[payload].anyOf[0];
    const stage = capsule.constraints.find(c => c.startsWith("WORKFLOW_STAGE:"))?.slice("WORKFLOW_STAGE:".length) as Stage | undefined;
    if (stage && ["task-sense", "discovery", "flow", "truth", "gap"].includes(stage)) {
      const file = `workflow-${stage}.schema.json`;
      document.properties.workflow_output = expand(JSON.parse(readFileSync(join(HARNESS_ROOT, "schemas", file), "utf8")), file);
    } else delete document.properties.workflow_output;
    if(capsule.role!=="opsx-proposer") delete document.properties.proposal;
    else {
      // A provider without pattern in its wire keywords loses every canonical pattern; the
      // canonical unit id pattern must still reach it so proposals are constrained at
      // inference instead of failing the post-hoc canonical validation.
      docs["proposal.schema.json"] ??= JSON.parse(readFileSync(join(HARNESS_ROOT, "schemas", "proposal.schema.json"), "utf8"));
      document.properties.proposal.properties.implementation_units.items.properties.id.pattern = docs["proposal.schema.json"].properties.implementation_units.items.properties.id.pattern;
    }
    if(capsule.role!=="api-contract-architect") delete document.properties.api_contract;
    if(!IMPLEMENTATION_ROLES.includes(capsule.role)) delete document.properties.proposal_deviation;
    // Providers accept a strict wire subset. Canonical conditional validation
    // still runs after parsing; optional review output is role-specific.
    if (!(capsule.role === "adversarial-reviewer" || capsule.role.endsWith("-reviewer")))
      delete document.properties.review_result;
    else if(!capsule.role.startsWith("opsx-")) { delete document.properties.review_result.properties.details; delete document.properties.review_result.properties.future_gates; }
    else document.properties.review_result.properties.future_gates.items = {type:"string",enum:["api-contract-system","visual-approval-system","database-isolation","external-resource-isolation","environment-isolation"]};
    this.pinDeterministicFields(document, capsule);
    // The canonical schema requires evidence only for completed/needs_review. A role whose
    // pinned status set admits an honest stop must be able to return evidence=[] and a null
    // payload; canonical validation and the consumers still reject such a completed result.
    const honestStop = document.properties.status.enum.some((s: string) => !["completed", "needs_review"].includes(s));
    if (!honestStop) document.properties.evidence.minItems = 1;
    else for (const payload of ["workflow_output", "proposal", "api_contract"])
      if (document.properties[payload]) document.properties[payload] = { anyOf: [document.properties[payload], { type: "null" }] };
    const strictObjects = (node: any): void => {
      if (!node || typeof node !== "object") return;
      if (node.const !== undefined && node.type === undefined) node.type = typeof node.const;
      if (node.type === "object" && node.properties) node.required = Object.keys(node.properties);
      for (const value of Object.values(node)) strictObjects(value);
    };
    strictObjects(document);
    const name = "provider-agent-result-" + hash(document) + ".schema.json";
    if (!this.storage.exists(name)) {
      try {
        this.storage.create([name], document);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    if (hash(this.storage.read(name)) !== hash(document))
      throw new Error("PROVIDER_SCHEMA_HASH_MISMATCH");
    return this.storage.path(name);
  }
  verifyReview(
    review: ReviewResult,
    subjectTask: string,
    subjectHash: string
  ): void {
    validate("review-result", review);
    const reviewerTask = this.events.get(review.reviewer);
    const result = this.result(review.reviewer);
    const completion = this.events
      .list(review.reviewer)
      .some(
        (event) =>
          event.event_type === "agent.completed" &&
          event.role === review.role &&
          event.payload.result_hash === hash(result)
      );
    if (
      !completion ||
      review.reviewer === subjectTask ||
      review.task_id !== subjectTask ||
      review.subject_hash !== subjectHash ||
      reviewerTask.capsule.parent_task_id !== subjectTask ||
      reviewerTask.capsule.role !== review.role ||
      result.role !== review.role ||
      result.status !== "completed" ||
      !result.review_result ||
      hash(result.review_result) !== hash(review) ||
      !review.evidence.length
    )
      throw new Error("REVIEW_PROVENANCE_REQUIRED");
  }
  createWorktree(input: import("../worktrees/index.js").CreateWorktreeInput) {
    this.authority();
    this.router.role(input.role);
    const workspace = resolve(HARNESS_ROOT, "../..");
    if (
      !this.runtime.repositories.some(
        (r) => resolve(workspace, r) === resolve(input.repository)
      )
    )
      throw new Error("UNREGISTERED_REPOSITORY");
    return this.worktrees.create(input);
  }

  result(task: string): AgentResult {
    return validate(
      "agent-result",
      this.storage.read("results", id(task) + ".json")
    );
  }
  transition(
    task: string,
    to: TaskState,
    revision: number,
    review?: ReviewResult
  ) {
    this.authority();
    return this.storage.exclusive("control-" + id(task), () => {
      const {
        capsule,
        state,
        revision: currentRevision,
      } = this.events.get(task);
      if (currentRevision !== revision) throw new Error("STALE_TASK_REVISION");
      assertTransition(state, to);
      const engineering=hasEngineering(this,task);
      if (capsule.constraints.includes("CORE_UNDERSTANDING_ROOT_V1")) {
        if(engineering) assertEngineeringTransition(this,task,to);
        else assertWorkflowTransition(this, task, to);
      }
      // The root capsule predates the contract and remains immutable. Engineering
      // proves the lock through its architect/reviewer results and contract events.
      const gateCapsule = engineering && ["IMPLEMENTATION_RUNNING","API_CONTRACT_LOCKED","DONE"].includes(to) && isContractPair(approvedProposal(this,task).proposal.content)
        ? {...capsule,api_contract_reference:approvedContract(this,task)} : capsule;
      if (
        [
          "IMPLEMENTATION_RUNNING",
          "API_CONTRACT_LOCKED",
          "VISUAL_LOCKED",
          "DONE",
        ].includes(to)
      )
        this.prerequisites(gateCapsule);
      if (to === "API_CONTRACT_LOCKED" && !gateCapsule.api_contract_reference)
        throw new Error("API_CONTRACT_LOCK_REQUIRED");
      if (to === "VISUAL_LOCKED" && !capsule.visual_lock_reference)
        throw new Error("VISUAL_LOCK_REQUIRED");
      if (to === "DONE") {
        if(engineering) {
          if(!review || review.verdict!=="approved" || review.role!=="opsx-apply-reviewer") throw new Error("INDEPENDENT_APPLY_REVIEW_REQUIRED");
          this.verifyReview(review,task,applySubject(this,task).subject_hash);
        } else {
        const result = this.result(task);
        validate("review-result", review);
        if (
          !review ||
          review.verdict !== "approved" ||
          review.role !== "adversarial-reviewer" ||
          review.reviewer === this.actor ||
          !["completed", "needs_review"].includes(result.status)
        )
          throw new Error("INDEPENDENT_REVIEW_REQUIRED");
        this.verifyReview(review, task, hash(result));
        }
      }
      return this.events.transition(task, to, revision);
    });
  }

  createContract(value: ApiContract) {
    this.authority();
    this.events.get(value.task_id);
    const ref = this.locks.put(value);
    this.events.append(value.task_id, "contract.created", { reference: ref });
    return ref;
  }
  lockContract(
    ref: ArtifactReference,
    backend: ReviewResult,
    frontend: ReviewResult
  ) {
    this.authority();
    const lock = this.locks.lock(ref, backend, frontend, this.actor);
    this.events.append(lock.task_id, "contract.locked", { lock });
    return lock;
  }
  requestContractChange(value: ContractChange) {
    this.authority();
    this.events.get(value.task_id);
    const result = this.locks.request(value);
    this.events.append(value.task_id, "contract.change.requested", {
      request_id: value.request_id,
    });
    return result;
  }
}
