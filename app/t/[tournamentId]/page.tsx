import Link from "next/link";
import { notFound } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function TournamentPage({ params }: { params: Promise<{ tournamentId: string }> }) {
  const { tournamentId } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: t } = await supabase
    .from("tournaments")
    .select("id,name,status,open_at,lock_at,first_tee_at,cut_complete")
    .eq("id", tournamentId)
    .maybeSingle();

  if (!t) notFound();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t.name}</h1>
        <p className="text-sm text-slate-600">Status: {t.status}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Submit picks</CardTitle>
            <CardDescription>Pick 1 golfer per tier (7 total).</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link href={`/t/${t.id}/picks`}>Make picks</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Leaderboard</CardTitle>
            <CardDescription>Live Best-4 scoring, MC to the bottom.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="secondary" className="w-full">
              <Link href={`/t/${t.id}/leaderboard`}>View leaderboard</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

