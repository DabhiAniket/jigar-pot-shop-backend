import type { Express } from 'express';
import mongoose from 'mongoose';
import sharp from 'sharp';
import supertest from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import type { AdminRole } from '@jmh/shared';
import { createApp } from '../../src/app';
import { getConfig } from '../../src/config/env';
import type { AppContext } from '../../src/context';
import { connectDatabase } from '../../src/db/connection';
import { AdminUserModel, CategoryModel, MediaAssetModel, ProductModel } from '../../src/db/models';
import { createInlineQueue } from '../../src/jobs/queue';
import { passthroughCache } from '../../src/lib/cache';
import { createMailer } from '../../src/lib/mailer';
import { processAsset } from '../../src/media/media.service';
import { hashPassword } from '../../src/modules/auth/auth.service';
import { invalidateSettingsCache } from '../../src/modules/settings/settings.service';
import { runMigrations } from '../../src/migrations';
import { getStorage } from '../../src/storage/storage';

export const ORIGIN = 'http://localhost:3000';
export const STRONG_PASSWORD = 'Terracotta-Kiln-48';

export interface Harness {
  ctx: AppContext;
  app: Express;
  request: () => TestAgent;
  close: () => Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const config = getConfig();
  await connectDatabase(config);
  await runMigrations(config);
  invalidateSettingsCache();
  const ctx = {
    config,
    storage: getStorage(config),
    cache: passthroughCache,
    revalidator: { notify: () => undefined },
    mailer: createMailer(config),
  } as Partial<AppContext> as AppContext;
  ctx.jobs = createInlineQueue(
    {
      'media.process': (data, job) =>
        processAsset(ctx, data.assetId, { isFinalAttempt: job.isFinalAttempt }),
    },
    1,
  );
  const app = createApp(ctx);
  return {
    ctx,
    app,
    request: () => supertest.agent(app),
    close: async () => {
      await ctx.jobs.close();
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    },
  };
}

export interface SignedInAdmin {
  agent: TestAgent;
  csrf: string;
  id: string;
  email: string;
}

let adminCounter = 0;

export async function createAdmin(
  role: AdminRole,
  options: { mustChangePassword?: boolean; password?: string; email?: string } = {},
) {
  adminCounter++;
  const email = options.email ?? `${role}.${adminCounter}.${Date.now()}@example.com`;
  const admin = await AdminUserModel.create({
    email,
    name: `Test ${role.replace('_', ' ')} ${adminCounter}`,
    role,
    passwordHash: await hashPassword(options.password ?? STRONG_PASSWORD),
    mustChangePassword: options.mustChangePassword ?? false,
  });
  return { id: admin._id.toString(), email };
}

export async function signIn(
  harness: Harness,
  email: string,
  password = STRONG_PASSWORD,
): Promise<SignedInAdmin> {
  const agent = harness.request();
  const response = await agent
    .post('/api/v1/admin/auth/login')
    .set('Origin', ORIGIN)
    .send({ email, password });
  if (response.status !== 200)
    throw new Error(`Sign-in failed: ${response.status} ${JSON.stringify(response.body)}`);
  return { agent, csrf: response.body.data.csrfToken, id: response.body.data.id, email };
}

export async function signedInAs(harness: Harness, role: AdminRole): Promise<SignedInAdmin> {
  const { email } = await createAdmin(role);
  return signIn(harness, email);
}

/** Wraps an agent so mutating calls carry the Origin and CSRF headers a browser would send. */
export function adminClient(admin: SignedInAdmin) {
  const withHeaders = <T extends { set: (k: string, v: string) => T }>(req: T) =>
    req.set('Origin', ORIGIN).set('X-CSRF-Token', admin.csrf);
  return {
    get: (url: string) => admin.agent.get(url),
    post: (url: string, body?: object) => withHeaders(admin.agent.post(url)).send(body ?? {}),
    put: (url: string, body?: object) => withHeaders(admin.agent.put(url)).send(body ?? {}),
    patch: (url: string, body?: object) => withHeaders(admin.agent.patch(url)).send(body ?? {}),
    delete: (url: string) => withHeaders(admin.agent.delete(url)),
    upload: (url: string) => withHeaders(admin.agent.post(url)),
  };
}

export async function makeTestImage(
  width: number,
  height: number,
  options: { format?: 'jpeg' | 'png' | 'webp'; orientation?: number } = {},
): Promise<Buffer> {
  const image = sharp({
    create: { width, height, channels: 3, background: { r: 184, g: 92, b: 56 } },
  }).composite([
    {
      input: Buffer.from(
        `<svg width="${width}" height="${height}"><rect x="0" y="0" width="${Math.round(width / 3)}" height="${height}" fill="#45352C"/></svg>`,
      ),
    },
  ]);
  const format = options.format ?? 'jpeg';
  let pipeline =
    format === 'png' ? image.png() : format === 'webp' ? image.webp() : image.jpeg({ quality: 90 });
  if (options.orientation) pipeline = pipeline.withMetadata({ orientation: options.orientation });
  return pipeline.toBuffer();
}

/** Creates a fully processed media asset directly (bypassing HTTP) for catalogue tests. */
export async function createReadyAsset(harness: Harness): Promise<string> {
  const asset = await MediaAssetModel.create({
    status: 'processing',
    originalFilename: 'fixture.jpg',
    sourceFormat: 'jpeg',
    sourceBytes: 1,
    sourceWidth: 800,
    sourceHeight: 800,
  });
  const buffer = await makeTestImage(800, 800);
  await harness.ctx.storage.putPrivate(`incoming/${asset.id}.jpg`, buffer, 'image/jpeg');
  asset.incomingKey = `incoming/${asset.id}.jpg`;
  await asset.save();
  await processAsset(harness.ctx, asset.id, { isFinalAttempt: true });
  return asset.id;
}

export async function createPublishedProduct(
  harness: Harness,
  overrides: Partial<{
    name: string;
    price: number;
    salePrice: number | null;
    stock: number;
    trackInventory: boolean;
    availability: 'in_stock' | 'out_of_stock' | 'made_to_order';
    category: mongoose.Types.ObjectId | null;
    variants: {
      name: string;
      price?: number | null;
      salePrice?: number | null;
      stock: number;
      isActive?: boolean;
    }[];
  }> = {},
) {
  const assetId = await createReadyAsset(harness);
  const asset = await MediaAssetModel.findById(assetId).lean();
  const name = overrides.name ?? `Clay Pot ${Math.random().toString(36).slice(2, 7)}`;
  const product = await ProductModel.create({
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    price: overrides.price ?? 1000_00,
    salePrice: overrides.salePrice ?? null,
    stock: overrides.stock ?? 10,
    trackInventory: overrides.trackInventory ?? true,
    availability: overrides.availability ?? 'in_stock',
    category: overrides.category ?? null,
    status: 'published',
    variants: (overrides.variants ?? []).map((variant) => ({
      isActive: true,
      price: null,
      salePrice: null,
      ...variant,
    })),
    images: [
      {
        asset: asset!._id,
        alt: name,
        width: asset!.width!,
        height: asset!.height!,
        placeholder: asset!.placeholder,
        variants: asset!.variants,
      },
    ],
  });
  return product;
}

export async function createCategory(name = `Category ${Math.random().toString(36).slice(2, 7)}`) {
  return CategoryModel.create({
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    isActive: true,
  });
}

export function checkoutBody(
  items: { productId: string; variantId?: string | null; quantity: number }[],
  overrides: object = {},
) {
  return {
    items,
    fulfillment: 'pickup',
    channel: 'whatsapp',
    customer: { name: 'Riya Patel', phone: '98765 43210' },
    ...overrides,
  };
}
