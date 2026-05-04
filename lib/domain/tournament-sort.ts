/** Best-effort instant for “which tournament is this week?” — avoids NULL starts_at sinking behind older events. */
export function tournamentScheduleMs(t: {
  starts_at: string | null;
  first_tee_at: string | null;
  lock_at: string;
  open_at: string;
  created_at: string;
}): number {
  const iso = t.starts_at ?? t.first_tee_at ?? t.lock_at ?? t.open_at ?? t.created_at;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

export function sortTournamentsByScheduleDesc<
  T extends {
    starts_at: string | null;
    first_tee_at: string | null;
    lock_at: string;
    open_at: string;
    created_at: string;
  }
>(rows: T[]): T[] {
  return [...rows].sort((a, b) => tournamentScheduleMs(b) - tournamentScheduleMs(a));
}
