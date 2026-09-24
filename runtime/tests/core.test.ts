import { test } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBus, PROVIDER_WIRE_KEYWORDS, assertScope } from "../src/agent-bus/index.js";
import { ClaudeProvider } from "../src/providers/claude.js";
import { Storage, hash, HARNESS_ROOT, scopePath } from "../src/storage.js";
import { LockService } from "../src/locks/index.js";
import type {
  TaskCapsule,
  AgentResult,
  ApiContract,
  ReviewResult,
  AgentProvider,
} from "../src/contracts.js";
const evidence = [
  {
    assertion: "The named artifact was inspected",
    source: "fixture.txt:1",
    observation: "Expected contents found",
  },
];
function capsule(task_id = "TASK-1"): TaskCapsule {
  return {
    task_id,
    parent_task_id: null,
    role: "discovery-frontend",
    responsibility: "Inspect one artifact",
    goal: "Identify verified behavior",
    inputs: [],
    required_context: [],
    allowed_paths: ["src"],
    forbidden_paths: ["src/private"],
    existing_patterns: [],
    api_contract_reference: null,
    visual_lock_reference: null,
    constraints: [],
    acceptance_criteria: ["Report verified behavior"],
    owned_tests: [],
    permissions: "read-only",
    worktree: null,
    expected_output: "agent-result",
  };
}
function result(c = capsule()): AgentResult {
  return {
    task_id: c.task_id,
    role: c.role,
    status: "completed",
    summary: "Inspection complete",
    changed_files: [],
    evidence,
    tests_executed: [],
    tests_not_executed: [],
    api_contract_status: "not_applicable",
    visual_lock_status: "not_applicable",
    scope_expanded: false,
    deviations: [],
    risks: [],
    known_issues: [],
    requested_followups: [],
  };
}
const both = (provider: AgentProvider) => ({ codex: provider, claude: provider });
function temp() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cartera-core-")));
  return {
    root,
    storage: new Storage(root),
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}
function contract(): ApiContract {
  return {
    contract_id: "auth-session",
    task_id: "TASK-1",
    version: "1",
    method: "POST",
    path: "/api/auth/session",
    path_parameters: {},
    query_parameters: {},
    headers: {},
    request_body: { type: "object" },
    success_status: 200,
    success_schema: { type: "object" },
    errors: [{ status: 401, code: "UNAUTHORIZED", schema: { type: "object" } }],
    nullable_semantics: "Explicit null only",
    optional_semantics: "Absent keys omitted",
    dates: "ISO-8601",
    money: "Decimal number",
    enums: {},
    pagination: null,
  };
}
function review(
  role: string,
  subject_hash: string,
  reviewer = role
): ReviewResult {
  return {
    task_id: "TASK-1",
    reviewer,
    role,
    subject_hash,
    verdict: "approved",
    evidence,
    findings: [],
  };
}

test("dry-run resolves a real role without invoking a provider or persisting delegation events", async () => {
  const t = temp();
  try {
    let calls = 0;
    const bus = new AgentBus(t.storage, both({
        async execute() {
          calls++;
          throw new Error("MODEL_CALLED");
        },
    }));
    bus.init(capsule());
    const plan = (await bus.delegate("TASK-1")) as any;
    const persisted = bus.routing("TASK-1")!.routes["discovery-frontend"];
    assert.equal(plan.provider, persisted.provider);
    assert.equal(plan.model_alias, persisted.model_alias);
    assert.equal(plan.model, persisted.model);
    assert.equal(plan.effort, persisted.effort);
    assert.equal(calls, 0);
    assert.equal(bus.events.list("TASK-1").length, 1);
    await assert.rejects(
      bus.delegate("TASK-1", false),
      /MODEL_EXECUTION_DISABLED/
    );
  } finally {
    t.clean();
  }
});
test("worker caller cannot initialize, delegate, transition or create contracts", async () => {
  const t = temp();
  try {
    const master = new AgentBus(t.storage);
    master.init(capsule());
    const worker = new AgentBus(t.storage, {}, "worker", "truth");
    assert.throws(() => worker.init(capsule("TASK-2")), /WORKERS/);
    await assert.rejects(worker.delegate("TASK-1"), /WORKERS/);
    assert.throws(
      () => worker.transition("TASK-1", "TASK_CLASSIFIED", 0),
      /WORKERS/
    );
    assert.throws(() => worker.createContract(contract()), /WORKERS/);
  } finally {
    t.clean();
  }
});
test("read-only roles cannot escalate permissions and scope paths reject traversal and forbidden directories", () => {
  const t = temp();
  try {
    const bus = new AgentBus(t.storage);
    assert.throws(
      () => bus.init({ ...capsule(), permissions: "workspace-write" }),
      /ROLE_PERMISSION_DENIED/
    );
    assertScope(capsule(), "src/feature.ts", t.root);
    for (const p of [
      "../outside",
      "/etc/passwd",
      "src/private/key",
      "src/../other",
      "src/.git/config",
      "src-other/file",
    ])
      assert.throws(() => assertScope(capsule(), p, t.root));
    symlinkSync("/private/tmp", join(t.root, "linked"));
    assert.throws(() => scopePath(t.root, "linked/file"), /SYMLINK/);
  } finally {
    t.clean();
  }
});
test("structured provider outputs bind identity and completion requires independent review", async () => {
  const t = temp();
  try {
    const c = capsule();
    const bus = new AgentBus(t.storage, both({
        async execute() {
          return result(c);
        },
    }));
    bus.runtime.model_execution_enabled = true;
    bus.init(c);
    await bus.delegate(c.task_id, false);
    assert.equal(bus.events.get(c.task_id).state, "TASK_RECEIVED");
    for (const state of [
      "TASK_CLASSIFIED",
      "IMPLEMENTATION_RUNNING",
      "LOCAL_VERIFICATION",
      "ADVERSARIAL_REVIEW",
      "REVIEW_GATE_APPLY",
    ] as const)
      bus.transition(c.task_id, state, bus.events.get(c.task_id).revision);
    assert.throws(() => bus.transition(c.task_id, "DONE", 5), /review-result/);
    assert.throws(
      () =>
        bus.transition(
          c.task_id,
          "DONE",
          5,
          review("adversarial-reviewer", hash(result(c)), "cockpit")
        ),
      /INDEPENDENT_REVIEW/
    );
    const approved = review(
      "adversarial-reviewer",
      hash(result(c)),
      "REVIEW-1"
    );
    assert.throws(
      () => bus.transition(c.task_id, "DONE", 5, approved),
      /TASK_NOT_FOUND/
    );
    const rc = {
      ...capsule("REVIEW-1"),
      role: "adversarial-reviewer",
      parent_task_id: c.task_id,
    };
    bus.init(rc);
    bus.providers.claude = bus.providers.codex = {
      async execute(req) {
        return { ...result(req.capsule), review_result: approved };
      },
    };
    await bus.delegate("REVIEW-1", false);
    bus.transition(c.task_id, "DONE", 5, approved);
    assert.equal(bus.events.get(c.task_id).state, "DONE");
    await assert.rejects(bus.delegate(c.task_id, false), /TASK_TERMINAL/);
  } finally {
    t.clean();
  }
});
test("invalid identity and unvalidated model text are rejected without saving a result", async () => {
  for (const bad of [{ ...result(), task_id: "WRONG" }, {}]) {
    const t = temp();
    try {
      const bus = new AgentBus(t.storage, both({
          async execute() {
            return bad as AgentResult;
          },
      }));
      bus.runtime.model_execution_enabled = true;
      bus.init(capsule());
      await assert.rejects(
        bus.delegate("TASK-1", false),
        /IDENTITY_MISMATCH|INVALID_AGENT_RESULT/
      );
      assert.throws(() => bus.result("TASK-1"));
      assert.equal(
        bus.events.list("TASK-1").at(-1)?.event_type,
        "agent.failed"
      );
    } finally {
      t.clean();
    }
  }
});
test("scope expansion requests are artifacts and cannot silently perform extra work", async () => {
  const t = temp();
  try {
    const request = {
      reason: "Additional file needed",
      required_paths: ["other/file"],
      required_behavior: "Extend inspection",
      impact: "Additional scope",
    };
    const bus = new AgentBus(t.storage, both({
        async execute() {
          return {
            ...result(),
            status: "needs_scope_expansion",
            requested_followups: [request],
          };
        },
    }));
    bus.runtime.model_execution_enabled = true;
    bus.init(capsule());
    await bus.delegate("TASK-1", false);
    assert.ok(
      bus.events
        .list("TASK-1")
        .some((e) => e.event_type === "scope.expansion.requested")
    );
    assert.equal(bus.events.get("TASK-1").state, "TASK_RECEIVED");
  } finally {
    t.clean();
  }
});
test("contract snapshots cannot overwrite versions and locks require two independent matching reviews", () => {
  const t = temp();
  try {
    const locks = new LockService(t.storage),
      c = contract(),
      ref = locks.put(c);
    assert.throws(() => locks.put({ ...c, path: "/changed" }), /EEXIST/);
    assert.throws(
      () =>
        locks.lock(
          ref,
          review("wrong", ref.content_hash),
          review("api-contract-frontend-reviewer", ref.content_hash),
          "cockpit"
        ),
      /INVALID_CONTRACT_REVIEW/
    );
    const backend = review("api-contract-backend-reviewer", ref.content_hash),
      frontend = review("api-contract-frontend-reviewer", ref.content_hash);
    const lock = locks.lock(ref, backend, frontend, "cockpit");
    assert.equal(lock.content_hash, hash(c));
    locks.require(ref);
    assert.throws(
      () => locks.lock(ref, backend, frontend, "cockpit"),
      /ALREADY_LOCKED/
    );
    const cr = {
      request_id: "CHANGE-1",
      task_id: "TASK-1",
      reason: "Add a required field",
      current_contract: ref,
      proposed_change: { field: "name" },
      frontend_impact: "Update client",
      backend_impact: "Update validator",
    };
    locks.request(cr);
    assert.deepEqual(t.storage.read("contract-changes", "CHANGE-1.json"), cr);
    assert.deepEqual(locks.get(ref).contract, c);
    const path = readdirSync(join(t.root, "contracts")).find(
      (p) => !p.endsWith(".lock.json")
    )!;
    writeFileSync(
      join(t.root, "contracts", path),
      JSON.stringify({ ...c, path: "/tampered" })
    );
    assert.throws(() => locks.get(ref), /HASH_MISMATCH/);
  } finally {
    t.clean();
  }
});
test("visual approval artifacts are immutable and content hashes are verified", () => {
  const t = temp();
  try {
    const locks = new LockService(t.storage);
    const content = {
      lock_id: "VISUAL-1",
      task_id: "TASK-1",
      version: "1",
      stories: [{ id: "story-1", path: "stories/example.ts" }],
      viewports: [{ id: "desktop", width: 1280, height: 720 }],
      hierarchy: ["Primary action"],
      responsive: ["Stack on mobile"],
      interactions: ["Focus"],
      design_components: ["Button"],
      baselines: [
        {
          story_id: "story-1",
          viewport_id: "desktop",
          artifact: "baseline.png",
        },
      ],
      approval: { actor: "user-caio", timestamp: new Date().toISOString() },
    };
    const visual = { ...content, content_hash: hash(content) };
    assert.throws(
      () => locks.putVisual(visual, { actor: "worker", approved: true }),
      /USER_APPROVAL/
    );
    locks.putVisual(visual, { actor: "user-caio", approved: true });
    assert.throws(
      () => locks.putVisual(visual, { actor: "user-caio", approved: true }),
      /EEXIST/
    );
    locks.visual({
      id: content.lock_id,
      version: "1",
      content_hash: hash(content),
    });
  } finally {
    t.clean();
  }
});
test("provider result schema is self-contained and excludes external refs", async () => {
  const t = temp();
  try {
    const bus = new AgentBus(t.storage, both({
        async execute(req) {
          const schema = readFileSync(req.result_schema_path, "utf8");
          assert.ok(!schema.includes('"$ref"'));
          assert.ok(!schema.includes('"allOf"'));
          for (const keyword of ["uniqueItems", "pattern"])
            assert.equal(schema.includes(`"${keyword}"`), PROVIDER_WIRE_KEYWORDS[req.route.provider].has(keyword), `${req.route.provider} wire ${keyword}`);
          assert.equal(JSON.parse(schema).properties.evidence.minItems, undefined, "a producer that may stop honestly is not forced to invent evidence");
          return result();
        },
    }));
    bus.runtime.model_execution_enabled = true;
    bus.init(capsule());
    await bus.delegate("TASK-1", false);
  } finally {
    t.clean();
  }
});

test("failed scope enforcement quarantines an isolated worktree and prevents reuse or cleanup", async () => {
  const t = temp();
  try {
    const repo = join(t.root, "repo");
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "allowed.txt"), "base");
    execFileSync("git", ["-C", repo, "add", "allowed.txt"]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Harness Test",
      "-c",
      "user.email=harness@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "fixture",
    ]);
    const c = {
      ...capsule(),
      role: "backend-worker",
      permissions: "restricted-path-write" as const,
      allowed_paths: ["allowed.txt"],
      forbidden_paths: [],
    };
    const bus = new AgentBus(t.storage, both({
        async execute(req) {
          writeFileSync(
            join(req.cwd, "outside.txt"),
            "preserve for inspection"
          );
          return { ...result(c), changed_files: ["outside.txt"] };
        },
    }));
    bus.runtime.model_execution_enabled = true;
    // Explicit authority only for this isolated legacy write-policy fixture.
    bus.executionPolicy.write_application_execution = true;
    const worktree = bus.worktrees.create({
      task_id: c.task_id,
      role: c.role,
      repository: repo,
      base_ref: "HEAD",
    });
    bus.init({ ...c, worktree });
    bus.transition(c.task_id, "TASK_CLASSIFIED", 0);
    bus.transition(c.task_id, "IMPLEMENTATION_RUNNING", 1);
    await assert.rejects(bus.delegate(c.task_id, false), /SCOPE_VIOLATION/);
    assert.equal(
      readFileSync(join(worktree.path, "outside.txt"), "utf8"),
      "preserve for inspection"
    );
    await assert.rejects(
      bus.delegate(c.task_id, false),
      /QUARANTINED_WORKTREE/
    );
    assert.throws(() => bus.worktrees.remove(worktree.id), /QUARANTINED/);
  } finally {
    t.clean();
  }
});

test("Claude write outside allowed_paths is rejected by existing scope validation", async () => {
  const t = temp();
  try {
    const repo = join(t.root, "repo");
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "allowed.txt"), "base");
    execFileSync("git", ["-C", repo, "add", "allowed.txt"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Harness Test", "-c", "user.email=harness@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"]);
    const c = { ...capsule(), role: "backend-worker", permissions: "restricted-path-write" as const, allowed_paths: ["allowed.txt"], forbidden_paths: [] };
    let permissionMode = "";
    const claude = new ClaudeProvider(async (input) => {
      permissionMode = input.args[input.args.indexOf("--permission-mode") + 1];
      writeFileSync(join(input.cwd, "outside.txt"), "preserve for inspection");
      return { exit_code: 0, stdout: JSON.stringify({ structured_output: { ...result(c), changed_files: ["outside.txt"] } }), stderr: "", signal: null };
    });
    const bus = new AgentBus(t.storage, { codex: claude, claude });
    bus.runtime.model_execution_enabled = true;
    bus.executionPolicy.write_application_execution = true;
    const worktree = bus.worktrees.create({ task_id: c.task_id, role: c.role, repository: repo, base_ref: "HEAD" });
    bus.init({ ...c, worktree });
    bus.transition(c.task_id, "TASK_CLASSIFIED", 0);
    bus.transition(c.task_id, "IMPLEMENTATION_RUNNING", 1);
    await assert.rejects(bus.delegate(c.task_id, false), /SCOPE_VIOLATION/);
    assert.equal(permissionMode, "acceptEdits");
    assert.equal(readFileSync(join(worktree.path, "outside.txt"), "utf8"), "preserve for inspection");
    await assert.rejects(bus.delegate(c.task_id, false), /QUARANTINED_WORKTREE/);
  } finally {
    t.clean();
  }
});

test("contract lock accepts only persisted results from two delegated reviewer roles", async () => {
  const t = temp();
  try {
    const bus = new AgentBus(t.storage);
    bus.runtime.model_execution_enabled = true;
    bus.init(capsule());
    const ref = bus.createContract(contract());
    const backend = review(
      "api-contract-backend-reviewer",
      ref.content_hash,
      "BACKEND-REVIEW"
    );
    const frontend = review(
      "api-contract-frontend-reviewer",
      ref.content_hash,
      "FRONTEND-REVIEW"
    );
    assert.throws(
      () => bus.lockContract(ref, backend, frontend),
      /TASK_NOT_FOUND/
    );
    bus.providers.claude = bus.providers.codex = {
      async execute(req) {
        assert.ok(req.prompt.includes("/api/auth/session"));
        return {
          ...result(req.capsule),
          review_result:
            req.capsule.task_id === backend.reviewer ? backend : frontend,
        };
      },
    };
    for (const r of [backend, frontend]) {
      bus.init({
        ...capsule(r.reviewer),
        role: r.role,
        parent_task_id: "TASK-1",
        api_contract_reference: ref,
      });
      await bus.delegate(r.reviewer, false);
    }
    const lock = bus.lockContract(ref, backend, frontend);
    assert.equal(lock.backend_reviewer, backend.reviewer);
    assert.equal(lock.frontend_reviewer, frontend.reviewer);
    assert.equal(
      bus.events.list("TASK-1").at(-1)?.event_type,
      "contract.locked"
    );
  } finally {
    t.clean();
  }
});

test("long valid task IDs remain valid for internal resource locks", () => {
  const t = temp();
  try {
    const bus = new AgentBus(t.storage);
    const c = capsule("T".repeat(100));
    bus.init(c);
    bus.transition(c.task_id, "TASK_CLASSIFIED", 0);
    assert.equal(bus.events.get(c.task_id).state, "TASK_CLASSIFIED");
  } finally {
    t.clean();
  }
});
