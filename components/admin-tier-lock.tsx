"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function AdminTierLock() {
  const [source, setSource] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [tournamentId, setTournamentId] = useState<string | null>(null);

  async function onRun() {
    setStatus("running");
    setMessage(null);
    setTournamentId(null);

    try {
      const res = await fetch("api/tier-lock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source })
      });

      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setStatus("error");
        setMessage(json?.error ?? "Request failed");
        return;
      }

      setStatus("done");
      setMessage(json?.message ?? "Done");
      setTournamentId(json?.tournament_id ?? null);
    } catch (e) {
      setStatus("error");
      setMessage(e instanceof Error ? e.message : "Unknown error");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Odds payload</CardTitle>
        <CardDescription>
          Paste a URL or JSON. Expected JSON shape:
          <span className="font-mono"> {"{ tournament: {...}, golfers: [...] }"} </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder={'https://... OR { "tournament": ..., "golfers": [...] }'}
        />
        <div className="flex gap-2">
          <Button onClick={onRun} disabled={!source || status === "running"}>
            {status === "running" ? "Locking..." : "Generate + lock tiers"}
          </Button>
        </div>
        {tournamentId ? <div className="text-xs text-slate-600">Tournament ID: {tournamentId}</div> : null}
        {message ? (
          <div className={status === "error" ? "text-sm text-red-600" : "text-sm text-slate-700"}>{message}</div>
        ) : null}
      </CardContent>
    </Card>
  );
}


