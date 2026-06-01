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
- A small server-side proxy for the Anthropic API (`server/claude.js`), exposed
  two ways from one shared handler: a Vite dev middleware for `npm run dev`, and
  a Netlify function (`netlify/functions/claude.mjs`) for production. Model:
  `claude-sonnet-4-6`. The Anthropic key never reaches the browser.

## Prerequisites

- Node 18+ (built and tested on Node 22).
- The Supabase project `nwgxyytowbluuykbdcfc` (already provisioned). The
  `recipes` table and the `usda-ground` edge function are deployed.
- An Anthropic API key.

## Run locally

```bash
npm install
cp .env.example .env
# then edit .env and set ANTHROPIC_API_KEY=sk-ant-...
npm run dev
```

Open the printed localhost URL and go to **Make a recipe**. Supabase URL and
anon key are prefilled from `.env` (public values). The Anthropic key is read
server side by the dev proxy, so there is nothing to paste in the browser.

### Where each key lives

- **Supabase URL + anon key**: public client values, safe in the browser. Access
  is governed by row-level security, not by hiding the key. Prefilled in
  `.env.example`.
- **Anthropic key** (`ANTHROPIC_API_KEY`, no `VITE_` prefix): server side only.
  Used by the Vite dev proxy locally and the Netlify function in production. It
  is never bundled into client code.
- **USDA key** (`USDA_API_KEY`): a secret on the Supabase edge function. It never
  touches the browser. See open items.

## Deploy to Netlify

`netlify.toml` is included: build `npm run build`, publish `dist`, route
`/api/claude` to the function, and an SPA fallback. Connect the repo, then set
these environment variables in the Netlify UI (Site settings > Environment
variables):

- `ANTHROPIC_API_KEY` (required; server side, powers the recipe proxy).
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (optional; the app falls back to
  the public defaults baked into the code if these are unset).

The browser calls `/api/claude`, which Netlify routes to
`netlify/functions/claude.mjs`. The key stays on the server.

## Open items / known rough edges

1. **Set the USDA secret on Supabase.** The edge function reads `USDA_API_KEY`
   and falls back to `DEMO_KEY` (about 30 requests/hour, which will choke
   immediately). This must be a **Supabase edge function secret**, not a GitHub
   secret: Supabase dashboard > project `nwgxyytowbluuykbdcfc` > Edge Functions
   > Secrets > `USDA_API_KEY`. Or via CLI:
   `supabase secrets set USDA_API_KEY=... --project-ref nwgxyytowbluuykbdcfc`.
   Free key: https://fdc.nal.usda.gov/api-key-signup.html
2. **RLS is permissive.** The `recipes` table has row-level security enabled with
   a policy that allows public read and insert, because the app authenticates
   with only the anon key (no user login). Fine for a private deploy. Add real
   auth (Supabase Auth) and scope rows to the signed-in user before this is
   shared.
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
