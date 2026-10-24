import { logger } from './logger';

export type ErrorReporter = (error: unknown, context: Record<string, unknown>) => void;

const reporters: ErrorReporter[] = [];

/**
 * Hook for an error-monitoring service. Example with Sentry (not bundled):
 *   Sentry.init({ dsn: process.env.SENTRY_DSN });
 *   registerErrorReporter((error, context) => Sentry.captureException(error, { extra: context }));
 */
export function registerErrorReporter(reporter: ErrorReporter): void {
  reporters.push(reporter);
}

export function reportError(error: unknown, context: Record<string, unknown> = {}): void {
  logger.error({ err: error, ...context }, 'unhandled error');
  for (const reporter of reporters) {
    try {
      reporter(error, context);
    } catch {
      // A broken reporter must never take the request down with it.
    }
  }
}
