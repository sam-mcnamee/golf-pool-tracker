import { LeaderboardClient } from "@/components/leaderboard-client";

export default async function LeaderboardPage({ params }: { params: Promise<{ tournamentId: string }> }) {
  const { tournamentId } = await params;
  return <LeaderboardClient tournamentId={tournamentId} />;
}

