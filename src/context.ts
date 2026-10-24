import type { AppConfig } from './config/env';
import type { JobQueue } from './jobs/queue';
import type { Cache } from './lib/cache';
import type { Mailer } from './lib/mailer';
import type { Revalidator } from './lib/revalidate';
import type { Storage } from './storage/storage';

/** Process-wide dependencies, created once at startup and passed to routes and services. */
export interface AppContext {
  config: AppConfig;
  storage: Storage;
  jobs: JobQueue;
  cache: Cache;
  revalidator: Revalidator;
  mailer: Mailer;
}
