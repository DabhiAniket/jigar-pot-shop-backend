import { Redis } from 'ioredis';
import { logger } from './logger';

let client: Redis | null = null;

/** Shared Redis connection for caching and rate limiting (BullMQ creates its own). */
export function getRedis(url: string | null): Redis | null {
  if (!url) return null;
  if (!client) {
    client = new Redis(url, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: true,
      connectTimeout: 5_000,
    });
    client.on('error', (error) => logger.warn({ err: error.message }, 'redis error'));
  }
  return client;
}

export async function pingRedis(): Promise<boolean | null> {
  if (!client) return null;
  try {
    return (await client.ping()) === 'PONG';
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => client?.disconnect());
    client = null;
  }
}
