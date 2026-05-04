import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseRouteHandlerClient } from "@/lib/supabase/route-handler";
import { displayNameFromOAuthMetadata } from "@/lib/auth/display-name";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const origin = url.origin;
  const err = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (err) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(err)}`);
  }

  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/";

  if (!code) {
    return NextResponse.redirect(`${origin}/login`);
  }

  const redirectPath = next.startsWith("/") ? next : "/";
  const response = NextResponse.redirect(`${origin}${redirectPath}`);

  const supabase = createSupabaseRouteHandlerClient(request, response);
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(`${origin}/auth/auth-code-error?reason=${encodeURIComponent(error.message)}`);
  }

  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (user) {
    const idMeta = user.identities?.[0]?.identity_data as Record<string, unknown> | undefined;
    const merged: Record<string, unknown> = { ...(idMeta ?? {}), ...(user.user_metadata ?? {}) };
    const display = displayNameFromOAuthMetadata(merged, user.email);
    if (display) {
      const { data: existing } = await supabase.from("profiles").select("user_id").eq("user_id", user.id).maybeSingle();
      if (existing) {
        await supabase.from("profiles").update({ display_name: display }).eq("user_id", user.id);
      } else {
        await supabase.from("profiles").insert({ user_id: user.id, display_name: display });
      }
    }
  }

  return response;
}
