import "server-only";

import { createClient } from "redis";
import { isLiveIndexerEvent } from "@/lib/indexer/live-event";
import { invalidateSnapshotsForLiveEvent } from "@/lib/server/live-snapshot-invalidation";

const EVENT_CHANNEL = "arcorigin:mainnet:events";
const STATUS_CHANNEL = "arcorigin:mainnet:indexer-status";
const RECENT_EVENTS_KEY = "arcorigin:mainnet:indexer:recent-events";
const STATUS_KEY = "arcorigin:mainnet:indexer:status";
const REPLAY_LIMIT = 200;

type Listener = (payload: string) => void;
type RedisClientHandle = Pick<ReturnType<typeof createClient>, "isOpen" | "disconnect">;
type LiveEventHubState = {
  client: RedisClientHandle | null;
  subscriber: RedisClientHandle | null;
  connecting: Promise<void> | null;
  listeners: Set<Listener>;
  recent: string[];
  status: string | null;
};

declare global {
  var __arcOriginLiveEventHub: LiveEventHubState | undefined;
}

const state = globalThis.__arcOriginLiveEventHub ?? {
  client: null,
  subscriber: null,
  connecting: null,
  listeners: new Set<Listener>(),
  recent: [],
  status: null,
};
state.subscriber ??= null;
globalThis.__arcOriginLiveEventHub = state;

async function connectHub() {
  if (state.client?.isOpen && state.subscriber?.isOpen) return;
  if (!state.connecting) {
    state.connecting = (async () => {
      const redisUrl = process.env.REDIS_URL?.trim();
      if (!redisUrl) throw new Error("REDIS_URL is not configured.");
      const client = createClient({
        url: redisUrl,
        socket: {
          connectTimeout: 3_000,
          reconnectStrategy: (retries) => Math.min(5_000, 250 * 2 ** Math.min(retries, 5)),
        },
      });
      client.on("error", () => undefined);
      const subscriber = client.duplicate();
      subscriber.on("error", () => undefined);
      await client.connect();
      await subscriber.connect();
      state.client = client;
      state.subscriber = subscriber;
      await subscriber.subscribe(EVENT_CHANNEL, (payload) => {
        try {
          const event: unknown = JSON.parse(payload);
          if (isLiveIndexerEvent(event)) invalidateSnapshotsForLiveEvent(event);
        } catch {
          // Invalid pub/sub data is ignored by both cache invalidation and clients.
        }
        state.recent = [payload, ...state.recent.filter((item) => item !== payload)].slice(0, REPLAY_LIMIT);
        for (const listener of state.listeners) listener(payload);
      });
      await subscriber.subscribe(STATUS_CHANNEL, (payload) => {
        state.status = payload;
      });
      // Subscribe before the initial read so an event published during startup
      // is observed either by pub/sub, the recent-event list, or both.
      const [recent, status] = await Promise.all([
        client.lRange(RECENT_EVENTS_KEY, 0, REPLAY_LIMIT - 1),
        client.get(STATUS_KEY),
      ]);
      state.recent = [...new Set([...recent, ...state.recent])].slice(0, REPLAY_LIMIT);
      state.status = status ?? state.status;
    })().catch((error) => {
      state.client?.disconnect();
      state.subscriber?.disconnect();
      state.client = null;
      state.subscriber = null;
      throw error;
    }).finally(() => {
      state.connecting = null;
    });
  }
  return state.connecting;
}

export async function subscribeLiveEvents(listener: Listener) {
  state.listeners.add(listener);
  try {
    await connectHub();
  } catch (error) {
    state.listeners.delete(listener);
    throw error;
  }
  return {
    recent: state.recent.slice(),
    status: state.status,
    unsubscribe: () => state.listeners.delete(listener),
  };
}

export async function publishVerifiedLiveEvent(event: import("@/lib/indexer/live-event").LiveIndexerEvent) {
  if (!isLiveIndexerEvent(event)) throw new Error("Invalid live event.");
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) throw new Error("REDIS_URL is not configured.");
  const publisher = createClient({ url: redisUrl, socket: { connectTimeout: 3_000 } });
  publisher.on("error", () => undefined);
  const encoded = JSON.stringify(event);
  const dedupeKey = `arcorigin:mainnet:announced:${event.id}`;
  try {
    await publisher.connect();
    const claimed = await publisher.set(dedupeKey, "1", { NX: true, EX: 86_400 });
    if (claimed !== "OK") return false;
    await publisher.multi()
      .lPush(RECENT_EVENTS_KEY, encoded)
      .lTrim(RECENT_EVENTS_KEY, 0, REPLAY_LIMIT - 1)
      .publish(EVENT_CHANNEL, encoded)
      .exec();
    return true;
  } finally {
    if (publisher.isOpen) await publisher.quit().catch(() => publisher.disconnect());
  }
}
