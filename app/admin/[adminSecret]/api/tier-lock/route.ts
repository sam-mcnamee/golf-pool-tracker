import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

const oddsGolferSchema = z.object({
  name: z.string().min(1),
  espn_athlete_id: z.string().min(1).optional(),
  athlete_id: z.string().min(1).optional(),
  odds: z.string().optional(),
  odds_text: z.string().optional(),
  tier: z.number().int().min(1).max(7).optional()
});

const payloadSchema = z.object({
  tournament: z.object({
    name: z.string().min(1),
    espn_event_id: z.string().min(1),
    open_at: z.string().datetime().optional(),
    lock_at: z.string().datetime().optional(),
    first_tee_at: z.string().datetime().optional()
  }),
  golfers: z.array(oddsGolferSchema).min(7)
});

function parseOddsNumber(s: string | undefined) {
  if (!s) return null;
  // Handle formats like "+1200", "12/1", "1200", "12-1"
  const normalized = s.trim();
  const frac = normalized.match(/^(\d+(?:\.\d+)?)\s*[\/-]\s*(\d+(?:\.\d+)?)$/);
  if (frac) {
    const a = Number(frac[1]);
    const b = Number(frac[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) return a / b;
  }
  const n = Number(normalized.replace(/[^0-9.+-]/g, ""));
  if (!Number.isFinite(n)) return null;
  return n;
}

function assignTiers(golfers: z.infer<typeof oddsGolferSchema>[]) {
  // If any golfers explicitly declare tier, require all to declare tier.
  const anyTier = golfers.some((g) => typeof g.tier === "number");
  if (anyTier) {
    const missing = golfers.filter((g) => typeof g.tier !== "number");
    if (missing.length) throw new Error("If any golfer includes tier, all golfers must include tier.");
    return golfers as Array<Required<Pick<(typeof golfers)[number], "tier">> & (typeof golfers)[number]>;
  }

  const sorted = [...golfers].sort((a, b) => {
    const ao = parseOddsNumber(a.odds_text ?? a.odds);
    const bo = parseOddsNumber(b.odds_text ?? b.odds);
    if (ao === null && bo === null) return 0;
    if (ao === null) return 1;
    if (bo === null) return -1;
    // Lower is better if fractional; if american, smaller absolute? We just keep numeric ascending.
    return ao - bo;
  });

  const perTier = Math.ceil(sorted.length / 7);
  return sorted.map((g, idx) => ({ ...g, tier: Math.min(7, Math.floor(idx / perTier) + 1) }));
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const source = body?.source;
  if (typeof source !== "string" || !source.trim()) {
    return NextResponse.json({ error: "Missing source" }, { status: 400 });
  }

  let raw: unknown;
  if (/^https?:\/\//i.test(source.trim())) {
    const res = await fetch(source.trim(), { headers: { accept: "application/json" } });
    if (!res.ok) {
      return NextResponse.json({ error: `Failed to fetch URL (${res.status})` }, { status: 400 });
    }
    raw = await res.json().catch(() => null);
  } else {
    raw = JSON.parse(source);
  }

  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  const supabase = createSupabaseServiceRoleClient();

  const t = parsed.data.tournament;
  const now = new Date();
  const open_at = t.open_at ? new Date(t.open_at) : now;
  const lock_at = t.lock_at ? new Date(t.lock_at) : new Date(now.getTime() + 1000 * 60 * 60 * 24 * 3);
  const first_tee_at = t.first_tee_at ? new Date(t.first_tee_at) : null;

  const { data: tournamentRow, error: tournamentErr } = await supabase
    .from("tournaments")
    .upsert(
      {
        name: t.name,
        espn_event_id: t.espn_event_id,
        open_at: open_at.toISOString(),
        lock_at: lock_at.toISOString(),
        first_tee_at: first_tee_at ? first_tee_at.toISOString() : null
      },
      { onConflict: "espn_event_id" }
    )
    .select("id,name")
    .single();

  if (tournamentErr || !tournamentRow) {
    return NextResponse.json({ error: tournamentErr?.message ?? "Failed to upsert tournament" }, { status: 500 });
  }

  const tournament_id = tournamentRow.id as string;

  const { data: existingSnapshot } = await supabase
    .from("odds_snapshots")
    .select("id")
    .eq("tournament_id", tournament_id)
    .maybeSingle();

  if (existingSnapshot?.id) {
    return NextResponse.json({ error: "Snapshot already exists for this tournament (tiers are frozen)." }, { status: 409 });
  }

  const { data: snapshotRow, error: snapshotErr } = await supabase
    .from("odds_snapshots")
    .insert({
      tournament_id,
      source_url: /^https?:\/\//i.test(source.trim()) ? source.trim() : null,
      raw_json: parsed.data
    })
    .select("id")
    .single();

  if (snapshotErr || !snapshotRow) {
    return NextResponse.json({ error: snapshotErr?.message ?? "Failed to create snapshot" }, { status: 500 });
  }

  const snapshot_id = snapshotRow.id as string;
  const golfersWithTiers = assignTiers(parsed.data.golfers);

  const tierSet = new Set(golfersWithTiers.map((g) => g.tier));
  if (tierSet.size !== 7) {
    return NextResponse.json({ error: "Tier assignment must cover tiers 1..7." }, { status: 400 });
  }

  const golfersToUpsert = golfersWithTiers.map((g) => {
    const athleteId = g.espn_athlete_id ?? g.athlete_id;
    if (!athleteId) throw new Error(`Missing espn_athlete_id for golfer: ${g.name}`);
    return {
      tournament_id,
      espn_athlete_id: athleteId,
      name: g.name
    };
  });

  const { error: upsertGolfersErr } = await supabase
    .from("golfers")
    .upsert(golfersToUpsert, { onConflict: "tournament_id,espn_athlete_id" });

  if (upsertGolfersErr) {
    return NextResponse.json({ error: upsertGolfersErr.message }, { status: 500 });
  }

  // Fetch golfer ids for tier linking
  const athleteIds = golfersToUpsert.map((g) => g.espn_athlete_id);
  const { data: golferRows, error: golfersSelErr } = await supabase
    .from("golfers")
    .select("id,espn_athlete_id")
    .eq("tournament_id", tournament_id)
    .in("espn_athlete_id", athleteIds);

  if (golfersSelErr || !golferRows) {
    return NextResponse.json({ error: golfersSelErr?.message ?? "Failed to fetch golfers" }, { status: 500 });
  }

  const idByAthlete = new Map<string, string>();
  for (const r of golferRows) idByAthlete.set(r.espn_athlete_id, r.id);

  const tiersToInsert = golfersWithTiers.map((g) => {
    const athleteId = (g.espn_athlete_id ?? g.athlete_id) as string;
    const golfer_id = idByAthlete.get(athleteId);
    if (!golfer_id) throw new Error(`Failed to resolve golfer id for athlete_id=${athleteId}`);
    return {
      tournament_id,
      snapshot_id,
      golfer_id,
      tier: g.tier,
      odds_text: g.odds_text ?? g.odds ?? null
    };
  });

  const { error: tiersErr } = await supabase.from("golfer_tiers").insert(tiersToInsert);
  if (tiersErr) {
    return NextResponse.json({ error: tiersErr.message }, { status: 500 });
  }

  return NextResponse.json({
    message: `Locked tiers for ${tournamentRow.name}.`,
    tournament_id
  });
}

