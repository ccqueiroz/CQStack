import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentBus } from "../dist/runtime/src/agent-bus/index.js";
import { HARNESS_ROOT, hash } from "../dist/runtime/src/storage.js";
import { ExecutionGrants } from "../dist/runtime/src/execution/grants.js";
import { checkFileEvidence } from "../dist/runtime/src/validation/evidence.js";

const bus = new AgentBus();
const task = "PHASE2-ISOLATED-FINAL-smoke-readme-discovery-tests";
const root = "PHASE2-ISOLATED-FINAL";
const artifact = name => join(HARNESS_ROOT, "artifacts", name);
const capsule = bus.events.get(task).capsule;
const result = bus.result(task);
const events = bus.events.list(task);
const one = type => {
  const matches = events.filter(e => e.event_type === type);
  assert.equal(matches.length, 1, type);
  return matches[0];
};
const issued = one("execution.grant.issued"), consumed = one("execution.grant.consumed");
const delegated = one("agent.delegated"), started = one("agent.started");
const validated = one("agent.result.validated"), completed = one("agent.completed");
assert.ok(events.indexOf(consumed) < events.indexOf(started));
const grant = bus.storage.read("execution-grants", task + ".json");
const receipt = bus.storage.read("execution-grant-consumptions", task + ".json");
const route = bus.router.resolve(capsule.role);
assert.equal(grant.capsule_hash, hash(capsule));
assert.equal(grant.root_capsule_hash, hash(bus.events.get(root).capsule));
assert.equal(grant.route_hash, hash(route));
assert.equal(grant.provider, "codex");
assert.equal(grant.model_alias, "luna");
assert.equal(grant.model, "gpt-5.6-luna");
assert.equal(issued.payload.grant_hash, hash(grant));
assert.equal(receipt.grant_hash, hash(grant));
assert.equal(receipt.usage_state, "consumed");
assert.deepEqual(receipt, consumed.payload);
assert.equal(delegated.payload.execution_grant_hash, hash(grant));
assert.equal(delegated.payload.model_execution_enabled, false);
assert.equal(bus.runtime.model_execution_enabled, false);
assert.equal(capsule.permissions, "read-only");
assert.equal(capsule.worktree, null);
assert.equal(result.status, "completed");
assert.equal(result.task_id, task);
assert.equal(result.role, capsule.role);
assert.deepEqual(result.changed_files, []);
assert.equal(result.scope_expanded, false);
for (const item of result.evidence) checkFileEvidence(item.source, capsule, resolve(HARNESS_ROOT, "../.."));
assert.equal(validated.payload.result_hash, hash(result));
assert.equal(validated.payload.capsule_hash, hash(capsule));
assert.equal(validated.payload.execution_event_id, started.event_id);
assert.equal(completed.payload.result_hash, hash(result));
assert.throws(() => new ExecutionGrants(bus.storage).eligible(capsule, bus.events.get(root).capsule, route), /EXECUTION_GRANT_CONSUMED/);
const observedEvent = one("provider.observed");
const observation = bus.storage.read("provider-observations", observedEvent.payload.artifact);
assert.equal(hash(observation), observedEvent.payload.content_hash);
assert.equal(observation.exit_code, 0);
assert.equal(observation.provider, "codex");
assert.equal(observation.model, grant.model);
assert.equal(observation.args[observation.args.indexOf("--sandbox") + 1], "read-only");
assert.equal(observation.tool_calls.length, 1);
assert.equal(observation.tool_calls[0].command, "/bin/zsh -lc 'nl -ba .cartera/harness/README.md'");

function invocation(number) {
  const name = `fable-grant-headless-${number}.jsonl`;
  const rows = readFileSync(artifact(name), "utf8").trim().split("\n").map(JSON.parse);
  const end = rows.findLast(r => r.type === "result");
  assert.ok(end, `invocation ${number} finished`);
  assert.equal(end.is_error, false);
  assert.equal(end.subtype, "success");
  assert.deepEqual(end.permission_denials, []);
  assert.ok(end.modelUsage["claude-fable-5-1"]);
  const uses = rows.flatMap(r => r.type === "assistant" ? r.message.content.filter(c => c.type === "tool_use") : []);
  const responses = rows.flatMap(r => r.type === "user" ? r.message.content.filter(c => c.type === "tool_result") : []);
  assert.ok(uses.length > 0);
  assert.ok(uses.every(u => ["task_get", "task_events", "agent_delegate", "agent_result", "roles"].map(n => "mcp__cartera__" + n).includes(u.name)));
  assert.ok(responses.every(r => !r.is_error));
  const output = use => {
    const response = responses.find(r => r.tool_use_id === use.id);
    assert.ok(response, "MCP response exists");
    const content = typeof response.content === "string" ? response.content : response.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    return JSON.parse(content);
  };
  const json = /```json\s*([\s\S]*?)```/.exec(end.result)?.[1] ?? end.result;
  return { name, end, uses, output, decision: JSON.parse(json), trace_hash: hash(rows) };
}
const invocations = [1, 2, 3].map(invocation);
assert.equal(new Set(invocations.map(i => i.end.session_id)).size, 3);
for (const i of invocations) {
  const executions = i.uses.filter(u => u.name === "mcp__cartera__agent_delegate" && u.input.dry_run === false);
  assert.equal(executions.length, i === invocations[1] ? 1 : 0);
  if (executions.length) {
    assert.equal(executions[0].input.task_id, task);
    assert.deepEqual(i.output(executions[0]), result);
  }
}
const consumer = invocations[2];
const retrieval = consumer.uses.find(u => u.name === "mcp__cartera__agent_result" && u.input.task_id === task);
assert.ok(retrieval);
assert.deepEqual(consumer.output(retrieval), result);
assert.equal(consumer.decision.child_task_id, task);
assert.equal(consumer.decision.global_model_execution_enabled, false);
assert.equal(consumer.decision.lifecycle_execution_started, false);
assert.equal(consumer.decision.grant_usage_state, "consumed");
assert.equal(consumer.decision.handoff_verdict, "PASS");
assert.equal(consumer.decision.orchestration_owner, "fable:master-orchestrator");
assert.equal(consumer.decision.follow_up_decision.accept_ownership, true);
assert.deepEqual(consumer.decision.AgentResult, result);
assert.equal(consumer.decision.validation_receipt_event_id, validated.event_id);
assert.equal(consumer.decision.completion_event_id, completed.event_id);
assert.equal(consumer.decision.consumption_event_id, consumed.event_id);

const tap = readFileSync(artifact("controlled-execution-grant-final-tests.tap"), "utf8");
const count = field => Number(new RegExp(`^# ${field} (\\d+)$`, "m").exec(tap)?.[1]);
assert.equal(count("tests"), 108);
assert.equal(count("pass"), 108);
assert.equal(count("fail"), 0);
const summary = {
  root_task_id: root, child_task_id: task, global_model_execution_enabled: false,
  grant_hash: hash(grant), capsule_hash: hash(capsule), result_hash: hash(result),
  grant_usage_state: receipt.usage_state, grant_reuse: "denied by authorization validation; no provider retry",
  provider: observation.provider, model: observation.model, provider_exit_code: observation.exit_code,
  validation_event_id: validated.event_id, completion_event_id: completed.event_id,
  consumption_event_id: consumed.event_id,
  invocations: invocations.map(i => ({ artifact: i.name, session_id: i.end.session_id, trace_hash: i.trace_hash, authenticated_model: "claude-fable-5-1", permission_denials: i.end.permission_denials, tool_calls: i.uses.map(u => ({ name: u.name, input: u.input })), decision: i.decision })),
  tests: { previous: 83, new: 25, total_passed: count("pass"), total_failed: count("fail") },
  root_state: bus.events.get(root).state, lifecycle_fix: "NOT STARTED", phase_3: "NOT STARTED",
  verification: "PASS", verified_at: new Date().toISOString(),
};
writeFileSync(artifact("fable-controlled-execution-proof.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({ verification: summary.verification, grant_hash: summary.grant_hash, result_hash: summary.result_hash, tests: summary.tests, follow_up_decision: consumer.decision.follow_up_decision }, null, 2));
