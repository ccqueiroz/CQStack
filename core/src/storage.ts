import { createHash } from "node:crypto";
import { appendFileSync, closeSync, fsyncSync, lstatSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type StateErrorCode =
  | "STATE_DIR_INVALID"
  | "ROOT_ID_INVALID"
  | "SYMLINK_REJECTED"
  | "ROOT_NOT_FOUND"
  | "ROOT_EXISTS"
  | "ROOT_LOCKED"
  | "LOG_TRUNCATED"
  | "LOG_LINE_INVALID"
  | "GRAPH_MISSING"
  | "GRAPH_MISMATCH"
  | "GRAPH_TRACK_INVALID"
  | "TRANSITION_NOT_IN_GRAPH"
  | "REVISION_STALE"
  | "ACTOR_REQUIRED"
  | "ACTOR_KIND_MISMATCH"
  | "ACTOR_ID_INVALID"
  | "EVENT_SCHEMA_VIOLATION"
  | "OBSERVATION_ATTRIBUTION_INVALID"
  | "OBSERVATION_INPUT_INVALID"
  | "HARNESS_VERSION_UNAVAILABLE";

// Ids become file names: lowercase only, so two ids never share a file on a case-insensitive disk.
export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class StateError extends Error {
  readonly code: StateErrorCode;

  constructor(code: StateErrorCode, message: string) {
    super(message);
    this.name = "StateError";
    this.code = code;
  }
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function assertNoSymlinks(path: string): void {
  for (let current = resolve(path); ; current = dirname(current)) {
    let isLink = false;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    if (isLink) throw new StateError("SYMLINK_REJECTED", `Symbolic link in the state path: ${current}`);
    if (dirname(current) === current) return;
  }
}

export function appendLine(file: string, line: string): void {
  const descriptor = openSync(file, "a", 0o600);
  try {
    appendFileSync(descriptor, line + "\n");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function withMutex<T>(lockFile: string, run: () => T): T {
  let descriptor: number;
  try {
    descriptor = openSync(lockFile, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new StateError("ROOT_LOCKED", `Root is locked by another write: ${lockFile}`);
    throw error;
  }
  try {
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }));
    return run();
  } finally {
    closeSync(descriptor);
    unlinkSync(lockFile);
  }
}
