// Shared logic for the /api/claude endpoint, used by BOTH the Vite dev
// middleware (local) and the Netlify function (production).
//
// Two jobs:
//  1. Enforce a shared app password (when APP_PASSWORD is set) so random
//     visitors can't burn your Anthropic spend. The password is checked here on
//     the server; it is never shipped to the browser.
//  2. Proxy the Generator/judge calls to Anthropic, holding the API key server
//     side. Model and token cap are fixed here so the endpoint can't be reused
//     as an open-ended relay.
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1000;
const ANTHROPIC_VERSION = "2023-06-01";

export async function handleClaudeRequest(body, password, env) {
  const expected = env?.APP_PASSWORD ?? "";
  if (expected && password !== expected) {
    return { status: 401, data: { error: { message: "Wrong or missing app password." } } };
  }

  // Lightweight ping the lock screen uses to validate the password without
  // spending an Anthropic call.
  if (body?.auth_check) {
    return { status: 200, data: { ok: true } };
  }

  const apiKey = env?.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { status: 500, data: { error: { message: "ANTHROPIC_API_KEY is not set on the server." } } };
  }
  return await callAnthropic(body, apiKey);
}

async function callAnthropic(body, apiKey) {
  const { system, user, messages } = body || {};
  const msgs = Array.isArray(messages) ? messages : [{ role: "user", content: user }];

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system, messages: msgs }),
  });

  const data = await resp.json();
  return { status: resp.status, data };
}
