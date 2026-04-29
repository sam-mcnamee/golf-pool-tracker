import Image from "next/image";
import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function HomePage() {
  const supabase = await createSupabaseServerClient();

  const { data: tournaments } = await supabase
    .from("tournaments")
    .select("id,name,status")
    .order("created_at", { ascending: false })
    .limit(1);

  const t = tournaments?.[0];

  return (
    <div className="space-y-10">
      <section className="rounded-2xl border border-club-gold/30 bg-gradient-to-b from-club-cream to-white px-6 py-10 shadow-sm sm:px-10">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 text-center sm:flex-row sm:items-center sm:text-left">
          <Image
            src="/logo.png"
            alt="Chode Emporium Golf Pool crest"
            width={280}
            height={153}
            priority
            className="h-auto w-full max-w-[260px] shrink-0 rounded-xl border-2 border-club-gold/50 bg-white object-contain shadow-md sm:max-w-[240px]"
            sizes="(max-width: 640px) 260px, 240px"
          />
          <div className="min-w-0 space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight text-club-navy sm:text-4xl">Chode Emporium Golf Pool</h1>
            <p className="text-pretty text-sm text-slate-600 sm:text-base">This week&apos;s pool — sign in, lock your picks before tee time, track the board live.</p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-3xl">
        <Card className="border-club-gold/30 shadow-md">
          <CardHeader className="border-b border-club-gold/15 bg-club-cream/40 pb-4">
            <CardTitle className="text-club-navy">Current tournament</CardTitle>
            <CardDescription className="text-slate-600">Most recent event in the pool.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6 pt-6 sm:flex-row sm:items-center sm:justify-between">
            {t ? (
              <>
                <div className="min-w-0 space-y-2">
                  <div className="text-lg font-semibold text-club-navy">{t.name}</div>
                  <div className="text-sm text-slate-600">
                    Status: <span className="font-medium text-club-navy">{t.status}</span>
                  </div>
                  <p className="text-sm text-slate-600">Get your picks in before Thursday at 1 AM PST.</p>
                </div>
                <div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-[220px]">
                  <Button asChild className="w-full bg-club-navy text-white hover:bg-club-navy/90">
                    <Link href={`/t/${t.id}/picks`}>Make picks</Link>
                  </Button>
                  <Button
                    asChild
                    variant="secondary"
                    className="w-full border border-club-gold/50 bg-white text-club-navy hover:bg-club-cream"
                  >
                    <Link href={`/t/${t.id}/leaderboard`}>Leaderboard</Link>
                  </Button>
                  <Link
                    href={`/t/${t.id}`}
                    className="text-center text-sm font-medium text-club-navy underline decoration-club-gold/60 underline-offset-2 hover:decoration-club-gold"
                  >
                    Tournament page
                  </Link>
                </div>
              </>
            ) : (
              <div className="text-sm text-slate-600">
                No tournaments yet. Create one via the admin page after you apply the Supabase schema.
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
