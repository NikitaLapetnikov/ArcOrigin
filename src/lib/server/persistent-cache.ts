import "server-only";

import { createClient, type RedisClientType } from "redis";

declare global {
  var __arcOriginRedisClient: RedisClientType | null | undefined;
  var __arcOriginRedisConnection: Promise<RedisClientType | null> | undefined;
}

async function redisClient() {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (globalThis.__arcOriginRedisClient?.isReady) return globalThis.__arcOriginRedisClient;
  if (!globalThis.__arcOriginRedisConnection) {
    globalThis.__arcOriginRedisConnection = (async () => {
      const client = createClient({
        url,
        socket: { connectTimeout: 1_500, reconnectStrategy: false },
      });
      client.on("error", () => undefined);
      try {
        await client.connect();
        globalThis.__arcOriginRedisClient = client;
        return client;
      } catch {
        globalThis.__arcOriginRedisClient = null;
        return null;
      }
    })().finally(() => {
      globalThis.__arcOriginRedisConnection = undefined;
    });
  }
  return globalThis.__arcOriginRedisConnection;
}

export async function readPersistentSnapshot<T>(key: string): Promise<T | null> {
  try {
    const client = await redisClient();
    const value = client ? await client.get(key) : null;
    return value ? JSON.parse(value) as T : null;
  } catch {
    return null;
  }
}

export async function writePersistentSnapshot(key: string, value: unknown, ttlSeconds = 86_400) {
  try {
    const client = await redisClient();
    if (client) await client.set(key, JSON.stringify(value), { EX: ttlSeconds });
  } catch {
    // Persistent caching must never make an onchain request fail.
  }
}
