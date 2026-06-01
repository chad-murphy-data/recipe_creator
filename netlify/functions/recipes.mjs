import { checkPassword } from "../../server/claude.js";
import { handleRecipes } from "../../server/recipes.js";

// Netlify Function (v2). Password-gated server-side access to the recipes table,
// so the browser never needs a DB-capable Supabase key. The browser calls
// /api/recipes (see netlify.toml redirect).
export default async (req) => {
  if (req.method !== "POST") {
    return json({ error: { message: "Method not allowed" } }, 405);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const password = req.headers.get("x-app-password") || "";
  const denied = checkPassword(password, process.env);
  if (denied) return json(denied.data, denied.status);

  try {
    const { status, data } = await handleRecipes(body, process.env);
    return json(data, status);
  } catch (e) {
    return json({ error: { message: String(e?.message ?? e) } }, 502);
  }
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
