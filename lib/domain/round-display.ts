export type RoundPickDisplay = {
  total_score: number | null;
  current_round: number | null;
  r1_score: number | null;
  r2_score: number | null;
  r3_score: number | null;
  r4_score: number | null;
  is_cut: boolean | null;
  thru: string | null;
  status?: string | null;
};

export function roundScoreFor(p: RoundPickDisplay, round: 1 | 2 | 3 | 4): number | null {
  return round === 1 ? p.r1_score : round === 2 ? p.r2_score : round === 3 ? p.r3_score : p.r4_score;
}

/** Mirrors ESPN sync `_thru_state` in scraper/espn_leaderboard_sync.py. */
export function thruStateFromEspn(thru: string | null | undefined): "not_started" | "in_progress" | "finished" | "unknown" {
  if (!thru) return "unknown";
  const t = thru.trim().toUpperCase();
  if (!t) return "unknown";
  if (t === "F" || t === "FIN" || t === "FINAL") return "finished";
  if (t.startsWith("F")) return "finished";
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    if (n >= 1 && n <= 18) return "in_progress";
  }
  if (t.includes(":") && (t.includes("AM") || t.includes("PM"))) return "not_started";
  return "unknown";
}

export function isRoundEndedForGolfer(
  p: RoundPickDisplay,
  round: 1 | 2 | 3 | 4,
  tournamentStatus: string
): boolean {
  if (tournamentStatus === "Complete") return true;
  const stored = roundScoreFor(p, round);
  if (typeof stored === "number") return true;
  return p.current_round === round && thruStateFromEspn(p.thru) === "finished";
}

export function isRoundInProgressForGolfer(
  p: RoundPickDisplay,
  round: 1 | 2 | 3 | 4,
  tournamentStatus: string
): boolean {
  if (tournamentStatus !== "Live") return false;
  if (p.current_round !== round) return false;
  if (p.is_cut === false) return false;
  return !isRoundEndedForGolfer(p, round, tournamentStatus);
}

export function derivedRoundScoreRelPar(p: RoundPickDisplay, round: 1 | 2 | 3 | 4): number | null {
  const stored = roundScoreFor(p, round);
  if (typeof stored === "number") return stored;
  if (typeof p.total_score !== "number") return null;
  let priorSum = 0;
  for (let r = 1; r < round; r++) {
    const prior = roundScoreFor(p, r as 1 | 2 | 3 | 4);
    if (typeof prior !== "number") return null;
    priorSum += prior;
  }
  return p.total_score - priorSum;
}

function formatRoundScore(value: number | null): string {
  if (value === null) return "-";
  if (value > 0) return `+${value}`;
  return String(value);
}

export function formatRoundCell(p: RoundPickDisplay, round: 1 | 2 | 3 | 4, tournamentStatus: string): string {
  const stored = roundScoreFor(p, round);
  if (round >= 3 && p.is_cut === false && stored === null) return "MC";
  const score = derivedRoundScoreRelPar(p, round);
  if (score !== null) return formatRoundScore(score);
  if (isRoundInProgressForGolfer(p, round, tournamentStatus)) return "IP";
  return "-";
}

export function roundCellClassName(p: RoundPickDisplay, round: 1 | 2 | 3 | 4, tournamentStatus: string): string {
  const stored = roundScoreFor(p, round);
  if (round >= 3 && p.is_cut === false && stored === null) return "text-red-700 font-semibold tabular-nums";
  if (isRoundInProgressForGolfer(p, round, tournamentStatus) && derivedRoundScoreRelPar(p, round) === null) {
    return "tabular-nums font-semibold text-slate-500";
  }
  return "tabular-nums text-slate-800";
}
