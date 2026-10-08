import { createHash } from "node:crypto";
import { ID_PATTERN, StateError } from "./storage.js";

export interface ObservedRequest {
  command: string;
  stdin: string;
  timeout_ms: number;
}

export interface ProcessOutcome {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  signal: string | null;
}

export interface Observation {
  root_id: string;
  item_id?: string;
  command: string;
  timeout_ms: number;
  elapsed_ms: number;
  exit_code: number | null;
  signal: string | null;
  prompt_bytes: number;
  prompt_hash: string;
  stdout_bytes: number;
  stdout_hash: string;
  stderr_bytes: number;
  stderr_hash: string;
  stderr: string;
  errors: string[];
  tool_calls: string[];
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

// The keys and prefixes of the previous observeProcess, plus "Basic", also inside a longer name. Everything after the first one
// is replaced: with no rule about where a value ends, no piece of it can be left on any line.
const SECRET_START = /token|api[_-]?key|password|secret|authorization|Bearer|Basic|sk-/i;

const redact = (text: string) => {
  const found = SECRET_START.exec(text);
  return found === null ? text : text.slice(0, found.index + found[0].length) + "[REDACTED]";
};

export function observeProcess(
  attribution: { root_id?: string; item_id?: string },
  request: ObservedRequest,
  result: ProcessOutcome,
  elapsedMs: number,
): Observation {
  const { root_id, item_id } = attribution ?? {};
  const isId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value);
  if (!isId(root_id) || (item_id !== undefined && !isId(item_id)))
    throw new StateError(
      "OBSERVATION_ATTRIBUTION_INVALID",
      "Observation needs the root_id of its root and, when given, a valid item_id",
    );
  const errors: string[] = [];
  const tool_calls: string[] = [];
  for (const line of result.stdout.split("\n")) {
    try {
      const value = JSON.parse(line);
      if (value.type === "error" && typeof value.message === "string") errors.push(redact(value.message));
      if (value.is_error && typeof value.result === "string") errors.push(redact(value.result));
      if (value.type === "item.completed" && value.item?.type === "command_execution") tool_calls.push(redact(value.item.command ?? ""));
    } catch {
      // a line that is not a JSON object keeps only its share of the stdout byte count and hash
    }
  }
  return {
    root_id,
    ...(item_id === undefined ? {} : { item_id }),
    command: request.command,
    timeout_ms: request.timeout_ms,
    elapsed_ms: elapsedMs,
    exit_code: result.exit_code,
    signal: result.signal,
    prompt_bytes: Buffer.byteLength(request.stdin),
    prompt_hash: digest(request.stdin),
    stdout_bytes: Buffer.byteLength(result.stdout),
    stdout_hash: digest(result.stdout),
    stderr_bytes: Buffer.byteLength(result.stderr),
    stderr_hash: digest(result.stderr),
    // redact before cutting, so the cut never leaves half a secret out of reach of the patterns
    stderr: redact(result.stderr).slice(0, 8000),
    errors,
    tool_calls,
  };
}
