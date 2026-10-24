import { describe, expect, it } from 'vitest';
import { createDirectQueue, JOB_ATTEMPTS, type JobHandlers } from '../../src/jobs/queue';

const handlersWith = (process: JobHandlers['media.process']): JobHandlers => ({
  'media.process': process,
});

describe('direct job queue (serverless)', () => {
  it('finishes the job before enqueue resolves', async () => {
    const done: string[] = [];
    const queue = createDirectQueue(
      handlersWith(async ({ assetId }) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        done.push(assetId);
      }),
    );
    await queue.enqueue('media.process', { assetId: 'a1' });
    expect(done).toEqual(['a1']);
  });

  it('retries, flags the final attempt and does not throw to the caller', async () => {
    const attempts: { attemptsMade: number; isFinalAttempt: boolean }[] = [];
    const queue = createDirectQueue(
      handlersWith(async (_data, context) => {
        attempts.push(context);
        throw new Error('decode failed');
      }),
    );
    await expect(queue.enqueue('media.process', { assetId: 'a2' })).resolves.toBeUndefined();
    expect(attempts).toHaveLength(JOB_ATTEMPTS);
    expect(attempts.at(-1)).toEqual({ attemptsMade: JOB_ATTEMPTS, isFinalAttempt: true });
    expect(attempts.slice(0, -1).every((a) => !a.isFinalAttempt)).toBe(true);
  });
});
