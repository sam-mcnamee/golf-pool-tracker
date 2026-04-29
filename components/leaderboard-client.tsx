"use client";

import { useEffect, useMemo, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  computeBest4,
  computeMadeCutCount,
  tiebreakDistanceVsActual,
  type PickedGolfer
} from "@/lib/domain/scoring";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type RowPick = {
  golfer_tiers:
    | {
        tier: number;
        odds_text: string | null;
        golfers:
          | {
              name: string;
              total_score: number | null;
              is_cut: boolean | null;
              status: string | null;
              r1_score: number | null;
              r2_score: number | null;
              r3_score: number | null;
              r4_score: number | null;
            }
          | {
              name: string;
              total_score: number | null;
              is_cut: boolean | null;
              status: string | null;
              r1_score: number | null;
              r2_score: number | null;
              r3_score: number | null;
              r4_score: number | null;
            }[]
          | null;
      }
    | {
        tier: number;
        odds_text: string | null;
        golfers:
          | {
              name: string;
              total_score: number | null;
              is_cut: boolean | null;
              status: string | null;
              r1_score: number | null;
              r2_score: number | null;
              r3_score: number | null;
              r4_score: number | null;
            }
          | {
              name: string;
              total_score: number | null;
              is_cut: boolean | null;
              status: string | null;
              r1_score: number | null;
              r2_score: number | null;
              r3_score: number | null;
              r4_score: number | null;
            }[]
          | null;
      }[]
    | null;
  user_id: string;
};

type Profile = { user_id: string; display_name: string | null; team_name: string | null };

type Tournament = {
  status: string;
  cut_complete: boolean;
  name: string;
  actual_winning_score_rel_par: number | null;
};

type LeaderRow = {
  user_id: string;
  teamName: string;
  personName: string;
  best4: number | null;
  scoreToday: number | null;
  isMc: boolean;
  picks: (PickedGolfer & { tier: number; r1_score: number | null; r2_score: number | null; r3_score: number | null; r4_score: number | null })[];
  predictedRelPar: number | null;
  tieDelta: number | null;
};

function scoreClass(value: number | null): string {
  if (value === null) return "text-slate-500";
  if (value < 0) return "text-emerald-700";
  if (value > 0) return "text-red-700";
  return "text-slate-700";
}

function formatScore(value: number | null): string {
  if (value === null) return "-";
  if (value > 0) return `+${value}`;
  return String(value);
}

function detectCurrentRound(rows: (PickedGolfer & { r1_score: number | null; r2_score: number | null; r3_score: number | null; r4_score: number | null })[]): number | null {
  for (let round = 4; round >= 1; round--) {
    const hasRoundScore = rows.some((p) => {
      const v = round === 1 ? p.r1_score : round === 2 ? p.r2_score : round === 3 ? p.r3_score : p.r4_score;
      return typeof v === "number";
    });
    if (hasRoundScore) return round;
  }
  return null;
}

function sumRoundScore(
  picks: (PickedGolfer & { r1_score: number | null; r2_score: number | null; r3_score: number | null; r4_score: number | null })[],
  round: number | null
): number | null {
  if (!round) return null;
  let hasAny = false;
  let total = 0;
  for (const p of picks) {
    const v = round === 1 ? p.r1_score : round === 2 ? p.r2_score : round === 3 ? p.r3_score : p.r4_score;
    if (typeof v === "number") {
      hasAny = true;
      total += v;
    }
  }
  return hasAny ? total : null;
}

export function LeaderboardClient({ tournamentId }: { tournamentId: string }) {
  const [rows, setRows] = useState<LeaderRow[]>([]);
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAuthed, setIsAuthed] = useState<boolean>(false);

  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  async function load() {
    setLoading(true);
    setError(null);

    const {
      data: { user }
    } = await supabase.auth.getUser();
    setIsAuthed(Boolean(user));

    const { data: t, error: tErr } = await supabase
      .from("tournaments")
      .select("name,status,cut_complete,actual_winning_score_rel_par")
      .eq("id", tournamentId)
      .maybeSingle();

    if (tErr || !t) {
      setError(tErr?.message ?? "Tournament not found");
      setLoading(false);
      return;
    }
    setTournament(t);

    // Picks visibility is controlled by RLS (others hidden until Locked).
    const { data: picks, error: picksErr } = await supabase
      .from("picks")
      .select(
        "user_id,golfer_tiers:golfer_tier_id(tier,odds_text,golfers:golfer_id(name,total_score,is_cut,status,r1_score,r2_score,r3_score,r4_score))"
      )
      .eq("tournament_id", tournamentId);

    if (picksErr) {
      setError(picksErr.message);
      setLoading(false);
      return;
    }

    const userIds = Array.from(new Set((picks ?? []).map((p) => p.user_id)));
    const { data: profiles } = await supabase.from("profiles").select("user_id,display_name,team_name").in("user_id", userIds);
    const profileById = new Map<string, Profile>();
    for (const p of profiles ?? []) profileById.set(p.user_id, p);

    const predictedByUser = new Map<string, number>();
    if (userIds.length > 0) {
      const { data: tieRows } = await supabase
        .from("tiebreakers")
        .select("user_id,predicted_winning_score_rel_par")
        .eq("tournament_id", tournamentId)
        .in("user_id", userIds);
      for (const row of tieRows ?? []) predictedByUser.set(row.user_id, row.predicted_winning_score_rel_par);
    }

    const actualRel = t.actual_winning_score_rel_par ?? null;

    const byUser = new Map<string, RowPick[]>();
    for (const p of (picks ?? []) as unknown as RowPick[]) {
      const arr = byUser.get(p.user_id) ?? [];
      arr.push(p);
      byUser.set(p.user_id, arr);
    }

    const computed: LeaderRow[] = [];
    const allPicked: (PickedGolfer & { r1_score: number | null; r2_score: number | null; r3_score: number | null; r4_score: number | null })[] = [];
    for (const [user_id, ps] of byUser.entries()) {
      const profile = profileById.get(user_id);
      const personName = profile?.display_name?.trim() || "Unknown player";
      const teamName = profile?.team_name?.trim() || `Team ${user_id.slice(0, 8)}`;
      const picked = ps
        .map((p) => {
          const gt = p.golfer_tiers ? (Array.isArray(p.golfer_tiers) ? p.golfer_tiers[0] : p.golfer_tiers) : null;
          const g0 = gt?.golfers ?? null;
          const g = Array.isArray(g0) ? g0[0] ?? null : g0;
          return g ? { ...g, tier: gt?.tier ?? 0 } : null;
        })
        .filter(
          (
            g
          ): g is {
            name: string;
            total_score: number | null;
            is_cut: boolean | null;
            status: string | null;
            r1_score: number | null;
            r2_score: number | null;
            r3_score: number | null;
            r4_score: number | null;
            tier: number;
          } => Boolean(g)
        )
        .map((g) => ({
          name: g.name,
          total_score: g.total_score,
          is_cut: g.is_cut,
          status: g.status,
          r1_score: g.r1_score,
          r2_score: g.r2_score,
          r3_score: g.r3_score,
          r4_score: g.r4_score,
          tier: g.tier
        }));

      const madeCut = computeMadeCutCount(picked);
      const best4 = computeBest4(picked).sum;
      const isMc = Boolean(t.cut_complete && madeCut < 4);
      const predictedRelPar = predictedByUser.get(user_id) ?? null;
      const tieDelta = tiebreakDistanceVsActual(predictedRelPar, actualRel);
      picked.sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
      allPicked.push(...picked);
      computed.push({ user_id, teamName, personName, best4, scoreToday: null, isMc, picks: picked, predictedRelPar, tieDelta });
    }

    const currentRound = detectCurrentRound(allPicked);
    for (const row of computed) {
      row.scoreToday = sumRoundScore(row.picks, currentRound);
    }

    computed.sort((a, b) => {
      if (a.isMc !== b.isMc) return a.isMc ? 1 : -1;
      const as = a.best4 ?? Number.POSITIVE_INFINITY;
      const bs = b.best4 ?? Number.POSITIVE_INFINITY;
      if (as !== bs) return as - bs;
      if (actualRel !== null) {
        const ad = a.tieDelta;
        const bd = b.tieDelta;
        if (ad !== null && bd !== null && ad !== bd) return ad - bd;
        if (ad !== null && bd === null) return -1;
        if (ad === null && bd !== null) return 1;
      }
      return a.teamName.localeCompare(b.teamName);
    });

    setRows(computed);
    setLoading(false);
  }

  useEffect(() => {
    void load();

    const golfersChannel = supabase
      .channel(`golfers:${tournamentId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "golfers", filter: `tournament_id=eq.${tournamentId}` },
        () => void load()
      )
      .subscribe();

    const tournamentChannel = supabase
      .channel(`tournament:${tournamentId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "tournaments", filter: `id=eq.${tournamentId}` }, () =>
        void load()
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(golfersChannel);
      void supabase.removeChannel(tournamentChannel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournamentId]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Leaderboard</h1>
          <p className="text-sm text-slate-600">
            {tournament ? (
              <>
                {tournament.name}
                {tournament.actual_winning_score_rel_par !== null &&
                tournament.actual_winning_score_rel_par !== undefined ? (
                  <> · Actual winner vs par: {tournament.actual_winning_score_rel_par}</>
                ) : null}
              </>
            ) : (
              <>Tournament: {tournamentId}</>
            )}
          </p>
        </div>
        <Button variant="secondary" onClick={() => void load()} disabled={loading}>
          Refresh
        </Button>
      </div>

      {!isAuthed ? (
        <Card>
          <CardHeader>
            <CardTitle>Sign in to see picks</CardTitle>
            <CardDescription>
              Picks are only visible to authenticated users, and other users’ picks appear after the tournament locks.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {error ? <div className="text-sm text-red-600">{error}</div> : null}
      {loading ? <div className="text-sm text-slate-600">Loading...</div> : null}

      <Card className="border-club-gold/40 bg-club-cream/70">
        <CardHeader className="rounded-t-md bg-club-navy py-3">
          <CardTitle className="text-center text-2xl italic tracking-wide text-white">Chodesters</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <div className="min-w-[22rem]">
              <div className="grid grid-cols-[2.25rem_minmax(7rem,1fr)_5rem_5rem] border-b border-club-gold/30 bg-club-cream/85 px-3 py-2 text-xs font-semibold uppercase text-slate-700">
                <div>#</div>
                <div>Team</div>
                <div className="text-right">Overall</div>
                <div className="text-right">Today</div>
              </div>
              <div>
                {rows.map((r, idx) => (
                  <div
                    key={`glance-${r.user_id}`}
                    className="grid grid-cols-[2.25rem_minmax(7rem,1fr)_5rem_5rem] items-center border-b border-club-gold/20 px-3 py-2 text-sm"
                  >
                    <div className="font-semibold text-slate-700">{idx + 1}</div>
                    <div className="truncate whitespace-nowrap font-medium text-slate-900">{r.teamName}</div>
                    <div className={`text-right tabular-nums font-semibold ${scoreClass(r.best4)}`}>{formatScore(r.best4)}</div>
                    <div className={`text-right tabular-nums font-semibold ${scoreClass(r.scoreToday)}`}>{formatScore(r.scoreToday)}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="pt-1">
        <h2 className="text-lg font-semibold text-club-navy">Scorecards</h2>
      </div>

      <div className="grid gap-3">
        {rows.map((r, idx) => (
          <Card key={r.user_id} className={r.isMc ? "border-red-300 bg-club-cream/60 opacity-85" : "border-club-gold/30 bg-club-cream/70"}>
            <CardHeader className="border-b border-club-gold/20 pb-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="truncate text-xl text-club-navy">
                    #{idx + 1} · {r.teamName}
                  </CardTitle>
                  <div className="truncate text-xs text-slate-700">{r.personName}</div>
                </div>
                <div className="flex items-center gap-2">
                  {r.isMc ? <Badge variant="destructive">MC</Badge> : <Badge variant="secondary">Best 4</Badge>}
                  <div
                    className={`rounded-md border border-club-gold/40 bg-white px-3 py-1 text-base font-semibold tabular-nums ${scoreClass(
                      r.best4
                    )}`}
                  >
                    {formatScore(r.best4)}
                  </div>
                </div>
              </div>
              <CardDescription>
                {r.predictedRelPar !== null ? <> · Pred. winner vs par: {r.predictedRelPar}</> : null}
                {r.tieDelta !== null ? <> · Tiebreak Δ: {r.tieDelta}</> : null}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto pb-1">
                <div className="min-w-[31rem]">
                  <div className="grid grid-cols-[2.5rem_minmax(8rem,1fr)_3rem_3rem_3rem_3rem_3.5rem] gap-1 text-xs font-medium text-slate-600">
                    <div>Cut?</div>
                    <div>Golfer</div>
                    <div className="text-right">R1</div>
                    <div className="text-right">R2</div>
                    <div className="text-right">R3</div>
                    <div className="text-right">R4</div>
                    <div className="text-right">Total</div>
                  </div>
                  <div className="mt-2 grid gap-1 text-sm">
                    {r.picks.map((p, i) => (
                      <div
                        key={`${r.user_id}-${i}-${p.name}`}
                        className="grid grid-cols-[2.5rem_minmax(8rem,1fr)_3rem_3rem_3rem_3rem_3.5rem] items-center gap-1 rounded border border-club-gold/20 bg-white/70 px-2 py-1"
                      >
                        <div className="text-center text-sm font-semibold">
                          {p.is_cut === null ? (
                            <span className="text-black">-</span>
                          ) : p.is_cut ? (
                            <span className="text-emerald-700">✓</span>
                          ) : (
                            <span className="text-red-700">✓</span>
                          )}
                        </div>
                        <div className="truncate text-slate-800">
                          T{p.tier} · {p.name}
                        </div>
                        <div className={`text-right tabular-nums ${scoreClass(p.r1_score)}`}>{formatScore(p.r1_score)}</div>
                        <div className={`text-right tabular-nums ${scoreClass(p.r2_score)}`}>{formatScore(p.r2_score)}</div>
                        <div className={`text-right tabular-nums ${scoreClass(p.r3_score)}`}>{formatScore(p.r3_score)}</div>
                        <div className={`text-right tabular-nums ${scoreClass(p.r4_score)}`}>{formatScore(p.r4_score)}</div>
                        <div className={`text-right tabular-nums font-semibold ${scoreClass(p.total_score)}`}>
                          {formatScore(p.total_score)}
                          {p.is_cut === false ? <span className="ml-2 text-xs text-red-700">CUT</span> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

