import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getConfig, resetConfigForTests } from '../../src/config/env';
import { createHarness, ORIGIN, type Harness } from '../helpers/harness';

let harness: Harness;
beforeAll(async () => {
  harness = await createHarness();
});
afterAll(async () => {
  await harness.close();
});

const preflight = (origin: string) =>
  harness
    .request()
    .options('/api/v1/admin/auth/login')
    .set('Origin', origin)
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'content-type,x-csrf-token');

describe('CORS for a separately hosted frontend', () => {
  it('answers the frontend origin preflight with credentials and an explicit origin', async () => {
    const response = await preflight(ORIGIN);
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-allow-headers']).toMatch(/x-csrf-token/i);
  });

  it('does not grant other origins', async () => {
    const response = await preflight('https://evil.example');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('accepts FRONTEND_URL in place of PUBLIC_WEB_URL and keeps extra CORS_ORIGINS', () => {
    const saved = { web: process.env.PUBLIC_WEB_URL, cors: process.env.CORS_ORIGINS };
    try {
      delete process.env.PUBLIC_WEB_URL;
      process.env.FRONTEND_URL = 'https://shop.example.com/';
      process.env.CORS_ORIGINS = 'https://preview.example.com';
      resetConfigForTests();
      const config = getConfig();
      expect(config.publicWebUrl).toBe('https://shop.example.com');
      expect(config.corsOrigins).toEqual([
        'https://shop.example.com',
        'https://preview.example.com',
      ]);
    } finally {
      process.env.PUBLIC_WEB_URL = saved.web;
      delete process.env.FRONTEND_URL;
      if (saved.cors === undefined) delete process.env.CORS_ORIGINS;
      else process.env.CORS_ORIGINS = saved.cors;
      resetConfigForTests();
    }
  });
});
