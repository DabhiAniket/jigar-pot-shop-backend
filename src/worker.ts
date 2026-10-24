import { connect, createContext, jobHandlers } from './bootstrap';
import { getConfig } from './config/env';
import { disconnectDatabase } from './db/connection';
import { startBullWorker } from './jobs/queue';
import { reportError } from './lib/error-reporter';
import { logger } from './lib/logger';
import { closeRedis } from './lib/redis';
import { configureSharp } from './media/image-processor';
import { recoverStuckAssets } from './media/media.service';

/**
 * Background worker: consumes image-processing jobs from Redis so Sharp never competes with
 * API requests for CPU. Scale it independently of the API (e.g. one worker per 2 vCPUs).
 */
async function main() {
  const config = getConfig();
  if (config.jobsDriver !== 'bullmq' || !config.redisUrl) {
    logger.info(
      'JOBS_DRIVER=inline: images are processed inside the API process, so no worker is needed.',
    );
    return;
  }
  await connect(config);
  const ctx = createContext(config);
  configureSharp(config.media.workerConcurrency);
  const worker = startBullWorker(config.redisUrl, jobHandlers(ctx), config.media.workerConcurrency);
  logger.info({ concurrency: config.media.workerConcurrency }, 'worker started');

  void recoverStuckAssets(ctx).catch((error) => reportError(error, { task: 'recoverStuckAssets' }));
  const sweep = setInterval(() => void recoverStuckAssets(ctx).catch(() => undefined), 5 * 60_000);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'worker shutting down: finishing active jobs');
    clearInterval(sweep);
    await worker.close();
    await ctx.jobs.close();
    await closeRedis();
    await disconnectDatabase();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => reportError(reason, { source: 'unhandledRejection' }));

main().catch((error) => {
  logger.fatal({ err: error }, 'worker failed to start');
  process.exit(1);
});
