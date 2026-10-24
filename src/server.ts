import { createApp, type AppState } from './app';
import { connect, createContext } from './bootstrap';
import { getConfig } from './config/env';
import { disconnectDatabase } from './db/connection';
import { reportError } from './lib/error-reporter';
import { logger } from './lib/logger';
import { closeRedis } from './lib/redis';
import { recoverStuckAssets } from './media/media.service';
import { runMigrations } from './migrations';

const SHUTDOWN_GRACE_MS = 25_000;

async function main() {
  const config = getConfig();
  await connect(config);
  if (!config.isProd) {
    // Production applies migrations as an explicit release step (npm run db:migrate).
    await runMigrations(config);
  }

  const ctx = createContext(config);
  const state: AppState = { shuttingDown: false };
  const app = createApp(ctx, state);
  const server = app.listen(config.port, config.host, () => {
    logger.info(
      { port: config.port, jobs: ctx.jobs.driver, storage: ctx.storage.driver },
      'API listening',
    );
  });
  // Keep-alive must outlive the load balancer's idle timeout (commonly 60s).
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 120_000;

  let sweep: NodeJS.Timeout | null = null;
  if (ctx.jobs.driver === 'inline') {
    void recoverStuckAssets(ctx).catch((error) =>
      reportError(error, { task: 'recoverStuckAssets' }),
    );
    sweep = setInterval(() => void recoverStuckAssets(ctx).catch(() => undefined), 5 * 60_000);
    sweep.unref();
  }

  const shutdown = async (signal: string) => {
    if (state.shuttingDown) return;
    state.shuttingDown = true;
    logger.info({ signal }, 'shutting down: draining connections');
    const force = setTimeout(() => {
      logger.error('forced shutdown after grace period');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    if (sweep) clearInterval(sweep);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await ctx.jobs.close().catch(() => undefined);
    await closeRedis();
    await disconnectDatabase();
    logger.info('shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => reportError(reason, { source: 'unhandledRejection' }));
process.on('uncaughtException', (error) => {
  reportError(error, { source: 'uncaughtException' });
  process.exit(1);
});

main().catch((error) => {
  logger.fatal({ err: error }, 'API failed to start');
  process.exit(1);
});
