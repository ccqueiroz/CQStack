import test from "node:test";
import assert from "node:assert/strict";
import { childCapsule, evidencePreflight } from "../src/workflow/adapters.js";
import type { WorkflowRequest } from "../src/workflow/contracts.js";

const directory = ".cartera/harness/state/fixtures/apply-demo/src";
const testFile = ".cartera/harness/state/fixtures/apply-demo/tests/pagination.test.mjs";
const request: WorkflowRequest = {
  task_id: "GAP-EVIDENCE-REGRESSION",
  user_request: "Compare the requested pagination defaults with the verified fixture behavior.",
  task_type: "fixture-validation", repository_scope: [".cartera/harness/state/fixtures/apply-demo"],
  allowed_paths: [directory, testFile], forbidden_paths: [], constraints: [],
  discovery: [{ name: "discovery-implementation", role: "discovery-backend", paths: [`${directory}/pagination.mjs`, testFile] }],
};

test("gap producer reuses the shared evidence preflight instead of a parallel mechanism", () => {
  const gap = childCapsule(request, "gap", []);
  const preflight = gap.constraints.find(c => c.startsWith("Evidence preflight"));
  assert.equal(preflight, evidencePreflight("gap"));
  assert.match(preflight!, /^Evidence preflight for gap: /);
  assert.match(preflight!, /Every evidence\.source MUST be exactly one allowed file followed by one existing line or verified range/);
  assert.match(preflight!, /Never use a capsule field such as capsule\.constraints, a logical name, a label, a directory or several paths in one source/);
  assert.match(preflight!, /including missing_behaviors, missing_integrations, missing_contracts, confirmed_non_gaps and the top-level evidence array/);
  assert.equal(gap.permissions, "read-only");
  assert.deepEqual(gap.allowed_paths, [directory, testFile]);
});

test("gap copies each source from confirmed Truth evidence and never cites the allowed directory item", () => {
  const preflight = evidencePreflight("gap");
  assert.match(preflight, /copied byte for byte from the evidence of a confirmed Truth claim whose id you cite in truth_claim_ids and that appears in actual_system_truth/);
  assert.ok(preflight.includes(`never cite a directory item of capsule.allowed_paths such as ${directory},`));
  assert.match(preflight, /never a path without line, never a line absent from the cited Truth evidence/);
  assert.match(preflight, /Gap gathers no new evidence/);
  assert.doesNotMatch(preflight, /copied byte for byte from one item of capsule\.allowed_paths/);
});

test("gap reports absence only through confirmed Truth evidence, otherwise as an unknown without source", () => {
  const preflight = evidencePreflight("gap");
  assert.match(preflight, /a module that does not exist yet.*cite only the confirmed Truth evidence that shows what exists instead/);
  assert.match(preflight, /A directory listing, a glob, a command, a path without line, a capsule field or the absence of a match is not evidence/);
  assert.match(preflight, /name it in unknowns as text without evidence; never invent a source to keep it as a gap/);
  assert.match(preflight, /no verifiable evidence.*status=blocked, evidence=\[\], omit workflow_output.*known_issues/);
});

test("discovery and truth preflights keep their wording so validated capsules stay compatible", () => {
  assert.match(evidencePreflight("discovery"), /The path before the colon MUST be copied byte for byte from one item of capsule\.allowed_paths/);
  assert.match(evidencePreflight("discovery"), /including nested evidence, ambiguity_triage and tests_found/);
  assert.match(evidencePreflight("truth"), /a file located inside a directory item of capsule\.allowed_paths/);
  assert.match(evidencePreflight("truth"), /including confirmed, rejected, contradicted and unverified/);
  for (const stage of ["discovery", "truth"] as const) assert.doesNotMatch(evidencePreflight(stage), /Gap gathers no new evidence/);
});

test("gap returns completed for a delivered verified artifact, blocked only for missing evidence, never needs_review", () => {
  const gap = childCapsule(request, "gap", []);
  assert.match(gap.responsibility, /deliver workflow_output with the required verified evidence, return AgentResult\.status="completed"/);
  assert.match(gap.responsibility, /known_issues and unknowns document limits, they never change the status/);
  assert.match(gap.responsibility, /status="blocked" only when the required evidence to produce the Gap is missing/);
  assert.match(gap.responsibility, /Never return needs_review from the Gap stage/);
  assert.match(gap.responsibility, /STOP at Gap; never invoke propose\/apply/, "the original gap semantics are preserved");
  assert.doesNotMatch(childCapsule(request, "gap", [], undefined, 1).responsibility, /needs_review/);
  for (const stage of ["task-sense", "discovery", "flow", "truth"] as const) {
    assert.doesNotMatch(childCapsule(request, stage, [], stage === "discovery" ? request.discovery[0] : undefined).responsibility, /Never return needs_review/);
  }
});
