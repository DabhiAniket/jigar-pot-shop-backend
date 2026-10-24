import { isIP } from 'node:net';
import type { RequestHandler } from 'express';
import { safeEqual } from '../lib/crypto';

/**
 * When the storefront is deployed separately (e.g. on Vercel), browser requests reach the API
 * through the web app's proxy, so the socket address is the web server's. The proxy forwards the
 * visitor's address in X-Client-IP together with the shared INTERNAL_API_TOKEN; only then is the
 * header trusted, so callers hitting the API directly cannot choose their rate-limit bucket.
 */
export function forwardedClientIp(internalToken: string | null): RequestHandler {
  return (req, _res, next) => {
    const forwarded = req.get('x-client-ip')?.trim();
    const provided = req.get('x-internal-token');
    if (
      internalToken &&
      forwarded &&
      provided &&
      isIP(forwarded) &&
      safeEqual(provided, internalToken)
    ) {
      Object.defineProperty(req, 'ip', { value: forwarded, configurable: true });
    }
    next();
  };
}
