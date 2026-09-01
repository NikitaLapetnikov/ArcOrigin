import "server-only";

import {
  isProtocolAnalyticsSnapshot,
  type AnalyticsRange,
  type ProtocolAnalyticsSnapshot,
} from "@/lib/analytics";
import { ARCORIGIN_NETWORK, ARC_ACTIVE_FACTORY } from "@/lib/chains";
import { getStoredProtocolAnalytics } from "@/lib/server/event-store";
import { readPersistentSnapshot, writePersistentSnapshot } from "@/lib/server/persistent-cache";

const CACHE_TTL_MS = 8_000;
const NORMAL_REFRESH_INTERVAL_MS = 4_000;
const FORCE_REFRESH_INTERVAL_MS = 1_200;
const REQUEST_WAIT_TIMEOUT_MS = 3_000;
const PERSISTENT_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

type CacheEntry = {
  snapshot: ProtocolAnalyticsSnapshot | null;
  cachedAt: number;
  lastAttemptAt: number;
  pending: Promise<ProtocolAnalyticsSnapshot> | null;
  hydrated: boolean;
};

type ProtocolAnalyticsState = Map<AnalyticsRange, CacheEntry>;

declare global {
  var __arcOriginProtocolAnalyticsState: ProtocolAnalyticsState | undefined;
}

const state = globalThis.__arcOriginProtocolAnalyticsState ?? new Map<AnalyticsRange, CacheEntry>();
globalThis.__arcOriginProtocolAnalyticsState = state;

function entryFor(range: AnalyticsRange) {
  const existing = state.get(range);
  if (existing) return existing;
  const entry: CacheEntry = {
    snapshot: null,
    cachedAt: 0,
    lastAttemptAt: 0,
    pending: null,
    hydrated: false,
  };
  state.set(range, entry);
  return entry;
}

function persistentKey(range: AnalyticsRange) {
  return `arcorigin:${ARCORIGIN_NETWORK}:protocol-analytics:v1:${ARC_ACTIVE_FACTORY.toLowerCase()}:${range}`;
}

async function hydrate(entry: CacheEntry, range: AnalyticsRange) {
  if (entry.hydrated) return;
  entry.hydrated = true;
  const persisted = await readPersistentSnapshot<unknown>(persistentKey(range));
  if (!isProtocolAnalyticsSnapshot(persisted) || persisted.range !== range) return;
  entry.snapshot = persisted;
  entry.cachedAt = Date.parse(persisted.generatedAt) || 0;
}

async function waitForSnapshot(pending: Promise<ProtocolAnalyticsSnapshot>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Protocol analytics refresh timed out.")), REQUEST_WAIT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function beginRefresh(entry: CacheEntry, range: AnalyticsRange) {
  if (entry.pending) return entry.pending;
  entry.lastAttemptAt = Date.now();
  entry.pending = getStoredProtocolAnalytics(range).then((snapshot) => {
    if (!snapshot || !isProtocolAnalyticsSnapshot(snapshot)) {
      throw new Error("The protocol event store has not published an analytics snapshot.");
    }
    entry.snapshot = snapshot;
    entry.cachedAt = Date.now();
    void writePersistentSnapshot(persistentKey(range), snapshot, PERSISTENT_CACHE_TTL_SECONDS);
    return snapshot;
  }).finally(() => {
    entry.pending = null;
  });
  return entry.pending;
}

export type ProtocolAnalyticsSnapshotResult = {
  snapshot: ProtocolAnalyticsSnapshot;
  stale: boolean;
};

/**
 * Serves a hot in-process snapshot, persists the last canonical result in
 * Redis, coalesces concurrent refreshes, and falls back to the stale snapshot
 * when Postgres is briefly unavailable. Forced refreshes are still throttled
 * so a burst of SSE events cannot create a database stampede.
 */
export async function getProtocolAnalyticsSnapshot(
  range: AnalyticsRange,
  forceRefresh = false,
): Promise<ProtocolAnalyticsSnapshotResult | null> {
  const entry = entryFor(range);
  await hydrate(entry, range);
  const now = Date.now();
  const isFresh = Boolean(entry.snapshot && now - entry.cachedAt < CACHE_TTL_MS);
  const minimumInterval = forceRefresh ? FORCE_REFRESH_INTERVAL_MS : NORMAL_REFRESH_INTERVAL_MS;
  const refreshThrottled = Boolean(entry.snapshot && now - entry.lastAttemptAt < minimumInterval);
  if (isFresh && !forceRefresh) return { snapshot: entry.snapshot!, stale: false };
  if (refreshThrottled) return { snapshot: entry.snapshot!, stale: !isFresh };

  const pending = beginRefresh(entry, range);
  if (entry.snapshot && !forceRefresh) {
    void pending.catch(() => undefined);
    return { snapshot: entry.snapshot, stale: true };
  }
  try {
    return { snapshot: await waitForSnapshot(pending), stale: false };
  } catch {
    return entry.snapshot ? { snapshot: entry.snapshot, stale: true } : null;
  }
}

export function invalidateProtocolAnalyticsSnapshots() {
  for (const entry of state.values()) {
    entry.cachedAt = 0;
    entry.lastAttemptAt = 0;
  }
}
