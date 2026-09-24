import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentExecutionRequest, ProcessResult } from "../src/contracts.js";
import { ClaudeProvider } from "../src/providers/claude.js";
import { CodexProvider } from "../src/providers/codex.js";
import { runProcess } from "../src/processes/run.js";

const result = {
  task_id: "t",
  role: "r",
  status: "completed",
  summary: "ok",
  changed_files: [],
  evidence: [{ assertion: "fixture", source: "test", observation: "valid" }],
  tests_executed: [],
  tests_not_executed: [],
  api_contract_status: "unchanged",
  visual_lock_status: "not_applicable",
  scope_expanded: false,
  deviations: [],
  risks: [],
  known_issues: [],
  requested_followups: [],
};
const ownedWorktree = {
  id: "wt",
  task_id: "t",
  role: "r",
  repository: "fixture",
  path: process.cwd(),
  base_ref: "HEAD",
  base_commit: "0000000000000000000000000000000000000000",
  contract_version: null,
  created_at: "2026-01-01T00:00:00.000Z",
};
const request = (
  permission: "read-only" | "workspace-write" | "restricted-path-write",
  schemaPath: string,
  model = "gpt-6-astra"
): AgentExecutionRequest => ({
  capsule: {
    task_id: "t",
    parent_task_id: null,
    role: "r",
    responsibility: "r",
    goal: "g",
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
    permissions: permission,
    worktree: null,
    expected_output: "agent-result",
  },
  route: { provider: "test", model_alias: model, model, role: {} as never, effort: null },
  cwd: process.cwd(),
  prompt: "p",
  result_schema_path: schemaPath,
  timeout_ms: 1000,
});

test("Codex sends explicit safe flags and parses a valid result", async () => {
  let observed: { command: string; args: string[] } | undefined;
  const runner = async (input: {
    command: string;
    args: string[];
  }): Promise<ProcessResult> => {
    observed = input;
    return {
      exit_code: 0,
      stdout: JSON.stringify(result),
      stderr: "",
      signal: null,
    };
  };
  const provider = new CodexProvider(runner as never);
  const value = await provider.execute(
    request("restricted-path-write", "/schema.json")
  ) as import("../src/contracts.js").AgentResult;
  assert.equal(value.summary, "ok");
  assert.deepEqual(observed?.args.slice(0, 5), [
    "exec",
    "--model",
    "gpt-6-astra",
    "--cd",
    process.cwd(),
  ]);
  assert.ok(
    observed?.args.includes("--sandbox") &&
      observed.args.includes("workspace-write")
  );
  assert.ok(
    observed?.args.includes("--ephemeral") &&
      observed.args.includes("--ignore-user-config")
  );
});



test("Claude passes schema inline and parses structured output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cartera-test-"));
  const schemaPath = join(directory, "schema.json");
  await writeFile(schemaPath, '{"type":"object"}');
  let schemaArg = "";
  try {
    const runner = async (input: {
      args: string[];
    }): Promise<ProcessResult> => {
      schemaArg = input.args[input.args.indexOf("--json-schema") + 1];
      return {
        exit_code: 0,
        stdout: JSON.stringify({ structured_output: result, result: "" }),
        stderr: "",
        signal: null,
      };
    };
    const value = await new ClaudeProvider(runner as never).execute(
      request("read-only", schemaPath)
    );
    assert.equal(value.summary, "ok");
    assert.equal(schemaArg, '{"type":"object"}');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude read-only keeps dontAsk and read tools only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cartera-test-"));
  const schemaPath = join(directory, "schema.json");
  await writeFile(schemaPath, '{"type":"object"}');
  let args: string[] = [];
  try {
    const runner = async (input: { args: string[] }): Promise<ProcessResult> => {
      args = input.args;
      return { exit_code: 0, stdout: JSON.stringify({ structured_output: result }), stderr: "", signal: null };
    };
    const value = await new ClaudeProvider(runner as never).execute(request("read-only", schemaPath));
    assert.equal(value.summary, "ok");
    assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
    assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep,Glob");
    assert.ok(!args.includes("--allowedTools"));
    assert.ok(args.includes("--restricted") && args.includes("--safe-mode"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude grants no tools to the proposal and API contract reviewers while producers keep read tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cartera-test-"));
  const schemaPath = join(directory, "schema.json");
  await writeFile(schemaPath, '{"type":"object"}');
  try {
    const tools = async (role: string) => {
      let args: string[] = [];
      const runner = async (input: { args: string[] }): Promise<ProcessResult> => {
        args = input.args;
        return { exit_code: 0, stdout: JSON.stringify({ structured_output: result }), stderr: "", signal: null };
      };
      const roleRequest = request("read-only", schemaPath);
      roleRequest.capsule.role = role;
      await new ClaudeProvider(runner as never).execute(roleRequest);
      return args[args.indexOf("--tools") + 1];
    };
    for (const role of ["opsx-propose-reviewer", "api-contract-frontend-reviewer", "api-contract-backend-reviewer"]) assert.equal(await tools(role), "", role);
    for (const role of ["opsx-proposer", "api-contract-architect", "opsx-apply-reviewer"]) assert.equal(await tools(role), "Read,Grep,Glob", role);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude restricted-path-write is accepted only inside an owned worktree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cartera-test-"));
  const schemaPath = join(directory, "schema.json");
  await writeFile(schemaPath, '{"type":"object"}');
  let args: string[] = [];
  try {
    const runner = async (input: { args: string[] }): Promise<ProcessResult> => {
      args = input.args;
      return { exit_code: 0, stdout: JSON.stringify({ structured_output: result }), stderr: "", signal: null };
    };
    const writeRequest = request("restricted-path-write", schemaPath);
    writeRequest.capsule.worktree = ownedWorktree;
    writeRequest.capsule.owned_tests = ["node --test tests/pagination.test.mjs"];
    const value = await new ClaudeProvider(runner as never).execute(writeRequest);
    assert.equal(value.summary, "ok");
    assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
    assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep,Glob,Edit,Write");
    assert.ok(!args.includes("--allowedTools"), "owned tests grant the worker no shell allowance; the harness runs them");
    assert.equal(args[args.indexOf("--add-dir") + 1], process.cwd());
    assert.ok(args.includes("--restricted") && args.includes("--safe-mode"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude restricted-path-write without an owned worktree never runs", async () => {
  const neverRun = async (): Promise<ProcessResult> => {
    throw new Error("must not run");
  };
  await assert.rejects(
    () => new ClaudeProvider(neverRun).execute(request("restricted-path-write", "/schema")),
    /OWNED_WORKTREE_REQUIRED/
  );
  const foreign = request("restricted-path-write", "/schema");
  foreign.capsule.worktree = { ...ownedWorktree, task_id: "other-task" };
  await assert.rejects(() => new ClaudeProvider(neverRun).execute(foreign), /OWNED_WORKTREE_REQUIRED/);
  const elsewhere = request("restricted-path-write", "/schema");
  elsewhere.capsule.worktree = { ...ownedWorktree, path: join(process.cwd(), "elsewhere") };
  await assert.rejects(() => new ClaudeProvider(neverRun).execute(elsewhere), /OWNED_WORKTREE_REQUIRED/);
});

test("claude tool list is minimal per capsule class", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cartera-test-"));
  const schemaPath = join(directory, "schema.json");
  await writeFile(schemaPath, '{"type":"object"}');
  try {
    const tools = async (prepare: (r: AgentExecutionRequest) => void, permission: "read-only" | "restricted-path-write" = "read-only") => {
      let args: string[] = [];
      const runner = async (input: { args: string[] }): Promise<ProcessResult> => {
        args = input.args;
        return { exit_code: 0, stdout: JSON.stringify({ structured_output: result }), stderr: "", signal: null };
      };
      const classRequest = request(permission, schemaPath);
      prepare(classRequest);
      await new ClaudeProvider(runner as never).execute(classRequest);
      return args[args.indexOf("--tools") + 1];
    };
    assert.equal(await tools(r => { r.capsule.worktree = ownedWorktree; }, "restricted-path-write"), "Read,Grep,Glob,Edit,Write");
    assert.equal(await tools(() => {}), "Read,Grep,Glob");
    assert.equal(await tools(r => { r.capsule.constraints = ["WORKFLOW_STAGE:flow"]; }), "");
    assert.equal(await tools(r => { r.capsule.role = "master-orchestrator"; }), "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// The replay side (provider_invoked:false) is pinned in engineering.test.ts by the GAP_DEFINED checkpoint test.
test("a real provider execution records provider_invoked true while replay records false", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cartera-test-"));
  const schemaPath = join(directory, "schema.json");
  await writeFile(schemaPath, '{"type":"object"}');
  try {
    const observations: Record<string, unknown>[] = [];
    const observe = (observation: Record<string, unknown>) => { observations.push(observation); };
    const claudeRequest = { ...request("read-only", schemaPath), observe };
    await new ClaudeProvider(async () => ({ exit_code: 0, stdout: JSON.stringify({ structured_output: result }), stderr: "", signal: null })).execute(claudeRequest);
    const codexRequest = { ...request("read-only", schemaPath), observe };
    await new CodexProvider(async () => ({ exit_code: 0, stdout: JSON.stringify(result), stderr: "", signal: null })).execute(codexRequest);
    assert.equal(observations.length, 2);
    for (const observation of observations) assert.equal(observation.provider_invoked, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("providers reject Fable and unsupported Claude writes", async () => {
  await assert.rejects(
    () =>
      new CodexProvider(async () => {
        throw new Error("must not run");
      }).execute(request("read-only", "/schema", "fable[1m]")),
    /FABLE_MODEL_FORBIDDEN/
  );
  await assert.rejects(
    () =>
      new ClaudeProvider(async () => {
        throw new Error("must not run");
      }).execute(request("workspace-write", "/schema")),
    /UNSUPPORTED_PERMISSION/
  );
});

test("runner rejects timeout and cancellation without model calls", async () => {
  await assert.rejects(
    () =>
      runProcess({
        command: process.execPath,
        args: ["-e", "setTimeout(()=>{}, 10000)"],
        cwd: process.cwd(),
        stdin: "",
        timeout_ms: 20,
      }),
    /timed out/
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      runProcess({
        command: process.execPath,
        args: ["-e", "setTimeout(()=>{}, 10000)"],
        cwd: process.cwd(),
        stdin: "",
        timeout_ms: 1000,
        signal: controller.signal,
      }),
    /aborted/
  );
});

test("Claude error envelopes are provider failures that keep their cause, never accepted results or generic invalid output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cartera-test-"));
  const schemaPath = join(directory, "schema.json");
  await writeFile(schemaPath, '{"type":"object"}');
  const execute = (exit_code: number, stdout: string) =>
    new ClaudeProvider((async () => ({ exit_code, stdout, stderr: "", signal: null })) as never).execute(request("read-only", schemaPath));
  const failure = { type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: 529 overloaded" };
  try {
    for (const [label, exit, stdout] of [
      ["error envelope with structured_output", 0, { ...failure, structured_output: result }],
      ["error envelope without structured_output", 0, failure],
      ["error envelope on a failed exit", 1, failure],
    ] as const) {
      await assert.rejects(execute(exit, JSON.stringify(stdout)), (error: Error) => {
        assert.equal(error.name, "CLAUDE_ERROR_ENVELOPE", label);
        assert.equal(error.message, "CLAUDE_ERROR_ENVELOPE: error_during_execution: API Error: 529 overloaded", label);
        assert.doesNotMatch(error.message, /INVALID_AGENT_RESULT/, label);
        return true;
      });
    }
    assert.equal((await execute(0, JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: result }))).summary, "ok");
    await assert.rejects(execute(0, "{not json"), /INVALID_AGENT_RESULT: JSON_PARSE_FAILED/);
    await assert.rejects(execute(1, "{not json"), /claude exited unsuccessfully \(1\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
