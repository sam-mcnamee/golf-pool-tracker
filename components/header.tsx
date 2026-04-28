import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";

export async function Header() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  return (
    <header className="border-b">
      <div className="container flex h-14 items-center justify-between">
        <Link href="/" className="font-semibold">
          Golf Pool
        </Link>
        <div className="flex items-center gap-2">
          {user ? (
            <form action="/auth/signout" method="post">
              <Button type="submit" variant="secondary">
                Sign out
              </Button>
            </form>
          ) : (
            <Button asChild variant="secondary">
              <Link href="/login">Sign in</Link>
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}

