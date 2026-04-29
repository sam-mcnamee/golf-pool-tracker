"use client";

import { useMemo, useState } from "react";
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

export function PicksClient({
  tournamentId,
  tiers,
  existingPicks,
  existingPredictedRelPar
}: {
  tournamentId: string;
  tiers: TierRow[];
  existingPicks: ExistingPick[];
  existingPredictedRelPar: number | null;
}) {
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

  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [venmoOpen, setVenmoOpen] = useState(false);

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
    setVenmoOpen(true);
  }

  async function submitAfterVenmoConfirm() {
    setVenmoOpen(false);
    setSubmitting(true);
    setMessage(null);

    const golferTierIds = Array.from({ length: 7 }, (_, i) => selection[i + 1]).filter(Boolean);
    const predictedWinningScoreRelPar = parseRelPar();
    if (golferTierIds.length !== 7 || predictedWinningScoreRelPar === null) {
      setMessage("Invalid picks or tiebreaker. Fix and try again.");
      setSubmitting(false);
      return;
    }

    try {
      const res = await fetch(`/api/t/${tournamentId}/submit-picks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ golferTierIds, predictedWinningScoreRelPar })
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

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Make picks</h1>
        <p className="text-sm text-slate-600">Pick 1 golfer per tier. Submission is blocked after the pool locks.</p>
      </div>

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
