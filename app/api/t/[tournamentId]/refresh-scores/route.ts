import { NextResponse } from "next/server";

import { isSyncStale, triggerLeaderboardSync } from "@/lib/sync/leaderboard-sync-trigger";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(_request: Request, { params }: { params: Promise<{ tournamentId: string }> }) {
  const { tournamentId } = await params;
  const supabase = createSupabaseServiceRoleClient();

  const { data: tournament, error: tournamentError } = await supabase
    .from("tournaments")
    .select("status")
    .eq("id", tournamentId)
    .maybeSingle();
  if (tournamentError) {
    return NextResponse.json({ ok: false, error: tournamentError.message }, { status: 500 });
  }
  if (!tournament) {
    return NextResponse.json({ ok: false, error: "Tournament not found" }, { status: 404 });
  }
  if (tournament.status !== "Live") {
    return NextResponse.json({ ok: false, error: "Tournament is not live" }, { status: 409 });
  }

  const { data: healthRow } = await supabase
    .from("sync_health")
    .select("last_success_at,last_run_at")
    .eq("tournament_id", tournamentId)
    .maybeSingle();

  const lastSuccessAt = healthRow?.last_success_at ?? healthRow?.last_run_at ?? null;
  if (!isSyncStale(lastSuccessAt, 5)) {
    return NextResponse.json({
      ok: true,
      throttled: true,
      last_success_at: lastSuccessAt,
      detail: "sync skipped: last success within 5 minutes"
    });
  }

  const result = await triggerLeaderboardSync("live_refresh_api", { tournamentId });
  const status = result.ok ? 200 : 503;
  return NextResponse.json(
    {
      ok: result.ok,
      last_success_at: result.lastSuccessAt ?? lastSuccessAt,
      detail: result.detail,
      mode: result.mode
    },
    { status }
  );
}
