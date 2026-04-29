"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { computeBest4 } from "@/lib/domain/scoring";

const VENMO_HANDLE = "Sam-McNamee";
const VENMO_AT = "@Sam-McNamee";
const VENMO_APP_URL = `venmo://paycharge?txn=pay&recipients=${VENMO_HANDLE}`;
const VENMO_WEB_URL = `https://venmo.com/${VENMO_HANDLE}`;

type TierRow = {
  id: string;
  tier: number;
  odds_text: string | null;
  golfers:
    | {
        id: string;
        name: string;
        espn_athlete_id: string;
        total_score: number | null;
        is_cut: boolean | null;
        status: string | null;
      }
    | {
        id: string;
        name: string;
        espn_athlete_id: string;
        total_score: number | null;
        is_cut: boolean | null;
        status: string | null;
      }[]
    | null;
};

type ExistingPick = { tier: number; golfer_tier_id: string };
type TierPerf = { tier: number; best: string[]; worst: string[] };

export function PicksClient({
  tournamentId,
  tiers,
  existingPicks,
  existingPredictedRelPar,
  existingTeamName,
  tournamentStatus,
  tournamentName
}: {
  tournamentId: string;
  tiers: TierRow[];
  existingPicks: ExistingPick[];
  existingPredictedRelPar: number | null;
  existingTeamName: string | null;
  tournamentStatus: string;
  tournamentName: string;
}) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const tiersByNumber = useMemo(() => {
    const map = new Map<number, TierRow[]>();
    for (const row of tiers) {
      const arr = map.get(row.tier) ?? [];
      arr.push(row);
      map.set(row.tier, arr);
    }
    return map;
  }, [tiers]);

  const [selection, setSelection] = useState<Record<number, string>>(() => {
    const init: Record<number, string> = {};
    for (const p of existingPicks) init[p.tier] = p.golfer_tier_id;
    return init;
  });

  const [predictedRelParInput, setPredictedRelParInput] = useState(
    existingPredictedRelPar !== null && existingPredictedRelPar !== undefined
      ? String(existingPredictedRelPar)
      : ""
  );
  const [teamNameInput, setTeamNameInput] = useState(existingTeamName ?? "");

  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [venmoOpen, setVenmoOpen] = useState(false);
  const [tierPerf, setTierPerf] = useState<TierPerf[]>([]);

  const hasStarted = useMemo(
    () => ["Locked", "Live", "Complete"].includes(tournamentStatus),
    [tournamentStatus]
  );

  const allChosen = useMemo(() => {
    for (let tier = 1; tier <= 7; tier++) {
      if (!selection[tier]) return false;
    }
    return true;
  }, [selection]);

  function parseRelPar(): number | null {
    const t = predictedRelParInput.trim();
    if (!t) return null;
    const n = Number(t);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
    return n;
  }

  function openVenmoStep() {
    setMessage(null);
    const golferTierIds = Array.from({ length: 7 }, (_, i) => selection[i + 1]).filter(Boolean);
    if (golferTierIds.length !== 7) {
      setMessage("Pick exactly one golfer per tier before submitting.");
      return;
    }
    const rel = parseRelPar();
    if (rel === null) {
      setMessage("Enter your predicted winning score relative to par (whole number, e.g. -12).");
      return;
    }
    if (teamNameInput.trim().length < 2) {
      setMessage("Enter a team name (at least 2 characters).");
      return;
    }
    setVenmoOpen(true);
  }

  async function submitAfterVenmoConfirm() {
    setVenmoOpen(false);
    setSubmitting(true);
    setMessage(null);

    const golferTierIds = Array.from({ length: 7 }, (_, i) => selection[i + 1]).filter(Boolean);
    const predictedWinningScoreRelPar = parseRelPar();
    const teamName = teamNameInput.trim();
    if (golferTierIds.length !== 7 || predictedWinningScoreRelPar === null || teamName.length < 2) {
      setMessage("Invalid picks or tiebreaker. Fix and try again.");
      setSubmitting(false);
      return;
    }

    try {
      const res = await fetch(`/api/t/${tournamentId}/submit-picks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ golferTierIds, predictedWinningScoreRelPar, teamName })
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setMessage(json?.error ?? "Submit failed");
        return;
      }

      setMessage("Saved.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Submit failed");
    } finally {
      setSubmitting(false);
    }
  }

  const selectedPicks = useMemo(() => {
    const out: {
      tier: number;
      name: string;
      total_score: number | null;
      is_cut: boolean | null;
    }[] = [];
    for (let tier = 1; tier <= 7; tier++) {
      const selectedId = selection[tier];
      if (!selectedId) continue;
      const options = tiersByNumber.get(tier) ?? [];
      const row = options.find((r) => r.id === selectedId);
      const golfer0 = row?.golfers ?? null;
      const golfer = Array.isArray(golfer0) ? golfer0[0] ?? null : golfer0;
      if (!golfer) continue;
      out.push({ tier, name: golfer.name, total_score: golfer.total_score, is_cut: golfer.is_cut });
    }
    return out;
  }, [selection, tiersByNumber]);

  const myOverallScore = useMemo(
    () =>
      computeBest4(
        selectedPicks.map((p) => ({ name: p.name, total_score: p.total_score, is_cut: p.is_cut, status: null }))
      ).sum,
    [selectedPicks]
  );

  useEffect(() => {
    if (!hasStarted) {
      setTierPerf([]);
      return;
    }

    let cancelled = false;
    async function loadTierPerf() {
      const { data: picks } = await supabase
        .from("picks")
        .select("user_id,golfer_tiers:golfer_tier_id(tier,golfers:golfer_id(name,total_score))")
        .eq("tournament_id", tournamentId);

      if (cancelled) return;
      const byTier = new Map<number, { name: string; score: number }[]>();
      for (const row of picks ?? []) {
        const gt0 = row.golfer_tiers;
        const gt = Array.isArray(gt0) ? gt0[0] ?? null : gt0;
        if (!gt?.tier) continue;
        const golfer0 = gt.golfers;
        const golfer = Array.isArray(golfer0) ? golfer0[0] ?? null : golfer0;
        if (!golfer || typeof golfer.total_score !== "number") continue;
        const arr = byTier.get(gt.tier) ?? [];
        arr.push({ name: golfer.name, score: golfer.total_score });
        byTier.set(gt.tier, arr);
      }

      const perf: TierPerf[] = [];
      for (let t = 1; t <= 7; t++) {
        const arr = byTier.get(t) ?? [];
        if (!arr.length) {
          perf.push({ tier: t, best: [], worst: [] });
          continue;
        }
        const bestScore = Math.min(...arr.map((x) => x.score));
        const worstScore = Math.max(...arr.map((x) => x.score));
        perf.push({
          tier: t,
          best: arr.filter((x) => x.score === bestScore).map((x) => `${x.name} (${x.score})`),
          worst: arr.filter((x) => x.score === worstScore).map((x) => `${x.name} (${x.score})`)
        });
      }
      setTierPerf(perf);
    }
    void loadTierPerf();
    return () => {
      cancelled = true;
    };
  }, [hasStarted, supabase, tournamentId]);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Make picks</h1>
        <p className="text-sm text-slate-600">
          {tournamentName} · Status: {tournamentStatus}. Pick 1 golfer per tier. Submission is blocked after the pool
          locks.
        </p>
      </div>

      {hasStarted ? (
        <Card>
          <CardHeader>
            <CardTitle>Your current overall score</CardTitle>
            <CardDescription>Best 4 golfer totals are counted (same scoring as leaderboard).</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="inline-flex items-center rounded-md border border-slate-300 bg-slate-50 px-4 py-2 text-2xl font-semibold tabular-nums">
              {myOverallScore ?? "—"}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Team name</CardTitle>
          <CardDescription>
            This appears on the leaderboard as your primary identity. Required before picks can be submitted.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="team-name">Team name</Label>
          <Input
            id="team-name"
            type="text"
            maxLength={60}
            placeholder="e.g. Birdie Brigade"
            value={teamNameInput}
            onChange={(e) => setTeamNameInput(e.target.value)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tiebreaker</CardTitle>
          <CardDescription>Predict the winner&apos;s score relative to par (e.g. -12). Used only to break ties.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="rel-par">Winning score vs par</Label>
          <Input
            id="rel-par"
            type="text"
            inputMode="numeric"
            pattern="-?[0-9]*"
            placeholder="-12"
            value={predictedRelParInput}
            onChange={(e) => setPredictedRelParInput(e.target.value)}
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 7 }, (_, i) => i + 1).map((tierNum) => {
          const rows = tiersByNumber.get(tierNum) ?? [];
          return (
            <Card key={tierNum}>
              <CardHeader>
                <CardTitle>Tier {tierNum}</CardTitle>
                <CardDescription>Select 1 golfer.</CardDescription>
              </CardHeader>
              <CardContent>
                {rows.length ? (
                  <RadioGroup
                    value={selection[tierNum] ?? ""}
                    onValueChange={(v) => setSelection((s) => ({ ...s, [tierNum]: v }))}
                    className="gap-3"
                  >
                    {rows.map((row) => {
                      const golfer = Array.isArray(row.golfers) ? row.golfers[0] : row.golfers;
                      return (
                        <label
                          key={row.id}
                          className={cn(
                            "flex cursor-pointer items-start gap-3 rounded-md border border-slate-200 p-3 hover:bg-slate-50",
                            selection[tierNum] === row.id && "border-slate-900"
                          )}
                        >
                          <RadioGroupItem value={row.id} aria-label={`Select ${golfer?.name ?? "golfer"}`} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <div className="truncate font-medium">{golfer?.name ?? "Unknown golfer"}</div>
                              <div className="shrink-0 text-xs text-slate-600">{row.odds_text ?? ""}</div>
                            </div>
                            <div className="text-xs text-slate-600">ESPN athlete: {golfer?.espn_athlete_id ?? "n/a"}</div>
                          </div>
                        </label>
                      );
                    })}
                  </RadioGroup>
                ) : (
                  <div className="text-sm text-slate-600">No golfers found for this tier yet.</div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={openVenmoStep} disabled={!allChosen || submitting}>
          {submitting ? "Submitting..." : "Submit picks"}
        </Button>
        {!allChosen ? <div className="text-sm text-slate-600">You must select 7 golfers.</div> : null}
        {message ? <div className="text-sm text-slate-700">{message}</div> : null}
      </div>

      {hasStarted ? (
        <Card>
          <CardHeader>
            <CardTitle>Tier-by-tier performance</CardTitle>
            <CardDescription>
              Compares currently visible picks for each tier. Lower score is better. Shows best/worst current picks.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {Array.from({ length: 7 }, (_, i) => i + 1).map((tier) => {
              const mine = selectedPicks.find((p) => p.tier === tier);
              const perf = tierPerf.find((p) => p.tier === tier);
              return (
                <div key={tier} className="rounded-md border border-slate-200 p-3">
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium">Tier {tier}</div>
                    <div className="text-sm text-slate-700">
                      Your pick: {mine ? `${mine.name} (${mine.total_score ?? "-"})` : "—"}
                    </div>
                  </div>
                  <div className="text-sm text-slate-700">
                    <div>
                      <span className="font-medium">Best:</span>{" "}
                      {perf?.best?.length ? perf.best.join(", ") : "No visible scored picks yet"}
                    </div>
                    <div>
                      <span className="font-medium">Worst:</span>{" "}
                      {perf?.worst?.length ? perf.worst.join(", ") : "No visible scored picks yet"}
                    </div>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      <AlertDialog open={venmoOpen} onOpenChange={setVenmoOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send entry fee on Venmo</AlertDialogTitle>
            <AlertDialogDescription>
              Before your picks are saved, send your pool entry to {VENMO_AT}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-wrap gap-2">
            <Button asChild type="button" variant="secondary" size="sm">
              <a href={VENMO_APP_URL}>Open Venmo app</a>
            </Button>
            <Button asChild type="button" variant="outline" size="sm">
              <a href={VENMO_WEB_URL} target="_blank" rel="noreferrer">
                Venmo on web
              </a>
            </Button>
          </div>
          <p className="text-xs text-slate-500">
            If the app link does nothing, use the web button or search {VENMO_AT} in the Venmo app.
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Back</AlertDialogCancel>
            <Button type="button" disabled={submitting} onClick={() => void submitAfterVenmoConfirm()}>
              {submitting ? "Saving..." : "I sent Venmo — save my picks"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
