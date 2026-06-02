import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const USDA_KEY = Deno.env.get("USDA_API_KEY") ?? "DEMO_KEY";
const NUTRIENT_IDS: Record<number,string> = {1008:"kcal",1003:"protein",1004:"fat",1005:"carbs",1079:"fiber"};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const COOKED_WORDS = ["cooked","roasted","boiled","braised","grilled","steamed","baked","stewed","simmered","prepared"];
const isCooked = (d: string) => COOKED_WORDS.some((w) => (d ?? "").toLowerCase().includes(w));
const isRaw = (d: string) => (d ?? "").toLowerCase().split(/[^a-z0-9]+/).includes("raw");

// Uses the POST search endpoint so Survey (FNDDS) can be passed as a dataType
// array value. (As a query-string param its parentheses make USDA return 400.)
// FNDDS is where entries like "Edamame, prepared" live, alongside Foundation
// and SR Legacy.
async function search(query: string) {
  const r = await fetch(`https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${USDA_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, dataType: ["Foundation", "SR Legacy", "Survey (FNDDS)"], pageSize: 25 }),
  });
  if (!r.ok) throw new Error(`USDA search failed (${r.status}) for "${query}"`);
  const d = await r.json();
  return (d.foods ?? []).map((f: any) => ({ fdcId: f.fdcId, description: f.description, dataType: f.dataType }));
}

// Every significant word of the match term must appear in the description
// (order-independent, plural tolerant). Stops "edamame" resolving to "Asparagus".
function descMatches(description: string, matchTerm: string): boolean {
  const tokens = (description ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const words = (matchTerm ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  if (!words.length) return false;
  return words.every((w) => tokens.some((t) => t === w || t.startsWith(w) || w.startsWith(t)));
}

// From a set of hits, pick the right food in the requested preparation: require
// the match term, then prefer the right form. "cooked" prefers cooked/prepared
// and avoids raw; "raw" prefers raw and avoids clearly-cooked. Falls back within
// the noun matches if the exact form isn't available.
function selectHit(hits: any[], matchTerm: string, prep: string) {
  const nounMatches = matchTerm ? hits.filter((h: any) => descMatches(h.description, matchTerm)) : hits;
  if (!nounMatches.length) return null;
  if (prep === "raw") {
    const raw = nounMatches.filter((h: any) => isRaw(h.description));
    if (raw.length) return raw[0];
    const notCooked = nounMatches.filter((h: any) => !isCooked(h.description));
    return notCooked[0] ?? nounMatches[0];
  }
  const cooked = nounMatches.filter((h: any) => isCooked(h.description) && !isRaw(h.description));
  if (cooked.length) return cooked[0];
  const notRaw = nounMatches.filter((h: any) => !isRaw(h.description));
  return notRaw[0] ?? nounMatches[0];
}

async function macros(fdcId: number) {
  const url = `https://api.nal.usda.gov/fdc/v1/food/${fdcId}?api_key=${USDA_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`USDA fetch failed (${r.status}) for ${fdcId}`);
  const d = await r.json();
  const out: any = { kcal:0, protein:0, fat:0, carbs:0, fiber:0, description: d.description };
  for (const n of d.foodNutrients ?? []) {
    const id = n.nutrient?.id ?? n.nutrientId;
    const key = NUTRIENT_IDS[id];
    if (key) out[key] = n.amount ?? n.value ?? 0;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { ingredients, prep: prepRaw } = await req.json(); // [{name, usdaQuery, match?, grams, fdcId?}], prep
    if (!Array.isArray(ingredients)) throw new Error("Body must include an 'ingredients' array.");
    // Default to "cooked" when not specified, so older clients keep their behavior.
    const prep = prepRaw === "raw" ? "raw" : "cooked";
    const grounded: any[] = [];
    const total = { kcal:0, protein:0, fat:0, carbs:0, fiber:0 };
    for (const ing of ingredients) {
      let chosen: any;
      if (ing.fdcId) {
        // 0) Pinned staple: fetch the exact curated entry, no search. The macros
        //    fetch carries the description, so we trust the caller's pin.
        chosen = { fdcId: ing.fdcId, description: null };
      } else {
        // 1) Try the generator's detailed query (precise variant for this prep).
        let hits = await search(ing.usdaQuery);
        chosen = selectHit(hits, ing.match, prep);
        // 2) Fallback: search the bare food noun. A noisy query like
        //    "shelled edamame cooked" floods results with "cooked" vegetables and
        //    buries the real "Edamame" entry; "edamame" alone finds it.
        if (!chosen && ing.match && ing.match.trim().toLowerCase() !== (ing.usdaQuery ?? "").trim().toLowerCase()) {
          hits = await search(ing.match);
          chosen = selectHit(hits, ing.match, prep);
        }
        if (!chosen) {
          const seen = hits.slice(0, 3).map((h: any) => h.description).join(" | ");
          throw new Error(`No USDA entry matching "${ing.match ?? ing.usdaQuery}" for "${ing.name}". Top hits were: ${seen}`);
        }
      }
      const per100 = await macros(chosen.fdcId);
      // For pinned entries, fill the description from the fetched food.
      if (!chosen.description) chosen.description = per100.description;
      const f = (ing.grams ?? 0) / 100;
      const contributes = {
        kcal: per100.kcal * f, protein: per100.protein * f, fat: per100.fat * f,
        carbs: per100.carbs * f, fiber: per100.fiber * f,
      };
      for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += (contributes as any)[k];
      grounded.push({
        name: ing.name, grams_cooked: ing.grams, fdcId: chosen.fdcId,
        fdcDescription: chosen.description, per100g: per100, contributes,
      });
    }
    return new Response(JSON.stringify({ grounded, total }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message ?? e) }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
