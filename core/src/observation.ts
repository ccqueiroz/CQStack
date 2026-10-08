import { createHash } from "node:crypto";
import { ID_PATTERN, StateError, asWritten } from "./storage.js";

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
  processRequest: ObservedRequest,
  processResult: ProcessOutcome,
  elapsedMs: number,
): Observation {
  const { root_id, item_id } = attribution ?? {};
  const isId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value);
  if (!isId(root_id) || (item_id !== undefined && !isId(item_id)))
    throw new StateError(
      "OBSERVATION_ATTRIBUTION_INVALID",
      "Observation needs the root_id of its root and, when given, a valid item_id",
    );
  // each field is read from the caller once and kept as its JSON text carries it (none: undefined, refused below), so a getter or a
  // toJSON cannot pass the checks and then give the sizes, hashes, redaction and record another value
  const request = asWritten({
    command: processRequest?.command,
    stdin: processRequest?.stdin,
    timeout_ms: processRequest?.timeout_ms,
  }) as ObservedRequest;
  const result = asWritten({
    exit_code: processResult?.exit_code,
    stdout: processResult?.stdout,
    stderr: processResult?.stderr,
    signal: processResult?.signal,
  }) as ProcessOutcome;
  const isText = (value: unknown) => typeof value === "string";
  // finite only: NaN and the infinities serialize as null, and an infinite exit_code would read as the legitimate null
  const isNumber = (value: unknown) => Number.isFinite(value);
  // the copies are written, hashed or redacted as they are: another type would skip the redaction or the record's shape
  if (
    !isText(request?.command) || !isText(request.stdin) || !isNumber(request.timeout_ms) || !isNumber(elapsedMs) ||
    !isText(result?.stdout) || !isText(result.stderr) || !(isNumber(result.exit_code) || result.exit_code === null) ||
    !(isText(result.signal) || result.signal === null)
  )
    throw new StateError("OBSERVATION_INPUT_INVALID", "Observation needs a process request and outcome with the documented field types");
  const errors: string[] = [];
  const tool_calls: string[] = [];
  for (const line of result.stdout.split("\n")) {
    try {
      const value = JSON.parse(line);
      if (value.type === "error" && typeof value.message === "string") errors.push(redact(value.message));
      if (value.is_error && typeof value.result === "string") errors.push(redact(value.result));
      if (value.type === "item.completed" && value.item?.type === "command_execution" && typeof value.item.command === "string")
        tool_calls.push(redact(value.item.command));
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
    // cut before redacting, so the marker is never cut; a key the cut splits had its value past the cut, which is dropped
    stderr: redact(result.stderr.slice(0, 8000)),
    errors,
    tool_calls,
  };
}
