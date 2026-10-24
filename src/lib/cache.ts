import type { Redis } from 'ioredis';
import { logger } from './logger';

/**
 * Read-through cache for public catalogue responses only (never carts, orders or admin data).
 * Entries are versioned per namespace: a write bumps the version, which instantly orphans every
 * cached entry in Redis; per-instance memory entries expire within their short TTL.
 */
export interface Cache {
  wrap<T>(namespace: string, key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T>;
  invalidate(...namespaces: string[]): Promise<void>;
}

const MAX_MEMORY_ENTRIES = 1000;
const MEMORY_TTL_CAP_SECONDS = 15;

export function createCache(redis: Redis | null): Cache {
  const memory = new Map<string, { expires: number; value: unknown }>();
  const localVersions = new Map<string, number>();
  const inflight = new Map<string, Promise<unknown>>();

  async function version(namespace: string): Promise<string> {
    if (redis) {
      try {
        return (await redis.get(`cache:v:${namespace}`)) ?? '0';
      } catch {
        return `local-${localVersions.get(namespace) ?? 0}`;
      }
    }
    return String(localVersions.get(namespace) ?? 0);
  }

  return {
    async wrap<T>(
      namespace: string,
      key: string,
      ttlSeconds: number,
      load: () => Promise<T>,
    ): Promise<T> {
      const fullKey = `cache:${namespace}:${await version(namespace)}:${key}`;
      const now = Date.now();
      const hit = memory.get(fullKey);
      if (hit && hit.expires > now) return hit.value as T;

      if (redis) {
        try {
          const raw = await redis.get(fullKey);
          if (raw !== null) {
            const value = JSON.parse(raw) as T;
            remember(fullKey, value, ttlSeconds);
            return value;
          }
        } catch (error) {
          logger.debug({ err: (error as Error).message }, 'cache read failed');
        }
      }

      // Collapse concurrent misses for the same key into one database query.
      const existing = inflight.get(fullKey);
      if (existing) return existing as Promise<T>;
      const promise = (async () => {
        const value = await load();
        remember(fullKey, value, ttlSeconds);
        if (redis) {
          redis.set(fullKey, JSON.stringify(value), 'EX', ttlSeconds).catch(() => undefined);
        }
        return value;
      })().finally(() => inflight.delete(fullKey));
      inflight.set(fullKey, promise);
      return promise;
    },

    async invalidate(...namespaces: string[]) {
      for (const namespace of namespaces) {
        localVersions.set(namespace, (localVersions.get(namespace) ?? 0) + 1);
        for (const key of memory.keys())
          if (key.startsWith(`cache:${namespace}:`)) memory.delete(key);
        if (redis) await redis.incr(`cache:v:${namespace}`).catch(() => undefined);
      }
    },
  };

  function remember(key: string, value: unknown, ttlSeconds: number) {
    if (memory.size >= MAX_MEMORY_ENTRIES) {
      const oldest = memory.keys().next().value;
      if (oldest) memory.delete(oldest);
    }
    memory.set(key, {
      value,
      expires: Date.now() + Math.min(ttlSeconds, MEMORY_TTL_CAP_SECONDS) * 1000,
    });
  }
}

/** No-op cache for tests that need to observe writes immediately. */
export const passthroughCache: Cache = {
  wrap: (_namespace, _key, _ttl, load) => load(),
  invalidate: async () => undefined,
};
