const STALE_REVALIDATION_DELAYS_MS = [1_500, 3_000, 6_000, 15_000, 30_000] as const;

export function snapshotRevalidationDelay(attempt: number) {
  const safeAttempt = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 0;
  return STALE_REVALIDATION_DELAYS_MS[
    Math.min(safeAttempt, STALE_REVALIDATION_DELAYS_MS.length - 1)
  ];
}
