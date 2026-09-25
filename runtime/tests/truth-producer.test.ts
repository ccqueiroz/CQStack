import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { HARNESS_ROOT, WORKSPACE_ROOT } from "../src/storage.js";
import { ENGINEERING_TEST_PREFIX } from "./test-state.js";
import { childCapsule, evidencePreflight } from "../src/workflow/adapters.js";
import { checkOutput } from "../src/workflow/artifacts.js";
import type { WorkflowRequest, WorkflowOutput } from "../src/workflow/contracts.js";

const directory = ".cartera/harness/state/fixtures/apply-demo/src";
const testFile = ".cartera/harness/state/fixtures/apply-demo/tests/pagination.test.mjs";
const request: WorkflowRequest = {
  task_id: "TRUTH-EVIDENCE-REGRESSION",
  user_request: "Verify the pagination fixture claims without executing anything.",
  task_type: "fixture-validation", repository_scope: [".cartera/harness/state/fixtures/apply-demo"],
  allowed_paths: [directory, testFile], forbidden_paths: [], constraints: [],
  discovery: [{ name: "discovery-implementation", role: "discovery-backend", paths: [`${directory}/pagination.mjs`, testFile] }],
};

function truthOutput(source: string): WorkflowOutput {
  const evidence = [{ assertion: "src/client.mjs does not exist yet", source, observation: "only pagination.mjs is present" }];
  return { stage: "truth", content: { confirmed: [{ id: "T1", assertion: "client.mjs is absent", evidence }], rejected: [], contradicted: [], unverified: [], missing_evidence: [], actual_system_truth: ["T1"] } } as WorkflowOutput;
}

test("truth producer reuses the shared evidence preflight instead of a parallel mechanism", () => {
  const truth = childCapsule(request, "truth", []);
  const preflight = truth.constraints.find(c => c.startsWith("Evidence preflight"));
  assert.equal(preflight, evidencePreflight("truth"));
  assert.match(preflight!, /^Evidence preflight for truth: read the scoped files yourself with numbered output/);
  assert.match(preflight!, /Every evidence\.source MUST be exactly one allowed file followed by one existing line or verified range/);
  assert.match(preflight!, /Never use a capsule field such as capsule\.constraints, a logical name, a label, a directory or several paths in one source/);
  assert.match(preflight!, /Apply this check to AgentResult\.evidence and every citation in workflow_output, including confirmed, rejected, contradicted and unverified/);
  assert.equal(truth.permissions, "read-only");
  assert.deepEqual(truth.allowed_paths, [directory, testFile]);
});

test("truth evidence path is an existing file inside allowed_paths, never the directory item itself", () => {
  const preflight = evidencePreflight("truth");
  assert.match(preflight, /a file located inside a directory item of capsule\.allowed_paths/);
  assert.ok(preflight.includes(`${directory}/pagination.mjs:1 when ${directory} is in allowed_paths`));
  assert.match(preflight, /never the directory item itself/);
  assert.match(preflight, /never a shortened, normalized or rewritten path/);
  assert.doesNotMatch(preflight, /copied byte for byte from one item of capsule\.allowed_paths/, "the discovery path rule would tell truth to cite the directory item");
});

test("truth asserts absence only with positive verifiable evidence and never confirms without it", () => {
  const preflight = evidencePreflight("truth");
  assert.match(preflight, /To assert that a file, symbol or behavior is absent, cite positive verifiable evidence that supports the conclusion/);
  assert.match(preflight, /A directory listing, a glob, a command, a path without line or the absence of a match is not file evidence/);
  assert.match(preflight, /Without such positive evidence the claim belongs in unverified with evidence=\[\]; never invent a source to keep it/);
  assert.match(preflight, /Put a claim in confirmed ONLY when sufficient verifiable file:line evidence supports it/);
  assert.match(preflight, /capsule fields such as capsule\.artifacts are claims, not evidence/);
  assert.match(preflight, /no verifiable evidence.*status=blocked, evidence=\[\], omit workflow_output.*known_issues/);
});

test("discovery keeps its original preflight wording so validated discovery capsules stay compatible", () => {
  const preflight = evidencePreflight("discovery");
  assert.match(preflight, /^Evidence preflight for discovery: /);
  assert.match(preflight, /The path before the colon MUST be copied byte for byte from one item of capsule\.allowed_paths/);
  assert.match(preflight, /A triage item without file evidence keeps evidence=\[\] and stays open or policy/);
  assert.match(preflight, /including nested evidence, ambiguity_triage and tests_found/);
  assert.doesNotMatch(preflight, /positive verifiable evidence/);
});

test("truth output validation rejects a directory, a capsule field and a path without line as evidence.source", t => {
  // The cited file must exist, so it is materialized under the test-temporary prefix instead of the ignored fixture.
  mkdirSync(join(HARNESS_ROOT, "state"), { recursive: true });
  const temporary = mkdtempSync(join(HARNESS_ROOT, "state", `${ENGINEERING_TEST_PREFIX}${process.pid}-truth-`));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  mkdirSync(join(temporary, "src"));
  writeFileSync(join(temporary, "src/pagination.mjs"), "export const page = 0;\n");
  const materialized = relative(WORKSPACE_ROOT, join(temporary, "src"));
  const capsule = childCapsule({ ...request, repository_scope: [relative(WORKSPACE_ROOT, temporary)], allowed_paths: [materialized, testFile] }, "truth", []);
  checkOutput(truthOutput(`${materialized}/pagination.mjs:1`), capsule, []);
  assert.throws(() => checkOutput(truthOutput(materialized), capsule, []), /EVIDENCE_FILE_LINE_REQUIRED/);
  assert.throws(() => checkOutput(truthOutput("capsule.artifacts.api_contract"), capsule, []), /EVIDENCE_FILE_LINE_REQUIRED/);
  assert.throws(() => checkOutput(truthOutput(`${materialized}/pagination.mjs`), capsule, []), /EVIDENCE_FILE_LINE_REQUIRED/);
});
