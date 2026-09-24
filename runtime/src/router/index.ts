import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_ROOT } from "../storage.js";
import { EFFORT_LEVELS, FRONTIER_ESCALATION_REASONS, MODEL_CLASSES } from "../contracts.js";
import type { FrontierEscalationReason, ModelClass, RoleDefinition, ResolvedRole, ResolvedRoute, RouteReason, RoutingSnapshot } from "../contracts.js";
// role → model class + effort has a single source shared by every profile;
// a profile only resolves each model class to one model alias.
export interface RoleRoute { model_class: string; effort: string }
export interface RoutingProfiles {
  default_profile: string;
  roles: Record<string, RoleRoute>;
  profiles: Record<string, Partial<Record<ModelClass, string>>>;
}
export type RoutingEscalations = Record<string, string>;
export function escalationsOf(snapshot: RoutingSnapshot): RoutingEscalations {
  return Object.fromEntries(Object.entries(snapshot.routes).filter(([, route]) => route.route_reason && route.route_reason !== "explicit-orchestration").map(([role, route]) => [role, route.route_reason as string]));
}
export class Router {
  readonly roles: RoleDefinition[];
  readonly models: Record<string, { provider: string; model: string }>;
  readonly providers: Record<string, { command: string; enabled: boolean }>;
  readonly profiles: RoutingProfiles;
  constructor(private readonly root = HARNESS_ROOT) {
    const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
    this.roles = read("roles/registry.json");
    this.models = read("config/models.json");
    this.providers = read("config/providers.json");
    this.profiles = read("config/routing-profiles.json");
    this.check();
  }
  check(): void {
    const names = new Set<string>();
    for (const r of this.roles) {
      if (names.has(r.role)) throw new Error("DUPLICATE_ROLE");
      names.add(r.role);
      if (!Array.isArray(r.governance) || !r.governance.length) throw new Error("ROLE_GOVERNANCE_MISSING: " + r.role);
      for (const file of r.governance)
        if (!/^[a-z0-9-]+\.md$/.test(file) || !existsSync(join(this.root, "governance", file))) throw new Error("ROLE_GOVERNANCE_UNKNOWN: " + r.role + ": " + file);
    }
    for (const role of Object.keys(this.profiles.roles)) if (!names.has(role)) throw new Error("UNKNOWN_ROLE: " + role);
    this.profile(this.profiles.default_profile);
    for (const name of Object.keys(this.profiles.profiles)) {
      for (const modelClass of Object.keys(this.profiles.profiles[name])) if (!MODEL_CLASSES.includes(modelClass as never)) throw new Error("UNKNOWN_MODEL_CLASS: " + modelClass);
      for (const modelClass of MODEL_CLASSES) this.target(name, modelClass);
      for (const role of names) this.resolve(role, name);
    }
  }
  role(name: string): RoleDefinition {
    const r = this.roles.find((r) => r.role === name);
    if (!r) throw new Error("UNKNOWN_ROLE");
    return r;
  }
  profile(name = this.profiles.default_profile): string {
    if (!this.profiles.profiles[name]) throw new Error("UNKNOWN_ROUTING_PROFILE: " + name);
    return name;
  }
  resolve(role: string, profile = this.profiles.default_profile, escalation?: string): ResolvedRole {
    this.role(role);
    const entry = this.profiles.roles[role];
    if (!entry) throw new Error("ROLE_CLASS_MISSING: " + role);
    if (Object.keys(entry).sort().join() !== "effort,model_class") throw new Error("ROLE_ROUTE_INVALID: " + role);
    const modelClass = entry.model_class as ModelClass;
    if (!MODEL_CLASSES.includes(modelClass)) throw new Error("UNKNOWN_MODEL_CLASS: " + entry.model_class);
    if (!EFFORT_LEVELS.includes(entry.effort as never)) throw new Error("INVALID_EFFORT: " + entry.effort);
    const name = this.profile(profile);
    let targetClass: ModelClass = modelClass;
    let routeReason: RouteReason | undefined = modelClass === "orchestration" ? "explicit-orchestration" : undefined;
    if (escalation !== undefined) {
      if (!FRONTIER_ESCALATION_REASONS.includes(escalation as FrontierEscalationReason)) throw new Error("UNKNOWN_ESCALATION_REASON: " + escalation);
      if (modelClass !== "reasoning" && modelClass !== "deep-reasoning") throw new Error("FRONTIER_ESCALATION_CLASS_DENIED: " + role);
      targetClass = "orchestration";
      routeReason = escalation as FrontierEscalationReason;
    }
    const { alias, provider, model } = this.target(name, targetClass);
    return this.materialize(role, { provider, model_class: modelClass, model_alias: alias, model, effort: entry.effort as ResolvedRoute["effort"], ...(routeReason ? { route_reason: routeReason } : {}) });
  }
  private target(profile: string, modelClass: ModelClass): { alias: string; provider: string; model: string } {
    const alias = this.profiles.profiles[profile][modelClass];
    if (!alias) throw new Error("MODEL_CLASS_UNRESOLVED: " + profile + "/" + modelClass);
    const m = this.models[alias];
    if (!m) throw new Error("UNKNOWN_MODEL_ALIAS");
    if (!this.providers[m.provider]?.enabled) throw new Error("INVALID_PROVIDER_ROUTE");
    // The frontier model is never a default: other classes reach it only through an explicit escalation.
    if (modelClass !== "orchestration" && (alias === this.profiles.profiles[profile].orchestration || /fable/i.test(alias + " " + m.model)))
      throw new Error("FRONTIER_AS_DEFAULT_FORBIDDEN: " + profile + "/" + modelClass);
    return { alias, ...m };
  }
  materialize(role: string, route: ResolvedRoute): ResolvedRole {
    return { role: this.role(role), provider_command: this.providers[route.provider]?.command, ...route };
  }
  snapshot(rootTaskId: string, profile = this.profiles.default_profile, escalations: RoutingEscalations = {}): RoutingSnapshot {
    const name = this.profile(profile);
    for (const role of Object.keys(escalations)) this.role(role);
    const routes = Object.fromEntries(this.roles.map((r) => {
      const { provider, model_class, model_alias, model, effort, route_reason } = this.resolve(r.role, name, escalations[r.role]);
      return [r.role, { provider, model_class, model_alias, model, effort, ...(route_reason ? { route_reason } : {}) }];
    }));
    return { version: 1, root_task_id: rootTaskId, profile: name, resolved_at: new Date().toISOString(), routes };
  }
}
