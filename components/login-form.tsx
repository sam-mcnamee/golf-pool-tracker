"use client";

import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Pending = "idle" | "google" | "email";

export function LoginForm({ initialOAuthError }: { initialOAuthError?: string }) {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState<Pending>("idle");
  const [emailSent, setEmailSent] = useState(false);
  const [error, setError] = useState<string | null>(initialOAuthError ?? null);

  async function signInWithGoogle() {
    setPending("google");
    setError(null);
    setEmailSent(false);

    const supabase = createSupabaseBrowserClient();
    const { data, error: oauthErr } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        queryParams: { prompt: "select_account" }
      }
    });

    if (oauthErr) {
      setError(oauthErr.message);
      setPending("idle");
      return;
    }

    if (data.url) {
      window.location.assign(data.url);
      return;
    }

    setError("Could not start Google sign-in.");
    setPending("idle");
  }

  async function onSubmitEmail(e: React.FormEvent) {
    e.preventDefault();
    setPending("email");
    setError(null);
    setEmailSent(false);

    const supabase = createSupabaseBrowserClient();
    const { error: otpErr } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`
      }
    });

    if (otpErr) {
      setError(otpErr.message);
      setPending("idle");
      return;
    }

    setEmailSent(true);
    setPending("idle");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>
          Use Google, or we can email you a magic link. After the first sign-in, you usually stay signed in on this
          device.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => void signInWithGoogle()}
          disabled={pending !== "idle"}
        >
          {pending === "google" ? "Redirecting…" : "Continue with Google"}
        </Button>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-slate-200" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-white px-2 text-slate-500">or</span>
          </div>
        </div>

        <form onSubmit={(e) => void onSubmitEmail(e)} className="space-y-3">
          <Input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <Button type="submit" className="w-full" variant="secondary" disabled={pending !== "idle"}>
            {pending === "email" ? "Sending…" : "Email me a magic link"}
          </Button>
        </form>

        {emailSent ? <p className="text-sm text-slate-600">Check your inbox for the link.</p> : null}
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
