import test from "node:test";
import assert from "node:assert/strict";
import { tasteProfile, tastePromptSection, EMPTY_TASTE } from "./taste.js";

test("buckets liked, disliked, and recent (non-liked) by status", () => {
  const box = [
    { title: "Miso Chicken", status: "liked" },
    { title: "Tofu Tacos", status: "disliked" },
    { title: "Sheet-pan Salmon", status: "untried" },
  ];
  const p = tasteProfile(box);
  assert.deepEqual(p.liked, ["Miso Chicken"]);
  assert.deepEqual(p.disliked, ["Tofu Tacos"]);
  // recent excludes liked, so we never tell the model to vary away from a hit
  assert.ok(!p.recent.includes("Miso Chicken"));
  assert.ok(p.recent.includes("Sheet-pan Salmon"));
  assert.ok(p.recent.includes("Tofu Tacos"));
});

test("missing status counts as untried", () => {
  const p = tasteProfile([{ title: "Mystery Bowl" }]);
  assert.deepEqual(p.liked, []);
  assert.deepEqual(p.disliked, []);
  assert.deepEqual(p.recent, ["Mystery Bowl"]);
});

test("dedupes by title (case-insensitive) and trims whitespace", () => {
  const p = tasteProfile([
    { title: "  Pad Thai ", status: "liked" },
    { title: "pad thai", status: "liked" },
  ]);
  assert.deepEqual(p.liked, ["Pad Thai"]);
});

test("caps each bucket", () => {
  const liked = Array.from({ length: 20 }, (_, i) => ({ title: `L${i}`, status: "liked" }));
  assert.equal(tasteProfile(liked, { cap: 8 }).liked.length, 8);
});

test("keeps newest-first order (box is created_at desc)", () => {
  const box = [
    { title: "Newest", status: "untried" },
    { title: "Older", status: "untried" },
  ];
  assert.deepEqual(tasteProfile(box).recent, ["Newest", "Older"]);
});

test("ignores rows without a usable title", () => {
  const p = tasteProfile([{ status: "liked" }, { title: "  ", status: "liked" }, { title: "Real", status: "liked" }]);
  assert.deepEqual(p.liked, ["Real"]);
});

test("prompt section is empty when nothing is saved", () => {
  assert.equal(tastePromptSection(EMPTY_TASTE), "");
  assert.equal(tastePromptSection(tasteProfile([])), "");
});

test("prompt section names liked, disliked, and recent", () => {
  const s = tastePromptSection({
    liked: ["Miso Chicken"],
    disliked: ["Tofu Tacos"],
    recent: ["Sheet-pan Salmon"],
  });
  assert.match(s, /LIKED/);
  assert.match(s, /Miso Chicken/);
  assert.match(s, /DISLIKED/);
  assert.match(s, /Tofu Tacos/);
  assert.match(s, /DIFFERENT/);
  assert.match(s, /Sheet-pan Salmon/);
});

test("handles non-array input safely", () => {
  assert.deepEqual(tasteProfile(null), EMPTY_TASTE);
  assert.deepEqual(tasteProfile(undefined), EMPTY_TASTE);
});
