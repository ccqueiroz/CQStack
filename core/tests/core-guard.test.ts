import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FORBIDDEN_TERMS: ReadonlyArray<readonly [length: number, sha256: string]> =
  [[7, "c5fa8aba36db1004d4af8e7131d2fcc7cdcdc5db1c90a9e10364b6421232e701"]]; // ponytail: only the known old name; a new term is a new pair
// The slashes are escaped, so this source line never matches itself.
const USER_HOME_PATH = /(?:\/(?:Users|home)\/|[A-Za-z]:\\{1,2}Users\\{1,2})[^\s\/\\"'`]+/;
const LEGACY_PATHS = ["README.md", "config", "docs", "examples", "governance", "mcp", "runtime", "scripts"];
const BASE_COMMIT = "f291a38d40e80149326a72cb8a8ddea3de9146a4";
const FICTITIOUS_TERMS = [[7, createHash("sha256").update("zorblax").digest("hex")]] as const;

function listRepositoryFiles(root: string): string[] {
  const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  });
  return [...new Set(output.split("\0").filter((file) => file !== ""))];
}

function findViolations(
  root: string,
  files: string[],
  terms: ReadonlyArray<readonly [number, string]>,
  legacyPaths: readonly string[],
): string[] {
  const termsAreValid =
    terms.length > 0 &&
    terms.every(([length, sha256]) => Number.isInteger(length) && length >= 1 && length <= 64 && /^[0-9a-f]{64}$/.test(sha256));
  if (!termsAreValid) throw new Error("GUARD_TERMS_INVALID");

  const termMatches = (line: string) => {
    const matches: Array<{ termIndex: number; start: number; length: number }> = [];
    for (const run of line.toLowerCase().matchAll(/[a-z0-9]+/g)) {
      terms.forEach(([length, sha256], termIndex) => {
        for (let offset = 0; offset + length <= run[0].length; offset++) {
          const window = run[0].slice(offset, offset + length);
          if (createHash("sha256").update(window).digest("hex") === sha256) {
            matches.push({ termIndex, start: run.index + offset, length });
          }
        }
      });
    }
    return matches;
  };

  const violations: string[] = [];
  for (const file of files) {
    if (legacyPaths.some((entry) => file === entry || file.startsWith(entry + "/"))) continue;
    const absolutePath = join(root, file);
    // ponytail: symbolic links are skipped whole (content and path); scan their targets when a slice brings tracked links
    if (!lstatSync(absolutePath, { throwIfNoEntry: false })?.isFile()) continue;
    let citedPath = file;
    for (const { start, length } of termMatches(file)) {
      citedPath = citedPath.slice(0, start) + "*".repeat(length) + citedPath.slice(start + length);
    }
    const lines = [file, ...readFileSync(absolutePath, "utf8").split("\n")];
    lines.forEach((line, lineNumber) => {
      if (USER_HOME_PATH.test(line)) violations.push(`${citedPath}:${lineNumber}: user home path`);
      const matchedTermIndexes = new Set(termMatches(line).map((match) => match.termIndex));
      terms.forEach((_, termIndex) => {
        if (matchedTermIndexes.has(termIndex)) violations.push(`${citedPath}:${lineNumber}: forbidden term #${termIndex}`);
      });
    });
  }
  return violations;
}

const temporaryDirectories: string[] = [];
after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function directoryWithFiles(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "cqstack-guard-"));
  temporaryDirectories.push(directory);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
  return directory;
}

function readJson(relativePath: string): any {
  return JSON.parse(readFileSync(join(REPOSITORY_ROOT, relativePath), "utf8"));
}

test("[GATE-01] npm test compiles only core/ and runs only the compiled core tests", () => {
  const packageJson = readJson("package.json");
  const coreTsconfig = readJson("core/tsconfig.json");
  assert.equal(packageJson.scripts.test, "tsc -p core/tsconfig.json && node --test dist/core/tests/*.test.js");
  assert.equal(coreTsconfig.compilerOptions.rootDir, ".");
  assert.equal(coreTsconfig.compilerOptions.outDir, "../dist/core");
  assert.deepEqual(coreTsconfig.include, ["src/**/*.ts", "tests/**/*.ts"]);
});

test("[NAME-01] package.json and the root package in package-lock.json are named cqstack", () => {
  const packageLock = readJson("package-lock.json");
  assert.equal(readJson("package.json").name, "cqstack");
  assert.equal(packageLock.name, "cqstack");
  assert.equal(packageLock.packages[""].name, "cqstack");
});

test("[DOC-01] the README says npm test compiles core/ and runs only its tests", () => {
  const readme = readFileSync(join(REPOSITORY_ROOT, "README.md"), "utf8");
  assert.ok(readme.includes("`npm test` compiles `core/` and runs only the tests in `core/`."));
  assert.ok(
    readme.includes(
      "`npm test` runs only the tests in `core/`; the `runtime/` suite and `scripts/final-gate.sh` describe the previous runtime and are not the gate.",
    ),
  );
});

test("[GUARD-02] [GUARD-06] the real repository lists this file and both package files outside LEGACY_PATHS and has no violations", () => {
  const files = listRepositoryFiles(REPOSITORY_ROOT);
  for (const file of ["core/tests/core-guard.test.ts", "package.json", "package-lock.json"]) {
    assert.ok(files.includes(file), `${file} is not in the repository file list`);
  }
  assert.ok(!LEGACY_PATHS.includes("package.json"));
  assert.ok(!LEGACY_PATHS.includes("package-lock.json"));
  assert.deepEqual(findViolations(REPOSITORY_ROOT, files, FORBIDDEN_TERMS, LEGACY_PATHS), []);
});

test("[GUARD-01] the stored hash finds the old package name in package.json at the base commit", () => {
  const basePackageJson = execFileSync("git", ["show", `${BASE_COMMIT}:package.json`], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  const directory = directoryWithFiles({ "package.json": basePackageJson });
  assert.deepEqual(findViolations(directory, ["package.json"], FORBIDDEN_TERMS, []), [
    "package.json:2: forbidden term #0",
  ]);
});

test("[GUARD-01] a fictitious term is found in content and in file paths, in any case and glued to other words, without printing it", () => {
  const files = {
    "a.txt": "first line\nZORBLAX_STATE=1",
    "b.json": '{"name": "@zorblax/pkg"}',
    "c.txt": "prefixzorblaxsuffix",
    "d.txt": "zor blax",
    "zorblax-notes.md": "clean\nzorblax again",
  };
  const violations = findViolations(directoryWithFiles(files), Object.keys(files), FICTITIOUS_TERMS, []);
  assert.deepEqual(violations, [
    "a.txt:2: forbidden term #0",
    "b.json:1: forbidden term #0",
    "c.txt:1: forbidden term #0",
    "*******-notes.md:0: forbidden term #0",
    "*******-notes.md:2: forbidden term #0",
  ]);
  for (const violation of violations) assert.doesNotMatch(violation, /zorblax/i);
});

test("[GUARD-03] an empty or malformed term list throws GUARD_TERMS_INVALID", () => {
  const validHash = FICTITIOUS_TERMS[0][1];
  const directory = directoryWithFiles({});
  const malformedLists: Array<ReadonlyArray<readonly [number, string]>> = [
    [],
    [[7, "abc"]],
    [[0, validHash]],
    [[65, validHash]],
    [[7.5, validHash]],
    [[7, validHash.toUpperCase()]],
  ];
  for (const terms of malformedLists) {
    assert.throws(() => findViolations(directory, [], terms, []), { message: "GUARD_TERMS_INVALID" });
  }
});

test("[GUARD-04] user home paths built at runtime are found; the local cqstack area is not", () => {
  const lines = [
    ["", "home", "someone", "x"].join("/"),
    ["", "Users", "someone", "x"].join("/"),
    ["C:", "Users", "someone", "x"].join("\\"),
    JSON.stringify({ path: ["C:", "Users", "someone", "demo"].join("\\") }),
    "~/.cqstack/projects/x/",
    ["", "Users", "someone"].join("/"),
    JSON.stringify({ path: ["", "home", "someone"].join("/") }),
    ["C:", "Users", "someone"].join("\\"),
    JSON.stringify({ path: ["C:", "Users", "someone"].join("\\") }),
  ];
  const directory = directoryWithFiles({ "paths.txt": lines.join("\n") });
  assert.deepEqual(findViolations(directory, ["paths.txt"], FORBIDDEN_TERMS, []), [
    "paths.txt:1: user home path",
    "paths.txt:2: user home path",
    "paths.txt:3: user home path",
    "paths.txt:4: user home path",
    "paths.txt:6: user home path",
    "paths.txt:7: user home path",
    "paths.txt:8: user home path",
    "paths.txt:9: user home path",
  ]);
});

test("[GUARD-05] only files under a legacy entry are skipped", () => {
  const files = { "legacy/a.txt": "zorblax", "legacy-new/a.txt": "zorblax", "other/a.txt": "zorblax", "single.txt": "zorblax" };
  const violations = findViolations(directoryWithFiles(files), Object.keys(files), FICTITIOUS_TERMS, ["legacy", "single.txt"]);
  assert.deepEqual(violations, ["legacy-new/a.txt:1: forbidden term #0", "other/a.txt:1: forbidden term #0"]);
});

test("[GUARD-05] the file list has tracked and untracked files and leaves out ignored ones", () => {
  const directory = directoryWithFiles({ "tracked.txt": "t", "untracked.txt": "u", ".gitignore": "ignored.txt\n", "ignored.txt": "i" });
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  execFileSync("git", ["add", "tracked.txt"], { cwd: directory });
  assert.deepEqual(listRepositoryFiles(directory).sort(), [".gitignore", "tracked.txt", "untracked.txt"]);
});

test("[GUARD-05] symbolic links and files missing from the working tree are skipped without error", () => {
  const directory = directoryWithFiles({ "real.txt": "zorblax" });
  symlinkSync("real.txt", join(directory, "link.txt"));
  assert.deepEqual(findViolations(directory, ["real.txt", "link.txt", "gone.txt"], FICTITIOUS_TERMS, []), [
    "real.txt:1: forbidden term #0",
  ]);
});

test("[GUARD-05] [GUARD-06] with the real LEGACY_PATHS, files under core/src/ and core/tests/ are scanned", () => {
  const files = { "core/src/profile.ts": "zorblax", "core/tests/core-guard.test.ts": "zorblax" };
  assert.deepEqual(findViolations(directoryWithFiles(files), Object.keys(files), FICTITIOUS_TERMS, LEGACY_PATHS), [
    "core/src/profile.ts:1: forbidden term #0",
    "core/tests/core-guard.test.ts:1: forbidden term #0",
  ]);
});

test("[GUARD-06] listing files outside a git repository throws", () => {
  const directory = directoryWithFiles({ "file.txt": "x" });
  const originalCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(directory);
  try {
    assert.throws(() => listRepositoryFiles(directory));
  } finally {
    if (originalCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = originalCeiling;
  }
});
