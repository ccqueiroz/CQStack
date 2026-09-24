import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, writeFileSync, unlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { AgentBus } from "../../agent-bus/index.js";
import type { WorktreeDescriptor } from "../../contracts.js";
import { hash, scopePath, within } from "../../storage.js";
import { WORKSPACE } from "../artifacts.js";

export const TEMPLATE = {
  "src/pagination.mjs": "export function paginate(items, page, size) {\n  const start = page * size;\n  return { content: items.slice(start, start + size), page, size, totalElements: items.length };\n}\n",
  "tests/pagination.test.mjs": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { paginate } from '../src/pagination.mjs';\ntest('returns the requested page and the original total', () => {\n  assert.deepEqual(paginate([0, 1, 2, 3, 4], 1, 2), { content: [2, 3], page: 1, size: 2, totalElements: 5 });\n});\n",
};
export function git(repository: string, args: string[], extra: NodeJS.ProcessEnv = {}, input?: string): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", repository, ...args], {
    encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], shell: false,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...extra },
  }).trimEnd();
}
export function treeSnapshot(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(path: string) {
    for (const name of readdirSync(path).sort()) {
      if (name === ".git") continue;
      const file = join(path, name), stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("SYMLINK_WORKTREE_REJECTED");
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) result[relative(directory, file)] = hash(readFileSync(file).toString("base64"));
    }
  }
  walk(directory); return result;
}
export function fixtureInfo(bus: AgentBus): { repository: string; workspace_path: string; base_commit: string; template_hash: string } {
  const f = bus.storage.read<any>("fixtures", "registration.json");
  const expected = bus.storage.path("fixtures", "apply-demo");
  if (f.repository !== expected || f.template_hash !== hash(TEMPLATE) || !within(WORKSPACE, expected)) throw new Error("INVALID_FIXTURE_REGISTRATION");
  scopePath(WORKSPACE, f.workspace_path);
  if (resolve(WORKSPACE, f.workspace_path) !== expected || git(expected, ["rev-parse", "HEAD"]) !== f.base_commit) throw new Error("FIXTURE_BASE_CHANGED");
  const expectedFiles = Object.fromEntries(Object.entries(TEMPLATE).map(([p, text]) => [p, hash(Buffer.from(text).toString("base64"))]));
  if (hash(treeSnapshot(expected)) !== hash(expectedFiles) || git(expected, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("FIXTURE_SOURCE_CHANGED");
  return f;
}
export function registerFixtureRepository(bus: AgentBus): void {
  if (!bus.storage.exists("fixtures", "registration.json")) return;
  const f = fixtureInfo(bus);
  if (!bus.runtime.repositories.includes(f.workspace_path)) bus.runtime.repositories.push(f.workspace_path);
}
export function createFixture(bus: AgentBus) {
  if (bus.callerRole !== "master-orchestrator") throw new Error("WORKERS_DO_NOT_ORCHESTRATE_WORKERS");
  if (bus.storage.exists("fixtures", "registration.json")) { registerFixtureRepository(bus); return fixtureInfo(bus); }
  const repository = bus.storage.path("fixtures", "apply-demo");
  if (!within(WORKSPACE, repository)) throw new Error("FIXTURE_STATE_MUST_BE_INSIDE_WORKSPACE");
  if (existsSync(repository)) throw new Error("FIXTURE_INITIALIZATION_REQUIRES_INSPECTION");
  mkdirSync(repository, { recursive: true });
  for (const [path, text] of Object.entries(TEMPLATE)) {
    const file = scopePath(repository, path); mkdirSync(resolve(file, ".."), { recursive: true }); writeFileSync(file, text);
  }
  git(repository, ["init", "--initial-branch=fixture"]);
  git(repository, ["add", "--", ...Object.keys(TEMPLATE)]);
  git(repository, ["-c", "user.name=Cartera Harness Fixture", "-c", "user.email=fixture@invalid", "commit", "--no-gpg-sign", "-m", "Initialize controlled pagination fixture"]);
  const f = { repository, workspace_path: relative(WORKSPACE, repository), base_commit: git(repository, ["rev-parse", "HEAD"]), template_hash: hash(TEMPLATE) };
  bus.storage.create(["fixtures", "registration.json"], f); registerFixtureRepository(bus); return f;
}
export function checkpoint(bus: AgentBus, w: WorktreeDescriptor, paths: string[]): string {
  const f = fixtureInfo(bus);
  if (w.repository !== f.repository) throw new Error("APPLICATION_WRITE_DISABLED");
  bus.worktrees.validate(w);
  const index = bus.storage.path("checkpoint-" + w.id + ".index");
  if (existsSync(index) || existsSync(index + ".lock")) throw new Error("CHECKPOINT_REQUIRES_INSPECTION");
  const env = { GIT_INDEX_FILE: index };
  try {
    git(w.path, ["read-tree", w.base_commit], env);
    for (const path of paths) {
      scopePath(w.path, path);
      if (path.split("/").includes(".git")) throw new Error("GIT_MUTATION_FORBIDDEN");
      git(w.path, ["add", "--", path], env);
    }
    const tree = git(w.path, ["write-tree"], env);
    return git(w.path, ["commit-tree", tree, "-p", w.base_commit], {
      ...env, GIT_AUTHOR_NAME: "Cartera Harness Fixture", GIT_AUTHOR_EMAIL: "fixture@invalid",
      GIT_COMMITTER_NAME: "Cartera Harness Fixture", GIT_COMMITTER_EMAIL: "fixture@invalid",
    }, `Verified fixture checkpoint for ${w.task_id}\n`);
  } finally { if (existsSync(index)) unlinkSync(index); }
}
export function assertCheckpoint(w: WorktreeDescriptor, commit: string) {
  const files = git(w.path, ["ls-tree", "-r", "--name-only", commit]).split("\n").filter(Boolean);
  const expected = Object.fromEntries(files.map(p => [p, hash(execFileSync("git", ["-C", w.path, "show", `${commit}:${p}`]).toString("base64"))]));
  if (hash(treeSnapshot(w.path)) !== hash(expected)) throw new Error("IMPLEMENTATION_CHANGED_AFTER_VERIFICATION");
}
