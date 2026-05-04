import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";

const bodySchema = z.object({
  tournamentId: z.string().uuid(),
  confirmDeletePicks: z.boolean().optional()
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

  const { tournamentId, confirmDeletePicks } = parsed.data;

  const adminSb = createSupabaseServiceRoleClient();

  const { data: tRow } = await adminSb.from("tournaments").select("status").eq("id", tournamentId).maybeSingle();
  if (!tRow) return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
  if (tRow.status === "Complete") {
    return NextResponse.json({ error: "Cannot unfreeze a completed tournament." }, { status: 400 });
  }

  const { count: pickCount, error: countErr } = await adminSb
    .from("picks")
    .select("id", { count: "exact", head: true })
    .eq("tournament_id", tournamentId);

  if (countErr) return NextResponse.json({ error: countErr.message }, { status: 400 });

  const n = pickCount ?? 0;
  if (n > 0 && !confirmDeletePicks) {
    return NextResponse.json(
      {
        error: "This tournament has submitted picks tied to the frozen tier rows. Unfreezing requires deleting those picks first.",
        pickCount: n,
        needsConfirmDeletePicks: true
      },
      { status: 409 }
    );
  }

  if (n > 0) {
    const { error: delPicksErr } = await adminSb.from("picks").delete().eq("tournament_id", tournamentId);
    if (delPicksErr) return NextResponse.json({ error: delPicksErr.message }, { status: 400 });
  }

  const { error: delTieErr } = await adminSb.from("tiebreakers").delete().eq("tournament_id", tournamentId);
  if (delTieErr) return NextResponse.json({ error: delTieErr.message }, { status: 400 });

  const { error: delSnapErr } = await adminSb.from("odds_snapshots").delete().eq("tournament_id", tournamentId);
  if (delSnapErr) return NextResponse.json({ error: delSnapErr.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
