import React, { useState, useEffect, useRef } from "react";

// ─────────────────────────────────────────────────────────────────────────
//  Charlie's Recipe Box
//  Macro-precise recipes, grounded in USDA FoodData Central, taste-checked
//  by a blind palatability judge. Saved to Supabase.
//
//  Pipeline per request:
//    1. Generator    -> proposes recipe w/ USDA query + match term + cooked grams
//    2. Grounding    -> code queries USDA, validates the match, computes macros
//    3. Reconcile    -> off-target? loop back to Generator w/ real shortfall
//    4. Palatability -> blind judge (no macros) approves or kicks back
//    5. Re-ground    -> recompute after any taste edit; macros can't silently drift
//    6. Save         -> Supabase
//
//  The Generator and judge run through /api/claude, a server-side proxy that
//  holds the Anthropic key and enforces the app password. Neither reaches the
//  browser.
// ─────────────────────────────────────────────────────────────────────────

const MAX_MACRO_ROUNDS = 4;
const MAX_TASTE_ROUNDS = 3;

// macro tolerances (per serving)
const TOL = { calories: 25, protein_g: 4, carbs_g: 8, fiber_g: 2 };

const DEFAULT_TARGETS = {
  calories: 535,
  protein_g: 45, // midpoint of 40-50
  carbs_g: 42,   // midpoint of 30-55
  fiber_g: 7,    // midpoint of 5-10
};

const DEFAULT_PREFS =
  "Loves umami flavors. Skinless boneless chicken breast is a workhorse protein. No hard dislikes or allergies. Avoid burying a dish in any single garnish to hit a number, balance is the point.";

// Public client defaults; can be overridden by env vars or the Setup tab.
const ENV_SB_URL = import.meta.env.VITE_SUPABASE_URL || "https://nwgxyytowbluuykbdcfc.supabase.co";
const ENV_SB_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

const appPassword = () =>
  (typeof sessionStorage !== "undefined" && sessionStorage.getItem("rb_pw")) || "";

// ── USDA grounding via Supabase edge function (server-side, no CORS/sandbox issue) ──
async function groundViaEdge(sb, ingredients) {
  const r = await fetch(`${sb.url}/functions/v1/usda-ground`, {
    method: "POST",
    headers: {
      apikey: sb.key,
      Authorization: `Bearer ${sb.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ingredients }),
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
  return JSON.parse(clean);
}

// ── Generator agent ────────────────────────────────────────────────────────
async function generateRecipe(targets, prefs, feedback) {
  const system = `You design dinner recipes for ONE serving that hit precise macro targets.

HARD RULES:
- For every ingredient, give a COOKED gram weight (cooked, not raw).
- For every ingredient, propose a USDA FoodData Central search phrase that will match a COOKED entry (e.g. "chicken breast meat only cooked roasted", "broccoli cooked boiled", "brown rice cooked"). Prefer cooked/roasted/boiled forms.
- For every ingredient, also give "match": the identifying food word(s) the correct USDA entry MUST contain. Use the distinctive food noun, not preparation words. Examples: "shelled edamame, cooked" -> "edamame"; "low-sodium soy sauce" -> "soy sauce"; "brown rice, cooked" -> "brown rice". Be specific for proteins, grains, and produce; a general word is fine for a minor seasoning (e.g. "vinegar").
- Do NOT use an absurd quantity of any single ingredient to hit a number. No garnish mountains.
- Real, appealing, balanced food a person would actually want to eat.

Respond ONLY with JSON, no prose, no backticks:
{
  "title": "string",
  "ingredients": [
    {"name":"display name","usdaQuery":"search phrase for a cooked entry","match":"identifying food word(s) that must appear in the USDA entry","grams":number}
  ],
  "steps": ["step 1","step 2"]
}`;

  const user = `Targets (per serving): ${targets.calories} kcal, ${targets.protein_g}g protein, ${targets.carbs_g}g carbs, ${targets.fiber_g}g fiber.
Preferences: ${prefs}
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
async function groundRecipe(recipe, sb, log) {
  log(`  Sending ${recipe.ingredients.length} ingredients to USDA grounding…`);
  const { grounded, total } = await groundViaEdge(
    sb,
    recipe.ingredients.map((i) => ({ name: i.name, usdaQuery: i.usdaQuery, grams: i.grams, match: i.match }))
  );
  for (const g of grounded) log(`    → ${g.name}: ${g.fdcDescription} (FDC ${g.fdcId})`);
  return { grounded, total };
}

function offTarget(total, targets) {
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

// ── Supabase (REST) ────────────────────────────────────────────────────────
async function saveRecipe(sb, record) {
  const r = await fetch(`${sb.url}/rest/v1/recipes`, {
    method: "POST",
    headers: {
      apikey: sb.key,
      Authorization: `Bearer ${sb.key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(record),
  });
  if (!r.ok) throw new Error(`Supabase save failed (${r.status}): ${await r.text()}`);
  return (await r.json())[0];
}

async function loadRecipes(sb) {
  const r = await fetch(
    `${sb.url}/rest/v1/recipes?select=*&order=created_at.desc`,
    { headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}` } }
  );
  if (!r.ok) throw new Error(`Supabase load failed (${r.status})`);
  return r.json();
}

// ─────────────────────────────────────────────────────────────────────────
//  UI
// ─────────────────────────────────────────────────────────────────────────
export default function App() {
  const [sbUrl, setSbUrl] = useState(ENV_SB_URL);
  const [sbKey, setSbKey] = useState(ENV_SB_KEY);
  const [targets, setTargets] = useState(DEFAULT_TARGETS);
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);

  const [busy, setBusy] = useState(false);
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

  const sb = { url: sbUrl.replace(/\/$/, ""), key: sbKey };
  const ready = sbUrl && sbKey;

  async function refreshBox() {
    try {
      setBox(await loadRecipes(sb));
    } catch (e) {
      setErr(e.message);
    }
  }

  async function run() {
    setErr("");
    setLogLines([]);
    setCurrent(null);
    setBusy(true);
    try {
      let feedback = "";
      let recipe = null;
      let grounded = null;
      let total = null;

      // macro reconciliation loop
      for (let round = 1; round <= MAX_MACRO_ROUNDS; round++) {
        log(`Generator — round ${round}…`);
        recipe = await generateRecipe(targets, prefs, feedback);
        log(`Proposed: "${recipe.title}". Grounding in USDA…`);
        ({ grounded, total } = await groundRecipe(recipe, sb, log));
        log(
          `Grounded totals: ${total.kcal.toFixed(0)} kcal · ${total.protein.toFixed(
            1
          )}g P · ${total.carbs.toFixed(1)}g C · ${total.fiber.toFixed(1)}g fiber`
        );
        const misses = offTarget(total, targets);
        if (!misses.length) {
          log(`✓ Macros within tolerance.`);
          break;
        }
        log(`✗ Off target: ${misses.join("; ")}`);
        feedback = `The grounded macros were off: ${misses.join(
          "; "
        )}. Adjust ingredient amounts (or swap an ingredient) to close the gap. Keep it appetizing.`;
        if (round === MAX_MACRO_ROUNDS)
          log(`Reached macro round cap — proceeding with closest version.`);
      }

      // palatability loop (blind)
      let verdict = { passes: true, note: "" };
      for (let t = 1; t <= MAX_TASTE_ROUNDS; t++) {
        log(`Palatability judge (blind) — round ${t}…`);
        verdict = await judgePalatability(recipe);
        if (verdict.passes) {
          log(`✓ Taste check passed. ${verdict.note || ""}`);
          break;
        }
        log(`✗ Taste check failed: ${verdict.note}`);
        if (t === MAX_TASTE_ROUNDS) {
          log(`Reached taste round cap — surfacing for your call.`);
          break;
        }
        // taste-driven revision, then RE-GROUND so macros can't drift silently
        recipe = await generateRecipe(
          targets,
          prefs,
          `A taste reviewer flagged this: "${verdict.note}". Fix the appeal problem while keeping macros on target.`
        );
        log(`Revised for taste: "${recipe.title}". Re-grounding…`);
        ({ grounded, total } = await groundRecipe(recipe, sb, log));
        log(
          `Re-grounded: ${total.kcal.toFixed(0)} kcal · ${total.protein.toFixed(
            1
          )}g P · ${total.carbs.toFixed(1)}g C · ${total.fiber.toFixed(1)}g fiber`
        );
      }

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
      };
      setCurrent(result);
      log(`Done.`);
    } catch (e) {
      setErr(e.message);
      log(`ERROR: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function keep() {
    setErr("");
    try {
      await saveRecipe(sb, current);
      setCurrent(null);
      setTab("box");
      await refreshBox();
    } catch (e) {
      setErr(e.message);
    }
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
              {["make", "box", "setup"].map((t) => (
                <button key={t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => { setTab(t); if (t === "box") refreshBox(); }}>
                  {t === "make" ? "Make a recipe" : t === "box" ? "The box" : "Setup"}
                </button>
              ))}
            </div>

            {err && <div className="err">{err}</div>}

            {tab === "setup" && (
              <div className="card">
                <h3 style={{ marginTop: 0 }}>Keys & connection</h3>
                <p style={{ fontSize: 13, color: "#8a7a5c" }}>
                  Connection settings for this session only; nothing is persisted.
                  The Supabase anon key is safe for client use behind row-level
                  security. Your USDA key lives server-side in the edge function (the
                  USDA_API_KEY secret), and your Anthropic key and app password live
                  server-side in the recipe proxy. None of those touch the browser.
                </p>
                <div className="field">
                  <label>Supabase project URL</label>
                  <input value={sbUrl} onChange={(e) => setSbUrl(e.target.value)} />
                </div>
                <div className="field">
                  <label>Supabase anon key</label>
                  <input value={sbKey} onChange={(e) => setSbKey(e.target.value)} placeholder="paste anon/publishable key" />
                </div>
              </div>
            )}

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
                  <button className="btn" disabled={!ready || busy} onClick={run}>
                    {busy ? "Cooking up something…" : ready ? "Generate recipe" : "Add Supabase keys in Setup first"}
                  </button>
                </div>

                {logLines.length > 0 && (
                  <div className="card">
                    <h3 style={{ marginTop: 0 }}>Kitchen pass</h3>
                    <div className="log" ref={logRef}>{logLines.join("\n")}</div>
                  </div>
                )}

                {current && <RecipeCard r={current} onKeep={keep} keepLabel="Add to the box" />}
              </>
            )}

            {tab === "box" && (
              <>
                {box.length === 0 && <div className="card">No recipes yet. Go make one.</div>}
                {box.map((r) => (
                  <RecipeCard key={r.id} r={r} />
                ))}
              </>
            )}
          </>
        )}
      </div>
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

function RecipeCard({ r, onKeep, keepLabel }) {
  const fiber = r.actual_fiber_g;
  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <h2 style={{ margin: "0 0 4px" }}>{r.title}</h2>
        <span className={`pill ${r.palatability_passed ? "ok" : "warn"}`}>
          {r.palatability_passed ? "taste ✓" : "needs a look"}
        </span>
      </div>

      <div className="macros">
        <div className="macro"><div className="v">{Math.round(r.actual_calories)}</div><div className="l">kcal</div></div>
        <div className="macro"><div className="v">{r.actual_protein_g}</div><div className="l">protein</div></div>
        <div className="macro"><div className="v">{r.actual_fat_g}</div><div className="l">fat</div></div>
        <div className="macro"><div className="v">{r.actual_carbs_g}</div><div className="l">carbs</div></div>
        {fiber != null && <div className="macro"><div className="v">{fiber}</div><div className="l">fiber</div></div>}
      </div>

      <h3 style={{ marginBottom: 6 }}>Ingredients</h3>
      {(r.ingredients || []).map((i, n) => (
        <div className="ing" key={n}>
          <span>{i.grams_cooked}g {i.name}</span>
          <span className="src">{i.fdcDescription} · FDC {i.fdcId}</span>
        </div>
      ))}

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
    </div>
  );
}
