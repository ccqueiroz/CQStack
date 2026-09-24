import type { Permission, ResolvedRole, RoutingSnapshot, TaskCapsule } from "../contracts.js";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Storage, hash, id, HARNESS_ROOT, scopePath, within } from "../storage.js";
import { smokeCapsule } from "../providers/smoke.js";
import { EventStore } from "../events/index.js";

export type GrantMode = "fixed-smoke" | "read-only-harness" | "orchestrated-read-only-diagnosis";
export type IssueMode = GrantMode | "maintenance-write";
export interface ExecutionGrant {
  version: 1;
  root_task_id: string;
  root_capsule_hash: string;
  child_task_id: string;
  capsule_hash: string;
  role: string;
  provider: string;
  model_alias: string;
  model: string;
  route_hash: string;
  permission_ceiling: Permission;
  execution_mode: GrantMode;
  maintenance_write?: true;
  issuer: string;
  reason: string;
  issued_at: string;
  usage_state: "available";
}

function binding(c: TaskCapsule, root: TaskCapsule, route: ResolvedRole, mode: GrantMode, maintenanceWrite = false) {
  return {
    root_task_id: root.task_id, root_capsule_hash: hash(root),
    child_task_id: c.task_id, capsule_hash: hash(c), role: c.role,
    provider: route.provider, model_alias: route.model_alias, model: route.model,
    route_hash: hash(route), permission_ceiling: c.permissions, execution_mode: mode,
    ...(maintenanceWrite ? { maintenance_write: true as const } : {}),
  };
}

export function isInternalMaintenanceCapsule(c: TaskCapsule): boolean {
  return c.constraints.includes("CORE_INTERNAL_MAINTENANCE_V1");
}

function assertRootRoute(storage: Storage, root: TaskCapsule, c: TaskCapsule, route: ResolvedRole): void {
  const file = id(root.task_id) + ".json";
  if (!storage.exists("routing", file)) throw new Error("ROUTING_SNAPSHOT_REQUIRED: " + root.task_id);
  const persisted = storage.read<RoutingSnapshot>("routing", file).routes[c.role];
  if (!persisted || persisted.provider !== route.provider || persisted.model_alias !== route.model_alias ||
      persisted.model !== route.model || persisted.effort !== route.effort)
    throw new Error("EXECUTION_GRANT_ROUTE_MISMATCH");
}

function assertPolicy(storage: Storage, c: TaskCapsule, root: TaskCapsule, route: ResolvedRole, mode: IssueMode, issuer: string, modelExecutionEnabled: () => boolean): void {
  if (route.role.role !== c.role)
    throw new Error("EXECUTION_GRANT_ROLE_MISMATCH");
  // Grants pin the route resolved once for the root task; a live re-resolution never widens them.
  assertRootRoute(storage, root, c, route);
  if (mode !== "maintenance-write" && (c.permissions !== "read-only" || c.worktree))
    throw new Error("EXECUTION_GRANT_READ_ONLY_REQUIRED");
  if (mode === "fixed-smoke") {
    if (hash(c) !== hash(smokeCapsule(route.provider, c.task_id)) || hash(root) !== hash(c))
      throw new Error("EXECUTION_GRANT_SMOKE_MISMATCH");
  } else if (mode === "read-only-harness") {
    if (c.parent_task_id !== root.task_id || root.parent_task_id ||
        !["mechanical-worker", "discovery-tests"].includes(c.role) ||
        c.allowed_paths.length !== 1 || c.allowed_paths[0] !== ".cartera/harness/README.md" ||
        c.required_context.some(p => p !== ".cartera/harness/README.md") ||
        c.owned_tests.length || c.api_contract_reference || c.visual_lock_reference)
      throw new Error("EXECUTION_GRANT_HANDOFF_SCOPE_REQUIRED");
  } else if (mode === "orchestrated-read-only-diagnosis") {
    if (issuer !== "trusted-operator-cli" || modelExecutionEnabled() !== false)
      throw new Error("EXECUTION_GRANT_DIAGNOSIS_OPERATOR_REQUIRED");
    // Eligibility is role-based; the immutable grant separately pins the entire
    // resolved route. Other read-only roles do not inherit diagnosis authority.
    if (c.parent_task_id !== root.task_id || root.parent_task_id !== null ||
        root.role !== "master-orchestrator" || root.permissions !== "read-only" || root.worktree !== null ||
        c.worktree !== null || c.role !== "truth" || route.role.mutation_permission !== "read-only" ||
        route.role.allowed_capabilities.some(cap => !["read", "return-result"].includes(cap)) ||
        c.owned_tests.length || c.api_contract_reference !== null || c.visual_lock_reference !== null)
      throw new Error("EXECUTION_GRANT_DIAGNOSIS_SCOPE_REQUIRED");
    const workspace = resolve(HARNESS_ROOT, "../..");
    const forbidden = c.forbidden_paths.map(p => scopePath(workspace, p));
    const allowed = c.allowed_paths.map(p => {
      const path = scopePath(workspace, p);
      if (!within(HARNESS_ROOT, path) || path === HARNESS_ROOT || p.split("/").includes(".git") ||
          forbidden.some(f => within(f, path))) throw new Error("EXECUTION_GRANT_DIAGNOSIS_PATH_REQUIRED");
      return path;
    });
    if (!allowed.length) throw new Error("EXECUTION_GRANT_DIAGNOSIS_PATH_REQUIRED");
    for (const p of c.required_context) {
      const path = scopePath(workspace, p);
      if (p.split("/").includes(".git") || !allowed.some(a => within(a, path)) || forbidden.some(f => within(f, path)))
        throw new Error("EXECUTION_GRANT_DIAGNOSIS_CONTEXT_REQUIRED");
    }
  } else if (mode === "maintenance-write") {
    if (issuer !== "trusted-operator-cli" || modelExecutionEnabled() !== false ||
        c.parent_task_id !== root.task_id || c.permissions !== "restricted-path-write" ||
        c.worktree !== null || c.role !== "opsx-implementation-worker" ||
        route.role.mutation_permission !== "restricted-path-write" ||
        !isInternalMaintenanceCapsule(c) || c.api_contract_reference !== null ||
        c.visual_lock_reference !== null || !c.allowed_paths.length)
      throw new Error("EXECUTION_GRANT_MAINTENANCE_SCOPE_REQUIRED");
    const workspace = resolve(HARNESS_ROOT, "../..");
    const forbidden = c.forbidden_paths.map(p => scopePath(workspace, p));
    for (const p of c.allowed_paths) {
      const path = scopePath(workspace, p);
      if (!within(HARNESS_ROOT, path) || path === HARNESS_ROOT ||
          p.split("/").includes(".git") || within(join(HARNESS_ROOT, "state"), path) ||
          forbidden.some(f => within(f, path)))
        throw new Error("EXECUTION_GRANT_MAINTENANCE_PATH_REQUIRED");
    }
    for (const p of c.required_context) {
      const path = scopePath(workspace, p);
      if (!within(HARNESS_ROOT, path) || !c.allowed_paths.some(a => within(scopePath(workspace, a), path)) || forbidden.some(f => within(f, path)))
        throw new Error("EXECUTION_GRANT_MAINTENANCE_CONTEXT_REQUIRED");
    }
  } else throw new Error("EXECUTION_GRANT_MODE_INVALID");
}

// Trusted local bootstrap API, deliberately absent from the MCP tool surface.
// This generalizes the fixed smoke exception; it does not execute providers.
export class ExecutionGrants {
  constructor(
    readonly storage: Storage,
    private readonly modelExecutionEnabled: () => boolean = () => JSON.parse(readFileSync(join(HARNESS_ROOT, "config/runtime.json"), "utf8")).model_execution_enabled,
  ) {}

  assertMaintenanceScope(c: TaskCapsule, root: TaskCapsule, route: ResolvedRole, issuer: string): void {
    assertPolicy(this.storage, c, root, route, "maintenance-write", issuer, this.modelExecutionEnabled);
  }

  issue(c: TaskCapsule, root: TaskCapsule, route: ResolvedRole, mode: IssueMode, issuer: string, reason: string): ExecutionGrant {
    assertPolicy(this.storage, c, root, route, mode, issuer, this.modelExecutionEnabled);
    if (!issuer.trim() || !reason.trim()) throw new Error("EXECUTION_GRANT_ISSUER_REASON_REQUIRED");
    const maintenanceWrite = mode === "maintenance-write";
    if (maintenanceWrite) {
      const record = new EventStore(this.storage).get(c.task_id);
      if (record.state !== "IMPLEMENTATION_RUNNING") throw new Error("IMPLEMENTATION_STATE_REQUIRED");
      if (hash(record.capsule) !== hash(c)) throw new Error("EXECUTION_GRANT_CAPSULE_HASH_MISMATCH");
    }
    const effectiveMode: GrantMode = maintenanceWrite ? "orchestrated-read-only-diagnosis" : mode;
    const grant: ExecutionGrant = {
      version: 1, ...binding(c, root, route, effectiveMode, maintenanceWrite), permission_ceiling: c.permissions,
      issuer, reason, issued_at: new Date().toISOString(), usage_state: "available",
    };
    // Immutable child key also prevents issuing a replacement grant after use.
    this.storage.create(["execution-grants", id(c.task_id) + ".json"], grant);
    return grant;
  }

  eligible(c: TaskCapsule, root: TaskCapsule, route: ResolvedRole): ExecutionGrant | null {
    const file = id(c.task_id) + ".json";
    if (!this.storage.exists("execution-grants", file)) return null;
    const grant = this.storage.read<ExecutionGrant>("execution-grants", file);
    const deny = (reason: string): never => { throw new Error("MODEL_EXECUTION_DISABLED: EXECUTION_GRANT_" + reason); };
    if (this.storage.exists("execution-grant-consumptions", file)) deny("CONSUMED");
    if (grant.version !== 1 || grant.usage_state !== "available" ||
        typeof grant.issuer !== "string" || !grant.issuer.trim() ||
        typeof grant.reason !== "string" || !grant.reason.trim() || !Number.isFinite(Date.parse(grant.issued_at))) deny("INVALID");
    const maintenanceWrite = grant.maintenance_write === true;
    if (maintenanceWrite && grant.execution_mode !== "orchestrated-read-only-diagnosis") deny("MODE_INVALID");
    const expected = binding(c, root, route, grant.execution_mode, maintenanceWrite);
    for (const key of Object.keys(expected) as Array<keyof typeof expected>)
      if (grant[key] !== expected[key]) deny("BINDING_MISMATCH");
    assertPolicy(this.storage, c, root, route, maintenanceWrite ? "maintenance-write" : grant.execution_mode, grant.issuer, this.modelExecutionEnabled);
    return grant;
  }

  consume(c: TaskCapsule, root: TaskCapsule, route: ResolvedRole, expected: ExecutionGrant) {
    const current = this.eligible(c, root, route);
    if (!current || hash(current) !== hash(expected)) throw new Error("EXECUTION_GRANT_CHANGED");
    const receipt = {
      child_task_id: c.task_id, root_task_id: root.task_id, grant_hash: hash(current),
      usage_state: "consumed", consumed_at: new Date().toISOString(),
    };
    // Exclusive create + fsync: cross-process, fail closed on crash or provider failure.
    this.storage.create(["execution-grant-consumptions", id(c.task_id) + ".json"], receipt);
    return receipt;
  }
}
