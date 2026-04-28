import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { getClientEnv, getServerEnv } from "@/lib/supabase/env";

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const clientEnv = getClientEnv();

  return createServerClient(clientEnv.NEXT_PUBLIC_SUPABASE_URL, clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components: can be called in contexts where setting cookies is not allowed.
        }
      }
    }
  });
}

export function createSupabaseServiceRoleClient() {
  const env = getServerEnv();
  const clientEnv = getClientEnv();

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY (server-only).");
  }

  return createServerClient(clientEnv.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    cookies: {
      getAll() {
        return [];
      },
      setAll() {}
    }
  });
}

