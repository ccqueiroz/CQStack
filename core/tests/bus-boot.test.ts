import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBus, type BusOptions } from "../src/bus.js";
import { type ProfileErrorCode } from "../src/profile.js";
import { areaOf, expectRefusedUnchanged, expectRejection, fakeClone, gitIn, temporaryDirectory, withGitShim, writeProject } from "./helpers.js";

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
