import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBus } from "../src/agent-bus/index.js";
import { HARNESS_ROOT, Storage, hash } from "../src/storage.js";
import { WorkflowService, config, implementationHash } from "../src/workflow/service.js";
import { childCapsule, selectedInputs, REV2_SEMANTICS, REV3_SEMANTICS, REV3_OPERATIONAL_CONSTRAINTS, SEMANTICS } from "../src/workflow/adapters.js";
import { createHash } from "node:crypto";
import { checkOutput } from "../src/workflow/artifacts.js";
import { invoke } from "../src/surface.js";
import { reviewWorkflow, reviewSubject } from "../src/workflow/review.js";
import type { WorkflowRequest, WorkflowOutput } from "../src/workflow/contracts.js";
import type { AgentExecutionRequest, AgentResult } from "../src/contracts.js";

const source = ".cartera/harness/README.md";
function request(task_id = "WF-TEST"): WorkflowRequest {
  return { task_id, user_request: "Document the currently declared shared runtime architecture; do not implement changes.", task_type: "analysis",
    repository_scope: [".cartera/harness"], allowed_paths: [source], forbidden_paths: [], constraints: ["Read only"],
    discovery: [{ name: "discovery-code", role: "discovery-backend", paths: [source] }, { name: "discovery-tests", role: "discovery-tests", paths: [source] }] };
}
function evidence() { return [{ assertion: "The README declares a shared runtime", source: source + ":1", observation: "README title and declared architecture" }]; }
function output(stage: string): WorkflowOutput {
  const claim = { id: "C1", assertion: "Shared runtime declared", evidence: evidence() };
  const content: Record<string, any> = {
    "task-sense": { intent: "Document runtime", explicit_requirements: ["Document declared runtime"], implicit_requirements: [], out_of_scope: ["Implementation"], ambiguities: [], likely_domains: ["harness"], likely_frontend_impact: false, likely_backend_impact: false, possible_api_impact: false, possible_visual_impact: false },
    discovery: { scope: [source], files_inspected: [source], symbols: [], patterns: [], existing_behavior: [claim], tests_found: [], contracts_found: [], dependencies: [], evidence: evidence(), uncertainties: [], ambiguity_triage: [] },
    flow: { entry_points: [claim], steps: [claim], components: [], data_transformations: [], side_effects: [], external_dependencies: [], error_paths: [], frontend_backend_edges: [], persistence_edges: [], evidence: evidence(), unknowns: [] },
    truth: { confirmed: [claim], rejected: [], contradicted: [{ id: "C2", assertion: "A false earlier claim", evidence: evidence() }], unverified: [], missing_evidence: [], actual_system_truth: ["C1"] },
    gap: { missing_behaviors: [], missing_integrations: [], missing_contracts: [], affected_surfaces: [], confirmed_non_gaps: [{ assertion: "Architecture already declared", truth_claim_ids: ["C1"], evidence: evidence() }], out_of_scope: ["Implementation"], unknowns: [], evidence: evidence() },
  };
  return { stage: stage as WorkflowOutput["stage"], content: content[stage] };
}
function result(r: AgentExecutionRequest): AgentResult {
  const stage = r.capsule.constraints.find(c => c.startsWith("WORKFLOW_STAGE:"))?.split(":")[1];
  return { task_id: r.capsule.task_id, role: r.capsule.role, status: "completed", summary: "Evidence inspected", changed_files: [], evidence: evidence(),
    tests_executed: [], tests_not_executed: [], api_contract_status: "not_applicable", visual_lock_status: "not_applicable", scope_expanded: false, deviations: [], risks: [], known_issues: [], requested_followups: [], ...(stage ? { workflow_output: output(stage) } : {}) };
}
async function fixture(change?: (r: AgentExecutionRequest, value: AgentResult) => Promise<AgentResult>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cartera-workflow-test-")));
  const calls: AgentExecutionRequest[] = [];
  const provider = { async execute(r: AgentExecutionRequest) {
    const value = result(r);
    if (r.capsule.constraints.includes("READ_ONLY_SMOKE")) { r.observe?.({ exit_code: 0, test_double: true }); return value; }
    calls.push(r);
    return change ? change(r, value) : value;
  } };
  const bus = new AgentBus(new Storage(root), { codex: provider, claude: provider });
  bus.runtime.repositories.push(".cartera/harness");
  const [codex, claude] = config().provider_smoke_tasks;
  await bus.smoke("codex", codex, true); await bus.smoke("claude", claude, true);
  return { bus, service: new WorkflowService(bus), calls, root, clean: () => rmSync(root, { recursive: true, force: true }) };
}

test("workflow creates real child capsules on the persisted role routes and artifact-backed state", async () => {
  const f = await fixture();
  try {
    await f.service.start(request());
    f.bus.events.append("WF-TEST", "private.orchestrator.note", { transcript: "PRIVATE_TRANSCRIPT_SENTINEL" });
    const shown = await f.service.resume("WF-TEST", true);
    assert.equal(shown.state, "GAP_DEFINED");
    assert.equal(f.calls.length, 6);
    const routes = f.bus.routing("WF-TEST")!.routes;
    assert.ok(f.calls.every(r => { const e = routes[r.capsule.role]; return r.route.provider === e.provider && r.route.model === e.model && r.route.effort === e.effort; }));
    assert.ok(f.calls.every(r => r.capsule.permissions === "read-only" && !r.capsule.worktree));
    const artifacts = f.service.artifacts("WF-TEST");
    assert.equal(artifacts.length, 6);
    for (const a of artifacts) {
      const { content_hash, ...body } = a;
      assert.equal(content_hash, hash(body));
      assert.equal(a.source_agent_result.content_hash, hash(f.bus.result(a.child_task)));
      assert.equal(f.bus.events.get(a.child_task).capsule.parent_task_id, "WF-TEST");
    }
    assert.equal(f.bus.runtime.model_execution_enabled, false);
    await assert.rejects(f.bus.delegate("WF-TEST-task-sense", false), /MODEL_EXECUTION_DISABLED/);
    assert.throws(() => f.bus.transition("WF-TEST", "PROPOSAL_CREATED", 6), /WORKFLOW_STOPS_AT_GAP/);
    assert.equal((await invoke(f.bus, "workflow_show", { task_id: "WF-TEST" }) as any).state, "GAP_DEFINED");
    const truth = f.calls.find(r => r.capsule.role === "truth")!;
    assert.ok(!truth.prompt.includes("PRIVATE_TRANSCRIPT_SENTINEL"));
    assert.ok(truth.capsule.required_context.includes(source));
    assert.ok(truth.capsule.responsibility.includes("REOPEN"));
    assert.notEqual(truth.capsule.task_id, "WF-TEST");
    assert.equal(JSON.parse(truth.capsule.inputs[0]).artifacts.length, 4);
    const gap = f.calls.find(r => r.capsule.role === "gap")!;
    assert.deepEqual(JSON.parse(gap.capsule.inputs[0]).artifacts.map((a: any) => a.output.stage), ["truth"]);
    assert.equal(artifacts.find(a => a.stage === "truth")!.output.content.contradicted.length, 1);
    assert.equal(JSON.parse(readFileSync(truth.result_schema_path, "utf8")).properties.workflow_output.anyOf[0].properties.stage.const, "truth");
  } finally { f.clean(); }
});

test("state cannot advance without required artifacts and duplicate start is rejected", async () => {
  const f = await fixture();
  try {
    await f.service.start(request());
    f.bus.transition("WF-TEST", "TASK_CLASSIFIED", 0);
    assert.throws(() => f.bus.transition("WF-TEST", "TASK_SENSE_COMPLETE", 1));
    assert.equal(f.bus.events.get("WF-TEST").state, "TASK_CLASSIFIED");
    await assert.rejects(f.service.start(request()), /TASK_EXISTS/);
    assert.equal(f.calls.length, 0);
  } finally { f.clean(); }
});

test("partial discovery failure remains visible and is not automatically retried", async () => {
  const f = await fixture(async (r, value) => { if (r.capsule.role === "discovery-tests") throw new Error("INDEPENDENT_FAILURE"); return value; });
  try {
    await f.service.start(request());
    await assert.rejects(f.service.resume("WF-TEST", true), /INDEPENDENT_FAILURE/);
    assert.equal(f.bus.events.get("WF-TEST").state, "TASK_SENSE_COMPLETE");
    const show = f.service.show("WF-TEST");
    assert.equal(show.nodes.find(n => n.role === "discovery-backend")!.status, "completed");
    assert.equal(show.nodes.find(n => n.role === "discovery-tests")!.status, "failed");
    const calls = f.calls.length;
    await assert.rejects(f.service.resume("WF-TEST", true), /EXPLICIT_NEW_TASK_REQUIRED/);
    assert.equal(f.calls.length, calls);
  } finally { f.clean(); }
});

test("resume reuses persisted earlier stages and guards concurrent execution", async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const f = await fixture(async (r, value) => { if (r.capsule.role === "flow") { reached(); await hold; } return value; });
  try {
    await f.service.start(request());
    const running = f.service.resume("WF-TEST", true);
    await started;
    await assert.rejects(f.service.resume("WF-TEST", true), /EEXIST/);
    release(); await running;
    const count = f.calls.length;
    await new WorkflowService(f.bus).resume("WF-TEST", true);
    assert.equal(f.calls.length, count);
    // Simulate a persisted stage boundary before Flow: replay contains only the
    // transitions/artifacts through Discovery, with later results absent.
    const rootEvents = f.bus.events.list("WF-TEST");
    const boundary = rootEvents.findIndex(e => e.event_type === "task.transitioned" && e.payload.to === "DISCOVERY_COMPLETE");
    writeFileSync(f.bus.storage.path("events", "WF-TEST.jsonl"), rootEvents.slice(0, boundary + 1).map(e => JSON.stringify(e)).join("\n") + "\n");
    for (const suffix of ["flow", "truth", "gap"]) {
      for (const parts of [["events", `WF-TEST-${suffix}.jsonl`], ["results", `WF-TEST-${suffix}.json`], ["workflows", "WF-TEST", "artifacts", `WF-TEST-${suffix}.json`]]) rmSync(f.bus.storage.path(...parts));
    }
    await new WorkflowService(f.bus).resume("WF-TEST", true);
    assert.deepEqual(f.calls.slice(count).map(r => r.capsule.role), ["flow", "truth", "gap"]);
  } finally { release(); f.clean(); }
});

test("tampered provenance and unsupported Gap inputs fail closed", async () => {
  const f = await fixture();
  try {
    await f.service.start(request(), true);
    const artifacts = f.service.artifacts("WF-TEST");
    const inputs = selectedInputs("gap", artifacts), c = childCapsule(request(), "gap", artifacts);
    const bad = output("gap"); bad.content.confirmed_non_gaps[0].truth_claim_ids = ["C2"];
    assert.throws(() => checkOutput(bad, c, inputs), /GAP_UNVERIFIED_CLAIM/);
    assert.throws(() => checkOutput(output("gap"), c, []), /GAP_REQUIRES_VERIFIED_TRUTH/);
    const equivalent = structuredClone(inputs);
    equivalent[0].output.content.confirmed[0].evidence[0].source = `${source}:1-3; ${source}:5`;
    checkOutput(output("gap"), c, equivalent);
    const outside = output("gap"); outside.content.confirmed_non_gaps[0].evidence[0].source = source + ":6";
    assert.throws(() => checkOutput(outside, c, equivalent), /GAP_EVIDENCE_NOT_IN_TRUTH/);
    const p = f.bus.storage.path("workflows", "WF-TEST", "artifacts", "WF-TEST-truth.json");
    const truth = JSON.parse(readFileSync(p, "utf8")); truth.provider = "forged"; writeFileSync(p, JSON.stringify(truth));
    assert.throws(() => f.service.show("WF-TEST"), /PROVENANCE_INVALID/);
    await assert.rejects(f.service.resume("WF-TEST", true), /PROVENANCE_INVALID/);
  } finally { f.clean(); }
});

test("read-only fan-out is bounded and all independent outcomes are persisted", async () => {
  let active = 0, maximum = 0;
  const f = await fixture(async (r, value) => {
    if (r.capsule.role.startsWith("discovery-")) { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 15)); active--; }
    return value;
  });
  try {
    const r = request(); r.discovery.push({ name: "discovery-extra", role: "discovery-tests", paths: [source] });
    await f.service.start(r, true);
    assert.equal(maximum, 2);
    assert.equal(f.service.artifacts(r.task_id).filter(a => a.stage === "discovery").length, 3);
    await assert.rejects(f.service.start({ ...request("UNSAFE"), discovery: [{ name: "discovery-write", role: "backend-worker", paths: [source] }] }), /INVALID_WORKFLOW_REQUEST/);
  } finally { f.clean(); }
});

test("provider schema failures require explicit bounded retry and preserve earlier attempts", async () => {
  let failed = false;
  const f = await fixture(async (r, value) => {
    if (!failed && r.capsule.role === "task-sense") {
      failed = true; r.observe?.({ exit_code: 1, errors: ["invalid_json_schema: type required"] });
      throw new Error("SCHEMA_REJECTED");
    }
    return value;
  });
  try {
    await f.service.start(request());
    await assert.rejects(f.service.resume("WF-TEST", true), /SCHEMA_REJECTED/);
    await assert.rejects(f.service.resume("WF-TEST", true), /EXPLICIT_NEW_TASK_REQUIRED/);
    const result = await f.service.resume("WF-TEST", true, "WF-TEST-task-sense");
    assert.equal(result.state, "GAP_DEFINED");
    assert.equal(f.calls.filter(r => r.capsule.role === "task-sense").length, 2);
    assert.ok(f.bus.events.list("WF-TEST-task-sense").some(e => e.event_type === "agent.failed"));
    assert.equal(f.bus.events.list("WF-TEST-task-sense").filter(e => e.event_type === "workflow.provider-retry.authorized").length, 1);
    await assert.rejects(f.service.resume("WF-TEST", true, "WF-TEST-task-sense"), /PROVIDER_RETRY_NOT_ALLOWED/);
  } finally { f.clean(); }
});

test("Truth cannot confirm unsupported evidence and workers cannot start workflows", async () => {
  const f = await fixture();
  try {
    const c = childCapsule(request(), "truth", []);
    const bad = output("truth"); bad.content.confirmed[0].evidence = [];
    assert.throws(() => checkOutput(bad, c, []), /workflow-truth/);
    const forged = output("truth"); forged.content.actual_system_truth = ["UNKNOWN"];
    assert.throws(() => checkOutput(forged, c, []), /TRUTH_UNSUPPORTED_CONFIRMATION/);
    const worker = new AgentBus(f.bus.storage, {}, "worker", "truth");
    await assert.rejects(new WorkflowService(worker).start(request()), /WORKERS_DO_NOT_ORCHESTRATE/);
    await assert.rejects(worker.delegateWorkflow("WF-TEST"), /WORKERS_DO_NOT_ORCHESTRATE/);
  } finally { f.clean(); }
});

test("top-level AgentResult.evidence of discovery, truth and gap is validated like the stage output", async () => {
  const cases: [string, string, string, RegExp][] = [
    ["discovery-backend", "discovery-code", ".cartera/harness/package.json:1", /EVIDENCE_OUTSIDE_SCOPE/],
    ["discovery-tests", "discovery-tests", ".cartera/harness/runtime/src", /EVIDENCE_FILE_LINE_REQUIRED/],
    ["truth", "truth", ".cartera/harness/package.json:1", /EVIDENCE_OUTSIDE_SCOPE/],
    ["gap", "gap", `${source}:2`, /GAP_EVIDENCE_NOT_IN_TRUTH/],
  ];
  for (const [role, child, cited, expected] of cases) {
    const f = await fixture(async (r, value) => { if (r.capsule.role === role) value.evidence = [{ assertion: "Top-level citation under test", source: cited, observation: "not derived from the stage inputs" }]; return value; });
    try {
      await f.service.start(request());
      await assert.rejects(f.service.resume("WF-TEST", true), expected, `${role} citing ${cited}`);
      assert.ok(!f.bus.storage.exists("workflows", "WF-TEST", "artifacts", `WF-TEST-${child}.json`), `${role} artifact was not published`);
    } finally { f.clean(); }
  }
});

test("citation validation checks every file and complete line ranges", async () => {
  const c = childCapsule(request(), "truth", []);
  const good = output("truth");
  good.content.confirmed[0].evidence[0].source = `${source}:1,3-4; ${source}:5`;
  checkOutput(good, c, []);
  good.content.confirmed[0].evidence[0].source = `${source}:1; ${source}:999999`;
  assert.throws(() => checkOutput(good, c, []), /EVIDENCE_LINE_MISSING/);
  good.content.confirmed[0].evidence[0].source = "capsule.allowed_paths / capsule.required_context";
  assert.throws(() => checkOutput(good, c, []), /EVIDENCE_FILE_LINE_REQUIRED/);
});

test("architecture review uses a separate scoped invocation bound to source and workflow hashes", async () => {
  let expectedHash = "";
  const f = await fixture(async (r, value) => r.capsule.role === "adversarial-reviewer" ? {
    ...value, review_result: { task_id: "WF-TEST", reviewer: r.capsule.task_id, role: r.capsule.role, subject_hash: expectedHash,
      verdict: "approved", evidence: evidence(), findings: [] },
  } : value);
  try {
    await f.service.start(request(), true);
    expectedHash = reviewSubject(f.bus, "WF-TEST").subject_hash;
    await reviewWorkflow(f.bus, "WF-TEST", "REVIEW-TEST", true);
    assert.equal(f.bus.events.get("WF-TEST").state, "GAP_DEFINED");
    assert.equal(f.bus.result("REVIEW-TEST").review_result!.subject_hash, expectedHash);
    assert.equal(f.calls.at(-1)!.capsule.role, "adversarial-reviewer");
    assert.equal(f.bus.events.list("WF-TEST").at(-1)!.event_type, "workflow.architecture.reviewed");
  } finally { f.clean(); }
});

test("explicit replacement creates a fresh child while preserving failure and prior work", async () => {
  const f = await fixture(async (r, value) => {
    if (r.capsule.task_id === "WF-TEST-truth") throw new Error("INVALID_AGENT_RESULT");
    return value;
  });
  try {
    await assert.rejects(f.service.start(request(), true), /INVALID_AGENT_RESULT/);
    assert.equal(f.bus.events.get("WF-TEST").state, "FLOW_COMPLETE");
    const count = f.calls.length;
    const replaced = f.service.replaceFailedChild("WF-TEST", "WF-TEST-truth", "Explicit fresh independent verification");
    assert.equal(replaced.replacement_child, "WF-TEST-truth-retry-1");
    await f.service.resume("WF-TEST", true);
    assert.deepEqual(f.calls.slice(count).map(r => r.capsule.task_id), ["WF-TEST-truth-retry-1", "WF-TEST-gap"]);
    assert.equal(f.service.show("WF-TEST").state, "GAP_DEFINED");
    assert.equal(f.service.artifacts("WF-TEST").find(a => a.stage === "truth")!.child_task, "WF-TEST-truth-retry-1");
    assert.ok(f.bus.events.list("WF-TEST-truth").some(e => e.event_type === "agent.failed"));
    assert.throws(() => f.service.replaceFailedChild("WF-TEST", "WF-TEST-truth-retry-1", "Do not replace success"), /ONLY_FAILED_CHILD/);
  } finally { f.clean(); }
});

test("resume recovers a validated persisted result when completion recording was interrupted", async () => {
  const f = await fixture();
  const append = f.bus.events.append.bind(f.bus.events);
  let interrupted = false;
  f.bus.events.append = (...args) => {
    if (!interrupted && args[0] === "WF-TEST-truth" && args[1] === "agent.completed") {
      interrupted = true;
      throw new Error("SIMULATED_INTERRUPTION_AFTER_RESULT_PERSISTENCE");
    }
    return append(...args);
  };
  try {
    await assert.rejects(f.service.start(request(), true), /SIMULATED_INTERRUPTION/);
    assert.equal(f.bus.storage.exists("results", "WF-TEST-truth.json"), true);
    assert.equal(f.bus.storage.exists("workflows", "WF-TEST", "artifacts", "WF-TEST-truth.json"), false);
    const original = f.bus.result("WF-TEST-truth");
    const count = f.calls.length;
    f.bus.events.append = append;
    await f.service.resume("WF-TEST", true);
    assert.deepEqual(f.calls.slice(count).map(r => r.capsule.role), ["gap"]);
    assert.deepEqual(f.bus.result("WF-TEST-truth"), original);
    const completed = f.bus.events.list("WF-TEST-truth").filter(e => e.event_type === "agent.completed");
    assert.equal(completed.length, 1);
    assert.equal(completed[0].payload.recovered, true);
    assert.ok(completed[0].payload.validation_event_id);
    assert.equal(f.service.show("WF-TEST").state, "GAP_DEFINED");
    await f.service.resume("WF-TEST", true);
    assert.equal(f.bus.events.list("WF-TEST-truth").filter(e => e.event_type === "agent.completed").length, 1);
  } finally { f.clean(); }
});

test("an orphan result without a matching validation receipt cannot poison artifacts or prevent explicit replacement", async () => {
  for (const mode of ["missing-receipt", "changed-result"] as const) {
    const f = await fixture();
    const append = f.bus.events.append.bind(f.bus.events);
    f.bus.events.append = (...args) => {
      if (args[0] === "WF-TEST-truth" && args[1] === "agent.completed") throw new Error("SIMULATED_INTERRUPTION");
      return append(...args);
    };
    try {
      await assert.rejects(f.service.start(request(), true), /SIMULATED_INTERRUPTION/);
      f.bus.events.append = append;
      if (mode === "missing-receipt") {
        const events = f.bus.events.list("WF-TEST-truth").filter(e => e.event_type !== "agent.result.validated");
        writeFileSync(f.bus.storage.path("events", "WF-TEST-truth.jsonl"), events.map(e => JSON.stringify(e)).join("\n") + "\n");
      } else {
        const changed = { ...f.bus.result("WF-TEST-truth"), summary: "Tampered after validation" };
        writeFileSync(f.bus.storage.path("results", "WF-TEST-truth.json"), JSON.stringify(changed));
      }
      const count = f.calls.length;
      await assert.rejects(f.service.resume("WF-TEST", true), /VALIDATION_RECEIPT_REQUIRED/);
      assert.equal(f.calls.length, count);
      assert.equal(f.bus.storage.exists("workflows", "WF-TEST", "artifacts", "WF-TEST-truth.json"), false);
      assert.equal(f.service.show("WF-TEST").state, "FLOW_COMPLETE");
      f.service.replaceFailedChild("WF-TEST", "WF-TEST-truth", "Explicit replacement for unverified orphan result");
      await f.service.resume("WF-TEST", true);
      assert.equal(f.service.show("WF-TEST").state, "GAP_DEFINED");
    } finally { f.clean(); }
  }
});

test("resume authorizes an intact child left between creation and parent authorization without repeating workers", async () => {
  const f = await fixture();
  const append = f.bus.events.append.bind(f.bus.events);
  let interrupted = false;
  f.bus.events.append = (...args) => {
    if (!interrupted && args[0] === "WF-TEST" && args[1] === "workflow.child.created" && args[2].child_task === "WF-TEST-discovery-code") {
      interrupted = true;
      throw new Error("SIMULATED_INTERRUPTION_BEFORE_CHILD_AUTHORIZATION");
    }
    return append(...args);
  };
  try {
    await assert.rejects(f.service.start(request(), true), /SIMULATED_INTERRUPTION/);
    assert.deepEqual(f.bus.events.list("WF-TEST-discovery-code").map(e => e.event_type), ["task.created"]);
    assert.ok(f.service.artifacts("WF-TEST").some(a => a.child_task === "WF-TEST-discovery-tests"));
    f.bus.events.append = append;
    await f.service.resume("WF-TEST", true);
    assert.equal(f.service.show("WF-TEST").state, "GAP_DEFINED");
    for (const child of ["WF-TEST-discovery-code", "WF-TEST-discovery-tests"]) {
      assert.equal(f.calls.filter(r => r.capsule.task_id === child).length, 1);
    }
    const authorization = f.bus.events.list("WF-TEST").find(e => e.event_type === "workflow.child.created" && e.payload.child_task === "WF-TEST-discovery-code")!;
    assert.equal(authorization.payload.recovered, true);
  } finally { f.clean(); }
});

test("resume never repairs missing authorization after a child has attempted execution", async () => {
  const f = await fixture(async (r, value) => {
    if (r.capsule.role === "truth") throw new Error("SIMULATED_WORKER_FAILURE");
    return value;
  });
  try {
    await assert.rejects(f.service.start(request(), true), /SIMULATED_WORKER_FAILURE/);
    const events = f.bus.events.list("WF-TEST").filter(e => !(e.event_type === "workflow.child.created" && e.payload.child_task === "WF-TEST-truth"));
    writeFileSync(f.bus.storage.path("events", "WF-TEST.jsonl"), events.map(e => JSON.stringify(e)).join("\n") + "\n");
    const count = f.calls.length;
    await assert.rejects(f.service.resume("WF-TEST", true), /CHILD_AUTHORIZATION_MISSING_AFTER_EXECUTION/);
    assert.equal(f.calls.length, count);
  } finally { f.clean(); }
});

test("implementation compatibility detects source and emitted provider changes", () => {
  const root = mkdtempSync(join(tmpdir(), "cartera-compatibility-test-"));
  try {
    mkdirSync(join(root, "runtime/src/workflow"), { recursive: true });
    mkdirSync(join(root, "dist/runtime/src/providers"), { recursive: true });
    const sourcePath = join(root, "runtime/src/workflow/artifacts.ts");
    const emittedPath = join(root, "dist/runtime/src/providers/codex.js");
    writeFileSync(sourcePath, "validateEvidence();");
    writeFileSync(emittedPath, "readOnlySandbox();");
    const before = implementationHash(root);
    writeFileSync(sourcePath, "validateAllEvidence();");
    const sourceChanged = implementationHash(root);
    assert.notEqual(before, sourceChanged);
    writeFileSync(emittedPath, "differentSandboxPolicy();");
    assert.notEqual(sourceChanged, implementationHash(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("partial workflow with an older compatibility digest is blocked before provider execution", async () => {
  const f = await fixture();
  try {
    await f.service.start(request());
    const path = f.bus.storage.path("workflows", "WF-TEST", "manifest.json");
    const old = JSON.parse(readFileSync(path, "utf8"));
    old.compatibility_hash = hash("previous runtime implementation");
    writeFileSync(path, JSON.stringify(old));
    const events = f.bus.events.list("WF-TEST");
    events.find(e => e.event_type === "workflow.created")!.payload.manifest_hash = hash(old);
    writeFileSync(f.bus.storage.path("events", "WF-TEST.jsonl"), events.map(e => JSON.stringify(e)).join("\n") + "\n");
    await assert.rejects(f.service.resume("WF-TEST", true), /WORKFLOW_VERSION_INCOMPATIBLE/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.service.show("WF-TEST").state, "TASK_RECEIVED");
  } finally { f.clean(); }
});

test("repeating the original start recovers either root initialization boundary without changing task identity", async () => {
  for (const boundary of ["before-manifest", "before-workflow-event"] as const) {
    const f = await fixture();
    const create = f.bus.storage.create.bind(f.bus.storage), append = f.bus.events.append.bind(f.bus.events);
    if (boundary === "before-manifest") f.bus.storage.create = (parts, value) => {
      if (parts.at(-1) === "manifest.json") throw new Error("SIMULATED_ROOT_INTERRUPTION");
      return create(parts, value);
    };
    else f.bus.events.append = (...args) => {
      if (args[1] === "workflow.created") throw new Error("SIMULATED_ROOT_INTERRUPTION");
      return append(...args);
    };
    try {
      await assert.rejects(f.service.start(request(), true), /SIMULATED_ROOT_INTERRUPTION/);
      assert.equal(f.calls.length, 0);
      f.bus.storage.create = create; f.bus.events.append = append;
      const changed = request(); changed.discovery[0].role = "discovery-frontend";
      await assert.rejects(f.service.start(changed, true), /ROOT_INITIALIZATION_INCOMPATIBLE/);
      assert.equal(f.calls.length, 0);
      await f.service.start(request(), true);
      assert.equal(f.service.show("WF-TEST").state, "GAP_DEFINED");
      assert.equal(f.bus.events.list("WF-TEST").filter(e => e.event_type === "task.created").length, 1);
      assert.equal(f.bus.events.list("WF-TEST").find(e => e.event_type === "workflow.created")!.payload.recovered, true);
      assert.equal(f.calls.length, 6);
      await assert.rejects(f.service.start(request(), true), /TASK_EXISTS/);
    } finally { f.clean(); }
  }
});

test("blocking ambiguity aggregation distinguishes unresolved claims from evidenced responsibility boundaries", async () => {
  for (const mode of ["open", "policy", "missing", "no-evidence", "closed", "not-applicable", "all-not-applicable", "not-applicable-no-evidence"] as const) {
    const f = await fixture(async (r, value) => {
      const stage = value.workflow_output?.stage, content = value.workflow_output?.content;
      if (stage === "task-sense") content!.ambiguities = [{ id: "DQ1", question: "Is the runtime shared?", blocking: true }];
      if (stage === "discovery") {
        const second = r.capsule.role === "discovery-tests";
        const outside = mode === "all-not-applicable" || (second && ["not-applicable", "not-applicable-no-evidence"].includes(mode));
        content!.ambiguity_triage = second && mode === "missing" ? [] : [{ id: "DQ1", kind: second && mode === "policy" ? "policy" : "factual", status: outside ? "not_applicable" : second && mode === "open" ? "open" : "closed", answer: outside ? "This responsibility only inspects documented test scope; implementation owns the question." : "Shared runtime declared", evidence: second && ["no-evidence", "not-applicable-no-evidence"].includes(mode) ? [] : evidence() }];
      }
      return value;
    });
    try {
      if (mode === "closed" || mode === "not-applicable") assert.equal((await f.service.start(request(), true)).state, "GAP_DEFINED");
      else {
        await assert.rejects(f.service.start(request(), true), /WORKFLOW_AMBIGUITY_UNRESOLVED: DQ1/);
        assert.equal(f.service.show("WF-TEST").state, "DISCOVERY_COMPLETE");
        assert.ok(!f.calls.some(r => r.capsule.role === "flow"));
        const count = f.calls.length;
        await assert.rejects(f.service.resume("WF-TEST", true), /WORKFLOW_AMBIGUITY_UNRESOLVED/);
        assert.equal(f.calls.length, count);
      }
    } finally { f.clean(); }
  }
});

test("Discovery adapter revisions preserve legacy capsules while giving new children explicit scope triage", () => {
  const r = request();
  const legacy = childCapsule(r, "discovery", [], r.discovery[0], 1);
  const current = childCapsule(r, "discovery", [], r.discovery[0], 2);
  assert.ok(legacy.responsibility.includes("closed/open with evidence"));
  assert.ok(!legacy.responsibility.includes("not_applicable"));
  assert.ok(current.responsibility.includes("not_applicable"));
  assert.deepEqual({ ...current, responsibility: legacy.responsibility }, legacy);
});

test("corrupt artifacts fail closed without inference or automatic overwrite", async () => {
  const f = await fixture(async (r, value) => {
    if (r.capsule.role === "flow") throw new Error("SIMULATED_FLOW_FAILURE");
    return value;
  });
  try {
    await assert.rejects(f.service.start(request(), true), /SIMULATED_FLOW_FAILURE/);
    const path = f.bus.storage.path("workflows", "WF-TEST", "artifacts", "WF-TEST-task-sense.json");
    const truncated = "{\"root_task\":\"WF-TEST\",";
    writeFileSync(path, truncated);
    const count = f.calls.length, eventHash = hash(f.bus.events.list("WF-TEST"));
    await assert.rejects(f.service.resume("WF-TEST", true), SyntaxError);
    assert.throws(() => f.service.replaceFailedChild("WF-TEST", "WF-TEST-task-sense", "Cannot erase corrupt artifacts"), /ONLY_FAILED_CHILD/);
    assert.equal(f.calls.length, count);
    assert.equal(hash(f.bus.events.list("WF-TEST")), eventHash);
    assert.equal(readFileSync(path, "utf8"), truncated);
  } finally { f.clean(); }
});

test("an understanding stage may block honestly with evidence=[] and workflow_output=null and publishes no artifact", async () => {
  const f = await fixture(async (r, value) => r.capsule.role === "discovery-tests" ? { ...value, status: "blocked", evidence: [], workflow_output: null, known_issues: ["No verifiable test evidence in scope"] } : value);
  try {
    await f.service.start(request());
    await assert.rejects(f.service.resume("WF-TEST", true), /WORKFLOW_CHILD_NOT_COMPLETED/);
    const call = f.calls.find(r => r.capsule.role === "discovery-tests")!;
    const wire = JSON.parse(readFileSync(call.result_schema_path, "utf8"));
    assert.equal(wire.properties.evidence.minItems, undefined);
    assert.deepEqual(wire.properties.workflow_output.anyOf[1], { type: "null" });
    assert.equal(f.bus.result(call.capsule.task_id).status, "blocked");
    assert.ok(!f.service.artifacts("WF-TEST").some(a => a.child_task === call.capsule.task_id));
    assert.equal(f.bus.events.get("WF-TEST").state, "TASK_SENSE_COMPLETE");
  } finally { f.clean(); }
});

test("an understanding stage claiming completed without evidence or without workflow_output publishes no artifact", async () => {
  for (const [change, error] of [[{ evidence: [] }, /INVALID_AGENT_RESULT: agent-result: \/evidence/], [{ workflow_output: null }, /WORKFLOW_CHILD_NOT_COMPLETED/]] as const) {
    const f = await fixture(async (r, value) => r.capsule.role === "discovery-tests" ? { ...value, ...change } as AgentResult : value);
    try {
      await f.service.start(request());
      await assert.rejects(f.service.resume("WF-TEST", true), error);
      assert.ok(!f.service.artifacts("WF-TEST").some(a => a.stage === "discovery" && a.role === "discovery-tests"));
    } finally { f.clean(); }
  }
});

test("adapter revision 2 semantics stay byte-identical", () => {
  // Hashes recorded before revision 3 existed (artifacts/p2-closure-20260924/m5-rev2-hash.txt).
  const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  assert.equal(sha(REV2_SEMANTICS), "978e9ac048a2b270fb811b7f375570f5652a25850ded545a315f2b24dc6bc119");
  const stages = ["task-sense", "discovery", "flow", "truth", "gap"] as const;
  const r: WorkflowRequest = { task_id: "FREEZE", user_request: "Freeze probe", task_type: null, repository_scope: ["repo"], allowed_paths: ["repo/src/a.ts"], forbidden_paths: ["repo/secret"], constraints: ["c1"], discovery: [{ name: "discovery-code", role: "discovery-backend", paths: ["repo/src/a.ts"] }] };
  const capsules = (revision: 1 | 2) => stages.map(s => childCapsule(r, s, [], s === "discovery" ? r.discovery[0] : undefined, revision));
  assert.equal(sha(capsules(1)), "b5732aff49899d674519bbf8541a4c99eec3784799e1b48b70fe7f8544a4cf3c");
  assert.equal(sha(capsules(2)), "74f62e178111801b90c7baceab57584e7caf2c2587a1f9df67e2295a5b1f368e");
  assert.equal(SEMANTICS, REV3_SEMANTICS);
});

test("a new root records adapter_revision 3 and its children use the revision 3 text", async () => {
  const f = await fixture();
  try {
    await f.service.start(request());
    assert.equal(f.bus.storage.read<any>("workflows", "WF-TEST", "manifest.json").adapter_revision, 3);
    await f.service.resume("WF-TEST", true);
    const flow = f.calls.find(r => r.capsule.role === "flow")!;
    assert.equal(flow.capsule.responsibility, REV3_SEMANTICS.flow);
    assert.deepEqual(flow.capsule.required_context, []);
    assert.equal(f.service.show("WF-TEST").state, "GAP_DEFINED");
  } finally { f.clean(); }
});

test("rev3 understanding prompt states each operational constraint once", async () => {
  const count = (text: string, fragment: string | RegExp) => text.split(fragment).length - 1;
  const r = request();
  for (const stage of ["task-sense", "discovery", "flow", "truth", "gap"] as const) {
    const capsule = childCapsule(r, stage, [], stage === "discovery" ? r.discovery[0] : undefined, 3);
    const text = [capsule.responsibility, ...capsule.constraints].join("\n");
    for (const rule of [REV3_OPERATIONAL_CONSTRAINTS.output, REV3_OPERATIONAL_CONSTRAINTS.language, REV3_OPERATIONAL_CONSTRAINTS.readOnly]) assert.equal(count(text, rule), 1, `${stage}: ${rule}`);
    assert.equal(count(text, REV3_OPERATIONAL_CONSTRAINTS.taskSenseEvidence), stage === "task-sense" ? 1 : 0, stage);
    for (const [fragment, label] of [[/Portuguese/g, "language"], [/write files/g, "no writes"], [/run tests/g, "no tests"], [/tests are executed/g, "no tests (rev2 wording)"], [/exact workspace(-relative)? file:line/g, "evidence format"]] as const)
      assert.ok(count(text, fragment) <= 1, `${stage}: ${label} stated more than once`);
    const rev2 = childCapsule(r, stage, [], stage === "discovery" ? r.discovery[0] : undefined, 2);
    const rev2Text = [rev2.responsibility, ...rev2.constraints].join("\n");
    if (stage === "discovery") assert.ok(count(rev2Text, /file:line|tests are executed|run tests/g) > count(text, /file:line|tests are executed|run tests/g), "rev2 repeated what rev3 states once");
  }
  const f = await fixture();
  try {
    await f.service.start(request());
    await f.service.resume("WF-TEST", true);
    for (const call of f.calls) {
      assert.equal(count(call.prompt, /Portuguese/g), 1, call.capsule.role);
      assert.equal(count(call.prompt, /write files/g), 1, call.capsule.role);
    }
  } finally { f.clean(); }
});

test("prompt attaches only the governance declared for the role", async () => {
  const heading = (file: string) => readFileSync(join(HARNESS_ROOT, "governance", file), "utf8").split("\n")[0];
  const f = await fixture();
  try {
    await f.service.start(request());
    await f.service.resume("WF-TEST", true);
    for (const role of ["task-sense", "discovery-backend", "flow", "truth", "gap"]) {
      const call = f.calls.find(c => c.capsule.role === role)!;
      assert.deepEqual(f.bus.router.role(role).governance, ["agent-behavior.md", "core.md", "scope.md"]);
      for (const file of ["agent-behavior.md", "core.md", "scope.md"]) assert.ok(call.prompt.includes(heading(file)), `${role} misses ${file}`);
      for (const file of ["api-contract.md", "visual.md", "testing.md"]) assert.ok(!call.prompt.includes(heading(file)), `${role} received ${file}`);
    }
    const tests = f.calls.find(c => c.capsule.role === "discovery-tests")!;
    assert.ok(tests.prompt.includes(heading("testing.md")));
    assert.ok(!tests.prompt.includes(heading("api-contract.md")));
  } finally { f.clean(); }
});
