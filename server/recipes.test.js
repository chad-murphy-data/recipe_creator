import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRecipes } from "./recipes.js";

const ENV = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_KEY: "svc" };

function stubFetch(capture) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    capture.url = url;
    capture.init = init;
    return { ok: true, status: 200, json: async () => capture.response ?? [{ id: "1" }] };
  };
  return () => { globalThis.fetch = orig; };
}

test("list issues a GET ordered by created_at", async () => {
  const cap = {};
  const restore = stubFetch(cap);
  try {
    const r = await handleRecipes({ action: "list" }, ENV);
    assert.equal(r.status, 200);
    assert.match(cap.url, /recipes\?select=\*&order=created_at\.desc/);
  } finally { restore(); }
});

test("create strips non-whitelisted fields", async () => {
  const cap = {};
  const restore = stubFetch(cap);
  try {
    await handleRecipes(
      { action: "create", record: { title: "X", status: "liked", id: "hax", evil: 1, created_at: "spoof" } },
      ENV
    );
    const sent = JSON.parse(cap.init.body);
    assert.deepEqual(Object.keys(sent).sort(), ["status", "title"]);
    assert.equal(sent.id, undefined);
    assert.equal(sent.evil, undefined);
  } finally { restore(); }
});

test("update requires an id", async () => {
  const r = await handleRecipes({ action: "update", patch: { status: "liked" } }, ENV);
  assert.equal(r.status, 400);
});

test("update targets the row and whitelists the patch", async () => {
  const cap = {};
  const restore = stubFetch(cap);
  try {
    await handleRecipes({ action: "update", id: "abc", patch: { status: "liked", hacker: true } }, ENV);
    assert.match(cap.url, /id=eq\.abc/);
    assert.equal(cap.init.method, "PATCH");
    const sent = JSON.parse(cap.init.body);
    assert.deepEqual(sent, { status: "liked" });
  } finally { restore(); }
});

test("delete requires an id and issues DELETE", async () => {
  const bad = await handleRecipes({ action: "delete" }, ENV);
  assert.equal(bad.status, 400);

  const cap = {};
  const restore = stubFetch(cap);
  try {
    const r = await handleRecipes({ action: "delete", id: "z9" }, ENV);
    assert.equal(r.status, 200);
    assert.equal(cap.init.method, "DELETE");
    assert.match(cap.url, /id=eq\.z9/);
  } finally { restore(); }
});

test("uses the service key when present, Authorization bearer set", async () => {
  const cap = {};
  const restore = stubFetch(cap);
  try {
    await handleRecipes({ action: "list" }, ENV);
    assert.equal(cap.init.headers.apikey, "svc");
    assert.equal(cap.init.headers.Authorization, "Bearer svc");
  } finally { restore(); }
});

test("falls back to a configured public key when no service key is set", async () => {
  const cap = {};
  const restore = stubFetch(cap);
  try {
    await handleRecipes({ action: "list" }, { SUPABASE_URL: ENV.SUPABASE_URL, VITE_SUPABASE_ANON_KEY: "pub" });
    assert.equal(cap.init.headers.apikey, "pub");
  } finally { restore(); }
});

test("falls back to baked URL + publishable key when nothing is configured", async () => {
  const cap = {};
  const restore = stubFetch(cap);
  try {
    await handleRecipes({ action: "list" }, {}); // empty env
    assert.match(cap.url, /^https:\/\/nwgxyytowbluuykbdcfc\.supabase\.co\/rest\/v1\//);
    assert.match(cap.init.headers.apikey, /^sb_publishable_/);
  } finally { restore(); }
});

test("unknown action is a 400", async () => {
  const r = await handleRecipes({ action: "frobnicate" }, ENV);
  assert.equal(r.status, 400);
});
