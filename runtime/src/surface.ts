import { join, resolve } from "node:path";
import { AgentBus } from "./agent-bus/index.js";
import { HARNESS_ROOT, Storage } from "./storage.js";
import type {
  AgentResult,
  ApiContract,
  ArtifactReference,
  ContractChange,
  ReviewResult,
  TaskState,
} from "./contracts.js";
import { Ajv } from "ajv";
import { WorkflowService, REQUEST_SCHEMA } from "./workflow/service.js";

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
const objectSchema = (
  properties: Record<string, unknown> = {},
  required: string[] = []
): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const toolDefinitions: Array<[string, string, string[]]> = [
  ["workflow_propose", "Design an immutable proposal from verified Gap and an explicit decision; execution opt-in", ["task_id"]],
  ["workflow_proposal", "Inspect proposal, gates, implementation units and blockers", ["task_id"]],
  ["workflow_proposal_review", "Independently review the latest proposal through the bus", ["task_id"]],
  ["workflow_apply", "Explicitly execute approved units only in the harness-owned fixture worktrees; application writes disabled", ["task_id"]],
  ["workflow_apply_review", "Independently review diff and test evidence; approved review gates DONE", ["task_id"]],
  ["workflow_engineering_retry", "Explicitly replace a failed read-only engineering child; never reuse failed write worktrees", ["task_id","child_task","reason"]],
  ["workflow_start", "Create a read-only core understanding workflow; execution is opt-in and requires the live provider gate", ["request"]],
  ["workflow_show", "Inspect root state and individual workflow children", ["task_id"]],
  ["workflow_resume", "Inspect or explicitly resume missing workflow stages", ["task_id"]],
  ["workflow_artifacts", "Read and verify immutable workflow artifacts and provenance", ["task_id"]],
  ["workflow_retry", "Explicitly replace one failed child with a fresh capsule; at most two replacements, no execution", ["task_id", "child_task", "reason"]],
  ["task_get", "Get a task record", ["task_id"]],
  ["task_init", "Create a task capsule", ["capsule"]],
  ["task_state", "Transition a task", ["task_id", "to", "revision"]],
  ["task_events", "List task events", ["task_id"]],
  ["roles", "List registered roles", []],
  ["agent_delegate", "Plan or execute a task", ["task_id"]],
  ["agent_result", "Get an agent result", ["task_id"]],
  ["worktree_list", "List or create worktrees", []],
  ["contract_get", "Get a contract", ["id", "version"]],
  ["contract_create", "Create a contract", ["contract"]],
  [
    "contract_lock",
    "Lock a contract",
    ["reference", "backend_review", "frontend_review"],
  ],
  ["contract_change_request", "Request a contract change", ["change"]],
  ["visual_lock_get", "Get a visual lock", ["id", "version"]],
];
const stringProperty = { type: "string", minLength: 1 };
const schemas: Record<string, Record<string, unknown>> = {
  workflow_propose: objectSchema({task_id:stringProperty,execute:{type:"boolean"},decision:stringProperty,revise:{type:"boolean"}},["task_id"]),
  workflow_proposal: objectSchema({task_id:stringProperty},["task_id"]),
  workflow_proposal_review: objectSchema({task_id:stringProperty,execute:{type:"boolean"}},["task_id"]),
  workflow_apply: objectSchema({task_id:stringProperty,execute:{type:"boolean"}},["task_id"]),
  workflow_apply_review: objectSchema({task_id:stringProperty,execute:{type:"boolean"}},["task_id"]),
  workflow_engineering_retry: objectSchema({task_id:stringProperty,child_task:stringProperty,reason:stringProperty},["task_id","child_task","reason"]),
  workflow_start: objectSchema({ request: REQUEST_SCHEMA, execute: { type: "boolean" } }, ["request"]),
  workflow_show: objectSchema({ task_id: stringProperty }, ["task_id"]),
  workflow_resume: objectSchema({ task_id: stringProperty, execute: { type: "boolean" }, retry_provider_task: stringProperty }, ["task_id"]),
  workflow_artifacts: objectSchema({ task_id: stringProperty }, ["task_id"]),
  workflow_retry: objectSchema({ task_id: stringProperty, child_task: stringProperty, reason: stringProperty }, ["task_id", "child_task", "reason"]),
  task_get: objectSchema({ task_id: stringProperty }, ["task_id"]),
  task_init: objectSchema({ capsule: { type: "object" }, routing_profile: stringProperty, routing_escalations: { type: "object", additionalProperties: stringProperty } }, ["capsule"]),
  task_state: objectSchema(
    {
      task_id: stringProperty,
      to: stringProperty,
      revision: { type: "integer", minimum: 0 },
      review: { type: "object" },
    },
    ["task_id", "to", "revision"]
  ),
  task_events: objectSchema({ task_id: stringProperty }, ["task_id"]),
  roles: objectSchema(),
  agent_delegate: objectSchema(
    { task_id: stringProperty, dry_run: { type: "boolean" } },
    ["task_id"]
  ),
  agent_result: objectSchema({ task_id: stringProperty }, ["task_id"]),
  worktree_list: objectSchema(),
  worktree_create: objectSchema(
    {
      task_id: stringProperty,
      role: stringProperty,
      repository: stringProperty,
      base_ref: stringProperty,
      contract_version: stringProperty,
      requires_uncommitted_changes: { type: "boolean" },
    },
    ["task_id", "role", "repository", "base_ref"]
  ),
  contract_get: objectSchema({ id: stringProperty, version: stringProperty }, [
    "id",
    "version",
  ]),
  contract_create: objectSchema({ contract: { type: "object" } }, ["contract"]),
  contract_lock: objectSchema(
    {
      reference: { type: "object" },
      backend_review: { type: "object" },
      frontend_review: { type: "object" },
    },
    ["reference", "backend_review", "frontend_review"]
  ),
  contract_change_request: objectSchema({ change: { type: "object" } }, [
    "change",
  ]),
  visual_lock_get: objectSchema(
    {
      id: stringProperty,
      version: stringProperty,
      content_hash: stringProperty,
    },
    ["id", "version", "content_hash"]
  ),
};
const allDefinitions: Array<[string, string, string[]]> =
  toolDefinitions.concat([
    [
      "worktree_create",
      "Create and register a worktree",
      ["task_id", "role", "repository", "base_ref"],
    ],
  ]);
export const TOOL_DESCRIPTORS: ToolDescriptor[] = allDefinitions.map(
  ([name, description, required]) => ({
    name,
    description,
    inputSchema: schemas[name] ?? objectSchema({}, required),
  })
);
const ajv = new Ajv({ allErrors: true });
const validators = new Map(
  Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)])
);

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`INVALID_ARGUMENTS: ${name}`);
  return value as Record<string, unknown>;
}
function stringArg(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== "string" || !args[key])
    throw new Error(`INVALID_ARGUMENT: ${key}`);
  return args[key] as string;
}
export function createBus(): AgentBus {
  const root = process.env.CARTERA_HARNESS_STATE
    ? resolve(process.env.CARTERA_HARNESS_STATE)
    : join(HARNESS_ROOT, "state");
  return new AgentBus(new Storage(root));
}
export async function invoke(
  bus: AgentBus,
  name: string,
  raw: unknown
): Promise<unknown> {
  const args = record(raw, name);
  const validator = validators.get(name);
  if (!validator) throw new Error(`UNKNOWN_TOOL: ${name}`);
  if (!validator(args)) throw new Error(`INVALID_ARGUMENTS: ${name}`);
  switch (name) {
    case "workflow_propose": return new WorkflowService(bus).propose(stringArg(args,"task_id"),args.execute===true,args.decision as string|undefined,args.revise===true);
    case "workflow_proposal": return new WorkflowService(bus).proposal(stringArg(args,"task_id"));
    case "workflow_proposal_review": return new WorkflowService(bus).proposalReview(stringArg(args,"task_id"),args.execute===true);
    case "workflow_apply": return new WorkflowService(bus).apply(stringArg(args,"task_id"),args.execute===true);
    case "workflow_apply_review": return new WorkflowService(bus).applyReview(stringArg(args,"task_id"),args.execute===true);
    case "workflow_engineering_retry": return new WorkflowService(bus).engineeringRetry(stringArg(args,"task_id"),stringArg(args,"child_task"),stringArg(args,"reason"));
    case "workflow_start": return await new WorkflowService(bus).start(args.request, args.execute === true);
    case "workflow_show": return new WorkflowService(bus).show(stringArg(args, "task_id"));
    case "workflow_resume": return await new WorkflowService(bus).resume(stringArg(args, "task_id"), args.execute === true, args.retry_provider_task as string | undefined);
    case "workflow_artifacts": return new WorkflowService(bus).allArtifacts(stringArg(args, "task_id"));
    case "workflow_retry": return new WorkflowService(bus).replaceFailedChild(stringArg(args, "task_id"), stringArg(args, "child_task"), stringArg(args, "reason"));
    case "task_get":
      return bus.events.get(stringArg(args, "task_id"));
    case "task_init":
      return bus.init(args.capsule, args.routing_profile as string | undefined, args.routing_escalations as Record<string, string> | undefined);
    case "task_state":
      return bus.transition(
        stringArg(args, "task_id"),
        stringArg(args, "to") as TaskState,
        Number(args.revision),
        args.review as ReviewResult | undefined
      );
    case "task_events":
      return bus.events.list(stringArg(args, "task_id"));
    case "roles":
      return bus.router.roles;
    case "agent_delegate":
      return await bus.delegate(
        stringArg(args, "task_id"),
        args.dry_run !== false
      );
    case "agent_result":
      return bus.result(stringArg(args, "task_id"));
    case "worktree_list":
      return bus.worktrees.list();
    case "worktree_create":
      return (
        bus as AgentBus & { createWorktree(input: unknown): unknown }
      ).createWorktree(args);
    case "contract_get":
      return bus.locks.get({
        id: stringArg(args, "id"),
        version: stringArg(args, "version"),
      });
    case "contract_create":
      return bus.createContract(
        record(args.contract, "contract") as unknown as ApiContract
      );
    case "contract_lock":
      return bus.lockContract(
        record(args.reference, "reference") as unknown as ArtifactReference,
        record(
          args.backend_review,
          "backend_review"
        ) as unknown as ReviewResult,
        record(
          args.frontend_review,
          "frontend_review"
        ) as unknown as ReviewResult
      );
    case "contract_change_request":
      return bus.requestContractChange(
        record(args.change, "change") as unknown as ContractChange
      );
    case "visual_lock_get":
      return bus.locks.visual({
        id: stringArg(args, "id"),
        version: stringArg(args, "version"),
        content_hash: stringArg(args, "content_hash"),
      });
    default:
      throw new Error(`UNKNOWN_TOOL: ${name}`);
  }
}
