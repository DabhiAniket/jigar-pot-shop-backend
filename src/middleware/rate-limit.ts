import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { Redis } from 'ioredis';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { safeEqual } from '../lib/crypto';

export interface LimiterOptions {
  name: string;
  windowMs: number;
  limit: number;
  key?: (req: Request) => string;
  message?: string;
  /** Count only failed (4xx/5xx) responses, e.g. for sign-in brute-force protection. */
  skipSuccessfulRequests?: boolean;
}

/**
 * Application-layer limits. With Redis they are shared by every API instance; without it each
 * instance counts on its own. Edge/WAF limits should sit in front of these in production.
 * Note that many Indian mobile users share carrier-grade NAT addresses, so per-IP limits are
 * deliberately generous except on authentication endpoints.
 */
export function createLimiterFactory(
  redis: Redis | null,
  enabled: boolean,
  internalToken: string | null = null,
) {
  // Server-to-server calls from the storefront all originate from the web servers' addresses;
  // they authenticate with a shared token instead of sharing one visitor's rate-limit bucket.
  // Requests the web proxy forwards on behalf of a visitor (X-Client-IP) are still limited.
  const isInternal = (req: Request) => {
    if (req.get('x-client-ip')) return false;
    const provided = req.get('x-internal-token');
    return Boolean(internalToken && provided && safeEqual(provided, internalToken));
  };
  return function limiter(options: LimiterOptions): RequestHandler {
    if (!enabled) return (_req, _res, next) => next();
    return rateLimit({
      skip: isInternal,
      skipSuccessfulRequests: options.skipSuccessfulRequests ?? false,
      windowMs: options.windowMs,
      limit: options.limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      keyGenerator: options.key ?? ((req) => ipKeyGenerator(req.ip ?? 'unknown')),
      store: redis
        ? new RedisStore({
            prefix: `rl:${options.name}:`,
            sendCommand: (command: string, ...args: string[]) =>
              redis.call(command, ...args) as Promise<RedisReply>,
          })
        : undefined,
      handler: (req, res) => {
        res.status(429).json({
          error: {
            code: 'RATE_LIMITED',
            message: options.message ?? 'Too many requests. Please wait a moment and try again.',
            requestId: req.id,
          },
        });
      },
    });
  };
}

export type LimiterFactory = ReturnType<typeof createLimiterFactory>;

export function ipAndBodyEmailKey(req: Request): string {
  const email =
    typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 160) : '';
  return `${ipKeyGenerator(req.ip ?? 'unknown')}:${email}`;
}
