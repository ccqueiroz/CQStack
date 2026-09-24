import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const exec = promisify(execFile);
const capsule = {
  task_id: "transport-task",
  parent_task_id: null,
  role: "task-sense",
  responsibility: "classify",
  goal: "test transport",
  inputs: [],
  required_context: [],
  allowed_paths: [],
  forbidden_paths: [],
  existing_patterns: [],
  api_contract_reference: null,
  visual_lock_reference: null,
  constraints: [],
  acceptance_criteria: [],
  owned_tests: [],
  permissions: "read-only",
  worktree: null,
  expected_output: "agent-result",
};
const textContent = (value: unknown): string => {
  const content = value as Array<{ type?: string; text?: string }>;
  return content?.[0]?.type === "text" ? content[0].text ?? "" : "";
};

test("CLI and MCP transports share state and return resolved JSON values", async () => {
  const state = await realpath(
    await mkdtemp(join(tmpdir(), "cartera-transport-"))
  );
  const harness = process.cwd();
  const cli = join(harness, "dist/cli/main.js");
  const env = { ...process.env, CARTERA_HARNESS_STATE: state };
  const capsuleFile = join(state, "capsule.json");
  await writeFile(capsuleFile, JSON.stringify(capsule));
  const profiles = JSON.parse(await (await import("node:fs/promises")).readFile(join(harness, "config/routing-profiles.json"), "utf8"));
  const defaultRoute = (role: string) => {
    const entry = profiles.roles[role];
    return { ...entry, model_alias: profiles.profiles[profiles.default_profile][entry.model_class] };
  };
  const runCli = async (...args: string[]) =>
    JSON.parse(
      (await exec(process.execPath, [cli, ...args], { cwd: harness, env }))
        .stdout
    );
  try {
    const smokePlan = await runCli("smoke", "codex", "TRANSPORT-SMOKE");
    assert.equal(smokePlan.capsule.permissions, "read-only");
    assert.equal(smokePlan.route.provider, "codex");
    assert.equal(smokePlan.route.model_alias, profiles.profiles.codex[profiles.roles["mechanical-worker"].model_class]);
    const initialized = await runCli("task", "init", capsuleFile);
    assert.equal(initialized.capsule.task_id, "transport-task");
    assert.equal(
      (await runCli("task", "show", "transport-task")).state,
      "TASK_RECEIVED"
    );
    assert.equal((await runCli("task", "events", "transport-task")).length, 1);
    const plan = await runCli("delegate", "transport-task");
    assert.equal(plan.role, "task-sense");
    assert.equal(plan.model_alias, defaultRoute("task-sense").model_alias);
    assert.equal(plan.effort, defaultRoute("task-sense").effort);
    await assert.rejects(() =>
      exec(process.execPath, [cli, "delegate", "transport-task", "--execute"], {
        cwd: harness,
        env,
      })
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(harness, "dist/mcp/server.js")],
      cwd: harness,
      env,
    });
    const client = new Client(
      { name: "transport-test", version: "0.1.0" },
      { capabilities: {} }
    );
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === "task_get"));
      const fetched = await client.callTool({
        name: "task_get",
        arguments: { task_id: "transport-task" },
      });
      const fetchedValue = JSON.parse(textContent(fetched.content));
      assert.equal(fetchedValue.state, "TASK_RECEIVED");
      const delegated = await client.callTool({
        name: "agent_delegate",
        arguments: { task_id: "transport-task" },
      });
      const delegatedValue = JSON.parse(textContent(delegated.content));
      assert.equal(delegatedValue.role, "task-sense");
      assert.equal(delegatedValue.model_alias, defaultRoute("task-sense").model_alias);
      const invalid = await client.callTool({
        name: "task_get",
        arguments: { task_id: 7 },
      });
      assert.equal(invalid.isError, true);
      const workflowRequest = JSON.parse(await (await import("node:fs/promises")).readFile(join(harness, "examples/phase-2-pagination-workflow.json"), "utf8"));
      workflowRequest.task_id = "transport-workflow";
      const workflowFile = join(state, "workflow.json");
      await writeFile(workflowFile, JSON.stringify(workflowRequest));
      const workflow = await runCli("workflow", "start", workflowFile);
      assert.equal(workflow.state, "TASK_RECEIVED");
      assert.equal(workflow.nodes.length, 6);
      const workflowMcp = await client.callTool({ name: "workflow_show", arguments: { task_id: "transport-workflow" } });
      assert.deepEqual(JSON.parse(textContent(workflowMcp.content)), workflow);
      const resumed = await client.callTool({ name: "workflow_resume", arguments: { task_id: "transport-workflow" } });
      assert.deepEqual(JSON.parse(textContent(resumed.content)), workflow);
      assert.deepEqual(await runCli("workflow", "artifacts", "transport-workflow"), []);
      const blocked = await client.callTool({ name: "workflow_resume", arguments: { task_id: "transport-workflow", execute: true } });
      assert.equal(blocked.isError, true);
    } finally {
      await client.close();
    }
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
