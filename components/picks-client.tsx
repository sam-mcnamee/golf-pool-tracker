"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import { formatGolferTotalScore, formatScore, golferTotalScoreClass } from "@/lib/domain/score-display";
import { isPlayerTiersMode } from "@/lib/domain/tournament-status";
import { isSyncStale } from "@/lib/sync/sync-staleness";

const VENMO_HANDLE = "Sam-McNamee";
const VENMO_AT = "@Sam-McNamee";
const ENTRY_FEE_USD = 50;
const VENMO_APP_URL = `venmo://paycharge?txn=pay&recipients=${VENMO_HANDLE}`;
const VENMO_WEB_URL = `https://venmo.com/${VENMO_HANDLE}`;

const TIER_GOLFER_SELECT =
  "id,tier,odds_text,golfers:golfer_id(id,name,espn_athlete_id,total_score,is_cut,status)" as const;

type Golfer = {
  id: string;
  name: string;
  espn_athlete_id: string;
  total_score: number | null;
  is_cut: boolean | null;
  status: string | null;
};

type TierRow = {
  id: string;
  tier: number;
  odds_text: string | null;
  golfers: Golfer | Golfer[] | null;
};

type ExistingPick = { tier: number; golfer_tier_id: string };
type TierPerf = { tier: number; best: string[]; worst: string[] };

function golferFromRow(row: TierRow): Golfer | null {
  const golfer0 = row.golfers;
  return Array.isArray(golfer0) ? golfer0[0] ?? null : golfer0;
}

function sortTierRows(rows: TierRow[]): TierRow[] {
  return [...rows].sort((a, b) => {
    const scoreA = golferFromRow(a)?.total_score;
    const scoreB = golferFromRow(b)?.total_score;
    const aNum = typeof scoreA === "number";
    const bNum = typeof scoreB === "number";
    if (aNum && bNum) return scoreA - scoreB;
    if (aNum) return -1;
    if (bNum) return 1;
    const nameA = golferFromRow(a)?.name ?? "";
    const nameB = golferFromRow(b)?.name ?? "";
    return nameA.localeCompare(nameB);
  });
}

function tierScoreBounds(rows: TierRow[]): { best: number | null; worst: number | null } {
  const scores = rows
    .map((row) => golferFromRow(row)?.total_score)
    .filter((score): score is number => typeof score === "number");
  if (!scores.length) return { best: null, worst: null };
  return { best: Math.min(...scores), worst: Math.max(...scores) };
}

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
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [liveTiers, setLiveTiers] = useState<TierRow[]>(tiers);
  const [liveTournamentStatus, setLiveTournamentStatus] = useState(tournamentStatus);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const lastSyncAtRef = useRef<string | null>(null);
  const [loadingLive, setLoadingLive] = useState(false);
  const playerTiersMode = isPlayerTiersMode(liveTournamentStatus);

  useEffect(() => {
    setLiveTournamentStatus(tournamentStatus);
  }, [tournamentStatus]);

  useEffect(() => {
    const tournamentChannel = supabase
      .channel(`picks-status:${tournamentId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tournaments", filter: `id=eq.${tournamentId}` },
        (payload) => {
          const nextStatus = (payload.new as { status?: string } | null)?.status;
          if (nextStatus) setLiveTournamentStatus(nextStatus);
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(tournamentChannel);
    };
  }, [supabase, tournamentId]);

  const activeTiers = playerTiersMode ? liveTiers : tiers;
  const tiersByNumber = useMemo(() => {
    const map = new Map<number, TierRow[]>();
    for (const row of activeTiers) {
      const arr = map.get(row.tier) ?? [];
      arr.push(row);
      map.set(row.tier, arr);
    }
    return map;
  }, [activeTiers]);

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
      router.push("/");
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
      const golfer = row ? golferFromRow(row) : null;
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

  const loadLiveData = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!playerTiersMode) return;

      if (!options?.silent) {
        setLoadingLive(true);
      }

      const { data: healthRow } = await supabase
        .from("sync_health")
        .select("last_success_at")
        .eq("tournament_id", tournamentId)
        .maybeSingle();
      const syncAt = healthRow?.last_success_at ?? null;
      lastSyncAtRef.current = syncAt;
      setLastSyncAt(syncAt);

      const { data: tRow } = await supabase
        .from("tournaments")
        .select("status")
        .eq("id", tournamentId)
        .maybeSingle();
      if (tRow?.status) {
        setLiveTournamentStatus(tRow.status);
      }

      const { data: tierRows } = await supabase
        .from("golfer_tiers")
        .select(TIER_GOLFER_SELECT)
        .eq("tournament_id", tournamentId)
        .order("tier", { ascending: true });
      setLiveTiers((tierRows as TierRow[] | null) ?? []);

      const { data: picks } = await supabase
        .from("picks")
        .select("user_id,golfer_tiers:golfer_tier_id(tier,golfers:golfer_id(name,total_score))")
        .eq("tournament_id", tournamentId);

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
          best: arr
            .filter((x) => x.score === bestScore)
            .map((x) => `${x.name} (${formatScore(x.score)})`),
          worst: arr
            .filter((x) => x.score === worstScore)
            .map((x) => `${x.name} (${formatScore(x.score)})`)
        });
      }
      setTierPerf(perf);

      if (!options?.silent) {
        setLoadingLive(false);
      }
    },
    [playerTiersMode, supabase, tournamentId]
  );

  useEffect(() => {
    if (!playerTiersMode) {
      setTierPerf([]);
      return;
    }

    void loadLiveData();

    const golfersChannel = supabase
      .channel(`picks-golfers:${tournamentId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "golfers", filter: `tournament_id=eq.${tournamentId}` },
        () => void loadLiveData({ silent: true })
      )
      .subscribe();

    const tournamentChannel = supabase
      .channel(`picks-tournament:${tournamentId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tournaments", filter: `id=eq.${tournamentId}` },
        () => void loadLiveData({ silent: true })
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(golfersChannel);
      void supabase.removeChannel(tournamentChannel);
    };
  }, [loadLiveData, playerTiersMode, supabase, tournamentId]);

  useEffect(() => {
    if (!playerTiersMode || liveTournamentStatus !== "Live") return;

    const intervalId = window.setInterval(() => {
      void (async () => {
        const last = lastSyncAtRef.current;
        if (last && !isSyncStale(last, 5)) {
          await loadLiveData({ silent: true });
          return;
        }
        try {
          await fetch(`/api/t/${tournamentId}/refresh-scores`, { method: "POST" });
        } catch {
          // Best-effort refresh; polling still reloads current DB state.
        }
        await loadLiveData({ silent: true });
      })();
    }, 60_000);

    return () => window.clearInterval(intervalId);
  }, [liveTournamentStatus, loadLiveData, playerTiersMode, tournamentId]);

  const staleSyncMessage = useMemo(() => {
    if (!playerTiersMode || liveTournamentStatus !== "Live" || !lastSyncAt) return null;
    const last = new Date(lastSyncAt).getTime();
    const ageMin = Math.round((Date.now() - last) / 60000);
    if (Number.isFinite(ageMin) && ageMin > 5) {
      return `Live scores may be stale (last sync ~${ageMin}m ago).`;
    }
    return null;
  }, [lastSyncAt, liveTournamentStatus, playerTiersMode]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{playerTiersMode ? "Player tiers" : "Make picks"}</h1>
          <p className="text-sm text-slate-600">
            {tournamentName} · Status: {playerTiersMode ? liveTournamentStatus : tournamentStatus}.{" "}
            {playerTiersMode
              ? "Live golfer totals by tier. Compare pool picks to see the best and worst values."
              : "Pick 1 golfer per tier. Submission is blocked after the pool locks."}
          </p>
          {staleSyncMessage ? <p className="text-xs text-amber-700">{staleSyncMessage}</p> : null}
        </div>
        {playerTiersMode ? (
          <Button variant="secondary" onClick={() => void loadLiveData()} disabled={loadingLive}>
            Refresh
          </Button>
        ) : null}
      </div>

      {playerTiersMode ? (
        <Card>
          <CardHeader>
            <CardTitle>Your current overall score</CardTitle>
            <CardDescription>Best 4 golfer totals are counted (same scoring as leaderboard).</CardDescription>
          </CardHeader>
          <CardContent>
            <div
              className={cn(
                "inline-flex items-center rounded-md border border-slate-300 bg-slate-50 px-4 py-2 text-2xl font-semibold tabular-nums",
                golferTotalScoreClass(myOverallScore, null)
              )}
            >
              {formatScore(myOverallScore)}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {!playerTiersMode ? (
        <>
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
              <CardDescription>
                Predict the winner&apos;s score relative to par (e.g. -12). Used only to break ties.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Label htmlFor="rel-par">Winning score vs par</Label>
              <Input
                id="rel-par"
                type="text"
                inputMode="text"
                pattern="-?[0-9]*"
                placeholder="-12"
                value={predictedRelParInput}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === "" || raw === "-") {
                    setPredictedRelParInput(raw);
                    return;
                  }
                  const sign = raw.trim().startsWith("-") ? "-" : "";
                  const digits = raw.replace(/[^0-9]/g, "");
                  setPredictedRelParInput(`${sign}${digits}`);
                }}
              />
            </CardContent>
          </Card>
        </>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 7 }, (_, i) => i + 1).map((tierNum) => {
          const rows = playerTiersMode ? sortTierRows(tiersByNumber.get(tierNum) ?? []) : tiersByNumber.get(tierNum) ?? [];
          const bounds = playerTiersMode ? tierScoreBounds(rows) : { best: null, worst: null };

          return (
            <Card key={tierNum}>
              <CardHeader>
                <CardTitle>Tier {tierNum}</CardTitle>
                <CardDescription>
                  {playerTiersMode ? "Live totals for every golfer in this tier." : "Select 1 golfer."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {rows.length ? (
                  playerTiersMode ? (
                    <div className="space-y-2">
                      {rows.map((row) => {
                        const golfer = golferFromRow(row);
                        const isMyPick = selection[tierNum] === row.id;
                        const score = golfer?.total_score ?? null;
                        const isCut = golfer?.is_cut ?? null;
                        const isBestValue = bounds.best !== null && score === bounds.best;
                        const isWorstValue = bounds.worst !== null && score === bounds.worst && bounds.worst !== bounds.best;

                        return (
                          <div
                            key={row.id}
                            className={cn(
                              "flex items-start justify-between gap-3 rounded-md border border-slate-200 p-3",
                              isMyPick && "border-slate-900 bg-slate-50"
                            )}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <div className="truncate font-medium">{golfer?.name ?? "Unknown golfer"}</div>
                                {isMyPick ? <Badge variant="secondary">Your pick</Badge> : null}
                                {isBestValue ? <Badge variant="secondary">Best value</Badge> : null}
                                {isWorstValue ? <Badge variant="destructive">Worst value</Badge> : null}
                              </div>
                            </div>
                            <div className="shrink-0 text-right">
                              <div
                                className={cn(
                                  "text-sm font-semibold tabular-nums",
                                  golferTotalScoreClass(score, isCut)
                                )}
                              >
                                {formatGolferTotalScore(score, isCut)}
                              </div>
                              {isCut === false ? <div className="text-xs text-red-700">CUT</div> : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <RadioGroup
                      value={selection[tierNum] ?? ""}
                      onValueChange={(v) => setSelection((s) => ({ ...s, [tierNum]: v }))}
                      className="gap-3"
                    >
                      {rows.map((row) => {
                        const golfer = golferFromRow(row);
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
                            </div>
                          </label>
                        );
                      })}
                    </RadioGroup>
                  )
                ) : (
                  <div className="text-sm text-slate-600">No golfers found for this tier yet.</div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {!playerTiersMode ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={openVenmoStep} disabled={!allChosen || submitting}>
            {submitting ? "Submitting..." : "Submit picks"}
          </Button>
          {!allChosen ? <div className="text-sm text-slate-600">You must select 7 golfers.</div> : null}
          {message ? <div className="text-sm text-slate-700">{message}</div> : null}
        </div>
      ) : null}

      {playerTiersMode ? (
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
                      Your pick:{" "}
                      {mine
                        ? `${mine.name} (${formatGolferTotalScore(mine.total_score, mine.is_cut)})`
                        : "—"}
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
              Before your picks are saved, send your ${ENTRY_FEE_USD} pool entry to {VENMO_AT}.
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
