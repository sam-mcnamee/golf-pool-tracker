import Image from "next/image";
import Link from "next/link";
import { FirstTeamAllChode } from "@/components/first-team-all-chode";
import {
  attachHeadshotsToSlots,
  buildHeadshotLookup,
  selectFirstTeamAllChodeByTier,
  type FirstTeamAllChodeCandidate
} from "@/lib/domain/first-team-all-chode";
import { sortTournamentsByScheduleDesc } from "@/lib/domain/tournament-sort";
import { isPlayerTiersMode } from "@/lib/domain/tournament-status";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const tournamentListSelect =
  "id,name,status,starts_at,first_tee_at,lock_at,open_at,created_at" as const;

type GolferTierRow = {
  tier: number;
  odds_text: string | null;
  golfers:
    | {
        id: string;
        name: string;
        espn_athlete_id: string;
        total_score: number | null;
      }
    | {
        id: string;
        name: string;
        espn_athlete_id: string;
        total_score: number | null;
      }[]
    | null;
};

function mapGolferTierRows(rows: GolferTierRow[] | null): FirstTeamAllChodeCandidate[] {
  const candidates: FirstTeamAllChodeCandidate[] = [];

  for (const row of rows ?? []) {
    const golfer0 = row.golfers;
    const golfer = Array.isArray(golfer0) ? golfer0[0] ?? null : golfer0;
    if (!golfer) continue;

    candidates.push({
      tier: row.tier,
      golferId: golfer.id,
      name: golfer.name,
      totalScore: golfer.total_score,
      oddsText: row.odds_text,
      espnAthleteId: golfer.espn_athlete_id
    });
  }

  return candidates;
}

export default async function HomePage() {
  const supabase = await createSupabaseServerClient();

  const { data: activeRows } = await supabase
    .from("tournaments")
    .select(tournamentListSelect)
    .neq("status", "Complete");

  let sorted = sortTournamentsByScheduleDesc(activeRows ?? []);
  if (!sorted.length) {
    const { data: allRows } = await supabase.from("tournaments").select(tournamentListSelect);
    sorted = sortTournamentsByScheduleDesc(allRows ?? []);
  }

  const t = sorted[0];
  const { data: snapshot } = t
    ? await supabase.from("odds_snapshots").select("id").eq("tournament_id", t.id).maybeSingle()
    : { data: null as { id: string } | null };
  const hasFrozenTiers = Boolean(snapshot?.id);
  const showPlayerTiers = t ? isPlayerTiersMode(t.status) : false;
  const statusLabel = t ? (hasFrozenTiers ? "Open" : "Formulating Tiers") : null;

  let allChodeSlots: ReturnType<typeof attachHeadshotsToSlots> | null = null;

  if (t && hasFrozenTiers) {
    const [{ data: tierRows }, { data: headshotRows }] = await Promise.all([
      supabase
        .from("golfer_tiers")
        .select("tier, odds_text, golfers:golfer_id(id, name, espn_athlete_id, total_score)")
        .eq("tournament_id", t.id),
      supabase.from("golfer_headshots").select("normalized_name, espn_athlete_id, headshot_url")
    ]);

    const candidates = mapGolferTierRows((tierRows as GolferTierRow[] | null) ?? null);
    const lookup = buildHeadshotLookup(headshotRows ?? []);
    const selected = selectFirstTeamAllChodeByTier(candidates, { tournamentId: t.id });
    allChodeSlots = attachHeadshotsToSlots(selected, lookup, candidates);
  }

  return (
    <div className="space-y-10">
      <section className="rounded-2xl border border-club-gold/30 bg-gradient-to-b from-club-cream to-white px-6 py-10 shadow-sm sm:px-10">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 text-center sm:flex-row sm:items-center sm:text-left">
          <Image
            src="/logo.png"
            alt="Chode Emporium Golf Pool crest"
            width={280}
            height={153}
            priority
            className="h-auto w-full max-w-[260px] shrink-0 rounded-xl border-2 border-club-gold/50 bg-white object-contain shadow-md sm:max-w-[240px]"
            sizes="(max-width: 640px) 260px, 240px"
          />
          <div className="min-w-0 space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight text-club-navy sm:text-4xl">Chode Emporium Golf Pool</h1>
            <p className="text-pretty text-sm text-slate-600 sm:text-base">This week&apos;s pool — sign in, lock your picks before tee time, track the board live.</p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-3xl">
        <Card className="border-club-gold/30 shadow-md">
          <CardHeader className="border-b border-club-gold/15 bg-club-cream/40 pb-4">
            <CardTitle className="text-club-navy">Current tournament</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-6 pt-6">
            {t ? (
              <>
                <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-2">
                    <div className="text-lg font-semibold text-club-navy">{t.name}</div>
                    <div className="text-sm text-slate-600">
                      Status: <span className="font-medium text-club-navy">{statusLabel}</span>
                    </div>
                    <p className="text-sm text-slate-600">
                      {showPlayerTiers
                        ? "Player tiers are locked. Follow live golfer totals by tier and compare pool picks to see the best and worst values."
                        : "\"Make Picks\" functionality will open Tuesday after player tiers are set. Users will be able to submit and modify picks until the first tee time on Thursday."}
                    </p>
                  </div>
                  <div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-[220px]">
                    <Button asChild className="w-full bg-club-navy text-white hover:bg-club-navy/90">
                      <Link href={`/t/${t.id}/picks`}>{showPlayerTiers ? "Player tiers" : "Make picks"}</Link>
                    </Button>
                    <Button
                      asChild
                      variant="secondary"
                      className="w-full border border-club-gold/50 bg-white text-club-navy hover:bg-club-cream"
                    >
                      <Link href={`/t/${t.id}/leaderboard`}>Leaderboard</Link>
                    </Button>
                    <Link
                      href="/team-stats"
                      className="text-center text-sm font-medium text-club-navy underline decoration-club-gold/60 underline-offset-2 hover:decoration-club-gold sm:text-left"
                    >
                      Team Stats
                    </Link>
                  </div>
                </div>
                {allChodeSlots ? <FirstTeamAllChode slots={allChodeSlots} /> : null}
              </>
            ) : (
              <div className="space-y-3 text-sm text-slate-600">
                <p>No tournaments yet. Create one via the admin page after you apply the Supabase schema.</p>
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
