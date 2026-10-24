import { Queue, Worker, type Job } from 'bullmq';
import { jobsProcessed } from '../lib/metrics';
import { logger } from '../lib/logger';

export interface JobPayloads {
  'media.process': { assetId: string };
}
export type JobName = keyof JobPayloads;

export interface JobContext {
  attemptsMade: number;
  isFinalAttempt: boolean;
}

export type JobHandlers = {
  [K in JobName]: (data: JobPayloads[K], context: JobContext) => Promise<void>;
};

export interface JobQueue {
  readonly driver: 'inline' | 'bullmq' | 'direct';
  enqueue<K extends JobName>(name: K, data: JobPayloads[K]): Promise<void>;
  close(): Promise<void>;
}

export const JOB_ATTEMPTS = 3;
const QUEUE_NAME = 'jmh-jobs';

/**
 * Production queue: jobs are persisted in Redis and consumed by the separate worker process
 * (`npm run start:worker`), so image conversion never competes with API requests.
 */
export function createBullQueue(redisUrl: string): JobQueue {
  const queue = new Queue(QUEUE_NAME, {
    connection: { url: redisUrl },
    defaultJobOptions: {
      attempts: JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
  return {
    driver: 'bullmq',
    async enqueue(name, data) {
      await queue.add(name, data);
    },
    async close() {
      await queue.close();
    },
  };
}

export function startBullWorker(
  redisUrl: string,
  handlers: JobHandlers,
  concurrency: number,
): Worker {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const name = job.name as JobName;
      const handler = handlers[name];
      if (!handler) throw new Error(`No handler for job ${job.name}`);
      const attemptsMade = job.attemptsMade + 1;
      await handler(job.data, {
        attemptsMade,
        isFinalAttempt: attemptsMade >= (job.opts.attempts ?? 1),
      });
    },
    { connection: { url: redisUrl, maxRetriesPerRequest: null }, concurrency },
  );
  worker.on('completed', (job) => jobsProcessed.inc({ job: job.name, outcome: 'completed' }));
  worker.on('failed', (job, error) => {
    jobsProcessed.inc({ job: job?.name ?? 'unknown', outcome: 'failed' });
    logger.error({ job: job?.name, jobId: job?.id, err: error.message }, 'job failed');
  });
  return worker;
}

/**
 * Development fallback when no Redis is configured: a bounded in-memory queue inside the API
 * process. Sharp does its pixel work on libuv threads, so the event loop stays responsive,
 * but jobs are lost on restart — they are recovered by the stuck-asset sweep.
 */
export function createInlineQueue(handlers: JobHandlers, concurrency = 1): JobQueue {
  const pending: { name: JobName; data: JobPayloads[JobName]; attempt: number }[] = [];
  let running = 0;
  let closed = false;
  const idle: (() => void)[] = [];

  const pump = () => {
    while (!closed && running < concurrency && pending.length > 0) {
      const job = pending.shift()!;
      running++;
      void (async () => {
        const isFinalAttempt = job.attempt >= JOB_ATTEMPTS;
        try {
          await handlers[job.name](job.data as never, {
            attemptsMade: job.attempt,
            isFinalAttempt,
          });
          jobsProcessed.inc({ job: job.name, outcome: 'completed' });
        } catch (error) {
          jobsProcessed.inc({ job: job.name, outcome: 'failed' });
          logger.error(
            { job: job.name, attempt: job.attempt, err: (error as Error).message },
            'job failed',
          );
          if (!isFinalAttempt && !closed) {
            const delay = 1000 * 2 ** job.attempt;
            setTimeout(() => {
              pending.push({ ...job, attempt: job.attempt + 1 });
              pump();
            }, delay).unref();
          }
        } finally {
          running--;
          if (running === 0 && pending.length === 0) idle.splice(0).forEach((resolve) => resolve());
          pump();
        }
      })();
    }
  };

  return {
    driver: 'inline',
    async enqueue(name, data) {
      if (closed) throw new Error('Queue is closed');
      pending.push({ name, data, attempt: 1 });
      setImmediate(pump);
    },
    async close() {
      closed = true;
      if (running > 0) await new Promise<void>((resolve) => idle.push(resolve));
    },
  };
}

/**
 * Serverless queue: the job runs before enqueue() resolves, so it finishes within the request
 * that created it (Vercel may freeze the function once the response is sent). Retries happen
 * immediately; the final failure is recorded by the handler and not rethrown to the caller.
 */
export function createDirectQueue(handlers: JobHandlers): JobQueue {
  return {
    driver: 'direct',
    async enqueue(name, data) {
      for (let attempt = 1; attempt <= JOB_ATTEMPTS; attempt++) {
        const isFinalAttempt = attempt === JOB_ATTEMPTS;
        try {
          await handlers[name](data, { attemptsMade: attempt, isFinalAttempt });
          jobsProcessed.inc({ job: name, outcome: 'completed' });
          return;
        } catch (error) {
          jobsProcessed.inc({ job: name, outcome: 'failed' });
          logger.error({ job: name, attempt, err: (error as Error).message }, 'job failed');
        }
      }
    },
    async close() {},
  };
}
