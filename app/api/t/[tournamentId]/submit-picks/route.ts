import { NextResponse } from "next/server";
import { z } from "zod";
import { profileDisplayNameFromUser } from "@/lib/auth/display-name";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const bodySchema = z.object({
  golferTierIds: z.array(z.string().uuid()).length(7),
  predictedWinningScoreRelPar: z.number().int(),
  teamName: z.string().trim().min(2).max(60)
});

export async function POST(request: Request, { params }: { params: Promise<{ tournamentId: string }> }) {
  const { tournamentId } = await params;
  const supabase = await createSupabaseServerClient();

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  const teamName = parsed.data.teamName.trim();
  const displayName = profileDisplayNameFromUser(user);

  const { data: existingProfile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("user_id", user.id)
    .maybeSingle();

  const profilePayload: { user_id: string; team_name: string; display_name?: string } = {
    user_id: user.id,
    team_name: teamName
  };
  if (displayName && !existingProfile?.display_name?.trim()) {
    profilePayload.display_name = displayName;
  }

  const { error: profileErr } = await supabase.from("profiles").upsert(profilePayload, { onConflict: "user_id" });

  if (profileErr) {
    return NextResponse.json({ error: profileErr.message }, { status: 400 });
  }

  const { error } = await supabase.rpc("submit_picks", {
    p_tournament_id: tournamentId,
    p_golfer_tier_ids: parsed.data.golferTierIds,
    p_predicted_winning_score_rel_par: parsed.data.predictedWinningScoreRelPar
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}

