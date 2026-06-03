// ─────────────────────────────────────────────────────────────────────────
//  Estimated fallback for foods USDA has no entry for (any tier, including
//  Branded). This is the ONE place a macro number originates from the model
//  instead of USDA, so it is always flagged `estimated: true` and rendered
//  "not USDA" in the UI. It exists so one exotic, truly-absent ingredient
//  doesn't sink an otherwise-good recipe.
//
//  Even here, code still owns the arithmetic: the model gives a per-100g
//  vector, and contributions are computed from grams below, never by the model.
//  The output matches the shape the grounding edge function returns, so it flows
//  through the solver, the editor, and save unchanged.
// ─────────────────────────────────────────────────────────────────────────

function num(x) {
  return Number.isFinite(+x) ? +x : 0;
}

// Coerce a raw model estimate into a clean per-100g vector, or null if unusable.
// An estimate with no calories is treated as a parse failure (better to swap the
// ingredient than to silently count it as zero).
export function normalizeEstimate(raw) {
  if (!raw || typeof raw !== "object") return null;
  const e = {
    kcal: num(raw.kcal),
    protein: num(raw.protein),
    fat: num(raw.fat),
    carbs: num(raw.carbs),
    fiber: num(raw.fiber),
  };
  if (e.kcal <= 0) return null;
  return e;
}

// Build a grounded-shaped ingredient from an estimate, or null if the estimate
// is unusable (caller then swaps the ingredient out).
export function estimatedEntry(ing, estimate) {
  const e = normalizeEstimate(estimate);
  if (!e) return null;
  const grams = num(ing?.grams ?? ing?.grams_cooked);
  const f = grams / 100;
  return {
    name: ing?.name,
    grams_cooked: grams,
    fdcId: null,
    fdcDescription: "estimated (not in USDA)",
    per100g: { ...e, description: "estimated" },
    contributes: {
      kcal: e.kcal * f,
      protein: e.protein * f,
      fat: e.fat * f,
      carbs: e.carbs * f,
      fiber: e.fiber * f,
    },
    role: ing?.role,
    estimated: true,
  };
}
