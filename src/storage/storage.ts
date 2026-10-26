import fs from 'node:fs/promises';
import path from 'node:path';
import { del, get, put } from '@vercel/blob';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { AppConfig } from '../config/env';
import { hmac, randomToken } from '../lib/crypto';

/**
 * Two areas:
 *  - public:  processed WebP variants, served by the CDN with immutable caching
 *  - private: uploaded originals awaiting processing (and retained originals, if enabled);
 *             never exposed over HTTP
 */
export interface Storage {
  readonly driver: 'local' | 's3' | 'blob';
  putPublic(key: string, body: Buffer, contentType: string): Promise<void>;
  putPrivate(key: string, body: Buffer, contentType: string): Promise<void>;
  getPrivate(key: string): Promise<Buffer>;
  /** Reads a processed public file back (used to re-crop an existing image). */
  getPublic(key: string): Promise<Buffer>;
  deletePublic(keys: string[]): Promise<void>;
  deletePrivate(keys: string[]): Promise<void>;
  publicUrl(key: string): string;
  healthCheck(): Promise<boolean>;
}

export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const KEY_PATTERN = /^[a-z0-9][a-z0-9/_.-]{0,250}$/;

export function assertSafeKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.includes('..') || key.includes('//')) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}

class LocalStorage implements Storage {
  readonly driver = 'local' as const;
  readonly publicDir: string;
  private readonly privateDir: string;

  constructor(
    rootDir: string,
    private readonly publicBaseUrl: string,
  ) {
    this.publicDir = path.join(rootDir, 'public');
    this.privateDir = path.join(rootDir, 'private');
  }

  private async write(baseDir: string, key: string, body: Buffer): Promise<void> {
    assertSafeKey(key);
    const target = path.join(baseDir, key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Write-then-rename so readers never observe a half-written file.
    const temp = `${target}.${randomToken(6)}.tmp`;
    await fs.writeFile(temp, body);
    await fs.rename(temp, target);
  }

  putPublic(key: string, body: Buffer): Promise<void> {
    return this.write(this.publicDir, key, body);
  }

  putPrivate(key: string, body: Buffer): Promise<void> {
    return this.write(this.privateDir, key, body);
  }

  async getPrivate(key: string): Promise<Buffer> {
    assertSafeKey(key);
    return fs.readFile(path.join(this.privateDir, key));
  }

  async getPublic(key: string): Promise<Buffer> {
    assertSafeKey(key);
    return fs.readFile(path.join(this.publicDir, key));
  }

  private async remove(baseDir: string, keys: string[]): Promise<void> {
    await Promise.all(
      keys.map(async (key) => {
        assertSafeKey(key);
        await fs.rm(path.join(baseDir, key), { force: true });
      }),
    );
  }

  deletePublic(keys: string[]): Promise<void> {
    return this.remove(this.publicDir, keys);
  }

  deletePrivate(keys: string[]): Promise<void> {
    return this.remove(this.privateDir, keys);
  }

  publicUrl(key: string): string {
    return `${this.publicBaseUrl}/${key}`;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await fs.mkdir(this.publicDir, { recursive: true });
      await fs.mkdir(this.privateDir, { recursive: true });
      await fs.access(this.publicDir, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}

class S3Storage implements Storage {
  readonly driver = 's3' as const;
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    private readonly publicBaseUrl: string,
    options: NonNullable<AppConfig['storage']['s3']>,
  ) {
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle,
      // Without explicit keys the default provider chain (IAM role, env, profile) is used.
      credentials:
        options.accessKeyId && options.secretAccessKey
          ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }
          : undefined,
    });
  }

  private async put(
    key: string,
    body: Buffer,
    contentType: string,
    cacheControl: string,
  ): Promise<void> {
    assertSafeKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: cacheControl,
      }),
    );
  }

  putPublic(key: string, body: Buffer, contentType: string): Promise<void> {
    return this.put(`public/${key}`, body, contentType, IMMUTABLE_CACHE_CONTROL);
  }

  putPrivate(key: string, body: Buffer, contentType: string): Promise<void> {
    return this.put(`private/${key}`, body, contentType, 'private, no-store');
  }

  async getPrivate(key: string): Promise<Buffer> {
    assertSafeKey(key);
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: `private/${key}` }),
    );
    if (!response.Body) throw new Error(`Empty object: ${key}`);
    return Buffer.from(await response.Body.transformToByteArray());
  }

  async getPublic(key: string): Promise<Buffer> {
    assertSafeKey(key);
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: `public/${key}` }),
    );
    if (!response.Body) throw new Error(`Empty object: ${key}`);
    return Buffer.from(await response.Body.transformToByteArray());
  }

  private async remove(prefix: string, keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      batch.forEach(assertSafeKey);
      if (batch.length === 0) continue;
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((key) => ({ Key: `${prefix}${key}` })), Quiet: true },
        }),
      );
    }
  }

  deletePublic(keys: string[]): Promise<void> {
    return this.remove('public/', keys);
  }

  deletePrivate(keys: string[]): Promise<void> {
    return this.remove('private/', keys);
  }

  /** MEDIA_PUBLIC_BASE_URL should point at the CDN whose origin path is the bucket's /public prefix. */
  publicUrl(key: string): string {
    return `${this.publicBaseUrl}/${key}`;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Vercel Blob. One store holds everything, and public blobs are URL-addressable, so private
 * objects live under an HMAC-derived path nobody can guess. Public keys map 1:1 to Blob
 * pathnames (no random suffix), which keeps the database's keys and URL shape unchanged.
 */
class BlobStorage implements Storage {
  readonly driver = 'blob' as const;

  constructor(
    private readonly token: string,
    private readonly publicBaseUrl: string,
    private readonly secret: string,
  ) {}

  private privatePath(key: string): string {
    assertSafeKey(key);
    return `private/${hmac(this.secret, key).slice(0, 32)}/${key}`;
  }

  async putPublic(key: string, body: Buffer, contentType: string): Promise<void> {
    assertSafeKey(key);
    const blob = await put(key, body, {
      access: 'public',
      token: this.token,
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 31_536_000,
    });
    // Catches a MEDIA_PUBLIC_BASE_URL that does not point at this store before bad URLs are saved.
    if (blob.url !== this.publicUrl(key))
      throw new Error(`Blob URL ${blob.url} does not match MEDIA_PUBLIC_BASE_URL`);
  }

  async putPrivate(key: string, body: Buffer, contentType: string): Promise<void> {
    await put(this.privatePath(key), body, {
      access: 'public',
      token: this.token,
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
    });
  }

  async getPrivate(key: string): Promise<Buffer> {
    const result = await get(this.privatePath(key), {
      access: 'public',
      token: this.token,
      useCache: false,
    });
    if (!result?.stream) throw new Error(`Missing object: ${key}`);
    return Buffer.from(await new Response(result.stream).arrayBuffer());
  }

  async getPublic(key: string): Promise<Buffer> {
    assertSafeKey(key);
    const response = await fetch(this.publicUrl(key), { cache: 'no-store' });
    if (!response.ok) throw new Error(`Missing object: ${key} (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }

  async deletePublic(keys: string[]): Promise<void> {
    keys.forEach(assertSafeKey);
    if (keys.length) await del(keys, { token: this.token });
  }

  async deletePrivate(keys: string[]): Promise<void> {
    if (keys.length) await del(keys.map((key) => this.privatePath(key)), { token: this.token });
  }

  publicUrl(key: string): string {
    return `${this.publicBaseUrl}/${key}`;
  }

  // shortcut: no network probe (Blob list/head calls are billed operations), upgrade if a probe is needed.
  async healthCheck(): Promise<boolean> {
    return Boolean(this.token);
  }
}

let instance: Storage | null = null;

export function getStorage(config: AppConfig): Storage {
  if (!instance) {
    instance =
      config.storage.driver === 'blob' && config.storage.blobToken
        ? new BlobStorage(config.storage.blobToken, config.storage.publicBaseUrl, config.appSecret)
        : config.storage.driver === 's3' && config.storage.s3
        ? new S3Storage(config.storage.s3.bucket, config.storage.publicBaseUrl, config.storage.s3)
        : new LocalStorage(config.storage.localDir, config.storage.publicBaseUrl);
  }
  return instance;
}

/** Directory served at /media in local (development) mode. */
export function localPublicDir(config: AppConfig): string | null {
  return config.storage.driver === 'local' ? path.join(config.storage.localDir, 'public') : null;
}

export function resetStorageForTests(): void {
  instance = null;
}
