import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  lstatSync,
  realpathSync,
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
  appendFileSync,
} from "node:fs";
import { resolve, join, relative, isAbsolute, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
function findRoot(): string {
  let p = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++, p = dirname(p)) {
    if (
      existsSync(join(p, "schemas/agent-result.schema.json")) &&
      existsSync(join(p, "config/runtime.json"))
    )
      return p;
  }
  throw new Error("HARNESS_ROOT_NOT_FOUND");
}
export const HARNESS_ROOT = findRoot();
export function id(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value))
    throw new Error("INVALID_ID");
  return value;
}
export function within(root: string, path: string): boolean {
  const r = relative(root, path);
  return r === "" || (r.split(sep)[0] !== ".." && !isAbsolute(r));
}
export function noSymlinks(path: string): string {
  const absolute = resolve(path);
  let p = absolute;
  for (;;) {
    try {
      if (lstatSync(p).isSymbolicLink())
        throw new Error("SYMLINK_PATH_REJECTED");
    } catch (error) {
      if (
        !["ENOENT", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? ""
        )
      )
        throw error;
    }
    const parent = dirname(p);
    if (parent === p) break;
    p = parent;
  }
  return absolute;
}
export function scopePath(root: string, path: string): string {
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").includes("..") ||
    path.includes("\0")
  )
    throw new Error("INVALID_SCOPE_PATH");
  const p = resolve(root, path);
  if (!within(root, p)) throw new Error("SCOPE_VIOLATION");
  noSymlinks(p);
  return p;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export class Storage {
  readonly root: string;
  constructor(root: string) {
    this.root = noSymlinks(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.root = realpathSync(this.root);
  }
  path(...parts: string[]): string {
    const p = resolve(this.root, ...parts);
    if (!within(this.root, p)) throw new Error("STORAGE_PATH_ESCAPE");
    return noSymlinks(p);
  }
  read<T>(...parts: string[]): T {
    return JSON.parse(readFileSync(this.path(...parts), "utf8")) as T;
  }
  exists(...parts: string[]): boolean {
    return existsSync(this.path(...parts));
  }
  create(parts: string[], value: unknown): void {
    const p = this.path(...parts);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    const fd = openSync(p, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  exclusive<T>(name: string, fn: () => T): T {
    const p = this.path("mutex-" + hash(name) + ".lock");
    let fd: number;
    try {
      fd = openSync(p, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(
          "RESOURCE_LOCKED: " +
            p +
            "; inspect owner and active processes before manual removal"
        );
      throw e;
    }
    try {
      writeFileSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          created_at: new Date().toISOString(),
        })
      );
      return fn();
    } finally {
      closeSync(fd);
      unlinkSync(p);
    }
  }
  append(parts: string[], value: unknown): void {
    const p = this.path(...parts);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    const fd = openSync(p, "a", 0o600);
    try {
      appendFileSync(fd, JSON.stringify(value) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
