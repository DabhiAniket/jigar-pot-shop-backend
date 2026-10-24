import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Router, type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { AppContext } from './context';
import { pingDatabase } from './db/connection';
import { safeEqual } from './lib/crypto';
import { logger } from './lib/logger';
import { httpDuration, httpRequests, renderMetrics } from './lib/metrics';
import { getRedis, pingRedis } from './lib/redis';
import { csrfProtection, loadSession, originCheck } from './middleware/auth';
import { forwardedClientIp } from './middleware/client-ip';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { createLimiterFactory } from './middleware/rate-limit';
import { authRoutes } from './modules/auth/auth.routes';
import { catalogAdminRoutes } from './modules/catalog/catalog.admin.routes';
import { dashboardAdminRoutes } from './modules/dashboard/dashboard.admin.routes';
import { inventoryAdminRoutes } from './modules/inventory/inventory.admin.routes';
import { mediaAdminRoutes } from './modules/media/media.admin.routes';
import { ordersAdminRoutes } from './modules/orders/orders.admin.routes';
import { promotionsAdminRoutes } from './modules/promotions/promotions.admin.routes';
import { publicRoutes } from './modules/public.routes';
import { settingsAdminRoutes } from './modules/settings/settings.admin.routes';
import { usersAdminRoutes } from './modules/users/users.admin.routes';
import { localPublicDir } from './storage/storage';

export interface AppState {
  shuttingDown: boolean;
}

const UNTRACKED_PATHS = new Set(['/health', '/ready', '/metrics']);

export function createApp(ctx: AppContext, state: AppState = { shuttingDown: false }): Express {
  const { config } = ctx;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('query parser', 'simple');
  app.use(forwardedClientIp(config.internalApiToken));

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id =
          typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: {
        ignore: (req) =>
          UNTRACKED_PATHS.has(req.url ?? '') || (req.url ?? '').startsWith('/media/'),
      },
      customLogLevel: (_req, res, error) =>
        error || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      serializers: {
        // Capability tokens (order confirmation, password reset) never reach the logs.
        req: (req) => ({
          id: req.id,
          method: req.method,
          url: String(req.url ?? '').replace(/([?&]token=)[^&]*/gi, '$1[redacted]'),
        }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use(metricsMiddleware);
  app.use(
    helmet({
      // The API only serves JSON and images; nothing here should ever render as a page.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      strictTransportSecurity: config.isProd
        ? { maxAge: 31_536_000, includeSubDomains: true }
        : false,
    }),
  );
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || config.corsOrigins.includes(origin)),
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key', 'X-Request-Id'],
      maxAge: 600,
    }),
  );

  app.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok' });
  });

  let readiness: { at: number; ok: boolean; checks: Record<string, boolean | null> } | null = null;
  app.get('/ready', async (_req, res) => {
    if (state.shuttingDown) {
      res.status(503).json({ status: 'shutting_down' });
      return;
    }
    if (!readiness || Date.now() - readiness.at > 5_000) {
      const [database, redis, storage] = await Promise.all([
        pingDatabase(),
        pingRedis(),
        ctx.storage.healthCheck(),
      ]);
      const checks = { database, redis, storage };
      readiness = { at: Date.now(), ok: database && redis !== false && storage, checks };
    }
    res
      .status(readiness.ok ? 200 : 503)
      .set('Cache-Control', 'no-store')
      .json({ status: readiness.ok ? 'ready' : 'not_ready', checks: readiness.checks });
  });

  app.get('/metrics', (req, res) => {
    const token = config.metricsToken;
    const provided = req.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!token || !safeEqual(provided, token)) {
      res.status(404).end();
      return;
    }
    res.type('text/plain; version=0.0.4').send(renderMetrics());
  });

  const mediaDir = localPublicDir(config);
  if (mediaDir) {
    // Development-only static serving; production images come from object storage via the CDN.
    app.use(
      '/media',
      express.static(mediaDir, {
        immutable: true,
        maxAge: '365d',
        index: false,
        dotfiles: 'deny',
        fallthrough: false,
      }),
    );
  }

  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());

  const limiter = createLimiterFactory(
    getRedis(config.redisUrl),
    process.env.RATE_LIMITS !== 'off' || config.isProd,
    config.internalApiToken,
  );
  const api = Router();
  api.use(limiter({ name: 'global', windowMs: 60_000, limit: 600 }));
  api.use(originCheck(config));
  api.use(publicRoutes(ctx, limiter));

  const admin = Router();
  admin.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
  admin.use(loadSession(config));
  admin.use(csrfProtection(config));
  admin.use('/auth', authRoutes(ctx, limiter));
  admin.use('/dashboard', dashboardAdminRoutes(ctx));
  admin.use('/media', mediaAdminRoutes(ctx, limiter));
  admin.use('/inventory', inventoryAdminRoutes(ctx));
  admin.use('/promotions', promotionsAdminRoutes(ctx));
  admin.use(catalogAdminRoutes(ctx));
  admin.use(ordersAdminRoutes(ctx));
  admin.use(settingsAdminRoutes(ctx));
  admin.use(usersAdminRoutes(ctx));
  api.use('/admin', admin);

  app.use('/api/v1', api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const metricsMiddleware: RequestHandler = (req, res, next) => {
  if (UNTRACKED_PATHS.has(req.path)) return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route?.path
      ? `${req.baseUrl}${req.route.path}`
      : req.path.startsWith('/media/')
        ? '/media'
        : 'unmatched';
    const labels = { method: req.method, route, status: `${Math.floor(res.statusCode / 100)}xx` };
    httpRequests.inc(labels);
    httpDuration.observe({ method: req.method, route }, seconds);
  });
  next();
};
