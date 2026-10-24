import type { Request, RequestHandler } from 'express';
import { hasPermission, type Permission } from '@jmh/shared';
import type { AppConfig } from '../config/env';
import { safeEqual } from '../lib/crypto';
import { forbidden, unauthorized } from '../lib/errors';
import { csrfTokenFor, resolveSession } from '../modules/auth/auth.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Attaches req.admin when a valid session cookie is present. Never rejects on its own. */
export function loadSession(config: AppConfig): RequestHandler {
  return async (req, _res, next) => {
    const token = req.cookies?.[config.cookies.sessionName];
    if (typeof token === 'string' && token) {
      const admin = await resolveSession(config, token);
      if (admin) req.admin = admin;
    }
    next();
  };
}

/**
 * Rejects cross-site state-changing requests. Browsers always send Origin on such requests;
 * non-browser clients (scripts, load tests) send none and rely on the CSRF token instead.
 */
export function originCheck(config: AppConfig): RequestHandler {
  const allowed = new Set([config.publicWebUrl, ...config.corsOrigins]);
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.get('origin');
    if (origin && origin !== 'null' && !allowed.has(origin)) {
      return next(forbidden('Cross-site request blocked.', 'BAD_ORIGIN'));
    }
    if (origin === 'null') return next(forbidden('Cross-site request blocked.', 'BAD_ORIGIN'));
    next();
  };
}

/** Double-submit protection for cookie-authenticated admin mutations. */
/**
 * Endpoints that establish or recover credentials. They must work even when the browser still
 * holds an old session cookie (e.g. signing in again), so they rely on the Origin check and
 * rate limits instead of the session-bound token.
 */
const CSRF_EXEMPT_PATHS = new Set(['/auth/login', '/auth/forgot-password', '/auth/reset-password']);

export function csrfProtection(config: AppConfig): RequestHandler {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method) || !req.admin || CSRF_EXEMPT_PATHS.has(req.path))
      return next();
    const provided = req.get('x-csrf-token') ?? '';
    const expected = csrfTokenFor(config, req.admin.sessionTokenHash);
    if (!provided || !safeEqual(provided, expected)) {
      return next(
        forbidden(
          'Your session security token is missing or expired. Refresh the page and try again.',
          'CSRF_FAILED',
        ),
      );
    }
    next();
  };
}

function ensureAdmin(req: Request, allowPendingPasswordChange: boolean) {
  if (!req.admin) throw unauthorized();
  if (req.admin.mustChangePassword && !allowPendingPasswordChange) {
    throw forbidden('Please change your password before continuing.', 'PASSWORD_CHANGE_REQUIRED');
  }
  return req.admin;
}

export function requireAdmin(
  options: { allowPendingPasswordChange?: boolean } = {},
): RequestHandler {
  return (req, _res, next) => {
    ensureAdmin(req, options.allowPendingPasswordChange ?? false);
    next();
  };
}

/** Enforces role permissions on the server for every protected operation. */
export function requirePermission(...permissions: Permission[]): RequestHandler {
  return (req, _res, next) => {
    const admin = ensureAdmin(req, false);
    const missing = permissions.filter((permission) => !hasPermission(admin.role, permission));
    if (missing.length) throw forbidden();
    next();
  };
}

export function clientIp(req: Request): string | null {
  return req.ip ?? null;
}
