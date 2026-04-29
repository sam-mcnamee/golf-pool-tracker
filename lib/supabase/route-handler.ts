import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { getClientEnv } from "@/lib/supabase/env";

/**
 * Supabase client for Route Handlers: session cookies must be written to the
 * same {@link NextResponse} you return (PKCE / OAuth code exchange, sign-out).
 */
export function createSupabaseRouteHandlerClient(request: NextRequest, response: NextResponse) {
  const env = getClientEnv();

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      }
    }
  });
}
