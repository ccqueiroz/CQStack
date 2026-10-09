import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createBus, type BusOptions } from "../src/bus.js";
import { buildGraph } from "../src/graph.js";
import { PROFILE_FILE_NAME, loadProfile, type ProfileErrorCode } from "../src/profile.js";
import { canonicalHash, type StateErrorCode } from "../src/storage.js";
import { ADA, expectRejection, fakeClone, gitIn, snapshot, temporaryDirectory, withGitShim, writeProject } from "./helpers.js";

const areaOf = (home: string, projectId = "acme-toy") => join(home, ".cqstack", "projects", projectId);

// a refused boot leaves every given folder as it was: no new entry, every file byte for byte and with the same mtime
async function expectRefusedUnchanged(options: BusOptions, code: StateErrorCode | ProfileErrorCode, folders: string[], label = ""): Promise<void> {
  const before = folders.map(snapshot);
  await expectRejection(createBus(options), code, label);
  assert.deepEqual(folders.map(snapshot), before, `${code} ${label}`);
}

test("[BOOT-03] [BOOT-08] the bus refuses a missing, relative or invalid profile with the loader code, before any git process, and creates nothing", async () => {
  const { cloneRoot } = fakeClone();
  const home = temporaryDirectory();
  const noProfile = temporaryDirectory();
  const invalid = writeProject({ state_dir: "/x" });
  // <lexical>/link/.. is the parent of the link target on disk, while join() would read the profile beside the link
  const lexical = writeProject();
  const realParent = temporaryDirectory();
  mkdirSync(join(realParent, "sub"));
  symlinkSync(join(realParent, "sub"), join(lexical, "link"));
  symlinkSync(join(realParent, "missing", "sub"), join(lexical, "broken"));
  const loop = join(temporaryDirectory(), "loop");
  symlinkSync(loop, loop);
  const cases: Array<[string | undefined, ProfileErrorCode]> = [
    [undefined, "PROFILE_PROJECT_ROOT_REQUIRED"],
    ["", "PROFILE_PROJECT_ROOT_REQUIRED"],
    ["   ", "PROFILE_PROJECT_ROOT_REQUIRED"],
    ["relative/project", "PROFILE_PROJECT_ROOT_NOT_ABSOLUTE"],
    [noProfile, "PROFILE_NOT_FOUND"],
    [invalid, "PROFILE_SCHEMA_VIOLATION"],
    [lexical + "/link/..", "PROFILE_NOT_FOUND"],
    [lexical + "/broken/..", "PROFILE_NOT_FOUND"],
    [loop, "PROFILE_UNREADABLE"],
  ];
  await withGitShim(async (calls) => {
    for (const [projectRoot, code] of cases)
      await expectRefusedUnchanged({ projectRoot, cloneRoot, homeDir: home }, code, [home, cloneRoot, noProfile, invalid, lexical, realParent], String(projectRoot));
    for (const options of [undefined, null])
      await expectRejection(createBus(options as unknown as BusOptions), "PROFILE_PROJECT_ROOT_REQUIRED", String(options));
    assert.deepEqual(calls(), []);
  });
});

test("[BOOT-05] [BOOT-08] a clone root that is relative, without git or without a commit is refused with HARNESS_VERSION_UNAVAILABLE and creates nothing", async () => {
  const projectRoot = writeProject();
  const home = temporaryDirectory();
  const withoutCommit = temporaryDirectory();
  gitIn(withoutCommit, "init", "--quiet");
  for (const cloneRoot of ["relative/clone", temporaryDirectory(), withoutCommit])
    await expectRefusedUnchanged({ projectRoot, cloneRoot, homeDir: home }, "HARNESS_VERSION_UNAVAILABLE", [home, projectRoot], cloneRoot);
});

test("[E5] [BOOT-08] a home folder that is not text, empty, relative, missing or a file is refused with HOME_INVALID and creates nothing", async () => {
  const projectRoot = writeProject();
  const { cloneRoot } = fakeClone();
  const parent = temporaryDirectory();
  writeFileSync(join(parent, "file"), "x");
  // the relative home exists from the cwd, so only the absolute-path rule refuses it
  mkdirSync(join(parent, "relative", "home"), { recursive: true });
  const originalCwd = process.cwd();
  process.chdir(parent);
  try {
    for (const homeDir of [undefined, "", "relative/home", join(parent, "missing"), join(parent, "file"), join(parent, "file", "below")])
      await expectRefusedUnchanged({ projectRoot, cloneRoot, homeDir: homeDir as string }, "HOME_INVALID", [parent, projectRoot, cloneRoot], String(homeDir));
  } finally {
    process.chdir(originalCwd);
  }
});

test("[AREA-07] [BOOT-08] a local area or a declared store in the harness clone is refused with PATH_INSIDE_HARNESS and creates nothing", async () => {
  const { cloneRoot } = fakeClone();
  mkdirSync(join(cloneRoot, "sub"));
  const insideProject = join(cloneRoot, "project");
  mkdirSync(insideProject);
  writeProject({ path: "memory" }, insideProject);
  const linked = writeProject({ path: "memory" });
  symlinkSync(cloneRoot, join(linked, "memory"));
  const linkedDeeper = writeProject({ path: "memory/deeper" });
  symlinkSync(join(cloneRoot, "sub"), join(linkedDeeper, "memory"));
  const home = temporaryDirectory();
  // a folder whose name starts with ".." is still inside the clone
  mkdirSync(join(cloneRoot, "..home"));
  const links = temporaryDirectory();
  symlinkSync(cloneRoot, join(links, "clone"));
  const cases: Array<[projectRoot: string, homeDir: string, cloneGiven?: string]> = [
    [writeProject(), cloneRoot],
    [writeProject(), join(cloneRoot, "sub")],
    [writeProject(), join(cloneRoot, "..home")],
    [writeProject({ path: "memory" }), join(cloneRoot, "sub")],
    [writeProject(), join(links, "clone")],
    [writeProject(), join(cloneRoot, "sub"), join(links, "clone")],
    [insideProject, home],
    [linked, home],
    [linkedDeeper, home],
  ];
  // on a disk that ignores case, the clone is the same folder in upper case
  if (existsSync(cloneRoot.toUpperCase())) cases.push([writeProject(), cloneRoot.toUpperCase()]);
  for (const [projectRoot, homeDir, cloneGiven = cloneRoot] of cases)
    await expectRefusedUnchanged({ projectRoot, cloneRoot: cloneGiven, homeDir }, "PATH_INSIDE_HARNESS", [cloneRoot, home, projectRoot], `${projectRoot} ${homeDir}`);
});

test("[E2] [BOOT-08] a declared store inside the local area or containing it is refused with STORE_PATH_INVALID and creates nothing", async () => {
  const { cloneRoot } = fakeClone();
  const home = temporaryDirectory();
  const areaProject = join(areaOf(home), "project");
  mkdirSync(areaProject, { recursive: true });
  writeProject({ path: "memory" }, areaProject);
  for (const [projectRoot, label] of [
    [writeProject({ path: "." }, home), "home"],
    [writeProject({ path: ".cqstack" }, home), ".cqstack"],
    [areaProject, "inside the area"],
  ])
    await expectRefusedUnchanged({ projectRoot, cloneRoot, homeDir: home }, "STORE_PATH_INVALID", [home, cloneRoot], label);
});

test("[E2] [E5] [BOOT-08] a file where a folder of the state path must be is refused with STATE_DIR_INVALID and creates nothing", async () => {
  const { cloneRoot } = fakeClone();
  const cases: Array<[state_dir: string | undefined, file: string]> = [
    [undefined, ".cqstack"],
    [undefined, ".cqstack/projects"],
    [undefined, ".cqstack/projects/acme-toy"],
    [undefined, ".cqstack/projects/acme-toy/state"],
    ["runs/x", ".cqstack/projects/acme-toy/runs"],
    ["runs/x", ".cqstack/projects/acme-toy/runs/x"],
  ];
  for (const [state_dir, file] of cases) {
    const home = temporaryDirectory();
    const projectRoot = writeProject(state_dir === undefined ? {} : { state_dir });
    mkdirSync(join(home, file, ".."), { recursive: true });
    if (file.split("/").length > 3) gitIn(areaOf(home), "init", "--quiet");
    writeFileSync(join(home, file), "x");
    await expectRefusedUnchanged({ projectRoot, cloneRoot, homeDir: home }, "STATE_DIR_INVALID", [home, cloneRoot, projectRoot], file);
  }
});

test("[STATE-03] [E2] [E4] [E5] a symbolic link in the local area, the state path or for project.json is refused with SYMLINK_REJECTED and creates nothing", async () => {
  const { cloneRoot } = fakeClone();
  const cases: Array<[state_dir: string | undefined, link: string, target: "folder" | "file"]> = [
    [undefined, ".cqstack", "folder"],
    [undefined, ".cqstack/projects", "folder"],
    [undefined, ".cqstack/projects/acme-toy", "folder"],
    [undefined, ".cqstack/projects/acme-toy/state", "folder"],
    ["runs", ".cqstack/projects/acme-toy/runs", "folder"],
    ["runs/x", ".cqstack/projects/acme-toy/runs", "folder"],
    [undefined, ".cqstack/projects/acme-toy/project.json", "file"],
  ];
  for (const [state_dir, link, target] of cases) {
    const home = temporaryDirectory();
    const outside = temporaryDirectory();
    const projectRoot = writeProject(state_dir === undefined ? {} : { state_dir });
    mkdirSync(join(home, link, ".."), { recursive: true });
    if (link.split("/").length > 3) gitIn(areaOf(home), "init", "--quiet");
    if (target === "file") writeFileSync(join(outside, "project.json"), "{}");
    symlinkSync(target === "file" ? join(outside, "project.json") : outside, join(home, link));
    await expectRefusedUnchanged({ projectRoot, cloneRoot, homeDir: home }, "SYMLINK_REJECTED", [home, outside, cloneRoot, projectRoot], link);
  }
});

test("[E5] a folder of the local area path that is open to group or belongs to another user is refused with STATE_DIR_INVALID and creates nothing", { skip: process.getuid?.() === 0 && "root owns every temporary folder" }, async () => {
  const { cloneRoot } = fakeClone();
  const projectRoot = writeProject();
  const open = temporaryDirectory();
  mkdirSync(join(open, ".cqstack"));
  chmodSync(join(open, ".cqstack"), 0o770);
  await expectRefusedUnchanged({ projectRoot, cloneRoot, homeDir: open }, "STATE_DIR_INVALID", [open, cloneRoot], "group");
  const home = temporaryDirectory();
  const getuid = process.getuid;
  process.getuid = () => 4242;
  try {
    await expectRefusedUnchanged({ projectRoot, cloneRoot, homeDir: home }, "STATE_DIR_INVALID", [home, cloneRoot], "another owner");
  } finally {
    process.getuid = getuid;
  }
});

const repositoryTop = (folder: string) => gitIn(folder, "rev-parse", "--show-toplevel").trim();
const hasCommit = (folder: string) => {
  try {
    gitIn(folder, "rev-parse", "--verify", "--quiet", "HEAD");
    return true;
  } catch {
    return false;
  }
};
const gitView = (folder: string) => gitIn(folder, "status", "--porcelain", "--untracked-files=all") + gitIn(folder, "ls-files");
const bindingOf = (home: string) => JSON.parse(readFileSync(join(areaOf(home), "project.json"), "utf8"));
// a store made by hand, with one commit, as memory restored without the harness
function storeWithCommit(folder: string): void {
  mkdirSync(folder, { recursive: true });
  gitIn(folder, "init", "--quiet");
  writeFileSync(join(folder, "memory.md"), "kept\n");
  gitIn(folder, "add", "memory.md");
  gitIn(folder, "commit", "--quiet", "-m", "memory");
}

// a git on PATH that runs the given JavaScript (with the arguments in args) before handing the call to the real git
async function withGitWrapper(before: string, action: () => Promise<void>): Promise<void> {
  const directory = temporaryDirectory();
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(directory, "git"),
    `#!${process.execPath}\nconst fs = require("node:fs"); const args = process.argv.slice(2);\n${before}\n` +
      `process.exit(require("node:child_process").spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" }).status ?? 1);\n`,
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  process.env.PATH = directory + ":" + (originalPath ?? "");
  try {
    await action();
  } finally {
    process.env.PATH = originalPath;
  }
}

test("[AREA-01] [STATE-01] [BIND-01] the first boot creates the local area as an empty git repository without remote, the binding and the state folder", async () => {
  const { cloneRoot, version } = fakeClone();
  const projectRoot = writeProject();
  const home = temporaryDirectory();
  const projectBefore = snapshot(projectRoot);
  const cloneBefore = snapshot(cloneRoot);
  const started = Date.now();
  const bus = await createBus({ projectRoot, cloneRoot, homeDir: home });
  const area = areaOf(home);
  assert.equal(existsSync(join(area, "state", ".gitignore")), true);
  assert.equal(repositoryTop(area), area);
  assert.equal(gitIn(area, "remote"), "");
  assert.equal(hasCommit(area), false);
  const binding = bindingOf(home);
  assert.equal(readFileSync(join(area, "project.json"), "utf8"), JSON.stringify(binding, null, 2) + "\n");
  assert.deepEqual(Object.keys(binding), ["project_id", "project_root", "profile_path", "profile_hash", "created_at"]);
  assert.equal(binding.project_id, "acme-toy");
  assert.equal(binding.project_root, projectRoot);
  assert.equal(binding.profile_path, join(projectRoot, PROFILE_FILE_NAME));
  assert.equal(binding.profile_hash, canonicalHash(loadProfile(projectRoot)));
  assert.match(binding.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Math.abs(Date.parse(binding.created_at) - started) < 60_000, binding.created_at);
  assert.deepEqual(bus.version, version);
  const event = bus.log.create("r1", { graph: buildGraph("L"), actor: ADA });
  assert.equal(existsSync(join(area, "state", "r1.jsonl")), true);
  assert.deepEqual(event.harness_version, version);
  assert.deepEqual(readdirSync(join(home, ".cqstack", "projects")), ["acme-toy"]);
  assert.deepEqual(snapshot(projectRoot), projectBefore);
  assert.deepEqual(snapshot(cloneRoot), cloneBefore);
});

test("[STATE-02] a declared state_dir is resolved against the local area and the state folder is made there at boot", async () => {
  const { cloneRoot } = fakeClone();
  for (const [state_dir, folder] of [["runs", "runs"], ["runs/", "runs"], ["./runs", "runs"], ["runs/x", "runs/x"]]) {
    const home = temporaryDirectory();
    const bus = await createBus({ projectRoot: writeProject({ state_dir }), cloneRoot, homeDir: home });
    assert.equal(existsSync(join(areaOf(home), folder, ".gitignore")), true, state_dir);
    bus.log.create("r1", { graph: buildGraph("L"), actor: ADA });
    assert.equal(existsSync(join(areaOf(home), folder, "r1.jsonl")), true, state_dir);
    assert.equal(existsSync(join(areaOf(home), "state")), false, state_dir);
  }
});

test("[STATE-04] the state folder and project.json stay out of the git of the store", async () => {
  const { cloneRoot } = fakeClone();
  for (const state_dir of [undefined, "runs/x"]) {
    const home = temporaryDirectory();
    const bus = await createBus({ projectRoot: writeProject(state_dir === undefined ? {} : { state_dir }), cloneRoot, homeDir: home });
    bus.log.create("r1", { graph: buildGraph("L"), actor: ADA });
    assert.equal(existsSync(join(areaOf(home), "project.json")), true);
    assert.equal(gitView(areaOf(home)), "", String(state_dir));
  }
  const home = temporaryDirectory();
  const projectRoot = writeProject({ path: "memory" });
  const bus = await createBus({ projectRoot, cloneRoot, homeDir: home });
  bus.log.create("r1", { graph: buildGraph("L"), actor: ADA });
  assert.equal(gitView(join(projectRoot, "memory")), "");
  assert.equal(gitView(areaOf(home)), "");
  // the area made here is not asked again after it is in place: a rev-parse failing there cannot refuse the boot after the
  // area exists, and a later boot that cannot read it as a repository refuses before writing
  const flaky = temporaryDirectory();
  const flakyRoot = writeProject();
  await withGitWrapper(`if (args[0] === "rev-parse" && process.cwd() === ${JSON.stringify(areaOf(flaky))}) process.exit(128);`, async () => {
    const flakyBus = await createBus({ projectRoot: flakyRoot, cloneRoot, homeDir: flaky }).catch((error: { code?: string }) =>
      assert.fail(`refused after making the area: ${error.code}`),
    );
    flakyBus.log.create("r1", { graph: buildGraph("L"), actor: ADA });
    await expectRefusedUnchanged({ projectRoot: flakyRoot, cloneRoot, homeDir: flaky }, "STORE_NOT_GIT", [flaky, flakyRoot]);
  });
  assert.equal(gitView(areaOf(flaky)), "");
});

test("[AREA-03] [BIND-01] [BIND-04] a store that is already a git repository is used as it is, and later boots keep the binding", async () => {
  const { cloneRoot } = fakeClone();
  const home = temporaryDirectory();
  const projectRoot = writeProject();
  storeWithCommit(areaOf(home));
  // an exclude whose last line has no newline: the new line must not be glued to it
  writeFileSync(join(areaOf(home), ".git", "info", "exclude"), "*.tmp");
  const added = [".git/info/exclude", "project.json", "state", "state/.gitignore"];
  const kept = (folder: string) => snapshot(folder).filter((entry) => !added.includes(entry.split(" ")[0]));
  const before = kept(areaOf(home));
  const head = gitIn(areaOf(home), "rev-parse", "HEAD");
  await createBus({ projectRoot, cloneRoot, homeDir: home });
  assert.equal(existsSync(join(areaOf(home), "project.json")), true);
  assert.deepEqual(kept(areaOf(home)), before);
  assert.equal(gitIn(areaOf(home), "rev-parse", "HEAD"), head);
  assert.equal(gitIn(areaOf(home), "ls-files"), "memory.md\n");
  const binding = readFileSync(join(areaOf(home), "project.json"));
  await createBus({ projectRoot, cloneRoot, homeDir: home });
  writeProject({ language: "pt" }, projectRoot);
  await createBus({ projectRoot, cloneRoot, homeDir: home });
  assert.deepEqual(readFileSync(join(areaOf(home), "project.json")), binding);
  assert.deepEqual(readdirSync(join(home, ".cqstack", "projects")), ["acme-toy"]);
  assert.equal(readFileSync(join(areaOf(home), ".git", "info", "exclude"), "utf8"), "*.tmp\n/project.json\n");
  assert.equal(gitIn(areaOf(home), "status", "--porcelain", "--untracked-files=all"), "");
  // only the project.json of the area is out of git, not one of the memory in a subfolder
  mkdirSync(join(areaOf(home), "sub"));
  writeFileSync(join(areaOf(home), "sub", "project.json"), "{}");
  assert.equal(gitIn(areaOf(home), "status", "--porcelain", "--untracked-files=all"), "?? sub/project.json\n");
  const declared = writeProject({ path: "memory" });
  storeWithCommit(join(declared, "memory"));
  const storeBefore = snapshot(join(declared, "memory"));
  await createBus({ projectRoot: declared, cloneRoot, homeDir: temporaryDirectory() });
  assert.deepEqual(snapshot(join(declared, "memory")), storeBefore);
});

test("[AREA-04] a store that exists and is not the top folder of a git repository is refused with STORE_NOT_GIT and left untouched", async () => {
  const { cloneRoot } = fakeClone();
  const cases: Array<[label: string, path: string | undefined, prepare: (projectRoot: string, home: string) => void]> = [
    ["empty area", undefined, (_, home) => mkdirSync(areaOf(home), { recursive: true })],
    ["area with files", undefined, (_, home) => {
      mkdirSync(areaOf(home), { recursive: true });
      writeFileSync(join(areaOf(home), "notes.md"), "x");
    }],
    ["store file", "memory", (projectRoot) => writeFileSync(join(projectRoot, "memory"), "x")],
    ["empty store", "memory", (projectRoot) => mkdirSync(join(projectRoot, "memory"))],
    ["store with files", "memory", (projectRoot) => {
      mkdirSync(join(projectRoot, "memory"));
      writeFileSync(join(projectRoot, "memory", "notes.md"), "x");
    }],
    ["plain folder in the project repository", "memory", (projectRoot) => {
      gitIn(projectRoot, "init", "--quiet");
      mkdirSync(join(projectRoot, "memory"));
      writeFileSync(join(projectRoot, "memory", "notes.md"), "x");
    }],
    ["store below a file", "file/memory", (projectRoot) => writeFileSync(join(projectRoot, "file"), "x")],
  ];
  for (const [label, path, prepare] of cases) {
    const home = temporaryDirectory();
    const projectRoot = writeProject(path === undefined ? {} : { path });
    prepare(projectRoot, home);
    await expectRefusedUnchanged({ projectRoot, cloneRoot, homeDir: home }, "STORE_NOT_GIT", [home, projectRoot], label);
  }
});

test("[AREA-09] [AREA-10] a declared knowledge_store.path is the store, and project.json and state stay in the local area, made an empty git repository", async () => {
  const { cloneRoot } = fakeClone();
  const home = temporaryDirectory();
  const projectRoot = writeProject({ path: "memory" });
  const bus = await createBus({ projectRoot, cloneRoot, homeDir: home });
  const store = join(projectRoot, "memory");
  assert.equal(existsSync(join(store, ".git")), true);
  assert.equal(repositoryTop(store), store);
  assert.equal(gitIn(store, "remote"), "");
  assert.equal(hasCommit(store), false);
  assert.deepEqual(readdirSync(store), [".git"]);
  assert.equal(repositoryTop(areaOf(home)), areaOf(home));
  assert.equal(hasCommit(areaOf(home)), false);
  assert.equal(bindingOf(home).project_root, projectRoot);
  bus.log.create("r1", { graph: buildGraph("L"), actor: ADA });
  assert.equal(existsSync(join(areaOf(home), "state", "r1.jsonl")), true);
  assert.deepEqual(readdirSync(store), [".git"]);
});

test("[AREA-04] [AREA-10] with a declared path, a local area that exists without git is used as it is", async () => {
  const { cloneRoot } = fakeClone();
  const home = temporaryDirectory();
  mkdirSync(areaOf(home), { recursive: true });
  writeFileSync(join(areaOf(home), "notes.md"), "x");
  const bus = await createBus({ projectRoot: writeProject({ path: "memory" }), cloneRoot, homeDir: home });
  bus.log.create("r1", { graph: buildGraph("L"), actor: ADA });
  assert.deepEqual(readdirSync(areaOf(home)).sort(), ["notes.md", "project.json", "state"]);
});

test("[AREA-09] [E2] a declared path through a symbolic link is followed, and one that resolves to the local area makes the area the store", async () => {
  const { cloneRoot } = fakeClone();
  const outside = temporaryDirectory();
  const linked = writeProject({ path: "link/memory" });
  symlinkSync(outside, join(linked, "link"));
  await createBus({ projectRoot: linked, cloneRoot, homeDir: temporaryDirectory() });
  assert.equal(existsSync(join(outside, "memory", ".git")), true);
  assert.equal(repositoryTop(join(outside, "memory")), join(outside, "memory"));
  const home = temporaryDirectory();
  storeWithCommit(areaOf(home));
  const toArea = writeProject({ path: "memory" });
  symlinkSync(areaOf(home), join(toArea, "memory"));
  const bus = await createBus({ projectRoot: toArea, cloneRoot, homeDir: home });
  bus.log.create("r1", { graph: buildGraph("L"), actor: ADA });
  assert.equal(existsSync(join(areaOf(home), "project.json")), true);
  assert.equal(gitView(areaOf(home)), "memory.md\n");
});

test("[BOOT-07] the bus takes the project root from its argument, never from CLAUDE_PROJECT_DIR", async () => {
  const { cloneRoot } = fakeClone();
  const home = temporaryDirectory();
  const original = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = writeProject({ project_id: "other-toy" });
  try {
    await createBus({ projectRoot: writeProject(), cloneRoot, homeDir: home });
    assert.equal(existsSync(areaOf(home)), true);
    assert.deepEqual(readdirSync(join(home, ".cqstack", "projects")), ["acme-toy"]);
    await expectRejection(createBus({ projectRoot: undefined, cloneRoot, homeDir: home }), "PROFILE_PROJECT_ROOT_REQUIRED");
  } finally {
    if (original === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = original;
  }
});

test("[BIND-04] [E1] the same root given with a trailing slash, through .. or through a symbolic link is bound as its real path and boots again", async () => {
  const { cloneRoot } = fakeClone();
  const home = temporaryDirectory();
  const projectRoot = writeProject();
  mkdirSync(join(projectRoot, "sub"));
  const link = join(temporaryDirectory(), "link");
  symlinkSync(projectRoot, link);
  await createBus({ projectRoot: projectRoot + "/", cloneRoot, homeDir: home });
  assert.equal(existsSync(join(areaOf(home), "project.json")), true);
  assert.equal(bindingOf(home).project_root, projectRoot);
  const binding = readFileSync(join(areaOf(home), "project.json"));
  for (const given of [projectRoot + "/sub/..", link, projectRoot]) {
    await createBus({ projectRoot: given, cloneRoot, homeDir: home });
    assert.deepEqual(readFileSync(join(areaOf(home), "project.json")), binding, given);
  }
  const throughLink = temporaryDirectory();
  await createBus({ projectRoot: link, cloneRoot, homeDir: throughLink });
  assert.equal(existsSync(join(areaOf(throughLink), "project.json")), true);
  assert.deepEqual([bindingOf(throughLink).project_root, bindingOf(throughLink).profile_path], [projectRoot, join(projectRoot, PROFILE_FILE_NAME)]);
  // a link to <root>/sub beside another profile: <beside>/link/.. is <root> on disk, so <root> is read and bound
  const beside = writeProject({ project_id: "other-toy" });
  symlinkSync(join(projectRoot, "sub"), join(beside, "link"));
  const combined = temporaryDirectory();
  await createBus({ projectRoot: beside + "/link/..", cloneRoot, homeDir: combined });
  assert.deepEqual(readdirSync(join(combined, ".cqstack", "projects")), ["acme-toy"]);
  assert.deepEqual([bindingOf(combined).project_root, bindingOf(combined).profile_hash], [projectRoot, canonicalHash(loadProfile(projectRoot))]);
});

test("[E5] a partial store left by a crash is ignored and the boot makes the store", async () => {
  const { cloneRoot } = fakeClone();
  const home = temporaryDirectory();
  const partial = join(home, ".cqstack", "projects", ".acme-toy.partial-x1");
  mkdirSync(join(partial, ".git"), { recursive: true });
  await createBus({ projectRoot: writeProject(), cloneRoot, homeDir: home });
  assert.equal(existsSync(join(areaOf(home), ".git")), true);
  assert.equal(repositoryTop(areaOf(home)), areaOf(home));
  assert.equal(existsSync(partial), true);
});

test("[AREA-07] [AREA-08] a project root inside the harness clone, without a declared path, boots and writes nothing in the clone", async () => {
  const { cloneRoot } = fakeClone();
  writeProject({}, cloneRoot);
  const before = snapshot(cloneRoot);
  const home = temporaryDirectory();
  const bus = await createBus({ projectRoot: cloneRoot, cloneRoot, homeDir: home });
  bus.log.create("r1", { graph: buildGraph("L"), actor: ADA });
  assert.equal(existsSync(join(areaOf(home), "project.json")), true);
  assert.equal(existsSync(join(areaOf(home), "state", "r1.jsonl")), true);
  assert.deepEqual(snapshot(cloneRoot), before);
});

test("[AREA-07] [AREA-08] [BOOT-08] an existing local area or store whose git folder is in the harness clone is refused with PATH_INSIDE_HARNESS and changes nothing", async () => {
  const worktree = (cloneRoot: string, folder: string) => gitIn(cloneRoot, "worktree", "add", "--quiet", "--detach", folder);
  const cases: Array<[label: string, path: string | undefined, prepare: (cloneRoot: string, projectRoot: string, home: string) => void]> = [
    ["area as a linked worktree of the clone", undefined, (cloneRoot, _, home) => worktree(cloneRoot, areaOf(home))],
    ["area with a .git file naming the git folder of the clone", undefined, (cloneRoot, _, home) => {
      mkdirSync(areaOf(home), { recursive: true });
      writeFileSync(join(areaOf(home), ".git"), `gitdir: ${join(cloneRoot, ".git")}\n`);
    }],
    ["declared store as a linked worktree of the clone", "memory", (cloneRoot, projectRoot) => worktree(cloneRoot, join(projectRoot, "memory"))],
    ["area as a linked worktree of the clone, with a declared store", "memory", (cloneRoot, _, home) => worktree(cloneRoot, areaOf(home))],
    // a worktree keeps its own git folder (HEAD, index) apart from the shared one (objects, info/exclude): either may be in the clone
    ["area whose own git folder is in the clone and whose shared one is outside", undefined, (cloneRoot, _, home) => {
      const outside = fakeClone(null).cloneRoot;
      worktree(outside, areaOf(home));
      renameSync(join(outside, ".git", "worktrees", "acme-toy"), join(cloneRoot, "own"));
      writeFileSync(join(cloneRoot, "own", "commondir"), join(outside, ".git") + "\n");
      writeFileSync(join(areaOf(home), ".git"), `gitdir: ${join(cloneRoot, "own")}\n`);
    }],
    ["area whose own git folder is outside and whose shared one is in the clone", undefined, (cloneRoot, _, home) => {
      const outside = temporaryDirectory();
      worktree(cloneRoot, areaOf(home));
      renameSync(join(cloneRoot, ".git", "worktrees", "acme-toy"), join(outside, "own"));
      writeFileSync(join(outside, "own", "commondir"), join(cloneRoot, ".git") + "\n");
      writeFileSync(join(areaOf(home), ".git"), `gitdir: ${join(outside, "own")}\n`);
    }],
  ];
  // on a disk that ignores case, git answers with the upper-case path a .git file gives, without resolving it
  if (existsSync(temporaryDirectory().toUpperCase()))
    cases.push(["area with a .git file naming the clone in upper case", undefined, (cloneRoot, _, home) => {
      mkdirSync(areaOf(home), { recursive: true });
      writeFileSync(join(areaOf(home), ".git"), `gitdir: ${join(cloneRoot, ".git").toUpperCase()}\n`);
    }]);
  for (const [label, path, prepare] of cases) {
    const { cloneRoot } = fakeClone();
    const home = temporaryDirectory();
    mkdirSync(join(home, ".cqstack", "projects"), { recursive: true });
    const projectRoot = writeProject(path === undefined ? {} : { path });
    prepare(cloneRoot, projectRoot, home);
    await expectRefusedUnchanged({ projectRoot, cloneRoot, homeDir: home }, "PATH_INSIDE_HARNESS", [cloneRoot, home, projectRoot], label);
  }
});

test('[STATE-04] [BOOT-08] a state folder whose .gitignore is not a file of "*" is refused with STORE_TRACKS_LOCAL_FILES and changes nothing', async () => {
  const { cloneRoot } = fakeClone();
  const cases: Array<[label: string, path: string | undefined, prepare: (stateDir: string) => void]> = [
    ["empty", undefined, (stateDir) => writeFileSync(join(stateDir, ".gitignore"), "")],
    ["negating", undefined, (stateDir) => writeFileSync(join(stateDir, ".gitignore"), "*\n!*.jsonl\n")],
    ["another pattern", undefined, (stateDir) => writeFileSync(join(stateDir, ".gitignore"), "*.tmp\n")],
    ["folder", undefined, (stateDir) => mkdirSync(join(stateDir, ".gitignore"))],
    ["link to a file of *", undefined, (stateDir) => {
      writeFileSync(join(stateDir, "ignore"), "*\n");
      symlinkSync(join(stateDir, "ignore"), join(stateDir, ".gitignore"));
    }],
    ["empty, with a declared store", "memory", (stateDir) => writeFileSync(join(stateDir, ".gitignore"), "")],
  ];
  for (const [label, path, prepare] of cases) {
    const home = temporaryDirectory();
    const projectRoot = writeProject(path === undefined ? {} : { path });
    await createBus({ projectRoot, cloneRoot, homeDir: home });
    const stateDir = join(areaOf(home), "state");
    assert.equal(existsSync(join(stateDir, ".gitignore")), true, label);
    rmSync(join(stateDir, ".gitignore"));
    prepare(stateDir);
    await expectRefusedUnchanged({ projectRoot, cloneRoot, homeDir: home }, "STORE_TRACKS_LOCAL_FILES", [home, projectRoot], label);
  }
});
