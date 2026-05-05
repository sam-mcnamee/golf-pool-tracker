export type ParsedAmericanOdds = { american: number; source: "american" | "fractional" };

function toIntSafe(n: number): number | null {
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  if (!Number.isFinite(i)) return null;
  return i;
}

/**
 * Parse common betting odds formats and normalize to American odds.
 *
 * Supported:
 * - American: "+600", "600", "-120"
 * - Fractional: "6/1", "12-1", "13.5/1"
 */
export function parseOddsToAmerican(s: string): ParsedAmericanOdds | null {
  const t = s.trim();
  if (!t) return null;

  const frac = t.match(/^(\d+(?:\.\d+)?)\s*[\/-]\s*(\d+(?:\.\d+)?)$/);
  if (frac) {
    const num = Number(frac[1]);
    const den = Number(frac[2]);
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;

    // Fractional odds a/b:
    // - If a >= b, American is positive: (a/b)*100
    // - If a <  b, American is negative: -(100*b)/a
    const american = num >= den ? (num / den) * 100 : (-100 * den) / num;
    const ai = toIntSafe(Math.round(american));
    if (ai === null || ai === 0) return null;
    return { american: ai, source: "fractional" };
  }

  // Strip currency/symbols but keep sign.
  const cleaned = t.replace(/[^\d.+-]/g, "");
  if (!cleaned) return null;

  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  const ai = toIntSafe(Math.round(n));
  if (ai === null || ai === 0) return null;
  return { american: ai, source: "american" };
}

/**
 * Convert American odds to implied probability in (0,1].
 * Higher probability = stronger favorite.
 */
export function impliedProbabilityFromAmerican(american: number): number | null {
  if (!Number.isFinite(american) || american === 0) return null;
  if (american < 0) {
    const a = Math.abs(american);
    return a / (a + 100);
  }
  return 100 / (american + 100);
}

/** Sort helper: favorites first, then stable by numeric American odds. */
export function compareAmericanOddsFavoriteFirst(a: number, b: number): number {
  const pa = impliedProbabilityFromAmerican(a);
  const pb = impliedProbabilityFromAmerican(b);
  if (pa != null && pb != null && pa !== pb) return pb - pa;
  // Fallback: smaller abs tends to be more likely, but keep deterministic.
  const aa = Math.abs(a);
  const ab = Math.abs(b);
  if (aa !== ab) return aa - ab;
  return a - b;
}

