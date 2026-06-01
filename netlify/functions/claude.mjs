import { callAnthropic } from "../../server/claude.js";

// Netlify Function (v2). Holds ANTHROPIC_API_KEY server-side and forwards to
// the Anthropic API. The browser calls /api/claude (see netlify.toml redirect).
export default async (req) => {
  if (req.method !== "POST") {
    return json({ error: { message: "Method not allowed" } }, 405);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(
      { error: { message: "ANTHROPIC_API_KEY is not set on the server." } },
      500
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    const { status, data } = await callAnthropic(body, apiKey);
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
