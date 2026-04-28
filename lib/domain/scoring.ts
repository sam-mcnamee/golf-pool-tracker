export type PickedGolfer = {
  name: string;
  total_score: number | null;
  is_cut: boolean | null;
  status: string | null;
};

export function computeBest4(picks: PickedGolfer[]) {
  const numericScores = picks.map((p) => p.total_score).filter((s): s is number => typeof s === "number");
  numericScores.sort((a, b) => a - b);
  const best4 = numericScores.slice(0, 4);
  const sum = best4.reduce((acc, s) => acc + s, 0);
  return { sum: best4.length ? sum : null, counted: best4.length };
}

export function computeMadeCutCount(picks: PickedGolfer[]) {
  return picks.filter((p) => p.is_cut === true).length;
}

