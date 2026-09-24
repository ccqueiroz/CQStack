import type { ExecutionGrant, GrantMode } from "./grants.js";

// Trusted runtime policy, not capsule input or MCP configuration. The AgentBus
// calls this only after exact grant validation and durable one-shot consumption.
const GRANT_TIMEOUT_CEILINGS_MS: Readonly<Record<GrantMode, number>> = Object.freeze({
  "fixed-smoke": 90000,
  "read-only-harness": 90000,
  "orchestrated-read-only-diagnosis": 300000,
});

export function executionGrantTimeout(runtimeTimeout: number, grant: ExecutionGrant): number {
  const ceiling = GRANT_TIMEOUT_CEILINGS_MS[grant.execution_mode];
  if (!Number.isFinite(ceiling) || !Number.isFinite(runtimeTimeout) || runtimeTimeout <= 0)
    throw new Error("INVALID_EXECUTION_TIMEOUT_POLICY");
  return Math.min(runtimeTimeout, ceiling);
}
