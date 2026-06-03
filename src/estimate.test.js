import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEstimate, estimatedEntry } from "./estimate.js";

test("normalizeEstimate coerces numeric strings and fills missing macros", () => {
  const e = normalizeEstimate({ kcal: "120", protein: 6 });
  assert.equal(e.kcal, 120);
  assert.equal(e.protein, 6);
  assert.equal(e.fat, 0);
  assert.equal(e.carbs, 0);
  assert.equal(e.fiber, 0);
});

test("normalizeEstimate rejects junk and calorie-less estimates", () => {
  assert.equal(normalizeEstimate(null), null);
  assert.equal(normalizeEstimate("nope"), null);
  assert.equal(normalizeEstimate({ protein: 5 }), null); // no kcal
  assert.equal(normalizeEstimate({ kcal: 0 }), null);
  assert.equal(normalizeEstimate({ kcal: -10 }), null);
});

test("estimatedEntry builds a grounded-shaped, flagged entry", () => {
  const entry = estimatedEntry(
    { name: "Gochujang", grams: 20, role: "seasoning" },
    { kcal: 120, protein: 5, fat: 2, carbs: 24, fiber: 2 }
  );
  assert.equal(entry.estimated, true);
  assert.equal(entry.fdcId, null);
  assert.match(entry.fdcDescription, /estimat/i);
  assert.equal(entry.role, "seasoning");
  assert.equal(entry.grams_cooked, 20);
  assert.equal(entry.per100g.kcal, 120);
  assert.equal(entry.per100g.description, "estimated");
  // contributes = per100g * grams / 100
  assert.ok(Math.abs(entry.contributes.kcal - 24) < 1e-9);
  assert.ok(Math.abs(entry.contributes.carbs - 4.8) < 1e-9);
});

test("estimatedEntry returns null when the estimate is unusable", () => {
  assert.equal(estimatedEntry({ name: "X", grams: 10 }, null), null);
  assert.equal(estimatedEntry({ name: "X", grams: 10 }, { protein: 3 }), null);
});

test("estimatedEntry tolerates missing grams (treats as 0)", () => {
  const entry = estimatedEntry({ name: "X" }, { kcal: 100 });
  assert.equal(entry.grams_cooked, 0);
  assert.equal(entry.contributes.kcal, 0);
});
