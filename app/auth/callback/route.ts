import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseRouteHandlerClient } from "@/lib/supabase/route-handler";

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

  return response;
}
