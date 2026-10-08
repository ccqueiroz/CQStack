import { StateError } from "./storage.js";

export const ROOT_STATES = [
  "TASK_RECEIVED",
  "TASK_CLASSIFIED",
  "TASK_SENSE_COMPLETE",
  "DISCOVERY_COMPLETE",
  "FLOW_COMPLETE",
  "TRUTH_VERIFIED",
  "GAP_DEFINED",
  "DECIDED",
  "PLAN_PROPOSED",
  "PLAN_APPROVED",
  "INTERFACE_CONTRACT_LOCKED",
  "CONTRACT_FROZEN",
  "LOTE_RUNNING",
  "PR_OPEN",
  "LOTE_MERGED",
  "NEEDS_HUMAN",
  "DONE",
] as const;
export type RootState = (typeof ROOT_STATES)[number];

export const TRACKS = ["S", "M", "L"] as const;
export type Track = (typeof TRACKS)[number];

export interface GraphEdge {
  from: RootState;
  to: RootState;
}

export interface Graph {
  track: Track;
  stages: string[];
  edges: GraphEdge[];
}

const edge = (from: RootState, to: RootState): GraphEdge => ({ from, to });

// The section 09 root diagram without the track edges and without the contract edge (F5.2).
const COMMON_EDGES: readonly GraphEdge[] = [
  edge("TASK_RECEIVED", "TASK_CLASSIFIED"),
  edge("TASK_CLASSIFIED", "TASK_SENSE_COMPLETE"),
  edge("TASK_SENSE_COMPLETE", "DISCOVERY_COMPLETE"),
  edge("FLOW_COMPLETE", "TRUTH_VERIFIED"),
  edge("TRUTH_VERIFIED", "GAP_DEFINED"),
  edge("GAP_DEFINED", "DECIDED"),
  edge("DECIDED", "PLAN_PROPOSED"),
  edge("PLAN_PROPOSED", "PLAN_APPROVED"),
  edge("PLAN_APPROVED", "CONTRACT_FROZEN"),
  edge("INTERFACE_CONTRACT_LOCKED", "CONTRACT_FROZEN"),
  edge("CONTRACT_FROZEN", "LOTE_RUNNING"),
  edge("LOTE_RUNNING", "PR_OPEN"),
  edge("PR_OPEN", "LOTE_MERGED"),
  edge("PR_OPEN", "NEEDS_HUMAN"),
  edge("LOTE_MERGED", "LOTE_RUNNING"),
  edge("LOTE_MERGED", "DONE"),
  edge("LOTE_RUNNING", "NEEDS_HUMAN"),
  edge("NEEDS_HUMAN", "LOTE_RUNNING"),
  edge("NEEDS_HUMAN", "DONE"),
];
const TRACK_TARGETS: Record<Track, RootState> = { L: "FLOW_COMPLETE", M: "GAP_DEFINED", S: "PLAN_PROPOSED" };

export function buildGraph(track: unknown = "L", stages: readonly string[] = []): Graph {
  if (!TRACKS.includes(track as Track)) throw new StateError("GRAPH_TRACK_INVALID", `Track must be S, M or L: ${String(track)}`);
  const declared = track as Track;
  return {
    track: declared,
    // a text is iterable: spread, it would become one stage per character; kept as given, the schema refuses it on create
    stages: Array.isArray(stages) ? [...stages] : (stages as string[]),
    edges: [...COMMON_EDGES.map(({ from, to }) => edge(from, to)), edge("DISCOVERY_COMPLETE", TRACK_TARGETS[declared])],
  };
}
