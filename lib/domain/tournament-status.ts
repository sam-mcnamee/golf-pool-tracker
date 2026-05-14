const PLAYER_TIERS_STATUSES = new Set(["Locked", "Live", "Complete"]);

export function isPlayerTiersMode(status: string): boolean {
  return PLAYER_TIERS_STATUSES.has(status);
}

export function isPicksOpen(status: string): boolean {
  return status === "Open";
}
