import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AdminOddsUpload } from "@/components/admin-odds-upload";
import { AdminTiering } from "@/components/admin-tiering";
import { AdminTournamentPicker } from "@/components/admin-tournament-picker";

type Props = {
  searchParams: Promise<{ tournamentId?: string }>;
};

export default async function AdminHome({ searchParams }: Props) {
  const sp = await searchParams;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("is_admin").eq("user_id", user.id).maybeSingle();
  if (!profile?.is_admin) redirect("/");

  const { data: tournaments } = await supabase
    .from("tournaments")
    .select("id,name,status")
    .neq("status", "Complete")
    .order("created_at", { ascending: false });

  const list = tournaments ?? [];
  if (list.length === 0) redirect("/");

  const requestedId = sp.tournamentId;
  const t = list.find((row) => row.id === requestedId) ?? list[0];

  const [{ data: odds }, { data: rules }, { data: overrides }, { data: snapshot }] = await Promise.all([
    supabase
      .from("tournament_odds_latest")
      .select("id,golfer_id,golfer_name,odds_american,fetched_at,source,source_url")
      .eq("tournament_id", t.id)
      .order("odds_american", { ascending: true }),
    supabase
      .from("tier_rules")
      .select("tier,min_odds_american,max_odds_american")
      .eq("tournament_id", t.id)
      .order("tier", { ascending: true }),
    supabase.from("tier_overrides").select("golfer_id,tier").eq("tournament_id", t.id),
    supabase.from("odds_snapshots").select("id").eq("tournament_id", t.id).maybeSingle()
  ]);

  const hasFrozenTiers = Boolean(snapshot?.id);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="text-sm text-slate-600">
          {t.name} · Status: {t.status}
        </p>
      </div>
      <AdminTournamentPicker tournaments={list} currentId={t.id} />
      <AdminOddsUpload tournamentId={t.id} disabled={hasFrozenTiers} />
      <AdminTiering
        key={t.id}
        tournamentId={t.id}
        odds={odds ?? []}
        rules={rules ?? []}
        overrides={overrides ?? []}
        hasFrozenTiers={hasFrozenTiers}
      />
    </div>
  );
}
