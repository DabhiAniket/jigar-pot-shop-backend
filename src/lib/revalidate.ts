import type { AppConfig } from '../config/env';
import { logger } from './logger';

export type RevalidationTag = 'catalog' | 'settings' | 'home' | 'promotions';

export interface Revalidator {
  /** Fire-and-forget: tells the Next.js storefront to refresh cached pages for these tags. */
  notify(tags: RevalidationTag[]): void;
}

export function createRevalidator(config: AppConfig): Revalidator {
  if (!config.revalidate) {
    return { notify: () => undefined };
  }
  const { url, secret } = config.revalidate;
  return {
    notify(tags) {
      void fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-revalidate-secret': secret },
        body: JSON.stringify({ tags }),
        signal: AbortSignal.timeout(3_000),
      })
        .then((response) => {
          if (!response.ok)
            logger.warn({ status: response.status, tags }, 'storefront revalidation rejected');
        })
        .catch((error: Error) =>
          logger.warn({ err: error.message, tags }, 'storefront revalidation failed'),
        );
    },
  };
}
