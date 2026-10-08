import { Ajv } from "ajv";
import { ROOT_STATES, TRACKS, type Graph, type RootState, type Track } from "./graph.js";
import { ID_PATTERN } from "./storage.js";

export type ActorKind = "harness" | "human" | "worker";
export interface Actor {
  kind: ActorKind;
  id: string;
  role?: string;
}

export interface HarnessVersion {
  tag: string | null;
  commit: string;
}

export interface Event {
  seq: number;
  ts: string;
  root_id: string;
  task_id: string;
  event_type: string;
  actor: Actor;
  reason?: string;
  cause_event_id?: string;
  graph?: Graph;
  graph_hash: string;
  harness_version: HarnessVersion;
  session_id?: string;
  item_id?: string;
  payload_ref?: string;
  payload_hash?: string;
}

export interface RootView {
  root_id: string;
  track: Track;
  state: RootState;
  revision: number;
  graph_hash: string;
}

const objectSchema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const TEXT_SCHEMA = { type: "string", minLength: 1 };
const ID_SCHEMA = { type: "string", pattern: ID_PATTERN.source };
const HASH_SCHEMA = { type: "string", pattern: "^[0-9a-f]{64}$" };
const STATE_SCHEMA = { enum: [...ROOT_STATES] };
const STATE_ALTERNATIVES = ROOT_STATES.join("|");

export const EVENT_SCHEMA = {
  type: "object",
  properties: {
    seq: { type: "integer", minimum: 1 },
    ts: TEXT_SCHEMA,
    root_id: ID_SCHEMA,
    task_id: ID_SCHEMA,
    event_type: {
      type: "string",
      pattern: `^(?:task\\.created|provider\\.observed|transition\\.(?:${STATE_ALTERNATIVES})\\.(?:${STATE_ALTERNATIVES}))$`,
    },
    actor: objectSchema({ kind: { enum: ["harness", "human", "worker"] }, id: TEXT_SCHEMA, role: TEXT_SCHEMA }, ["kind", "id"]),
    reason: TEXT_SCHEMA,
    cause_event_id: TEXT_SCHEMA,
    graph: objectSchema(
      {
        track: { enum: [...TRACKS] },
        stages: { type: "array", uniqueItems: true, items: ID_SCHEMA },
        edges: { type: "array", items: objectSchema({ from: STATE_SCHEMA, to: STATE_SCHEMA }, ["from", "to"]) },
      },
      ["track", "stages", "edges"],
    ),
    graph_hash: HASH_SCHEMA,
    harness_version: objectSchema(
      {
        tag: { type: ["string", "null"], minLength: 1 },
        commit: { type: "string", pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" },
      },
      ["tag", "commit"],
    ),
    session_id: TEXT_SCHEMA,
    item_id: ID_SCHEMA,
    payload_ref: TEXT_SCHEMA,
    payload_hash: HASH_SCHEMA,
  },
  required: ["seq", "ts", "root_id", "task_id", "event_type", "actor", "graph_hash", "harness_version"],
  additionalProperties: false,
  dependencies: {
    graph: { type: "object", properties: { event_type: { const: "task.created" } } },
    payload_ref: ["payload_hash"],
    payload_hash: ["payload_ref"],
  },
};

const validateEvent = new Ajv({ allErrors: true, strict: true }).compile(EVENT_SCHEMA);

export function eventViolations(value: unknown): string[] {
  if (validateEvent(value)) return [];
  return (validateEvent.errors ?? []).map((error) => {
    const field = error.params.additionalProperty;
    return `${error.instancePath || "/"} ${error.message}${field === undefined ? "" : ` (${field})`}`;
  });
}
