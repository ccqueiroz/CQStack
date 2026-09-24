import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import type { WorktreeDescriptor } from "../contracts.js";
import { Storage, hash, id, noSymlinks, within } from "../storage.js";

export interface RepositoryInspection {
  repository: string;
  branch: string;
  HEAD: string;
  dirty_files: string[];
  untracked_files: string[];
  deleted_files: string[];
}

export interface CreateWorktreeInput {
  task_id: string;
  role: string;
  repository: string;
  base_ref: string;
  contract_version?: string;
  requires_uncommitted_changes?: boolean;
}

interface OwnershipRecord {
  descriptor: WorktreeDescriptor;
  descriptor_hash: string;
  git_common_dir: string;
}

interface GitWorktreeRecord {
  path: string;
  head: string;
  locked: boolean;
}

const git = (repository: string, args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-C", repository, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false }
  ).trimEnd();

function safeGitValue(value: string, error: string): string {
  if (!value || value.startsWith("-") || /[\0\r\n]/.test(value))
    throw new Error(error);
  return value;
}

function parseStatus(
  output: string
): Pick<
  RepositoryInspection,
  "dirty_files" | "untracked_files" | "deleted_files"
> {
  const dirty = new Set<string>();
  const untracked = new Set<string>();
  const deleted = new Set<string>();
  for (const line of output.split("\n")) {
    if (!line) continue;
    const state = line.slice(0, 2);
    const rawPath = line.slice(3);
    const path = rawPath.includes(" -> ")
      ? rawPath.slice(rawPath.lastIndexOf(" -> ") + 4)
      : rawPath;
    if (state === "??") untracked.add(path);
    else {
      dirty.add(path);
      if (state.includes("D")) deleted.add(path);
    }
  }
  return {
    dirty_files: [...dirty].sort(),
    untracked_files: [...untracked].sort(),
    deleted_files: [...deleted].sort(),
  };
}

function parseWorktrees(output: string): GitWorktreeRecord[] {
  return output
    .split(/\n\n+/)
    .filter(Boolean)
    .map((block) => {
      let path = "";
      let head = "";
      let locked = false;
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) path = line.slice(9);
        else if (line.startsWith("HEAD ")) head = line.slice(5);
        else if (line === "locked" || line.startsWith("locked ")) locked = true;
      }
      return { path, head, locked };
    });
}

export class WorktreeManager {
  constructor(
    readonly storage: Storage,
    private readonly authorizeMutation: () => void = () => {}
  ) {}

  inspect(repository: string): RepositoryInspection {
    const canonicalRepository = this.repository(repository);
    const status = parseStatus(
      git(canonicalRepository, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ])
    );
    return {
      repository: canonicalRepository,
      branch: git(canonicalRepository, ["branch", "--show-current"]),
      HEAD: git(canonicalRepository, ["rev-parse", "HEAD"]),
      ...status,
    };
  }

  create(input: CreateWorktreeInput): WorktreeDescriptor {
    this.authorizeMutation();
    if (input.requires_uncommitted_changes)
      throw new Error("UNCOMMITTED_INPUT_REQUIRED");
    id(input.task_id);
    id(input.role);
    safeGitValue(input.base_ref, "INVALID_BASE_REF");
    const repository = this.repository(input.repository);
    return this.storage.exclusive(this.repositoryLock(repository), () => {
      const baseCommit = git(repository, [
        "rev-parse",
        "--verify",
        `${input.base_ref}^{commit}`,
      ]);
      if (!/^[0-9a-f]{40,64}$/.test(baseCommit))
        throw new Error("INVALID_BASE_COMMIT");
      const worktreeId = id(
        `${input.task_id.slice(0, 32)}-${input.role.slice(
          0,
          24
        )}-${randomUUID()}`
      );
      const path = this.storage.path("worktrees", worktreeId);
      if (existsSync(path)) throw new Error("WORKTREE_PATH_EXISTS");
      git(repository, ["worktree", "add", "--detach", path, baseCommit]);
      const descriptor: WorktreeDescriptor = {
        id: worktreeId,
        task_id: input.task_id,
        role: input.role,
        repository,
        path: realpathSync(path),
        base_ref: input.base_ref,
        base_commit: baseCommit,
        contract_version: input.contract_version ?? null,
        created_at: new Date().toISOString(),
      };
      try {
        this.storage.create(["ownership", `${worktreeId}.json`], {
          descriptor,
          descriptor_hash: hash(descriptor),
          git_common_dir: this.gitCommonDir(repository),
        } satisfies OwnershipRecord);
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        throw new Error(`WORKTREE_CREATION_INCOMPLETE: ${path}; ${cause}`);
      }
      this.validate(descriptor);
      return descriptor;
    });
  }

  list(): WorktreeDescriptor[] {
    const directory = this.storage.path("ownership");
    if (!existsSync(directory)) return [];
    if (lstatSync(directory).isSymbolicLink())
      throw new Error("SYMLINK_PATH_REJECTED");
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => this.readOwnership(entry.name.slice(0, -5)).descriptor);
  }

  validate(descriptor: WorktreeDescriptor): void {
    id(descriptor.id);
    const ownership = this.readOwnership(descriptor.id);
    if (ownership.descriptor_hash !== hash(ownership.descriptor))
      throw new Error("OWNERSHIP_HASH_MISMATCH");
    if (hash(ownership.descriptor) !== hash(descriptor))
      throw new Error("OWNERSHIP_DESCRIPTOR_MISMATCH");
    const repository = this.repository(descriptor.repository);
    const sourceCommonDir = this.gitCommonDir(repository);
    if (ownership.git_common_dir !== sourceCommonDir)
      throw new Error("GIT_COMMON_DIR_MISMATCH");
    const expectedPath = this.storage.path("worktrees", descriptor.id);
    if (
      descriptor.path !== expectedPath ||
      !within(this.storage.path("worktrees"), descriptor.path)
    )
      throw new Error("WORKTREE_PATH_MISMATCH");
    noSymlinks(descriptor.path);
    if (
      !existsSync(descriptor.path) ||
      realpathSync(descriptor.path) !== descriptor.path
    )
      throw new Error("WORKTREE_PATH_MISSING");
    if (this.gitCommonDir(descriptor.path) !== sourceCommonDir)
      throw new Error("GIT_COMMON_DIR_MISMATCH");
    const registered = parseWorktrees(
      git(repository, ["worktree", "list", "--porcelain"])
    ).find((worktree) => worktree.path === descriptor.path);
    if (!registered) throw new Error("WORKTREE_NOT_REGISTERED");
    if (
      registered.head !== descriptor.base_commit ||
      git(descriptor.path, ["rev-parse", "HEAD"]) !== descriptor.base_commit
    ) {
      throw new Error("WORKTREE_HEAD_MOVED");
    }
    try {
      git(descriptor.path, ["symbolic-ref", "--quiet", "HEAD"]);
    } catch {
      return;
    }
    throw new Error("WORKTREE_NOT_DETACHED");
  }

  assertClean(descriptor: WorktreeDescriptor): void {
    this.validate(descriptor);
    const status = git(descriptor.path, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignored",
    ]);
    if (status) throw new Error("WORKTREE_DIRTY");
  }

  remove(worktreeId: string): void {
    this.authorizeMutation();
    id(worktreeId);
    const ownership = this.readOwnership(worktreeId);
    if (
      this.storage.exists(`execution-${id(ownership.descriptor.task_id)}.lock`)
    )
      throw new Error("ACTIVE_WORKTREE");
    if (this.storage.exists("quarantine", `${worktreeId}.json`))
      throw new Error("QUARANTINED_WORKTREE");
    const repository = this.repository(ownership.descriptor.repository);
    this.storage.exclusive(this.repositoryLock(repository), () => {
      this.assertClean(ownership.descriptor);
      const registered = parseWorktrees(
        git(repository, ["worktree", "list", "--porcelain"])
      ).find((worktree) => worktree.path === ownership.descriptor.path);
      if (!registered) throw new Error("WORKTREE_NOT_REGISTERED");
      if (registered.locked) throw new Error("WORKTREE_LOCKED");
      git(repository, ["worktree", "remove", ownership.descriptor.path]);
      unlinkSync(this.storage.path("ownership", `${worktreeId}.json`));
    });
  }

  private repository(value: string): string {
    safeGitValue(value, "INVALID_REPOSITORY");
    const requested = noSymlinks(resolve(value));
    if (!existsSync(requested) || !lstatSync(requested).isDirectory())
      throw new Error("REPOSITORY_NOT_FOUND");
    const canonical = realpathSync(requested);
    let topLevel: string;
    try {
      topLevel = realpathSync(git(canonical, ["rev-parse", "--show-toplevel"]));
    } catch {
      throw new Error("NOT_GIT_TOPLEVEL");
    }
    if (canonical !== topLevel) throw new Error("NOT_GIT_TOPLEVEL");
    return canonical;
  }

  private repositoryLock(repository: string): string {
    return `worktree-${hash(repository)}`;
  }

  private gitCommonDir(repository: string): string {
    const value = git(repository, ["rev-parse", "--git-common-dir"]);
    return realpathSync(resolve(repository, value));
  }

  private readOwnership(worktreeId: string): OwnershipRecord {
    id(worktreeId);
    if (!this.storage.exists("ownership", `${worktreeId}.json`))
      throw new Error("UNKNOWN_WORKTREE_OWNERSHIP");
    const record = this.storage.read<OwnershipRecord>(
      "ownership",
      `${worktreeId}.json`
    );
    if (
      !record ||
      typeof record !== "object" ||
      !record.descriptor ||
      typeof record.descriptor_hash !== "string" ||
      typeof record.git_common_dir !== "string"
    ) {
      throw new Error("INVALID_OWNERSHIP_METADATA");
    }
    if (basename(record.descriptor.path) !== worktreeId)
      throw new Error("OWNERSHIP_DESCRIPTOR_MISMATCH");
    return record;
  }
}
