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
  madeCut: number;
  isMc: boolean;
  picks: (PickedGolfer & { tier: number; r1_score: number | null; r2_score: number | null; r3_score: number | null; r4_score: number | null })[];
  predictedRelPar: number | null;
  tieDelta: number | null;
};

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
      computed.push({ user_id, teamName, personName, madeCut, best4, isMc, picks: picked, predictedRelPar, tieDelta });
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
                {tournament.name} · Status: {tournament.status} · Cut complete: {String(tournament.cut_complete)}
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

      <div className="grid gap-3">
        {rows.map((r, idx) => (
          <Card key={r.user_id} className={r.isMc ? "opacity-70" : ""}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="truncate text-lg">
                    #{idx + 1} · {r.teamName}
                  </CardTitle>
                  <div className="truncate text-xs text-slate-600">{r.personName}</div>
                </div>
                <div className="flex items-center gap-2">
                  {r.isMc ? <Badge variant="destructive">MC</Badge> : <Badge variant="secondary">Best 4</Badge>}
                  <div className="rounded-md border border-slate-300 bg-slate-50 px-3 py-1 text-base font-semibold tabular-nums">
                    {r.best4 ?? "—"}
                  </div>
                </div>
              </div>
              <CardDescription>
                Made cut: {r.madeCut} / 7
                {r.predictedRelPar !== null ? <> · Pred. winner vs par: {r.predictedRelPar}</> : null}
                {r.tieDelta !== null ? <> · Tiebreak Δ: {r.tieDelta}</> : null}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-[minmax(9rem,1fr)_3rem_3rem_3rem_3rem_4rem] gap-1 text-xs font-medium text-slate-500">
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
                    className="grid grid-cols-[minmax(9rem,1fr)_3rem_3rem_3rem_3rem_4rem] items-center gap-1 rounded border border-slate-100 px-2 py-1"
                  >
                    <div className="truncate text-slate-800">
                      T{p.tier} · {p.name}
                    </div>
                    <div className="text-right tabular-nums text-slate-700">{p.r1_score ?? "-"}</div>
                    <div className="text-right tabular-nums text-slate-700">{p.r2_score ?? "-"}</div>
                    <div className="text-right tabular-nums text-slate-700">{p.r3_score ?? "-"}</div>
                    <div className="text-right tabular-nums text-slate-700">{p.r4_score ?? "-"}</div>
                    <div className="text-right tabular-nums font-semibold text-slate-900">
                      {p.total_score ?? "—"}
                      {p.is_cut === false ? <span className="ml-2 text-xs text-red-700">CUT</span> : null}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

