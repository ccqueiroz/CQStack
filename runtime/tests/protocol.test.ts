import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AgentResult,
  RoleDefinition,
  TaskCapsule,
} from "../src/contracts.js";
import { EventStore } from "../src/events/index.js";
import { Router } from "../src/router/index.js";
import { assertTransition } from "../src/state/index.js";
import { Storage } from "../src/storage.js";
import {
  InvalidAgentResultError,
  SchemaValidationError,
  parseAgentResult,
  validate,
} from "../src/validation/index.js";

const capsule = (overrides: Partial<TaskCapsule> = {}): TaskCapsule => ({
  task_id: "task-1",
  parent_task_id: null,
  role: "implementer",
  responsibility: "Implement the assigned capsule",
  goal: "Produce a validated result",
  inputs: [],
  required_context: ["runtime/src/contracts.ts"],
  allowed_paths: ["runtime/src"],
  forbidden_paths: ["models"],
  existing_patterns: [],
  api_contract_reference: null,
  visual_lock_reference: null,
  constraints: [],
  acceptance_criteria: ["Protocol validation passes"],
  owned_tests: ["runtime/tests/protocol.test.ts"],
  permissions: "restricted-path-write",
  worktree: null,
  expected_output: "agent-result",
  ...overrides,
});

const agentResult = (overrides: Partial<AgentResult> = {}): AgentResult => ({
  task_id: "task-1",
  role: "implementer",
  status: "completed",
  summary: "Implemented and verified",
  changed_files: ["runtime/tests/protocol.test.ts"],
  evidence: [
    {
      assertion: "Protocol passes",
      source: "node:test",
      observation: "exit code 0",
    },
  ],
  tests_executed: [
    { command: "npm test", exit_code: 0, evidence: "all tests passed" },
  ],
  tests_not_executed: [],
  api_contract_status: "not_applicable",
  visual_lock_status: "not_applicable",
  scope_expanded: false,
  deviations: [],
  risks: [],
  known_issues: [],
  requested_followups: [],
  ...overrides,
});

async function withTemporaryDirectory(
  run: (directory: string) => Promise<void>
): Promise<void> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "cartera-protocol-"))
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeRouterFixture(
  root: string,
  roles: RoleDefinition[],
  models: Record<string, { provider: string; model: string }>,
  providers: Record<string, { command: string; enabled: boolean }>,
  roleClasses: Record<string, { model_class: string; effort: string | null }>,
  classes: Record<string, string>
): Promise<void> {
  await mkdir(join(root, "roles"), { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(join(root, "governance"), { recursive: true });
  await writeFile(join(root, "governance/core.md"), "# Core\n");
  await writeFile(join(root, "roles/registry.json"), JSON.stringify(roles));
  await writeFile(join(root, "config/models.json"), JSON.stringify(models));
  await writeFile(
    join(root, "config/providers.json"),
    JSON.stringify(providers)
  );
  await writeFile(
    join(root, "config/routing-profiles.json"),
    JSON.stringify({ default_profile: "test", roles: roleClasses, profiles: { test: classes } })
  );
}

const role = (name: string): RoleDefinition => ({
  role: name,
  purpose: `${name} work`,
  allowed_capabilities: ["read"],
  mutation_permission: "read-only",
  required_artifacts: [],
  expected_output_schema: "agent-result",
  governance: ["core.md"],
});

test("TaskCapsule schema accepts a complete capsule and rejects unsafe scope paths", () => {
  assert.deepEqual(validate<TaskCapsule>("task-capsule", capsule()), capsule());
  assert.throws(
    () =>
      validate<TaskCapsule>(
        "task-capsule",
        capsule({ allowed_paths: ["/etc/passwd"] })
      ),
    SchemaValidationError
  );
});

test("AgentResult schema and parser enforce required evidence and followups", () => {
  const valid = agentResult();
  assert.deepEqual(validate<AgentResult>("agent-result", valid), valid);
  assert.deepEqual(parseAgentResult(JSON.stringify(valid)), valid);
  assert.throws(
    () => validate<AgentResult>("agent-result", { ...valid, evidence: [] }),
    SchemaValidationError
  );
  assert.throws(
    () =>
      validate<AgentResult>(
        "agent-result",
        agentResult({
          status: "needs_scope_expansion",
          evidence: [],
          requested_followups: [],
        })
      ),
    SchemaValidationError
  );
  const review = {
    task_id: "task-1",
    reviewer: "reviewer-1",
    role: "adversarial-reviewer",
    subject_hash: "a".repeat(64),
    verdict: "approved" as const,
    evidence: [
      {
        assertion: "Result verified",
        source: "review",
        observation: "approved",
      },
    ],
    findings: [],
  };
  assert.deepEqual(
    validate<AgentResult>(
      "agent-result",
      agentResult({ review_result: review })
    ).review_result,
    review
  );
  assert.equal(
    validate<AgentResult>(
      "agent-result",
      agentResult({ review_result: { ...review, verdict: "rejected" } })
    ).review_result?.verdict,
    "rejected"
  );
  assert.throws(
    () =>
      validate<AgentResult>(
        "agent-result",
        agentResult({ review_result: { ...review, evidence: [] } })
      ),
    SchemaValidationError
  );
  assert.throws(
    () => parseAgentResult("{not-json"),
    (error: unknown) =>
      error instanceof InvalidAgentResultError &&
      error.code === "INVALID_AGENT_RESULT"
  );
});

const models = {
  frontier: { provider: "codex", model: "gpt-frontier" },
  primary: { provider: "codex", model: "gpt-primary" },
  review: { provider: "claude", model: "claude-review" },
  bulk: { provider: "codex", model: "gpt-bulk" },
};
const classes = { orchestration: "frontier", reasoning: "primary", "deep-reasoning": "review", mechanical: "bulk" };
const bothProviders = { codex: { command: "codex", enabled: true }, claude: { command: "claude", enabled: true } };

test("Router resolves every registered role", async () => {
  await withTemporaryDirectory(async (directory) => {
    const roles = [role("implementer"), role("reviewer")];
    await writeRouterFixture(
      directory,
      roles,
      models,
      bothProviders,
      { implementer: { model_class: "reasoning", effort: "high" }, reviewer: { model_class: "deep-reasoning", effort: "medium" } },
      classes
    );
    const router = new Router(directory);
    assert.deepEqual(
      router.roles.map(({ role: name }) => router.resolve(name).model),
      ["gpt-primary", "claude-review"]
    );
    assert.deepEqual(router.roles.map(({ role: name }) => router.resolve(name).effort), ["high", "medium"]);
    assert.equal(router.resolve("implementer").provider, "codex");
    assert.throws(() => router.resolve("missing"), /UNKNOWN_ROLE/);
    assert.throws(() => router.resolve("implementer", "absent"), /UNKNOWN_ROUTING_PROFILE/);
    const snapshot = router.snapshot("ROOT-1");
    assert.equal(snapshot.profile, "test");
    assert.deepEqual(snapshot.routes.reviewer, { provider: "claude", model_class: "deep-reasoning", model_alias: "review", model: "claude-review", effort: "medium" });
  });
});

test("Router rejects a role without declared governance or with an unknown governance file", async () => {
  for (const [governance, expected] of [[[], /ROLE_GOVERNANCE_MISSING: implementer/], [["missing.md"], /ROLE_GOVERNANCE_UNKNOWN: implementer: missing\.md/], [["../core.md"], /ROLE_GOVERNANCE_UNKNOWN/]] as const) {
    await withTemporaryDirectory(async (directory) => {
      await writeRouterFixture(directory, [{ ...role("implementer"), governance: [...governance] }], models, bothProviders, { implementer: { model_class: "reasoning", effort: "medium" } }, classes);
      assert.throws(() => new Router(directory), expected);
    });
  }
});

test("Router rejects missing aliases and invalid provider routes", async () => {
  await withTemporaryDirectory(async (directory) => {
    await writeRouterFixture(
      directory,
      [role("implementer")],
      models,
      bothProviders,
      { implementer: { model_class: "reasoning", effort: "medium" } },
      { ...classes, reasoning: "missing" }
    );
    assert.throws(() => new Router(directory), /UNKNOWN_MODEL_ALIAS/);
  });
  await withTemporaryDirectory(async (directory) => {
    await writeRouterFixture(
      directory,
      [role("implementer")],
      models,
      { codex: { command: "codex", enabled: true }, claude: { command: "claude", enabled: false } },
      { implementer: { model_class: "reasoning", effort: "medium" } },
      classes
    );
    assert.throws(() => new Router(directory), /INVALID_PROVIDER_ROUTE/);
  });
  await withTemporaryDirectory(async (directory) => {
    await writeRouterFixture(
      directory,
      [role("implementer"), role("reviewer")],
      models,
      bothProviders,
      { implementer: { model_class: "reasoning", effort: "medium" } },
      classes
    );
    assert.throws(() => new Router(directory), /ROLE_CLASS_MISSING: reviewer/);
  });
  await withTemporaryDirectory(async (directory) => {
    await writeRouterFixture(
      directory,
      [role("implementer")],
      models,
      bothProviders,
      { implementer: { model_class: "reasoning", effort: "ultra" } },
      classes
    );
    assert.throws(() => new Router(directory), /INVALID_EFFORT/);
  });
});

test("state transitions accept declared edges and reject invalid or terminal moves", () => {
  assert.doesNotThrow(() =>
    assertTransition("TASK_RECEIVED", "TASK_CLASSIFIED")
  );
  assert.doesNotThrow(() =>
    assertTransition("IMPLEMENTATION_RUNNING", "FAILED")
  );
  assert.throws(
    () => assertTransition("TASK_RECEIVED", "DONE"),
    /INVALID_STATE_TRANSITION/
  );
  assert.throws(
    () => assertTransition("DONE", "IMPLEMENTATION_RUNNING"),
    /INVALID_STATE_TRANSITION/
  );
});

test("events persist across store reopen and reject stale revisions", async () => {
  await withTemporaryDirectory(async (directory) => {
    const first = new EventStore(new Storage(directory));
    first.create(capsule());
    const transitioned = first.transition("task-1", "TASK_CLASSIFIED", 0);
    assert.equal(transitioned.revision, 1);

    const reopened = new EventStore(new Storage(directory));
    assert.equal(reopened.list("task-1").length, 2);
    assert.deepEqual(reopened.get("task-1"), transitioned);
    assert.throws(
      () => reopened.transition("task-1", "IMPLEMENTATION_RUNNING", 0),
      /STALE_TASK_REVISION/
    );
  });
});

test("task creation is immutable when the same task id is initialized twice", async () => {
  await withTemporaryDirectory(async (directory) => {
    const events = new EventStore(new Storage(directory));
    const original = capsule();
    events.create(original);
    assert.throws(
      () => events.create(capsule({ goal: "Replace the original goal" })),
      /TASK_EXISTS/
    );
    assert.deepEqual(events.get("task-1").capsule, original);
    assert.equal(events.list("task-1").length, 1);
  });
});

test("event mutations honor the injected authority boundary", async () => {
  await withTemporaryDirectory(async (directory) => {
    const events = new EventStore(new Storage(directory), () => {
      throw new Error("MUTATION_DENIED");
    });
    assert.throws(() => events.create(capsule()), /MUTATION_DENIED/);
    assert.throws(
      () => events.append("task-1", "task.created", {}),
      /MUTATION_DENIED/
    );
    assert.throws(
      () => events.transition("task-1", "TASK_CLASSIFIED", 0),
      /MUTATION_DENIED/
    );
    assert.equal(events.list("task-1").length, 0);
  });
});
