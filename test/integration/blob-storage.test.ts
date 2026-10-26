import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfig, resetConfigForTests } from '../../src/config/env';
import { getStorage, resetStorageForTests } from '../../src/storage/storage';

const blob = vi.hoisted(() => ({ put: vi.fn(), del: vi.fn(), get: vi.fn(), head: vi.fn() }));
vi.mock('@vercel/blob', () => blob);

const BASE = 'https://store1.public.blob.vercel-storage.com';
function blobStorage() {
  resetStorageForTests();
  Object.assign(process.env, {
    STORAGE_DRIVER: 'blob',
    BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_store1_x',
    MEDIA_PUBLIC_BASE_URL: BASE,
  });
  resetConfigForTests();
  return getStorage(getConfig());
}

beforeEach(() => Object.values(blob).forEach((fn) => fn.mockReset()));

describe('Vercel Blob storage driver', () => {
  it('keeps keys as pathnames so stored keys map to the same public URL', async () => {
    const storage = blobStorage();
    const key = 'img/abc123/card-480.webp';
    blob.put.mockResolvedValue({ url: `${BASE}/${key}` });
    await storage.putPublic(key, Buffer.from('x'), 'image/webp');
    expect(blob.put).toHaveBeenCalledWith(
      key,
      expect.any(Buffer),
      expect.objectContaining({ access: 'public', addRandomSuffix: false, allowOverwrite: true }),
    );
    expect(storage.publicUrl(key)).toBe(`${BASE}/${key}`);
  });

  it('fails loudly when MEDIA_PUBLIC_BASE_URL does not match the store', async () => {
    const storage = blobStorage();
    blob.put.mockResolvedValue({
      url: 'https://other.public.blob.vercel-storage.com/img/a/b.webp',
    });
    await expect(storage.putPublic('img/a/b.webp', Buffer.from('x'), 'image/webp')).rejects.toThrow(
      /MEDIA_PUBLIC_BASE_URL/,
    );
  });

  it('stores private originals under an unguessable, deterministic path', async () => {
    const storage = blobStorage();
    blob.put.mockResolvedValue({});
    await storage.putPrivate('incoming/1.jpg', Buffer.from('x'), 'image/jpeg');
    await storage.putPrivate('incoming/1.jpg', Buffer.from('x'), 'image/jpeg');
    const [first, second] = blob.put.mock.calls.map((call) => call[0] as string);
    expect(first).toMatch(/^private\/[\w-]{32}\/incoming\/1\.jpg$/);
    expect(second).toBe(first);
    await storage.deletePrivate(['incoming/1.jpg']);
    expect(blob.del).toHaveBeenCalledWith([first], { token: 'vercel_blob_rw_store1_x' });
  });

  it('rejects unsafe keys', async () => {
    await expect(blobStorage().putPublic('../x', Buffer.from('x'), 'image/webp')).rejects.toThrow();
  });
});
