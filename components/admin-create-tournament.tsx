"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function localDatetimeToIso(local: string): string | null {
  const t = local.trim();
  if (!t) return null;
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export function AdminCreateTournament() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [espnEventId, setEspnEventId] = useState("");
  const [startsLocal, setStartsLocal] = useState("");
  const [openLocal, setOpenLocal] = useState("");
  const [lockLocal, setLockLocal] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit() {
    setMessage(null);
    const openIso = localDatetimeToIso(openLocal);
    const lockIso = localDatetimeToIso(lockLocal);
    const startsIso = localDatetimeToIso(startsLocal);
    if (!name.trim()) {
      setMessage("Enter a tournament name.");
      return;
    }
    if (!espnEventId.trim()) {
      setMessage("Enter an ESPN event id (from the leaderboard URL ?event=…).");
      return;
    }
    if (!openIso || !lockIso) {
      setMessage("Open at and Lock at are required (use the datetime fields).");
      return;
    }

    setBusy(true);
    try {
      const body: {
        name: string;
        espn_event_id: string;
        open_at: string;
        lock_at: string;
        starts_at?: string;
      } = {
        name: name.trim(),
        espn_event_id: espnEventId.trim(),
        open_at: openIso,
        lock_at: lockIso
      };
      if (startsIso) body.starts_at = startsIso;

      const res = await fetch("/api/admin/tournaments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? "Create failed");

      setName("");
      setEspnEventId("");
      setStartsLocal("");
      setOpenLocal("");
      setLockLocal("");
      router.push(`/admin?tournamentId=${encodeURIComponent(json.id as string)}`);
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="border-club-gold/30">
      <CardHeader>
        <CardTitle>Create tournament</CardTitle>
        <CardDescription>
          Add a new week (e.g. Truist). Use the numeric <code className="text-xs">event</code> id from ESPN&apos;s leaderboard URL so the scraper can upsert the same row.{" "}
          <strong>Open at</strong> / <strong>Lock at</strong> are in <em>your browser&apos;s local timezone</em> — convert from Eastern if needed (pool copy references ET).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="new-t-name">Name</Label>
            <Input id="new-t-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Truist Championship" disabled={busy} />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="new-t-espn">ESPN event id</Label>
            <Input id="new-t-espn" value={espnEventId} onChange={(e) => setEspnEventId(e.target.value)} placeholder="401811945" disabled={busy} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-t-starts">First tee / starts (optional)</Label>
            <Input
              id="new-t-starts"
              type="datetime-local"
              value={startsLocal}
              onChange={(e) => setStartsLocal(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-t-open">Open at (required)</Label>
            <Input id="new-t-open" type="datetime-local" value={openLocal} onChange={(e) => setOpenLocal(e.target.value)} disabled={busy} required />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="new-t-lock">Lock at (required)</Label>
            <Input id="new-t-lock" type="datetime-local" value={lockLocal} onChange={(e) => setLockLocal(e.target.value)} disabled={busy} required />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => void submit()} disabled={busy}>
            {busy ? "Creating…" : "Create tournament"}
          </Button>
          {message ? <p className="text-sm text-slate-800">{message}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}
