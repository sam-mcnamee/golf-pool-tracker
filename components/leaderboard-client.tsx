"use client";

import { useEffect, useMemo, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { computeBest4, computeMadeCutCount, type PickedGolfer } from "@/lib/domain/scoring";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type RowPick = {
  golfer_tiers: {
    tier: number;
    odds_text: string | null;
    golfers: {
      name: string;
      total_score: number | null;
      is_cut: boolean | null;
      status: string | null;
    } | null;
  } | null;
  user_id: string;
};

type Profile = { user_id: string; display_name: string | null };

type Tournament = { status: string; cut_complete: boolean; name: string };

type LeaderRow = {
  user_id: string;
  display: string;
  best4: number | null;
  madeCut: number;
  isMc: boolean;
  picks: PickedGolfer[];
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
      .select("name,status,cut_complete")
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
        "user_id,golfer_tiers:golfer_tier_id(tier,odds_text,golfers:golfer_id(name,total_score,is_cut,status))"
      )
      .eq("tournament_id", tournamentId);

    if (picksErr) {
      setError(picksErr.message);
      setLoading(false);
      return;
    }

    const userIds = Array.from(new Set((picks ?? []).map((p) => p.user_id)));
    const { data: profiles } = await supabase.from("profiles").select("user_id,display_name").in("user_id", userIds);
    const profileById = new Map<string, Profile>();
    for (const p of profiles ?? []) profileById.set(p.user_id, p);

    const byUser = new Map<string, RowPick[]>();
    for (const p of (picks ?? []) as RowPick[]) {
      const arr = byUser.get(p.user_id) ?? [];
      arr.push(p);
      byUser.set(p.user_id, arr);
    }

    const computed: LeaderRow[] = [];
    for (const [user_id, ps] of byUser.entries()) {
      const display = profileById.get(user_id)?.display_name ?? user_id.slice(0, 8);
      const picked = ps
        .map((p) => p.golfer_tiers?.golfers)
        .filter((g): g is NonNullable<RowPick["golfer_tiers"]>["golfers"] => Boolean(g))
        .map((g) => ({ name: g!.name, total_score: g!.total_score, is_cut: g!.is_cut, status: g!.status }));

      const madeCut = computeMadeCutCount(picked);
      const best4 = computeBest4(picked).sum;
      const isMc = Boolean(t.cut_complete && madeCut < 4);
      computed.push({ user_id, display, madeCut, best4, isMc, picks: picked });
    }

    computed.sort((a, b) => {
      if (a.isMc !== b.isMc) return a.isMc ? 1 : -1;
      const as = a.best4 ?? Number.POSITIVE_INFINITY;
      const bs = b.best4 ?? Number.POSITIVE_INFINITY;
      if (as !== bs) return as - bs;
      return a.display.localeCompare(b.display);
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
                <CardTitle className="text-base">
                  #{idx + 1} · {r.display}
                </CardTitle>
                <div className="flex items-center gap-2">
                  {r.isMc ? <Badge variant="destructive">MC</Badge> : <Badge variant="secondary">Best 4</Badge>}
                  <div className="text-sm font-semibold tabular-nums">{r.best4 ?? "—"}</div>
                </div>
              </div>
              <CardDescription>Made cut: {r.madeCut} / 7</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-1 text-sm">
                {r.picks.map((p) => (
                  <div key={p.name} className="flex items-center justify-between gap-3">
                    <div className="truncate">{p.name}</div>
                    <div className="shrink-0 tabular-nums text-slate-700">
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

