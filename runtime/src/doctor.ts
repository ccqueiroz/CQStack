import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HARNESS_ROOT, Storage } from "./storage.js";
import { Router } from "./router/index.js";
import { SchemaValidator } from "./validation/index.js";
import { WorktreeManager } from "./worktrees/index.js";
export interface DoctorCheck {
  name: string;
  status: "PASS" | "PARTIAL";
  detail: unknown;
}
export function doctor(): {
  checks: DoctorCheck[];
  status: "PASS" | "PARTIAL";
} {
  const checks: DoctorCheck[] = [];
  const check = (name: string, fn: () => unknown) => {
    try {
      checks.push({ name, status: "PASS", detail: fn() });
    } catch (error) {
      checks.push({
        name,
        status: "PARTIAL",
        detail: error instanceof Error ? error.message : "check failed",
      });
    }
  };
  check("node", () => {
    if (Number(process.versions.node.split(".")[0]) < 20)
      throw new Error("Node >=20 required");
    return process.version;
  });
  for (const cli of ["npm", "git", "claude", "codex"])
    check(cli, () =>
      execFileSync(cli, ["--version"], {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim()
    );
  check("harness-config", () => {
    const router = new Router();
    const runtime = JSON.parse(
      readFileSync(join(HARNESS_ROOT, "config/runtime.json"), "utf8")
    );
    if (
      typeof runtime.model_execution_enabled !== "boolean" ||
      !Number.isInteger(runtime.timeout_ms) ||
      runtime.timeout_ms <= 0 ||
      !Array.isArray(runtime.repositories) ||
      runtime.state_directory !== "state"
    )
      throw new Error("INVALID_RUNTIME_CONFIG");
    return {
      roles: router.roles.length,
      routing_profiles: Object.keys(router.profiles.profiles),
      default_routing_profile: router.profiles.default_profile,
      execution_enabled: runtime.model_execution_enabled,
    };
  });
  check("schemas", () => {
    new SchemaValidator(join(HARNESS_ROOT, "schemas"));
    return "All canonical schemas compiled with references resolved";
  });
  const state = resolve(
    process.env.CARTERA_HARNESS_STATE ?? join(HARNESS_ROOT, "state")
  );
  check("runtime-state", () => {
    new Storage(state);
    accessSync(state, constants.R_OK | constants.W_OK);
    return { path: state, write_access: true };
  });
  for (const repository of ["cartera-backend", "cartera-frontend"])
    check("repository:" + repository, () => {
      const info = new WorktreeManager(new Storage(state)).inspect(
        resolve(HARNESS_ROOT, "../..", repository)
      );
      return {
        repository: info.repository,
        branch: info.branch,
        HEAD: info.HEAD,
        dirty_files: info.dirty_files.length,
        untracked_files: info.untracked_files.length,
        deleted_files: info.deleted_files.length,
      };
    });
  check("mcp-configuration", () => {
    const path = resolve(HARNESS_ROOT, "../../.mcp.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    accessSync(path, constants.R_OK | constants.W_OK);
    if (!config.mcpServers || typeof config.mcpServers !== "object")
      throw new Error("INVALID_MCP_CONFIG");
    return {
      path,
      configured_servers: Object.keys(config.mcpServers),
      local_stdio: "supported",
      note: "No server authentication or model execution tested",
    };
  });
  return {
    checks,
    status: checks.every((c) => c.status === "PASS") ? "PASS" : "PARTIAL",
  };
}
