import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function HomePage() {
  const supabase = await createSupabaseServerClient();

  const { data: tournaments } = await supabase
    .from("tournaments")
    .select("id,name,status,open_at,lock_at")
    .order("created_at", { ascending: false })
    .limit(1);

  const t = tournaments?.[0];

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">7-Tier Golf Pool Tracker</h1>
        <p className="text-slate-600">
          Pick exactly 1 golfer per tier. Your score is the sum of your best 4 golfers. If fewer than 4 make the
          cut, you’re marked <span className="font-semibold">MC</span>.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Current tournament</CardTitle>
          <CardDescription>Most recent tournament in the database.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {t ? (
            <>
              <div className="space-y-1">
                <div className="font-medium">{t.name}</div>
                <div className="text-sm text-slate-600">Status: {t.status}</div>
              </div>
              <div className="flex gap-2">
                <Button asChild variant="secondary">
                  <Link href={`/t/${t.id}`}>View</Link>
                </Button>
                <Button asChild>
                  <Link href={`/t/${t.id}/leaderboard`}>Leaderboard</Link>
                </Button>
              </div>
            </>
          ) : (
            <div className="text-sm text-slate-600">
              No tournaments yet. Create one via the admin page after you apply the Supabase schema.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

