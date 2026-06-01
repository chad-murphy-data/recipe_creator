# Charlie's Recipe Box

A macro-precise dinner recipe generator with a saved recipe box. Macros are
computed in code from USDA FoodData Central, never guessed by the model, and a
blind palatability judge approves on taste alone so the food stays edible.

## How it works

Per request the app runs this pipeline:

1. **Generator** (Claude) proposes a recipe: `{name, usdaQuery, grams}` per
   ingredient plus steps. Grams are always the cooked weight, and the USDA query
   targets a cooked entry, so there is no raw to cooked yield math.
2. **Grounding** (code) sends those ingredients to a Supabase edge function that
   queries USDA, fetches per 100g macros, and returns authoritative totals.
3. **Reconcile**: if totals are off target, loop back to the Generator with the
   real shortfall (cap 4 rounds).
4. **Palatability judge** (a separate Claude call given no macro targets) passes
   or rejects on taste. A failure triggers a revision and a re-ground, so a taste
   fix cannot silently break the macros (cap 3 rounds).
5. **Save** to Supabase.

The model never sees a nutrition number it can game, and the judge never sees a
number it could be seduced into chasing. That split is the whole point.

## Stack

- React + Vite single page app (`src/App.jsx`).
- Supabase Postgres table `recipes` for storage, plus an edge function
  `usda-ground` that does all USDA work server side.
- Anthropic API for the Generator and the judge (`claude-sonnet-4-20250514`).

## Prerequisites

- Node 18+ (built and tested on Node 22).
- The Supabase project `nwgxyytowbluuykbdcfc` (already provisioned). The
  `recipes` table and the `usda-ground` edge function are deployed.
- An Anthropic API key.

## Run locally

```bash
npm install
cp .env.example .env      # Supabase URL + anon key are prefilled (public values)
npm run dev
```

Open the printed localhost URL. Go to the **Setup** tab and paste your Anthropic
API key (or set `VITE_ANTHROPIC_API_KEY` in `.env`). Then **Make a recipe**.

### Keys and where they live

- **Supabase URL + anon key**: public client values, safe in the browser. Access
  is governed by row-level security, not by hiding the key. Prefilled in
  `.env.example`.
- **Anthropic key**: a real secret. Paste it in the Setup tab (kept in memory for
  the session only, never persisted). If you put it in `.env` for convenience,
  remember that `vite build` would bake it into the public bundle, so do not do
  that for a shared deploy. Use a serverless proxy instead (see below).
- **USDA key**: lives server side as the `USDA_API_KEY` secret on the edge
  function. It never touches the browser. See open items.

## Deploy to Netlify

`netlify.toml` is included (build `npm run build`, publish `dist`, SPA redirect).
Connect the repo, set environment variables in the Netlify UI:

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (safe to expose).

For the Anthropic call on a public deploy, do not ship the key in the bundle.
Add a small serverless function (Netlify Functions) that holds
`ANTHROPIC_API_KEY` server side and forwards to `api.anthropic.com`, then point
the frontend at that function. The current build calls Anthropic directly from
the browser with a pasted key, which is fine for a private single-user demo but
not for a public URL.

## Open items / known rough edges

1. **Set the USDA secret.** The edge function reads `USDA_API_KEY` and falls back
   to `DEMO_KEY` (about 30 requests/hour, which will choke immediately). Set the
   real key in the Supabase dashboard: project `nwgxyytowbluuykbdcfc` ->
   Edge Functions -> Secrets -> `USDA_API_KEY`. Free key:
   https://fdc.nal.usda.gov/api-key-signup.html
2. **RLS is permissive.** The `recipes` table has row-level security enabled with
   a policy that allows public read and insert, because the app authenticates
   with only the anon key (no user login). Fine for a private demo. Add real auth
   and per-user rows before this is more than that.
3. **Ingredient matching takes the first cooked hit** from USDA search. Worked in
   tests, but USDA search is fuzzy and a top hit is occasionally a branded or
   lunchmeat item. A disambiguation step (show the match, let the user confirm or
   swap) is the next improvement. Watch soba and edamame on the first real run.

## Demo parameters

- Targets (dinner, per serving): 535 kcal, 40 to 50g protein, 30 to 55g carbs,
  5 to 10g fiber. The app defaults to the midpoints: 535 / 45 / 42 / 7.
- Tolerances (per serving): calories +/-25, protein +/-4g, carbs +/-8g, fiber no
  more than 2g under.
- Preferences: loves umami, skinless boneless chicken breast is a workhorse
  protein, no hard dislikes or allergies, do not bury a dish in one garnish to
  hit a number.
