export function isSyncStale(lastSuccessAt: string | null | undefined, maxAgeMinutes: number): boolean {
  if (!lastSuccessAt) return true;
  const lastMs = Date.parse(lastSuccessAt);
  if (!Number.isFinite(lastMs)) return true;
  return Date.now() - lastMs > maxAgeMinutes * 60_000;
}
