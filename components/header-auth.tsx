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
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    let cancelled = false;

    async function refreshAdminFlag(uid: string | undefined) {
      if (!uid) {
        setIsAdmin(false);
        return;
      }
      const { data: profile } = await supabase.from("profiles").select("is_admin").eq("user_id", uid).maybeSingle();
      if (!cancelled) setIsAdmin(Boolean(profile?.is_admin));
    }

    void supabase.auth.getUser().then(({ data: { user: u } }) => {
      if (cancelled) return;
      setUser(u ?? null);
      void refreshAdminFlag(u?.id);
    });

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const u = session?.user ?? null;
      setUser(u);
      void refreshAdminFlag(u?.id);
    });

    return () => {
      cancelled = true;
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
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 sm:gap-3">
      <span
        className="hidden max-w-[9rem] truncate text-right text-sm font-medium text-club-navy sm:inline"
        title={user.email ?? undefined}
      >
        {displayName(user)}
      </span>
      {isAdmin ? (
        <Button asChild variant="outline" size="sm" className="border-club-gold/50 bg-white text-club-navy hover:bg-club-cream">
          <Link href="/admin">Admin</Link>
        </Button>
      ) : null}
      <form action="/auth/signout" method="post">
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          className="border-club-gold/40 bg-white text-club-navy hover:bg-club-cream"
        >
          Sign out
        </Button>
      </form>
    </div>
  );
}
