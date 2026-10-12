import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { createBus } from "../src/bus.js";
import { buildGraph } from "../src/graph.js";
import { PROFILE_FILE_NAME } from "../src/profile.js";
import {
  ADA,
  areaOf,
  bareRemote,
  bindingOf,
  expectRefusedUnchanged,
  expectRejection,
  fakeClone,
  gitIn,
  gitView,
  repositoryTop,
  snapshot,
  temporaryDirectory,
  testHome,
  withGitShim,
  writeProject,
} from "./helpers.js";

test("[E5] two first boots of the same root at once both resolve, with one store, one binding and no temporary folder left", async () => {
  const { cloneRoot } = fakeClone();
  for (const fields of [{}, { remote: "https://example.invalid/memory.git" }, { path: "memory" }]) {
    const home = testHome();
    bareRemote(home, "memory");
    const projectRoot = writeProject(fields);
    const results = await Promise.allSettled([1, 2, 3].map(() => createBus({ projectRoot, cloneRoot, homeDir: home })));
    assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled", "fulfilled"], JSON.stringify(fields));
    assert.deepEqual(readdirSync(join(home, ".cqstack", "projects")), ["acme-toy"]);
    assert.equal(bindingOf(home).project_root, projectRoot);
    assert.equal(gitView(areaOf(home)), "remote" in fields ? "memory.md\n" : "");
    if ("path" in fields) {
      assert.equal(repositoryTop(join(projectRoot, "memory")), join(projectRoot, "memory"));
      assert.deepEqual(readdirSync(projectRoot).sort(), [PROFILE_FILE_NAME, "memory"]);
    }
  }
});

test("[E5] two first boots of different roots with the same project_id at once: exactly one resolves, and the binding is its root", async () => {
  const { cloneRoot } = fakeClone();
  const home = temporaryDirectory();
  const roots = [writeProject(), writeProject(), writeProject()];
  const results = await Promise.allSettled(roots.map((projectRoot) => createBus({ projectRoot, cloneRoot, homeDir: home })));
  const winners = roots.filter((_, index) => results[index].status === "fulfilled");
  assert.equal(winners.length, 1, JSON.stringify(results.map((result) => (result.status === "rejected" ? String(result.reason) : "ok"))));
  for (const result of results)
    if (result.status === "rejected") assert.equal((result.reason as { code?: string }).code, "BINDING_ROOT_MISMATCH");
  assert.equal(bindingOf(home).project_root, winners[0]);
  assert.deepEqual(readdirSync(join(home, ".cqstack", "projects")), ["acme-toy"]);
});

test("[E5] a clone that fails never removes what a boot that ran at the same time made", async () => {
  const { cloneRoot } = fakeClone();
  const home = temporaryDirectory();
  const fake = temporaryDirectory();
  writeFileSync(join(fake, "ssh"), "#!/bin/sh\nsleep 2\nexit 255\n", { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = fake + delimiter + (originalPath ?? "");
  try {
    const failing = createBus({ projectRoot: writeProject({ remote: "ssh://example.invalid/memory.git" }), cloneRoot, homeDir: home });
    const outcome = failing.then(
      () => "resolved",
      (error: { code?: string }) => error.code,
    );
    for (let waited = 0; !existsSync(join(home, ".cqstack", "projects")) && waited < 3000; waited += 10)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const projectRoot = writeProject();
    await createBus({ projectRoot, cloneRoot, homeDir: home });
    assert.equal(await outcome, "STORE_CLONE_FAILED");
    assert.equal(existsSync(join(areaOf(home), "project.json")), true);
    assert.equal(bindingOf(home).project_root, projectRoot);
    assert.equal(repositoryTop(areaOf(home)), areaOf(home));
    assert.deepEqual(readdirSync(join(home, ".cqstack", "projects")), ["acme-toy"]);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("[E5] a boot that finds its store made by another boot as a folder without git refuses with STORE_NOT_GIT", async () => {
  const { cloneRoot } = fakeClone();
  const home = temporaryDirectory();
  const projectRoot = writeProject();
  // the folder appears while git init runs in the temporary folder, as another process writing there would leave it
  await withGitShim(
    () => expectRejection(createBus({ projectRoot, cloneRoot, homeDir: home }), "STORE_NOT_GIT"),
    `if (args[0] === "init") { fs.mkdirSync(${JSON.stringify(areaOf(home))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(join(areaOf(home), "notes.md"))}, "x"); }`,
  );
  assert.deepEqual(readdirSync(areaOf(home)), ["notes.md"]);
  assert.deepEqual(readdirSync(join(home, ".cqstack", "projects")), ["acme-toy"]);
  // at a declared path the store goes into place after the binding claimed the area: the area stays bound to this root, the
  // folder there is left as found, and the next boot refuses before it writes
  const declaredHome = temporaryDirectory();
  const declaredRoot = writeProject({ path: "memory" });
  const memory = join(declaredRoot, "memory");
  await withGitShim(
    () => expectRejection(createBus({ projectRoot: declaredRoot, cloneRoot, homeDir: declaredHome }), "STORE_NOT_GIT"),
    `if (args[0] === "init" && args.at(-1).startsWith(${JSON.stringify(join(declaredRoot, ".memory.partial-"))})) { fs.mkdirSync(${JSON.stringify(memory)}); fs.writeFileSync(${JSON.stringify(join(memory, "notes.md"))}, "x"); }`,
  );
  assert.deepEqual(readdirSync(memory), ["notes.md"]);
  assert.deepEqual(readdirSync(declaredRoot).sort(), [PROFILE_FILE_NAME, "memory"]);
  assert.equal(bindingOf(declaredHome).project_root, declaredRoot);
  await expectRefusedUnchanged({ projectRoot: declaredRoot, cloneRoot, homeDir: declaredHome }, "STORE_NOT_GIT", [declaredHome, declaredRoot]);
});

test("[E5] [BOOT-08] two first boots of different roots with their own declared stores at once: the refused one leaves no store, no state folder and no temporary folder", async () => {
  const { cloneRoot } = fakeClone();
  const cloneBefore = snapshot(cloneRoot);
  for (const existingArea of [false, true]) {
    const home = temporaryDirectory();
    // an area made by hand without a binding: the link of project.json decides who owns it
    if (existingArea) {
      mkdirSync(areaOf(home), { recursive: true });
      gitIn(areaOf(home), "init", "--quiet");
    }
    const roots = [writeProject({ path: "memory", state_dir: "runs" }), writeProject({ path: "memory" })];
    const before = roots.map(snapshot);
    const results = await Promise.allSettled(roots.map((projectRoot) => createBus({ projectRoot, cloneRoot, homeDir: home })));
    const outcomes = results.map((result) => (result.status === "fulfilled" ? "ok" : (result.reason as { code?: string }).code));
    const winner = outcomes.indexOf("ok");
    assert.deepEqual([...outcomes].sort(), ["BINDING_ROOT_MISMATCH", "ok"], `${existingArea} ${outcomes}`);
    assert.equal(bindingOf(home).project_root, roots[winner]);
    assert.deepEqual(snapshot(roots[1 - winner]), before[1 - winner], `${existingArea}: the refused root keeps no store`);
    assert.equal(existsSync(join(roots[winner], "memory", ".git")), true);
    assert.deepEqual(readdirSync(areaOf(home)).sort(), [".git", "project.json", winner === 0 ? "runs" : "state"], String(existingArea));
    assert.deepEqual(readdirSync(join(home, ".cqstack", "projects")), ["acme-toy"]);
  }
  assert.deepEqual(snapshot(cloneRoot), cloneBefore);
});

test("[E5] [AREA-08] a boot that loses the local area to another boot checks the area it finds before writing, and never follows a tracked link into the clone", async () => {
  const { cloneRoot } = fakeClone();
  mkdirSync(join(cloneRoot, "sub"));
  const cloneBefore = snapshot(cloneRoot);
  const cases = [
    ["another root", false, {}, "BINDING_ROOT_MISMATCH"],
    ["the same root, its profile changed to a declared store", true, { path: "memory" }, "SYMLINK_REJECTED"],
    ["the same root, its profile changed to the default state folder", true, {}, "STORE_TRACKS_LOCAL_FILES"],
  ] as const;
  for (const [label, sameRoot, fields, code] of cases) {
    const home = testHome();
    // the memory of the winner tracks a link named state into the clone; its own state folder is runs, so its clone passes
    const work = temporaryDirectory();
    gitIn(work, "init", "--quiet");
    symlinkSync(join(cloneRoot, "sub"), join(work, "state"));
    gitIn(work, "add", "state");
    gitIn(work, "commit", "--quiet", "-m", "memory");
    gitIn(work, "clone", "--quiet", "--bare", work, join(home, "remotes", "memory.git"));
    const projects = join(home, ".cqstack", "projects");
    const winnerRoot = writeProject({ state_dir: "runs", remote: "https://example.invalid/memory.git" });
    // the winner clones once the other boot has its own temporary area, whose git init then waits for the winner's area
    await withGitShim(
      async () => {
        const winning = createBus({ projectRoot: winnerRoot, cloneRoot, homeDir: home });
        // the winner has read its profile already: a profile changed now reaches only the other boot
        const loserRoot = writeProject(fields, sameRoot ? winnerRoot : temporaryDirectory());
        const loserBefore = snapshot(loserRoot);
        const [winnerOutcome, loserOutcome] = await Promise.allSettled([winning, createBus({ projectRoot: loserRoot, cloneRoot, homeDir: home })]);
        assert.equal(winnerOutcome.status, "fulfilled", label);
        assert.equal(loserOutcome.status === "rejected" ? (loserOutcome.reason as { code?: string }).code : "resolved", code, label);
        assert.deepEqual(snapshot(loserRoot), loserBefore, label);
      },
      `const projects = ${JSON.stringify(projects)};\n` +
        `const wait = (done) => { for (let k = 0; !done() && k < 500; k++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); };\n` +
        `if (args.includes("clone")) wait(() => fs.existsSync(projects) && fs.readdirSync(projects).filter((name) => name.startsWith(".acme-toy.partial-")).length >= 2);\n` +
        `if (args[0] === "init" && args.at(-1).startsWith(projects + "/")) wait(() => fs.existsSync(projects + "/acme-toy"));`,
    );
    assert.deepEqual(snapshot(cloneRoot), cloneBefore, label);
    assert.deepEqual(readdirSync(areaOf(home)).sort(), [".git", "project.json", "runs", "state"], label);
  }
});

// The boot that makes the area runs in a worker whose renameSync waits: the area goes into place once the other boot has its own
// temporary area, and the store only after the other boot put its store there. Between the two renames of a boot there is no
// git call and no await, so only the scheduler opens this window, between two processes.
const RENAME_HOLD = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const { projects, area, store, busUrl, options } = workerData;
const realRename = fs.renameSync;
const waitFor = (done) => { for (let k = 0; !done() && k < 500; k++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); };
let storeRename = "not tried";
fs.renameSync = (from, to) => {
  if (to === area) waitFor(() => fs.readdirSync(projects).filter((name) => name.startsWith(".acme-toy.partial-")).length >= 2);
  if (to !== store) return realRename(from, to);
  waitFor(() => fs.existsSync(store + "/.git"));
  try { realRename(from, to); storeRename = "won"; } catch (error) { storeRename = error.code; throw error; }
};
require("node:module").syncBuiltinESMExports();
import(busUrl).then(({ createBus }) => createBus(options)).then(
  () => parentPort.postMessage({ outcome: "ok", storeRename }),
  (error) => parentPort.postMessage({ outcome: error.code ?? String(error), storeRename }),
);
`;

test("[E5] [BOOT-08] a boot that made the local area and loses the declared store to a boot of the same root that git cannot read leaves only what that boot uses", async () => {
  const { cloneRoot } = fakeClone();
  const home = temporaryDirectory();
  writeFileSync(join(home, "notes.md"), "kept\n");
  const projectRoot = writeProject({ path: "memory" });
  const projects = join(home, ".cqstack", "projects");
  const store = join(projectRoot, "memory");
  const folders = [cloneRoot, home, projectRoot];
  const before = folders.map(snapshot);
  const options = { projectRoot, cloneRoot, homeDir: home };
  // in the worker, git cannot read the store it finds (as a timeout or a git that fails would leave it)
  let areaMaker = { outcome: "not run", storeRename: "not tried" };
  let other: PromiseSettledResult<unknown> | undefined;
  await withGitShim(async () => {
    const worker = new Worker(RENAME_HOLD, {
      eval: true,
      workerData: { projects, area: areaOf(home), store, busUrl: new URL("../src/bus.js", import.meta.url).href, options },
    });
    const made = new Promise<typeof areaMaker>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    // the other boot waits with its temporary area until the area of the worker is in place, then adopts it
    await withGitShim(
      async () => {
        [other] = await Promise.allSettled([createBus(options)]);
      },
      `const wait = (done) => { for (let k = 0; !done() && k < 500; k++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); };\n` +
        `if (args[0] === "init" && args.at(-1).startsWith(${JSON.stringify(join(projects, ".acme-toy.partial-"))})) wait(() => fs.existsSync(${JSON.stringify(areaOf(home))}));`,
    );
    areaMaker = await made;
  }, `if (args[0] === "rev-parse" && process.cwd() === ${JSON.stringify(store)}) process.exit(128);`);
  assert.deepEqual(
    [areaMaker.outcome, ["ENOTEMPTY", "EEXIST"].includes(areaMaker.storeRename), other?.status],
    ["STORE_NOT_GIT", true, "fulfilled"],
    JSON.stringify([areaMaker, other?.status === "rejected" ? String(other.reason) : "ok"]),
  );
  assert.deepEqual(readdirSync(projects), ["acme-toy"]);
  assert.deepEqual(readdirSync(areaOf(home)).sort(), [".git", "project.json", "state"]);
  assert.equal(bindingOf(home).project_root, projectRoot);
  assert.deepEqual(readdirSync(join(areaOf(home), "state")), [".gitignore"]);
  assert.deepEqual(readdirSync(projectRoot).sort(), [PROFILE_FILE_NAME, "memory"]);
  assert.equal(repositoryTop(store), store);
  folders.forEach((folder, index) => assert.deepEqual(snapshot(folder).filter((entry) => before[index].includes(entry)), before[index], folder));
});

// Two boots of the same root in two processes. The writer stops right after it opens the .gitignore of the state folder, or
// the file it writes it in, and before it writes; it is killed there. The other boot passed every check before that open and
// makes the state folder only after it.
const GITIGNORE_HOLD = `
const fs = require("node:fs");
const { role, opened, busUrl, graphUrl, options, stateDir } = JSON.parse(process.argv[1]);
const real = { openSync: fs.openSync, writeFileSync: fs.writeFileSync, mkdirSync: fs.mkdirSync };
const waitFor = (done) => { for (let k = 0; !done() && k < 3000; k++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); };
const isIgnore = (path) => typeof path === "string" && path.endsWith("/.gitignore");
if (role === "writer") {
  const descriptors = new Set();
  fs.openSync = (path, ...rest) => {
    const descriptor = real.openSync(path, ...rest);
    if (isIgnore(path)) descriptors.add(descriptor);
    return descriptor;
  };
  fs.writeFileSync = (target, data, options) => {
    if (typeof target === "number" ? !descriptors.has(target) : !isIgnore(target)) return real.writeFileSync(target, data, options);
    if (typeof target === "string") real.openSync(target, options?.flag ?? "w", options?.mode);
    real.writeFileSync(opened, "");
    waitFor(() => false);
    process.exit(1);
  };
} else
  fs.mkdirSync = (path, ...rest) => {
    if (path === stateDir) {
      real.writeFileSync(opened + ".waiting", "");
      waitFor(() => fs.existsSync(opened));
    }
    return real.mkdirSync(path, ...rest);
  };
require("node:module").syncBuiltinESMExports();
Promise.all([import(busUrl), import(graphUrl)])
  .then(([{ createBus }, { buildGraph }]) => createBus(options).then((bus) => bus.log.create("r1", { graph: buildGraph("L"), actor: { kind: "human", id: "ada@example.com" } })))
  .then(() => process.stdout.write("ok"), (error) => process.stdout.write(error.code ?? String(error)));
`;

test("[E5] [STATE-04] a boot killed between opening and writing the .gitignore of the state folder never leaves the state of another boot of the same root in git", async () => {
  const { cloneRoot } = fakeClone();
  const home = temporaryDirectory();
  const projectRoot = writeProject();
  const projects = join(home, ".cqstack", "projects");
  const opened = join(temporaryDirectory(), "opened");
  const boot = (role: "waiter" | "writer") => {
    const data = {
      role,
      opened,
      busUrl: new URL("../src/bus.js", import.meta.url).href,
      graphUrl: new URL("../src/graph.js", import.meta.url).href,
      options: { projectRoot, cloneRoot, homeDir: home },
      stateDir: join(areaOf(home), "state"),
    };
    const child = spawn(process.execPath, ["-e", GITIGNORE_HOLD, JSON.stringify(data)], { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    return { child, outcome: new Promise<string>((resolve) => child.on("close", () => resolve(output))) };
  };
  // the first boot makes the area and the binding, then waits to make the state folder; the writer boots meanwhile
  const first = boot("waiter");
  for (let waited = 0; !existsSync(opened + ".waiting") && first.child.exitCode === null && waited < 30_000; waited += 10)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const writer = boot("writer");
  try {
    assert.deepEqual([await first.outcome, existsSync(opened)], ["ok", true]);
  } finally {
    writer.child.kill("SIGKILL");
    await writer.outcome;
  }
  assert.equal(gitView(areaOf(home)), "");
  assert.equal(readFileSync(join(areaOf(home), "state", ".gitignore"), "utf8"), "*\n");
  // the killed boot leaves only the temporary folder it wrote in, beside the area and outside the git of the store
  const left = readdirSync(projects).filter((name) => name !== "acme-toy");
  assert.equal(left.length === 1 && left[0].startsWith(".acme-toy.partial-"), true, JSON.stringify(left));
  assert.deepEqual(readdirSync(join(projects, left[0])), [".gitignore"]);
  const bus = await createBus({ projectRoot, cloneRoot, homeDir: home });
  bus.log.create("r2", { graph: buildGraph("L"), actor: ADA });
  assert.equal(gitView(areaOf(home)), "");
});
