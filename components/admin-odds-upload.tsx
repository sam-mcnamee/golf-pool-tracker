"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { parseOddsToAmerican } from "@/lib/domain/odds-normalize";

export type ParsedOddsRow = { golfer_name: string; odds_american: number; espn_athlete_id?: string };

function parseOddsTokenToAmerican(s: string): number | null {
  const parsed = parseOddsToAmerican(s);
  if (!parsed) return null;
  // Store as positive integer for underdogs in our DB; favorites (negative) are allowed too.
  return parsed.american;
}

function looksLikeEspnAthleteId(s: string): boolean {
  return /^\d{4,12}$/.test(s.trim());
}

/** Parse textarea: one golfer per line. Tab-separated, or "Name, +1200" / "Name  +1200". Lines starting with # ignored. */
export function parseOddsPaste(text: string): { rows: ParsedOddsRow[]; errors: string[] } {
  const errors: string[] = [];
  const rows: ParsedOddsRow[] = [];
  const lines = text.split(/\r?\n/);
  let lineNo = 0;
  for (const line of lines) {
    lineNo++;
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;

    let name: string;
    let oddsStr: string;
    let espnAthleteId: string | undefined;

    if (t.includes("\t")) {
      const parts = t.split("\t").map((p) => p.trim()).filter((p) => p.length > 0);
      if (parts.length < 2) {
        errors.push(`Line ${lineNo}: need name and odds (tab-separated).`);
        continue;
      }

      const last = parts[parts.length - 1]!;
      const first = parts[0]!;

      if (parts.length >= 3 && looksLikeEspnAthleteId(last)) {
        const oddsCandidate = parts[parts.length - 2]!;
        const parsedOdds = parseOddsTokenToAmerican(oddsCandidate);
        if (parsedOdds === null) {
          errors.push(`Line ${lineNo}: expected odds before ESPN id column (e.g. +600 or 6/1).`);
          continue;
        }
        oddsStr = oddsCandidate;
        name = parts.slice(0, -2).join("\t").trim();
        espnAthleteId = last.trim();
      } else if (parts.length >= 3 && looksLikeEspnAthleteId(first)) {
        const parsedOdds = parseOddsTokenToAmerican(last);
        if (parsedOdds === null) {
          errors.push(`Line ${lineNo}: last column must be odds when leading ESPN id is used (e.g. +600 or 6/1).`);
          continue;
        }
        oddsStr = last;
        name = parts.slice(1, -1).join("\t").trim();
        espnAthleteId = first.trim();
      } else {
        oddsStr = last;
        name = parts.slice(0, -1).join("\t").trim();
      }
    } else {
      const comma = t.lastIndexOf(",");
      if (comma > 0) {
        name = t.slice(0, comma).trim();
        oddsStr = t.slice(comma + 1).trim();
      } else {
        const m = t.match(/^(.+?)\s+([^\s]+)\s*$/);
        if (!m) {
          errors.push(`Line ${lineNo}: use "Name, +1200" or "Name<TAB>+1200" or "Name  +1200" or "Name  6/1".`);
          continue;
        }
        name = m[1]!.trim();
        oddsStr = m[2]!.trim();
      }
    }

    const odds = parseOddsTokenToAmerican(oddsStr);
    if (odds === null) {
      errors.push(`Line ${lineNo}: invalid odds "${oddsStr}".`);
      continue;
    }
    if (name.length < 1 || name.length > 200) {
      errors.push(`Line ${lineNo}: name length invalid.`);
      continue;
    }
    const row: ParsedOddsRow = { golfer_name: name, odds_american: odds };
    if (espnAthleteId) row.espn_athlete_id = espnAthleteId;
    rows.push(row);
  }
  return { rows, errors };
}

export function AdminOddsUpload({
  tournamentId,
  disabled,
  disabledReason
}: {
  tournamentId: string;
  disabled: boolean;
  /** Shown when disabled (frozen vs complete, etc.). */
  disabledReason?: string;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function upload() {
    setMessage(null);
    const { rows, errors } = parseOddsPaste(text);
    if (errors.length) {
      setMessage(errors.slice(0, 5).join(" ") + (errors.length > 5 ? ` …(+${errors.length - 5} more)` : ""));
      return;
    }
    if (!rows.length) {
      setMessage("Paste at least one line of odds.");
      return;
    }
    if (!window.confirm(`Replace all odds for this tournament with ${rows.length} row(s)? Existing scraped odds will be deleted.`)) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/admin/tiering/upload-odds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tournamentId, rows })
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? "Upload failed");
      setMessage(`Saved ${json.count} rows (${json.matchedToField ?? 0} matched to tournament field).`);
      setText("");
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  const preview = parseOddsPaste(text);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload odds (manual)</CardTitle>
        <CardDescription>
          If the automated odds sync fails, paste a list here. It <strong>replaces</strong> all rows in{" "}
          <code className="text-xs">tournament_odds_latest</code> for this tournament. Rows link to the{" "}
          <code className="text-xs">golfers</code> field list for this event (run the ESPN leaderboard sync first). Matching is by{" "}
          <strong>normalized name</strong>, or add an ESPN athlete id column:{" "}
          <code className="text-xs">Name[TAB]+450[TAB]46046</code> or <code className="text-xs">46046[TAB]Name[TAB]+450</code>. Also{" "}
          <code className="text-xs">Name, +450</code> works. Fractional odds like <code className="text-xs">6/1</code> are accepted too.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"Scottie Scheffler\t+450\t46046\nRory McIlroy, +800\nTiger Woods  +5000\n# comments start with #"}
          rows={10}
          disabled={disabled || busy}
          className="font-mono text-sm"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => void upload()} disabled={disabled || busy}>
            {busy ? "Uploading…" : "Replace odds from paste"}
          </Button>
          {preview.rows.length > 0 ? (
            <span className="text-sm text-slate-600">
              Parsed: {preview.rows.length} line(s)
              {preview.errors.length > 0 ? ` · ${preview.errors.length} issue(s)` : null}
            </span>
          ) : null}
        </div>
        {message ? <p className="text-sm text-slate-800">{message}</p> : null}
        {disabled && disabledReason ? <p className="text-sm text-amber-800">{disabledReason}</p> : null}
      </CardContent>
    </Card>
  );
}
