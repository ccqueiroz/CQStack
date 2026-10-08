import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { StateError } from "../src/storage.js";
import { observeProcess, type ObservedRequest, type ProcessOutcome } from "../src/observation.js";

// Secret samples and their prefixes are built at runtime, so no source line looks like a credential.
const VALUE = ["v4l0", "U_e-9"].join(".");
const BEARER = ["Bea", "rer"].join("");
const BASIC = ["ba", "sic"].join("");
const SK = ["s", "k-"].join("");
const SLASHED = ["Zq9", "Wx+Yv", "=="].join("/");
const SPACED = ["correct", "horse", "staple"].join(" ");
const ESCAPED = ["zq", "wx yv"].join('\\"');
const ESCAPED_SINGLE = ["zq", "wx yv"].join("\\'");
const FRAGMENTS = ["Zq9", "Wx+Yv", "correct", "horse", "staple", "zq", "wx yv"];
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const REQUEST = { command: "provider-cli", stdin: "prompt", timeout_ms: 1000 };
const outcome = (overrides: Partial<ProcessOutcome>): ProcessOutcome => ({ exit_code: 0, stdout: "", stderr: "", signal: null, ...overrides });
const stdoutOf = (inputs: string[]) =>
  [
    ...inputs.map((input) => JSON.stringify({ type: "error", message: input })),
    ...inputs.map((input) => JSON.stringify({ is_error: true, result: input })),
    ...inputs.map((input) => JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: input } })),
  ].join("\n");

test("[OBS-01] [OBS-02] [OBS-04] [OBS-06] the observation of a process is exactly the redacted record with root_id and item_id", () => {
  const request = {
    command: "provider-cli",
    stdin: "stdin-marker-9 \u00e7\u00e3o",
    timeout_ms: 5000,
    args: ["--flag-marker"],
    cwd: "cwd-marker",
    env: { CQSTACK_FAKE_NAME_7: "fake-value-7" },
  };
  const observation = observeProcess(
    { root_id: "r1", item_id: "item-1" },
    request,
    outcome({ stdout: "stdout-marker-42 \u00e7\n", stderr: "warn" }),
    12,
  );
  assert.deepEqual(observation, {
    root_id: "r1",
    item_id: "item-1",
    command: "provider-cli",
    timeout_ms: 5000,
    elapsed_ms: 12,
    exit_code: 0,
    signal: null,
    prompt_bytes: Buffer.byteLength("stdin-marker-9 \u00e7\u00e3o"),
    prompt_hash: sha256("stdin-marker-9 \u00e7\u00e3o"),
    stdout_bytes: Buffer.byteLength("stdout-marker-42 \u00e7\n"),
    stdout_hash: sha256("stdout-marker-42 \u00e7\n"),
    stderr_bytes: 4,
    stderr_hash: sha256("warn"),
    stderr: "warn",
    errors: [],
    tool_calls: [],
  });
  const serialized = JSON.stringify(observation);
  for (const marker of ["stdin-marker-9", "stdout-marker-42", "CQSTACK_FAKE_NAME_7", "fake-value-7", "--flag-marker", "cwd-marker"]) {
    assert.ok(!serialized.includes(marker), marker);
  }
});

test("[OBS-02] without item_id the observation has no item_id key", () => {
  const observation = observeProcess({ root_id: "r1" }, REQUEST, outcome({}), 1);
  assert.equal(observation.root_id, "r1");
  assert.equal("item_id" in observation, false);
});

test("[OBS-03] a missing, empty or malformed root_id, or a malformed item_id, is refused", () => {
  const attributions = [
    {},
    { root_id: "" },
    { root_id: "R1" },
    { root_id: undefined },
    { root_id: "r1", item_id: "Item" },
    { root_id: "r1", item_id: "" },
    null,
    undefined,
    { root_id: null },
    { root_id: 1 },
    { root_id: "r1", item_id: null },
    { root_id: "r1", item_id: 1 },
  ] as unknown as Array<{ root_id?: string; item_id?: string }>;
  for (const attribution of attributions) {
    assert.throws(
      () => observeProcess(attribution, REQUEST, outcome({}), 1),
      (error: unknown) => error instanceof StateError && error.code === "OBSERVATION_ATTRIBUTION_INVALID",
      JSON.stringify(attribution),
    );
  }
});

test("[OBS-05] every secret form is replaced whole by [REDACTED] in stderr, error messages and tool commands, in any case", () => {
  const forms: Array<[string, string]> = [
    [`token=${VALUE}`, "token[REDACTED]"],
    [`TOKEN: ${VALUE}`, "TOKEN[REDACTED]"],
    [`api_key: "${VALUE}"`, "api_key[REDACTED]"],
    [`api-key='${VALUE}'`, "api-key[REDACTED]"],
    [`APIKEY = ${VALUE}`, "APIKEY[REDACTED]"],
    [`password="${SPACED}"`, "password[REDACTED]"],
    [`{"secret": "${SLASHED}", "next": 1}`, '{"secret[REDACTED]'],
    [`Authorization: ${VALUE}`, "Authorization[REDACTED]"],
    [`x ${BEARER}  ${VALUE}`, `x ${BEARER}[REDACTED]`],
    [`${BASIC.toUpperCase()}\t${VALUE}`, `${BASIC.toUpperCase()}[REDACTED]`],
    [`x ${SK}${SLASHED} y`, `x ${SK}[REDACTED]`],
    [`${SK.toUpperCase()}q`, `${SK.toUpperCase()}[REDACTED]`],
    [`aws_secret_access_key=${VALUE}`, "aws_secret[REDACTED]"],
    [`--token ${VALUE}`, "--token[REDACTED]"],
    [`token${SK}${VALUE}`, "token[REDACTED]"],
    [`lead ${BEARER} ${VALUE} token=${VALUE}`, `lead ${BEARER}[REDACTED]`],
    [`password="${SK}${ESCAPED} tail"`, "password[REDACTED]"],
    ["token=\npassword=\nLEAK123", "token[REDACTED]"],
    ["token=\n_\nLEAK123", "token[REDACTED]"],
    ["x token", "x token[REDACTED]"],
  ];
  for (const [input, output] of forms) {
    const observation = observeProcess({ root_id: "r1" }, REQUEST, outcome({ stdout: stdoutOf([input]), stderr: input }), 1);
    assert.deepEqual([observation.stderr, observation.errors, observation.tool_calls], [output, [output, output], [output]], input);
    assert.equal(observation.stderr_hash, sha256(input));
    const serialized = JSON.stringify(observation);
    for (const fragment of [VALUE, ...FRAGMENTS, "LEAK123"]) assert.ok(!serialized.includes(fragment), fragment);
  }

  // Every key and prefix, in both cases and inside a longer name, before values of every shape and on any line: the text is
  // kept up to the end of the first one and nothing after it is left.
  const WORDS = ["token", "api_key", "api-key", "apikey", "password", "secret", "authorization", BEARER, BASIC, SK];
  const VALUES = ['="qx1\\"zv2"', " 'qx1\\'zv2'", " qx1/+=zv2", "=\n_\nqx1", "=\npassword=\nqx1", ":\r\n\u2028qx1\tzv2", ""];
  const wrong: string[] = [];
  let swept = 0;
  for (const caseOf of [(text: string) => text.toLowerCase(), (text: string) => text.toUpperCase()])
    for (const word of WORDS)
      for (const [name, rest] of [["", ""], ["aws_", "_id"]])
        for (const value of VALUES)
          for (const before of ["", "lead ", "lead\n"]) {
            const text = before + name + caseOf(word) + rest + value;
            const expected = before + name + caseOf(word) + "[REDACTED]";
            const sample = observeProcess({ root_id: "r1" }, REQUEST, outcome({ stdout: stdoutOf([text]), stderr: text }), 1);
            swept += 1;
            if ([sample.stderr, ...sample.errors, ...sample.tool_calls].some((output) => output !== expected)) wrong.push(text);
          }
  assert.deepEqual({ swept, wrong: wrong.slice(0, 3), count: wrong.length }, { swept: 840, wrong: [], count: 0 });
});

test("[OBS-05] stderr is cut to 8000 characters before redaction, so the marker stays whole", () => {
  const cut = (stderr: string) => observeProcess({ root_id: "r1" }, REQUEST, outcome({ stderr }), 1).stderr;
  assert.equal(cut("a".repeat(7990) + " token=" + VALUE), "a".repeat(7990) + " token[REDACTED]");
  assert.equal(cut("e".repeat(7998) + "token=" + VALUE), "e".repeat(7998) + "to");
  assert.equal(cut("b".repeat(8001)), "b".repeat(8000));
  assert.equal(cut("c".repeat(7999)), "c".repeat(7999));
  assert.equal(cut("d".repeat(8000)), "d".repeat(8000));
});

test("[OBS-04] [OBS-05] only error messages and command executions are taken from stdout", () => {
  const stdout = [
    "not json",
    "null",
    '{"type":"other","message":"m1"}',
    '{"type":"error","message":5}',
    '{"is_error":false,"result":"r1"}',
    '{"is_error":true,"result":7}',
    '{"type":"item.completed","item":{"type":"file_change","command":"cmd-1"}}',
    '{"type":"item.started","item":{"type":"command_execution","command":"cmd-2"}}',
    '{"type":"item.completed","item":{"type":"command_execution"}}',
    ...[[`token=${VALUE}`], ["curl", "-H", `token: ${VALUE}`], { argv: `token=${VALUE}` }, 5, null].map((command) =>
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command } }),
    ),
    '{"type":"error","message":"e1"}',
    '{"is_error":true,"result":"r2"}',
    '{"type":"item.completed","item":{"type":"command_execution","command":"cmd-3"}}',
  ].join("\n");
  const observation = observeProcess({ root_id: "root-a" }, REQUEST, outcome({ stdout }), 1);
  assert.deepEqual(observation.errors, ["e1", "r2"]);
  assert.deepEqual(observation.tool_calls, ["cmd-3"]);
  const serialized = JSON.stringify(observation);
  for (const marker of ["m1", "r1", "cmd-1", "cmd-2", VALUE]) assert.ok(!serialized.includes(marker), marker);
});

test("[OBS-07] a process request or outcome with a field of another type is refused", () => {
  const secretBytes = new TextEncoder().encode(`token=${VALUE}`);
  const requests = [
    null,
    undefined,
    { ...REQUEST, command: ["provider-cli", "--api-key", VALUE] },
    { ...REQUEST, command: undefined },
    { ...REQUEST, stdin: secretBytes },
    { ...REQUEST, stdin: null },
    { ...REQUEST, timeout_ms: "1000" },
    { ...REQUEST, timeout_ms: { raw: VALUE } },
    ...[NaN, Infinity, -Infinity].map((timeout_ms) => ({ ...REQUEST, timeout_ms })),
  ];
  const outcomes = [
    null,
    { ...outcome({}), stdout: Buffer.from("x") },
    { ...outcome({}), stderr: secretBytes },
    { ...outcome({}), stderr: [`token=${VALUE}`] },
    { ...outcome({}), exit_code: "0" },
    { ...outcome({}), exit_code: undefined },
    ...[NaN, Infinity, -Infinity].map((exit_code) => ({ ...outcome({}), exit_code })),
    { ...outcome({}), signal: { raw: VALUE } },
    { ...outcome({}), signal: undefined },
  ];
  const cases: Array<[unknown, unknown, unknown]> = [
    ...requests.map((request): [unknown, unknown, unknown] => [request, outcome({}), 1]),
    ...outcomes.map((result): [unknown, unknown, unknown] => [REQUEST, result, 1]),
    [REQUEST, outcome({}), "12"],
    [REQUEST, outcome({}), undefined],
    ...[NaN, Infinity, -Infinity].map((elapsedMs): [unknown, unknown, unknown] => [REQUEST, outcome({}), elapsedMs]),
  ];
  cases.forEach(([request, result, elapsedMs], index) => {
    assert.throws(
      () => observeProcess({ root_id: "r1" }, request as ObservedRequest, result as ProcessOutcome, elapsedMs as number),
      (error: unknown) => error instanceof StateError && error.code === "OBSERVATION_INPUT_INVALID",
      `case ${index + 1}`,
    );
  });
  const accepted = observeProcess({ root_id: "r1" }, REQUEST, outcome({ exit_code: null, signal: "SIGTERM" }), 2.5);
  assert.deepEqual([accepted.exit_code, accepted.signal, accepted.elapsed_ms], [null, "SIGTERM", 2.5]);
});
