export function scoreClass(value: number | null): string {
  if (value === null) return "text-slate-500";
  if (value < 0) return "text-emerald-700";
  if (value > 0) return "text-red-700";
  return "text-slate-700";
}

export function formatScore(value: number | null): string {
  if (value === null) return "-";
  if (value > 0) return `+${value}`;
  return String(value);
}

export function formatGolferTotalScore(totalScore: number | null, isCut: boolean | null): string {
  if (isCut === false && totalScore === null) return "MC";
  return formatScore(totalScore);
}

export function golferTotalScoreClass(totalScore: number | null, isCut: boolean | null): string {
  if (isCut === false && totalScore === null) return "text-red-700";
  return scoreClass(totalScore);
}
