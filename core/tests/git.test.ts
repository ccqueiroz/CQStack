import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { StateError } from "../src/storage.js";
import { readHarnessVersion } from "../src/git.js";

const temporaryDirectories: string[] = [];
after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

// Only PATH and fixed -c options: the user's git configuration never signs, prompts or prints hints here.
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@example.com",
      "-c", "commit.gpgsign=false",
      "-c", "tag.gpgsign=false",
      "-c", "init.defaultBranch=main",
      ...args,
    ],
    { cwd, env: { PATH: process.env.PATH ?? "" }, stdio: "pipe", encoding: "utf8" },
  );
}

function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "cqstack-git-")));
  temporaryDirectories.push(directory);
  return directory;
}

function repository(): string {
  const directory = temporaryDirectory();
  git(directory, "init", "--quiet");
  return directory;
}

function commit(directory: string, message: string): string {
  git(directory, "commit", "--allow-empty", "--quiet", "-m", message);
  return git(directory, "rev-parse", "HEAD").trim();
}

function expectUnavailable(promise: Promise<unknown>, label: string): Promise<void> {
  return assert.rejects(
    promise,
    (error: unknown) => error instanceof StateError && error.code === "HARNESS_VERSION_UNAVAILABLE",
    label,
  );
}

test("[VER-01] [ACTOR-10] on a tagged commit the version is the first tag and the full commit", async () => {
  const both = repository();
  const bothCommit = commit(both, "one");
  git(both, "tag", "-a", "v1.0.0-rc1", "-m", "rc1");
  git(both, "tag", "v1.0.0");
  assert.match(bothCommit, /^[0-9a-f]{40}$/);
  assert.deepEqual(await readHarnessVersion(both), { tag: "v1.0.0", commit: bothCommit });
  const light = repository();
  const lightCommit = commit(light, "one");
  git(light, "tag", "v2.0.0");
  assert.deepEqual(await readHarnessVersion(light), { tag: "v2.0.0", commit: lightCommit });
});

test("[VER-01] [ACTOR-12] off a tag the version has tag null and the full commit", async () => {
  const directory = repository();
  commit(directory, "one");
  git(directory, "tag", "v1.0.0");
  const next = commit(directory, "two");
  assert.deepEqual(await readHarnessVersion(directory), { tag: null, commit: next });
  const other = repository();
  commit(other, "elsewhere");
  git(other, "tag", "v3.0.0");
  const originalGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = join(other, ".git");
  try {
    assert.deepEqual(await readHarnessVersion(directory), { tag: null, commit: next });
  } finally {
    if (originalGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = originalGitDir;
  }
  // A git shim that answers as if HEAD moved to a tagged commit right after rev-parse: only the tags of the commit read count.
  const shim = temporaryDirectory();
  const readCommit = "a".repeat(40);
  writeFileSync(
    join(shim, "git"),
    `#!/bin/sh\nif [ "$1" = rev-parse ]; then echo ${readCommit}; elif [ "$3" = HEAD ]; then echo v-moved; fi\n`,
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  process.env.PATH = shim + delimiter + (originalPath ?? "");
  try {
    assert.deepEqual(await readHarnessVersion(directory), { tag: null, commit: readCommit });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("[VER-01] a relative clone root, a folder that is not a git clone or a clone without commits is refused with HARNESS_VERSION_UNAVAILABLE", async () => {
  await expectUnavailable(readHarnessVersion("relative/dir"), "relative");
  await expectUnavailable(readHarnessVersion(""), "empty");
  await expectUnavailable(readHarnessVersion(temporaryDirectory()), "not a clone");
  await expectUnavailable(readHarnessVersion(repository()), "no commit");
});
