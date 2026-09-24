import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childCapsule, selectedInputs } from "../src/workflow/adapters.js";
import { checkOutput, WORKSPACE } from "../src/workflow/artifacts.js";
import { checkFlowResultEvidence, flowEvidenceAllowlist } from "../src/workflow/producers/flow.js";
import { assertClosedEvidence, checkFileEvidence, closedEvidenceAllowlist } from "../src/validation/evidence.js";
import { ClaudeProvider } from "../src/providers/claude.js";
import { Storage, hash } from "../src/storage.js";
import { AgentBus } from "../src/agent-bus/index.js";
import { Ajv } from "ajv";
import type { WorkflowArtifact, WorkflowOutput, WorkflowRequest } from "../src/workflow/contracts.js";
import type { AgentResult, Evidence, TaskCapsule } from "../src/contracts.js";

const readme = ".cartera/harness/README.md";
const directory = ".cartera/harness/runtime/src";
const request: WorkflowRequest = {
  task_id: "FLOW-EVIDENCE-REGRESSION",
  user_request: "Describe the documented runtime flow; a client module does not exist yet.",
  task_type: "analysis", repository_scope: [".cartera/harness"],
  allowed_paths: [readme, directory], forbidden_paths: [], constraints: [],
  discovery: [{ name: "discovery-docs", role: "discovery-backend", paths: [readme] }],
};
const evidence = (source: string, assertion = "The README declares the shared runtime"): Evidence[] => [{ assertion, source, observation: "Observed in the cited line" }];
function artifact(stage: WorkflowArtifact["stage"], content: Record<string, any>): WorkflowArtifact {
  const body = { root_task: request.task_id, child_task: `${request.task_id}-${stage === "discovery" ? "discovery-docs" : stage}`, stage, role: stage === "discovery" ? "discovery-backend" : stage,
    provider: "claude", model_alias: "sonnet", model: "sonnet", created_at: "2026-09-17T00:00:00.000Z",
    source_agent_result: { task_id: "x", content_hash: "a".repeat(64) }, input_artifact_references: [], output: { stage, content } as WorkflowOutput };
  return { ...body, content_hash: hash(body) };
}
const inputs = selectedInputs("flow", [
  artifact("task-sense", { intent: "Document runtime", explicit_requirements: ["Document declared runtime"], implicit_requirements: [], out_of_scope: [], ambiguities: [], likely_domains: ["harness"], likely_frontend_impact: false, likely_backend_impact: false, possible_api_impact: false, possible_visual_impact: false }),
  artifact("discovery", { scope: [readme], files_inspected: [readme], symbols: [], patterns: [], existing_behavior: [{ id: "D1", assertion: "Shared runtime declared", evidence: evidence(`${readme}:3`) }], tests_found: [], contracts_found: [], dependencies: [], evidence: evidence(`${readme}:1`), uncertainties: [], ambiguity_triage: [] }),
]);
function flowOutput(sources: string[], unknowns: string[] = [], assertion?: string): WorkflowOutput {
  const claims = sources.map((source, index) => ({ id: `F${index + 1}`, assertion: assertion ?? "Runtime hop", evidence: evidence(source, assertion) }));
  return { stage: "flow", content: { entry_points: claims.slice(0, 1), steps: claims, components: [], data_transformations: [], side_effects: [], external_dependencies: [], error_paths: [], frontend_backend_edges: [], persistence_edges: [], evidence: claims.flatMap(c => c.evidence), unknowns } };
}
const capsule = childCapsule(request, "flow", inputs);

test("flow evidence copied byte for byte from the validated Discovery artifact passes", () => {
  assert.deepEqual([...flowEvidenceAllowlist(inputs)].sort(), [`${readme}:1`, `${readme}:3`]);
  checkOutput(flowOutput([`${readme}:1`, `${readme}:3`]), capsule, inputs);
  checkFlowResultEvidence(evidence(`${readme}:3`), inputs);
});

test("a directory such as .../src is rejected by the flow allowlist before the artifact is published", () => {
  assert.throws(() => checkOutput(flowOutput([`${readme}:1`, directory]), capsule, inputs), /^Error: FLOW_EVIDENCE_NOT_IN_INPUTS: \.cartera\/harness\/runtime\/src$/);
  assert.throws(() => checkOutput(flowOutput([`${readme}:1`, `${directory}/index.ts`]), capsule, inputs), /FLOW_EVIDENCE_NOT_IN_INPUTS/);
});

test("evidence invented by the model is rejected even when the file and line exist inside the allowed scope", () => {
  const invented = `${readme}:2`;
  assert.doesNotThrow(() => checkFileEvidence(invented, capsule, WORKSPACE), "the generic file check alone would have accepted this citation");
  assert.throws(() => checkOutput(flowOutput([invented]), capsule, inputs), /FLOW_EVIDENCE_NOT_IN_INPUTS/);
  assert.throws(() => checkFlowResultEvidence(evidence(invented), inputs), /FLOW_EVIDENCE_NOT_IN_INPUTS/);
  assert.throws(() => checkOutput(flowOutput([`artifact:${inputs[1].child_task}`]), capsule, inputs), /FLOW_EVIDENCE_NOT_IN_INPUTS/);
  assert.throws(() => checkOutput(flowOutput([`task:${request.task_id}`]), capsule, inputs), /FLOW_EVIDENCE_NOT_IN_INPUTS/);
});

test("an absence claim never becomes flow evidence; it stays a textual unknown for Truth and Gap", () => {
  const absence = "src/client.mjs does not exist yet";
  assert.throws(() => checkOutput(flowOutput([directory], [], absence), capsule, inputs), /FLOW_EVIDENCE_NOT_IN_INPUTS/);
  assert.throws(() => checkOutput(flowOutput([`${readme}/client.mjs:1`], [], absence), capsule, inputs), /FLOW_EVIDENCE_NOT_IN_INPUTS/);
  checkOutput(flowOutput([`${readme}:1`], [absence]), capsule, inputs);
  assert.match(capsule.responsibility, /Absence of a file or behavior is not a Flow finding: name it in unknowns as text without evidence/);
  assert.match(capsule.responsibility, /The runtime rejects any evidence\.source, in workflow_output or AgentResult\.evidence, that is not present byte for byte/);
});

test("flow receives no code context and the Claude adapter grants it no tools, unlike Discovery", async () => {
  assert.deepEqual(capsule.required_context, []);
  assert.deepEqual(capsule.allowed_paths, request.allowed_paths, "scope is kept only to validate copied citations");
  assert.deepEqual(childCapsule(request, "flow", inputs, undefined, 1).required_context, request.allowed_paths, "legacy manifests keep their capsule hash");
  const directoryPath = realpathSync(mkdtempSync(join(tmpdir(), "cartera-flow-tools-")));
  try {
    const schema = join(directoryPath, "schema.json"); writeFileSync(schema, "{}");
    const seen: string[][] = [];
    const runner = async (input: { args: string[] }, c: TaskCapsule) => {
      seen.push(input.args);
      const done: AgentResult = { task_id: c.task_id, role: c.role, status: "completed", summary: "ok", changed_files: [], evidence: evidence(`${readme}:1`), tests_executed: [], tests_not_executed: [], api_contract_status: "not_applicable", visual_lock_status: "not_applicable", scope_expanded: false, deviations: [], risks: [], known_issues: [], requested_followups: [] };
      return { exit_code: 0, stdout: JSON.stringify({ structured_output: done }), stderr: "", signal: null };
    };
    const execute = (c: TaskCapsule) => new ClaudeProvider(((input: { args: string[] }) => runner(input, c)) as never).execute({ capsule: c, cwd: directoryPath, prompt: "p", result_schema_path: schema, timeout_ms: 1000,
      route: { provider: "claude", model_alias: "sonnet", model: "sonnet", effort: "medium", role: {} as never } });
    await execute(capsule);
    await execute(childCapsule(request, "discovery", inputs, request.discovery[0]));
    const tools = (args: string[]) => args[args.indexOf("--tools") + 1];
    assert.equal(tools(seen[0]), "");
    assert.equal(tools(seen[1]), "Read,Grep,Glob");
    assert.ok(!seen[0].includes("--allowedTools"));
  } finally { rmSync(directoryPath, { recursive: true, force: true }); }
});

test("the flow allowlist is the shared closed evidence allowlist: inherited file:line only, references only when supplied", () => {
  const shared = closedEvidenceAllowlist(inputs.map(a => a.output.content));
  assert.deepEqual([...shared].sort(), [...flowEvidenceAllowlist(inputs)].sort());
  const withReferences = closedEvidenceAllowlist([{ evidence: evidence(`artifact:${inputs[1].child_task}`) }, { evidence: evidence(directory) }], [`task:${request.task_id}`]);
  assert.deepEqual([...withReferences].sort(), [directory, `task:${request.task_id}`].sort(), "artifact:/task: forms come only from received references, never from inherited evidence");
  assert.throws(() => assertClosedEvidence(evidence(`${readme}:2`), shared, "FLOW_EVIDENCE_NOT_IN_INPUTS"), /^Error: FLOW_EVIDENCE_NOT_IN_INPUTS: \.cartera\/harness\/README\.md:2$/);
});

test("flow evidence allowlist never offers the discovery-only capsule literal", () => {
  const literal = "capsule.allowed_paths / capsule.required_context";
  const citing = selectedInputs("flow", [inputs[0], artifact("discovery", { ...inputs[1].output.content, evidence: [...evidence(`${readme}:1`), ...evidence(literal, "Scope read by Discovery")] })]);
  const allowlist = flowEvidenceAllowlist(citing);
  assert.equal(allowlist.has(literal), false);
  assert.deepEqual([...allowlist].sort(), [`${readme}:1`, `${readme}:3`]);
});

function flowWire(discoveryContent: Record<string, any>): any {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cartera-flow-wire-")));
  try {
    const bus = new AgentBus(new Storage(root));
    const flowInputs = selectedInputs("flow", [inputs[0], artifact("discovery", discoveryContent)]);
    const path = (bus as unknown as { providerSchema(c: TaskCapsule, provider: string): string }).providerSchema(childCapsule(request, "flow", flowInputs), "codex");
    return JSON.parse(readFileSync(path, "utf8"));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const enums = (node: any): unknown[][] => !node || typeof node !== "object" ? [] : [...(Array.isArray(node.enum) ? [node.enum] : []), ...Object.values(node).flatMap(enums)];

test("flow wire schema stays satisfiable when no evidence source is inherited", () => {
  const discovery = inputs[1].output.content as Record<string, any>;
  const wire = flowWire({ ...discovery, existing_behavior: [{ ...discovery.existing_behavior[0], evidence: [] }], evidence: [] });
  assert.ok(enums(wire).every(values => values.length > 0), "no enum: [] anywhere in the wire");
  assert.deepEqual(wire.properties.status.enum, ["blocked"]);
  const blocked = { task_id: `${request.task_id}-flow`, role: "flow", status: "blocked", summary: "No citable source was inherited", changed_files: [], evidence: [], tests_executed: [], tests_not_executed: [],
    api_contract_status: "not_applicable", visual_lock_status: "not_applicable", scope_expanded: false, deviations: [], risks: [], known_issues: ["Discovery supplied no citable evidence"], requested_followups: [], workflow_output: null };
  const validateWire = new Ajv({ strict: false }).compile(wire);
  assert.ok(validateWire(blocked), JSON.stringify(validateWire.errors));
});

test("flow wire enum never offers the discovery-only capsule literal", () => {
  const literal = "capsule.allowed_paths / capsule.required_context";
  const discovery = inputs[1].output.content as Record<string, any>;
  const wire = flowWire({ ...discovery, evidence: [...discovery.evidence, ...evidence(literal, "Scope read by Discovery")] });
  const offered = enums(wire).flat();
  assert.ok(offered.includes(`${readme}:1`));
  assert.ok(!offered.includes(literal));
});
