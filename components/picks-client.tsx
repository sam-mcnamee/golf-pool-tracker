"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

type TierRow = {
  id: string;
  tier: number;
  odds_text: string | null;
  golfers: {
    id: string;
    name: string;
    espn_athlete_id: string;
    total_score: number | null;
    is_cut: boolean | null;
    status: string | null;
  } | null;
};

type ExistingPick = { tier: number; golfer_tier_id: string };

export function PicksClient({
  tournamentId,
  tiers,
  existingPicks
}: {
  tournamentId: string;
  tiers: TierRow[];
  existingPicks: ExistingPick[];
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

  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const allChosen = useMemo(() => {
    for (let tier = 1; tier <= 7; tier++) {
      if (!selection[tier]) return false;
    }
    return true;
  }, [selection]);

  async function submit() {
    setSubmitting(true);
    setMessage(null);

    try {
      const golferTierIds = Array.from({ length: 7 }, (_, i) => selection[i + 1]).filter(Boolean);
      if (golferTierIds.length !== 7) {
        setMessage("Pick exactly one golfer per tier before submitting.");
        setSubmitting(false);
        return;
      }

      const res = await fetch(`/api/t/${tournamentId}/submit-picks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ golferTierIds })
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setMessage(json?.error ?? "Submit failed");
        setSubmitting(false);
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
                    {rows.map((row) => (
                      <label
                        key={row.id}
                        className={cn(
                          "flex cursor-pointer items-start gap-3 rounded-md border border-slate-200 p-3 hover:bg-slate-50",
                          selection[tierNum] === row.id && "border-slate-900"
                        )}
                      >
                        <RadioGroupItem value={row.id} aria-label={`Select ${row.golfers?.name ?? "golfer"}`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <div className="truncate font-medium">{row.golfers?.name ?? "Unknown golfer"}</div>
                            <div className="shrink-0 text-xs text-slate-600">{row.odds_text ?? ""}</div>
                          </div>
                          <div className="text-xs text-slate-600">
                            ESPN athlete: {row.golfers?.espn_athlete_id ?? "n/a"}
                          </div>
                        </div>
                      </label>
                    ))}
                  </RadioGroup>
                ) : (
                  <div className="text-sm text-slate-600">No golfers found for this tier yet.</div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={submit} disabled={!allChosen || submitting}>
          {submitting ? "Submitting..." : "Submit picks"}
        </Button>
        {!allChosen ? <div className="text-sm text-slate-600">You must select 7 golfers.</div> : null}
        {message ? <div className="text-sm text-slate-700">{message}</div> : null}
      </div>
    </div>
  );
}

