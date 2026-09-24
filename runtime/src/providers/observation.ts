import { createHash } from "node:crypto";
import type { ProcessRequest, ProcessResult } from "../contracts.js";

// Retain behavior and diagnostics, never environment variables or credentials.
export function observeProcess(request: ProcessRequest, result: ProcessResult, elapsed_ms: number) {
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const redact = (text: string) => text
    .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/\b(token|api[_-]?key|password|secret|authorization)\b(["'\s]*[:=]["'\s]*)[^\s,}"']+/gi, "$1$2[REDACTED]");
  const types: string[] = [], errors: string[] = [];
  let envelope: Record<string, unknown> = {};
  const toolCalls: { type: string; command: string }[] = [];
  let usage: unknown = null;
  const itemTypes: string[] = [];
  for (const line of result.stdout.split("\n").filter(Boolean)) {
    try {
      const value = JSON.parse(line);
      if (value.type) types.push(value.type);
      if (value.item?.type) itemTypes.push(value.item.type);
      if (value.type === "turn.completed") usage = value.usage ?? null;
      if (value.type === "item.completed" && value.item?.type === "command_execution") toolCalls.push({ type: value.item.type, command: redact(value.item.command ?? "") });
      if (value.type === "error" && typeof value.message === "string") errors.push(redact(value.message));
      if (value.is_error && typeof value.result === "string") errors.push(redact(value.result));
      if (value.type === "result") envelope = {
        type: value.type, subtype: value.subtype, is_error: value.is_error,
        structured_output_present: value.structured_output != null,
        usage: value.usage, modelUsage: value.modelUsage,
      };
    } catch { /* only byte count/hash retained for non-JSON stdout */ }
  }
  // Only a real provider process reaches here; replayed checkpoints record false, and older observations lack the field.
  return {
    provider_invoked: true,
    command: request.command, args: request.args, cwd: request.cwd,
    timeout_ms: request.timeout_ms, elapsed_ms, exit_code: result.exit_code, signal: result.signal,
    prompt_bytes: Buffer.byteLength(request.stdin), prompt_hash: digest(request.stdin),
    stdout_bytes: Buffer.byteLength(result.stdout), stdout_hash: digest(result.stdout), stdout_types: types,
    stderr_bytes: Buffer.byteLength(result.stderr), stderr_hash: digest(result.stderr),
    stderr: redact(result.stderr).slice(0, 8000), errors, envelope, tool_calls: toolCalls, usage, item_types: [...new Set(itemTypes)],
  };
}
