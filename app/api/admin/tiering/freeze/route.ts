import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";

const bodySchema = z.object({
  tournamentId: z.string().uuid()
});

function pickTierFromRules(
  rules: { tier: number; min_odds_american: number | null; max_odds_american: number | null }[],
  odds: number
) {
  for (const r of rules) {
    if (r.min_odds_american != null && odds < r.min_odds_american) continue;
    if (r.max_odds_american != null && odds > r.max_odds_american) continue;
    return r.tier;
  }
  return null;
}

export async function POST(req: Request) {
  // Auth check (anon key client) + admin check
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

  const { tournamentId } = parsed.data;

  // Use service role for snapshot + tier insert (bypass RLS)
  const adminSb = createSupabaseServiceRoleClient();

  const { data: existingSnapshot } = await adminSb
    .from("odds_snapshots")
    .select("id")
    .eq("tournament_id", tournamentId)
    .maybeSingle();
  if (existingSnapshot?.id) {
    return NextResponse.json({ error: "Snapshot already exists for this tournament (tiers are frozen)." }, { status: 409 });
  }

  const { data: oddsRows, error: oddsErr } = await adminSb
    .from("tournament_odds_latest")
    .select("golfer_id,golfer_name,odds_american,source,source_url,fetched_at")
    .eq("tournament_id", tournamentId);
  if (oddsErr) return NextResponse.json({ error: oddsErr.message }, { status: 400 });

  const matched = (oddsRows ?? []).filter((r) => r.golfer_id);
  if (matched.length < 20) {
    return NextResponse.json({ error: "Too few matched golfers to freeze tiers. Run ESPN sync and odds sync, then retry." }, { status: 400 });
  }

  const { data: rules, error: rulesErr } = await adminSb
    .from("tier_rules")
    .select("tier,min_odds_american,max_odds_american")
    .eq("tournament_id", tournamentId)
    .order("tier", { ascending: true });
  if (rulesErr) return NextResponse.json({ error: rulesErr.message }, { status: 400 });

  const { data: overrides, error: ovErr } = await adminSb
    .from("tier_overrides")
    .select("golfer_id,tier")
    .eq("tournament_id", tournamentId);
  if (ovErr) return NextResponse.json({ error: ovErr.message }, { status: 400 });

  const overrideByGolfer = new Map<string, number>();
  for (const o of overrides ?? []) overrideByGolfer.set(o.golfer_id, o.tier);

  const snapshotPayload = { odds: oddsRows ?? [], rules: rules ?? [], overrides: overrides ?? [] };

  const { data: snapshot, error: snapErr } = await adminSb
    .from("odds_snapshots")
    .insert({ tournament_id: tournamentId, source_url: null, raw_json: snapshotPayload })
    .select("id")
    .single();
  if (snapErr || !snapshot) return NextResponse.json({ error: snapErr?.message ?? "Failed to create snapshot" }, { status: 500 });

  const snapshotId = snapshot.id as string;

  const tiersToInsert = matched.map((r) => {
    const golferId = r.golfer_id as string;
    const overrideTier = overrideByGolfer.get(golferId) ?? null;
    const suggested = rules?.length ? pickTierFromRules(rules, r.odds_american) : null;
    const tier = overrideTier ?? suggested;
    if (!tier) throw new Error(`No tier assigned for golfer ${r.golfer_name} (+${r.odds_american}). Define rules or overrides.`);
    return {
      tournament_id: tournamentId,
      snapshot_id: snapshotId,
      golfer_id: golferId,
      tier,
      odds_text: `+${r.odds_american}`
    };
  });

  const { error: tiersErr } = await adminSb.from("golfer_tiers").insert(tiersToInsert);
  if (tiersErr) return NextResponse.json({ error: tiersErr.message }, { status: 500 });

  // Freezing tiers is the moment picks become available (RLS + RPC require status === 'Open').
  const { error: openErr } = await adminSb.from("tournaments").update({ status: "Open" }).eq("id", tournamentId);
  if (openErr) return NextResponse.json({ error: openErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

