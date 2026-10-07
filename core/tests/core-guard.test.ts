import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

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
