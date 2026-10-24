import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAdmin,
  createHarness,
  ORIGIN,
  STRONG_PASSWORD,
  type Harness,
} from '../helpers/harness';

// This file runs with application rate limits switched on (the rest of the suite disables them).
process.env.RATE_LIMITS = 'on';
const INTERNAL_TOKEN = 'test-internal-token-0123456789abcdef';
process.env.INTERNAL_API_TOKEN = INTERNAL_TOKEN;

let harness: Harness;
beforeAll(async () => {
  harness = await createHarness();
});
afterAll(async () => {
  await harness.close();
});

const attempt = (email: string, password: string, headers: Record<string, string> = {}) =>
  harness
    .request()
    .post('/api/v1/admin/auth/login')
    .set('Origin', ORIGIN)
    .set(headers)
    .send({ email, password });

const failSevenTimes = async (email: string, headers: (i: number) => Record<string, string>) => {
  const statuses = [];
  for (let i = 0; i < 7; i++)
    statuses.push((await attempt(email, 'Wrong-Password-99', headers(i))).status);
  return statuses;
};

describe('sign-in rate limiting', () => {
  it('counts only failed attempts per account and blocks after six', async () => {
    const { email } = await createAdmin('order_manager');
    for (let i = 0; i < 3; i++) expect((await attempt(email, STRONG_PASSWORD)).status).toBe(200);
    const failures = [];
    for (let i = 0; i < 7; i++) failures.push((await attempt(email, 'Wrong-Password-99')).status);
    expect(failures.slice(0, 6)).toEqual([401, 401, 401, 401, 401, 401]);
    expect(failures[6]).toBe(429);
    // Once blocked, even the correct password is refused until the window passes.
    const blocked = await attempt(email, STRONG_PASSWORD);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['ratelimit-policy'] ?? blocked.headers['ratelimit']).toBeDefined();
  });

  it('limits unknown accounts the same way, so blocking does not reveal which emails exist', async () => {
    const statuses = [];
    for (let i = 0; i < 7; i++)
      statuses.push((await attempt('nobody-here@example.com', 'Wrong-Password-99')).status);
    expect(statuses.at(-1)).toBe(429);
  });

  it('limits visitors forwarded by the web proxy separately', async () => {
    const { email } = await createAdmin('order_manager');
    const visitor = (ip: string) => () => ({
      'x-client-ip': ip,
      'x-internal-token': INTERNAL_TOKEN,
    });
    expect((await failSevenTimes(email, visitor('203.0.113.7'))).at(-1)).toBe(429);
    // Another visitor behind the same web server keeps their own budget.
    expect((await attempt(email, STRONG_PASSWORD, visitor('198.51.100.20')())).status).toBe(200);
  });

  it('ignores X-Client-IP without the shared token, so callers cannot pick their bucket', async () => {
    const { email } = await createAdmin('order_manager');
    const spoofed = await failSevenTimes(email, (i) => ({
      'x-client-ip': `192.0.2.${i + 1}`,
      'x-internal-token': 'wrong-token-0123456789abcdef',
    }));
    expect(spoofed.at(-1)).toBe(429);
  });

  it('still exempts server-side calls that carry only the shared token', async () => {
    const statuses = await failSevenTimes('server-side@example.com', () => ({
      'x-internal-token': INTERNAL_TOKEN,
    }));
    expect(statuses).not.toContain(429);
  });
});
