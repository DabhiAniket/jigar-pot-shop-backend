import { getConfig, type AppConfig } from './config/env';
import type { AppContext } from './context';
import { assertTransactionsSupported, connectDatabase } from './db/connection';
import {
  createBullQueue,
  createDirectQueue,
  createInlineQueue,
  type JobHandlers,
  type JobQueue,
} from './jobs/queue';
import { createCache } from './lib/cache';
import { createMailer } from './lib/mailer';
import { getRedis } from './lib/redis';
import { createRevalidator } from './lib/revalidate';
import { configureSharp } from './media/image-processor';
import { processAsset } from './media/media.service';
import { getStorage } from './storage/storage';

export function jobHandlers(ctx: AppContext): JobHandlers {
  return {
    'media.process': (data, job) =>
      processAsset(ctx, data.assetId, { isFinalAttempt: job.isFinalAttempt }),
  };
}

/** Creates the shared dependencies. Inline jobs run inside this process; BullMQ jobs in the worker. */
export function createContext(config: AppConfig = getConfig()): AppContext {
  const redis = getRedis(config.redisUrl);
  const ctx = {
    config,
    storage: getStorage(config),
    cache: createCache(redis),
    revalidator: createRevalidator(config),
    mailer: createMailer(config),
  } as AppContext;
  let jobs: JobQueue;
  if (config.jobsDriver === 'bullmq' && config.redisUrl) {
    jobs = createBullQueue(config.redisUrl);
  } else if (config.jobsDriver === 'direct') {
    configureSharp(1);
    jobs = createDirectQueue(jobHandlers(ctx));
  } else {
    configureSharp(2);
    jobs = createInlineQueue(jobHandlers(ctx), 1);
  }
  ctx.jobs = jobs;
  return ctx;
}

export async function connect(config: AppConfig): Promise<void> {
  await connectDatabase(config);
  await assertTransactionsSupported();
}
