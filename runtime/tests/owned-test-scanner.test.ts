import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertFixtureTestSafe } from "../src/workflow/engineering/service.js";

const SAFE_TEST = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { paginate } from '../src/pagination.mjs';\ntest('pages', () => { assert.deepEqual(paginate([1], 0, 1).content, [1]); });\n";
const SAFE_SOURCE = "export function paginate(items, page = 0, size = 20) { return { content: items.slice(page * size, page * size + size), page, size, totalElements: items.length }; }\n";

function worktree(files: Record<string, string>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cartera-scanner-test-")));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return { root, clean: () => rmSync(root, { recursive: true, force: true }) };
}
function scan(files: Record<string, string>, allowed: string[], testPath = "tests/pagination.test.mjs") {
  const w = worktree(files);
  try { assertFixtureTestSafe(w.root, allowed, join(w.root, testPath)); } finally { w.clean(); }
}

test("owned-test scanner accepts the fixture test, scans directory allowed paths and ignores allowed paths not created yet", () => {
  scan({ "tests/pagination.test.mjs": SAFE_TEST, "src/pagination.mjs": SAFE_SOURCE }, ["src", "tests/pagination.test.mjs", "src/client.mjs"]);
});

test("owned-test scanner names a missing test or imported module instead of a raw ENOENT", () => {
  assert.throws(() => scan({ "src/pagination.mjs": SAFE_SOURCE }, ["src"]), /^Error: OWNED_TEST_MODULE_MISSING: tests\/pagination\.test\.mjs$/);
  assert.throws(() => scan({ "tests/pagination.test.mjs": SAFE_TEST }, ["tests"]), /^Error: OWNED_TEST_MODULE_MISSING: src\/pagination\.mjs$/);
});

test("owned-test scanner rejects dangerous identifiers that a prefix match such as process. misses", () => {
  for (const [label, source, reason] of [
    ["aliased process", "const p = process; p.exit(1);\n" + SAFE_SOURCE, "process"],
    ["computed global", "global['pro' + 'cess'].exit(1);\n" + SAFE_SOURCE, "global"],
    ["computed globalThis", "globalThis ['fetch']('http://example.test');\n" + SAFE_SOURCE, "globalThis"],
    ["code hidden after a string containing //", "const url = 'x//'; process.exit(1);\n" + SAFE_SOURCE, "process"],
    ["Function constructor", "const run = Function; run('return 1')();\n" + SAFE_SOURCE, "Function"],
  ] as const) {
    assert.throws(() => scan({ "tests/pagination.test.mjs": SAFE_TEST, "src/pagination.mjs": source }, ["src", "tests"]),
      new RegExp(`^Error: UNSAFE_FIXTURE_TEST: src/pagination\\.mjs: ${reason}$`), label);
  }
});

test("owned-test scanner follows relative imports outside allowed_paths and rejects non-test modules and imports leaving the worktree", () => {
  const helper = SAFE_TEST.replace("../src/pagination.mjs", "../lib/helper.mjs");
  assert.throws(() => scan({ "tests/pagination.test.mjs": helper, "lib/helper.mjs": "import { spawn } from 'node:child_process';\nexport const paginate = () => spawn('sh');\n" }, ["tests"]),
    /^Error: UNSAFE_FIXTURE_TEST: lib\/helper\.mjs: child_process$/);
  assert.throws(() => scan({ "tests/pagination.test.mjs": "import { readFileSync } from 'fs';\n" + SAFE_TEST, "src/pagination.mjs": SAFE_SOURCE }, ["tests"]),
    /^Error: UNSAFE_FIXTURE_TEST: tests\/pagination\.test\.mjs: import fs$/);
  assert.throws(() => scan({ "tests/pagination.test.mjs": SAFE_TEST.replace("../src/pagination.mjs", "../../outside.mjs") }, ["tests"]),
    /^Error: UNSAFE_FIXTURE_TEST: tests\/pagination\.test\.mjs: import outside the worktree \.\.\/\.\.\/outside\.mjs$/);
});
