import assert from "node:assert/strict";
import test from "node:test";
import { CodexProvider } from "../src/providers/codex.js";
import type { AgentExecutionRequest, AgentResult, MaintenancePatchResult } from "../src/contracts.js";
import { HARNESS_ROOT } from "../src/storage.js";
import { join } from "node:path";

const agentResult: AgentResult = {
  task_id: "PARSING", role: "opsx-implementation-worker", status: "completed", summary: "Parsed result",
  changed_files: [], evidence: [{ assertion: "Fixture", source: "test", observation: "Valid result" }], tests_executed: [], tests_not_executed: [],
  api_contract_status: "not_applicable", visual_lock_status: "not_applicable", scope_expanded: false,
  deviations: [], risks: [], known_issues: [], requested_followups: [],
};
const patch: MaintenancePatchResult = {
  kind: "maintenance-patch",
  edits: [{ relative_path: ".cartera/harness/example.ts", expected_before_hash: null, content: "// Escaped newline\nconst text = '{json}';\n" }],
  agent_result: agentResult,
};
const request = (maintenance = true): AgentExecutionRequest => ({
  capsule: {
    task_id: "PARSING", parent_task_id: "ROOT", role: "opsx-implementation-worker", responsibility: "Parsing", goal: "Parsing",
    inputs: [], required_context: [], allowed_paths: [".cartera/harness/example.ts"], forbidden_paths: [], existing_patterns: [],
    api_contract_reference: null, visual_lock_reference: null,
    constraints: maintenance ? ["CORE_INTERNAL_MAINTENANCE_V1"] : [], acceptance_criteria: [], owned_tests: [],
    permissions: "restricted-path-write", worktree: null, expected_output: "agent-result",
  },
  route: { provider: "codex", model_alias: "sol", model: "gpt-5.6-sol", role: {} as never, effort: null },
  cwd: process.cwd(), prompt: "Return JSON", result_schema_path: join(HARNESS_ROOT, "schemas/agent-result.schema.json"), timeout_ms: 1000,
});

// Protocol fixture, not a captured v3 stdout: that execution did not persist raw output.
// Format: https://developers.openai.com/codex/noninteractive/#make-output-machine-readable
const events = (payload: unknown) => [
  { type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Inspecting the source." } },
  { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "cat source.ts", aggregated_output: JSON.stringify({ kind: "untrusted-tool-output" }), exit_code: 0, status: "completed" } },
  { type: "item.completed", item: { id: "item_2", type: "agent_message", text: JSON.stringify(payload) } },
  { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 } },
];
const jsonl = (values: unknown[]) => values.map(value => JSON.stringify(value)).join("\n") + "\n";
const execute = (stdout: string, maintenance = true) => new CodexProvider(async input => {
  if (maintenance) assert.equal(input.args[input.args.indexOf("--sandbox") + 1], "read-only");
  return { stdout, stderr: "", exit_code: 0, signal: null };
}).execute(request(maintenance));

test("Codex JSONL reproduces the position-77 parse failure and returns the final maintenance payload", async () => {
  const stdout = jsonl(events(patch));
  assert.throws(() => JSON.parse(stdout), /Unexpected non-whitespace character after JSON at position 77/);
  assert.deepEqual(await execute(stdout), patch);
  assert.deepEqual(await execute(stdout.replaceAll("\n", "\r\n")), patch);
});

test("Codex accepts plain JSON and the existing last_message envelope", async () => {
  assert.deepEqual(await execute(JSON.stringify(patch, null, 2)), patch);
  assert.deepEqual(await execute(JSON.stringify({ last_message: JSON.stringify(patch) })), patch);
  assert.deepEqual(await execute(jsonl(events(agentResult)), false), agentResult);
});

test("Codex never substitutes a tool result or an earlier message for the final payload", async () => {
  const stream = events(patch);
  stream[4] = { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "Final response is not JSON" } };
  await assert.rejects(execute(jsonl(stream)), SyntaxError);
  const withoutAgent = events(patch).filter(event => event.item?.type !== "agent_message");
  await assert.rejects(execute(jsonl(withoutAgent)), /CODEX_FINAL_MESSAGE_MISSING/);
});

test("Codex rejects failed, incomplete, or malformed event streams", async () => {
  await assert.rejects(execute(jsonl(events(patch).slice(0, -1))), /CODEX_FINAL_MESSAGE_MISSING/);
  await assert.rejects(execute(jsonl([...events(patch), { type: "turn.started" }])), /CODEX_FINAL_MESSAGE_MISSING/);
  await assert.rejects(execute(jsonl([...events(patch), { type: "turn.failed", error: { message: "failed" } }])), /CODEX_STREAM_FAILED/);
  await assert.rejects(execute(jsonl([...events(patch), { type: "error", message: "failed" }])), /CODEX_STREAM_FAILED/);
  await assert.rejects(execute("prefix\n" + jsonl(events(patch))), SyntaxError);
  await assert.rejects(execute(jsonl(events(patch)) + '{"type":'), SyntaxError);
});

test("Codex validates the maintenance envelope and every edit before returning", async () => {
  for (const invalid of [
    null, {}, { ...patch, kind: "other" }, { ...patch, edits: {} },
    { ...patch, edits: [null] }, { ...patch, edits: [{ relative_path: "file.ts", content: "text" }] },
    { ...patch, edits: [{ ...patch.edits[0], relative_path: 1 }] },
    { ...patch, edits: [{ ...patch.edits[0], expected_before_hash: 1 }] },
    { ...patch, edits: [{ ...patch.edits[0], content: {} }] },
    { ...patch, agent_result: null },
  ]) await assert.rejects(execute(jsonl(events(invalid))), /INVALID_MAINTENANCE_PATCH/);
});

test("Codex validates the nested AgentResult against the canonical schema", async () => {
  await assert.rejects(execute(jsonl(events({ ...patch, agent_result: {} }))), /INVALID_AGENT_RESULT/);
  await assert.rejects(execute(jsonl(events({ ...patch, agent_result: { ...agentResult, status: "invented" } }))), /INVALID_AGENT_RESULT/);
  await assert.rejects(execute(jsonl(events({ ...patch, agent_result: { ...agentResult, deviations: [{}] } }))), /INVALID_AGENT_RESULT: agent-result: \/deviations\/0 must be string/);
});
