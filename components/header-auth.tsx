"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { User } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

function displayName(user: User): string {
  const meta = user.user_metadata as Record<string, string | undefined> | undefined;
  const fromMeta = meta?.full_name ?? meta?.name ?? meta?.preferred_username;
  if (fromMeta && String(fromMeta).trim()) return String(fromMeta).trim();
  if (user.email) return user.email;
  return "Signed in";
}

export function HeaderAuth() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();

    void supabase.auth.getUser().then(({ data: { user: u } }) => {
      setUser(u ?? null);
    });

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  if (user === undefined) {
    return <div className="h-9 min-w-[8rem] rounded-md bg-club-cream/80 animate-pulse" aria-hidden />;
  }

  if (!user) {
    return (
      <Button asChild variant="secondary" className="border-club-gold/40 bg-club-navy text-white hover:bg-club-navy/90">
        <Link href="/login">Sign in</Link>
      </Button>
    );
  }

  return (
    <div className="flex max-w-[min(100vw-8rem,22rem)] shrink-0 items-center gap-2 sm:gap-3">
      <span className="truncate text-right text-sm font-medium text-club-navy" title={user.email ?? undefined}>
        {displayName(user)}
      </span>
      <form action="/auth/signout" method="post">
        <Button type="submit" variant="secondary" className="border-club-gold/40 bg-white text-club-navy hover:bg-club-cream">
          Sign out
        </Button>
      </form>
    </div>
  );
}
