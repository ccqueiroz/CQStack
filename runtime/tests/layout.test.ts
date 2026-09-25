import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_PREFIX, HARNESS_ROOT, WORKSPACE_ROOT, harnessPath, resolveLayout } from "../src/storage.js";
import { doctorTargets } from "../src/doctor.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "cartera-layout-suite-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

// A copy resolves HARNESS_ROOT from its own dist, so its module constants follow its own runtime.json.
function harnessCopy(destination: string, runtime: (current: Record<string, unknown>) => Record<string, unknown>): string {
  const ignored = ["state", "artifacts", "scratchpad", "node_modules", ".git"].map(name => join(HARNESS_ROOT, name));
  cpSync(HARNESS_ROOT, destination, { recursive: true, verbatimSymlinks: true, filter: source => !ignored.includes(source) });
  symlinkSync(join(HARNESS_ROOT, "node_modules"), join(destination, "node_modules"));
  const file = join(destination, "config/runtime.json");
  writeFileSync(file, JSON.stringify(runtime(JSON.parse(readFileSync(file, "utf8")))));
  return destination;
}

function runIn(harness: string, script: string) {
  const prelude = `import { join } from "node:path"; import { pathToFileURL } from "node:url";
const H = process.argv[1]; const load = p => import(pathToFileURL(join(H, "dist/runtime/src", p)).href);`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", prelude + script, harness], { encoding: "utf8" });
}

test("resolveLayout keeps the embedded default and derives the logical harness prefix", () => {
  const harness = "/w/.cartera/harness";
  assert.deepEqual(resolveLayout(harness, {}), { workspaceRoot: "/w", harnessPrefix: ".cartera/harness" });
  assert.deepEqual(resolveLayout(harness, { workspace: { root: "../.." } }), { workspaceRoot: "/w", harnessPrefix: ".cartera/harness" });
  assert.deepEqual(resolveLayout(harness, { workspace: { root: "/w" } }), { workspaceRoot: "/w", harnessPrefix: ".cartera/harness" });
  assert.deepEqual(resolveLayout(harness, { workspace: { root: "." } }), { workspaceRoot: harness, harnessPrefix: "" });
});

test("resolveLayout rejects a workspace that does not contain the harness", () => {
  const harness = "/w/.cartera/harness";
  for (const root of ["runtime", "../other", "/elsewhere"])
    assert.throws(() => resolveLayout(harness, { workspace: { root } }), /WORKSPACE_ROOT_MUST_CONTAIN_HARNESS/, root);
});

test("resolveLayout is the only validation of the workspace configuration", () => {
  for (const runtime of [{ workspace: { root: "" } }, { workspace: { root: 1 } }, { workspace: "x" }, { workspace: null }, { workspace: [] }])
    assert.throws(() => resolveLayout("/w/.cartera/harness", runtime), /INVALID_RUNTIME_CONFIG/, JSON.stringify(runtime));
});

test("the running harness uses the embedded layout of this workspace", () => {
  assert.equal(HARNESS_PREFIX, ".cartera/harness");
  assert.equal(join(WORKSPACE_ROOT, HARNESS_PREFIX), HARNESS_ROOT);
  assert.equal(harnessPath("README.md"), ".cartera/harness/README.md");
});

test("doctor targets come from the declared repositories and the workspace MCP configuration", () => {
  assert.deepEqual(doctorTargets({ repositories: [] }, "/w"), { repositories: [], mcp: "/w/.mcp.json" });
  assert.deepEqual(doctorTargets({ repositories: ["a"] }, "/w"), { repositories: [{ name: "a", path: "/w/a" }], mcp: "/w/.mcp.json" });
});

test("a standalone copy runs with an empty prefix, a README smoke and closed diagnosis boundaries", () => {
  const harness = harnessCopy(join(scratch, "cq"), current => ({ ...current, workspace: { root: "." }, repositories: [] }));
  const run = runIn(harness, `
const { HARNESS_PREFIX, WORKSPACE_ROOT, HARNESS_ROOT, Storage } = await load("storage.js");
const { smokeCapsule } = await load("providers/smoke.js");
const { AgentBus } = await load("agent-bus/index.js");
const { ExecutionGrants } = await load("execution/grants.js");
const { doctorTargets } = await load("doctor.js");
const { readFileSync, mkdtempSync } = await import("node:fs");
const storage = new Storage(mkdtempSync(join(H, "..", "standalone-state-")));
const bus = new AgentBus(storage, {});
const grants = new ExecutionGrants(storage, () => bus.runtime.model_execution_enabled);
const issuer = "trusted-operator-cli";
const smoke = smokeCapsule("codex", "LAYOUT-SMOKE");
bus.init(smoke, "codex");
const smokeGrant = grants.issue(smoke, smoke, bus.routeFor(smoke), "fixed-smoke", issuer, "Standalone layout test only");
const root = { ...smokeCapsule("codex", "LAYOUT-ROOT"), role: "master-orchestrator", constraints: ["CORE_UNDERSTANDING_ROOT_V1"] };
bus.init(root);
const internal = "runtime/src/execution/grants.ts";
const child = { ...smokeCapsule("codex", "LAYOUT-CHILD"), parent_task_id: root.task_id, role: "truth",
  responsibility: "Read one file", goal: "Read-only diagnosis", allowed_paths: [internal], required_context: [internal], constraints: ["Read only."] };
bus.init(child);
const route = bus.routeFor(child);
// Same shape as the embedded refusals: the initialized capsule is widened afterwards, so issuance itself must refuse.
const attempt = path => {
  try {
    return grants.issue({ ...child, allowed_paths: [path], required_context: [path] }, root, route, "orchestrated-read-only-diagnosis", issuer, "Standalone layout test only").execution_mode;
  } catch (error) { return error.message; }
};
const refusals = { git: attempt(".git"), harness_root: attempt("."), traversal: attempt("../outside") };
console.log(JSON.stringify({ prefix: HARNESS_PREFIX, workspace_is_harness: WORKSPACE_ROOT === HARNESS_ROOT,
  smoke_paths: [smoke.required_context, smoke.allowed_paths], smoke_grant: smokeGrant.execution_mode,
  ...refusals, internal: attempt(internal),
  doctor: doctorTargets(JSON.parse(readFileSync(join(H, "config/runtime.json"), "utf8")), WORKSPACE_ROOT) }));`);
  assert.equal(run.status, 0, run.stderr);
  const observed = JSON.parse(run.stdout);
  assert.equal(observed.prefix, "");
  assert.equal(observed.workspace_is_harness, true);
  assert.deepEqual(observed.smoke_paths, [["README.md"], ["README.md"]]);
  assert.equal(observed.smoke_grant, "fixed-smoke");
  assert.equal(observed.internal, "orchestrated-read-only-diagnosis");
  assert.match(observed.git, /EXECUTION_GRANT_DIAGNOSIS_PATH_REQUIRED/);
  assert.match(observed.harness_root, /EXECUTION_GRANT_DIAGNOSIS_PATH_REQUIRED/);
  // Standalone has no path inside the workspace but outside the harness; traversal is closed earlier, at the workspace boundary.
  assert.match(observed.traversal, /INVALID_SCOPE_PATH/);
  assert.deepEqual(observed.doctor, { repositories: [], mcp: join(harness, ".mcp.json") });
});

test("a copy whose workspace root is inside the harness fails at load without creating state", () => {
  const harness = harnessCopy(join(scratch, "invalid"), current => ({ ...current, workspace: { root: "runtime" } }));
  const run = runIn(harness, `await load("agent-bus/index.js");`);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /WORKSPACE_ROOT_MUST_CONTAIN_HARNESS/);
  assert.equal(existsSync(join(harness, "state")), false);
});

test("review subject records absent optional governance files and changes when one appears", () => {
  const workspace = join(scratch, "ws");
  const harness = harnessCopy(join(workspace, ".cartera/harness"), current => current);
  const run = runIn(harness, `
const { snapshot } = await load("workflow/artifacts.js");
const { hash } = await load("storage.js");
const { writeFileSync } = await import("node:fs");
const optional = ["AGENTS.md", "CLAUDE.md", ".cartera/harness/artifacts/phase-2-completion-workspace-preservation.json"];
const before = snapshot(optional, [], optional);
writeFileSync(join(H, "../../AGENTS.md"), "# appeared during review\\n");
const afterAppearing = snapshot(optional, [], optional);
console.log(JSON.stringify({ before, changed: hash(before) !== hash(afterAppearing), agents: afterAppearing["AGENTS.md"] }));`);
  assert.equal(run.status, 0, run.stderr);
  const observed = JSON.parse(run.stdout);
  assert.deepEqual(observed.before, { "AGENTS.md": "absent", "CLAUDE.md": "absent", ".cartera/harness/artifacts/phase-2-completion-workspace-preservation.json": "absent" });
  assert.equal(observed.changed, true);
  assert.notEqual(observed.agents, "absent");
});
