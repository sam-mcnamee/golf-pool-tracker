import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const bodySchema = z.object({
  tournamentId: z.string().uuid(),
  golferId: z.string().uuid(),
  tier: z.number().int().min(1).max(7).nullable()
});

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("is_admin").eq("user_id", user.id).maybeSingle();
  if (!profile?.is_admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const { tournamentId, golferId, tier } = parsed.data;

  const { data: frozen } = await supabase
    .from("odds_snapshots")
    .select("id")
    .eq("tournament_id", tournamentId)
    .maybeSingle();
  if (frozen?.id) {
    return NextResponse.json({ error: "Tiers are already frozen for this tournament." }, { status: 409 });
  }

  if (tier === null) {
    const { error } = await supabase.from("tier_overrides").delete().eq("tournament_id", tournamentId).eq("golfer_id", golferId);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  const { error } = await supabase
    .from("tier_overrides")
    .upsert({ tournament_id: tournamentId, golfer_id: golferId, tier }, { onConflict: "tournament_id,golfer_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}

