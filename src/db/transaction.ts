import mongoose, { type ClientSession } from 'mongoose';
import { AppError } from '../lib/errors';

const DEFAULT_DEADLINE_MS = 8_000;

function hasLabel(error: unknown, label: string): boolean {
  const candidate = error as {
    hasErrorLabel?: (label: string) => boolean;
    errorLabels?: string[];
  } | null;
  return Boolean(candidate?.hasErrorLabel?.(label) || candidate?.errorLabels?.includes(label));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` in a MongoDB transaction, retrying transient write conflicts with jittered backoff —
 * but only until a deadline. The driver's built-in helper retries for up to 120 s while holding a
 * pooled connection, which under heavy contention starves every other request. Here a hot spot
 * fails fast with 503 instead (checkout retries are safe thanks to the Idempotency-Key).
 */
export async function runTransaction<T>(
  fn: (session: ClientSession) => Promise<T>,
  options: { deadlineMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const session = await mongoose.startSession();
  try {
    for (let attempt = 1; ; attempt++) {
      session.startTransaction({
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
      let result: T;
      try {
        result = await fn(session);
      } catch (error) {
        if (session.inTransaction()) await session.abortTransaction().catch(() => undefined);
        if (hasLabel(error, 'TransientTransactionError') && Date.now() < deadline) {
          await sleep(Math.random() * Math.min(20 * 2 ** attempt, 400));
          continue;
        }
        if (hasLabel(error, 'TransientTransactionError')) throw busy();
        throw error;
      }
      // Commit, retrying only the commit when its outcome is unknown (e.g. a network blip).
      for (;;) {
        try {
          await session.commitTransaction();
          return result;
        } catch (error) {
          if (hasLabel(error, 'UnknownTransactionCommitResult') && Date.now() < deadline) continue;
          if (hasLabel(error, 'TransientTransactionError') && Date.now() < deadline) break;
          if (
            hasLabel(error, 'TransientTransactionError') ||
            hasLabel(error, 'UnknownTransactionCommitResult')
          )
            throw busy();
          throw error;
        }
      }
      await sleep(Math.random() * Math.min(20 * 2 ** attempt, 400));
    }
  } finally {
    await session.endSession();
  }
}

function busy(): AppError {
  return new AppError(
    503,
    'CHECKOUT_BUSY',
    'We are handling a lot of orders right now. Please try again in a moment.',
  );
}
