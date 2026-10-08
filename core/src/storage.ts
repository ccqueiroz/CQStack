import { createHash } from "node:crypto";
import { appendFileSync, closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
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

// The value as its JSON line carries it, or undefined when it has none: a bigint, a cycle, a toJSON that throws or gives undefined
// (JSON.parse of undefined throws), or a value JSON would turn into null or drop (a number that is not finite, a function, a symbol),
// so NaN never becomes the legitimate null. Checks read this copy: an inherited field or a toJSON cannot pass them and then change the line.
export function asWritten(value: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, item: unknown) => {
        if ((typeof item === "number" && !Number.isFinite(item)) || typeof item === "function" || typeof item === "symbol")
          throw new TypeError("no JSON text");
        return item;
      }),
    );
  } catch {
    return undefined;
  }
}

// After this walk no other user can change the path (as OpenSSH StrictModes): no component is a symbolic link, every component
// above the file is a folder, and every folder belongs to the user or root and is not writable by group or others. A folder others
// may write passes only with the sticky bit (others cannot rename or remove a name that is not theirs) and only when the next
// component down is an existing folder: others can still create a missing name there, and the names in the state directory itself
// are its log and lock files.
// Without process.getuid (Windows) only the link check runs.
export function assertTrustedPath(path: string): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const file = resolve(path);
  let below: Stats | undefined;
  for (let current = file; ; current = dirname(current)) {
    let stats: Stats | undefined;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    if (stats?.isSymbolicLink()) throw new StateError("SYMLINK_REJECTED", `Symbolic link in the state path: ${current}`);
    if (stats !== undefined && !stats.isDirectory() && current !== file)
      throw new StateError("STATE_DIR_INVALID", `State path component is not a folder: ${current}`);
    if (stats?.isDirectory() && uid !== undefined) {
      const othersMayWrite = (stats.mode & 0o022) !== 0;
      const stickyProtects = (stats.mode & 0o1000) !== 0 && below?.isDirectory() === true;
      if ((stats.uid !== uid && stats.uid !== 0) || (othersMayWrite && !stickyProtects))
        throw new StateError(
          "STATE_DIR_INVALID",
          `Folder in the state path must belong to the user or root and not be writable by group or others: ${current}`,
        );
    }
    below = stats;
    if (dirname(current) === current) return;
  }
}

// O_NOFOLLOW makes the open itself refuse a link put in place of the file after assertTrustedPath looked (0 where the system has
// none); the link error is ELOOP, or EMLINK on FreeBSD.
function openNoFollow(file: string, flags: number, mode?: number): number {
  try {
    return openSync(file, flags | (constants.O_NOFOLLOW ?? 0), mode);
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? ""))
      throw new StateError("SYMLINK_REJECTED", `Symbolic link in the state path: ${file}`);
    throw error;
  }
}

export function readText(file: string): string {
  const descriptor = openNoFollow(file, constants.O_RDONLY);
  try {
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

export function appendLine(file: string, line: string): void {
  const descriptor = openNoFollow(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
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
