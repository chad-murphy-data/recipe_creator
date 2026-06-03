# usda-ground edge function

Server-side USDA FoodData Central grounding for Charlie's Recipe Box. Takes
`{ ingredients: [{ name, usdaQuery, match, grams }] }`, searches USDA, validates
each match, fetches per-100g macros, and returns `{ grounded, total }`.

This is the source of truth for the function. It was iterated by deploying
directly to Supabase; keep this file in sync with the deployed version.

## Matching

- If the caller passes a pinned `fdcId` (a curated staple from `src/staples.js`),
  the function fetches that exact entry and skips search entirely. This removes
  search variance for Charlie's regulars.
- Otherwise it searches the detailed `usdaQuery` first, then falls back to the
  bare `match` noun if the food doesn't surface (a noisy query like "shelled
  edamame cooked" buries the real entry under generic "cooked" vegetables).
- If the generic datasets still have no match, it tries **Branded** as a final
  tier: real USDA manufacturer-label data, where foods like gochujang and specific
  sauces/pastes live. Branded is searched only as a fallback (the dataset is huge
  and would otherwise bury good generic matches), and a branded hit whose label is
  missing calories is skipped. Branded entries come back with `branded: true`.
- Requires the chosen entry's description to contain the `match` term, prefers a
  cooked/prepared form, and avoids raw. Fails loudly (naming the ingredient)
  rather than substituting a wrong food. The client treats that failure as
  recoverable (it re-grounds per ingredient and estimates the genuine miss), so a
  loud failure here no longer kills the whole recipe.
- Searches Foundation, SR Legacy, and Survey (FNDDS) via the POST endpoint, plus
  Branded as the fallback tier. FNDDS must go through POST: as a query-string
  `dataType` value its parentheses make the search endpoint return 400.

## Deploy config (not captured in the source)

- `verify_jwt = false`. The function is a stateless USDA utility (no database, no
  user data), so it is callable without a Supabase JWT. This also keeps it
  working with the modern publishable key, which is not a JWT.
- Reads the `USDA_API_KEY` secret, set in the Supabase dashboard under
  Edge Functions > Secrets. Falls back to `DEMO_KEY`, which is heavily
  rate-limited.

## Deploy

```bash
supabase functions deploy usda-ground --no-verify-jwt --project-ref nwgxyytowbluuykbdcfc
```
