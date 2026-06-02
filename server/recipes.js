// Server-side recipes data access for /api/recipes.
//
// Why this exists: the browser used to call Supabase REST directly with the
// public anon key, which means anyone can read the key from the bundle and hit
// the DB. Routing through the server lets us (a) gate on APP_PASSWORD and (b)
// use the Supabase SECRET key, held server-side, so we can shut RLS to the
// public key entirely (see the lock-down migration).
//
// Safe rollout: if SUPABASE_SERVICE_KEY isn't set yet, we fall back to the
// public anon/publishable key. So this works identically before and after the
// key is configured, and before/after RLS is locked. No flag day.

const ALLOWED_FIELDS = new Set([
  "title", "servings",
  "target_calories", "target_protein_g", "target_carbs_g", "target_fiber_g",
  "actual_calories", "actual_protein_g", "actual_fat_g", "actual_carbs_g", "actual_fiber_g",
  "ingredients", "steps", "palatability_passed", "palatability_note",
  "on_target", "off_target_note", "status", "tags", "prep",
]);

// Whitelist what the client may write, so the endpoint can't be used to set
// arbitrary columns. id/created_at are server/DB-managed.
function clean(record) {
  const out = {};
  for (const [k, v] of Object.entries(record || {})) {
    if (ALLOWED_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

// Public fallbacks (same values the client bakes in) so the box can't break just
// because a Supabase env var is missing. Order: SECRET key (the real lock, lets us
// shut RLS) -> any configured public key -> the baked publishable key. The
// publishable fallback works only while RLS is still open; once RLS is locked the
// SECRET key must be set, which is the intended "armed" state.
const DEFAULT_URL = "https://nwgxyytowbluuykbdcfc.supabase.co";
const DEFAULT_PUBLISHABLE = "sb_publishable_MF7iftdZykPrfelnVnJHew_DSuyVLJ1";

function dbKey(env) {
  return env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || DEFAULT_PUBLISHABLE;
}
function dbUrl(env) {
  return (env.SUPABASE_URL || env.VITE_SUPABASE_URL || DEFAULT_URL).replace(/\/$/, "");
}

async function sb(env, path, init = {}) {
  const key = dbKey(env);
  const url = dbUrl(env);
  if (!key || !url) throw new Error("Supabase is not configured on the server.");
  const r = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${init.method || "GET"} ${path} failed (${r.status}): ${await r.text()}`);
  return r;
}

// action: list | create | update | delete
export async function handleRecipes(body, env) {
  const action = body?.action;
  if (action === "list") {
    const r = await sb(env, "recipes?select=*&order=created_at.desc");
    return { status: 200, data: await r.json() };
  }
  if (action === "create") {
    const r = await sb(env, "recipes", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(clean(body.record)),
    });
    return { status: 200, data: (await r.json())[0] };
  }
  if (action === "update") {
    if (!body.id) return { status: 400, data: { error: { message: "update requires id" } } };
    const r = await sb(env, `recipes?id=eq.${encodeURIComponent(body.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(clean(body.patch)),
    });
    return { status: 200, data: (await r.json())[0] };
  }
  if (action === "delete") {
    if (!body.id) return { status: 400, data: { error: { message: "delete requires id" } } };
    await sb(env, `recipes?id=eq.${encodeURIComponent(body.id)}`, { method: "DELETE" });
    return { status: 200, data: { ok: true } };
  }
  return { status: 400, data: { error: { message: `Unknown action: ${action}` } } };
}
