import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AgentExecutionRequest,
  AgentProvider,
  ProcessRunner,
} from "../contracts.js";
import { runProcess } from "../processes/run.js";
import { parseAgentResult } from "../validation/index.js";
import { observeProcess } from "./observation.js";
import { isFlowCapsule } from "../workflow/producers/flow.js";

export class ClaudeProvider implements AgentProvider {
  constructor(private readonly runner: ProcessRunner = runProcess) {}

  async execute(request: AgentExecutionRequest) {
    const permission = request.capsule.permissions;
    if (permission !== "read-only" && permission !== "restricted-path-write")
      throw unsupportedPermission(permission);
    const writable = permission === "restricted-path-write";
    if (writable) assertOwnedWorktree(request);
    const master = request.capsule.role === "master-orchestrator";
    // Flow and the proposal/API contract reviewers only synthesize or review supplied
    // validated inputs, so they receive no read tools and cannot redo Discovery.
    const synthesisOnly = isFlowCapsule(request.capsule.constraints) || ["opsx-propose-reviewer", "api-contract-frontend-reviewer", "api-contract-backend-reviewer"].includes(request.capsule.role);
    const schema = await readFile(request.result_schema_path, "utf8");
    try {
      const started = Date.now();
      const processRequest = {
        command: request.route.provider_command ?? "claude",
        cwd: request.cwd,
        stdin: request.prompt,
        timeout_ms: request.timeout_ms,
        signal: request.signal,
        args: [
          "-p",
          "--model",
          request.route.model,
          ...(request.route.effort ? ["--effort", request.route.effort] : []),
          "--output-format",
          "json",
          "--json-schema",
          schema,
          "--permission-mode",
          writable ? "acceptEdits" : "dontAsk",
          "--permission-prompts",
          "none",
          "--no-session-persistence",
          ...(master ? [] : ["--safe-mode", "--restricted"]),
          "--strict-mcp-config",
          "--mcp-config",
          master
            ? JSON.stringify({mcpServers:{cartera:{command:process.execPath,args:[`${process.cwd()}/dist/mcp/server.js`]}}})
            : '{"mcpServers":{}}',
          "--tools",
          master || synthesisOnly ? "" : writable ? "Read,Grep,Glob,Edit,Write" : "Read,Grep,Glob",
          // No shell for workers: the harness runs the owned tests itself after the worker returns.
          "--add-dir",
          request.cwd,
        ],
      };
      const result = await this.runner(processRequest);
      request.observe?.(observeProcess(processRequest, result, Date.now() - started));
      const envelope = parseEnvelope(result.stdout);
      // An error envelope is a provider failure even when it also carries structured output.
      if (envelope?.is_error) throw errorEnvelope(envelope);
      if (result.exit_code !== 0)
        throw providerFailure("claude", result.exit_code, result.signal);
      return parseAgentResult(envelope ? structuredOutput(envelope) : result.stdout);
    } finally {
      /* no provider-owned files */
    }
  }
}

function assertOwnedWorktree(request: AgentExecutionRequest): void {
  const { capsule, cwd } = request;
  const worktree = capsule.worktree;
  if (
    !worktree ||
    worktree.task_id !== capsule.task_id ||
    worktree.role !== capsule.role ||
    resolve(cwd) !== resolve(worktree.path)
  ) {
    const error = new Error("OWNED_WORKTREE_REQUIRED");
    error.name = "OWNED_WORKTREE_REQUIRED";
    throw error;
  }
}
function unsupportedPermission(permission: string): Error {
  const error = new Error(`UNSUPPORTED_PERMISSION: ${permission}`);
  error.name = "UNSUPPORTED_PERMISSION";
  return error;
}
function providerFailure(
  provider: string,
  code: number | null,
  signal: string | null
): Error {
  return new Error(
    `${provider} exited unsuccessfully (${code ?? signal ?? "unknown"})`
  );
}
function parseEnvelope(text: string): Record<string, unknown> | null {
  try {
    const envelope = JSON.parse(text) as unknown;
    return envelope && typeof envelope === "object" && !Array.isArray(envelope) ? envelope as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
function errorEnvelope(envelope: Record<string, unknown>): Error {
  const detail = [envelope.subtype, typeof envelope.result === "string" ? envelope.result.slice(0, 500) : null]
    .filter(part => part !== undefined && part !== null && part !== "").join(": ");
  const error = new Error(`CLAUDE_ERROR_ENVELOPE${detail ? ": " + detail : ""}`);
  error.name = "CLAUDE_ERROR_ENVELOPE";
  return error;
}
function structuredOutput(envelope: Record<string, unknown>): string {
  const structured = envelope.structured_output ?? envelope.structuredOutput;
  if (typeof structured === "string") return structured;
  if (structured && typeof structured === "object") return JSON.stringify(structured);
  if (typeof envelope.result === "string") return envelope.result;
  return JSON.stringify(structured ?? envelope.result ?? envelope);
}
