import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { StateError, canonical, canonicalHash } from "../src/storage.js";
import { ROOT_STATES, buildGraph, type Graph } from "../src/graph.js";

test("[GRAPH-07] [GRAPH-08] the canonical form sorts object keys at every level and keeps array order", () => {
  assert.equal(
    canonical({ c: 3, b: [{ z: null, y: "x" }, 2], a: { q: true, p: "\u00e9" } }),
    '{"a":{"p":"\u00e9","q":true},"b":[{"y":"x","z":null},2],"c":3}',
  );
  assert.equal(canonical([]), "[]");
  assert.equal(canonical({}), "{}");
  assert.equal(canonical(null), "null");
  assert.equal(canonical("s"), '"s"');
});

test("[GRAPH-07] [GRAPH-08] the canonical hash is the sha256 of the canonical form, whatever the key order", () => {
  const expected = createHash("sha256").update('{"a":2,"b":1}').digest("hex");
  assert.equal(canonicalHash({ b: 1, a: 2 }), expected);
  assert.equal(canonicalHash({ a: 2, b: 1 }), expected);
});

const ROOT_STATES_ORACLE = [
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
];
const COMMON_EDGES_ORACLE = [
  "TASK_RECEIVED>TASK_CLASSIFIED",
  "TASK_CLASSIFIED>TASK_SENSE_COMPLETE",
  "TASK_SENSE_COMPLETE>DISCOVERY_COMPLETE",
  "FLOW_COMPLETE>TRUTH_VERIFIED",
  "TRUTH_VERIFIED>GAP_DEFINED",
  "GAP_DEFINED>DECIDED",
  "DECIDED>PLAN_PROPOSED",
  "PLAN_PROPOSED>PLAN_APPROVED",
  "PLAN_APPROVED>CONTRACT_FROZEN",
  "INTERFACE_CONTRACT_LOCKED>CONTRACT_FROZEN",
  "CONTRACT_FROZEN>LOTE_RUNNING",
  "LOTE_RUNNING>PR_OPEN",
  "PR_OPEN>LOTE_MERGED",
  "PR_OPEN>NEEDS_HUMAN",
  "LOTE_MERGED>LOTE_RUNNING",
  "LOTE_MERGED>DONE",
  "LOTE_RUNNING>NEEDS_HUMAN",
  "NEEDS_HUMAN>LOTE_RUNNING",
  "NEEDS_HUMAN>DONE",
];
const TRACK_EDGE_ORACLE = {
  L: "DISCOVERY_COMPLETE>FLOW_COMPLETE",
  M: "DISCOVERY_COMPLETE>GAP_DEFINED",
  S: "DISCOVERY_COMPLETE>PLAN_PROPOSED",
} as const;

const edgeTexts = (graph: Graph) => graph.edges.map((edge) => `${edge.from}>${edge.to}`);
const targetsOfDiscovery = (graph: Graph) =>
  graph.edges.filter((edge) => edge.from === "DISCOVERY_COMPLETE").map((edge) => edge.to);

test("[GRAPH-01] track L leaves DISCOVERY_COMPLETE only to FLOW_COMPLETE", () => {
  const graph = buildGraph("L");
  assert.deepEqual(targetsOfDiscovery(graph), ["FLOW_COMPLETE"]);
  assert.equal(graph.track, "L");
});

test("[GRAPH-02] track M leaves DISCOVERY_COMPLETE only to GAP_DEFINED", () => {
  const graph = buildGraph("M");
  assert.deepEqual(targetsOfDiscovery(graph), ["GAP_DEFINED"]);
  assert.equal(graph.track, "M");
});

test("[GRAPH-03] track S leaves DISCOVERY_COMPLETE only to PLAN_PROPOSED", () => {
  const graph = buildGraph("S");
  assert.deepEqual(targetsOfDiscovery(graph), ["PLAN_PROPOSED"]);
  assert.equal(graph.track, "S");
});

test("[GRAPH-04] every track has the 19 unlabeled edges of section 09, one track edge and only the 17 root states", () => {
  assert.deepEqual([...ROOT_STATES], ROOT_STATES_ORACLE);
  for (const track of ["S", "M", "L"] as const) {
    const graph = buildGraph(track);
    assert.deepEqual(edgeTexts(graph).sort(), [...COMMON_EDGES_ORACLE, TRACK_EDGE_ORACLE[track]].sort());
    for (const edge of graph.edges) {
      assert.ok(ROOT_STATES_ORACLE.includes(edge.from), edge.from);
      assert.ok(ROOT_STATES_ORACLE.includes(edge.to), edge.to);
    }
  }
});

test("[GRAPH-05] a track other than S, M or L is refused", () => {
  for (const track of ["X", "s", "", "LL", " L", null, 1]) {
    assert.throws(
      () => buildGraph(track),
      (error: unknown) => error instanceof StateError && error.code === "GRAPH_TRACK_INVALID",
      String(track),
    );
  }
});

test("[GRAPH-06] a missing track builds the L graph", () => {
  const graph = buildGraph();
  assert.equal(graph.track, "L");
  assert.ok(edgeTexts(graph).includes("DISCOVERY_COMPLETE>FLOW_COMPLETE"));
  assert.deepEqual(graph, buildGraph("L"));
  assert.equal(buildGraph(undefined, ["prototype"]).track, "L");
});

test("[GRAPH-07] the same stages and track give the same canonical hash, and a graph keeps its stages and edges whatever is changed elsewhere", () => {
  const stages = ["prototype", "copy"];
  const graph = buildGraph("M", stages);
  assert.equal(canonicalHash(graph), canonicalHash(buildGraph("M", ["prototype", "copy"])));
  assert.deepEqual(graph.stages, ["prototype", "copy"]);
  stages.push("late");
  assert.deepEqual(graph.stages, ["prototype", "copy"]);
  const earlier = buildGraph("M");
  const pristineHash = canonicalHash(buildGraph("L"));
  const changed = buildGraph("L");
  changed.edges[0].to = "DONE";
  changed.edges[18].from = "DONE";
  assert.equal(earlier.edges[0].to, "TASK_CLASSIFIED");
  assert.equal(earlier.edges[18].from, "NEEDS_HUMAN");
  assert.equal(canonicalHash(buildGraph("L")), pristineHash);
});
