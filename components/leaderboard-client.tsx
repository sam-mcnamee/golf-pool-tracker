"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  computeBest4,
  computeMadeCutCount,
  tiebreakDistanceVsActual,
  type PickedGolfer
} from "@/lib/domain/scoring";
import { formatScore, scoreClass } from "@/lib/domain/score-display";
import { isSyncStale } from "@/lib/sync/sync-staleness";
import { formatRoundCell, roundCellClassName } from "@/lib/domain/round-display";
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
              current_round: number | null;
              is_cut: boolean | null;
              status: string | null;
              r1_score: number | null;
              r2_score: number | null;
              r3_score: number | null;
              r4_score: number | null;
              r1_tee_at: string | null;
              r2_tee_at: string | null;
              r3_tee_at: string | null;
              r4_tee_at: string | null;
            }
          | {
              name: string;
              total_score: number | null;
              current_round: number | null;
              is_cut: boolean | null;
              status: string | null;
              r1_score: number | null;
              r2_score: number | null;
              r3_score: number | null;
              r4_score: number | null;
              r1_tee_at: string | null;
              r2_tee_at: string | null;
              r3_tee_at: string | null;
              r4_tee_at: string | null;
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
              current_round: number | null;
              is_cut: boolean | null;
              status: string | null;
              r1_score: number | null;
              r2_score: number | null;
              r3_score: number | null;
              r4_score: number | null;
              r1_tee_at: string | null;
              r2_tee_at: string | null;
              r3_tee_at: string | null;
              r4_tee_at: string | null;
            }
          | {
              name: string;
              total_score: number | null;
              current_round: number | null;
              is_cut: boolean | null;
              status: string | null;
              r1_score: number | null;
              r2_score: number | null;
              r3_score: number | null;
              r4_score: number | null;
              r1_tee_at: string | null;
              r2_tee_at: string | null;
              r3_tee_at: string | null;
              r4_tee_at: string | null;
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
  isMc: boolean;
  picks: (PickedGolfer & {
    tier: number;
    current_round: number | null;
    r1_score: number | null;
    r2_score: number | null;
    r3_score: number | null;
    r4_score: number | null;
    r1_tee_at: string | null;
    r2_tee_at: string | null;
    r3_tee_at: string | null;
    r4_tee_at: string | null;
  })[];
  predictedRelPar: number | null;
  tieDelta: number | null;
};

/** True if `a` has a strictly better leaderboard position than `b` (lower best4; non-MC ahead of MC). */
function strictlyBetterScore(a: LeaderRow, b: LeaderRow): boolean {
  if (a.isMc !== b.isMc) return !a.isMc && b.isMc;
  const as = a.best4 ?? Number.POSITIVE_INFINITY;
  const bs = b.best4 ?? Number.POSITIVE_INFINITY;
  return as < bs;
}

/** Competition ranks (1,1,1,4…); labels use T{n} when multiple teams share rank n. */
function competitionRankLabels(rows: LeaderRow[]): string[] {
  if (!rows.length) return [];
  const ranks = rows.map((_, i) => {
    let rank = 1;
    for (let j = 0; j < i; j++) {
      if (strictlyBetterScore(rows[j], rows[i])) rank++;
    }
    return rank;
  });
  const countByRank = new Map<number, number>();
  for (const r of ranks) countByRank.set(r, (countByRank.get(r) ?? 0) + 1);
  return ranks.map((r) => (countByRank.get(r)! > 1 ? `T${r}` : String(r)));
}

export type LeaderboardTournamentChoice = { id: string; name: string; status: string };

export function LeaderboardClient({
  tournamentId,
  tournamentChoices
}: {
  tournamentId: string;
  /** When set, shows an event switcher; each event keeps its own saved leaderboard. */
  tournamentChoices?: LeaderboardTournamentChoice[];
}) {
  const router = useRouter();
  const [rows, setRows] = useState<LeaderRow[]>([]);
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAuthed, setIsAuthed] = useState<boolean>(false);

  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const rankLabels = useMemo(() => competitionRankLabels(rows), [rows]);

  async function load(options?: { silent?: boolean }) {
    if (!options?.silent) {
      setLoading(true);
    }
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

    const { data: healthRow } = await supabase
      .from("sync_health")
      .select("last_success_at")
      .eq("tournament_id", tournamentId)
      .maybeSingle();
    setLastSyncAt(healthRow?.last_success_at ?? null);

    // Picks visibility is controlled by RLS (others hidden until Locked).
    const { data: picks, error: picksErr } = await supabase
      .from("picks")
      .select(
        "user_id,golfer_tiers:golfer_tier_id(tier,odds_text,golfers:golfer_id(name,total_score,current_round,is_cut,status,r1_score,r2_score,r3_score,r4_score,r1_tee_at,r2_tee_at,r3_tee_at,r4_tee_at))"
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
            current_round: number | null;
            is_cut: boolean | null;
            status: string | null;
            r1_score: number | null;
            r2_score: number | null;
            r3_score: number | null;
            r4_score: number | null;
            r1_tee_at: string | null;
            r2_tee_at: string | null;
            r3_tee_at: string | null;
            r4_tee_at: string | null;
            tier: number;
          } => Boolean(g)
        )
        .map((g) => ({
          name: g.name,
          total_score: g.total_score,
          current_round: g.current_round,
          is_cut: g.is_cut,
          status: g.status,
          r1_score: g.r1_score,
          r2_score: g.r2_score,
          r3_score: g.r3_score,
          r4_score: g.r4_score,
          r1_tee_at: g.r1_tee_at,
          r2_tee_at: g.r2_tee_at,
          r3_tee_at: g.r3_tee_at,
          r4_tee_at: g.r4_tee_at,
          tier: g.tier
        }));

      const madeCut = computeMadeCutCount(picked);
      const best4 = computeBest4(picked).sum;
      const isMc = Boolean(t.cut_complete && madeCut < 4);
      const predictedRelPar = predictedByUser.get(user_id) ?? null;
      const tieDelta = tiebreakDistanceVsActual(predictedRelPar, actualRel);
      picked.sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
      computed.push({ user_id, teamName, personName, best4, isMc, picks: picked, predictedRelPar, tieDelta });
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
    if (!options?.silent) {
      setLoading(false);
    }
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

  useEffect(() => {
    if (tournament?.status !== "Live") return;
    const intervalId = window.setInterval(() => {
      void (async () => {
        if (lastSyncAt && !isSyncStale(lastSyncAt, 5)) {
          await load({ silent: true });
          return;
        }
        try {
          await fetch(`/api/t/${tournamentId}/refresh-scores`, { method: "POST" });
        } catch {
          // Best-effort refresh; polling still reloads current DB state.
        }
        await load({ silent: true });
      })();
    }, 60_000);
    return () => window.clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournament?.status, tournamentId, lastSyncAt]);

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
          {tournament?.status === "Live" && lastSyncAt ? (
            (() => {
              const last = new Date(lastSyncAt).getTime();
              const ageMin = Math.round((Date.now() - last) / 60000);
              if (Number.isFinite(ageMin) && ageMin > 5) {
                return <p className="text-xs text-amber-700">Live scores may be stale (last sync ~{ageMin}m ago).</p>;
              }
              return null;
            })()
          ) : null}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">
          {tournamentChoices && tournamentChoices.length > 0 ? (
            <div className="flex min-w-[min(100%,16rem)] flex-col gap-1">
              <label htmlFor="leaderboard-event" className="text-xs font-medium text-slate-600">
                Event
              </label>
              <select
                id="leaderboard-event"
                className="rounded-md border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                value={tournamentId}
                onChange={(e) => {
                  const id = e.target.value;
                  if (id && id !== tournamentId) router.push(`/t/${id}/leaderboard`);
                }}
              >
                {tournamentChoices.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.name} ({opt.status})
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <Button variant="secondary" onClick={() => void load()} disabled={loading}>
            Refresh
          </Button>
        </div>
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
        <CardHeader className="rounded-t-md bg-[#006847] py-3">
          <CardTitle className="text-center text-2xl italic tracking-wide text-white">Chodesters</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="grid grid-cols-[minmax(2rem,auto)_minmax(0,1fr)_minmax(2.75rem,auto)] border-b border-club-gold/30 bg-club-cream/85 px-3 py-2 text-xs font-semibold uppercase text-slate-700 sm:grid-cols-[minmax(2.5rem,auto)_minmax(0,1fr)_4rem]">
            <div>#</div>
            <div>Team</div>
            <div className="text-right">Overall</div>
          </div>
          <div>
            {rows.map((r, idx) => (
              <div
                key={`glance-${r.user_id}`}
                className="grid grid-cols-[minmax(2rem,auto)_minmax(0,1fr)_minmax(2.75rem,auto)] items-start border-b border-club-gold/20 px-3 py-2 text-sm sm:grid-cols-[minmax(2.5rem,auto)_minmax(0,1fr)_4rem] sm:items-center"
              >
                <div className="font-semibold tabular-nums text-slate-700">{rankLabels[idx] ?? String(idx + 1)}</div>
                <div className="min-w-0 text-pretty font-medium leading-snug text-slate-900 sm:truncate">{r.teamName}</div>
                <div className={`self-start pt-0.5 text-right tabular-nums font-semibold sm:self-center sm:pt-0 ${scoreClass(r.best4)}`}>{formatScore(r.best4)}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="pt-1">
        <h2 className="text-lg font-semibold text-club-navy">Scorecards</h2>
      </div>

      <div className="grid gap-3">
        {rows.map((r, idx) => (
          <Card key={r.user_id} className={r.isMc ? "border-red-300 bg-club-cream/60 opacity-85" : "border-club-gold/30 bg-club-cream/70"}>
            <CardHeader className="border-b border-club-gold/20 p-4 pb-3 sm:p-6 sm:pb-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <CardTitle className="text-pretty text-xl leading-snug text-club-navy sm:truncate">
                    #{rankLabels[idx] ?? String(idx + 1)} · {r.teamName}
                  </CardTitle>
                  <div className="text-pretty text-xs text-slate-700 sm:truncate">{r.personName}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2 self-start sm:self-center">
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
                {r.predictedRelPar !== null ? <>Winning Score Prediction: {r.predictedRelPar}</> : null}
                {r.tieDelta !== null ? <> · Tiebreak Δ: {r.tieDelta}</> : null}
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
              <div className="hidden md:block">
                <div className="grid grid-cols-[3rem_minmax(9rem,1fr)_3rem_3rem_3rem_3rem_4rem] gap-1 text-xs font-medium text-slate-600">
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
                      className="grid grid-cols-[3rem_minmax(9rem,1fr)_3rem_3rem_3rem_3rem_4rem] items-center gap-1 rounded border border-club-gold/20 bg-white/70 px-2 py-1"
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
                      <div className={`text-right ${roundCellClassName(p, 1)}`}>{formatRoundCell(p, 1)}</div>
                      <div className={`text-right ${roundCellClassName(p, 2)}`}>{formatRoundCell(p, 2)}</div>
                      <div className={`text-right ${roundCellClassName(p, 3)}`}>{formatRoundCell(p, 3)}</div>
                      <div className={`text-right ${roundCellClassName(p, 4)}`}>{formatRoundCell(p, 4)}</div>
                      <div className={`text-right tabular-nums font-semibold ${scoreClass(p.total_score)}`}>
                        {formatScore(p.total_score)}
                        {p.is_cut === false ? <span className="ml-2 text-xs text-red-700">CUT</span> : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="md:hidden space-y-2">
                {r.picks.map((p, i) => {
                  const highlightClass =
                    p.is_cut === true
                      ? "border-emerald-300/70 bg-emerald-50/60"
                      : p.is_cut === false
                        ? "border-red-300/70 bg-red-50/60"
                        : "border-club-gold/20 bg-white/70";

                  const totalText =
                    p.is_cut === false && p.total_score === null ? "MC" : formatScore(p.total_score);
                  const totalClass =
                    p.is_cut === false && p.total_score === null
                      ? "text-red-700"
                      : p.total_score === null
                        ? "text-slate-700"
                        : scoreClass(p.total_score);

                  const r1Text = formatRoundCell(p, 1);
                  const r2Text = formatRoundCell(p, 2);
                  const r3Text = formatRoundCell(p, 3);
                  const r4Text = formatRoundCell(p, 4);
                  const r1Class = roundCellClassName(p, 1);
                  const r2Class = roundCellClassName(p, 2);
                  const r3Class = roundCellClassName(p, 3);
                  const r4Class = roundCellClassName(p, 4);

                  return (
                    <div
                      key={`${r.user_id}-${i}-${p.name}`}
                      className={`rounded border ${highlightClass} px-3 py-2`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold text-slate-800">
                            T{p.tier} · {p.name}
                          </div>
                        </div>
                        <div className={`tabular-nums text-sm font-semibold ${totalClass}`}>{totalText}</div>
                      </div>

                      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                        <div className="flex items-center justify-between rounded bg-white/50 px-2 py-1">
                          <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">R1</span>
                          <span className={`shrink-0 text-right ${r1Class}`}>{r1Text}</span>
                        </div>
                        <div className="flex items-center justify-between rounded bg-white/50 px-2 py-1">
                          <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">R2</span>
                          <span className={`shrink-0 text-right ${r2Class}`}>{r2Text}</span>
                        </div>
                        <div className="flex items-center justify-between rounded bg-white/50 px-2 py-1">
                          <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">R3</span>
                          <span className={`shrink-0 text-right ${r3Class}`}>{r3Text}</span>
                        </div>
                        <div className="flex items-center justify-between rounded bg-white/50 px-2 py-1">
                          <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">R4</span>
                          <span className={`shrink-0 text-right ${r4Class}`}>{r4Text}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

