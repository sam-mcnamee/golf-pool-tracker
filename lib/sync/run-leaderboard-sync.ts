import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import {
  competitorToUpdate,
  detectEventStatus,
  extractCompetitors,
  fetchEspnLeaderboard,
  isActivelyScoring,
  normalizeName,
  resolveCompetitorTotalScore,
  type GolferUpdate
} from "@/lib/sync/espn-leaderboard-parse";

type SyncableTournament = {
  id: string;
  espn_event_id: string;
  status: string | null;
  created_at: string | null;
};

type SyncHealthRow = {
  tournament_id: string;
  espn_event_id: string;
  last_run_at: string;
  last_error: string | null;
  golfers_updated_count: number;
  total_from_detail_count: number;
  total_from_fallback_count: number;
  anomalies: Record<string, unknown>[];
  last_success_at?: string | null;
};

type ExistingGolferRow = {
  espn_athlete_id: string;
  r1_tee_at: string | null;
  r2_tee_at: string | null;
  r3_tee_at: string | null;
  r4_tee_at: string | null;
  r1_score: number | null;
  r2_score: number | null;
  r3_score: number | null;
  r4_score: number | null;
  total_score: number | null;
  today_score: number | null;
};

type GolferAuthorityRow = {
  id: string;
  name: string;
  total_score: number | null;
  today_score: number | null;
  current_round: number | null;
  thru: string | null;
  updated_at: string | null;
};

const STATUS_PRIORITY: Record<string, number> = {
  Live: 0,
  Locked: 1,
  Open: 2,
  Upcoming: 3
};

const SCORE_FIELDS = ["r1_score", "r2_score", "r3_score", "r4_score", "total_score", "today_score"] as const;
const TEE_FIELDS = ["r1_tee_at", "r2_tee_at", "r3_tee_at", "r4_tee_at"] as const;

export type RunLeaderboardSyncResult = {
  ok: boolean;
  tournamentsSynced: number;
  details: string[];
  lastSuccessAt: string | null;
};

function createdTsForSort(row: SyncableTournament): number {
  if (!row.created_at) return 0;
  const parsed = Date.parse(row.created_at);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildSyncHealthPayload(args: {
  tournamentId: string;
  espnEventId: string;
  tournamentStatus: string | null;
  updates: GolferUpdate[];
  totalFromDetailCount: number;
  totalFromFallbackCount: number;
  lastError: string | null;
  anomalies: Record<string, unknown>[];
}): SyncHealthRow {
  const nowIso = new Date().toISOString();
  const inProgress = args.updates.filter((update) => isActivelyScoring(update));
  const inProgressTotal = inProgress.length;
  const nullTotalInProgress = inProgress.filter((update) => update.totalScore === null).length;
  const nullThruInProgress = inProgress.filter((update) => !(update.thru && update.thru.trim())).length;
  const anomalies = [...args.anomalies];
  let hardFail = false;

  if (args.tournamentStatus === "Live" && inProgressTotal > 0) {
    const fracNullTotal = nullTotalInProgress / Math.max(1, inProgressTotal);
    if (fracNullTotal > 0.2) {
      anomalies.push({
        type: "too_many_null_totals_in_progress",
        count: nullTotalInProgress,
        total: inProgressTotal
      });
      hardFail = true;
    }
    const fracNullThru = nullThruInProgress / Math.max(1, inProgressTotal);
    if (fracNullThru > 0.5) {
      anomalies.push({
        type: "too_many_null_thru_in_progress",
        count: nullThruInProgress,
        total: inProgressTotal
      });
    }
  }

  const health: SyncHealthRow = {
    tournament_id: args.tournamentId,
    espn_event_id: args.espnEventId,
    last_run_at: nowIso,
    last_error: args.lastError,
    golfers_updated_count: args.updates.length,
    total_from_detail_count: args.totalFromDetailCount,
    total_from_fallback_count: args.totalFromFallbackCount,
    anomalies
  };

  if (args.lastError === null && !hardFail) {
    health.last_success_at = nowIso;
  }

  return health;
}

async function persistSyncHealth(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  health: SyncHealthRow
): Promise<void> {
  if (!("last_success_at" in health)) {
    const { data } = await supabase
      .from("sync_health")
      .select("last_success_at")
      .eq("tournament_id", health.tournament_id)
      .maybeSingle();
    if (data?.last_success_at) {
      health.last_success_at = data.last_success_at;
    }
  }

  const { error } = await supabase.from("sync_health").upsert(health, { onConflict: "tournament_id" });
  if (error) {
    console.error(JSON.stringify({ event: "sync_health_write_failed", error: error.message, tournamentId: health.tournament_id }));
  }
}

function authorityKey(row: GolferAuthorityRow): [number, number, number] {
  const hasScore = row.total_score !== null || row.today_score !== null || row.current_round !== null ? 1 : 0;
  const hasThru = row.thru && row.thru.trim() ? 1 : 0;
  const updatedAt = row.updated_at ? Date.parse(row.updated_at) : 0;
  return [hasScore, hasThru, Number.isFinite(updatedAt) ? updatedAt : 0];
}

async function relinkGolferReferences(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  tournamentId: string,
  anomalies: Record<string, unknown>[]
): Promise<void> {
  const { data: golfers, error: golfersError } = await supabase
    .from("golfers")
    .select("id,name,total_score,today_score,current_round,thru,updated_at")
    .eq("tournament_id", tournamentId);
  if (golfersError) {
    anomalies.push({ type: "auto_relink_failed", error: golfersError.message.slice(0, 240) });
    return;
  }

  const byNorm = new Map<string, GolferAuthorityRow[]>();
  for (const golfer of (golfers ?? []) as GolferAuthorityRow[]) {
    const key = normalizeName(golfer.name ?? "");
    if (!key) continue;
    const group = byNorm.get(key) ?? [];
    group.push(golfer);
    byNorm.set(key, group);
  }

  const authoritativeByNorm = new Map<string, string>();
  for (const [key, group] of byNorm.entries()) {
    const best = [...group].sort((a, b) => {
      const ak = authorityKey(a);
      const bk = authorityKey(b);
      return ak[0] - bk[0] || ak[1] - bk[1] || ak[2] - bk[2];
    })[0];
    authoritativeByNorm.set(key, best.id);
  }

  const { data: tiers, error: tiersError } = await supabase
    .from("golfer_tiers")
    .select("id,golfer_id,golfers:golfer_id(id,name)")
    .eq("tournament_id", tournamentId);
  if (tiersError) {
    anomalies.push({ type: "auto_relink_failed", error: tiersError.message.slice(0, 240) });
    return;
  }

  let relinked = 0;
  for (const tier of tiers ?? []) {
    const golfer = Array.isArray(tier.golfers) ? tier.golfers[0] : tier.golfers;
    if (!golfer || typeof golfer !== "object" || !("name" in golfer)) continue;
    const want = authoritativeByNorm.get(normalizeName(String(golfer.name ?? "")));
    if (!want) continue;
    if (tier.golfer_id === want) continue;
    const { error } = await supabase.from("golfer_tiers").update({ golfer_id: want }).eq("id", tier.id);
    if (!error) relinked += 1;
  }
  if (relinked > 0) anomalies.push({ type: "auto_relinked_golfer_tiers", count: relinked });

  const { data: oddsRows, error: oddsError } = await supabase
    .from("tournament_odds_latest")
    .select("id,golfer_id,golfer_name")
    .eq("tournament_id", tournamentId);
  if (oddsError) {
    anomalies.push({ type: "auto_relink_failed", error: oddsError.message.slice(0, 240) });
    return;
  }

  let oddsRelinked = 0;
  for (const odds of oddsRows ?? []) {
    const want = authoritativeByNorm.get(normalizeName(String(odds.golfer_name ?? "")));
    if (!want) continue;
    if (odds.golfer_id === want) continue;
    const { error } = await supabase.from("tournament_odds_latest").update({ golfer_id: want }).eq("id", odds.id);
    if (!error) oddsRelinked += 1;
  }
  if (oddsRelinked > 0) anomalies.push({ type: "auto_relinked_tournament_odds_latest", count: oddsRelinked });
}

async function listSyncableTournaments(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  tournamentId?: string
): Promise<SyncableTournament[]> {
  let query = supabase.from("tournaments").select("id,espn_event_id,status,created_at").neq("status", "Complete");
  if (tournamentId) query = query.eq("id", tournamentId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const rows = ((data ?? []) as SyncableTournament[]).filter((row) => /^\d+$/.test(String(row.espn_event_id ?? "").trim()));
  return rows.sort((a, b) => {
    const priA = STATUS_PRIORITY[String(a.status ?? "")] ?? 9;
    const priB = STATUS_PRIORITY[String(b.status ?? "")] ?? 9;
    if (priA !== priB) return priA - priB;
    return createdTsForSort(b) - createdTsForSort(a);
  });
}

async function syncLeaderboardOnce(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  tournament: SyncableTournament
): Promise<{ ok: boolean; detail: string; lastSuccessAt: string | null }> {
  const tournamentId = tournament.id;
  const espnEventId = String(tournament.espn_event_id);
  const payload = await fetchEspnLeaderboard(espnEventId);
  const competitors = extractCompetitors(payload);

  const updates: GolferUpdate[] = [];
  // DB columns: total_from_detail_count = scoreToPar, total_from_fallback_count = score.displayValue
  let totalFromDetailCount = 0;
  let totalFromFallbackCount = 0;
  for (const row of competitors) {
    const { source } = resolveCompetitorTotalScore(row);
    if (source === "scoreToPar") totalFromDetailCount += 1;
    else if (source === "scoreDisplay") totalFromFallbackCount += 1;
    const update = competitorToUpdate(row);
    if (update) updates.push(update);
  }

  const { tournamentStatus } = detectEventStatus(payload);

  if (!updates.length) {
    const health = buildSyncHealthPayload({
      tournamentId,
      espnEventId,
      tournamentStatus,
      updates: [],
      totalFromDetailCount: 0,
      totalFromFallbackCount: 0,
      lastError: `ESPN payload has no competitors yet for event ${espnEventId} (tournament_id=${tournamentId}); skipping golfer upsert.`,
      anomalies: [{ type: "empty_competitors" }]
    });
    await persistSyncHealth(supabase, health);
    return { ok: true, detail: `no competitors for ${espnEventId}`, lastSuccessAt: health.last_success_at ?? null };
  }

  const anyWeekendStarted = updates.some(
    (update) =>
      (update.currentRound !== null && update.currentRound >= 3) ||
      update.r3Score !== null ||
      update.r4Score !== null
  );
  const anyExplicitCut = updates.some(
    (update) => (update.status ?? "").trim().toUpperCase() === "CUT" && update.isCut === false
  );
  const cutComplete = anyWeekendStarted && anyExplicitCut;

  const { data: existingRows, error: existingError } = await supabase
    .from("golfers")
    .select(
      "espn_athlete_id,r1_tee_at,r2_tee_at,r3_tee_at,r4_tee_at,r1_score,r2_score,r3_score,r4_score,total_score,today_score"
    )
    .eq("tournament_id", tournamentId);
  if (existingError) throw new Error(existingError.message);

  const existingByAthlete = new Map<string, ExistingGolferRow>();
  for (const row of (existingRows ?? []) as ExistingGolferRow[]) {
    existingByAthlete.set(String(row.espn_athlete_id), row);
  }

  const golferRows = updates.map((update) => {
    const prev = existingByAthlete.get(update.espnAthleteId) ?? null;
    const row: Record<string, unknown> = {
      tournament_id: tournamentId,
      espn_athlete_id: update.espnAthleteId,
      name: update.name,
      current_round: update.currentRound,
      thru: update.thru,
      status: update.status,
      is_cut: update.isCut
    };

    const scoreMap: Record<(typeof SCORE_FIELDS)[number], number | null> = {
      r1_score: update.r1Score,
      r2_score: update.r2Score,
      r3_score: update.r3Score,
      r4_score: update.r4Score,
      total_score: update.totalScore,
      today_score: update.todayScore
    };
    for (const key of SCORE_FIELDS) {
      const value = scoreMap[key] ?? prev?.[key] ?? null;
      if (value !== null) row[key] = value;
    }

    const teeMap: Record<(typeof TEE_FIELDS)[number], string | null> = {
      r1_tee_at: update.r1TeeAt,
      r2_tee_at: update.r2TeeAt,
      r3_tee_at: update.r3TeeAt,
      r4_tee_at: update.r4TeeAt
    };
    for (const key of TEE_FIELDS) {
      const value = teeMap[key] ?? prev?.[key] ?? null;
      if (value !== null) row[key] = value;
    }

    return row;
  });

  const { error: upsertError } = await supabase
    .from("golfers")
    .upsert(golferRows, { onConflict: "tournament_id,espn_athlete_id" });
  if (upsertError) throw new Error(upsertError.message);

  const anomalies: Record<string, unknown>[] = [];
  await relinkGolferReferences(supabase, tournamentId, anomalies);

  const tournamentPatch: Record<string, unknown> = {};
  if (tournamentStatus === "Live" || tournamentStatus === "Complete") {
    tournamentPatch.status = tournamentStatus;
  }
  if (cutComplete) tournamentPatch.cut_complete = true;
  if (Object.keys(tournamentPatch).length > 0) {
    const { error: tournamentError } = await supabase.from("tournaments").update(tournamentPatch).eq("id", tournamentId);
    if (tournamentError) throw new Error(tournamentError.message);
  }

  const health = buildSyncHealthPayload({
    tournamentId,
    espnEventId,
    tournamentStatus,
    updates,
    totalFromDetailCount,
    totalFromFallbackCount,
    lastError: null,
    anomalies
  });
  await persistSyncHealth(supabase, health);

  return {
    ok: true,
    detail: `synced ${updates.length} golfers for ${tournamentId}`,
    lastSuccessAt: health.last_success_at ?? null
  };
}

export async function runLeaderboardSync(options?: { tournamentId?: string }): Promise<RunLeaderboardSyncResult> {
  const supabase = createSupabaseServiceRoleClient();
  const targets = await listSyncableTournaments(supabase, options?.tournamentId);
  if (!targets.length) {
    return { ok: false, tournamentsSynced: 0, details: ["no syncable tournaments"], lastSuccessAt: null };
  }

  const details: string[] = [];
  let ok = true;
  let lastSuccessAt: string | null = null;

  for (const tournament of targets) {
    try {
      const result = await syncLeaderboardOnce(supabase, tournament);
      details.push(result.detail);
      if (!result.ok) ok = false;
      if (result.lastSuccessAt) lastSuccessAt = result.lastSuccessAt;
    } catch (error) {
      ok = false;
      details.push(`${tournament.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { ok, tournamentsSynced: targets.length, details, lastSuccessAt };
}
