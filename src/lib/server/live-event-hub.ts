import "server-only";

import { createClient } from "redis";

const EVENT_CHANNEL = "arcorigin:mainnet:events";
const STATUS_CHANNEL = "arcorigin:mainnet:indexer-status";
const RECENT_EVENTS_KEY = "arcorigin:mainnet:indexer:recent-events";
const STATUS_KEY = "arcorigin:mainnet:indexer:status";
const REPLAY_LIMIT = 200;

type Listener = (payload: string) => void;
type RedisClientHandle = Pick<ReturnType<typeof createClient>, "isOpen" | "disconnect">;
type LiveEventHubState = {
  client: RedisClientHandle | null;
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
  connecting: null,
  listeners: new Set<Listener>(),
  recent: [],
  status: null,
};
globalThis.__arcOriginLiveEventHub = state;

async function connectHub() {
  if (state.client?.isOpen) return;
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
      await client.connect();
      state.client = client;
      const [recent, status] = await Promise.all([
        client.lRange(RECENT_EVENTS_KEY, 0, REPLAY_LIMIT - 1),
        client.get(STATUS_KEY),
      ]);
      state.recent = recent;
      state.status = status;
      await client.subscribe(EVENT_CHANNEL, (payload) => {
        state.recent = [payload, ...state.recent.filter((item) => item !== payload)].slice(0, REPLAY_LIMIT);
        for (const listener of state.listeners) listener(payload);
      });
      await client.subscribe(STATUS_CHANNEL, (payload) => {
        state.status = payload;
      });
    })().catch((error) => {
      state.client?.disconnect();
      state.client = null;
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
