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
import { rateLimit } from "./ratelimit.js";

const MODEL = "claude-sonnet-4-6";
// Recipes with many ingredients (each now carrying name/usdaQuery/match/role)
// plus steps can exceed 1000 tokens; a truncated response breaks JSON.parse.
const MAX_TOKENS = 2000;
const ANTHROPIC_VERSION = "2023-06-01";

// Spend guard: cap model calls per rolling window. A full recipe run makes
// several calls (generate + judge, plus any swap/taste rounds), so this allows
// real use while stopping a runaway loop or a leaked-password abuser from
// racking up a bill. Override via env if needed.
function spendLimit(env) {
  return {
    max: Number(env?.CLAUDE_RATE_MAX) || 40,
    windowMs: (Number(env?.CLAUDE_RATE_WINDOW_S) || 600) * 1000,
  };
}

// Shared password check. Returns null if OK, or an error response.
export function checkPassword(password, env) {
  const expected = env?.APP_PASSWORD ?? "";
  if (expected && password !== expected) {
    return { status: 401, data: { error: { message: "Wrong or missing app password." } } };
  }
  return null;
}

export async function handleClaudeRequest(body, password, env) {
  const denied = checkPassword(password, env);
  if (denied) return denied;

  // Lightweight ping the lock screen uses to validate the password without
  // spending an Anthropic call.
  if (body?.auth_check) {
    return { status: 200, data: { ok: true } };
  }

  // Spend cap (keyed globally; this is a single-user app).
  const { max, windowMs } = spendLimit(env);
  const rl = rateLimit("claude", max, windowMs);
  if (!rl.ok) {
    return {
      status: 429,
      data: { error: { message: `Rate limit reached (${max} requests per ${Math.round(windowMs / 60000)} min). Try again shortly.` } },
    };
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

  // If the model hit the token ceiling, the JSON is truncated. Fail with a clear
  // message rather than handing the client a half-object that breaks JSON.parse.
  if (resp.ok && data?.stop_reason === "max_tokens") {
    return {
      status: 502,
      data: { error: { message: "The recipe was too long and got cut off (hit the token limit). Try again or simplify the request." } },
    };
  }

  return { status: resp.status, data };
}
