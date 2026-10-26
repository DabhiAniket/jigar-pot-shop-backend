import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adminClient,
  createHarness,
  makeTestImage,
  signedInAs,
  type Harness,
} from '../helpers/harness';
import { MediaAssetModel } from '../../src/db/models';
import { ORIGIN } from '../helpers/harness';

const blob = vi.hoisted(() => ({ head: vi.fn(), del: vi.fn(), put: vi.fn(), get: vi.fn() }));
vi.mock('@vercel/blob', () => blob);

const TOKEN = 'vercel_blob_rw_teststore_secretsecretsecret';
const tokenRequest = (pathname: string) => ({
  type: 'blob.generate-client-token',
  payload: { pathname, clientPayload: null, multipart: false },
});

let harness: Harness;
let pm: ReturnType<typeof adminClient>;
beforeAll(async () => {
  harness = await createHarness();
  pm = adminClient(await signedInAs(harness, 'product_manager'));
});
afterAll(async () => {
  await harness.close();
});
beforeEach(() => {
  Object.values(blob).forEach((fn) => fn.mockReset());
  blob.del.mockResolvedValue(undefined);
  harness.ctx.config.storage.blobToken = TOKEN;
});

describe('direct-to-Blob uploads', () => {
  it('refuses anonymous token requests', async () => {
    const response = await harness
      .request()
      .post('/api/v1/admin/media/blob-token')
      .set('Origin', ORIGIN)
      .send(tokenRequest('client-uploads/a.jpg'));
    expect(response.status).toBe(401);
  });

  it('issues a client token only for the client-uploads prefix, never the read-write token', async () => {
    const ok = await pm.post(
      '/api/v1/admin/media/blob-token',
      tokenRequest('client-uploads/a.jpg'),
    );
    expect(ok.status).toBe(200);
    expect(ok.body.clientToken).toEqual(expect.any(String));
    expect(JSON.stringify(ok.body)).not.toContain('secretsecret');
    const bad = await pm.post('/api/v1/admin/media/blob-token', tokenRequest('img/x/large-1.webp'));
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.body.clientToken).toBeUndefined();
  });

  it('is unavailable when Blob is not configured', async () => {
    harness.ctx.config.storage.blobToken = null;
    const response = await pm.post(
      '/api/v1/admin/media/blob-token',
      tokenRequest('client-uploads/a.jpg'),
    );
    expect(response.status).toBe(400);
  });

  it('turns an uploaded blob into an asset and deletes the temporary blob', async () => {
    const image = await makeTestImage(800, 600);
    blob.head.mockResolvedValue({
      size: image.length,
      url: 'https://x.public.blob.vercel-storage.com/c.jpg',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(image))),
    );
    const response = await pm.post('/api/v1/admin/media', {
      blobPathname: 'client-uploads/a-123.jpg',
      originalName: 'pot photo.jpg',
      alt: 'A pot',
      crop: null,
    });
    vi.unstubAllGlobals();
    expect(response.status).toBe(202);
    expect(blob.del).toHaveBeenCalledWith('client-uploads/a-123.jpg', { token: TOKEN });
    expect(await MediaAssetModel.countDocuments({ originalFilename: 'pot photo.jpg' })).toBe(1);
  });

  it('rejects pathnames outside client-uploads and oversized blobs (and still cleans up)', async () => {
    const outside = await pm.post('/api/v1/admin/media', {
      blobPathname: 'img/other/large-1.webp',
      originalName: 'x.jpg',
    });
    expect(outside.status).toBe(400);
    expect(blob.head).not.toHaveBeenCalled();
    blob.head.mockResolvedValue({
      size: 10 ** 9,
      url: 'https://x.public.blob.vercel-storage.com/c.jpg',
    });
    const big = await pm.post('/api/v1/admin/media', {
      blobPathname: 'client-uploads/big.jpg',
      originalName: 'big.jpg',
    });
    expect(big.status).toBe(400);
    expect(blob.del).toHaveBeenCalledWith('client-uploads/big.jpg', { token: TOKEN });
  });
});
