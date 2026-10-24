import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inject } from 'vitest';

// Every test file runs in its own module scope with its own database and storage directory.
const fileId = Math.random().toString(36).slice(2, 10);
const baseUri = inject('mongoUri');
const [uriWithoutQuery, query] = baseUri.split('?');
// Tests drop their databases on teardown: refuse to run against anything but a local server.
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(baseUri)) {
  throw new Error(
    'Integration tests must use the local in-memory MongoDB, never a remote cluster.',
  );
}

process.env.NODE_ENV = 'test';
process.env.APP_SECRET = 'test-secret-that-is-definitely-longer-than-32-chars';
process.env.MONGODB_URI = `${uriWithoutQuery!.replace(/\/[^/]*$/, '')}/jmh_test_${fileId}${query ? `?${query}` : ''}`;
process.env.MONGODB_AUTO_INDEX = 'true';
process.env.PUBLIC_WEB_URL = 'http://localhost:3000';
process.env.MEDIA_PUBLIC_BASE_URL = 'http://localhost:3000/media';
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_LOCAL_DIR = mkdtempSync(path.join(os.tmpdir(), 'jmh-storage-'));
process.env.RATE_LIMITS = process.env.RATE_LIMITS ?? 'off';
process.env.WHATSAPP_BUSINESS_NUMBER = '919000000001';
delete process.env.REDIS_URL;
delete process.env.WEB_REVALIDATE_URL;
