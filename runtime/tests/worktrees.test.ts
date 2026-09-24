import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Storage } from "../src/storage.js";
import { WorktreeManager } from "../src/worktrees/index.js";

const runGit = (cwd: string, args: string[]): string =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  }).trimEnd();

function fixture(): {
  root: string;
  repository: string;
  storage: Storage;
  manager: WorktreeManager;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cartera-worktrees-")));
  const repository = join(root, "repository");
  mkdirSync(repository);
  runGit(repository, ["init", "-q"]);
  writeFileSync(join(repository, "tracked.txt"), "initial\n");
  writeFileSync(join(repository, "deleted.txt"), "delete me\n");
  writeFileSync(join(repository, ".gitignore"), "ignored.txt\n");
  runGit(repository, ["add", "tracked.txt", "deleted.txt", ".gitignore"]);
  runGit(repository, [
    "-c",
    "user.name=Cartera Test",
    "-c",
    "user.email=test@cartera.local",
    "commit",
    "-q",
    "-m",
    "Initial commit",
  ]);
  const storage = new Storage(join(root, "storage"));
  return { root, repository, storage, manager: new WorktreeManager(storage) };
}

test("inspect reports canonical repository state and separates changed paths", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  writeFileSync(join(f.repository, "tracked.txt"), "changed\n");
  writeFileSync(join(f.repository, "new.txt"), "new\n");
  unlinkSync(join(f.repository, "deleted.txt"));
  const inspection = f.manager.inspect(f.repository);
  assert.equal(inspection.repository, f.repository);
  assert.match(inspection.HEAD, /^[0-9a-f]{40}$/);
  assert.deepEqual(inspection.dirty_files, ["deleted.txt", "tracked.txt"]);
  assert.deepEqual(inspection.untracked_files, ["new.txt"]);
  assert.deepEqual(inspection.deleted_files, ["deleted.txt"]);
});

test("create uses an explicit commit without copying dirty source changes and preserves contract version", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const head = runGit(f.repository, ["rev-parse", "HEAD"]);
  writeFileSync(join(f.repository, "tracked.txt"), "source-only change\n");
  const descriptor = f.manager.create({
    task_id: "task-1",
    role: "builder",
    repository: f.repository,
    base_ref: "HEAD",
    contract_version: "v3",
  });
  assert.equal(descriptor.base_commit, head);
  assert.equal(descriptor.contract_version, "v3");
  assert.equal(
    runGit(descriptor.path, ["show", "HEAD:tracked.txt"]),
    "initial"
  );
  assert.deepEqual(f.manager.list(), [descriptor]);
  f.manager.validate(descriptor);
  f.manager.remove(descriptor.id);
  assert.deepEqual(f.manager.list(), []);
});

test("create rejects option injection, symlink repositories, subdirectories, and required uncommitted input", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  assert.throws(
    () =>
      f.manager.create({
        task_id: "task",
        role: "builder",
        repository: f.repository,
        base_ref: "--help",
      }),
    /INVALID_BASE_REF/
  );
  assert.throws(
    () =>
      f.manager.create({
        task_id: "task",
        role: "builder",
        repository: f.repository,
        base_ref: "HEAD",
        requires_uncommitted_changes: true,
      }),
    /UNCOMMITTED_INPUT_REQUIRED/
  );
  mkdirSync(join(f.repository, "subdir"));
  assert.throws(
    () => f.manager.inspect(join(f.repository, "subdir")),
    /NOT_GIT_TOPLEVEL/
  );
  const link = join(f.root, "repository-link");
  symlinkSync(f.repository, link);
  assert.throws(() => f.manager.inspect(link), /SYMLINK_PATH_REJECTED/);
});

test("remove refuses dirty, ignored, moved, locked, and unknown worktrees", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));

  const dirty = f.manager.create({
    task_id: "dirty",
    role: "builder",
    repository: f.repository,
    base_ref: "HEAD",
  });
  writeFileSync(join(dirty.path, "untracked.txt"), "dirty\n");
  assert.throws(() => f.manager.remove(dirty.id), /WORKTREE_DIRTY/);
  rmSync(join(dirty.path, "untracked.txt"));
  writeFileSync(join(dirty.path, "tracked.txt"), "committed movement\n");
  runGit(dirty.path, ["add", "tracked.txt"]);
  runGit(dirty.path, [
    "-c",
    "user.name=Cartera Test",
    "-c",
    "user.email=test@cartera.local",
    "commit",
    "-q",
    "-m",
    "Ignore file",
  ]);
  assert.throws(() => f.manager.remove(dirty.id), /WORKTREE_HEAD_MOVED/);

  const ignored = f.manager.create({
    task_id: "ignored",
    role: "builder",
    repository: f.repository,
    base_ref: "HEAD",
  });
  writeFileSync(join(ignored.path, "ignored.txt"), "ignored but dirty\n");
  assert.throws(() => f.manager.remove(ignored.id), /WORKTREE_DIRTY/);

  const locked = f.manager.create({
    task_id: "locked",
    role: "builder",
    repository: f.repository,
    base_ref: "HEAD",
  });
  runGit(f.repository, ["worktree", "lock", locked.path]);
  assert.throws(() => f.manager.remove(locked.id), /WORKTREE_LOCKED/);
  runGit(f.repository, ["worktree", "unlock", locked.path]);
  f.manager.remove(locked.id);
  assert.throws(
    () => f.manager.remove("unknown"),
    /UNKNOWN_WORKTREE_OWNERSHIP/
  );
});

test("validate rejects descriptor tampering and unregistered paths without deleting ownership", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const descriptor = f.manager.create({
    task_id: "validate",
    role: "reviewer",
    repository: f.repository,
    base_ref: "HEAD",
  });
  assert.throws(
    () => f.manager.validate({ ...descriptor, role: "builder" }),
    /OWNERSHIP_DESCRIPTOR_MISMATCH/
  );
  runGit(f.repository, ["worktree", "remove", descriptor.path]);
  assert.throws(
    () => f.manager.validate(descriptor),
    /WORKTREE_PATH_MISSING|WORKTREE_NOT_REGISTERED/
  );
  assert.equal(f.manager.list().length, 1);
});

test("mutation authorization runs for create and remove", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  let calls = 0;
  const manager = new WorktreeManager(f.storage, () => {
    calls++;
  });
  const descriptor = manager.create({
    task_id: "authorized",
    role: "builder",
    repository: f.repository,
    base_ref: "HEAD",
  });
  manager.remove(descriptor.id);
  assert.equal(calls, 2);
  const denied = new WorktreeManager(f.storage, () => {
    throw new Error("MUTATION_DENIED");
  });
  assert.throws(
    () =>
      denied.create({
        task_id: "denied",
        role: "builder",
        repository: f.repository,
        base_ref: "HEAD",
      }),
    /MUTATION_DENIED/
  );
});

test("assertClean rejects ignored content and remove preserves active or quarantined worktrees", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const dirty = f.manager.create({
    task_id: "clean-check",
    role: "builder",
    repository: f.repository,
    base_ref: "HEAD",
  });
  writeFileSync(join(dirty.path, "ignored.txt"), "must count\n");
  assert.throws(() => f.manager.assertClean(dirty), /WORKTREE_DIRTY/);

  const active = f.manager.create({
    task_id: "active-task",
    role: "builder",
    repository: f.repository,
    base_ref: "HEAD",
  });
  f.storage.create(["execution-active-task.lock"], { owner: "test" });
  assert.throws(() => f.manager.remove(active.id), /ACTIVE_WORKTREE/);

  const quarantined = f.manager.create({
    task_id: "quarantine-task",
    role: "builder",
    repository: f.repository,
    base_ref: "HEAD",
  });
  f.storage.create(["quarantine", `${quarantined.id}.json`], {
    reason: "test",
  });
  assert.throws(() => f.manager.remove(quarantined.id), /QUARANTINED_WORKTREE/);
  assert.equal(
    f.manager.list().some((item) => item.id === quarantined.id),
    true
  );
});

test("validate requires the source shared git common directory and detached HEAD", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const descriptor = f.manager.create({
    task_id: "git-link",
    role: "builder",
    repository: f.repository,
    base_ref: "HEAD",
  });
  runGit(descriptor.path, ["switch", "-q", "-c", "unexpected-branch"]);
  assert.throws(() => f.manager.validate(descriptor), /WORKTREE_NOT_DETACHED/);

  const tampered = f.manager.create({
    task_id: "common-dir",
    role: "builder",
    repository: f.repository,
    base_ref: "HEAD",
  });
  const other = join(f.root, "other-repository");
  mkdirSync(other);
  runGit(other, ["init", "-q"]);
  writeFileSync(join(other, "other.txt"), "other\n");
  runGit(other, ["add", "other.txt"]);
  runGit(other, [
    "-c",
    "user.name=Cartera Test",
    "-c",
    "user.email=test@cartera.local",
    "commit",
    "-q",
    "-m",
    "Other",
  ]);
  writeFileSync(
    join(tampered.path, ".git"),
    `gitdir: ${join(other, ".git")}\n`
  );
  assert.throws(() => f.manager.validate(tampered), /GIT_COMMON_DIR_MISMATCH/);
});

test("ownership persistence failure leaves the created worktree for inspection", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.storage.create = () => {
    throw new Error("PERSISTENCE_DENIED");
  };
  assert.throws(
    () =>
      f.manager.create({
        task_id: "incomplete",
        role: "builder",
        repository: f.repository,
        base_ref: "HEAD",
      }),
    /WORKTREE_CREATION_INCOMPLETE: .*PERSISTENCE_DENIED/
  );
  assert.equal(readdirSync(f.storage.path("worktrees")).length, 1);
});
