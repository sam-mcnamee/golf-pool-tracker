import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const bodySchema = z.object({
  tournamentId: z.string().uuid(),
  rules: z
    .array(
      z.object({
        tier: z.number().int().min(1).max(7),
        min_odds_american: z.number().int().nullable(),
        max_odds_american: z.number().int().nullable()
      })
    )
    .length(7)
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

  const { tournamentId, rules } = parsed.data;

  const { data: frozen } = await supabase
    .from("odds_snapshots")
    .select("id")
    .eq("tournament_id", tournamentId)
    .maybeSingle();
  if (frozen?.id) {
    return NextResponse.json({ error: "Tiers are already frozen for this tournament." }, { status: 409 });
  }

  const rows = rules.map((r) => ({ tournament_id: tournamentId, ...r }));
  const { error } = await supabase.from("tier_rules").upsert(rows, { onConflict: "tournament_id,tier" });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}

