import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonical, canonicalHash } from "../src/storage.js";

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
