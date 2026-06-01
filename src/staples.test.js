import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStaple, normalize, STAPLES } from "./staples.js";

test("resolves a known staple to its pinned fdcId", () => {
  const s = resolveStaple("chicken breast");
  assert.ok(s, "chicken breast should resolve");
  assert.equal(s.fdcId, 171477);
});

test("matching is case- and punctuation-insensitive", () => {
  assert.equal(resolveStaple("Chicken Breast").fdcId, 171477);
  assert.equal(resolveStaple("  chicken   breast ").fdcId, 171477);
  assert.equal(resolveStaple("low-sodium soy sauce").fdcId, resolveStaple("low sodium soy sauce").fdcId);
});

test("resolves alias keys to the same entry", () => {
  const a = resolveStaple("white miso");
  const b = resolveStaple("miso paste");
  const c = resolveStaple("white miso paste");
  assert.ok(a && b && c);
  assert.equal(a.fdcId, b.fdcId);
  assert.equal(b.fdcId, c.fdcId);
});

test("returns null for unknown foods (falls through to search)", () => {
  assert.equal(resolveStaple("dragonfruit"), null);
  assert.equal(resolveStaple("rice vinegar"), null); // deliberately not pinned
  assert.equal(resolveStaple("edamame"), null);      // deliberately not pinned
});

test("returns null for empty/missing input", () => {
  assert.equal(resolveStaple(""), null);
  assert.equal(resolveStaple(null), null);
  assert.equal(resolveStaple(undefined), null);
});

test("does not substring-match (avoids mis-pinning)", () => {
  // "chicken" alone is not a key; only the specific phrases are.
  assert.equal(resolveStaple("chicken"), null);
  assert.equal(resolveStaple("chicken breast sandwich"), null);
});

test("normalize collapses case, punctuation, and whitespace", () => {
  assert.equal(normalize("  Low-Sodium  Soy Sauce! "), "low sodium soy sauce");
});

test("every staple has a positive integer fdcId and at least one key", () => {
  for (const s of STAPLES) {
    assert.ok(Number.isInteger(s.fdcId) && s.fdcId > 0, `bad fdcId for ${s.label}`);
    assert.ok(Array.isArray(s.keys) && s.keys.length > 0, `no keys for ${s.label}`);
  }
});

test("no key is claimed by two different staples", () => {
  const seen = new Map();
  for (const s of STAPLES) {
    for (const k of s.keys) {
      const nk = normalize(k);
      assert.ok(!seen.has(nk) || seen.get(nk) === s.fdcId, `key "${k}" maps to two entries`);
      seen.set(nk, s.fdcId);
    }
  }
});
