import Link from "next/link";
import { sortTournamentsByScheduleDesc } from "@/lib/domain/tournament-sort";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const tournamentListSelect =
  "id,name,status,starts_at,first_tee_at,lock_at,open_at,created_at" as const;

export default async function LeaderboardsIndexPage() {
  const supabase = await createSupabaseServerClient();
  const { data: rows } = await supabase.from("tournaments").select(tournamentListSelect);
  const tournaments = sortTournamentsByScheduleDesc(rows ?? []);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-club-navy">Leaderboards</h1>
        <p className="text-sm text-slate-600">
          Each tournament keeps its own picks, tiers, and scores in the database. Completed weeks stay here so you can
          reopen any leaderboard anytime.
        </p>
      </div>

      {tournaments.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-slate-600">No tournaments yet.</CardContent>
        </Card>
      ) : (
        <ul className="space-y-3">
          {tournaments.map((t) => (
            <li key={t.id}>
              <Card className="border-club-gold/30 transition-shadow hover:shadow-md">
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <CardTitle className="text-lg text-club-navy">{t.name}</CardTitle>
                    <Badge variant={t.status === "Complete" ? "secondary" : "default"}>{t.status}</Badge>
                  </div>
                  <CardDescription>Open the board for this week — same URL works after the event ends.</CardDescription>
                </CardHeader>
                <CardContent>
                  <Link
                    href={`/t/${t.id}/leaderboard`}
                    className="text-sm font-medium text-club-navy underline decoration-club-gold/60 underline-offset-2 hover:decoration-club-gold"
                  >
                    View leaderboard →
                  </Link>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
