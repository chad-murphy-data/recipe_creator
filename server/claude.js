// Shared Anthropic proxy logic, used by BOTH the Vite dev middleware
// (local `npm run dev`) and the Netlify function (production). The API key is
// passed in by the caller from a server-side env var and never reaches the
// browser. The model and token cap are fixed here so the endpoint can't be
// repurposed as an open-ended Anthropic relay.
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1000;
const ANTHROPIC_VERSION = "2023-06-01";

export async function callAnthropic(body, apiKey) {
  const { system, user, messages } = body || {};
  const msgs = Array.isArray(messages) ? messages : [{ role: "user", content: user }];

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: msgs,
    }),
  });

  const data = await resp.json();
  return { status: resp.status, data };
}
