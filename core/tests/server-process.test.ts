import { before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fakeClone, gitIn, snapshot, temporaryDirectory, withGitShim, writeProject } from "./helpers.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const INITIALIZE =
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "0.0.0" } },
  }) + "\n";
const ADA = { kind: "human", id: "ada@example.com" };

let clone = "";
let cloneCommit = "";

// mcp/server.ts compiled the way npm run build does (the root tsconfig.json, by extends), but only its import graph and into
// a stand-in clone: a git repository tagged v7.7.7 with the build in dist/ and the dependencies of the repository
before(() => {
  clone = temporaryDirectory();
  const config = join(temporaryDirectory(), "tsconfig.json");
  writeFileSync(
    config,
    JSON.stringify({
      extends: join(REPOSITORY_ROOT, "tsconfig.json"),
      compilerOptions: { outDir: join(clone, "dist"), typeRoots: [join(REPOSITORY_ROOT, "node_modules", "@types")] },
      files: [join(REPOSITORY_ROOT, "mcp", "server.ts")],
      include: [],
    }),
  );
  execFileSync(process.execPath, [join(REPOSITORY_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", config], { stdio: "pipe" });
  writeFileSync(join(clone, "package.json"), '{"type":"module"}\n');
  symlinkSync(join(REPOSITORY_ROOT, "node_modules"), join(clone, "node_modules"));
  cloneCommit = fakeClone("v7.7.7", clone).version.commit;
});

const serverFile = (root = clone) => join(root, "dist", "mcp", "server.js");

// the whole environment of the child is built here: no HOME, CLAUDE_PROJECT_DIR or state variable of the test process leaks in
function environment(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env.PATH ?? "", HOME: home, ...extra };
}

// a server that must not start: it exits with 1, answers nothing to initialize and writes one line with the code to stderr
function expectNoStart(env: Record<string, string>, code: string, options: { cwd?: string; server?: string } = {}): string {
  const result = spawnSync(process.execPath, [options.server ?? serverFile()], {
    env,
    cwd: options.cwd,
    input: INITIALIZE,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.status, 1, `${code}: status ${result.status}, stderr ${result.stderr}`);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, new RegExp(`^Server did not start: ${code}: [\\x20-\\x7e]*\\n$`));
  return result.stderr;
}

async function startClient(env: Record<string, string>, cwd?: string): Promise<Client | undefined> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverFile()], env, cwd, stderr: "pipe" });
  return client.connect(transport).then(
    () => client,
    () => undefined,
  );
}

function payloadOf(result: unknown): any {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

test("[SRV-01] [SRV-02] [SRV-03] the build makes dist/mcp/server.js from mcp/server.ts with the pinned SDK, and it announces cqstack and lists the three tools over stdio", async () => {
  const packageJson = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8"));
  const packageLock = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "package-lock.json"), "utf8"));
  const tsconfig = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "tsconfig.json"), "utf8"));
  assert.equal(packageJson.scripts.build, "tsc -p tsconfig.json");
  assert.equal(packageJson.dependencies["@modelcontextprotocol/sdk"], "1.26.0");
  assert.equal(packageLock.packages["node_modules/@modelcontextprotocol/sdk"].version, "1.26.0");
  assert.equal(tsconfig.compilerOptions.rootDir, ".");
  assert.equal(tsconfig.compilerOptions.outDir, "dist");
  assert.ok(tsconfig.include.includes("mcp/**/*.ts"));
  assert.equal(existsSync(serverFile()), true);
  const client = await startClient(environment(temporaryDirectory(), { CLAUDE_PROJECT_DIR: writeProject() }));
  assert.ok(client, "the compiled server did not start");
  try {
    assert.deepEqual(client.getServerVersion(), { name: "cqstack", version: "v7.7.7" });
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["task_init", "task_state", "task_events"]);
  } finally {
    await client.close();
  }
});

test("[BOOT-01] [BOOT-08] [E11] without CLAUDE_PROJECT_DIR, or with it empty or blank, the server exits before initialize with one English line and creates nothing", () => {
  const home = temporaryDirectory();
  const before = [snapshot(home), snapshot(clone)];
  for (const extra of [{}, { CLAUDE_PROJECT_DIR: "" }, { CLAUDE_PROJECT_DIR: "   " }] as Array<Record<string, string>>)
    expectNoStart(environment(home, extra), "PROFILE_PROJECT_ROOT_REQUIRED");
  assert.deepEqual([snapshot(home), snapshot(clone)], before);
});

test("[BOOT-02] [BOOT-04] a relative CLAUDE_PROJECT_DIR is refused even when the cwd has a valid profile at that path", () => {
  const home = temporaryDirectory();
  const cwd = temporaryDirectory();
  mkdirSync(join(cwd, "project"));
  writeProject({}, join(cwd, "project"));
  for (const relative of ["project", "./project"])
    expectNoStart(environment(home, { CLAUDE_PROJECT_DIR: relative }), "PROFILE_PROJECT_ROOT_NOT_ABSOLUTE", { cwd });
  assert.equal(existsSync(join(home, ".cqstack")), false);
});

test("[BOOT-03] [BOOT-08] a folder without profile, a file as project root or an invalid profile stops the server with the loader code and creates nothing", () => {
  const home = temporaryDirectory();
  const file = join(temporaryDirectory(), "file");
  writeFileSync(file, "x");
  const brokenJson = temporaryDirectory();
  writeFileSync(join(brokenJson, "cqstack.profile.json"), "{");
  const cases: Array<[string, string]> = [
    [temporaryDirectory(), "PROFILE_NOT_FOUND"],
    [join(temporaryDirectory(), "missing"), "PROFILE_NOT_FOUND"],
    [file, "PROFILE_NOT_FOUND"],
    [writeProject({ project_id: "Acme" }), "PROFILE_SCHEMA_VIOLATION"],
    [brokenJson, "PROFILE_INVALID_JSON"],
  ];
  for (const [projectRoot, code] of cases) expectNoStart(environment(home, { CLAUDE_PROJECT_DIR: projectRoot }), code);
  assert.equal(existsSync(join(home, ".cqstack")), false);
});

test("[BOOT-04] the server takes the project only from CLAUDE_PROJECT_DIR, never from the cwd", async () => {
  const home = temporaryDirectory();
  const cwd = writeProject({ project_id: "other-toy" });
  const client = await startClient(environment(home, { CLAUDE_PROJECT_DIR: writeProject() }), cwd);
  assert.ok(client, "the server did not start");
  try {
    payloadOf(await client.callTool({ name: "task_init", arguments: { root_id: "r1", actor: ADA } }));
  } finally {
    await client.close();
  }
  assert.deepEqual(readdirSync(join(home, ".cqstack", "projects")), ["acme-toy"]);
});

test("[BOOT-05] [BOOT-08] a clone without git, without a commit, or with git missing from PATH stops the server with HARNESS_VERSION_UNAVAILABLE and creates nothing", () => {
  const home = temporaryDirectory();
  const projectRoot = writeProject();
  const copy = (withGit: boolean) => {
    const root = temporaryDirectory();
    cpSync(join(clone, "dist"), join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
    symlinkSync(join(REPOSITORY_ROOT, "node_modules"), join(root, "node_modules"));
    if (withGit) gitIn(root, "init", "--quiet");
    return root;
  };
  for (const root of [copy(false), copy(true)])
    expectNoStart(environment(home, { CLAUDE_PROJECT_DIR: projectRoot }), "HARNESS_VERSION_UNAVAILABLE", { server: serverFile(root) });
  expectNoStart({ PATH: temporaryDirectory(), HOME: home, CLAUDE_PROJECT_DIR: projectRoot }, "HARNESS_VERSION_UNAVAILABLE");
  assert.equal(existsSync(join(home, ".cqstack")), false);
});

test("[BOOT-06] events record the tag and commit of the clone that holds the server, not those of the project or of the cwd", async () => {
  const projectRoot = writeProject();
  const projectVersion = fakeClone("v1.2.3", projectRoot).version;
  assert.notEqual(projectVersion.commit, cloneCommit);
  const client = await startClient(environment(temporaryDirectory(), { CLAUDE_PROJECT_DIR: projectRoot }), projectRoot);
  assert.ok(client, "the server did not start");
  try {
    const opened = payloadOf(await client.callTool({ name: "task_init", arguments: { root_id: "r1", actor: ADA } }));
    assert.deepEqual(opened.event?.harness_version, { tag: "v7.7.7", commit: cloneCommit });
  } finally {
    await client.close();
  }
});

test("[STATE-03] [E3] [BOOT-08] a state_dir outside the rule or a remote outside the list stops the server before any git process, runs nothing and shows no secret", async () => {
  const home = temporaryDirectory();
  const target = temporaryDirectory();
  const profiles = [
    ...["/x", "../x", ".", ".git/x", "a\\b", "project.json"].map((state_dir) => writeProject({ state_dir })),
    ...[`ext::sh -c touch% ${join(target, "pwned")}`, "fd::17", "file:///x", "/abs/x", "https://user:S3CRETVALUE@host/x"].map((remote) =>
      writeProject({ remote }),
    ),
  ];
  await withGitShim(async (calls) => {
    for (const projectRoot of profiles) {
      const stderr = expectNoStart(environment(home, { CLAUDE_PROJECT_DIR: projectRoot }), "PROFILE_SCHEMA_VIOLATION");
      assert.ok(!stderr.includes("S3CRETVALUE"), stderr);
    }
    assert.deepEqual(calls(), []);
  });
  assert.deepEqual(readdirSync(target), []);
  assert.equal(existsSync(join(home, ".cqstack")), false);
});

test("[AREA-07] [BOOT-08] a home folder inside the clone stops the server with PATH_INSIDE_HARNESS and writes nothing in the clone", () => {
  const home = join(clone, "home");
  mkdirSync(home, { recursive: true });
  const before = snapshot(clone);
  expectNoStart(environment(home, { CLAUDE_PROJECT_DIR: writeProject() }), "PATH_INSIDE_HARNESS");
  assert.deepEqual(snapshot(clone), before);
});

test("[AREA-08] [STATE-05] serving the three tools writes nothing in the clone, nor where the old state variable points", async () => {
  const home = temporaryDirectory();
  const oldStateFolder = temporaryDirectory();
  const oldStateVariable = ["CAR", "TERA", "_HARNESS", "_STATE"].join("");
  const before = snapshot(clone);
  const client = await startClient(environment(home, { CLAUDE_PROJECT_DIR: writeProject(), [oldStateVariable]: oldStateFolder }));
  assert.ok(client, "the server did not start");
  try {
    const { view } = payloadOf(await client.callTool({ name: "task_init", arguments: { root_id: "r1", actor: ADA } }));
    const moved = payloadOf(
      await client.callTool({
        name: "task_state",
        arguments: { root_id: "r1", to: "TASK_CLASSIFIED", expected_revision: view.revision, graph_hash: view.graph_hash, actor: { kind: "harness", id: "v7.7.7" } },
      }),
    );
    assert.equal(moved.view?.state, "TASK_CLASSIFIED");
    assert.equal(payloadOf(await client.callTool({ name: "task_events", arguments: { root_id: "r1" } })).events?.length, 2);
    assert.equal(payloadOf(await client.callTool({ name: "task_events", arguments: { root_id: "r9" } })).code, "ROOT_NOT_FOUND");
  } finally {
    await client.close();
  }
  assert.equal(existsSync(join(home, ".cqstack", "projects", "acme-toy", "state", "r1.jsonl")), true);
  assert.deepEqual(snapshot(clone), before);
  assert.deepEqual(readdirSync(oldStateFolder), []);
  assert.equal(existsSync(join(clone, "state")), false);
});
