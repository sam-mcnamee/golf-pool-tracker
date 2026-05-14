import { normalizeGolferNameKey } from "@/lib/domain/name-normalize";
import { compareAmericanOddsFavoriteFirst, parseOddsToAmerican } from "@/lib/domain/odds-normalize";

export const PLACEHOLDER_HEADSHOT_URL = "/golfer-placeholder.png";

export type FirstTeamAllChodeCandidate = {
  tier: number;
  golferId: string;
  name: string;
  totalScore: number | null;
  oddsText: string | null;
  espnAthleteId: string | null;
};

export type FirstTeamAllChodeSlot = {
  tier: number;
  golferId: string;
  name: string;
  totalScore: number;
  oddsText: string | null;
  headshotUrl: string;
};

export type HeadshotRow = {
  normalized_name: string;
  espn_athlete_id: string | null;
  headshot_url: string;
};

export type HeadshotLookup = {
  byEspnAthleteId: Map<string, string>;
  byNormalizedName: Map<string, string>;
};

export function buildHeadshotLookup(rows: HeadshotRow[]): HeadshotLookup {
  const byEspnAthleteId = new Map<string, string>();
  const byNormalizedName = new Map<string, string>();

  for (const row of rows) {
    if (row.espn_athlete_id) {
      byEspnAthleteId.set(row.espn_athlete_id, row.headshot_url);
    }
    byNormalizedName.set(row.normalized_name, row.headshot_url);
  }

  return { byEspnAthleteId, byNormalizedName };
}

export function resolveHeadshotUrl(
  lookup: HeadshotLookup,
  candidate: Pick<FirstTeamAllChodeCandidate, "name" | "espnAthleteId">
): string {
  if (candidate.espnAthleteId) {
    const byEspn = lookup.byEspnAthleteId.get(candidate.espnAthleteId);
    if (byEspn) return byEspn;
  }

  const byName = lookup.byNormalizedName.get(normalizeGolferNameKey(candidate.name));
  if (byName) return byName;

  return PLACEHOLDER_HEADSHOT_URL;
}

function seededTieBreakIndex(seed: string, count: number): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % count;
}

function pickWorstGolferForTier(
  tier: number,
  candidates: FirstTeamAllChodeCandidate[],
  tournamentId: string
): FirstTeamAllChodeCandidate | null {
  const scored = candidates.filter((c) => typeof c.totalScore === "number");
  if (!scored.length) return null;

  const worstScore = Math.max(...scored.map((c) => c.totalScore as number));
  const tiedOnScore = scored.filter((c) => c.totalScore === worstScore);

  const withParsedOdds = tiedOnScore.map((c) => ({
    candidate: c,
    american: c.oddsText ? parseOddsToAmerican(c.oddsText)?.american ?? null : null
  }));

  withParsedOdds.sort((a, b) => {
    const aHas = a.american !== null;
    const bHas = b.american !== null;
    if (aHas !== bHas) return aHas ? -1 : 1;
    if (a.american !== null && b.american !== null) {
      const cmp = compareAmericanOddsFavoriteFirst(a.american, b.american);
      if (cmp !== 0) return cmp;
    }
    return a.candidate.golferId.localeCompare(b.candidate.golferId);
  });

  const bestFavorite = withParsedOdds[0]?.american ?? null;
  const tiedOnOdds = withParsedOdds.filter(
    (row) => row.american === bestFavorite || (row.american === null && bestFavorite === null)
  );

  if (tiedOnOdds.length === 1) {
    return tiedOnOdds[0].candidate;
  }

  const sortedIds = tiedOnOdds.map((row) => row.candidate.golferId).sort();
  const seed = `${tournamentId}:${tier}:${sortedIds.join(",")}`;
  const index = seededTieBreakIndex(seed, tiedOnOdds.length);
  return tiedOnOdds[index].candidate;
}

export function selectFirstTeamAllChodeByTier(
  candidates: FirstTeamAllChodeCandidate[],
  options: { tournamentId: string }
): (FirstTeamAllChodeSlot | null)[] {
  const byTier = new Map<number, FirstTeamAllChodeCandidate[]>();

  for (const candidate of candidates) {
    const tierCandidates = byTier.get(candidate.tier) ?? [];
    tierCandidates.push(candidate);
    byTier.set(candidate.tier, tierCandidates);
  }

  return Array.from({ length: 7 }, (_, index) => {
    const tier = index + 1;
    const winner = pickWorstGolferForTier(tier, byTier.get(tier) ?? [], options.tournamentId);
    if (!winner || typeof winner.totalScore !== "number") return null;

    return {
      tier,
      golferId: winner.golferId,
      name: winner.name,
      totalScore: winner.totalScore,
      oddsText: winner.oddsText,
      headshotUrl: PLACEHOLDER_HEADSHOT_URL
    };
  });
}

export function attachHeadshotsToSlots(
  slots: (FirstTeamAllChodeSlot | null)[],
  lookup: HeadshotLookup,
  candidates: FirstTeamAllChodeCandidate[]
): (FirstTeamAllChodeSlot | null)[] {
  const candidateById = new Map(candidates.map((c) => [c.golferId, c]));

  return slots.map((slot) => {
    if (!slot) return null;
    const candidate = candidateById.get(slot.golferId);
    if (!candidate) return slot;

    return {
      ...slot,
      headshotUrl: resolveHeadshotUrl(lookup, candidate)
    };
  });
}
