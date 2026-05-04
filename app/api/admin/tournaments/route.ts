import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";

const isoLike = z
  .string()
  .trim()
  .min(1)
  .refine((s) => Number.isFinite(Date.parse(s)), "Invalid datetime");

const bodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  espn_event_id: z.string().trim().min(1).max(120),
  starts_at: isoLike.optional(),
  open_at: isoLike,
  lock_at: isoLike
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

  const { name, espn_event_id, starts_at, open_at, lock_at } = parsed.data;
  const openMs = Date.parse(open_at);
  const lockMs = Date.parse(lock_at);
  if (lockMs <= openMs) return NextResponse.json({ error: "lock_at must be after open_at" }, { status: 400 });

  const startsAtIso = starts_at ? new Date(Date.parse(starts_at)).toISOString() : null;
  const firstTeeAt = startsAtIso;

  const adminSb = createSupabaseServiceRoleClient();
  const { data: row, error } = await adminSb
    .from("tournaments")
    .insert({
      name,
      espn_event_id,
      open_at: new Date(openMs).toISOString(),
      lock_at: new Date(lockMs).toISOString(),
      starts_at: startsAtIso,
      first_tee_at: firstTeeAt
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "That ESPN event id is already used by another tournament. Use the real id from the leaderboard URL, or a unique placeholder until sync runs." },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, id: row.id as string });
}
