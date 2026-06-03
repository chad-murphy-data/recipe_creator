import React, { useState, useEffect, useRef } from "react";
import { solvePortions, applyGrams, totalsFromGrams, offTarget, TOL } from "./solver.js";
import { resolveStaple } from "./staples.js";
import { tasteProfile, tastePromptSection, EMPTY_TASTE } from "./taste.js";
import { estimatedEntry } from "./estimate.js";

// ─────────────────────────────────────────────────────────────────────────
//  Charlie's Recipe Box
//  Macro-precise recipes, grounded in USDA FoodData Central, taste-checked
//  by a blind palatability judge. Saved to Supabase.
//
//  Pipeline per request:
//    1. Generator    -> proposes a dish: ingredients (w/ USDA query, match, role)
//                       + rough grams + steps. Grams are a starting point.
//    2. Grounding    -> code queries USDA, validates the match, gets per-100g macros
//    3. Solve        -> code computes the exact gram weights that hit the targets,
//                       within sane per-ingredient bounds (the precision engine).
//    4. Swap (only)  -> if NO portioning can hit the targets, the ingredient SET
//                       is wrong: ask the model to swap one in, then re-ground.
//    5. Palatability -> blind judge (no macros) approves or kicks back
//    6. Re-solve     -> after any taste edit, re-ground and re-solve so macros
//                       can't silently drift
//    7. Save         -> Supabase
//
//  Macros are never the model's job. The model designs the dish; code owns the
//  numbers. The Generator and judge run through /api/claude, a server-side proxy
//  that holds the Anthropic key and enforces the app password.
// ─────────────────────────────────────────────────────────────────────────

const MAX_SWAP_ROUNDS = 4;
const MAX_TASTE_ROUNDS = 3;

const DEFAULT_TARGETS = {
  calories: 535,
  protein_g: 45, // midpoint of 40-50
  carbs_g: 42,   // midpoint of 30-55
  fiber_g: 7,    // midpoint of 5-10
};

const DEFAULT_PREFS =
  "Loves umami flavors. Skinless boneless chicken breast is a workhorse protein. No hard dislikes or allergies. Avoid burying a dish in any single garnish to hit a number, balance is the point.";

// Supabase connection. These are PUBLIC client values for this one project:
// the publishable key is meant to live in the browser (access is governed by
// row-level security, not by hiding it). Baked in so there's nothing to paste
// and no env var that could be set to the wrong (secret) key by mistake.
// An env var can still override for a different project/deploy.
const SB = {
  url: import.meta.env.VITE_SUPABASE_URL || "https://nwgxyytowbluuykbdcfc.supabase.co",
  key: import.meta.env.VITE_SUPABASE_ANON_KEY || "sb_publishable_MF7iftdZykPrfelnVnJHew_DSuyVLJ1",
};

const appPassword = () =>
  (typeof sessionStorage !== "undefined" && sessionStorage.getItem("rb_pw")) || "";

// ── USDA grounding via Supabase edge function (server-side, no CORS/sandbox issue) ──
async function groundViaEdge(sb, ingredients, prep) {
  const r = await fetch(`${sb.url}/functions/v1/usda-ground`, {
    method: "POST",
    headers: {
      apikey: sb.key,
      Authorization: `Bearer ${sb.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ingredients, prep }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || `Grounding failed (${r.status})`);
  return d; // { grounded, total }
}

// ── Recipe engine (Generator + judge) via the server-side proxy ──────────────
// See server/claude.js. The Anthropic key, model, and password live on the
// server. We just pass the entered password through for the server to check.
async function callClaude(system, userContent) {
  const response = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-app-password": appPassword() },
    body: JSON.stringify({ system, user: userContent }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `Recipe engine error (${response.status})`);
  }
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return text;
}

function parseJSON(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    // Most often a truncated response. Give an actionable message instead of
    // the cryptic "Unexpected end of JSON input".
    const preview = clean.slice(0, 120).replace(/\s+/g, " ");
    throw new Error(
      `The recipe engine returned text that wasn't valid JSON (likely cut off). Try again. Starts with: "${preview}…"`
    );
  }
}

// ── Generator agent ────────────────────────────────────────────────────────
// The model designs the DISH. It does not have to nail the macros: code solves
// the exact gram weights afterward. Its grams are just a sensible starting point,
// and its "role" tags tell the solver how far each ingredient may be adjusted.
async function generateRecipe(targets, prefs, feedback, taste, prep) {
  const raw = prep === "raw";
  const weightWord = raw ? "RAW (uncooked) gram weight" : "COOKED gram weight";
  const queryHint = raw
    ? `that will match a RAW entry (e.g. "chicken breast raw", "broccoli raw", "brown rice raw"). Prefer raw/uncooked forms.`
    : `that will match a COOKED entry (e.g. "chicken breast meat only cooked roasted", "broccoli cooked boiled", "brown rice cooked"). Prefer cooked/roasted/boiled forms.`;
  const system = `You design dinner recipes for ONE serving. A separate program will fine-tune the exact gram weights to hit macro targets, so you do not need to nail the numbers. Your job is a real, appealing, balanced dish with the right KINDS and rough amounts of food.

All ingredient weights are ${raw ? "RAW (weighed uncooked, before cooking)" : "COOKED (weighed after cooking)"}.

HARD RULES:
- For every ingredient, give a ${weightWord} as a reasonable starting amount.
- For every ingredient, propose a USDA FoodData Central search phrase ${queryHint}
- For every ingredient, give "match": the identifying food word(s) the correct USDA entry MUST contain. Use the distinctive food noun, not preparation words. Examples: "edamame", "chicken breast", "soy sauce". Be specific for proteins, grains, and produce; a general word is fine for a minor seasoning (e.g. "vinegar").
- For every ingredient, give "role": one of "protein", "carb", "vegetable", "legume", "fat", "seasoning". This controls how much the amount may be adjusted, so be accurate (oils/butter = "fat"; sauces/spices/aromatics = "seasoning").
- Include enough of a clear protein source, a clear carb source, and produce that the targets are reachable by adjusting amounts. (To reach ${targets.protein_g}g protein you need a real protein anchor; to reach ${targets.fiber_g}g fiber you need beans/whole grains/veg.)
- Real, appealing food a person would actually want to eat. No garnish mountains.

Respond ONLY with JSON, no prose, no backticks:
{
  "title": "string",
  "ingredients": [
    {"name":"display name","usdaQuery":"USDA search phrase for a ${raw ? "raw" : "cooked"} entry","match":"identifying food word(s) that must appear in the USDA entry","role":"protein|carb|vegetable|legume|fat|seasoning","grams":number}
  ],
  "steps": ["step 1","step 2"]
}`;

  // Taste signal: the box teaches the generator. Liked dishes pull toward their
  // style, disliked push away, and recent ones keep it from reissuing the same
  // meal (the old "miso chicken every time" loop). This only shapes the DISH;
  // code still solves the macros and the judge stays blind, so no guardrail moves.
  const variety = tastePromptSection(taste);

  const user = `Targets (per serving): ${targets.calories} kcal, ${targets.protein_g}g protein, ${targets.carbs_g}g carbs, ${targets.fiber_g}g fiber.
Weights are ${raw ? "RAW" : "COOKED"}.
Preferences: ${prefs}${variety}
${feedback ? `\nREVISION NEEDED:\n${feedback}` : ""}`;

  return parseJSON(await callClaude(system, user));
}

// ── Palatability judge (blind to macros) ─────────────────────────────────
async function judgePalatability(recipe) {
  const system = `You are a discerning home cook. You will see a recipe: title, ingredients with amounts, and steps. You do NOT know any nutrition targets and you do not care about them.

Answer one question: would a normal person enjoy eating this, and is every ingredient in a sane quantity? Flag anything that looks off, such as an ingredient in absurd amounts, a bizarre combination, or something that would taste bad or unbalanced.

Respond ONLY with JSON:
{"passes": true/false, "note": "one or two sentences. If it fails, say specifically what to fix."}`;

  const user = `Title: ${recipe.title}
Ingredients:
${recipe.ingredients.map((i) => `- ${i.grams}g ${i.name}`).join("\n")}
Steps:
${recipe.steps.map((s, n) => `${n + 1}. ${s}`).join("\n")}`;

  return parseJSON(await callClaude(system, user));
}

// ── Grounding: delegate to edge function, then log results ───────────────
// We carry the model's "role" onto each grounded ingredient so the solver knows
// how far it may adjust each amount (the edge function doesn't echo role back).
// Staples resolve to a pinned fdcId (COOKED entries), so they only apply in
// cooked mode; raw mode falls through to the prep-aware search.
// Get a per-100g macro vector for EVERY ingredient, however we can, so one
// stubborn food doesn't sink the recipe. Order of preference:
//   1. One batched USDA call (the fast, normal path). The edge function itself
//      now tries Foundation/SR/FNDDS and then USDA Branded, so exotic condiments
//      like gochujang resolve here as real USDA data.
//   2. If the batch throws (a food USDA truly lacks at any tier), re-ground each
//      ingredient on its own so the matches survive, and collect the misses.
//   3. Estimate the genuine misses (flagged "not USDA"); whatever can't even be
//      estimated comes back in `unresolved` for the caller to swap out.
async function groundAndEstimate(recipe, sb, log, prep, onPhase) {
  log(`  Sending ${recipe.ingredients.length} ingredients to USDA grounding (${prep})…`);
  const payload = recipe.ingredients.map((i) => {
    const pin = prep === "cooked" ? resolveStaple(i.match) : null;
    if (pin) log(`    · ${i.name}: pinned to ${pin.label} (FDC ${pin.fdcId})`);
    return { name: i.name, usdaQuery: i.usdaQuery, grams: i.grams, match: i.match, fdcId: pin?.fdcId };
  });

  const byIndex = new Map(); // original index -> grounded ingredient
  const missingIdx = [];
  const note = (g) =>
    log(`    → ${g.name}: ${g.fdcDescription} (FDC ${g.fdcId})${g.branded ? " · branded" : ""}`);

  try {
    const { grounded } = await groundViaEdge(sb, payload, prep);
    grounded.forEach((g, idx) => {
      g.role = recipe.ingredients[idx]?.role;
      byIndex.set(idx, g);
      note(g);
    });
  } catch (batchErr) {
    log(`  Batch grounding failed (${batchErr.message}). Grounding ingredient-by-ingredient…`);
    const settled = await Promise.allSettled(payload.map((p) => groundViaEdge(sb, [p], prep)));
    settled.forEach((res, idx) => {
      const g = res.status === "fulfilled" ? res.value.grounded?.[0] : null;
      if (g) {
        g.role = recipe.ingredients[idx]?.role;
        byIndex.set(idx, g);
        note(g);
      } else {
        missingIdx.push(idx);
      }
    });
    // Nothing matched at all: this isn't one exotic food, it's a real outage
    // (network / USDA down / bad key). Surface it rather than "estimating" the
    // whole dinner.
    if (byIndex.size === 0) throw batchErr;
  }

  // Estimate the genuinely-absent foods (flagged, not USDA).
  const estimatedNames = [];
  const unresolved = [];
  if (missingIdx.length) {
    onPhase?.("estimating");
    log(`  Not in USDA: ${missingIdx.map((i) => recipe.ingredients[i].name).join(", ")}. Estimating (flagged, not USDA)…`);
    let estimates = [];
    try {
      estimates = await estimateMacros(missingIdx.map((i) => recipe.ingredients[i]), prep);
    } catch (e) {
      log(`  Estimation call failed (${e.message}).`);
    }
    missingIdx.forEach((idx, k) => {
      const ing = recipe.ingredients[idx];
      const entry = estimatedEntry(ing, estimates[k]);
      if (entry) {
        byIndex.set(idx, entry);
        estimatedNames.push(ing.name);
        log(`    ~ ${ing.name}: ${entry.per100g.kcal} kcal/100g (estimated, not USDA)`);
      } else {
        unresolved.push(ing.name);
        log(`    ✗ ${ing.name}: couldn't estimate.`);
      }
    });
  }

  // Reassemble in the original ingredient order (resolved ones only).
  const grounded = [];
  for (let i = 0; i < recipe.ingredients.length; i++) {
    if (byIndex.has(i)) grounded.push(byIndex.get(i));
  }
  return { grounded, estimatedNames, unresolved };
}

// Ask the model for per-100g macros for foods USDA lacks at every tier. These
// are shown clearly labeled as estimates; this is the one place a macro number
// comes from the model, and only for foods USDA genuinely does not contain.
async function estimateMacros(ingredients, prep) {
  const system = `You estimate nutrition for foods that are NOT in USDA FoodData Central. For each food, give TYPICAL macros per 100 grams of the food in its ${prep} form, using well-established nutrition values. These will be shown to the user clearly labeled as estimates.
Respond ONLY with JSON, no prose, no backticks:
{"estimates":[{"name":"<echo the food name>","kcal":number,"protein":number,"fat":number,"carbs":number,"fiber":number}]}`;
  const user = `Foods (give macros per 100 g, ${prep} form):\n${ingredients.map((i) => `- ${i.name}`).join("\n")}`;
  const parsed = parseJSON(await callClaude(system, user));
  const arr = Array.isArray(parsed?.estimates) ? parsed.estimates : [];
  return ingredients.map((_, k) => arr[k]); // align by request order
}

// ── Recipes via the server (/api/recipes) ───────────────────────────────────
// The browser no longer touches Supabase directly; the server endpoint holds the
// DB key and is password-gated, so the public key can't be used to read/wipe the
// box from the bundle. The grounding edge function is still called directly (it's
// a stateless USDA utility with no DB access).
async function recipesApi(action, payload) {
  const r = await fetch("/api/recipes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-app-password": appPassword() },
    body: JSON.stringify({ action, ...payload }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || `Recipes request failed (${r.status})`);
  return d;
}

const saveRecipe = (record) => recipesApi("create", { record });
const loadRecipes = () => recipesApi("list", {});
const updateRecipe = (id, patch) => recipesApi("update", { id, patch });
const deleteRecipe = (id) => recipesApi("delete", { id });

// ─────────────────────────────────────────────────────────────────────────
//  UI
// ─────────────────────────────────────────────────────────────────────────
export default function App() {
  const sb = SB;
  const [targets, setTargets] = useState(DEFAULT_TARGETS);
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  const [prep, setPrep] = useState("raw"); // weigh ingredients raw (default) or cooked

  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("idle"); // drives the cooking-chef caption
  const [logLines, setLogLines] = useState([]);
  const [current, setCurrent] = useState(null);
  const [box, setBox] = useState([]);
  const [tab, setTab] = useState("make");
  const [err, setErr] = useState("");
  const logRef = useRef(null);

  // password gate
  const [unlocked, setUnlocked] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);

  const log = (line) => setLogLines((l) => [...l, line]);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  // On load, ask the server whether we're already in (valid saved password, or
  // no password configured at all). A 401 means a password is required.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/claude", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-app-password": appPassword() },
          body: JSON.stringify({ auth_check: true }),
        });
        if (r.ok) setUnlocked(true);
      } catch {
        /* leave locked; the lock screen will show */
      }
      setAuthChecking(false);
    })();
  }, []);

  const ready = Boolean(sb.url && sb.key);

  async function refreshBox() {
    try {
      setBox(await loadRecipes());
    } catch (e) {
      setErr(e.message);
    }
  }

  // Load the box as soon as we're in, so the Make tab's taste signal (and the
  // variety nudge) are ready on the very first generate, not only after the
  // user has visited The Box tab.
  useEffect(() => {
    if (unlocked) refreshBox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked]);

  async function run(opts = {}) {
    const { rerollNote = "", baseRecipe = null } = opts;
    setErr("");
    setLogLines([]);
    setCurrent(null);
    setBusy(true);
    setTab("make");
    try {
      const isReroll = Boolean(baseRecipe);

      // The box teaches the generator: liked -> lean toward, disliked -> steer
      // clear, recent -> don't repeat. A reroll is a targeted tweak of one dish,
      // so it carries no taste profile (we want to keep that dish, not vary it).
      const taste = isReroll ? EMPTY_TASTE : tasteProfile(box);

      // baseFeedback persists across swap rounds so the "keep this dish" intent
      // (or the change request) isn't lost when macro-miss feedback is appended.
      let baseFeedback = "";
      if (isReroll) {
        const ingList = (baseRecipe.ingredients || [])
          .map((i) => `${i.grams_cooked}g ${i.name}`)
          .join(", ");
        baseFeedback =
          `TWEAK this existing recipe. Keep it fundamentally the same dish — same main protein and overall character — do NOT replace it with a different meal.\n` +
          `Current recipe "${baseRecipe.title}": ${ingList}.\n` +
          (rerollNote
            ? `Change the user wants: "${rerollNote}". Make that change and otherwise keep the recipe as close to the original as possible.`
            : `Make a small improvement while keeping it the same dish.`);
      }
      // Rerolls keep the original recipe's prep; a fresh make uses the toggle.
      const activePrep = isReroll && baseRecipe.prep ? baseRecipe.prep : prep;
      let feedback = baseFeedback;
      let recipe = null;
      let grounded = null;
      let solved = null;
      let estimatedNames = []; // foods we fell back to a flagged estimate for
      // The last round that produced a full grounded set + a solve. We keep this
      // (not whatever the latest round left behind) so an unresolved swap attempt
      // can't strand a stale grounded/solved pair.
      let committed = null;

      // ── Generate -> ground -> SOLVE. Code owns the portions. We loop back to
      //    the model in two cases: the ingredient SET can't hit the targets at
      //    any portioning (swap for macros), or a food can't be grounded OR
      //    estimated (swap it for something findable). One missing food no longer
      //    sinks the whole recipe.
      for (let round = 1; round <= MAX_SWAP_ROUNDS; round++) {
        setPhase("generating");
        log(round === 1 ? `Generator…` : `Generator — swapping an ingredient (round ${round})…`);
        recipe = await generateRecipe(targets, prefs, feedback, taste, activePrep);
        setPhase("grounding");
        log(`Proposed: "${recipe.title}". Grounding in USDA…`);
        const ground = await groundAndEstimate(recipe, sb, log, activePrep, setPhase);

        // A food we couldn't match anywhere OR estimate: the set needs a swap.
        if (ground.unresolved.length) {
          log(`✗ Couldn't ground or estimate: ${ground.unresolved.join(", ")}. Asking for a swap…`);
          const swapMsg = `These ingredients couldn't be found in USDA (any dataset) or reliably estimated: ${ground.unresolved.join(
            ", "
          )}. Replace each with a common, widely available alternative that keeps the dish appealing. Do not just rename them.`;
          feedback = [baseFeedback, swapMsg].filter(Boolean).join("\n\n");
          if (round === MAX_SWAP_ROUNDS) log(`Reached swap cap with unresolved ingredients.`);
          continue;
        }
        if (ground.estimatedNames.length) log(`  Estimated (not USDA): ${ground.estimatedNames.join(", ")}.`);

        setPhase("solving");
        log(`Solving exact portions…`);
        const sol = solvePortions(ground.grounded, targets);
        for (const c of sol.changes) {
          if (c.from !== c.to) log(`    · ${c.name}: ${c.from}g → ${c.to}g`);
        }
        log(
          `Solved totals: ${sol.total.kcal.toFixed(0)} kcal · ${sol.total.protein.toFixed(
            1
          )}g P · ${sol.total.carbs.toFixed(1)}g C · ${sol.total.fiber.toFixed(1)}g fiber`
        );

        committed = { recipe, grounded: ground.grounded, solved: sol, estimatedNames: ground.estimatedNames };

        if (sol.withinTolerance) {
          log(`✓ Macros hit within tolerance.`);
          break;
        }
        log(`✗ This ingredient set can't hit target: ${sol.misses.join("; ")}`);
        const macroMiss = `Code adjusted the portions as far as it sensibly could and STILL could not hit the targets: ${sol.misses.join(
          "; "
        )}. The amounts are not the problem; the ingredient SET is. Swap in or add an ingredient that fixes this (e.g. a leaner/denser protein for a protein gap, beans or whole grains for a fiber gap) and keep the dish appetizing. Do not just change numbers.`;
        feedback = [baseFeedback, macroMiss].filter(Boolean).join("\n\n");
        if (round === MAX_SWAP_ROUNDS)
          log(`Reached swap cap — keeping the closest version (flagged below).`);
      }

      // Every round failed to even ground/estimate its ingredients. Surface it
      // cleanly rather than crashing on a null solve.
      if (!committed) {
        throw new Error(
          "Couldn't assemble a recipe whose ingredients resolve in USDA or as estimates after several tries. Try again, or adjust your preferences."
        );
      }
      recipe = committed.recipe;
      solved = committed.solved;
      estimatedNames = committed.estimatedNames;

      // Lock in the solved portions on the grounded ingredients.
      grounded = applyGrams(committed.grounded, solved.grams);
      let total = solved.total;

      // ── Palatability (blind). A taste fix re-grounds AND re-solves so the
      //    macros can't silently drift off target.
      let verdict = { passes: true, note: "" };
      for (let t = 1; t <= MAX_TASTE_ROUNDS; t++) {
        setPhase("tasting");
        log(`Palatability judge (blind) — round ${t}…`);
        verdict = await judgePalatability({ ...recipe, ingredients: grounded.map((g) => ({ name: g.name, grams: g.grams_cooked })) });
        if (verdict.passes) {
          log(`✓ Taste check passed. ${verdict.note || ""}`);
          break;
        }
        log(`✗ Taste check failed: ${verdict.note}`);
        if (t === MAX_TASTE_ROUNDS) {
          log(`Reached taste round cap — surfacing for your call.`);
          break;
        }
        setPhase("generating");
        const revised = await generateRecipe(
          targets,
          prefs,
          `A taste reviewer flagged this: "${verdict.note}". Fix the appeal problem. Amounts will be re-tuned automatically, so focus on the dish itself.`,
          // Keep variety so the fix isn't a near-dupe, but drop the like/dislike
          // lean here: the specific taste note is what should drive this revision.
          { liked: [], disliked: [], recent: taste.recent },
          activePrep
        );
        setPhase("grounding");
        log(`Revised for taste: "${revised.title}". Re-grounding and re-solving…`);
        const reg = await groundAndEstimate(revised, sb, log, activePrep, setPhase);
        if (reg.unresolved.length) {
          // The revision introduced something we can't ground or estimate. Don't
          // commit it; keep the version we already have and stop revising.
          log(`  Revision needs ${reg.unresolved.join(", ")}, which won't ground or estimate. Keeping the previous version.`);
          break;
        }
        recipe = revised;
        estimatedNames = reg.estimatedNames;
        setPhase("solving");
        solved = solvePortions(reg.grounded, targets);
        grounded = applyGrams(reg.grounded, solved.grams);
        total = solved.total;
        if (reg.estimatedNames.length) log(`  Estimated (not USDA): ${reg.estimatedNames.join(", ")}.`);
        if (!solved.withinTolerance) log(`  (note: ${solved.misses.join("; ")})`);
        log(
          `Re-solved: ${total.kcal.toFixed(0)} kcal · ${total.protein.toFixed(
            1
          )}g P · ${total.carbs.toFixed(1)}g C · ${total.fiber.toFixed(1)}g fiber`
        );
      }

      const onTarget = solved.withinTolerance;
      const result = {
        title: recipe.title,
        servings: 1,
        target_calories: targets.calories,
        target_protein_g: targets.protein_g,
        target_carbs_g: targets.carbs_g,
        target_fiber_g: targets.fiber_g,
        actual_calories: +total.kcal.toFixed(1),
        actual_protein_g: +total.protein.toFixed(1),
        actual_fat_g: +total.fat.toFixed(1),
        actual_carbs_g: +total.carbs.toFixed(1),
        actual_fiber_g: +total.fiber.toFixed(1),
        ingredients: grounded,
        steps: recipe.steps,
        palatability_passed: verdict.passes,
        palatability_note: verdict.note || null,
        on_target: onTarget,
        off_target_note: onTarget ? null : solved.misses.join("; "),
        prep: activePrep,
      };
      setPhase("done");
      setCurrent(result);
      const estNote = estimatedNames.length ? ` (estimated, not USDA: ${estimatedNames.join(", ")})` : "";
      log(onTarget ? `Done.${estNote}` : `Done, but macros are off (see above) — your call whether to keep.${estNote}`);
    } catch (e) {
      setPhase("error");
      setErr(e.message);
      log(`ERROR: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function keep() {
    setErr("");
    try {
      await saveRecipe(current);
      setCurrent(null);
      setTab("box");
      await refreshBox();
    } catch (e) {
      setErr(e.message);
    }
  }

  // Optimistic box edits: update local state immediately, persist, roll back on error.
  async function patchBoxRecipe(id, patch) {
    setErr("");
    const prev = box;
    setBox((b) => b.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    try {
      await updateRecipe(id, patch);
    } catch (e) {
      setBox(prev);
      setErr(e.message);
    }
  }

  async function removeBoxRecipe(id) {
    setErr("");
    const prev = box;
    setBox((b) => b.filter((r) => r.id !== id));
    try {
      await deleteRecipe(id);
    } catch (e) {
      setBox(prev);
      setErr(e.message);
    }
  }

  // Reroll: regenerate from a saved recipe with the user's change note. Produces
  // a fresh candidate on the Make tab (non-destructive; the original stays put).
  function rerollFromBox(recipe, note) {
    run({ rerollNote: note, baseRecipe: recipe });
  }

  // Build the macro fields a recipe row stores from a recomputed total + misses.
  function macroFields(total, misses) {
    return {
      actual_calories: +total.kcal.toFixed(1),
      actual_protein_g: +total.protein.toFixed(1),
      actual_fat_g: +total.fat.toFixed(1),
      actual_carbs_g: +total.carbs.toFixed(1),
      actual_fiber_g: +total.fiber.toFixed(1),
      on_target: misses.length === 0,
      off_target_note: misses.length ? misses.join("; ") : null,
    };
  }

  // Apply edited portions to the unsaved candidate (saved later via "Add to the box").
  function applyEditsToCurrent(ingredients, total, misses) {
    setCurrent((c) => (c ? { ...c, ingredients, ...macroFields(total, misses) } : c));
  }

  // Apply edited portions to a saved recipe (persist immediately).
  function saveEditsToBox(id, ingredients, total, misses) {
    return patchBoxRecipe(id, { ingredients, ...macroFields(total, misses) });
  }

  // ── styles ───────────────────────────────────────────────────────────────
  const css = `
    @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;1,9..144,400&family=Spline+Sans:wght@400;500;600&display=swap');
    * { box-sizing: border-box; }
    .rb { font-family:'Spline Sans',sans-serif; color:#2b2622; background:#f4ede1;
      min-height:100vh; padding:28px; line-height:1.5; }
    .rb h1,.rb h2,.rb h3,.rb .disp { font-family:'Fraunces',serif; }
    .wrap { max-width:880px; margin:0 auto; }
    .masthead { border-bottom:3px solid #2b2622; padding-bottom:14px; margin-bottom:24px; }
    .masthead h1 { font-size:42px; font-weight:600; margin:0; letter-spacing:-0.5px; }
    .masthead .sub { font-style:italic; color:#8a7a5c; margin-top:2px; }
    .tabs { display:flex; gap:6px; margin-bottom:20px; }
    .tab { font-family:'Spline Sans'; font-size:14px; font-weight:600; padding:8px 16px;
      border:1.5px solid #2b2622; background:#f4ede1; cursor:pointer; border-radius:2px; }
    .tab.on { background:#2b2622; color:#f4ede1; }
    .card { background:#fffdf8; border:1.5px solid #d8c9ad; border-radius:4px;
      padding:20px; margin-bottom:16px; box-shadow:3px 3px 0 #e3d6bd; }
    .row { display:flex; gap:12px; flex-wrap:wrap; }
    .field { flex:1; min-width:120px; margin-bottom:12px; }
    .field label { display:block; font-size:11px; text-transform:uppercase; letter-spacing:0.8px;
      color:#8a7a5c; font-weight:600; margin-bottom:4px; }
    .field input, .field textarea { width:100%; padding:8px 10px; border:1.5px solid #d8c9ad;
      border-radius:3px; font-family:'Spline Sans'; font-size:14px; background:#fff; }
    .btn { font-family:'Spline Sans'; font-weight:600; font-size:15px; padding:11px 22px;
      border:none; border-radius:3px; background:#9c3d2e; color:#fff; cursor:pointer; }
    .btn:disabled { background:#c4b8a3; cursor:not-allowed; }
    .btn.ghost { background:#f4ede1; color:#2b2622; border:1.5px solid #2b2622; }
    .macros { display:flex; gap:18px; flex-wrap:wrap; margin:14px 0; }
    .macro { text-align:center; }
    .macro .v { font-family:'Fraunces'; font-size:26px; font-weight:600; }
    .macro .l { font-size:10px; text-transform:uppercase; letter-spacing:1px; color:#8a7a5c; }
    .ing { padding:6px 0; border-bottom:1px dotted #d8c9ad; font-size:14px; display:flex; justify-content:space-between; }
    .ing .src { color:#8a7a5c; font-size:11px; font-style:italic; }
    .log { background:#2b2622; color:#cde3b4; font-family:ui-monospace,monospace; font-size:12px;
      padding:14px; border-radius:4px; height:180px; overflow-y:auto; white-space:pre-wrap; }
    .pill { display:inline-block; font-size:11px; font-weight:600; padding:3px 9px; border-radius:99px; }
    .pill.ok { background:#dcecd0; color:#3a5a28; }
    .pill.warn { background:#f3e2c2; color:#8a5a14; }
    .err { background:#f7dcd7; color:#9c3d2e; padding:10px 14px; border-radius:4px; margin-bottom:14px; font-size:14px; }
    .step { margin:8px 0; padding-left:26px; position:relative; font-size:14px; }
    .step .n { position:absolute; left:0; font-family:'Fraunces'; font-weight:600; color:#9c3d2e; }
    .note { font-style:italic; color:#8a7a5c; font-size:13px; margin-top:8px; }
    .bd { width:100%; border-collapse:collapse; font-size:12.5px; font-variant-numeric:tabular-nums; }
    .bd th, .bd td { padding:5px 8px; text-align:right; border-bottom:1px solid #ece2cd; white-space:nowrap; }
    .bd th { font-size:10px; text-transform:uppercase; letter-spacing:0.6px; color:#8a7a5c; font-weight:600; }
    .bd tbody tr:nth-child(odd) td { background:#fbf6ec; }
    .bd .bd-total td { font-weight:600; border-top:1.5px solid #2b2622; background:#f4ede1 !important; }
    .pill.status-liked { background:#dcecd0; color:#3a5a28; }
    .pill.status-disliked { background:#f7dcd7; color:#9c3d2e; }
    .pill.status-untried { background:#ece2cd; color:#8a7a5c; }
    .chip { font-family:'Spline Sans'; font-size:12px; font-weight:600; padding:5px 11px; border-radius:99px;
      border:1.5px solid #d8c9ad; background:#fffdf8; color:#8a7a5c; cursor:pointer; }
    .chip:hover { border-color:#2b2622; }
    .chip-on { background:#2b2622; color:#f4ede1; border-color:#2b2622; }
    .field select { width:100%; padding:8px 10px; border:1.5px solid #d8c9ad; border-radius:3px;
      font-family:'Spline Sans'; font-size:14px; background:#fff; }
    /* Cooking chef — the generation animation. Pure SVG/CSS, themed to the box. */
    .chef-wrap { display:flex; flex-direction:column; align-items:center; gap:8px; padding:6px 0 14px; }
    .chef { width:180px; height:auto; display:block; }
    .chef-cap { font-family:'Fraunces',serif; font-style:italic; color:#8a7a5c; font-size:15px; min-height:1.3em; text-align:center; }
    .chef-bob { animation: chefBob 2.6s ease-in-out infinite; }
    .chef .steam { animation: steamRise 2.8s ease-in-out infinite; }
    .chef .steam-b { animation-delay:0.7s; }
    .chef .steam-c { animation-delay:1.4s; }
    .chef .stir { transform-box: view-box; transform-origin: 110px 116px; animation: stir 1.9s ease-in-out infinite; }
    .chef .sauce { animation: sauceWobble 1.9s ease-in-out infinite; }
    @keyframes chefBob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
    @keyframes steamRise { 0% { opacity:0; transform: translateY(8px); } 35% { opacity:0.6; } 100% { opacity:0; transform: translateY(-14px); } }
    @keyframes stir { 0%,100% { transform: rotate(-13deg); } 50% { transform: rotate(13deg); } }
    @keyframes sauceWobble { 0%,100% { transform: translateX(-1.5px); } 50% { transform: translateX(1.5px); } }
    @media (prefers-reduced-motion: reduce) {
      .chef-bob, .chef .steam, .chef .stir, .chef .sauce { animation: none; }
    }
  `;

  return (
    <div className="rb">
      <style>{css}</style>
      <div className="wrap">
        <div className="masthead">
          <h1>Charlie's Recipe Box</h1>
          <div className="sub">Precise to the gram. Checked for joy.</div>
        </div>

        {authChecking ? (
          <div className="card">Checking…</div>
        ) : !unlocked ? (
          <LockCard onUnlock={() => setUnlocked(true)} />
        ) : (
          <>
            <div className="tabs">
              {["make", "box"].map((t) => (
                <button key={t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => { setTab(t); if (t === "box") refreshBox(); }}>
                  {t === "make" ? "Make a recipe" : "The box"}
                </button>
              ))}
            </div>

            {err && <div className="err">{err}</div>}

            {tab === "make" && (
              <>
                <div className="card">
                  <h3 style={{ marginTop: 0 }}>Tonight's targets</h3>
                  <div className="row">
                    {[
                      ["calories", "Calories"],
                      ["protein_g", "Protein (g)"],
                      ["carbs_g", "Carbs (g)"],
                      ["fiber_g", "Fiber (g)"],
                    ].map(([k, label]) => (
                      <div className="field" key={k}>
                        <label>{label}</label>
                        <input
                          type="number"
                          value={targets[k]}
                          onChange={(e) => setTargets({ ...targets, [k]: +e.target.value })}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="field">
                    <label>Preferences</label>
                    <textarea rows={2} value={prefs} onChange={(e) => setPrefs(e.target.value)} />
                  </div>
                  <div className="field" style={{ flex: "none" }}>
                    <label>Weigh ingredients</label>
                    <div style={{ display: "flex", gap: 6 }}>
                      {["raw", "cooked"].map((p) => (
                        <button
                          key={p}
                          type="button"
                          className={`chip ${prep === p ? "chip-on" : ""}`}
                          onClick={() => setPrep(p)}
                        >
                          {p === "raw" ? "Raw" : "Cooked"}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button className="btn" disabled={!ready || busy} onClick={() => run()}>
                    {busy ? "Cooking up something…" : ready ? "Generate recipe" : "Supabase not configured"}
                  </button>
                  <TasteHint box={box} />
                </div>

                {(busy || logLines.length > 0) && (
                  <div className="card">
                    <h3 style={{ marginTop: 0 }}>Kitchen pass</h3>
                    {busy && <CookingChef phase={phase} />}
                    {logLines.length > 0 && (
                      <div className="log" ref={logRef}>{logLines.join("\n")}</div>
                    )}
                  </div>
                )}

                {current && (
                  <RecipeCard
                    r={current}
                    onKeep={keep}
                    keepLabel="Add to the box"
                    onApplyEdits={(ings, total, misses) => applyEditsToCurrent(ings, total, misses)}
                    applyEditsLabel="Use these amounts"
                  />
                )}
              </>
            )}

            {tab === "box" && (
              <BoxTab
                box={box}
                onSetStatus={(id, status) => patchBoxRecipe(id, { status })}
                onSetTags={(id, tags) => patchBoxRecipe(id, { tags })}
                onDelete={removeBoxRecipe}
                onReroll={rerollFromBox}
                onSaveEdits={saveEditsToBox}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// A small line under the Generate button so the taste-learning is legible: it
// tells Charlie the box is actually steering what gets made, not just archiving.
function TasteHint({ box }) {
  const liked = box.filter((r) => (r.status || "untried") === "liked").length;
  const disliked = box.filter((r) => (r.status || "untried") === "disliked").length;
  if (!liked && !disliked) return null;
  const parts = [];
  if (liked) parts.push(`leaning on ${liked} you liked`);
  if (disliked) parts.push(`steering clear of ${disliked} you didn't`);
  return (
    <div className="note" style={{ marginTop: 10 }}>
      Learning from your box: {parts.join(" and ")}.
    </div>
  );
}

// The cooking chef shown while the kitchen runs. Hand-built SVG + CSS (see the
// .chef styles): no image asset, themed to the box's palette, and it honors
// prefers-reduced-motion. The caption tracks the real pipeline phase, so the
// animation is wired to the actual work rather than being a generic spinner.
const CHEF_CAPTIONS = {
  idle: "Warming the stove…",
  generating: "Dreaming up a dish…",
  grounding: "Weighing it against USDA…",
  estimating: "Looking up an off-menu ingredient…",
  solving: "Solving the exact grams…",
  tasting: "Giving it a taste…",
  done: "Plating up…",
  error: "Something boiled over.",
};

function CookingChef({ phase }) {
  const caption = CHEF_CAPTIONS[phase] || CHEF_CAPTIONS.idle;
  return (
    <div className="chef-wrap">
      <svg className="chef" viewBox="0 0 220 180" role="img" aria-label="A chef stirring a pot">
        <g className="chef-bob">
          {/* apron/chest, mostly hidden behind the pot */}
          <rect x="86" y="78" width="48" height="62" rx="14" fill="#9c3d2e" stroke="#2b2622" strokeWidth="2.5" />
          {/* toque */}
          <circle cx="96" cy="34" r="13" fill="#fffdf8" stroke="#2b2622" strokeWidth="2.5" />
          <circle cx="124" cy="34" r="13" fill="#fffdf8" stroke="#2b2622" strokeWidth="2.5" />
          <circle cx="110" cy="26" r="15" fill="#fffdf8" stroke="#2b2622" strokeWidth="2.5" />
          <rect x="90" y="40" width="40" height="14" rx="4" fill="#fffdf8" stroke="#2b2622" strokeWidth="2.5" />
          {/* head + face */}
          <circle cx="110" cy="64" r="20" fill="#f3d7b0" stroke="#2b2622" strokeWidth="2.5" />
          <circle cx="103" cy="62" r="2.2" fill="#2b2622" />
          <circle cx="117" cy="62" r="2.2" fill="#2b2622" />
          <path d="M103 72 Q110 78 117 72" fill="none" stroke="#2b2622" strokeWidth="2" strokeLinecap="round" />
          <circle cx="99" cy="70" r="2.6" fill="#d98a6a" opacity="0.5" />
          <circle cx="121" cy="70" r="2.6" fill="#d98a6a" opacity="0.5" />
          {/* steam (drawn before the pot so it appears to rise out of it) */}
          <g fill="none" stroke="#cbb89a" strokeWidth="3.2" strokeLinecap="round">
            <path className="steam steam-a" d="M92 116 q-5 -8 0 -16 q5 -8 0 -16" />
            <path className="steam steam-b" d="M110 116 q-5 -9 0 -18 q5 -9 0 -18" />
            <path className="steam steam-c" d="M128 116 q-5 -8 0 -16 q5 -8 0 -16" />
          </g>
          {/* stirring spoon (rotates around the rim) */}
          <g className="stir">
            <line x1="110" y1="116" x2="142" y2="86" stroke="#7a4a22" strokeWidth="5" strokeLinecap="round" />
            <circle cx="143" cy="85" r="6" fill="#f3d7b0" stroke="#2b2622" strokeWidth="2.5" />
          </g>
          {/* pot, in front */}
          <path d="M64 118 L156 118 L150 150 Q149 157 142 157 L78 157 Q71 157 70 150 Z" fill="#2b2622" />
          <ellipse cx="110" cy="118" rx="48" ry="9" fill="#3a322b" stroke="#2b2622" strokeWidth="2" />
          <ellipse className="sauce" cx="110" cy="117" rx="39" ry="6" fill="#c8643f" />
          <path d="M62 124 q-9 2 -9 10" fill="none" stroke="#2b2622" strokeWidth="3.5" strokeLinecap="round" />
          <path d="M158 124 q9 2 9 10" fill="none" stroke="#2b2622" strokeWidth="3.5" strokeLinecap="round" />
        </g>
      </svg>
      <div className="chef-cap">{caption}</div>
    </div>
  );
}

function LockCard({ onUnlock }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const r = await fetch("/api/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-app-password": pw },
        body: JSON.stringify({ auth_check: true }),
      });
      if (r.ok) {
        sessionStorage.setItem("rb_pw", pw);
        onUnlock();
      } else {
        setErr("That password didn't work.");
      }
    } catch {
      setErr("Couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit} style={{ maxWidth: 380 }}>
      <h3 style={{ marginTop: 0 }}>This box is locked</h3>
      <p style={{ fontSize: 13, color: "#8a7a5c" }}>Enter the password to come in.</p>
      {err && <div className="err">{err}</div>}
      <div className="field">
        <label>Password</label>
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
      </div>
      <button className="btn" type="submit" disabled={busy || !pw}>
        {busy ? "Checking…" : "Unlock"}
      </button>
    </form>
  );
}

const STATUSES = [
  { key: "untried", label: "Haven't tried" },
  { key: "liked", label: "Liked" },
  { key: "disliked", label: "Disliked" },
];
const statusLabel = (s) => (STATUSES.find((x) => x.key === s) || STATUSES[0]).label;

function BoxTab({ box, onSetStatus, onSetTags, onDelete, onReroll, onSaveEdits }) {
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");

  const allTags = Array.from(
    new Set(box.flatMap((r) => r.tags || []))
  ).sort();

  const needle = q.trim().toLowerCase();
  const filtered = box.filter((r) => {
    if (statusFilter !== "all" && (r.status || "untried") !== statusFilter) return false;
    if (tagFilter !== "all" && !(r.tags || []).includes(tagFilter)) return false;
    if (needle) {
      const hay = [
        r.title,
        ...(r.ingredients || []).map((i) => i.name),
        ...(r.tags || []),
      ].join(" ").toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  if (box.length === 0) return <div className="card">No recipes yet. Go make one.</div>;

  return (
    <>
      <div className="card" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="field" style={{ marginBottom: 0, flex: 2 }}>
          <label>Search</label>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="title, ingredient, or tag" />
        </div>
        <div className="field" style={{ marginBottom: 0, flex: 1 }}>
          <label>Status</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All</option>
            {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>
        {allTags.length > 0 && (
          <div className="field" style={{ marginBottom: 0, flex: 1 }}>
            <label>Tag</label>
            <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
              <option value="all">All</option>
              {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        )}
      </div>

      {filtered.length === 0 && <div className="card">Nothing matches that filter.</div>}
      {filtered.map((r) => (
        <RecipeCard
          key={r.id}
          r={r}
          onSetStatus={onSetStatus}
          onSetTags={onSetTags}
          onDelete={onDelete}
          onReroll={onReroll}
          onApplyEdits={(ings, total, misses) => onSaveEdits(r.id, ings, total, misses)}
          applyEditsLabel="Save changes"
        />
      ))}
    </>
  );
}

function RecipeCard({ r, onKeep, keepLabel, onSetStatus, onSetTags, onDelete, onReroll, onApplyEdits, applyEditsLabel }) {
  const isBoxed = Boolean(onSetStatus || onDelete || onReroll);
  const fiber = r.actual_fiber_g;
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [showReroll, setShowReroll] = useState(false);
  const [rerollNote, setRerollNote] = useState("");
  const [tagInput, setTagInput] = useState("");
  const ings = r.ingredients || [];
  const hasContrib = ings.some((i) => i.contributes);
  const canEdit = Boolean(onApplyEdits) && ings.some((i) => i.per100g) && r.target_calories != null;
  const status = r.status || "untried";
  const estimatedIngs = ings.filter((i) => i.estimated);
  const hasEstimates = estimatedIngs.length > 0;

  function addTag() {
    const t = tagInput.trim().toLowerCase();
    if (!t) return;
    const next = Array.from(new Set([...(r.tags || []), t]));
    onSetTags(r.id, next);
    setTagInput("");
  }
  function removeTag(t) {
    onSetTags(r.id, (r.tags || []).filter((x) => x !== t));
  }

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <h2 style={{ margin: "0 0 4px" }}>{r.title}</h2>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          {isBoxed && (
            <span className={`pill status-${status}`}>{statusLabel(status)}</span>
          )}
          {r.on_target === false && <span className="pill warn">macros off</span>}
          {hasEstimates && <span className="pill warn">estimated</span>}
          <span className={`pill ${r.palatability_passed ? "ok" : "warn"}`}>
            {r.palatability_passed ? "taste ✓" : "needs a look"}
          </span>
        </div>
      </div>
      {r.on_target === false && r.off_target_note && (
        <div className="note" style={{ color: "#9c3d2e" }}>Macros off target: {r.off_target_note}</div>
      )}
      {hasEstimates && (
        <div className="note" style={{ color: "#8a5a14" }}>
          Estimated (not USDA): {estimatedIngs.map((i) => i.name).join(", ")}. These macros are approximate.
        </div>
      )}

      <div className="macros">
        <div className="macro"><div className="v">{Math.round(r.actual_calories)}</div><div className="l">kcal</div></div>
        <div className="macro"><div className="v">{r.actual_protein_g}</div><div className="l">protein</div></div>
        <div className="macro"><div className="v">{r.actual_fat_g}</div><div className="l">fat</div></div>
        <div className="macro"><div className="v">{r.actual_carbs_g}</div><div className="l">carbs</div></div>
        {fiber != null && <div className="macro"><div className="v">{fiber}</div><div className="l">fiber</div></div>}
      </div>

      <h3 style={{ marginBottom: 2 }}>Ingredients</h3>
      <div className="note" style={{ marginTop: 0, marginBottom: 6 }}>
        Weights are {r.prep === "raw" ? "raw (weighed uncooked)" : "cooked"}.
      </div>
      {ings.map((i, n) => (
        <div className="ing" key={n}>
          <span>{i.grams_cooked}g {i.name}</span>
          <span className="src">
            {i.estimated ? "estimated · not in USDA" : `${i.fdcDescription} · FDC ${i.fdcId}`}
          </span>
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
        {hasContrib && (
          <button className="btn ghost" style={{ padding: "6px 12px", fontSize: 13 }} onClick={() => setShowBreakdown((v) => !v)}>
            {showBreakdown ? "Hide macro breakdown" : "Show macro breakdown"}
          </button>
        )}
        {canEdit && (
          <button className="btn ghost" style={{ padding: "6px 12px", fontSize: 13 }} onClick={() => setShowEditor((v) => !v)}>
            {showEditor ? "Done adjusting" : "Adjust portions"}
          </button>
        )}
      </div>
      {hasContrib && showBreakdown && <MacroBreakdown ings={ings} r={r} />}
      {canEdit && showEditor && (
        <PortionEditor
          ings={ings}
          targets={{
            calories: r.target_calories,
            protein_g: r.target_protein_g,
            carbs_g: r.target_carbs_g,
            fiber_g: r.target_fiber_g,
          }}
          applyLabel={applyEditsLabel || "Use these amounts"}
          onApply={(newIngs, total, misses) => { onApplyEdits(newIngs, total, misses); setShowEditor(false); }}
        />
      )}

      <h3 style={{ marginBottom: 6, marginTop: 16 }}>Method</h3>
      {(r.steps || []).map((s, n) => (
        <div className="step" key={n}><span className="n">{n + 1}</span>{s}</div>
      ))}

      {r.palatability_note && <div className="note">Taste note: {r.palatability_note}</div>}

      {onKeep && (
        <div style={{ marginTop: 16 }}>
          <button className="btn" onClick={onKeep}>{keepLabel}</button>
        </div>
      )}

      {isBoxed && (
        <div style={{ marginTop: 16, borderTop: "1px solid #ece2cd", paddingTop: 14 }}>
          {/* Status */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.8px", color: "#8a7a5c", fontWeight: 600, marginRight: 4 }}>Status</span>
            {STATUSES.map((s) => (
              <button
                key={s.key}
                className={`chip ${status === s.key ? "chip-on" : ""}`}
                onClick={() => onSetStatus(r.id, s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>

          {/* Tags */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.8px", color: "#8a7a5c", fontWeight: 600, marginRight: 4 }}>Tags</span>
            {(r.tags || []).map((t) => (
              <span key={t} className="chip chip-on" onClick={() => removeTag(t)} title="Remove tag" style={{ cursor: "pointer" }}>
                {t} ✕
              </span>
            ))}
            <input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
              placeholder="add tag"
              style={{ border: "1.5px solid #d8c9ad", borderRadius: 3, padding: "4px 8px", fontFamily: "'Spline Sans'", fontSize: 13, width: 110 }}
            />
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn ghost" style={{ padding: "8px 14px", fontSize: 13 }} onClick={() => setShowReroll((v) => !v)}>
              {showReroll ? "Cancel reroll" : "Ask for a reroll"}
            </button>
            <button
              className="btn ghost"
              style={{ padding: "8px 14px", fontSize: 13, borderColor: "#9c3d2e", color: "#9c3d2e" }}
              onClick={() => { if (confirm(`Delete "${r.title}"? This can't be undone.`)) onDelete(r.id); }}
            >
              Delete
            </button>
          </div>

          {showReroll && (
            <div style={{ marginTop: 12 }}>
              <div className="field" style={{ marginBottom: 8 }}>
                <label>What should change?</label>
                <textarea
                  rows={2}
                  value={rerollNote}
                  onChange={(e) => setRerollNote(e.target.value)}
                  placeholder='e.g. "too many sides, pick one veg" or "make it spicier"'
                />
              </div>
              <button
                className="btn"
                disabled={!rerollNote.trim()}
                onClick={() => { onReroll(r, rerollNote.trim()); setShowReroll(false); setRerollNote(""); }}
              >
                Reroll this recipe
              </button>
              <div className="note" style={{ marginTop: 6 }}>Creates a new recipe on the Make tab. The original stays here.</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Per-ingredient macro contributions + a totals row, for spot-checking accuracy.
// `contributes` comes straight from grounding (recomputed by the solver after
// portioning), so this is the authoritative per-ingredient math, not a re-estimate.
// Live portion editor: change a gram weight and watch the macros update instantly
// (pure per-100g math, no API call). "Rebalance the rest" holds the ingredients
// you've edited and solves the others to the targets, the precision engine again,
// just with some ingredients pinned.
function PortionEditor({ ings, targets, applyLabel, onApply }) {
  const orig = ings.map((i) => Math.round(i.grams_cooked || 0));
  const [grams, setGrams] = useState(orig);
  const [held, setHeld] = useState(() => new Set()); // indices the user pinned

  const total = totalsFromGrams(ings, grams);
  const within = {
    calories: Math.abs(total.kcal - targets.calories) <= TOL.calories,
    protein_g: Math.abs(total.protein - targets.protein_g) <= TOL.protein_g,
    carbs_g: Math.abs(total.carbs - targets.carbs_g) <= TOL.carbs_g,
    fiber_g: total.fiber >= targets.fiber_g - TOL.fiber_g,
  };

  function setGram(i, val) {
    const n = Math.max(0, Math.round(+val || 0));
    setGrams((g) => g.map((x, j) => (j === i ? n : x)));
    setHeld((h) => new Set(h).add(i)); // editing pins it
  }
  function rebalance() {
    const seeded = applyGrams(ings, grams); // bounds/locks read current grams
    const solved = solvePortions(seeded, targets, { locked: [...held] });
    setGrams(solved.grams);
  }
  function reset() {
    setGrams(orig);
    setHeld(new Set());
  }
  function apply() {
    const newIngs = applyGrams(ings, grams);
    const t = totalsFromGrams(ings, grams);
    onApply(newIngs, t, offTarget(t, targets));
  }

  const stat = (ok) => ({ color: ok ? "#3a5a28" : "#9c3d2e", fontWeight: 600 });

  return (
    <div className="card" style={{ background: "#f4ede1", marginTop: 12 }}>
      <h3 style={{ marginTop: 0, marginBottom: 4 }}>Adjust portions</h3>
      <p className="note" style={{ marginTop: 0 }}>
        Edit a weight to see macros update live. Edited ingredients are held; "Rebalance
        the rest" solves the others to your targets.
      </p>

      {ings.map((i, n) => (
        <div key={n} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
          <input
            type="number"
            min="0"
            value={grams[n]}
            onChange={(e) => setGram(n, e.target.value)}
            style={{ width: 72, padding: "5px 8px", border: "1.5px solid #d8c9ad", borderRadius: 3, fontFamily: "'Spline Sans'", fontSize: 14, background: "#fff" }}
          />
          <span style={{ fontSize: 11, color: "#8a7a5c" }}>g</span>
          <span style={{ flex: 1, fontSize: 14 }}>{i.name}</span>
          {held.has(n) && <span className="pill" style={{ background: "#2b2622", color: "#f4ede1" }}>held</span>}
        </div>
      ))}

      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", margin: "14px 0 4px", fontSize: 13 }}>
        <span style={stat(within.calories)}>{Math.round(total.kcal)} kcal <span style={{ color: "#8a7a5c", fontWeight: 400 }}>/ {targets.calories}</span></span>
        <span style={stat(within.protein_g)}>{total.protein.toFixed(1)}g P <span style={{ color: "#8a7a5c", fontWeight: 400 }}>/ {targets.protein_g}</span></span>
        <span style={stat(within.carbs_g)}>{total.carbs.toFixed(1)}g C <span style={{ color: "#8a7a5c", fontWeight: 400 }}>/ {targets.carbs_g}</span></span>
        <span style={stat(within.fiber_g)}>{total.fiber.toFixed(1)}g fiber <span style={{ color: "#8a7a5c", fontWeight: 400 }}>/ {targets.fiber_g}</span></span>
        <span style={{ color: "#8a7a5c" }}>{total.fat.toFixed(1)}g fat</span>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
        <button className="btn" style={{ padding: "8px 14px", fontSize: 13 }} onClick={rebalance}>Rebalance the rest to targets</button>
        <button className="btn ghost" style={{ padding: "8px 14px", fontSize: 13 }} onClick={apply}>{applyLabel}</button>
        <button className="btn ghost" style={{ padding: "8px 14px", fontSize: 13 }} onClick={reset}>Reset</button>
      </div>
    </div>
  );
}

function MacroBreakdown({ ings, r }) {
  const n1 = (x) => (x == null ? "—" : (Math.round(x * 10) / 10).toString());
  const sum = (k) => ings.reduce((s, i) => s + (i.contributes?.[k] || 0), 0);
  const cols = [
    ["kcal", "kcal"],
    ["protein", "protein"],
    ["fat", "fat"],
    ["carbs", "carbs"],
    ["fiber", "fiber"],
  ];
  return (
    <div style={{ overflowX: "auto", marginTop: 10 }}>
      <table className="bd">
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>ingredient</th>
            <th>g</th>
            {cols.map(([, label]) => <th key={label}>{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {ings.map((i, idx) => (
            <tr key={idx}>
              <td style={{ textAlign: "left" }}>{i.name}</td>
              <td>{i.grams_cooked}</td>
              {cols.map(([k]) => <td key={k}>{n1(i.contributes?.[k])}</td>)}
            </tr>
          ))}
          <tr className="bd-total">
            <td style={{ textAlign: "left" }}>total (sum)</td>
            <td>{ings.reduce((s, i) => s + (i.grams_cooked || 0), 0)}</td>
            {cols.map(([k]) => <td key={k}>{n1(sum(k))}</td>)}
          </tr>
          <tr className="bd-total">
            <td style={{ textAlign: "left" }}>saved totals</td>
            <td>—</td>
            <td>{n1(r.actual_calories)}</td>
            <td>{n1(r.actual_protein_g)}</td>
            <td>{n1(r.actual_fat_g)}</td>
            <td>{n1(r.actual_carbs_g)}</td>
            <td>{n1(r.actual_fiber_g)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
