import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createBus } from "../src/bus.js";
import { buildGraph } from "../src/graph.js";
import { PROFILE_FILE_NAME, loadProfile } from "../src/profile.js";
import { canonicalHash } from "../src/storage.js";
import {
  ADA,
  areaOf,
  bindingOf,
  expectRefusedUnchanged,
  expectRejection,
  fakeClone,
  gitIn,
  gitView,
  hasCommit,
  repositoryTop,
  snapshot,
  storeWithCommit,
  temporaryDirectory,
  withGitShim,
  writeProject,
} from "./helpers.js";

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
  await withGitShim(async () => {
    const flakyBus = await createBus({ projectRoot: flakyRoot, cloneRoot, homeDir: flaky }).catch((error: { code?: string }) =>
      assert.fail(`refused after making the area: ${error.code}`),
    );
    flakyBus.log.create("r1", { graph: buildGraph("L"), actor: ADA });
    await expectRefusedUnchanged({ projectRoot: flakyRoot, cloneRoot, homeDir: flaky }, "STORE_NOT_GIT", [flaky, flakyRoot]);
  }, `if (args[0] === "rev-parse" && process.cwd() === ${JSON.stringify(areaOf(flaky))}) process.exit(128);`);
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

test("[AREA-09] [E2] [BOOT-08] a declared path through a symbolic link is followed inside the project root, and one that leads outside it is refused with STORE_PATH_INVALID and creates nothing", async () => {
  const { cloneRoot } = fakeClone();
  const inside = writeProject({ path: "link/memory" });
  mkdirSync(join(inside, "real"));
  symlinkSync(join(inside, "real"), join(inside, "link"));
  await createBus({ projectRoot: inside, cloneRoot, homeDir: temporaryDirectory() });
  assert.equal(existsSync(join(inside, "real", "memory", ".git")), true);
  assert.equal(repositoryTop(join(inside, "real", "memory")), join(inside, "real", "memory"));
  const home = temporaryDirectory();
  storeWithCommit(areaOf(home));
  const outside = temporaryDirectory();
  storeWithCommit(join(outside, "repository"));
  const cases: Array<[label: string, path: string, link: string, target: (projectRoot: string) => string]> = [
    ["link to a folder outside, store absent", "link/memory", "link", () => outside],
    ["link to a repository outside", "memory", "memory", () => join(outside, "repository")],
    ["link to the local area", "memory", "memory", () => areaOf(home)],
    ["relative link to a folder outside", "up/memory", "up", (projectRoot) => relative(projectRoot, outside)],
  ];
  const roots = cases.map(([, path, link, target]) => {
    const projectRoot = writeProject({ path });
    symlinkSync(target(projectRoot), join(projectRoot, link));
    return projectRoot;
  });
  await withGitShim(async (calls) => {
    for (const [index, [label]] of cases.entries())
      await expectRefusedUnchanged({ projectRoot: roots[index], cloneRoot, homeDir: home }, "STORE_PATH_INVALID", [home, outside, roots[index], cloneRoot], label);
    // only the two reads of the harness version ran: no git process in the store or the area
    assert.deepEqual(calls().map((call) => call.args.slice(0, 2).join(" ")), cases.flatMap(() => ["rev-parse HEAD", "tag --points-at"]));
  });
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

test("[BIND-02] another root with the same project_id is refused with BINDING_ROOT_MISMATCH, with the binding and the area unchanged", async () => {
  const { cloneRoot } = fakeClone();
  const home = temporaryDirectory();
  const first = writeProject();
  await createBus({ projectRoot: first, cloneRoot, homeDir: home });
  assert.equal(existsSync(join(areaOf(home), "project.json")), true);
  const other = writeProject();
  await expectRefusedUnchanged({ projectRoot: other, cloneRoot, homeDir: home }, "BINDING_ROOT_MISMATCH", [home, other], "other root");
  const moved = join(temporaryDirectory(), "moved");
  mkdirSync(moved);
  writeProject({}, moved);
  await expectRefusedUnchanged({ projectRoot: moved, cloneRoot, homeDir: home }, "BINDING_ROOT_MISMATCH", [home, moved], "moved");
});

test("[BIND-03] [E4] a binding that is not valid is refused with BINDING_INVALID and never rewritten", async () => {
  const { cloneRoot } = fakeClone();
  const projectRoot = writeProject();
  const valid = {
    project_id: "acme-toy",
    project_root: projectRoot,
    profile_path: join(projectRoot, PROFILE_FILE_NAME),
    profile_hash: "a".repeat(64),
    created_at: "2026-10-08T12:00:00.000Z",
  };
  const without = (field: keyof typeof valid) => Object.fromEntries(Object.entries(valid).filter(([key]) => key !== field));
  const texts: string[] = [
    "",
    "{",
    "[]",
    "null",
    '"x"',
    "42",
    JSON.stringify({ ...valid, extra: "x" }),
    ...(Object.keys(valid) as Array<keyof typeof valid>).map((field) => JSON.stringify(without(field))),
    JSON.stringify({ ...valid, project_id: "other-toy" }),
    JSON.stringify({ ...valid, project_id: "Acme-toy" }),
    JSON.stringify({ ...valid, project_root: "relative/project" }),
    JSON.stringify({ ...valid, project_root: projectRoot + "/" }),
    JSON.stringify({ ...valid, project_root: projectRoot + "/sub/.." }),
    JSON.stringify({ ...valid, project_root: 1 }),
    JSON.stringify({ ...valid, profile_path: join(temporaryDirectory(), PROFILE_FILE_NAME) }),
    JSON.stringify({ ...valid, profile_path: join(projectRoot, "other.json") }),
    JSON.stringify({ ...valid, profile_path: "cqstack.profile.json" }),
    JSON.stringify({ ...valid, profile_hash: "a".repeat(63) }),
    JSON.stringify({ ...valid, profile_hash: "a".repeat(65) }),
    JSON.stringify({ ...valid, profile_hash: "A".repeat(64) }),
    JSON.stringify({ ...valid, created_at: "2026-10-08" }),
    JSON.stringify({ ...valid, created_at: "2026-10-08T12:00:00Z" }),
    JSON.stringify({ ...valid, created_at: "x2026-10-08T12:00:00.000Z" }),
    JSON.stringify({ ...valid, created_at: "2026-10-08T12:00:00.000Zx" }),
    ...["202a-10-08T12:00:00.000Z", "2026-1a-08T12:00:00.000Z", "2026-10-0aT12:00:00.000Z", "2026-10-08T1a:00:00.000Z",
      "2026-10-08T12:0a:00.000Z", "2026-10-08T12:00:0a.000Z", "2026-10-08T12:00:00.00aZ", "2026-10-08T12:00:00a000Z",
      "2026-10-08 12:00:00.000Z", "2026-10-08T12:00:00.000z"].map((created_at) => JSON.stringify({ ...valid, created_at })),
    ...["g".repeat(64), "a".repeat(63) + " ", "-" + "a".repeat(63)].map((profile_hash) => JSON.stringify({ ...valid, profile_hash })),
  ];
  await Promise.all(
    texts.map(async (text) => {
      const home = temporaryDirectory();
      await createBus({ projectRoot, cloneRoot, homeDir: home });
      writeFileSync(join(areaOf(home), "project.json"), text);
      await expectRefusedUnchanged({ projectRoot, cloneRoot, homeDir: home }, "BINDING_INVALID", [home], text);
    }),
  );
  const folder = temporaryDirectory();
  await createBus({ projectRoot, cloneRoot, homeDir: folder });
  rmSync(join(areaOf(folder), "project.json"));
  mkdirSync(join(areaOf(folder), "project.json"));
  await expectRefusedUnchanged({ projectRoot, cloneRoot, homeDir: folder }, "BINDING_INVALID", [folder], "folder");
  const home = temporaryDirectory();
  await createBus({ projectRoot, cloneRoot, homeDir: home });
  writeFileSync(join(areaOf(home), "project.json"), JSON.stringify(valid));
  await createBus({ projectRoot, cloneRoot, homeDir: home });
});
