import test from "node:test";
import assert from "node:assert/strict";
import { childCapsule } from "../src/workflow/adapters.js";
import type { WorkflowRequest } from "../src/workflow/contracts.js";

const path = "fixture/tests/pagination.test.mjs";
const request: WorkflowRequest = {
  task_id: "DISCOVERY-EVIDENCE-REGRESSION",
  user_request: "Inspect the existing pagination test without executing it.",
  task_type: "analysis", repository_scope: ["fixture"],
  allowed_paths: [path], forbidden_paths: [], constraints: [],
  discovery: [{ name: "discovery-tests", role: "discovery-tests", paths: [path] }],
};

test("discovery producers require verified lines and range endpoints before emitting evidence", () => {
  const capsule = childCapsule(request, "discovery", [], request.discovery[0]);
  const preflight = capsule.constraints.find(c => c.startsWith("Evidence preflight"));
  assert.ok(preflight, "The producer must instruct the worker before it can emit an out-of-file citation");
  assert.match(preflight, /read the scoped files yourself with numbered output/);
  assert.match(preflight, /only lines actually read and verified during this execution/);
  assert.match(preflight, /Before returning any path:line, confirm that the line exists and its content supports the observation/);
  assert.match(preflight, /verify every referenced line, including the end of each range/);
  assert.match(preflight, /AgentResult.evidence.*workflow_output.*nested evidence, ambiguity_triage and tests_found/);
  assert.match(preflight, /no verifiable evidence.*status=blocked, evidence=\[\], omit workflow_output.*known_issues/);
  assert.equal(capsule.permissions, "read-only");
  assert.deepEqual(capsule.allowed_paths, [path]);
  assert.deepEqual(capsule.owned_tests, []);
});

test("evidence.source format is exactly one allowed file plus an existing line, never capsule fields or several paths", () => {
  const capsule = childCapsule(request, "discovery", [], { ...request.discovery[0], name: "discovery-implementation", role: "discovery-backend" });
  const preflight = capsule.constraints.find(c => c.startsWith("Evidence preflight"))!;
  assert.match(preflight, /Every evidence\.source MUST be exactly one allowed file followed by one existing line or verified range/);
  assert.match(preflight, /Never use a capsule field such as capsule\.constraints, a logical name, a label, a directory or several paths in one source/);
  assert.match(preflight, /Put each cited file in its own evidence entry/);
  assert.match(preflight, /capsule fields and memory are not file evidence/);
  assert.match(preflight, /triage item without file evidence keeps evidence=\[\]/);
});

test("evidence.source path is copied exactly from capsule.allowed_paths, never relativized to cwd, fixture or repository", () => {
  const workspacePath = ".cartera/harness/state/fixtures/apply-demo/tests/pagination.test.mjs";
  const capsule = childCapsule({ ...request, allowed_paths: [workspacePath], discovery: [{ name: "discovery-tests", role: "discovery-tests", paths: [workspacePath] }] }, "discovery", [], { name: "discovery-tests", role: "discovery-tests", paths: [workspacePath] });
  assert.deepEqual(capsule.allowed_paths, [workspacePath]);
  const preflight = capsule.constraints.find(c => c.startsWith("Evidence preflight"))!;
  assert.match(preflight, /The path before the colon MUST be copied byte for byte from one item of capsule\.allowed_paths/);
  assert.ok(preflight.includes(`${workspacePath}:5 when that item is in allowed_paths`));
  assert.match(preflight, /never relativize it to your working directory, the fixture or the repository, never shorten it to tests\/file\.mjs, and never normalize or rewrite it/);
  assert.match(preflight, /If no allowed_paths item can support the evidence, return status=blocked instead of adapting the path/);
});

test("the evidence preflight applies to every discovery producer, to truth and to gap, never to task-sense or flow", () => {
  const tests = childCapsule(request, "discovery", [], request.discovery[0]);
  const preflight = tests.constraints.find(c => c.startsWith("Evidence preflight"));
  assert.ok(preflight);
  for (const role of ["discovery-backend", "discovery-frontend", "discovery-design-system"] as const) {
    const other = childCapsule(request, "discovery", [], { ...request.discovery[0], role });
    assert.deepEqual({ ...tests, role }, other);
  }
  assert.ok(childCapsule(request, "truth", []).constraints.some(c => c.startsWith("Evidence preflight for truth")));
  assert.ok(childCapsule(request, "gap", []).constraints.some(c => c.startsWith("Evidence preflight for gap")));
  for (const stage of ["task-sense", "flow"] as const) {
    assert.ok(!childCapsule(request, stage, []).constraints.some(c => c.startsWith("Evidence preflight")));
  }
});

test("flow synthesizes only from validated Task Sense and Discovery artifacts and never rediscovers", () => {
  const flow = childCapsule(request, "flow", []);
  assert.match(flow.responsibility, /using ONLY the supplied validated Task Sense and Discovery artifacts/);
  assert.match(flow.responsibility, /Do not reopen, read or search code, do not redo Discovery and do not gather new evidence/);
  assert.match(flow.responsibility, /reuse the file:line evidence already present in the Discovery artifacts, copying each source exactly/);
  assert.match(flow.responsibility, /insufficient.*or contain no citable source at all, the only valid result is AgentResult status=blocked with evidence=\[\] and no workflow_output/);
  assert.match(childCapsule(request, "flow", [], undefined, 2).responsibility, /insufficient.*status=blocked, evidence=\[\], omit workflow_output/);
  assert.doesNotMatch(flow.responsibility, /independently reopen/);
  assert.equal(flow.permissions, "read-only");
  assert.match(childCapsule(request, "flow", [], undefined, 1).responsibility, /independently reopen scoped code/);
});

test("flow separates the harness orchestration pipeline in the goal from the analyzed system flow", () => {
  const orchestrationGoal = "Usar o fluxo: Proposal aprovado -> API Contract Architect -> Front reviewer -> Back reviewer -> API Contract Lock -> workers em paralelo -> review-gate:apply -> DONE. No backend, adicionar defaults page=0 e size=20 à função paginate.";
  const flow = childCapsule({ ...request, user_request: orchestrationGoal }, "flow", []);
  assert.equal(flow.goal, orchestrationGoal, "The goal still carries the pipeline; the responsibility must tell the worker how to read it");
  assert.match(flow.responsibility, /Reconstruct exclusively the functional\/technical flow of the analyzed system/);
  assert.match(flow.responsibility, /Proposal, API Contract Architect, reviewers, API Contract Lock, workers, review-gate, worktrees, providers, DONE.*orchestration metadata, never hops of the analyzed system/);
  assert.match(flow.responsibility, /never turn its steps into entry_points, steps, components or edges, and never require evidence for them/);
  assert.match(flow.responsibility, /If the Discovery artifacts describe the system flow, synthesize that flow even when the goal also describes the harness pipeline/);
  assert.match(flow.responsibility, /insufficient to describe the system flow itself.*status=blocked.*never block because harness execution steps lack evidence/);
  assert.doesNotMatch(childCapsule(request, "flow", [], undefined, 1).responsibility, /orchestration metadata/);
  for (const stage of ["task-sense", "discovery", "truth", "gap"] as const) {
    assert.doesNotMatch(childCapsule(request, stage, [], stage === "discovery" ? request.discovery[0] : undefined).responsibility, /orchestration metadata/);
  }
});

test("task-sense marks blocking only task, product or code ambiguities, never operational harness questions", () => {
  const sense = childCapsule(request, "task-sense", []);
  assert.match(sense.responsibility, /blocking=true ONLY when it concerns the task, the product or the code and must be answered to define the implementation/);
  assert.match(sense.responsibility, /Never mark as blocking.*creation or existence of worktrees, provider or model, routing, grants, workflow execution or AgentBus internal state/);
  assert.match(sense.responsibility, /belong to the orchestrator, not to Discovery/);
  assert.match(sense.responsibility, /never inspect application code/);
  assert.deepEqual(sense.allowed_paths, []);
  assert.doesNotMatch(childCapsule(request, "task-sense", [], undefined, 1).responsibility, /operational harness questions/);
});
