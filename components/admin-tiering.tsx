"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

type OddsRow = {
  id: string;
  golfer_id: string | null;
  golfer_name: string;
  odds_american: number;
  fetched_at: string;
  source: string;
  source_url: string | null;
};

type Rule = { tier: number; min_odds_american: number | null; max_odds_american: number | null };
type Override = { golfer_id: string; tier: number };

function suggestedTier(rules: Rule[], odds: number): number | null {
  for (const rule of rules) {
    const min = rule.min_odds_american;
    const max = rule.max_odds_american;
    if (min != null && odds < min) continue;
    if (max != null && odds > max) continue;
    return rule.tier;
  }
  return null;
}

export function AdminTiering({
  tournamentId,
  tournamentStatus,
  odds,
  rules,
  overrides,
  hasFrozenTiers
}: {
  tournamentId: string;
  tournamentStatus: string;
  odds: OddsRow[];
  rules: Rule[];
  overrides: Override[];
  hasFrozenTiers: boolean;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const editLocked = hasFrozenTiers || tournamentStatus === "Complete";

  const [ruleState, setRuleState] = useState<Record<number, { min: string; max: string }>>(() => {
    const init: Record<number, { min: string; max: string }> = {};
    for (let t = 1; t <= 7; t++) init[t] = { min: "", max: "" };
    for (const r of rules) init[r.tier] = { min: r.min_odds_american?.toString() ?? "", max: r.max_odds_american?.toString() ?? "" };
    return init;
  });

  const overrideByGolferId = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of overrides) m.set(o.golfer_id, o.tier);
    return m;
  }, [overrides]);

  const computed = useMemo(() => {
    const ruleList: Rule[] = Array.from({ length: 7 }, (_, i) => {
      const tier = i + 1;
      const s = ruleState[tier];
      const min = s?.min ? Number(s.min) : null;
      const max = s?.max ? Number(s.max) : null;
      return { tier, min_odds_american: Number.isFinite(min as number) ? (min as number) : null, max_odds_american: Number.isFinite(max as number) ? (max as number) : null };
    });

    return odds.map((o) => {
      const suggested = suggestedTier(ruleList, o.odds_american);
      const overrideTier = o.golfer_id ? overrideByGolferId.get(o.golfer_id) ?? null : null;
      const finalTier = overrideTier ?? suggested;
      return { ...o, suggested, overrideTier, finalTier };
    });
  }, [odds, overrideByGolferId, ruleState]);

  async function saveRules() {
    setSaving(true);
    setMessage(null);
    try {
      const rulesPayload = Array.from({ length: 7 }, (_, i) => {
        const tier = i + 1;
        const r = ruleState[tier];
        return {
          tier,
          min_odds_american: r.min ? Number(r.min) : null,
          max_odds_american: r.max ? Number(r.max) : null
        };
      });
      const res = await fetch("/api/admin/tiering/rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tournamentId, rules: rulesPayload })
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? "Failed saving rules");
      setMessage("Saved tier rules.");
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  async function setOverride(golferId: string, tier: number | null) {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/tiering/override", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tournamentId, golferId, tier })
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? "Failed setting override");
      setMessage("Saved override.");
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  async function freeze() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/tiering/freeze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tournamentId })
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? "Failed freezing tiers");
      setMessage("Frozen tiers.");
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {editLocked ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {hasFrozenTiers ? (
            <>
              Tier list is frozen for this tournament. Rules and manual bumps are locked; picks use{" "}
              <code className="rounded bg-amber-100 px-1">golfer_tiers</code>. Entry lock timing still follows{" "}
              <code className="rounded bg-amber-100 px-1">lock_at</code> / the pool scheduler.
            </>
          ) : (
            <>
              This tournament is complete. Rules and manual bumps are view-only; picks use{" "}
              <code className="rounded bg-amber-100 px-1">golfer_tiers</code> from the freeze.
            </>
          )}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Tier rules (American odds)</CardTitle>
          <CardDescription>
            Define 7 odds ranges. Suggested tier is derived from these rules. “Freeze tiers” writes{" "}
            <code className="rounded bg-slate-100 px-1">golfer_tiers</code> for the pick sheet (separate from tournament{" "}
            <code className="rounded bg-slate-100 px-1">Open/Locked</code> status).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            {Array.from({ length: 7 }, (_, i) => i + 1).map((tier) => (
              <div key={tier} className="rounded-md border border-slate-200 p-3">
                <div className="mb-2 font-medium">Tier {tier}</div>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    placeholder="min (e.g. 0)"
                    value={ruleState[tier]?.min ?? ""}
                    onChange={(e) => setRuleState((s) => ({ ...s, [tier]: { ...s[tier], min: e.target.value } }))}
                    disabled={editLocked}
                  />
                  <Input
                    placeholder="max (e.g. 1000)"
                    value={ruleState[tier]?.max ?? ""}
                    onChange={(e) => setRuleState((s) => ({ ...s, [tier]: { ...s[tier], max: e.target.value } }))}
                    disabled={editLocked}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={saveRules} disabled={saving || editLocked}>
              {saving ? "Saving..." : "Save rules"}
            </Button>
            <Button variant="secondary" onClick={freeze} disabled={saving || editLocked}>
              Freeze tiers
            </Button>
            {message ? <div className="text-sm text-slate-700">{message}</div> : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Odds (best → worst)</CardTitle>
          <CardDescription>
            Imported odds rows: {odds.length}. Unmatched golfers can’t be overridden until they match an ESPN golfer record.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {computed.map((o) => (
            <div key={o.id} className="flex flex-col gap-2 rounded-md border border-slate-200 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="truncate font-medium">{o.golfer_name}</div>
                <div className="text-xs text-slate-600">
                  +{o.odds_american} · suggested: {o.suggested ?? "—"} · final: {o.finalTier ?? "—"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {o.overrideTier ? <Badge variant="secondary">Override</Badge> : null}
                {o.golfer_id ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setOverride(o.golfer_id as string, Math.max(1, (o.finalTier ?? 4) - 1))}
                      disabled={saving || editLocked}
                    >
                      Up
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setOverride(o.golfer_id as string, Math.min(7, (o.finalTier ?? 4) + 1))}
                      disabled={saving || editLocked}
                    >
                      Down
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => setOverride(o.golfer_id as string, null)} disabled={saving || editLocked}>
                      Clear
                    </Button>
                  </>
                ) : (
                  <Badge variant="destructive">Unmatched</Badge>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

