import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const err = searchParams.get("error_description") ?? searchParams.get("error");
  if (err) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(err)}`);
  }

  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(`${origin}/login`);
  }

  const supabase = await createSupabaseServerClient();
  await supabase.auth.exchangeCodeForSession(code);

  return NextResponse.redirect(`${origin}/`);
}

