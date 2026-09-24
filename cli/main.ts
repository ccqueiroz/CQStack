import { readFileSync } from "node:fs";
import { createBus, invoke } from "../runtime/src/surface.js";
import { doctor } from "../runtime/src/doctor.js";
import { reviewWorkflow } from "../runtime/src/workflow/review.js";
import { createFixture } from "../runtime/src/workflow/engineering/fixture.js";
import { ExecutionGrants } from "../runtime/src/execution/grants.js";
import { hash } from "../runtime/src/storage.js";
const args = process.argv.slice(2);
const output = (value: unknown) =>
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
try {
  const command = args.shift();
  if (command === "doctor") {
    output(doctor());
  } else if (command === "fixture" && args.shift()==="init") {
    output(createFixture(createBus()));
  } else if (command === "maintenance") {
    const action = args.shift(), task = args.shift();
    const capsuleHash = args[0] === "--capsule-hash" ? args[1] : undefined;
    if (action !== "prepare" || !task || args.length !== 2 || !/^[a-f0-9]{64}$/.test(capsuleHash ?? ""))
      throw new Error("USAGE: maintenance prepare <existing-child-id> --capsule-hash <sha256>");
    const bus = createBus();
    let record = bus.events.get(task);
    const { capsule } = record;
    if (hash(capsule) !== capsuleHash) throw new Error("EXECUTION_GRANT_CAPSULE_HASH_MISMATCH");
    if (!capsule.parent_task_id || !["TASK_RECEIVED", "TASK_CLASSIFIED", "IMPLEMENTATION_RUNNING"].includes(record.state) ||
        bus.storage.exists("results", task + ".json") || bus.storage.exists("execution-grants", task + ".json") ||
        bus.events.list(task).some(e => ["agent.started", "agent.failed"].includes(e.event_type)))
      throw new Error("UNEXECUTED_HANDOFF_CHILD_REQUIRED");
    new ExecutionGrants(bus.storage, () => bus.runtime.model_execution_enabled).assertMaintenanceScope(
      capsule, bus.events.get(capsule.parent_task_id).capsule, bus.routeFor(capsule), "trusted-operator-cli");
    if (record.state === "TASK_RECEIVED") record = bus.transition(task, "TASK_CLASSIFIED", record.revision);
    if (record.state === "TASK_CLASSIFIED") record = bus.transition(task, "IMPLEMENTATION_RUNNING", record.revision);
    output(record);
  } else if (command === "execution-grant") {
    const task = args.shift(), reason = args.shift();
    const mode = args[0] === "--mode" ? args[1] : undefined;
    const capsuleHash = args[2] === "--capsule-hash" ? args[3] : undefined;
    const explicitMode = mode === "orchestrated-read-only-diagnosis" || mode === "maintenance-write";
    const governed = explicitMode && /^[a-f0-9]{64}$/.test(capsuleHash ?? "") && args.length === 4;
    if (!task || !reason || (args.length && !governed)) throw new Error("USAGE: execution-grant <existing-child-id> <operator-reason> [--mode orchestrated-read-only-diagnosis|maintenance-write --capsule-hash <sha256>]");
    const bus = createBus();
    const { capsule, state } = bus.events.get(task);
    if (governed && hash(capsule) !== capsuleHash) throw new Error("EXECUTION_GRANT_CAPSULE_HASH_MISMATCH");
    const maintenance = mode === "maintenance-write";
    if (bus.runtime.model_execution_enabled || !capsule.parent_task_id || (maintenance ? state !== "IMPLEMENTATION_RUNNING" : state !== "TASK_RECEIVED") ||
        bus.storage.exists("results", task + ".json") || bus.events.list(task).some(e => ["agent.started", "agent.failed"].includes(e.event_type)))
      throw new Error("UNEXECUTED_HANDOFF_CHILD_REQUIRED");
    const root = bus.events.get(capsule.parent_task_id).capsule;
    const grant = new ExecutionGrants(bus.storage, () => bus.runtime.model_execution_enabled).issue(capsule, root, bus.routeFor(capsule),
      maintenance ? "maintenance-write" : mode === "orchestrated-read-only-diagnosis" ? "orchestrated-read-only-diagnosis" : "read-only-harness", "trusted-operator-cli", reason);
    bus.events.append(task, "execution.grant.issued", { grant_hash: hash(grant), grant }, "trusted-operator-cli");
    output(grant);
  } else if (command === "smoke") {
    const provider = args.shift(), task = args.shift();
    if (!provider || !task) throw new Error("USAGE: smoke codex|claude <task-id> [--execute]");
    output(await createBus().smoke(provider, task, args.includes("--execute")));
  } else if (command === "roles") {
    output(await invoke(createBus(), "roles", {}));
  } else if (command === "workflow") {
    const action = args.shift(), target = args.shift();
    if (!target || !["start", "show", "resume", "artifacts", "propose", "proposal", "proposal-review", "apply", "apply-review"].includes(action ?? "")) throw new Error("USAGE: workflow start <request.json>|show|resume|artifacts|propose|proposal|proposal-review|apply|apply-review <id> [--execute]");
    const retry = args.indexOf("--retry-provider-task");
    if (retry >= 0 && !args[retry + 1]) throw new Error("RETRY_TASK_REQUIRED");
    const decision=args.indexOf("--decision"); if(decision>=0&&!args[decision+1]) throw new Error("EXPLICIT_USER_DECISION_REQUIRED");
    const input = action === "start" ? { request: JSON.parse(readFileSync(target, "utf8")), execute: args.includes("--execute") } : action === "resume" ? { task_id: target, execute: args.includes("--execute"), ...(retry >= 0 ? { retry_provider_task: args[retry + 1] } : {}) } : action==="propose" ? {task_id:target,execute:args.includes("--execute"),revise:args.includes("--revise"),...(decision>=0?{decision:args[decision+1]}:{})} : ["proposal-review","apply","apply-review"].includes(action!) ? {task_id:target,execute:args.includes("--execute")} : { task_id: target };
    output(await invoke(createBus(), `workflow_${action!.replaceAll("-","_")}`, input));
  } else if (command === "workflow-review") {
    const root = args.shift(), task = args.shift();
    if (!root || !task) throw new Error("USAGE: workflow-review <root> <review-task> [--execute]");
    output(await reviewWorkflow(createBus(), root, task, args.includes("--execute")));
  } else if (command === "workflow-retry") {
    const root = args.shift(), child = args.shift(), reason = args.shift();
    if (!root || !child || !reason) throw new Error("USAGE: workflow-retry <root> <failed-child> <reason>");
    output(await invoke(createBus(), "workflow_retry", { task_id: root, child_task: child, reason }));
  } else if (command === "call") {
    const name = args.shift();
    const file = args.shift();
    if (!name || !file) throw new Error("USAGE: call <tool> <jsonfile>");
    output(
      await invoke(createBus(), name, JSON.parse(readFileSync(file, "utf8")))
    );
  } else if (command === "task") {
    const action = args.shift();
    const bus = createBus();
    const id = args.shift();
    const profile = args.indexOf("--routing-profile");
    if (profile >= 0 && !args[profile + 1]) throw new Error("ROUTING_PROFILE_REQUIRED");
    const escalations = args.flatMap((arg, index) => arg === "--routing-escalation" ? [args[index + 1] ?? ""] : []).map(value => {
      const [role, reason, ...rest] = value.split("=");
      if (!role || !reason || rest.length) throw new Error("ROUTING_ESCALATION_REQUIRED: <role>=<reason>");
      return [role, reason];
    });
    if (action === "init" && id)
      output(
        await invoke(bus, "task_init", {
          capsule: JSON.parse(readFileSync(id, "utf8")),
          ...(profile >= 0 ? { routing_profile: args[profile + 1] } : {}),
          ...(escalations.length ? { routing_escalations: Object.fromEntries(escalations) } : {}),
        })
      );
    else if (action === "show" && id)
      output(await invoke(bus, "task_get", { task_id: id }));
    else if (action === "events" && id)
      output(await invoke(bus, "task_events", { task_id: id }));
    else throw new Error("USAGE: task init <file> [--routing-profile <name>] [--routing-escalation <role>=<reason>]...|show <id>|events <id>");
  } else if (command === "delegate") {
    const id = args.shift();
    if (!id) throw new Error("USAGE: delegate <id> [--execute]");
    output(
      await invoke(createBus(), "agent_delegate", {
        task_id: id,
        dry_run: !args.includes("--execute"),
      })
    );
  } else if (command === "worktree" && args.shift() === "list") {
    output(await invoke(createBus(), "worktree_list", {}));
  } else if (command === "contract" && args.shift() === "show") {
    const id = args.shift(),
      version = args.shift();
    if (!id || !version) throw new Error("USAGE: contract show <id> <version>");
    output(await invoke(createBus(), "contract_get", { id, version }));
  } else throw new Error("UNKNOWN_COMMAND");
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? error.message : "UNKNOWN_ERROR") + "\n"
  );
  process.exitCode = 1;
}
