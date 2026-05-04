import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { normalizeGolferNameKey } from "@/lib/domain/name-normalize";

const rowSchema = z.object({
  golfer_name: z.string().trim().min(1).max(200),
  odds_american: z.number().int(),
  espn_athlete_id: z.string().trim().regex(/^\d+$/).max(20).optional()
});

const bodySchema = z.object({
  tournamentId: z.string().uuid(),
  rows: z.array(rowSchema).min(1).max(300)
});

function betterOddsRow(a: z.infer<typeof rowSchema>, b: z.infer<typeof rowSchema>): z.infer<typeof rowSchema> {
  if (a.odds_american !== b.odds_american) return a.odds_american < b.odds_american ? a : b;
  const aE = Boolean(a.espn_athlete_id);
  const bE = Boolean(b.espn_athlete_id);
  if (aE !== bE) return aE ? a : b;
  return a.golfer_name.localeCompare(b.golfer_name) <= 0 ? a : b;
}

function dedupeByNormalizedName(rows: z.infer<typeof rowSchema>[]): z.infer<typeof rowSchema>[] {
  const best = new Map<string, z.infer<typeof rowSchema>>();
  for (const r of rows) {
    const key = normalizeGolferNameKey(r.golfer_name);
    if (!key) continue;
    const prev = best.get(key);
    if (!prev) best.set(key, r);
    else best.set(key, betterOddsRow(prev, r));
  }
  return [...best.values()].sort((a, b) => a.odds_american - b.odds_american || a.golfer_name.localeCompare(b.golfer_name));
}

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

  const { tournamentId, rows: rawRows } = parsed.data;

  const { data: frozen } = await supabase.from("odds_snapshots").select("id").eq("tournament_id", tournamentId).maybeSingle();
  if (frozen?.id) {
    return NextResponse.json({ error: "Tiers are already frozen; odds cannot be replaced." }, { status: 409 });
  }

  const adminSbCheck = createSupabaseServiceRoleClient();
  const { data: tRow } = await adminSbCheck.from("tournaments").select("status").eq("id", tournamentId).maybeSingle();
  if (tRow?.status === "Complete") {
    return NextResponse.json({ error: "Cannot replace odds for a completed tournament." }, { status: 400 });
  }

  const rows = dedupeByNormalizedName(rawRows);
  if (!rows.length) return NextResponse.json({ error: "No valid odds rows after dedupe." }, { status: 400 });

  const adminSb = adminSbCheck;

  const { data: golfers, error: gErr } = await adminSb.from("golfers").select("id,name,espn_athlete_id").eq("tournament_id", tournamentId);
  if (gErr) return NextResponse.json({ error: gErr.message }, { status: 400 });

  const byNorm = new Map<string, string>();
  const byEspn = new Map<string, string>();
  for (const g of golfers ?? []) {
    const k = normalizeGolferNameKey(g.name);
    if (k && !byNorm.has(k)) byNorm.set(k, g.id);
    const eid = g.espn_athlete_id != null ? String(g.espn_athlete_id).trim() : "";
    if (eid && !byEspn.has(eid)) byEspn.set(eid, g.id);
  }

  const now = new Date().toISOString();
  const insertRows = rows.map((r) => {
    let gid: string | null = null;
    const pastedEspn = r.espn_athlete_id?.trim();
    if (pastedEspn) gid = byEspn.get(pastedEspn) ?? null;
    if (!gid) gid = byNorm.get(normalizeGolferNameKey(r.golfer_name)) ?? null;
    return {
      tournament_id: tournamentId,
      golfer_name: r.golfer_name.trim(),
      golfer_id: gid,
      odds_american: r.odds_american,
      source: "manual",
      source_url: null as string | null,
      fetched_at: now
    };
  });

  const { error: delErr } = await adminSb.from("tournament_odds_latest").delete().eq("tournament_id", tournamentId);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 400 });

  const { error: insErr } = await adminSb.from("tournament_odds_latest").insert(insertRows);
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 400 });

  const matched = insertRows.filter((r) => r.golfer_id).length;
  return NextResponse.json({ ok: true, count: insertRows.length, matchedToField: matched });
}
