import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createBus } from "../src/bus.js";
import { buildGraph } from "../src/graph.js";
import {
  ADA,
  areaOf,
  bareRemote,
  expectRefusedUnchanged,
  expectRejection,
  fakeClone,
  gitIn,
  hasCommit,
  snapshot,
  temporaryDirectory,
  testHome,
  withGitShim,
  writeProject,
} from "./helpers.js";

const PROTOCOL_FLAGS_ORACLE = [
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=always",
  "-c", "protocol.ssh.allow=always",
  "-c", "protocol.ext.allow=never",
  "-c", "protocol.fd.allow=never",
];

test("[AREA-02] with a remote, the first boot clones it with the remote as origin, in the local area or at the declared path", async () => {
  const { cloneRoot } = fakeClone();
  const home = testHome();
  const commit = bareRemote(home, "memory");
  const bus = await createBus({ projectRoot: writeProject({ remote: "https://example.invalid/memory.git" }), cloneRoot, homeDir: home });
  assert.equal(hasCommit(areaOf(home)), true);
  assert.equal(gitIn(areaOf(home), "rev-parse", "HEAD").trim(), commit);
  assert.equal(gitIn(areaOf(home), "config", "--get", "remote.origin.url"), "https://example.invalid/memory.git\n");
  assert.equal(readFileSync(join(areaOf(home), "memory.md"), "utf8"), "remote\n");
  bus.log.create("r1", { graph: buildGraph("L"), actor: ADA });
  assert.equal(gitIn(areaOf(home), "status", "--porcelain", "--untracked-files=all"), "");
  const other = testHome();
  const otherCommit = bareRemote(other, "memory");
  const projectRoot = writeProject({ path: "memory", remote: "https://example.invalid/memory.git" });
  await createBus({ projectRoot, cloneRoot, homeDir: other });
  assert.equal(hasCommit(join(projectRoot, "memory")), true);
  assert.equal(gitIn(join(projectRoot, "memory"), "rev-parse", "HEAD").trim(), otherCommit);
  assert.equal(gitIn(join(projectRoot, "memory"), "config", "--get", "remote.origin.url"), "https://example.invalid/memory.git\n");
  assert.equal(hasCommit(areaOf(other)), false);
  assert.equal(gitIn(areaOf(other), "remote"), "");
});

test("[AREA-05] a clone that fails leaves no store, no binding, no temporary folder and no parent folder, and the next boot clones", async () => {
  const { cloneRoot } = fakeClone();
  for (const [path, existing] of [[undefined, false], ["deep/memory", false], [undefined, true]] as const) {
    const home = testHome();
    // an empty .cqstack made before stays: the cleanup goes no higher than the folders this boot made
    if (existing) mkdirSync(join(home, ".cqstack"));
    const projectRoot = writeProject({ remote: "https://example.invalid/memory.git", ...(path === undefined ? {} : { path }) });
    await expectRefusedUnchanged({ projectRoot, cloneRoot, homeDir: home }, "STORE_CLONE_FAILED", [home, projectRoot], `missing ${path}`);
    const commit = bareRemote(home, "memory");
    await createBus({ projectRoot, cloneRoot, homeDir: home });
    const store = path === undefined ? areaOf(home) : join(projectRoot, path);
    assert.equal(existsSync(join(store, ".git")), true);
    assert.equal(gitIn(store, "rev-parse", "HEAD").trim(), commit);
  }
});

test("[AREA-05] a remote without access is refused with STORE_CLONE_FAILED and leaves nothing", { skip: process.getuid?.() === 0 && "root reads any folder" }, async () => {
  const { cloneRoot } = fakeClone();
  const home = testHome();
  bareRemote(home, "memory");
  chmodSync(join(home, "remotes", "memory.git"), 0o000);
  try {
    const projectRoot = writeProject({ remote: "https://example.invalid/memory.git" });
    await expectRejection(createBus({ projectRoot, cloneRoot, homeDir: home }), "STORE_CLONE_FAILED");
    assert.equal(existsSync(join(home, ".cqstack")), false);
  } finally {
    chmodSync(join(home, "remotes", "memory.git"), 0o755);
  }
});

test("[AREA-05] a clone that takes longer than its time limit is stopped with STORE_CLONE_FAILED and leaves nothing", async () => {
  const { cloneRoot } = fakeClone();
  const home = testHome();
  const fake = temporaryDirectory();
  writeFileSync(join(fake, "ssh"), "#!/bin/sh\nexec sleep 5\n", { mode: 0o755 });
  const projectRoot = writeProject({ remote: "ssh://example.invalid/x.git" });
  const originalPath = process.env.PATH;
  process.env.PATH = fake + delimiter + (originalPath ?? "");
  try {
    const before = [snapshot(home), snapshot(projectRoot)];
    await assert.rejects(createBus({ projectRoot, cloneRoot, homeDir: home, cloneTimeoutMs: 500 }), (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error && error.code === "STORE_CLONE_FAILED", String(error));
      assert.match(error.message, /timed out after 500 ms/);
      return true;
    });
    assert.deepEqual([snapshot(home), snapshot(projectRoot)], before);
  } finally {
    process.env.PATH = originalPath;
  }
});

// macOS gives every process __CF_USER_TEXT_ENCODING; it is not in the environment the code passes
const passedEnv = (env: Record<string, string>) =>
  Object.fromEntries(Object.entries(env).filter(([key]) => key !== "__CF_USER_TEXT_ENCODING").sort());

test("[E6] the clone and the init run git with the protocol flags, no template, -- right before the remote and only the store environment", async () => {
  const { cloneRoot } = fakeClone();
  const home = testHome();
  bareRemote(home, "memory");
  const projectRoot = writeProject({ path: "memory", remote: "https://example.invalid/memory.git" });
  const storeEnv = {
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    GIT_TERMINAL_PROMPT: "0",
    HOME: home,
    PATH: "",
    ...(process.env.SSH_AUTH_SOCK === undefined ? {} : { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK }),
  };
  await withGitShim(async (calls) => {
    storeEnv.PATH = process.env.PATH ?? "";
    await createBus({ projectRoot, cloneRoot, homeDir: home });
    const clones = calls().filter((call) => call.args.includes("clone"));
    const inits = calls().filter((call) => call.args.includes("init"));
    assert.equal(clones.length, 1);
    assert.equal(inits.length, 1);
    const [clone] = clones;
    assert.deepEqual(clone.args.slice(0, -1), [...PROTOCOL_FLAGS_ORACLE, "clone", "--quiet", "--template=", "--", "https://example.invalid/memory.git"]);
    assert.ok(clone.args.at(-1)!.startsWith(join(projectRoot, ".memory.partial-")), clone.args.at(-1));
    assert.deepEqual(passedEnv(clone.env), storeEnv);
    assert.deepEqual(inits[0].args.slice(0, -1), ["init", "--quiet", "--template=", "--"]);
    assert.ok(inits[0].args.at(-1)!.startsWith(join(home, ".cqstack", "projects", ".acme-toy.partial-")), inits[0].args.at(-1));
    assert.deepEqual(passedEnv(inits[0].env), storeEnv);
    for (const call of calls().filter((call) => !call.args.includes("clone") && !call.args.includes("init")))
      assert.deepEqual(Object.keys(passedEnv(call.env)), ["PATH"], call.args.join(" "));
  });
});

test("[E6] a user configuration that allows ext and rewrites the remote to ext:: still runs no command", async () => {
  const { cloneRoot } = fakeClone();
  const target = temporaryDirectory();
  const home = testHome(`[protocol "ext"]\n\tallow = always\n[url "ext::sh -c touch% ${join(target, "pwned")}"]\n\tinsteadOf = https://example.invalid/evil\n`);
  const projectRoot = writeProject({ remote: "https://example.invalid/evil.git" });
  await expectRefusedUnchanged({ projectRoot, cloneRoot, homeDir: home }, "STORE_CLONE_FAILED", [home, projectRoot, target]);
  assert.deepEqual(readdirSync(target), []);
});

test("[STATE-04] [E6] a remote or an existing store that tracks project.json or the state folder is refused with STORE_TRACKS_LOCAL_FILES and leaves nothing", async () => {
  const { cloneRoot } = fakeClone();
  const refused: Array<[state_dir: string | undefined, files: Record<string, string>]> = [
    [undefined, { "project.json": "{}" }],
    [undefined, { "project.json/x": "x" }],
    [undefined, { "state/x": "x" }],
    [undefined, { state: "x" }],
    ["runs/x", { runs: "x" }],
    ["runs/x", { "runs/x": "x" }],
    ["runs/x", { "runs/x/y": "x" }],
    [undefined, { ".gitignore": "!project.json\n" }],
    [undefined, { ".gitignore": "!*.json\n" }],
    // without case, as a disk without case reads them
    [undefined, { "Project.json": "{}" }],
    [undefined, { "Project.json/x": "x" }],
    [undefined, { "State/x": "x" }],
    ["runs/x", { RUNS: "x" }],
    ["Runs/x", { runs: "x" }],
  ];
  await Promise.all(
    refused.map(([state_dir, files]) => {
      const home = testHome();
      bareRemote(home, "memory", files);
      const projectRoot = writeProject({ remote: "https://example.invalid/memory.git", ...(state_dir === undefined ? {} : { state_dir }) });
      return expectRefusedUnchanged({ projectRoot, cloneRoot, homeDir: home }, "STORE_TRACKS_LOCAL_FILES", [home, projectRoot], Object.keys(files)[0]);
    }),
  );
  for (const tracked of ["project.json", "state/x", ".gitignore"]) {
    const existing = temporaryDirectory();
    const projectRoot = writeProject();
    await createBus({ projectRoot, cloneRoot, homeDir: existing });
    assert.equal(existsSync(join(areaOf(existing), "project.json")), true);
    mkdirSync(join(areaOf(existing), "state"), { recursive: true });
    writeFileSync(join(areaOf(existing), "state", "x"), "x");
    writeFileSync(join(areaOf(existing), ".gitignore"), "!project.json\n");
    gitIn(areaOf(existing), "add", "--force", tracked);
    gitIn(areaOf(existing), "commit", "--quiet", "-m", "tracked");
    await expectRefusedUnchanged({ projectRoot, cloneRoot, homeDir: existing }, "STORE_TRACKS_LOCAL_FILES", [existing], `existing ${tracked}`);
  }
  // a project.json folder tracked by the area, with the binding file back in its place on disk
  const folderHome = temporaryDirectory();
  const folderRoot = writeProject();
  await createBus({ projectRoot: folderRoot, cloneRoot, homeDir: folderHome });
  const bindingFile = join(areaOf(folderHome), "project.json");
  const bindingText = readFileSync(bindingFile);
  rmSync(bindingFile);
  mkdirSync(bindingFile);
  writeFileSync(join(bindingFile, "x"), "x");
  gitIn(areaOf(folderHome), "add", "--force", "project.json/x");
  gitIn(areaOf(folderHome), "commit", "--quiet", "-m", "tracked");
  rmSync(bindingFile, { recursive: true });
  writeFileSync(bindingFile, bindingText);
  await expectRefusedUnchanged({ projectRoot: folderRoot, cloneRoot, homeDir: folderHome }, "STORE_TRACKS_LOCAL_FILES", [folderHome], "existing project.json/x");
  // a check-ignore that fails for another reason than "no match" stops the boot, never reads as "not un-ignored"
  const failing = temporaryDirectory();
  const failingRoot = writeProject();
  await createBus({ projectRoot: failingRoot, cloneRoot, homeDir: failing });
  await withGitShim(
    () => assert.rejects(createBus({ projectRoot: failingRoot, cloneRoot, homeDir: failing }), (error: unknown) => (error as { code?: unknown }).code === 128),
    'if (args[0] === "check-ignore") process.exit(128);',
  );
  const accepted: Array<[state_dir: string | undefined, path: string | undefined, files: Record<string, string>]> = [
    ["runs/x", undefined, { "runs/other": "x", "runs/xy": "x", "state/x": "x" }],
    [undefined, undefined, { "project.jsonx": "x", "statex/y": "x", "sub/project.json": "x" }],
    [undefined, undefined, { ".gitignore": "!state/\n!state/*\n!project.jsonx\n!sub/project.json\n" }],
    [undefined, "memory", { "project.json": "{}", "state/x": "x", ".gitignore": "!project.json\n" }],
  ];
  await Promise.all(
    accepted.map(async ([state_dir, path, files]) => {
      const home = testHome();
      bareRemote(home, "memory", files);
      const projectRoot = writeProject({
        remote: "https://example.invalid/memory.git",
        ...(state_dir === undefined ? {} : { state_dir }),
        ...(path === undefined ? {} : { path }),
      });
      const bus = await createBus({ projectRoot, cloneRoot, homeDir: home });
      bus.log.create("r1", { graph: buildGraph("L"), actor: ADA });
      assert.equal(existsSync(join(areaOf(home), "project.json")), true, Object.keys(files).join());
      assert.equal(gitIn(areaOf(home), "status", "--porcelain", "--untracked-files=all"), "", Object.keys(files).join());
    }),
  );
});

test("[E6] [BOOT-08] a clone that puts a folder open to group on the state path is refused with STATE_DIR_INVALID before the local area is put in place", async () => {
  const { cloneRoot } = fakeClone();
  const home = testHome();
  bareRemote(home, "memory", { "runs/other": "x" });
  const projectRoot = writeProject({ remote: "https://example.invalid/memory.git", state_dir: "runs/x" });
  // git makes the folders of the checkout with 0777 less the umask: under 0002 "runs" is open to group, under 0022 it is not
  const previous = process.umask(0o002);
  try {
    await expectRefusedUnchanged({ projectRoot, cloneRoot, homeDir: home }, "STATE_DIR_INVALID", [home, projectRoot]);
    process.umask(0o022);
    await createBus({ projectRoot, cloneRoot, homeDir: home });
  } finally {
    process.umask(previous);
  }
  assert.equal(existsSync(join(areaOf(home), "runs", "other")), true);
});

test("[E11] a clone failure shows the output of git without any credential, redacted before it is cut", async () => {
  const { cloneRoot } = fakeClone();
  const outputs = [
    "https://user:S3CRETVALUE@host/x\n",
    "fatal: https://user:S3CRETVALUE@host/x\n",
    "fatal: s3://user:S3CRETVALUE@host/x\n",
    "fatal: x://user:S3CRETVALUE@host/x\n",
    "fatal: a+b://user:S3CRETVALUE@host/x\n",
    "fatal: https://user:S3CRETVALUE@host/x and https://a@b/\n",
    "fatal: HTTPS://user:S3CRETVALUE@host/x\n",
    "fatal: ssh://user:p@ssS3CRETVALUE@host/x\n",
    "fatal: git+ssh://S3CRETVALUE@host/x\n",
    "fatal: https://a@b/ and then https://user:S3CRETVALUE@host/x\n",
    // the credential ends past the 2000th character of the output: cut before the redaction, its start would stay
    "a".repeat(1976) + " https://user:S3CRETVALUE@host/x\n",
    "remote: token S3CRETVALUE\n",
  ];
  // a fake ssh on PATH that writes the output named by its host to stderr and fails: git passes the stderr of ssh on
  const fake = temporaryDirectory();
  outputs.forEach((output, index) => writeFileSync(join(fake, `case${index}.invalid`), output));
  writeFileSync(
    join(fake, "ssh"),
    `#!/bin/sh\nfor argument in "$@"; do case "$argument" in *.invalid) cat "${fake}/$argument" >&2;; esac; done\nexit 255\n`,
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  process.env.PATH = fake + delimiter + (originalPath ?? "");
  try {
    await Promise.all(
      outputs.map((_, index) =>
        assert.rejects(
          createBus({ projectRoot: writeProject({ remote: `ssh://case${index}.invalid/memory.git` }), cloneRoot, homeDir: testHome() }),
          (error: unknown) => {
            assert.ok(error instanceof Error && "code" in error && error.code === "STORE_CLONE_FAILED", String(error));
            assert.ok(error.message.includes("[REDACTED]"), error.message);
            assert.ok(!error.message.includes("S3CR"), error.message);
            return true;
          },
        ),
      ),
    );
  } finally {
    process.env.PATH = originalPath;
  }
});
