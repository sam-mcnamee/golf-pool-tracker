import { spawn } from "node:child_process";
import path from "node:path";

import { getClientEnv, getServerEnv } from "@/lib/supabase/env";

export type LeaderboardSyncTriggerResult = {
  ok: boolean;
  mode: "github_dispatch" | "python" | "skipped";
  detail?: string;
};

function logSyncEvent(event: string, data: Record<string, unknown>) {
  const payload = { event, ...data, timestamp: new Date().toISOString() };
  if (event.endsWith("_failed")) {
    console.error(JSON.stringify(payload));
    return;
  }
  console.log(JSON.stringify(payload));
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
  const responseBody = ok ? "" : (await response.text()).slice(0, 500);
  const detail = ok ? `dispatched (${reason})` : `github ${response.status}${responseBody ? `: ${responseBody}` : ""}`;
  logSyncEvent("leaderboard_sync_dispatch", { reason, repo, ok, status: response.status, detail });
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
      logSyncEvent("leaderboard_sync_python_failed", { reason, error: error.message });
      resolve({ ok: false, mode: "python", detail: error.message });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      const ok = code === 0;
      logSyncEvent(ok ? "leaderboard_sync_python_finished" : "leaderboard_sync_python_failed", {
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
  logSyncEvent("leaderboard_sync_trigger_requested", { reason });

  const github = await dispatchGithubWorkflow(reason);
  if (github.ok) return github;

  if (!process.env.VERCEL) {
    const python = await runPythonSync(reason);
    if (python.ok) return python;

    const detail = [github.detail, python.detail].filter(Boolean).join("; ");
    logSyncEvent("leaderboard_sync_trigger_failed", { reason, detail });
    return { ok: false, mode: "skipped", detail };
  }

  logSyncEvent("leaderboard_sync_trigger_failed", {
    reason,
    detail: github.detail ?? "github dispatch unavailable on Vercel"
  });
  return {
    ok: false,
    mode: "skipped",
    detail: github.detail ?? "github dispatch unavailable on Vercel"
  };
}
