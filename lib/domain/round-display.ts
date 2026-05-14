export type RoundPickDisplay = {
  current_round: number | null;
  r1_score: number | null;
  r2_score: number | null;
  r3_score: number | null;
  r4_score: number | null;
  r1_tee_at: string | null;
  r2_tee_at: string | null;
  r3_tee_at: string | null;
  r4_tee_at: string | null;
  is_cut: boolean | null;
};

export function roundScoreFor(p: RoundPickDisplay, round: 1 | 2 | 3 | 4): number | null {
  return round === 1 ? p.r1_score : round === 2 ? p.r2_score : round === 3 ? p.r3_score : p.r4_score;
}

export function roundTeeAtFor(p: RoundPickDisplay, round: 1 | 2 | 3 | 4): string | null {
  return round === 1 ? p.r1_tee_at : round === 2 ? p.r2_tee_at : round === 3 ? p.r3_tee_at : p.r4_tee_at;
}

export function hasRoundTeeStarted(teeAt: string | null, nowMs: number): boolean {
  if (!teeAt) return false;
  const teeMs = Date.parse(teeAt);
  return Number.isFinite(teeMs) && nowMs >= teeMs;
}

export function formatRoundRelPar(value: number): string {
  if (value === 0) return "E";
  if (value > 0) return `+${value}`;
  return String(value);
}

export function formatRoundCell(p: RoundPickDisplay, round: 1 | 2 | 3 | 4, nowMs: number = Date.now()): string {
  const stored = roundScoreFor(p, round);
  if (round >= 3 && p.is_cut === false && stored === null) return "MC";
  if (typeof stored === "number") return formatRoundRelPar(stored);

  const isLiveColumn = p.current_round === round && p.is_cut !== false;
  if (!isLiveColumn) return "-";
  if (!hasRoundTeeStarted(roundTeeAtFor(p, round), nowMs)) return "-";
  return "-";
}

export function roundCellClassName(p: RoundPickDisplay, round: 1 | 2 | 3 | 4): string {
  const stored = roundScoreFor(p, round);
  if (round >= 3 && p.is_cut === false && stored === null) return "text-red-700 font-semibold tabular-nums";
  return "tabular-nums text-slate-800";
}
