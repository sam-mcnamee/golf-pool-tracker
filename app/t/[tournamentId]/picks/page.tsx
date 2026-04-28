import { createSupabaseServerClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { PicksClient } from "@/components/picks-client";

export default async function PicksPage({ params }: { params: Promise<{ tournamentId: string }> }) {
  const { tournamentId } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: tiers, error: tiersErr } = await supabase
    .from("golfer_tiers")
    .select("id,tier,odds_text,golfers:golfer_id(id,name,espn_athlete_id,total_score,is_cut,status)")
    .eq("tournament_id", tournamentId)
    .order("tier", { ascending: true });

  if (tiersErr) {
    throw new Error(tiersErr.message);
  }

  const { data: existingPicks, error: picksErr } = await supabase
    .from("picks")
    .select("tier,golfer_tier_id")
    .eq("tournament_id", tournamentId)
    .eq("user_id", user.id);

  if (picksErr) {
    throw new Error(picksErr.message);
  }

  return <PicksClient tournamentId={tournamentId} tiers={tiers ?? []} existingPicks={existingPicks ?? []} />;
}

