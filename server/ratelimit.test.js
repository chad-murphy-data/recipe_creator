import { test } from "node:test";
import assert from "node:assert/strict";
import { rateLimit, _resetRateLimit } from "./ratelimit.js";

test("allows up to max within the window, then blocks", () => {
  _resetRateLimit();
  const t0 = 1000;
  for (let i = 0; i < 3; i++) {
    assert.equal(rateLimit("k", 3, 1000, t0 + i).ok, true);
  }
  const blocked = rateLimit("k", 3, 1000, t0 + 4);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterMs > 0);
});

test("window slides: old hits expire", () => {
  _resetRateLimit();
  assert.equal(rateLimit("k", 1, 1000, 0).ok, true);
  assert.equal(rateLimit("k", 1, 1000, 500).ok, false); // still in window
  assert.equal(rateLimit("k", 1, 1000, 1500).ok, true); // first hit expired
});

test("keys are independent", () => {
  _resetRateLimit();
  assert.equal(rateLimit("a", 1, 1000, 0).ok, true);
  assert.equal(rateLimit("b", 1, 1000, 0).ok, true); // different key, not blocked
  assert.equal(rateLimit("a", 1, 1000, 0).ok, false);
});
