import { Ajv } from "ajv";
import type { Bus } from "./bus.js";
import { EVENT_SCHEMA, type Actor } from "./events.js";
import { ROOT_STATES, TRACKS, buildGraph, type RootState, type Track } from "./graph.js";
import { StateError } from "./storage.js";

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const objectSchema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const ROOT_ID = EVENT_SCHEMA.properties.root_id;
// absent or null reaches the log, which refuses it with ACTOR_REQUIRED: there is no default author
const ACTOR = { ...EVENT_SCHEMA.properties.actor, type: ["object", "null"] };

export const TOOL_DESCRIPTORS: readonly ToolDescriptor[] = [
  {
    name: "task_init",
    description: "Open a root task with the graph of its track (S, M or L; L when absent). The actor is the human of the profile.",
    inputSchema: objectSchema({ root_id: ROOT_ID, track: { enum: [...TRACKS] }, actor: ACTOR }, ["root_id"]),
  },
  {
    name: "task_state",
    description: "Move a root task along an edge of its recorded graph, with the revision and graph_hash of its current view.",
    inputSchema: objectSchema(
      {
        root_id: ROOT_ID,
        to: { enum: [...ROOT_STATES] },
        expected_revision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        graph_hash: EVENT_SCHEMA.properties.graph_hash,
        actor: ACTOR,
      },
      ["root_id", "to", "expected_revision", "graph_hash"],
    ),
  },
  {
    name: "task_events",
    description: "Read the events of a root task in file order, with its current view.",
    inputSchema: objectSchema({ root_id: ROOT_ID }, ["root_id"]),
  },
];

const ajv = new Ajv({ allErrors: true, strict: true });
const validators = new Map(TOOL_DESCRIPTORS.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]));

interface ToolArguments {
  root_id: string;
  track?: Track;
  to: RootState;
  expected_revision: number;
  graph_hash: string;
  actor?: Actor | null;
}

// The tools hold no state: every call goes to the event log, which re-reads the root file, so each answer is a fresh copy.
export function invoke(bus: Bus, name: unknown, args: unknown): unknown {
  const validate = typeof name === "string" ? validators.get(name) : undefined;
  if (validate === undefined)
    throw new StateError("TOOL_UNKNOWN", `Unknown tool: ${String(name)}; the tools are task_init, task_state and task_events`);
  if (!validate(args)) throw new StateError("TOOL_ARGUMENTS_INVALID", `Arguments of ${name} do not match its schema: ${ajv.errorsText(validate.errors)}`);
  const { root_id, track, to, expected_revision, graph_hash, actor } = args as ToolArguments;
  // the stages of the profile enter the graph in F4.2; until then the graph is the skeleton and the track
  if (name === "task_init") return { event: bus.log.create(root_id, { graph: buildGraph(track, []), actor }), view: bus.log.state(root_id) };
  if (name === "task_state")
    return { event: bus.log.transition(root_id, { to, expected_revision, graph_hash, actor }), view: bus.log.state(root_id) };
  return { events: bus.log.events(root_id), view: bus.log.state(root_id) };
}
