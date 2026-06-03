# Charlie's Recipe Box

A macro-precise dinner recipe generator with a saved recipe box. Macros are
computed in code from USDA FoodData Central, never guessed by the model, and a
blind palatability judge approves on taste alone so the food stays edible.

> **This is a personal app.** The only user is Charlie (one person), and it is
> not in daily use yet. There is no real risk in testing against production, and
> any change can be reverted, so prefer shipping and verifying on the live
> preview or prod over building elaborate staging. (Secrets still stay
> server-side regardless; see the password gate and deploy notes below.)

## How it works

Per request the app runs this pipeline:

1. **Generator** (Claude) designs a dish: per ingredient a display name, a USDA
   search phrase, a `match` term (the food word that must appear in the matched
   USDA entry), a `role` (protein/carb/vegetable/legume/fat/seasoning), and a
   rough gram weight, plus steps. The grams are only a starting point.
   Weights are **raw** by default (weighed uncooked, how most people portion at
   prep time); a Raw/Cooked toggle on the Make tab switches to cooked entries.
   The chosen mode is stored per recipe.
2. **Grounding** (code) sends those ingredients to a Supabase edge function that
   queries USDA, verifies each hit actually contains the `match` term (so edamame
   can't silently resolve to asparagus) and is in the requested prep (raw vs
   cooked), and returns each ingredient's per-100g macros. Charlie's staple foods
   (`src/staples.js`, cooked entries) pin a USDA
   entry in cooked mode, so common ingredients skip the fuzzy search and use a
   known-good ID; raw mode falls through to the prep-aware search.
3. **Solve** (code, `src/solver.js`): the precision engine. Macros are linear in
   grams, so hitting the targets is a small bounded least-squares solve on the
   per-100g vectors. Code computes the exact gram weights, within sane per-role
   bounds (it can trim the rice but not delete it, and can't drown the dish in
   oil to reach a calorie number). Deterministic: the same recipe always solves
   the same way.
4. **Swap, only if needed**: if no portioning can hit the targets, the ingredient
   *set* is wrong, not the amounts. The Generator is asked to swap or add one
   ingredient (e.g. beans for a fiber gap), then we re-ground and re-solve (cap 4).
5. **Palatability judge** (a separate Claude call given no macro targets) passes
   or rejects on taste. A failure triggers a revision, then a re-ground and
   re-solve, so a taste fix cannot silently break the macros (cap 3 rounds).
6. **Save** to Supabase. If the solve still couldn't hit target, the recipe is
   saved and shown flagged (`on_target = false`) rather than passed off as good.

The model designs the food; code owns the numbers. The model never sees a
nutrition number it can game, and the judge never sees a number it could be
seduced into chasing. That split is the whole point.

## The box

Saved recipes live in **The box**, with:

- **Status**: mark each recipe Liked / Disliked / Haven't tried (shown as a pill).
- **Tags**: add freeform tags; remove by clicking them.
- **Search and filter**: by text (title, ingredient, or tag), by status, and by tag.
- **Reroll with a note**: describe a change ("too many sides, pick one veg") and
  it regenerates a fresh recipe on the Make tab. Non-destructive: the original
  stays in the box.
- **Delete** (with a confirm).

The generator also gets a **variety nudge**: recent box titles are passed in with
"make something different," so it stops defaulting to the same dish every run.

## Tests

```bash
npm test
```

`src/solver.test.js` proves the precision engine: it hits realistic targets,
trims a carb-heavy ingredient instead of zeroing it, refuses to inflate calories
with oil, reports infeasible ingredient sets instead of silently saving off
target, and is deterministic. `src/staples.test.js` covers the pinned-staple
lookup, and `server/claude.test.js` covers the proxy (password gate, token-limit
handling).

## Stack

- React + Vite single page app (`src/App.jsx`).
- Supabase Postgres table `recipes` for storage, plus an edge function
  `usda-ground` that does all USDA work server side (search, match validation,
  macro math).
- A small server-side proxy (`server/claude.js`) for the recipe engine, exposed
  two ways from one shared handler: a Vite dev middleware for `npm run dev`, and a
  Netlify function (`netlify/functions/claude.mjs`) for production. It holds the
  Anthropic key, fixes the model (`claude-sonnet-4-6`), and enforces the app
  password. None of that reaches the browser.
- A second password-gated endpoint (`server/recipes.js` -> `/api/recipes`) holds
  the Supabase **service** key and is the only way the browser touches the
  `recipes` table, so the database is never reachable with the public key.

## Prerequisites

- Node 18+ (built and tested on Node 22).
- The Supabase project `nwgxyytowbluuykbdcfc` (already provisioned). The
  `recipes` table and the `usda-ground` edge function are deployed.
- An Anthropic API key.

## Run locally

```bash
npm install
cp .env.example .env
# then edit .env: set ANTHROPIC_API_KEY, and APP_PASSWORD if you want the gate
npm run dev
```

Open the printed localhost URL. Supabase URL and anon key are prefilled from
`.env` (public values). The Anthropic key and password are read server side by
the dev proxy, so there is nothing to paste in the browser.

## The password gate

A shared password keeps random visitors from burning your Anthropic spend.

- Set `APP_PASSWORD` (server-side env var). The app shows a lock screen, and the
  `/api/claude` proxy refuses to call Anthropic without the right password. The
  check is server side, so it actually protects the calls, not just the screen.
- Leave `APP_PASSWORD` blank and there is no gate (handy for local dev).
- The entered password is kept in the browser session only and sent with each
  request for the server to verify.

What it does not cover: the password is a single shared secret, not per-user
login. It is not the database's lock, though: the `recipes` table is locked down
(RLS on, no anon policies), and the browser reaches it only through the
password-gated `/api/recipes`, which uses the Supabase service key server-side.
So the public key in the bundle cannot read or change the box. The one
intentionally open surface is the `usda-ground` edge function (no password, no
database, only free USDA quota). Real per-user auth is only worth adding if this
is ever shared beyond one person.

## Deploy to Netlify

`netlify.toml` is included: build `npm run build`, publish `dist`, route
`/api/claude` to the function, and an SPA fallback. Connect the repo, then set
these environment variables in the Netlify UI (Site settings > Environment
variables):

- `ANTHROPIC_API_KEY` (required; powers the recipe proxy).
- `APP_PASSWORD` (optional; turns on the lock screen).
- `SUPABASE_SERVICE_KEY` (the `sb_secret_...` service-role key; lets `/api/recipes`
  reach the locked-down table. Required now that RLS is closed to the public key.
  Server-side only: never give a `VITE_`-prefixed var a secret value, it gets
  bundled into the public site).
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (optional; the app falls back to
  the public defaults baked into the code if unset).

## Open items / known rough edges

1. **Set the USDA secret on Supabase.** The edge function reads `USDA_API_KEY`
   and falls back to `DEMO_KEY` (about 30 requests/hour, which chokes fast). This
   must be a **Supabase edge function secret**, not a GitHub secret: dashboard >
   project `nwgxyytowbluuykbdcfc` > Edge Functions > Secrets > `USDA_API_KEY`. Or
   via CLI: `supabase secrets set USDA_API_KEY=... --project-ref nwgxyytowbluuykbdcfc`.
   Free key: https://fdc.nal.usda.gov/api-key-signup.html
2. **No per-user auth (single shared password).** The `recipes` table is locked
   down: RLS on with no anon policies, so the public key can't touch it. The
   browser reads and writes only through the password-gated `/api/recipes`, which
   holds the Supabase service key server-side. What remains is that everyone shares
   one password instead of logging in; add real auth and per-user rows only if this
   is ever shared beyond one person.
3. **Ingredient matching** validates that the chosen USDA entry contains the
   Generator's `match` term and searches Foundation, SR Legacy, and Survey
   (FNDDS), then **USDA Branded** (real label data) as a fallback for foods the
   generic sets lack (gochujang, specific sauces). A food absent from every USDA
   tier falls back to a clearly-flagged model estimate, and one that can't even be
   estimated is swapped, so a single odd ingredient never errors the whole recipe.
   Curated staple foods mapped to known-good FDC IDs (`src/staples.js`) skip the
   search for Charlie's regulars.

## Demo parameters

- Targets (dinner, per serving): 535 kcal, 40 to 50g protein, 30 to 55g carbs,
  5 to 10g fiber. The app defaults to the midpoints: 535 / 45 / 42 / 7.
- Tolerances (per serving): calories +/-25, protein +/-4g, carbs +/-8g, fiber no
  more than 2g under.
- Preferences: loves umami, skinless boneless chicken breast is a workhorse
  protein, no hard dislikes or allergies, do not bury a dish in one garnish to
  hit a number.
