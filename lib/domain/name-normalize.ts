/**
 * Normalize golfer names for matching odds / ESPN field (same idea as scraper merge).
 */
export function normalizeGolferNameKey(s: string): string {
  let t = s.normalize("NFKD").replace(/\p{M}/gu, "");
  for (const [old, rep] of [
    ["ø", "o"],
    ["Ø", "o"],
    ["æ", "ae"],
    ["Æ", "ae"],
    ["å", "a"],
    ["Å", "a"],
    ["ö", "o"],
    ["Ö", "o"],
    ["ü", "u"],
    ["Ü", "u"]
  ] as const) {
    t = t.split(old).join(rep);
  }
  t = t
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();
  // Books often omit or spell suffixes differently than ESPN roster names.
  t = t.replace(/\b(jr|sr|ii|iii|iv)\b/gi, "").replace(/\s+/g, " ").trim();
  return t;
}
