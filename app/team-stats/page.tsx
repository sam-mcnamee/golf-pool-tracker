import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { computeBest4, tiebreakDistanceVsActual, type PickedGolfer } from "@/lib/domain/scoring";

type Tournament = {
  id: string;
  name: string;
  actual_winning_score_rel_par: number | null;
};

type PickRow = {
  tournament_id: string;
  user_id: string;
  golfer_tiers:
    | { golfers: { total_score: number | null; is_cut: boolean | null; status: string | null } | { total_score: number | null; is_cut: boolean | null; status: string | null }[] | null }
    | { golfers: { total_score: number | null; is_cut: boolean | null; status: string | null } | { total_score: number | null; is_cut: boolean | null; status: string | null }[] | null }[]
    | null;
};

type TieRow = {
  tournament_id: string;
  user_id: string;
  predicted_winning_score_rel_par: number;
};

type Profile = {
  user_id: string;
  team_name: string | null;
  display_name: string | null;
};

type TeamAgg = {
  user_id: string;
  team_name: string;
  display_name: string;
  avg_finish: number;
  majors_won: number;
  tournaments_counted: number;
};

function isMajorTournament(name: string): boolean {
  const n = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return (
    n.includes("masters") ||
    n.includes("us open") ||
    n.includes("u s open") ||
    n.includes("open championship") ||
    n.includes("pga championship")
  );
}

function finishRankRows(tournament: Tournament, picks: PickRow[], tiesByUser: Map<string, number | null>) {
  const byUser = new Map<string, PickedGolfer[]>();
  for (const p of picks) {
    const gt0 = p.golfer_tiers;
    const gt = Array.isArray(gt0) ? gt0[0] ?? null : gt0;
    const golfer0 = gt?.golfers ?? null;
    const golfer = Array.isArray(golfer0) ? golfer0[0] ?? null : golfer0;
    if (!golfer) continue;
    const arr = byUser.get(p.user_id) ?? [];
    arr.push({ name: p.user_id, total_score: golfer.total_score, is_cut: golfer.is_cut, status: golfer.status });
    byUser.set(p.user_id, arr);
  }

  const rows = Array.from(byUser.entries()).map(([user_id, picked]) => {
    const madeCut = picked.filter((x) => x.is_cut === true).length;
    const isMc = madeCut < 4 && picked.some((x) => x.is_cut !== null);
    const best4 = computeBest4(picked).sum;
    const tieDelta = tiebreakDistanceVsActual(tiesByUser.get(user_id) ?? null, tournament.actual_winning_score_rel_par);
    return { user_id, best4, isMc, tieDelta };
  });

  rows.sort((a, b) => {
    if (a.isMc !== b.isMc) return a.isMc ? 1 : -1;
    const as = a.best4 ?? Number.POSITIVE_INFINITY;
    const bs = b.best4 ?? Number.POSITIVE_INFINITY;
    if (as !== bs) return as - bs;
    const ad = a.tieDelta ?? Number.POSITIVE_INFINITY;
    const bd = b.tieDelta ?? Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    return a.user_id.localeCompare(b.user_id);
  });

  return rows.map((r, idx) => ({ ...r, rank: idx + 1 }));
}

export default async function TeamStatsPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: tournaments } = await supabase
    .from("tournaments")
    .select("id,name,actual_winning_score_rel_par")
    .eq("status", "Complete")
    .order("created_at", { ascending: true });

  const completed = (tournaments ?? []) as Tournament[];
  const tIds = completed.map((t) => t.id);

  if (!completed.length) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Team Stats</h1>
        <Card>
          <CardContent className="pt-6 text-sm text-slate-600">No completed tournaments yet.</CardContent>
        </Card>
      </div>
    );
  }

  const [{ data: picks }, { data: ties }, { data: profiles }] = await Promise.all([
    supabase
      .from("picks")
      .select("tournament_id,user_id,golfer_tiers:golfer_tier_id(golfers:golfer_id(total_score,is_cut,status))")
      .in("tournament_id", tIds),
    supabase
      .from("tiebreakers")
      .select("tournament_id,user_id,predicted_winning_score_rel_par")
      .in("tournament_id", tIds),
    supabase.from("profiles").select("user_id,team_name,display_name")
  ]);

  const tieMapByTournament = new Map<string, Map<string, number | null>>();
  for (const tr of ((ties ?? []) as TieRow[])) {
    const m = tieMapByTournament.get(tr.tournament_id) ?? new Map<string, number | null>();
    m.set(tr.user_id, tr.predicted_winning_score_rel_par);
    tieMapByTournament.set(tr.tournament_id, m);
  }

  const profileByUser = new Map<string, Profile>();
  for (const p of ((profiles ?? []) as Profile[])) profileByUser.set(p.user_id, p);

  const finishByUser = new Map<string, number[]>();
  const majorWinsByUser = new Map<string, number>();

  for (const t of completed) {
    const tPicks = ((picks ?? []) as PickRow[]).filter((p) => p.tournament_id === t.id);
    const ranks = finishRankRows(t, tPicks, tieMapByTournament.get(t.id) ?? new Map<string, number | null>());
    for (const r of ranks) {
      const arr = finishByUser.get(r.user_id) ?? [];
      arr.push(r.rank);
      finishByUser.set(r.user_id, arr);
    }

    if (isMajorTournament(t.name) && ranks.length > 0) {
      const winner = ranks[0]?.user_id;
      if (winner) majorWinsByUser.set(winner, (majorWinsByUser.get(winner) ?? 0) + 1);
    }
  }

  const rows: TeamAgg[] = Array.from(finishByUser.entries()).map(([user_id, finishes]) => {
    const p = profileByUser.get(user_id);
    const team_name = p?.team_name?.trim() || `Team ${user_id.slice(0, 8)}`;
    const display_name = p?.display_name?.trim() || "Unknown player";
    const avg_finish = finishes.reduce((a, b) => a + b, 0) / finishes.length;
    return {
      user_id,
      team_name,
      display_name,
      avg_finish,
      majors_won: majorWinsByUser.get(user_id) ?? 0,
      tournaments_counted: finishes.length
    };
  });

  rows.sort((a, b) => {
    if (a.avg_finish !== b.avg_finish) return a.avg_finish - b.avg_finish;
    if (a.majors_won !== b.majors_won) return b.majors_won - a.majors_won;
    return a.team_name.localeCompare(b.team_name);
  });

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Team Stats</h1>
        <p className="text-sm text-slate-600">
          Average finish across completed tournaments and major wins (Masters, U.S. Open, Open Championship, PGA Championship).
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Standings by team history</CardTitle>
          <CardDescription>{rows.length} teams with completed results.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-[minmax(10rem,1fr)_minmax(8rem,1fr)_7rem_6rem_6rem] gap-2 border-b border-slate-200 pb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
            <div>Team</div>
            <div>Owner</div>
            <div className="text-right">Avg finish</div>
            <div className="text-right">Majors</div>
            <div className="text-right">Events</div>
          </div>
          <div className="mt-2 space-y-1">
            {rows.map((r) => (
              <div
                key={r.user_id}
                className="grid grid-cols-[minmax(10rem,1fr)_minmax(8rem,1fr)_7rem_6rem_6rem] items-center gap-2 rounded-md border border-slate-100 px-2 py-2 text-sm"
              >
                <div className="truncate font-medium text-club-navy">{r.team_name}</div>
                <div className="truncate text-slate-700">{r.display_name}</div>
                <div className="text-right tabular-nums text-slate-900">{r.avg_finish.toFixed(2)}</div>
                <div className="text-right tabular-nums font-semibold text-slate-900">{r.majors_won}</div>
                <div className="text-right tabular-nums text-slate-700">{r.tournaments_counted}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
