// ─────────────────────────────────────────────────────────────────────────
//  Portion solver — the precision engine.
//
//  Grounding gives us each ingredient's per-100g macro vector. Macros are linear
//  in grams, so hitting the targets is a small bounded least-squares problem on
//  data we already have: no extra USDA calls, no model guessing at portions.
//
//  Philosophy: the model designs the dish (which ingredients, roughly how much).
//  This code tunes the gram weights to hit the numbers, within sane per-
//  ingredient bounds so the dish stays recognizable. If no portioning can hit
//  the targets, that's a signal the ingredient SET is wrong, and the caller asks
//  the model to swap something, not to re-guess amounts.
// ─────────────────────────────────────────────────────────────────────────

// Tolerances per serving. One source of truth, imported by the app too.
export const TOL = { calories: 25, protein_g: 4, carbs_g: 8, fiber_g: 2 };

// Target key -> per-100g / totals key.
const KEYS = ["calories", "protein_g", "carbs_g", "fiber_g"];
const P = { calories: "kcal", protein_g: "protein", carbs_g: "carbs", fiber_g: "fiber" };

// Recompute authoritative totals locally from per-100g vectors. Identical to
// what re-grounding would return for the same fdcIds (per-100g is fixed; the
// contribution is linear), so pure portion changes need no USDA round trip.
export function totalsFromGrams(grounded, grams) {
  const t = { kcal: 0, protein: 0, fat: 0, carbs: 0, fiber: 0 };
  grounded.forEach((g, i) => {
    const p = g.per100g || {};
    const f = (grams[i] ?? 0) / 100;
    t.kcal += (p.kcal || 0) * f;
    t.protein += (p.protein || 0) * f;
    t.fat += (p.fat || 0) * f;
    t.carbs += (p.carbs || 0) * f;
    t.fiber += (p.fiber || 0) * f;
  });
  return t;
}

// The real, asymmetric tolerance check (fiber only fails when UNDER).
export function offTarget(total, targets) {
  const misses = [];
  if (Math.abs(total.kcal - targets.calories) > TOL.calories)
    misses.push(`calories ${total.kcal.toFixed(0)} vs target ${targets.calories}`);
  if (Math.abs(total.protein - targets.protein_g) > TOL.protein_g)
    misses.push(`protein ${total.protein.toFixed(1)}g vs target ${targets.protein_g}g`);
  if (Math.abs(total.carbs - targets.carbs_g) > TOL.carbs_g)
    misses.push(`carbs ${total.carbs.toFixed(1)}g vs target ${targets.carbs_g}g`);
  if (total.fiber < targets.fiber_g - TOL.fiber_g)
    misses.push(`fiber ${total.fiber.toFixed(1)}g below target ${targets.fiber_g}g`);
  return misses;
}

// Per-ingredient gram bounds. This is the "sane portions" guarantee, and the
// direct answer to "trim the rice or delete it?": the solver may trim within a
// band around the model's proposed amount, but it can't zero an ingredient out
// (deletion is a design choice, left to the model via a swap). Flavor and fat
// ingredients get a tight band so the solver can't game calories by drowning the
// dish in oil or piling on a garnish.
function boundsFor(g) {
  const proposed = g.grams_cooked ?? g.grams ?? 0;
  const role = (g.role || "").toLowerCase();
  const p = g.per100g || {};
  const kcalPerG = (p.kcal || 0) / 100;
  const fatPerG = (p.fat || 0) / 100;

  let lo = 0.4, hi = 2.2; // default: a main component

  if (kcalPerG > 4.5 || fatPerG > 0.5) {
    lo = 0.6; hi = 1.3; // near-pure fat/oil: never the calorie lever
  } else if (/(season|aromat|condiment|spice|sauce|paste|dressing|garnish|oil)/.test(role)) {
    lo = 0.7; hi = 1.4; // flavor, not macros
  } else if (/(protein|meat|chicken|beef|pork|fish|seafood|tofu|tempeh|egg)/.test(role)) {
    lo = 0.5; hi = 2.0;
  } else if (/(carb|grain|rice|noodle|soba|pasta|potato|bread|tortilla|oat)/.test(role)) {
    lo = 0.3; hi = 2.6;
  } else if (/(veg|green|mushroom|fruit|bean|legume|edamame)/.test(role)) {
    lo = 0.3; hi = 3.0;
  } else if (proposed <= 15) {
    lo = 0.7; hi = 1.4; // heuristic when role is absent: small amount = flavoring
  }

  return {
    lo: Math.max(2, Math.round(proposed * lo)),
    hi: Math.min(600, Math.max(Math.round(proposed * hi), Math.round(proposed * lo) + 1)),
    proposed,
  };
}

// Solve gram weights to minimize weighted squared error against the targets,
// subject to per-ingredient bounds. Weighted coordinate descent: closed-form
// optimum per ingredient holding others fixed, clamped to bounds, swept to
// convergence. Convex and deterministic, so no learning rate to tune and the
// same recipe always solves the same way.
export function solvePortions(grounded, targets, opts = {}) {
  const n = grounded.length;
  const sweeps = opts.sweeps ?? 60;

  // Weight each macro by 1/tolerance^2 so "within tolerance" matters equally
  // across calories and grams despite their different scales.
  const w = {};
  for (const k of KEYS) w[k] = 1 / (TOL[k] * TOL[k]);

  // Per-gram coefficient for each ingredient and macro.
  const a = grounded.map((g) => {
    const p = g.per100g || {};
    return {
      calories: (p.kcal || 0) / 100,
      protein_g: (p.protein || 0) / 100,
      carbs_g: (p.carbs || 0) / 100,
      fiber_g: (p.fiber || 0) / 100,
    };
  });
  const b = grounded.map(boundsFor);
  // `locked` ingredients are held at their current weight (the user pinned them,
  // e.g. "salmon at 200g"); the rest solve around them.
  const locked = new Set(opts.locked || []);
  const grams = b.map((x, i) =>
    locked.has(i)
      ? Math.max(0, grounded[i].grams_cooked ?? x.proposed)
      : Math.min(x.hi, Math.max(x.lo, x.proposed))
  );

  // Running totals (fiber solved two-sided here for clean math; the real
  // one-sided fiber check happens in offTarget at the end).
  const tot = {};
  for (const k of KEYS) tot[k] = grams.reduce((s, gi, i) => s + gi * a[i][k], 0);

  for (let s = 0; s < sweeps; s++) {
    for (let i = 0; i < n; i++) {
      if (locked.has(i)) continue; // never move a pinned ingredient
      for (const k of KEYS) tot[k] -= grams[i] * a[i][k]; // strip i -> rest
      let num = 0, den = 0;
      for (const k of KEYS) {
        const resid = tot[k] - targets[k];
        num += w[k] * a[i][k] * resid;
        den += w[k] * a[i][k] * a[i][k];
      }
      let gi = den < 1e-9 ? grams[i] : -num / den; // den~0: macro-inert item
      gi = Math.min(b[i].hi, Math.max(b[i].lo, gi));
      grams[i] = gi;
      for (const k of KEYS) tot[k] += grams[i] * a[i][k]; // add i back
    }
  }

  const finalGrams = grams.map((x) => Math.round(x));
  const total = totalsFromGrams(grounded, finalGrams);
  const misses = offTarget(total, targets);

  const changes = grounded.map((g, i) => ({
    name: g.name,
    from: b[i].proposed,
    to: finalGrams[i],
  }));

  return { grams: finalGrams, total, withinTolerance: misses.length === 0, misses, changes };
}

// Apply gram weights onto grounded ingredients: update grams_cooked and recompute
// each ingredient's macro contribution. Shared by the pipeline and the live editor
// so displayed/saved numbers always match the per-100g math.
export function applyGrams(grounded, grams) {
  return grounded.map((g, i) => {
    const f = (grams[i] ?? 0) / 100;
    const p = g.per100g || {};
    return {
      ...g,
      grams_cooked: grams[i],
      contributes: {
        kcal: (p.kcal || 0) * f, protein: (p.protein || 0) * f, fat: (p.fat || 0) * f,
        carbs: (p.carbs || 0) * f, fiber: (p.fiber || 0) * f,
      },
    };
  });
}
