import { test } from "node:test";
import assert from "node:assert/strict";
import { handleClaudeRequest } from "./claude.js";
import { _resetRateLimit } from "./ratelimit.js";

const ENV = { ANTHROPIC_API_KEY: "sk-test", APP_PASSWORD: "" };

function stubFetch(response) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => response });
  return () => { globalThis.fetch = orig; };
}

test("password gate rejects a wrong password before calling the model", async () => {
  const r = await handleClaudeRequest({ user: "hi" }, "nope", { ...ENV, APP_PASSWORD: "secret" });
  assert.equal(r.status, 401);
});

test("auth_check returns ok without spending a model call", async () => {
  const r = await handleClaudeRequest({ auth_check: true }, "secret", { ...ENV, APP_PASSWORD: "secret" });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

test("missing API key is a clear 500", async () => {
  const r = await handleClaudeRequest({ user: "hi" }, "", { APP_PASSWORD: "" });
  assert.equal(r.status, 500);
});

test("a truncated (max_tokens) response becomes a clear 502, not a half-object", async () => {
  _resetRateLimit();
  const restore = stubFetch({
    stop_reason: "max_tokens",
    content: [{ type: "text", text: '{"title":"half a recipe' }],
  });
  try {
    const r = await handleClaudeRequest({ user: "make a recipe" }, "", ENV);
    assert.equal(r.status, 502);
    assert.match(r.data.error.message, /cut off|token limit/i);
  } finally {
    restore();
  }
});

test("a normal completed response passes through", async () => {
  _resetRateLimit();
  const restore = stubFetch({
    stop_reason: "end_turn",
    content: [{ type: "text", text: '{"title":"ok"}' }],
  });
  try {
    const r = await handleClaudeRequest({ user: "make a recipe" }, "", ENV);
    assert.equal(r.status, 200);
    assert.equal(r.data.content[0].text, '{"title":"ok"}');
  } finally {
    restore();
  }
});

test("spend cap returns 429 once the limit is exceeded", async () => {
  _resetRateLimit();
  const restore = stubFetch({ stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] });
  const env = { ...ENV, CLAUDE_RATE_MAX: 3, CLAUDE_RATE_WINDOW_S: 600 };
  try {
    for (let i = 0; i < 3; i++) {
      const ok = await handleClaudeRequest({ user: "x" }, "", env);
      assert.equal(ok.status, 200);
    }
    const blocked = await handleClaudeRequest({ user: "x" }, "", env);
    assert.equal(blocked.status, 429);
    assert.match(blocked.data.error.message, /rate limit/i);
  } finally {
    restore();
  }
});

test("auth_check is not rate limited", async () => {
  _resetRateLimit();
  const env = { ...ENV, CLAUDE_RATE_MAX: 1, CLAUDE_RATE_WINDOW_S: 600 };
  for (let i = 0; i < 5; i++) {
    const r = await handleClaudeRequest({ auth_check: true }, "", env);
    assert.equal(r.status, 200);
  }
});
