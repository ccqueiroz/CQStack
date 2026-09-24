import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Ajv } from "ajv";
import { AgentBus } from "../src/agent-bus/index.js";
import { CodexProvider } from "../src/providers/codex.js";
import { Storage } from "../src/storage.js";
import type { TaskCapsule } from "../src/contracts.js";

for (const [name, deviations, accepted] of [
  ["string deviations are accepted", ["Tests are run by the AgentBus after patch application."], true],
  ["object deviations are rejected without coercion", [{ reason: "Invalid object" }], false],
] as const) test(`maintenance output schema: ${name}`, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "cartera-maintenance-schema-test-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bus = new AgentBus(new Storage(directory));
  const capsule: TaskCapsule = {
    task_id: "SCHEMA", parent_task_id: "ROOT", role: "opsx-implementation-worker",
    responsibility: "Validate output contract", goal: "Validate output contract", inputs: [], required_context: [],
    allowed_paths: [".cartera/harness/README.md"], forbidden_paths: [], existing_patterns: [],
    api_contract_reference: null, visual_lock_reference: null,
    constraints: ["CORE_ENGINEERING_V1", "CORE_INTERNAL_MAINTENANCE_V1"], acceptance_criteria: [], owned_tests: [],
    permissions: "restricted-path-write", worktree: null, expected_output: "agent-result",
  };
  // Exercise the same canonical wire projection that AgentBus supplies to providers.
  const schemaPath = (bus as unknown as { providerSchema(c: TaskCapsule, provider: string): string }).providerSchema(capsule, "codex");
  const result = {
    task_id: capsule.task_id, role: capsule.role, status: "completed", summary: "Valid fixture",
    changed_files: [], evidence: [{ assertion: "Fixture", source: "test", observation: "Contract check" }],
    tests_executed: [], tests_not_executed: [], api_contract_status: "not_applicable", visual_lock_status: "not_applicable",
    scope_expanded: false, deviations, risks: [], known_issues: [], requested_followups: [], proposal_deviation: null,
  };
  const payload = { kind: "maintenance-patch", edits: [{ relative_path: ".cartera/harness/README.md", expected_before_hash: null, content: "Fixture" }], agent_result: result };
  let outputSchemaPath = "";
  const provider = new CodexProvider(async request => {
    outputSchemaPath = request.args[request.args.indexOf("--output-schema") + 1];
    assert.notEqual(outputSchemaPath, schemaPath);
    assert.equal(request.args[request.args.indexOf("--sandbox") + 1], "read-only");
    const schema = JSON.parse(readFileSync(outputSchemaPath, "utf8"));
    assert.equal(schema.properties.edits.minItems, 1);
    assert.deepEqual(schema.properties.agent_result.properties.deviations, { type: "array", items: { type: "string" } });
    assert.ok(schema.properties.agent_result.required.includes("deviations"));
    const validate = new Ajv({ allErrors: true }).compile(schema);
    assert.equal(validate(payload), accepted);
    if (!accepted) assert.ok(validate.errors?.some(e => e.instancePath === "/agent_result/deviations/0" && e.keyword === "type"));
    assert.equal(validate({ ...payload, edits: [] }), false);
    assert.ok(validate.errors?.some(e => e.instancePath === "/edits" && e.keyword === "minItems"));
    // An invalid double deliberately ignores the generation schema: the return boundary must still reject it.
    return { exit_code: 0, signal: null, stderr: "", stdout: JSON.stringify(payload) };
  });
  const execution = provider.execute({ capsule, route: bus.router.resolve(capsule.role, "codex"), cwd: process.cwd(),
    prompt: "Return the maintenance patch", result_schema_path: schemaPath, timeout_ms: 1000 });
  if (accepted) assert.deepEqual(await execution, payload);
  else await assert.rejects(execution, /INVALID_AGENT_RESULT: agent-result: \/deviations\/0 must be string/);
  assert.equal(existsSync(outputSchemaPath), false);
  assert.deepEqual(result.deviations, deviations);
});
