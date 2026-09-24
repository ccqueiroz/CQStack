// Human-readable evidence projection; canonical state remains in the runtime.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { createBus } from "../dist/runtime/src/surface.js";
import { WorkflowService } from "../dist/runtime/src/workflow/service.js";
import { hash } from "../dist/runtime/src/storage.js";

const bus = createBus(), service = new WorkflowService(bus);
const root = "PHASE2-PAGINATION";
const target = resolve("artifacts/phase-2-live-workflow-demo");
mkdirSync(target, { recursive: true });
const save = (file, data) => {
  const path = join(target, file);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
};
const events = bus.events.list(root);
const ids = [root, ...events.filter(e => e.event_type === "workflow.child.created").map(e => e.payload.child_task)];
const smokeIds = readdirSync(bus.storage.path("events")).filter(f => f.startsWith("PHASE2A-")).map(f => f.replace(/\.jsonl$/, ""));
for (const task of [...new Set([...ids, ...smokeIds])]) {
  save(`capsules/${task}.json`, bus.events.get(task).capsule);
  save(`tasks/${task}.json`, bus.events.get(task));
  mkdirSync(join(target, "events"), { recursive: true });
  cpSync(bus.storage.path("events", task + ".jsonl"), join(target, "events", task + ".jsonl"));
  if (bus.storage.exists("results", task + ".json")) save(`results/${task}.json`, bus.result(task));
  for (const e of bus.events.list(task).filter(e => e.event_type === "provider.observed")) {
    save(`provider-observations/${e.payload.artifact}`, bus.storage.read("provider-observations", e.payload.artifact));
  }
}
const artifacts = service.artifacts(root), status = service.show(root);
for (const artifact of artifacts) save(`artifacts/${artifact.child_task}.json`, artifact);
save("manifest.json", bus.storage.read("workflows", root, "manifest.json"));
save("final-state.json", status);
save("role-resolutions.json", ids.flatMap(task => bus.events.list(task).filter(e => e.event_type === "agent.delegated").map(e => e.payload)));
save("attempt-history.json", events.filter(e => ["workflow.stage.failed", "workflow.child.replaced", "workflow.architecture.reviewed"].includes(e.event_type)));
save("artifact-index.json", artifacts.map(a => ({ child_task: a.child_task, content_hash: a.content_hash, source_agent_result: a.source_agent_result, input_artifact_references: a.input_artifact_references })));
save("workspace-preservation.json", JSON.parse(readFileSync("artifacts/phase-2-workspace-preservation.json", "utf8")));
const executions = readdirSync(bus.storage.path("provider-observations")).filter(f => f.startsWith("PHASE2") && f.endsWith(".json")).sort().map(file => {
  const o = bus.storage.read("provider-observations", file);
  return { task_id: o.task_id, provider: o.provider, model_alias: o.model_alias, model: o.model,
    exit_code: o.exit_code, elapsed_ms: o.elapsed_ms, timeout_ms: o.timeout_ms, prompt_bytes: o.prompt_bytes,
    usage: o.usage ?? null, provider_reported_models: Object.keys(o.envelope?.modelUsage ?? {}), observation_file: file };
});
if (executions.some(e => /fable/i.test([e.model, e.model_alias, ...e.provider_reported_models].join(" ")))) throw new Error("FABLE_OBSERVED");
writeFileSync("artifacts/phase-2-provider-executions.json", JSON.stringify(executions, null, 2) + "\n");
writeFileSync(join(target, "README.md"), `# Phase 2 live workflow evidence\n\nRoot: ${root}. Final state: ${status.state}.\n\nThis is an export of canonical task events, immutable capsules/results, route resolutions, provider observations and validated workflow artifacts. It includes failed attempts and explicit replacements. No application files are copied or changed. The MCP inspection is recorded separately in mcp-inspection.json.\n\nThe six accepted stage artifacts are listed in artifact-index.json. Truth uses its own child invocation and independently reads the three scoped files. Gap reports no missing requested behavior; test execution remains unverified because the task prohibits running application tests.\n\nRegenerate from the harness directory with node scripts/export-phase-2.mjs after building. The runtime state directory remains canonical.\n`);
console.log(JSON.stringify({ root, state: status.state, artifacts: artifacts.length, task_count: ids.length, export_hash: hash(status), target }));
