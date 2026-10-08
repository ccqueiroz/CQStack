import test from "node:test";
import assert from "node:assert/strict";
import { canonicalHash } from "../src/storage.js";
import { buildGraph } from "../src/graph.js";
import { EVENT_SCHEMA, eventViolations, type HarnessVersion } from "../src/events.js";

const V1: HarnessVersion = { tag: "v9.9.9", commit: "1".repeat(40) };

const GRAPH_L = buildGraph("L");

function createdEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 1,
    ts: "2026-10-07T00:00:00.000Z",
    root_id: "r1",
    task_id: "r1",
    event_type: "task.created",
    actor: { kind: "human", id: "ada@example.com" },
    graph: GRAPH_L,
    graph_hash: canonicalHash(GRAPH_L),
    harness_version: V1,
    ...overrides,
  };
}

function transitionEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 2,
    ts: "2026-10-07T00:00:01.000Z",
    root_id: "r1",
    task_id: "r1",
    event_type: "transition.TASK_RECEIVED.TASK_CLASSIFIED",
    actor: { kind: "harness", id: "v9.9.9" },
    graph_hash: canonicalHash(GRAPH_L),
    harness_version: V1,
    ...overrides,
  };
}

function without(event: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...event };
  delete copy[key];
  return copy;
}

function assertValid(event: unknown): void {
  assert.deepEqual(eventViolations(event), [], JSON.stringify(event));
}

function assertInvalid(event: unknown): void {
  assert.notDeepEqual(eventViolations(event), [], JSON.stringify(event));
}

test("[ACTOR-01] an event without actor fails the schema", () => {
  assertValid(createdEvent());
  assertValid(transitionEvent());
  assertInvalid(without(createdEvent(), "actor"));
  assertInvalid(without(transitionEvent(), "actor"));
});

test("[ACTOR-02] an actor kind missing or outside harness, human and worker fails the schema", () => {
  assertInvalid(createdEvent({ actor: { id: "ada@example.com" } }));
  for (const kind of ["admin", "Human", "", null]) assertInvalid(createdEvent({ actor: { kind, id: "ada@example.com" } }));
  for (const kind of ["harness", "human", "worker"]) assertValid(createdEvent({ actor: { kind, id: "ada@example.com" } }));
});

test("[ACTOR-03] an actor id missing or empty fails the schema", () => {
  assertInvalid(createdEvent({ actor: { kind: "human" } }));
  for (const id of ["", 7]) assertInvalid(createdEvent({ actor: { kind: "human", id } }));
  assertValid(createdEvent({ actor: { kind: "human", id: "x" } }));
});

test("[ACTOR-04] an actor with a field outside kind, id and role, or an empty role, fails the schema", () => {
  assertInvalid(createdEvent({ actor: { kind: "human", id: "ada@example.com", email: "ada@example.com" } }));
  assertInvalid(createdEvent({ actor: { kind: "human", id: "ada@example.com", role: "" } }));
  assertValid(createdEvent({ actor: { kind: "human", id: "ada@example.com", role: "implementer" } }));
});

test("[VER-02] harness_version without the tag key or without commit fails the schema; tag null with a commit passes", () => {
  assertInvalid(without(createdEvent(), "harness_version"));
  const invalidVersions: unknown[] = [
    { commit: "1".repeat(40) },
    { tag: "v1" },
    { tag: "", commit: "1".repeat(40) },
    { tag: 1, commit: "1".repeat(40) },
    ...[39, 41, 63, 65].map((length) => ({ tag: "v1", commit: "1".repeat(length) })),
    { tag: "v1", commit: "A".repeat(40) },
    { tag: "v1", commit: "g".repeat(40) },
    { tag: "v1", commit: "1".repeat(40), extra: true },
  ];
  for (const harness_version of invalidVersions) assertInvalid(createdEvent({ harness_version }));
  assertValid(createdEvent({ harness_version: { tag: null, commit: "1".repeat(40) } }));
  assertValid(createdEvent({ harness_version: { tag: "v1", commit: "a".repeat(64) } }));
  for (const digit of ["0", "9", "a", "f"]) assertValid(createdEvent({ harness_version: { tag: "v1", commit: digit.repeat(40) } }));
  for (const digit of ["A", "g"]) assertInvalid(createdEvent({ harness_version: { tag: "v1", commit: digit.repeat(64) } }));
  for (const digit of ["0", "9", "f"]) assertValid(createdEvent({ harness_version: { tag: "v1", commit: digit.repeat(64) } }));
});

test("[GRAPH-10] an event other than task.created with graph fails the schema; task.created without graph passes it", () => {
  assertInvalid(transitionEvent({ graph: GRAPH_L }));
  assertInvalid(transitionEvent({ event_type: "provider.observed", graph: GRAPH_L }));
  assertValid(without(createdEvent(), "graph"));
});

test("[PROOF-02] the schema properties are the slice subset of the section 17 Event names", () => {
  const section17EventNames = [
    "seq", "ts", "root_id", "task_id", "event_type", "actor", "reason", "cause_event_id", "graph", "graph_hash",
    "provider", "model", "harness_version", "prompt_version", "session_id", "item_id", "request_id", "input",
    "output", "cache_read", "cache_write_5m", "cache_write_1h", "cost_usd", "pricing_version", "payload_ref",
    "payload_hash",
  ];
  const properties = Object.keys(EVENT_SCHEMA.properties).sort();
  assert.deepEqual(properties, [
    "actor", "cause_event_id", "event_type", "graph", "graph_hash", "harness_version", "item_id", "payload_hash",
    "payload_ref", "reason", "root_id", "seq", "session_id", "task_id", "ts",
  ]);
  for (const property of properties) assert.ok(section17EventNames.includes(property), property);
});

test("[LOG-04] [LOG-05] an event outside the field forms of the slice fails the schema", () => {
  for (const seq of [0, -1, 1.5, "1"]) assertInvalid(createdEvent({ seq }));
  for (const ts of ["", 5]) assertInvalid(createdEvent({ ts }));
  for (const field of ["root_id", "task_id", "item_id"]) {
    for (const value of ["A", "-a", "", "a".repeat(65)]) assertInvalid(createdEvent({ [field]: value }));
    for (const value of ["a".repeat(64), "z9_-"]) assertValid(createdEvent({ [field]: value }));
  }
  for (const event_type of [
    "agent.started",
    "",
    "task.createdx",
    "transition.TASK_RECEIVED",
    "transition.TASK_RECEIVED.BOGUS",
    "transition.BOGUS.TASK_CLASSIFIED",
    "xtransition.TASK_RECEIVED.TASK_CLASSIFIED",
    "transition.TASK_RECEIVED.TASK_CLASSIFIEDx",
    "transition-TASK_RECEIVED-TASK_CLASSIFIED",
    "taskXcreated",
    "providerXobserved",
    "transitionXTASK_RECEIVED.TASK_CLASSIFIED",
    "transition.TASK_RECEIVEDXTASK_CLASSIFIED",
    "transition.TASK_RECEIVED.",
    "transition..TASK_CLASSIFIED",
  ]) {
    assertInvalid(transitionEvent({ event_type }));
  }
  for (const event_type of ["transition.NEEDS_HUMAN.DONE", "transition.DONE.TASK_RECEIVED", "provider.observed"]) {
    assertValid(transitionEvent({ event_type }));
  }
  for (const field of ["seq", "ts", "root_id", "task_id", "event_type", "graph_hash"]) assertInvalid(without(createdEvent(), field));
  for (const length of [63, 65]) assertInvalid(createdEvent({ graph_hash: "a".repeat(length) }));
  for (const digit of ["A", "g"]) assertInvalid(createdEvent({ graph_hash: digit.repeat(64) }));
  for (const digit of ["0", "9", "a", "f"]) assertValid(createdEvent({ graph_hash: digit.repeat(64) }));
  const invalidGraphs: unknown[] = [
    { ...GRAPH_L, track: "X" },
    { track: "L", edges: GRAPH_L.edges },
    { stages: [], edges: GRAPH_L.edges },
    { track: "L", stages: [] },
    { ...GRAPH_L, edges: [...GRAPH_L.edges, { to: "DONE" }] },
    { ...GRAPH_L, stages: ["Bad"] },
    { ...GRAPH_L, stages: ["a", "a"] },
    { ...GRAPH_L, edges: [...GRAPH_L.edges, { from: "BOGUS", to: "DONE" }] },
    { ...GRAPH_L, edges: [...GRAPH_L.edges, { from: "DONE" }] },
    { ...GRAPH_L, edges: [...GRAPH_L.edges, { from: "DONE", to: "DONE", label: "x" }] },
    { ...GRAPH_L, extra: true },
  ];
  for (const graph of invalidGraphs) assertInvalid(createdEvent({ graph }));
  for (const field of ["reason", "cause_event_id", "session_id"]) {
    assertInvalid(transitionEvent({ [field]: "" }));
    assertValid(transitionEvent({ [field]: "x" }));
  }
  const payloadHash = "b".repeat(64);
  assertInvalid(transitionEvent({ payload_ref: "", payload_hash: payloadHash }));
  assertValid(transitionEvent({ payload_ref: "x", payload_hash: payloadHash }));
  assertInvalid(transitionEvent({ payload_ref: "x" }));
  assertInvalid(transitionEvent({ payload_hash: payloadHash }));
  assertInvalid(transitionEvent({ payload_ref: "x", payload_hash: "b".repeat(63) }));
  assertInvalid(transitionEvent({ event_id: "e1" }));
  assertInvalid(transitionEvent({ provider: "alpha-llm" }));
});
