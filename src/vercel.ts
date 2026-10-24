import express from 'express';
import { createApp } from './app';
import { connect, createContext } from './bootstrap';
import { getConfig } from './config/env';
import { logger } from './lib/logger';

/**
 * Vercel Functions entry (api/index.js re-exports the bundled build of this file). One instance
 * serves many requests, so the app is built once and the database connection is opened lazily
 * and reused. Migrations stay an explicit release step (`npm run db:migrate`).
 */
const config = getConfig();
const app = createApp(createContext(config));

let ready: Promise<void> | null = null;
const handler = express();
handler.disable('x-powered-by');
handler.use(async (_req, res, next) => {
  try {
    ready ??= connect(config);
    await ready;
    next();
  } catch (error) {
    ready = null;
    logger.error({ err: (error as Error).message }, 'database connection failed');
    res.status(503).json({
      error: { code: 'UNAVAILABLE', message: 'Service temporarily unavailable.' },
    });
  }
});
handler.use(app);

export default handler;
