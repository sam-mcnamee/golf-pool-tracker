export type ParsedScore = {
  totalScore: number | null;
  statusText: string | null;
  isCut: boolean | null;
};

export type GolferUpdate = {
  espnAthleteId: string;
  name: string;
  r1Score: number | null;
  r2Score: number | null;
  r3Score: number | null;
  r4Score: number | null;
  totalScore: number | null;
  todayScore: number | null;
  currentRound: number | null;
  thru: string | null;
  status: string | null;
  isCut: boolean | null;
  r1TeeAt: string | null;
  r2TeeAt: string | null;
  r3TeeAt: string | null;
  r4TeeAt: string | null;
};

type JsonRecord = Record<string, unknown>;

const DETAIL_SCORE_RE = /^\s*(E|[+-]?\d+)\s*(?:\(|$)/i;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFindFirstList(obj: unknown, key: string): unknown[] | null {
  if (isRecord(obj)) {
    const direct = obj[key];
    if (Array.isArray(direct) && direct.every((item) => isRecord(item))) {
      return direct;
    }
    for (const value of Object.values(obj)) {
      const found = deepFindFirstList(value, key);
      if (found) return found;
    }
    return null;
  }
  if (Array.isArray(obj)) {
    for (const value of obj) {
      const found = deepFindFirstList(value, key);
      if (found) return found;
    }
  }
  return null;
}

function deepFindFirstDict(obj: unknown, key: string): JsonRecord | null {
  if (isRecord(obj)) {
    const direct = obj[key];
    if (isRecord(direct)) return direct;
    for (const value of Object.values(obj)) {
      const found = deepFindFirstDict(value, key);
      if (found) return found;
    }
    return null;
  }
  if (Array.isArray(obj)) {
    for (const value of obj) {
      const found = deepFindFirstDict(value, key);
      if (found) return found;
    }
  }
  return null;
}

export function parseTotalScore(scoreStr: string | null | undefined): ParsedScore {
  if (scoreStr == null) {
    return { totalScore: null, statusText: null, isCut: null };
  }

  const s = scoreStr.trim().toUpperCase();
  if (!s || s === "--") {
    return { totalScore: null, statusText: null, isCut: null };
  }
  if (s === "-") {
    return { totalScore: null, statusText: null, isCut: null };
  }
  if (s === "MC") {
    return { totalScore: null, statusText: "CUT", isCut: false };
  }
  if (s === "E") {
    return { totalScore: 0, statusText: null, isCut: null };
  }
  if (s === "CUT" || s === "WD" || s === "DQ") {
    return { totalScore: null, statusText: s, isCut: false };
  }

  const normalized = s.replace("+", "");
  const parsed = Number.parseInt(normalized, 10);
  if (Number.isFinite(parsed)) {
    return { totalScore: parsed, statusText: null, isCut: null };
  }
  return { totalScore: null, statusText: s, isCut: null };
}

function extractCompetitorScoreDisplay(row: JsonRecord): string | null {
  for (const key of ["score", "displayScore", "totalScore"]) {
    const obj = row[key];
    if (isRecord(obj)) {
      const displayValue = obj.displayValue;
      if (typeof displayValue === "string" && displayValue.trim()) {
        return displayValue;
      }
    } else if (typeof obj === "string" && obj.trim()) {
      return obj;
    }
  }
  return null;
}

export function totalScoreFromStatusDetail(statusObj: unknown): number | null {
  if (!isRecord(statusObj)) return null;
  for (const key of ["detail", "todayDetail"]) {
    const value = statusObj[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const match = DETAIL_SCORE_RE.exec(value.trim());
    if (!match) continue;
    const parsed = parseTotalScore(match[1].toUpperCase());
    if (parsed.totalScore !== null) return parsed.totalScore;
  }
  return null;
}

function todayScoreFromLinescores(linescores: unknown): number | null {
  if (!Array.isArray(linescores)) return null;
  let bestPeriod = 0;
  let out: number | null = null;
  for (const entry of linescores) {
    if (!isRecord(entry)) continue;
    const period = entry.period;
    if (typeof period !== "number" || period < 1 || period > 4) continue;
    const display = entry.displayValue;
    if (typeof display !== "string" || !display.trim()) continue;
    const parsed = parseTotalScore(display);
    if (parsed.totalScore === null) continue;
    if (period >= bestPeriod) {
      bestPeriod = period;
      out = parsed.totalScore;
    }
  }
  return out;
}

function parseIntRound(value: unknown): number | null {
  if (typeof value === "number" && value >= 1 && value <= 4) return value;
  if (typeof value === "string" && value.trim().match(/^\d+$/)) {
    const parsed = Number.parseInt(value, 10);
    return parsed >= 1 && parsed <= 4 ? parsed : null;
  }
  return null;
}

function thruState(thru: string | null | undefined): "not_started" | "in_progress" | "finished" | "unknown" {
  if (!thru) return "unknown";
  const t = thru.trim().toUpperCase();
  if (!t) return "unknown";
  if (t === "F" || t === "FIN" || t === "FINAL" || t.startsWith("F")) return "finished";
  if (/^\d+$/.test(t)) {
    const n = Number.parseInt(t, 10);
    if (n >= 1 && n <= 18) return "in_progress";
  }
  if (t.includes(":") && (t.includes("AM") || t.includes("PM"))) return "not_started";
  return "unknown";
}

function tryParseIsoDatetime(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed.replace("Z", "+00:00"));
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

export function extractCompetitors(payload: unknown): JsonRecord[] {
  const competitors = deepFindFirstList(payload, "competitors");
  if (competitors) return competitors as JsonRecord[];
  const entries = deepFindFirstList(payload, "entries");
  if (entries) return entries as JsonRecord[];
  return [];
}

export function competitorToUpdate(row: JsonRecord): GolferUpdate | null {
  const athlete = (isRecord(row.athlete) ? row.athlete : deepFindFirstDict(row, "athlete")) ?? null;
  if (!athlete) return null;

  const athleteId = athlete.id;
  const name = athlete.displayName ?? athlete.name;
  if (athleteId == null || name == null) return null;

  const scoreDisplay = extractCompetitorScoreDisplay(row);
  let { totalScore, statusText, isCut } = parseTotalScore(scoreDisplay);

  const statusObj = row.status;
  if (isRecord(statusObj)) {
    const typeObj = statusObj.type;
    if (isRecord(typeObj)) {
      const candidate = typeObj.name ?? typeObj.description ?? statusObj.detail;
      if (typeof candidate === "string") statusText = candidate;
    } else {
      const candidate = statusObj.detail ?? statusObj.description;
      if (typeof candidate === "string") statusText = candidate;
    }
  }

  const totalFromDetail = totalScoreFromStatusDetail(statusObj);
  if (totalFromDetail !== null) totalScore = totalFromDetail;

  const scoreParsed = parseTotalScore(scoreDisplay);
  if (scoreParsed.statusText) statusText = scoreParsed.statusText;
  if (scoreParsed.isCut !== null) isCut = scoreParsed.isCut;

  const roundScores = new Map<number, number>();
  const roundTeeAt = new Map<number, string>();
  const linescores = row.linescores;
  if (Array.isArray(linescores)) {
    for (const entry of linescores) {
      if (!isRecord(entry)) continue;
      const period = entry.period;
      if (typeof period !== "number" || period < 1 || period > 4) continue;

      const teeTime = entry.teeTime;
      if (typeof teeTime === "string") {
        const teeDate = tryParseIsoDatetime(teeTime);
        if (teeDate) roundTeeAt.set(period, teeDate.toISOString());
      }

      const display = entry.displayValue;
      if (typeof display === "string" && display.trim()) {
        const parsed = parseTotalScore(display);
        if (parsed.totalScore !== null) roundScores.set(period, parsed.totalScore);
      }
    }
  }

  if (isCut === null && Array.isArray(linescores) && linescores.length >= 3) {
    isCut = true;
  }
  if (isCut === null && statusText) {
    const st = statusText.trim().toUpperCase();
    if (st === "CUT" || st === "WD" || st === "DQ") isCut = false;
  }

  const todayScore = todayScoreFromLinescores(linescores);

  let thru: string | null = null;
  if (isRecord(statusObj)) {
    const thruRaw = statusObj.displayThru ?? statusObj.thru;
    if (typeof thruRaw === "number") thru = String(Math.trunc(thruRaw));
    else if (typeof thruRaw === "string") thru = thruRaw.trim() || null;
  }

  let currentRound: number | null = null;
  for (const key of ["currentRound", "current_round", "round"]) {
    if (key in row) {
      const parsed = parseIntRound(row[key]);
      if (parsed !== null) {
        currentRound = parsed;
        break;
      }
    }
  }
  if (currentRound === null && isRecord(statusObj)) {
    currentRound = parseIntRound(statusObj.period);
  }

  if (currentRound === null) {
    const state = thruState(thru);
    if (state === "in_progress") {
      let bestPeriod = 0;
      if (Array.isArray(linescores)) {
        for (const entry of linescores) {
          if (!isRecord(entry)) continue;
          const period = entry.period;
          if (typeof period !== "number" || period < 1 || period > 4) continue;
          const display = entry.displayValue;
          if (typeof display !== "string" || !display.trim()) continue;
          if (parseTotalScore(display).totalScore === null) continue;
          bestPeriod = Math.max(bestPeriod, period);
        }
      }
      currentRound = bestPeriod || 1;
    }
  }

  return {
    espnAthleteId: String(athleteId),
    name: String(name),
    r1Score: roundScores.get(1) ?? null,
    r2Score: roundScores.get(2) ?? null,
    r3Score: roundScores.get(3) ?? null,
    r4Score: roundScores.get(4) ?? null,
    totalScore,
    todayScore,
    currentRound,
    thru,
    status: statusText,
    isCut,
    r1TeeAt: roundTeeAt.get(1) ?? null,
    r2TeeAt: roundTeeAt.get(2) ?? null,
    r3TeeAt: roundTeeAt.get(3) ?? null,
    r4TeeAt: roundTeeAt.get(4) ?? null
  };
}

export function isActivelyScoring(update: GolferUpdate): boolean {
  const status = (update.status ?? "").trim().toUpperCase();
  if (status.includes("IN_PROGRESS") || ["IN", "INPROGRESS", "LIVE"].includes(status)) return true;
  if (update.totalScore !== null || update.todayScore !== null) return true;
  const thru = (update.thru ?? "").trim();
  return Boolean(thru && thru !== "0" && thru !== "-" && thru !== "--");
}

export function detectEventStatus(payload: unknown): { tournamentStatus: string | null; isFinal: boolean } {
  const status = deepFindFirstDict(payload, "status");
  if (!status) return { tournamentStatus: null, isFinal: false };

  const typeObj = status.type;
  if (isRecord(typeObj)) {
    const name = String(typeObj.name ?? typeObj.description ?? "").toUpperCase();
    const state = String(typeObj.state ?? "").toUpperCase();
    if (name.includes("FINAL") || state === "POST") return { tournamentStatus: "Complete", isFinal: true };
    if (["IN", "INPROGRESS", "LIVE"].includes(state)) return { tournamentStatus: "Live", isFinal: false };
  }

  const detail = String(status.detail ?? status.description ?? "").toUpperCase();
  if (detail.includes("FINAL")) return { tournamentStatus: "Complete", isFinal: true };
  return { tournamentStatus: null, isFinal: false };
}

export function normalizeName(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/ø/gi, "o")
    .replace(/æ/gi, "ae")
    .replace(/å/gi, "a")
    .replace(/ö/gi, "o")
    .replace(/ü/gi, "u");
  return ascii.toLowerCase().replace(/[^a-z]+/g, " ").trim();
}

export async function fetchEspnLeaderboard(eventId: string): Promise<unknown> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?event=${encodeURIComponent(eventId)}`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`ESPN ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw new Error(`Failed to fetch ESPN JSON after 3 tries: ${String(lastError)}`);
}
