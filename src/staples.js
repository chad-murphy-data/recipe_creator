// ─────────────────────────────────────────────────────────────────────────
//  Staple ingredient table — pinned USDA FoodData Central entries.
//
//  USDA search is fuzzy. For Charlie's regular ingredients we'd rather not roll
//  the dice every time: pinning a food to a known-good FDC ID removes search
//  variance entirely, so the common case resolves to a fixed, correct entry and
//  fuzzy search only handles the long tail. A resolved staple is passed to the
//  edge function as a pinned fdcId, which skips search and fetches that exact
//  entry.
//
//  HOW TO EXTEND (the mechanism is built; grow the table over time):
//    1. Look the food up at https://fdc.nal.usda.gov/
//    2. Prefer a Foundation, SR Legacy, or Survey (FNDDS) entry in a COOKED form.
//    3. Copy its FDC ID and add a row below. `keys` are the lowercase "match"
//       terms the generator emits (the distinctive food noun).
//    4. VERIFY the ID returns the food you expect before adding it. A wrong pin
//       is worse than a search: it produces confidently wrong macros.
//
//  The seed rows below were confirmed correct in grounding logs this session.
//  Notably absent: edamame and rice vinegar (their first auto-matches were
//  wrong, so they are left to the improved search rather than pinned to a guess).
// ─────────────────────────────────────────────────────────────────────────

export const STAPLES = [
  { fdcId: 171477, label: "Chicken, breast, meat only, cooked, roasted", keys: ["chicken breast"] },
  { fdcId: 168932, label: "Rice, white, short-grain, cooked", keys: ["white rice", "short-grain white rice", "short grain white rice"] },
  { fdcId: 170097, label: "Mushrooms, shiitake, cooked", keys: ["shiitake", "shiitake mushroom", "shiitake mushrooms"] },
  { fdcId: 168510, label: "Broccoli, cooked, boiled, drained", keys: ["broccoli"] },
  { fdcId: 172442, label: "Miso", keys: ["miso", "white miso", "miso paste", "white miso paste"] },
  { fdcId: 171016, label: "Oil, sesame, salad or cooking", keys: ["sesame oil"] },
  { fdcId: 172473, label: "Soy sauce (shoyu), low sodium", keys: ["soy sauce", "low sodium soy sauce", "low-sodium soy sauce"] },
];

export function normalize(term) {
  return (term ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Built once from STAPLES: normalized key -> entry.
const INDEX = new Map();
for (const s of STAPLES) for (const k of s.keys) INDEX.set(normalize(k), s);

// Resolve a generator "match" term to a curated staple, or null. Exact match on
// the normalized term only. This is conservative on purpose: we never want to
// mis-pin, so anything not explicitly listed falls through to search.
export function resolveStaple(matchTerm) {
  const key = normalize(matchTerm);
  if (!key) return null;
  return INDEX.get(key) ?? null;
}
