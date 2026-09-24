import type {
  AgentExecutionRequest,
  AgentProvider,
  MaintenancePatchResult,
  ProcessRunner,
} from "../contracts.js";
import { runProcess } from "../processes/run.js";
import { parseAgentResult } from "../validation/index.js";
import { observeProcess } from "./observation.js";
import { Ajv } from "ajv";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const maintenancePatchSchema = {
  type: "object",
  required: ["kind", "edits", "agent_result"],
  additionalProperties: false,
  properties: {
    kind: { type: "string", const: "maintenance-patch" },
    edits: {
      type: "array",
      items: {
        type: "object",
        required: ["relative_path", "expected_before_hash", "content"],
        additionalProperties: false,
        properties: {
          relative_path: { type: "string" },
          expected_before_hash: { type: ["string", "null"] },
          content: { type: "string" },
        },
      },
    },
    agent_result: { type: "object" },
  },
};
const validateMaintenancePatch = new Ajv({ allErrors: true }).compile<MaintenancePatchResult>(maintenancePatchSchema);

export class CodexProvider implements AgentProvider {
  constructor(private readonly runner: ProcessRunner = runProcess) {}

  async execute(request: AgentExecutionRequest) {
    assertModel(request.route.model);
    const maintenance = request.capsule.constraints.includes("CORE_INTERNAL_MAINTENANCE_V1");
    const sandbox = maintenance || request.capsule.permissions === "read-only" ? "read-only" : "workspace-write";
    const schemaDirectory = maintenance ? await mkdtemp(join(tmpdir(), "cartera-codex-output-")) : null;
    try {
      let schemaPath = request.result_schema_path;
      if (schemaDirectory) {
        const agentResultSchema = JSON.parse(await readFile(request.result_schema_path, "utf8"));
        const outputSchema = {
          ...maintenancePatchSchema,
          properties: {
            ...maintenancePatchSchema.properties,
            edits: { ...maintenancePatchSchema.properties.edits, minItems: 1 },
            agent_result: agentResultSchema,
          },
        };
        schemaPath = join(schemaDirectory, "maintenance-patch.schema.json");
        await writeFile(schemaPath, JSON.stringify(outputSchema), { flag: "wx", mode: 0o600 });
      }
      const started = Date.now();
      const args = [
          "exec",
          "--model",
          request.route.model,
          ...(request.route.effort ? ["-c", `model_reasoning_effort="${request.route.effort}"`] : []),
          "--cd",
          request.cwd,
          "--sandbox",
          sandbox,
          "-c",
          'approval_policy="never"',
          "--ignore-user-config",
          "--ephemeral",
          "--skip-git-repo-check",
          "--json",
          "-",
        ];
      args.splice(args.indexOf("--json"), 0, "--output-schema", schemaPath);
      if (!maintenance) args.splice(args.indexOf("--json"), 0, "--output-last-message", "/dev/null");
      const processRequest = { command: request.route.provider_command ?? "codex", cwd: request.cwd, stdin: request.prompt, timeout_ms: request.timeout_ms, signal: request.signal, args };
      const result = await this.runner(processRequest);
      request.observe?.(observeProcess(processRequest, result, Date.now() - started));
      if (result.exit_code !== 0)
        throw providerFailure("codex", result.exit_code, result.signal);
      const text = result.stdout;
      if (maintenance) {
        const patch: unknown = JSON.parse(extractJson(text));
        if (!validateMaintenancePatch(patch)) throw new Error("INVALID_MAINTENANCE_PATCH");
        patch.agent_result = parseAgentResult(JSON.stringify(patch.agent_result));
        return patch;
      }
      return parseAgentResult(extractJson(text));
    } finally {
      if (schemaDirectory) await rm(schemaDirectory, { recursive: true, force: true });
    }
  }
}


function assertModel(model: string): void {
  if (/fable/i.test(model)) throw new Error("FABLE_MODEL_FORBIDDEN");
}
function unsupportedPermission(permission: string): Error {
  const error = new Error(`UNSUPPORTED_PERMISSION: ${permission}`);
  error.name = "UNSUPPORTED_PERMISSION";
  return error;
}
function providerFailure(
  provider: string,
  code: number | null,
  signal: string | null
): Error {
  return new Error(
    `${provider} exited unsuccessfully (${code ?? signal ?? "unknown"})`
  );
}
function extractJson(text: string): string {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    // --json emits JSONL; each complete line is an event, never a substring.
    const events: unknown[] = text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    return extractFinalMessage(events);
  }
  if (isRecord(document) && typeof document.type === "string") return extractFinalMessage([document]);
  return isRecord(document) && typeof document.last_message === "string" ? document.last_message : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractFinalMessage(events: unknown[]): string {
  let activeTurn = false;
  let message: string | undefined;
  let finalMessage: string | undefined;
  for (const event of events) {
    if (!isRecord(event) || typeof event.type !== "string") throw new Error("INVALID_CODEX_EVENT");
    if (event.type === "turn.failed" || event.type === "error") throw new Error("CODEX_STREAM_FAILED");
    if (event.type === "turn.started") {
      if (activeTurn) throw new Error("INVALID_CODEX_EVENT_ORDER");
      activeTurn = true;
      message = undefined;
      finalMessage = undefined;
    } else if (event.type === "item.completed" && isRecord(event.item) && event.item.type === "agent_message") {
      if (!activeTurn || typeof event.item.text !== "string") throw new Error("INVALID_CODEX_AGENT_MESSAGE");
      message = event.item.text;
    } else if (event.type === "turn.completed") {
      if (!activeTurn || message === undefined) throw new Error("CODEX_FINAL_MESSAGE_MISSING");
      activeTurn = false;
      finalMessage = message;
    }
  }
  if (activeTurn || finalMessage === undefined) throw new Error("CODEX_FINAL_MESSAGE_MISSING");
  return finalMessage;
}
