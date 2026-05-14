import { spawn } from "node:child_process";
import path from "node:path";

import { getClientEnv, getServerEnv } from "@/lib/supabase/env";

const DEBUG_INGEST_URL = "http://127.0.0.1:7412/ingest/a35909aa-fcf4-433b-8c2a-136ae1033165";
const DEBUG_SESSION_ID = "0f5852";

export type LeaderboardSyncTriggerResult = {
  ok: boolean;
  mode: "github_dispatch" | "python" | "skipped";
  detail?: string;
};

function agentDebugLog(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>,
  runId = "pre-fix"
) {
  // #region agent log
  void fetch(DEBUG_INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": DEBUG_SESSION_ID
    },
    body: JSON.stringify({
      sessionId: DEBUG_SESSION_ID,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
      runId
    })
  }).catch(() => {});
  // #endregion
}

export function isSyncStale(lastSuccessAt: string | null | undefined, maxAgeMinutes: number): boolean {
  if (!lastSuccessAt) return true;
  const lastMs = Date.parse(lastSuccessAt);
  if (!Number.isFinite(lastMs)) return true;
  return Date.now() - lastMs > maxAgeMinutes * 60_000;
}

async function dispatchGithubWorkflow(reason: string): Promise<LeaderboardSyncTriggerResult> {
  const token = process.env.GITHUB_WORKFLOW_TOKEN?.trim();
  const repo = process.env.GITHUB_REPOSITORY?.trim() || "sam-mcnamee/golf-pool-tracker";
  if (!token) {
    return { ok: false, mode: "skipped", detail: "missing GITHUB_WORKFLOW_TOKEN" };
  }

  const response = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/sync-leaderboard.yml/dispatches`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: JSON.stringify({ ref: "main", inputs: {} })
  });

  const ok = response.ok;
  const detail = ok ? `dispatched (${reason})` : `github ${response.status}`;
  agentDebugLog("A", "leaderboard-sync-trigger.ts:dispatchGithubWorkflow", "github workflow dispatch", {
    reason,
    repo,
    ok,
    status: response.status
  });
  return { ok, mode: "github_dispatch", detail };
}

async function runPythonSync(reason: string): Promise<LeaderboardSyncTriggerResult> {
  const serverEnv = getServerEnv();
  const clientEnv = getClientEnv();
  if (!serverEnv.SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, mode: "skipped", detail: "missing SUPABASE_SERVICE_ROLE_KEY" };
  }

  const scriptPath = path.join(process.cwd(), "scraper", "espn_leaderboard_sync.py");
  const startedAt = Date.now();

  return await new Promise((resolve) => {
    const child = spawn("python3", [scriptPath, "--mode", "current"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SUPABASE_URL: clientEnv.NEXT_PUBLIC_SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: serverEnv.SUPABASE_SERVICE_ROLE_KEY
      }
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, 120_000);

    child.on("error", (error) => {
      clearTimeout(timeout);
      agentDebugLog("B", "leaderboard-sync-trigger.ts:runPythonSync", "python spawn failed", {
        reason,
        error: error.message
      });
      resolve({ ok: false, mode: "python", detail: error.message });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      const ok = code === 0;
      agentDebugLog("B", "leaderboard-sync-trigger.ts:runPythonSync", "python sync finished", {
        reason,
        ok,
        exitCode: code,
        durationMs: Date.now() - startedAt,
        stderrTail: stderr.slice(-500)
      });
      resolve({
        ok,
        mode: "python",
        detail: ok ? `exit 0 (${reason})` : `exit ${code ?? "unknown"}`
      });
    });
  });
}

export async function triggerLeaderboardSync(reason: string): Promise<LeaderboardSyncTriggerResult> {
  agentDebugLog("A", "leaderboard-sync-trigger.ts:triggerLeaderboardSync", "sync trigger requested", { reason });

  const github = await dispatchGithubWorkflow(reason);
  if (github.ok) return github;

  const python = await runPythonSync(reason);
  if (python.ok) return python;

  agentDebugLog("C", "leaderboard-sync-trigger.ts:triggerLeaderboardSync", "sync trigger unavailable", {
    reason,
    githubDetail: github.detail,
    pythonDetail: python.detail
  });
  return {
    ok: false,
    mode: "skipped",
    detail: [github.detail, python.detail].filter(Boolean).join("; ")
  };
}
