import { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { StateError, canonicalHash, type StateErrorCode } from "../src/storage.js";
import { buildGraph, type RootState, type Track } from "../src/graph.js";
import { EventLog, type Actor, type Event, type HarnessVersion } from "../src/events.js";
import { PROFILE_FILE_NAME, ProfileError, loadProfile, type ProfileErrorCode, type ProjectProfile } from "../src/profile.js";
import { observeProcess, type Observation } from "../src/observation.js";

export const V1: HarnessVersion = { tag: "v9.9.9", commit: "1".repeat(40) };
export const V2: HarnessVersion = { tag: null, commit: "2".repeat(40) };

const temporaryDirectories: string[] = [];
after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

export function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "cqstack-test-")));
  temporaryDirectories.push(directory);
  return directory;
}

// the fictitious profile of the tests, written as cqstack.profile.json in projectRoot (a new temporary folder by default)
export function writeProject(
  fields: { project_id?: string; state_dir?: string; path?: string; remote?: string; language?: string } = {},
  projectRoot = temporaryDirectory(),
): string {
  const { project_id = "acme-toy", state_dir, path, remote, language = "en" } = fields;
  writeFileSync(
    join(projectRoot, PROFILE_FILE_NAME),
    JSON.stringify({
      project_id,
      language: { default: language, by_artifact: {} },
      commit_identity: { name: "Ada Example", email: "ada@example.com" },
      providers_required: ["alpha-llm"],
      repositories: [{ id: "app", path: "." }],
      knowledge_store: { deliveries_dir: "deliveries", ...(path === undefined ? {} : { path }), ...(remote === undefined ? {} : { remote }) },
      ...(state_dir === undefined ? {} : { state_dir }),
    }),
  );
  return projectRoot;
}
export const PROFILE: ProjectProfile = loadProfile(writeProject());

export function expectStateError(action: () => unknown, code: StateErrorCode, label = ""): void {
  assert.throws(action, (error: unknown) => error instanceof StateError && error.code === code, `${code} ${label}`);
}

export function expectRejection(promise: Promise<unknown>, code: StateErrorCode | ProfileErrorCode, label = ""): Promise<void> {
  return assert.rejects(
    promise,
    (error: unknown) => (error instanceof StateError || error instanceof ProfileError) && error.code === code,
    `${code} ${label}`,
  );
}

// Only PATH and fixed -c options: the user's git configuration never signs, prompts or prints hints in the setup of a test, and
// no background maintenance after a commit leaves a lock file that a snapshot would catch.
export function gitIn(directory: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@example.com",
      "-c", "commit.gpgsign=false",
      "-c", "tag.gpgsign=false",
      "-c", "init.defaultBranch=main",
      "-c", "maintenance.auto=false",
      "-c", "gc.auto=0",
      ...args,
    ],
    { cwd: directory, env: { PATH: process.env.PATH ?? "" }, stdio: "pipe", encoding: "utf8" },
  );
}

// a stand-in harness clone: a git repository with one commit and, by default, a tag on it
export function fakeClone(tag: string | null = "v7.7.7", cloneRoot = temporaryDirectory()): { cloneRoot: string; version: HarnessVersion } {
  gitIn(cloneRoot, "init", "--quiet");
  gitIn(cloneRoot, "commit", "--allow-empty", "--quiet", "-m", "clone");
  if (tag !== null) gitIn(cloneRoot, "tag", tag);
  return { cloneRoot, version: { tag, commit: gitIn(cloneRoot, "rev-parse", "HEAD").trim() } };
}

// every entry under directory without following links: folders by path, files also by size, mtime and sha256, links by target
export function snapshot(directory: string): string[] {
  const entries: string[] = [];
  const walk = (relativePath: string) => {
    const path = join(directory, relativePath);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) entries.push(`${relativePath} link ${readlinkSync(path)}`);
    else if (stats.isDirectory()) {
      entries.push(`${relativePath} dir`);
      for (const name of readdirSync(path).sort()) walk(join(relativePath, name));
    } else entries.push(`${relativePath} file ${stats.size} ${stats.mtimeMs} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
  };
  walk(".");
  return entries;
}

// a git on PATH that records the arguments and the environment of each call in log, one JSON line each, then runs the real git
export async function withGitShim<T>(action: (calls: () => Array<{ args: string[]; env: Record<string, string> }>) => Promise<T>): Promise<T> {
  const directory = temporaryDirectory();
  const log = join(directory, "calls.jsonl");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(directory, "git"),
    `#!${process.execPath}\n` +
      `const { appendFileSync } = require("node:fs"); const { spawnSync } = require("node:child_process");\n` +
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), env: process.env }) + "\\n");\n` +
      `const result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: "inherit" });\n` +
      `process.exit(result.status ?? 1);\n`,
    { mode: 0o755 },
  );
  const calls = () =>
    existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line)) : [];
  const originalPath = process.env.PATH;
  process.env.PATH = directory + delimiter + (originalPath ?? "");
  try {
    return await action(calls);
  } finally {
    process.env.PATH = originalPath;
  }
}

export function withCwd(directory: string, action: () => void): void {
  const original = process.cwd();
  process.chdir(directory);
  try {
    action();
  } finally {
    process.chdir(original);
  }
}

export function handLog(rootId: string, track: Track, path: RootState[], version: HarnessVersion = V1): Record<string, unknown>[] {
  const graph = buildGraph(track);
  const graphHash = canonicalHash(graph);
  const events: Record<string, unknown>[] = [
    {
      seq: 1,
      ts: "2026-10-07T00:00:00.000Z",
      root_id: rootId,
      task_id: rootId,
      event_type: "task.created",
      actor: { kind: "human", id: "ada@example.com" },
      graph,
      graph_hash: graphHash,
      harness_version: version,
    },
  ];
  let from: RootState = "TASK_RECEIVED";
  for (const to of path) {
    events.push({
      seq: events.length + 1,
      ts: "2026-10-07T00:00:01.000Z",
      root_id: rootId,
      task_id: rootId,
      event_type: `transition.${from}.${to}`,
      actor: { kind: "harness", id: "v9.9.9" },
      graph_hash: graphHash,
      harness_version: version,
    });
    from = to;
  }
  return events;
}

export function observedLine(rootId: string, seq: number, graphHash: string): Record<string, unknown> {
  return {
    seq,
    ts: "2026-10-07T00:00:02.000Z",
    root_id: rootId,
    task_id: rootId,
    event_type: "provider.observed",
    actor: { kind: "worker", id: "child-1" },
    graph_hash: graphHash,
    harness_version: V1,
    item_id: "item-1",
    payload_ref: "observations/one.json",
    payload_hash: "c".repeat(64),
  };
}

export function writeLog(stateDir: string, rootId: string, events: unknown[], tail = "\n"): string {
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, `${rootId}.jsonl`);
  writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n") + tail);
  return file;
}

export const ADA: Actor = { kind: "human", id: "ada@example.com" };

const HUMAN_EDGES_ORACLE = [
  "GAP_DEFINED>DECIDED",
  "PLAN_PROPOSED>PLAN_APPROVED",
  "PR_OPEN>LOTE_MERGED",
  "NEEDS_HUMAN>LOTE_RUNNING",
  "NEEDS_HUMAN>DONE",
];
export const L_PATH_TO_GAP: RootState[] = ["TASK_CLASSIFIED", "TASK_SENSE_COMPLETE", "DISCOVERY_COMPLETE", "FLOW_COMPLETE", "TRUTH_VERIFIED", "GAP_DEFINED"];

export function actorFor(from: RootState, to: RootState, version: HarnessVersion = V1): Actor {
  return HUMAN_EDGES_ORACLE.includes(`${from}>${to}`) ? ADA : { kind: "harness", id: version.tag ?? version.commit };
}

export function createdRoot(stateDir: string, track: Track, path: RootState[] = [], version: HarnessVersion = V1): EventLog {
  const log = new EventLog(stateDir, PROFILE, version);
  log.create("r1", { graph: buildGraph(track), actor: ADA });
  advance(log, path, version);
  return log;
}

export function advance(log: EventLog, path: RootState[], version: HarnessVersion = V1): Event[] {
  return path.map((to) => {
    const view = log.state("r1");
    return log.transition("r1", {
      to,
      expected_revision: view.revision,
      graph_hash: view.graph_hash,
      actor: actorFor(view.state, to, version),
    });
  });
}

export function bytesOf(stateDir: string): Buffer {
  const file = join(stateDir, "r1.jsonl");
  assert.equal(existsSync(file), true);
  return readFileSync(file);
}

export const WORKER: Actor = { kind: "worker", id: "child-1", role: "implementer" };

export function observationOf(attribution: { root_id?: string; item_id?: string }): Observation {
  return observeProcess(
    attribution,
    { command: "provider-cli", stdin: "prompt", timeout_ms: 1000 },
    { exit_code: 0, stdout: "", stderr: "", signal: null },
    3,
  );
}

// values whose JSON is not what a check of the value reads: fields only on the prototype, or a toJSON that JSON.stringify calls
export function inheriting<T extends object>(fields: T): T {
  return Object.create(fields) as T;
}

export function withToJson<T extends object>(value: T, json: unknown, enumerable = false): T {
  return Object.defineProperty({ ...value }, "toJSON", { value: () => json, enumerable }) as T;
}

// a root written while its folders were private, then a folder above it opened to others: every operation is refused, nothing changes
export function assertStatePathRefused(stateDir: string, label: string): void {
  const before = bytesOf(stateDir);
  const names = readdirSync(stateDir).sort();
  const log = new EventLog(stateDir, PROFILE, V1);
  const graphHash = canonicalHash(buildGraph("L"));
  expectStateError(() => log.events("r1"), "STATE_DIR_INVALID", `events ${label}`);
  expectStateError(() => log.state("r1"), "STATE_DIR_INVALID", `state ${label}`);
  expectStateError(
    () => log.transition("r1", { to: "TASK_CLASSIFIED", expected_revision: 0, graph_hash: graphHash, actor: { kind: "harness", id: "v9.9.9" } }),
    "STATE_DIR_INVALID",
    `transition ${label}`,
  );
  expectStateError(
    () => log.recordObservation("r1", { actor: WORKER, observation: observationOf({ root_id: "r1" }), payload_ref: "observations/one.json" }),
    "STATE_DIR_INVALID",
    `observation ${label}`,
  );
  expectStateError(() => log.create("r2", { graph: buildGraph("L"), actor: ADA }), "STATE_DIR_INVALID", `create ${label}`);
  assert.deepEqual(bytesOf(stateDir), before);
  assert.deepEqual(readdirSync(stateDir).sort(), names);
}
