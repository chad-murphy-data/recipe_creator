// ─────────────────────────────────────────────────────────────────────────
//  Taste signal: turn the saved box into guidance for the Generator.
//
//  This is the one place the box "teaches" the generator. It only shapes the
//  DISH (which foods, which style), never the macros: code still solves the
//  grams and the palatability judge is still blind. So it touches no guardrail.
//
//  Three buckets, each capped so the prompt stays small:
//    liked    -> lean toward what made these appealing (but still bring new)
//    disliked -> steer clear of dishes like these
//    recent   -> do not reissue the same meal (variety); newest first, and it
//                excludes liked dishes so we never tell the model to vary away
//                from a hit.
//
//  The box arrives newest-first (the API lists by created_at desc), so slicing
//  keeps the most recent items.
// ─────────────────────────────────────────────────────────────────────────

const CAP = 8;

export const EMPTY_TASTE = { liked: [], disliked: [], recent: [] };

function titles(rows) {
  return rows
    .map((r) => (r && typeof r.title === "string" ? r.title.trim() : ""))
    .filter(Boolean);
}

// Drop case-insensitive duplicates, keeping first (newest) occurrence + casing.
function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const t of list) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

export function tasteProfile(box, { cap = CAP } = {}) {
  const rows = Array.isArray(box) ? box : [];
  const status = (r) => r?.status || "untried";
  const byStatus = (s) => rows.filter((r) => status(r) === s);
  return {
    liked: dedupe(titles(byStatus("liked"))).slice(0, cap),
    disliked: dedupe(titles(byStatus("disliked"))).slice(0, cap),
    // Variety pool: everything except the hits, so leaning toward a liked dish
    // is never contradicted by a "make something different" instruction.
    recent: dedupe(titles(rows.filter((r) => status(r) !== "liked"))).slice(0, cap),
  };
}

// Render the profile into a prompt fragment (leading newline, or "" if empty).
export function tastePromptSection(profile) {
  const p = profile || EMPTY_TASTE;
  const lines = [];
  if (p.liked?.length) {
    lines.push(
      `Charlie has LIKED these dishes. Lean toward what makes them appealing (their flavors, techniques, and proteins), but still design a genuinely new dish, do not just reissue them: ${p.liked.join("; ")}.`
    );
  }
  if (p.disliked?.length) {
    lines.push(
      `Charlie has DISLIKED these dishes. Steer clear of meals like them and what characterizes them: ${p.disliked.join("; ")}.`
    );
  }
  if (p.recent?.length) {
    lines.push(
      `Make something genuinely DIFFERENT from these recent recipes (vary the cuisine and the main protein, do not just rename): ${p.recent.join("; ")}.`
    );
  }
  return lines.length ? "\n" + lines.join("\n") : "";
}
