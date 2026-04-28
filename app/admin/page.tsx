import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AdminTiering } from "@/components/admin-tiering";

export default async function AdminHome() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("is_admin").eq("user_id", user.id).maybeSingle();
  if (!profile?.is_admin) redirect("/");

  const { data: t } = await supabase
    .from("tournaments")
    .select("id,name,status,cut_complete")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!t) redirect("/");

  const { data: odds } = await supabase
    .from("tournament_odds_latest")
    .select("id,golfer_id,golfer_name,odds_american,fetched_at,source,source_url")
    .eq("tournament_id", t.id)
    .order("odds_american", { ascending: true });

  const { data: rules } = await supabase
    .from("tier_rules")
    .select("tier,min_odds_american,max_odds_american")
    .eq("tournament_id", t.id)
    .order("tier", { ascending: true });

  const { data: overrides } = await supabase
    .from("tier_overrides")
    .select("golfer_id,tier")
    .eq("tournament_id", t.id);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="text-sm text-slate-600">
          {t.name} · Status: {t.status}
        </p>
      </div>
      <AdminTiering tournamentId={t.id} odds={odds ?? []} rules={rules ?? []} overrides={overrides ?? []} />
    </div>
  );
}

