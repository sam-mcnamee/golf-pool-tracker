"use client";

import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Pending = "idle" | "google";

export function LoginForm({ initialOAuthError }: { initialOAuthError?: string }) {
  const [pending, setPending] = useState<Pending>("idle");
  const [error, setError] = useState<string | null>(initialOAuthError ?? null);

  async function signInWithGoogle() {
    setPending("google");
    setError(null);

    const supabase = createSupabaseBrowserClient();
    const callback = new URL("/auth/callback", window.location.origin);
    callback.searchParams.set("next", "/");
    const { data, error: oauthErr } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: callback.toString(),
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>
          Use Google sign-in. After the first sign-in, you usually stay signed in on this device.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => void signInWithGoogle()}
          disabled={pending !== "idle"}
        >
          {pending === "google" ? "Redirecting…" : "Continue with Google"}
        </Button>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
