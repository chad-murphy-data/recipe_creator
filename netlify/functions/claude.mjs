import { handleClaudeRequest } from "../../server/claude.js";

// Netlify Function (v2). Enforces the app password and proxies to Anthropic,
// both server-side. The browser calls /api/claude (see netlify.toml redirect).
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

  try {
    const { status, data } = await handleClaudeRequest(body, password, process.env);
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
