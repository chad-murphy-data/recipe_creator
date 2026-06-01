import { test } from "node:test";
import assert from "node:assert/strict";
import { solvePortions, totalsFromGrams, offTarget, TOL } from "./solver.js";

// Realistic per-100g macro vectors (USDA-ish), so the tests exercise the same
// shapes the live edge function returns.
const P = {
  chicken: { kcal: 165, protein: 31, fat: 3.6, carbs: 0, fiber: 0 },     // breast, cooked
  rice:    { kcal: 130, protein: 2.7, fat: 0.3, carbs: 28, fiber: 0.4 }, // white, cooked
  brownRice:{ kcal: 123, protein: 2.7, fat: 1.0, carbs: 25.6, fiber: 1.6 },
  edamame: { kcal: 121, protein: 12, fat: 5, carbs: 9, fiber: 5 },
  broccoli:{ kcal: 35, protein: 2.4, fat: 0.4, carbs: 7, fiber: 3.3 },
  mushroom:{ kcal: 28, protein: 2.2, fat: 0.5, carbs: 5, fiber: 2 },
  oil:     { kcal: 884, protein: 0, fat: 100, carbs: 0, fiber: 0 },
  miso:    { kcal: 198, protein: 12, fat: 6, carbs: 26, fiber: 5 },
  soy:     { kcal: 53, protein: 8, fat: 0, carbs: 5, fiber: 0.8 },
};

const ing = (name, per100g, grams, role) => ({
  name, per100g, grams_cooked: grams, role,
});

const TARGETS = { calories: 535, protein_g: 45, carbs_g: 42, fiber_g: 7 };

test("totalsFromGrams is linear and correct", () => {
  const grounded = [ing("chicken", P.chicken, 100)];
  const t = totalsFromGrams(grounded, [200]);
  assert.equal(Math.round(t.kcal), 330);
  assert.equal(Math.round(t.protein), 62);
});

test("solves the miso-chicken bowl to within tolerance", () => {
  // Deliberately off: too much rice (carb/calorie heavy), the exact case Chad asked about.
  const grounded = [
    ing("Chicken breast", P.chicken, 150, "protein"),
    ing("Brown rice", P.brownRice, 200, "carb"),
    ing("Edamame", P.edamame, 75, "legume"),
    ing("Roasted mushrooms", P.mushroom, 80, "veg"),
    ing("Broccoli", P.broccoli, 80, "veg"),
    ing("Sesame oil", P.oil, 5, "oil"),
    ing("White miso", P.miso, 16, "seasoning"),
    ing("Soy sauce", P.soy, 10, "condiment"),
  ];
  const r = solvePortions(grounded, TARGETS);
  assert.ok(r.withinTolerance, `expected within tolerance, misses: ${r.misses.join("; ")}`);
  // sanity: every macro genuinely inside tolerance
  assert.ok(Math.abs(r.total.kcal - 535) <= TOL.calories);
  assert.ok(Math.abs(r.total.protein - 45) <= TOL.protein_g);
  assert.ok(Math.abs(r.total.carbs - 42) <= TOL.carbs_g);
  assert.ok(r.total.fiber >= 7 - TOL.fiber_g);
});

test("trims the carb-heavy ingredient rather than zeroing it (Chad's rice question)", () => {
  const grounded = [
    ing("Chicken breast", P.chicken, 150, "protein"),
    ing("White rice", P.rice, 300, "carb"), // way too much
    ing("Broccoli", P.broccoli, 80, "veg"),
    ing("Edamame", P.edamame, 75, "legume"),
    ing("Sesame oil", P.oil, 5, "oil"),
  ];
  const r = solvePortions(grounded, TARGETS);
  const rice = r.changes.find((c) => c.name === "White rice");
  assert.ok(rice.to < rice.from, "rice should be trimmed down");
  assert.ok(rice.to > 0, "rice should not be deleted, just trimmed");
});

test("never drowns the dish in oil to hit calories", () => {
  // Low-calorie starting point; a naive solver might crank the oil.
  const grounded = [
    ing("Chicken breast", P.chicken, 150, "protein"),
    ing("Broccoli", P.broccoli, 100, "veg"),
    ing("Sesame oil", P.oil, 5, "oil"),
  ];
  const r = solvePortions(grounded, TARGETS);
  const oil = r.changes.find((c) => c.name === "Sesame oil");
  // oil capped at 1.3x its 5g proposal -> <= ~7g, not 30g+
  assert.ok(oil.to <= 8, `oil should stay small, got ${oil.to}g`);
});

test("reports the set is infeasible when no portioning can hit the targets", () => {
  // All low-protein veg: cannot reach 45g protein no matter the grams.
  const grounded = [
    ing("Broccoli", P.broccoli, 100, "veg"),
    ing("Mushrooms", P.mushroom, 100, "veg"),
  ];
  const r = solvePortions(grounded, TARGETS);
  assert.equal(r.withinTolerance, false);
  assert.ok(r.misses.some((m) => m.includes("protein")), "protein should be flagged as a miss");
});

test("is deterministic: same input solves identically", () => {
  const grounded = [
    ing("Chicken breast", P.chicken, 150, "protein"),
    ing("Brown rice", P.brownRice, 200, "carb"),
    ing("Edamame", P.edamame, 75, "legume"),
    ing("Sesame oil", P.oil, 5, "oil"),
  ];
  const a = solvePortions(grounded, TARGETS);
  const b = solvePortions(grounded, TARGETS);
  assert.deepEqual(a.grams, b.grams);
});

test("leaves an already-good recipe essentially alone", () => {
  // Pre-solved-ish portions; solver shouldn't thrash them.
  const grounded = [
    ing("Chicken breast", P.chicken, 140, "protein"),
    ing("Brown rice", P.brownRice, 150, "carb"),
    ing("Edamame", P.edamame, 70, "legume"),
    ing("Broccoli", P.broccoli, 90, "veg"),
    ing("Sesame oil", P.oil, 5, "oil"),
  ];
  const r = solvePortions(grounded, TARGETS);
  assert.ok(r.withinTolerance, `misses: ${r.misses.join("; ")}`);
});
