import { after } from "next/server";

import { LeaderboardClient } from "@/components/leaderboard-client";
import { sortTournamentsByScheduleDesc } from "@/lib/domain/tournament-sort";
import { triggerLeaderboardSync } from "@/lib/sync/leaderboard-sync-trigger";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const tournamentListSelect =
  "id,name,status,starts_at,first_tee_at,lock_at,open_at,created_at" as const;

export default async function LeaderboardPage({ params }: { params: Promise<{ tournamentId: string }> }) {
  const { tournamentId } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: tournamentRow } = await supabase
    .from("tournaments")
    .select("status")
    .eq("id", tournamentId)
    .maybeSingle();

  if (tournamentRow?.status === "Live") {
    after(async () => {
      await triggerLeaderboardSync("leaderboard_visit", { tournamentId });
    });
  }

  const { data: rows } = await supabase.from("tournaments").select(tournamentListSelect);
  const tournamentChoices = sortTournamentsByScheduleDesc(rows ?? []).map(({ id, name, status }) => ({
    id,
    name,
    status
  }));

  return <LeaderboardClient tournamentId={tournamentId} tournamentChoices={tournamentChoices} />;
}

