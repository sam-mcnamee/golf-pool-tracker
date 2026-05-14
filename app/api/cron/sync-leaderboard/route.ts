import { NextResponse } from "next/server";

import { triggerLeaderboardSync } from "@/lib/sync/leaderboard-sync-trigger";

export const runtime = "nodejs";
export const maxDuration = 120;

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const auth = request.headers.get("authorization")?.trim();
  return auth === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await triggerLeaderboardSync("vercel_cron");
  const status = result.ok ? 200 : 503;
  return NextResponse.json(result, { status });
}
