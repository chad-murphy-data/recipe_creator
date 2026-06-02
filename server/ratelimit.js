// Best-effort in-memory rate limiter (sliding window).
//
// This is the spend guard on the Anthropic proxy: even if the password leaks or
// the client loops, requests are capped. Honest limitations: the counter lives
// in the function process, so it resets on a cold start and isn't shared across
// concurrent instances. For a single-user personal app that's an adequate guard
// against runaway loops and casual hammering. The real backstop against a
// surprise bill is a monthly budget cap set in the Anthropic console; set one.
const hits = new Map(); // key -> sorted timestamps (ms)

export function rateLimit(key, max, windowMs, now = Date.now()) {
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    const retryAfterMs = Math.max(0, windowMs - (now - arr[0]));
    hits.set(key, arr);
    return { ok: false, retryAfterMs };
  }
  arr.push(now);
  hits.set(key, arr);
  return { ok: true, remaining: max - arr.length };
}

// Test helper.
export function _resetRateLimit() {
  hits.clear();
}
