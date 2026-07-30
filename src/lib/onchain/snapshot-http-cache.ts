export function snapshotCacheControl({
  forceRefresh,
  stale,
  freshPolicy,
}: {
  forceRefresh: boolean;
  stale: boolean;
  freshPolicy: string;
}) {
  return forceRefresh || stale ? "no-store" : freshPolicy;
}
