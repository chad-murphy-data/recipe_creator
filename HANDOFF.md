# Charlie's Recipe Box — Handoff

A macro-precise dinner recipe generator with a saved recipe box. The thesis:
**macros are computed in code from USDA FoodData Central, never guessed by the
model**, and a **blind palatability judge** keeps the food edible. Built for
Charlie, who tracks macros non-negotiably and weighs ingredients raw.

If you are a new session picking this up: read the Hard Guardrails first. They
are the whole point. A change that breaks one of them is a regression even if it
appears to work.

## Hard guardrails (do not regress these)

1. **Macros are computed in code, never by the model.** The model proposes, per
   ingredient, `{name, usdaQuery, match, role, grams}`. Code does the USDA lookup
   and the arithmetic. Never let the model emit macro numbers, and never trust a
   model-supplied USDA `fdcId` (it hallucinates plausible-but-wrong IDs, which is
   worse than a search because it looks authoritative).
2. **Code owns the portions.** `src/solver.js` solves the gram weights (bounded
   least-squares) to hit the targets within tolerance, inside sane per-role
   bounds. The model designs the dish; code sets the amounts. Do not revert to
   the model eyeballing grams.
3. **Never silently ship off-target.** If no portioning can hit the targets, the
   recipe is saved and shown flagged (`on_target = false`, a "macros off" pill +
   the specific miss), not passed off as good.
4. **Never substitute the wrong food.** The chosen USDA entry must contain the
   generator's `match` term (`descMatches` in the edge function). If nothing
   matches, fail loudly naming the ingredient. This is what stopped "edamame"
   silently resolving to "Asparagus, cooked."
5. **Match the prep.** Raw mode uses raw weights and raw USDA entries; cooked uses
   cooked. Never mix (raw grams against a cooked entry gives wrong macros).
6. **The judge is blind.** The palatability judge sees the recipe but no macro
   targets, so it cannot be seduced into gaming numbers. After any taste-driven
   revision, re-ground AND re-solve so the macros cannot silently drift.
7. **Tolerances are the precision contract** (per serving, `TOL` in
   `src/solver.js`): calories +/-25, protein +/-4g, carbs +/-8g, fiber no more
   than 2g under. This is the definition of "on target."
8. **Secrets stay server-side.** The Anthropic key, the Supabase service
   (`sb_secret_...`) key, and the USDA key never reach the browser. Only the
   Supabase *publishable* key is client-side, and the database is locked so it
   cannot touch data. Never give a `VITE_`-prefixed env var a secret value (it
   gets bundled into the public site).

## Pipeline (per recipe request)

1. **Generator** (Claude) designs a dish and returns, per ingredient, a display
   name, a USDA `usdaQuery`, a `match` term (the food word the entry must
   contain), a `role` (protein/carb/vegetable/legume/fat/seasoning), and a rough
   gram weight. Raw or cooked per the toggle.
2. **Grounding** (Supabase edge function `usda-ground`) searches USDA, validates
   the `match`, prefers the requested prep, and returns each ingredient's
   per-100g macros. Charlie's staples pin known-good FDC IDs (cooked mode only).
3. **Solve** (`src/solver.js`) computes the exact gram weights to hit the targets
   within bounds. Deterministic (same recipe solves the same way).
4. **Swap, only if infeasible** (cap 4): if no portioning works, the ingredient
   *set* is wrong, ask the model to swap one in, then re-ground and re-solve.
5. **Palatability judge** (blind, cap 3): pass, or revise then re-ground/re-solve.
6. **Save** to Supabase through the server, or save flagged off-target.

## Where things live

- `src/App.jsx` — the whole React UI (single file). Make tab (targets, prefs,
  Raw/Cooked toggle, generate) and The Box (status, tags, search/filter, delete,
  reroll, per-ingredient macro breakdown, live portion editor).
- `src/solver.js` — the precision engine: portion solver, tolerances (`TOL`),
  `applyGrams`, `offTarget`. Tested in `src/solver.test.js`.
- `src/staples.js` — pinned USDA FDC IDs for staple foods. Tested.
- `server/claude.js` — `/api/claude`: password gate + spend cap + Anthropic call.
  Model `claude-sonnet-4-6`, `max_tokens` 2000.
- `server/recipes.js` — `/api/recipes`: password-gated DB access with the service
  key (public-key fallback so it never bricks before the key is set).
- `server/ratelimit.js` — the spend cap (sliding window).
- `netlify/functions/{claude,recipes}.mjs` — production endpoints. `vite.config.js`
  mirrors both as dev middleware so `npm run dev` behaves like production.
- `supabase/functions/usda-ground/index.ts` — the grounding edge function (Deno).
  Deployed to Supabase; keep this file in sync with the deployed version.
- Tests: `npm test` (Node's built-in runner, no extra deps). 38 tests across the
  solver, staples, recipes endpoint, rate limiter, and the proxy.

## Deployed infrastructure

- **Supabase** project ref `nwgxyytowbluuykbdcfc` (us-east-2).
  - Table `public.recipes`: `target_*` and `actual_*` for calories/protein_g/
    fat_g/carbs_g/fiber_g, `ingredients` (jsonb, the grounded array with per-100g
    + contributions), `steps` (jsonb), `palatability_passed`, `palatability_note`,
    `on_target`, `off_target_note`, `status` (untried/liked/disliked), `tags`
    (text[]), `prep` (raw/cooked). **RLS enabled, zero policies, zero anon grants:
    service-role-only.**
  - Edge function `usda-ground`: ACTIVE, `verify_jwt = false` (stateless USDA
    utility; this is also why it works with the modern publishable key, which is
    not a JWT). Reads the `USDA_API_KEY` secret.
- **Netlify**: builds the Vite app, serves `/api/*` via the functions
  (`netlify.toml` has the `/api/claude`, `/api/recipes`, and SPA redirects).

## Environment variables

Netlify (server-side; functions read them at runtime):
- `ANTHROPIC_API_KEY` — powers the recipe engine.
- `APP_PASSWORD` — the app gate. Set means the lock screen is on. Currently set.
- `SUPABASE_SERVICE_KEY` — the `sb_secret_...` service_role key; lets the server
  bypass RLS. Currently set.
- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are intentionally **not set**.
  The client bakes in the public project URL and publishable key as defaults.
  Do not set `VITE_SUPABASE_ANON_KEY` to a secret key (it would be bundled into
  the public site, which is the bug that bit us once).

Supabase (not Netlify): `USDA_API_KEY` secret on the edge function.

Anthropic account: a **$25/month billing limit** is set. That is the absolute
hard ceiling on spend, on top of the password and the in-app rate cap.

## Security posture

- Anthropic key is server-only and never in the bundle. `/api/claude` is
  password-gated and rate-capped; the $25 account cap is the absolute backstop.
- The recipes table is service-role-only (RLS locked). The browser reaches it
  only through the password-gated `/api/recipes`.
- The USDA key is an edge-function secret.
- One known-open surface: `usda-ground` is publicly callable (no password, by
  design, so the browser can reach it). It touches no data and spends no
  Anthropic money, only free USDA quota. Gate it if you ever want zero open
  endpoints.

## Run / test / deploy

- Local: `npm install`; `cp .env.example .env`; set `ANTHROPIC_API_KEY` (and
  `APP_PASSWORD`, `SUPABASE_SERVICE_KEY` for full parity); `npm run dev`. The dev
  server serves the same `/api/*` endpoints as production.
- Test: `npm test`.
- Deploy: merge to `main`, Netlify auto-deploys. Edge function changes deploy
  separately to Supabase (deploy `usda-ground` with `--no-verify-jwt`, and keep
  `supabase/functions/usda-ground/index.ts` in sync).

## Two gotchas a new session WILL hit

1. **The agent sandbox is egress-blocked.** Outbound calls to `supabase.co` and
   `api.nal.usda.gov` are denied from the Claude Code shell (host allowlist). You
   cannot exercise the live USDA/Supabase data path from the agent. Your
   verification path is: `npm test`, a clean `npm run build`, and the **Netlify
   deploy preview** (which can reach everything). Plan live checks on the
   preview/production, not the sandbox. `api.anthropic.com`, GitHub, npm, and
   Google Fonts are allowed.
2. **PRs are squash-merged**, so after a merge the working branch diverges from
   `main` (main has the squash; the branch has the original commits). Before
   starting new work: `git fetch origin main && git reset --hard origin/main`.
   Otherwise the next PR re-includes already-merged commits and conflicts.

## Open items (the "last 5%")

- **Saving ingredients in a table: judged NOT necessary.** Moving `src/staples.js`
  into a DB table would not improve accuracy (the hardcoded list is already
  deterministic and correct); it would only allow editing without a deploy, not
  worth the surface for a rarely-changing short list. A USDA response cache is a
  performance/rate-limit optimization that single-user usage does not need. If
  you want better long-tail accuracy, add more *verified* FDC IDs to
  `src/staples.js` (verify each against USDA first; a wrong pin is worse than a
  search).
- **Disambiguation UI**: show the matched USDA entry and let Charlie confirm or
  swap it. Today it is first-acceptable-match with loud failure. This is the next
  accuracy step if a wrong match ever slips through validation.
- **Full in-place editing of saved recipes** (changing ingredients/steps, not
  just portions): reroll-with-a-note covers most of the need; a true editor was
  deferred.
- **Gate `usda-ground`** if you want no open endpoints (see Security posture).
- **Real auth**: currently a single shared password, by design (one user, private
  URL). Add Supabase Auth with per-user rows only if it is ever shared.

## House style (Chad's standing rules)

- No em dashes in written output.
- Insight-first, concrete, no consultant-speak, no sycophancy. Honest pushback
  welcome.
- 65% solution ships; do not over-engineer. Talk through the thinking, then build.
