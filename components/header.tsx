import Image from "next/image";
import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";

export async function Header() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  return (
    <header className="border-b border-club-gold/25 bg-club-cream/50">
      <div className="container flex h-16 items-center justify-between gap-4">
        <Link href="/" className="flex min-w-0 items-center gap-3 text-club-navy">
          <Image
            src="/logo.png"
            alt="Chode Emporium Golf Pool crest"
            width={56}
            height={31}
            className="h-9 w-auto shrink-0 rounded-md border border-club-gold/40 bg-white object-contain shadow-sm"
            sizes="56px"
          />
          <span className="truncate font-semibold tracking-tight sm:inline">Chode Emporium Golf Pool</span>
        </Link>
        <div className="flex shrink-0 items-center gap-2">
          {user ? (
            <form action="/auth/signout" method="post">
              <Button type="submit" variant="secondary" className="border-club-gold/40 bg-white text-club-navy hover:bg-club-cream">
                Sign out
              </Button>
            </form>
          ) : (
            <Button asChild variant="secondary" className="border-club-gold/40 bg-club-navy text-white hover:bg-club-navy/90">
              <Link href="/login">Sign in</Link>
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
