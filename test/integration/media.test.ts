import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CategoryModel, MediaAssetModel, ProductModel } from '../../src/db/models';
import {
  adminClient,
  createCategory,
  createHarness,
  createPublishedProduct,
  makeTestImage,
  signedInAs,
  type Harness,
} from '../helpers/harness';

let harness: Harness;
let pm: ReturnType<typeof adminClient>;
beforeAll(async () => {
  harness = await createHarness();
  pm = adminClient(await signedInAs(harness, 'product_manager'));
});
afterAll(async () => {
  await harness.close();
});

async function waitUntilProcessed(id: string) {
  for (let i = 0; i < 100; i++) {
    const response = await pm.get(`/api/v1/admin/media/${id}`);
    if (response.body.data.status !== 'processing') return response.body.data;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('image was not processed in time');
}

function publicFile(url: string) {
  const key = new URL(url).pathname.replace(/^\/media\//, '');
  return path.join(process.env.STORAGE_LOCAL_DIR!, 'public', key);
}

describe('image upload pipeline', () => {
  it('crops, auto-orients, resizes into WebP variants and strips metadata', async () => {
    // 1600×1200 stored sideways (EXIF orientation 6) → displayed as 1200×1600.
    const source = await makeTestImage(1600, 1200, { orientation: 6 });
    const upload = await pm
      .upload('/api/v1/admin/media')
      .field('alt', 'Terracotta matka')
      .field('crop', JSON.stringify({ x: 0, y: 200, width: 1200, height: 1200, rotation: 0 }))
      .attach('file', source, { filename: 'matka.jpg', contentType: 'image/jpeg' });
    expect(upload.status).toBe(202);
    expect(upload.body.data).toMatchObject({
      status: 'processing',
      sourceWidth: 1200,
      sourceHeight: 1600,
    });

    const asset = await waitUntilProcessed(upload.body.data.id);
    expect(asset.status).toBe('ready');
    expect(asset.width).toBe(1200);
    expect(asset.height).toBe(1200);
    expect(asset.variants.map((v: { name: string; width: number }) => [v.name, v.width])).toEqual([
      ['thumb', 240],
      ['card', 560],
      ['standard', 1080],
      ['large', 1200],
    ]);
    expect(asset.placeholder).toMatch(/^data:image\/webp;base64,/);

    for (const variant of asset.variants) {
      const meta = await sharp(publicFile(variant.url)).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.width).toBe(variant.width);
      expect(meta.height).toBe(variant.height);
      expect(meta.exif).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
    }
    // The incoming original is removed after processing (originals are not retained by default).
    const stored = await MediaAssetModel.findById(asset.id).lean();
    expect(stored?.incomingKey).toBeNull();
    expect(stored?.originalKey).toBeNull();
  });

  it('never upscales small images and keeps their aspect ratio', async () => {
    const upload = await pm
      .upload('/api/v1/admin/media')
      .attach('file', await makeTestImage(500, 300, { format: 'png' }), {
        filename: 'small.png',
        contentType: 'image/png',
      });
    const asset = await waitUntilProcessed(upload.body.data.id);
    expect(
      asset.variants.map((v: { width: number; height: number }) => [v.width, v.height]),
    ).toEqual([
      [240, 144],
      [500, 300],
    ]);
  });

  it('applies rotation from the crop editor', async () => {
    const upload = await pm
      .upload('/api/v1/admin/media')
      .field('crop', JSON.stringify({ x: 0, y: 0, width: 600, height: 800, rotation: 90 }))
      .attach('file', await makeTestImage(800, 600, { format: 'webp' }), {
        filename: 'r.webp',
        contentType: 'image/webp',
      });
    const asset = await waitUntilProcessed(upload.body.data.id);
    expect([asset.width, asset.height]).toEqual([600, 800]);
  });

  it('rejects files that are not really images, even with an image name and type', async () => {
    const fake = Buffer.from('<?php echo "not an image"; ?>');
    const response = await pm
      .upload('/api/v1/admin/media')
      .attach('file', fake, { filename: 'pot.jpg', contentType: 'image/jpeg' });
    expect(response.status).toBe(400);
    expect(response.body.error.fields.file[0]).toMatch(/JPEG, PNG and WebP/);
  });

  it('rejects SVG and GIF uploads and tiny images', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"></svg>',
    );
    expect(
      (
        await pm
          .upload('/api/v1/admin/media')
          .attach('file', svg, { filename: 'x.svg', contentType: 'image/svg+xml' })
      ).status,
    ).toBe(400);
    const gif = await sharp({
      create: { width: 400, height: 400, channels: 3, background: '#b85c38' },
    })
      .gif()
      .toBuffer();
    expect(
      (
        await pm
          .upload('/api/v1/admin/media')
          .attach('file', gif, { filename: 'x.jpg', contentType: 'image/jpeg' })
      ).status,
    ).toBe(400);
    const tiny = await makeTestImage(50, 50);
    const response = await pm
      .upload('/api/v1/admin/media')
      .attach('file', tiny, { filename: 'tiny.jpg', contentType: 'image/jpeg' });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/at least/);
  });

  it('rejects oversized uploads', async () => {
    const huge = Buffer.alloc(harness.ctx.config.media.maxUploadBytes + 1024, 0xff);
    huge[0] = 0xff;
    huge[1] = 0xd8;
    huge[2] = 0xff;
    const response = await pm
      .upload('/api/v1/admin/media')
      .attach('file', huge, { filename: 'huge.jpg', contentType: 'image/jpeg' });
    expect(response.status).toBe(413);
  });

  it('refuses to delete an image that a product uses, then deletes it with its files', async () => {
    const upload = await pm
      .upload('/api/v1/admin/media')
      .attach('file', await makeTestImage(900, 900), {
        filename: 'used.jpg',
        contentType: 'image/jpeg',
      });
    const asset = await waitUntilProcessed(upload.body.data.id);
    const product = await pm.post('/api/v1/admin/products', {
      name: 'Uses Image',
      price: 100_00,
      images: [{ assetId: asset.id, alt: '' }],
    });
    expect(product.status).toBe(201);

    const blocked = await pm.delete(`/api/v1/admin/media/${asset.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('MEDIA_IN_USE');

    await pm.delete(`/api/v1/admin/products/${product.body.data.id}`);
    expect((await pm.delete(`/api/v1/admin/media/${asset.id}`)).status).toBe(204);
    await expect(fs.access(publicFile(asset.variants[0].url))).rejects.toThrow();
  });

  it('does not let products reference images that are not ready', async () => {
    const processing = await MediaAssetModel.create({
      status: 'processing',
      originalFilename: 'x.jpg',
    });
    const response = await pm.post('/api/v1/admin/products', {
      name: 'Broken',
      price: 100_00,
      images: [{ assetId: processing.id, alt: '' }],
    });
    expect(response.status).toBe(400);
    expect(response.body.error.fields['images.0'][0]).toMatch(/still processing/);
  });

  it('requires media permissions to upload', async () => {
    const om = adminClient(await signedInAs(harness, 'order_manager'));
    const response = await om
      .upload('/api/v1/admin/media')
      .attach('file', await makeTestImage(400, 400), {
        filename: 'a.jpg',
        contentType: 'image/jpeg',
      });
    expect(response.status).toBe(403);
  });

  describe('replacing and re-cropping an image in place', () => {
    async function uploadReady(width = 1600, height = 1200) {
      const upload = await pm
        .upload('/api/v1/admin/media')
        .field('alt', 'Original pot')
        .attach('file', await makeTestImage(width, height), {
          filename: 'pot.jpg',
          contentType: 'image/jpeg',
        });
      return waitUntilProcessed(upload.body.data.id);
    }

    function fileOnDisk(key: string) {
      return path.join(process.env.STORAGE_LOCAL_DIR!, 'public', key);
    }

    it('re-crops the same record: new revision, refs updated everywhere, old files kept', async () => {
      const product = await createPublishedProduct(harness);
      const assetId = product.images[0]!.asset.toString();
      const category = await createCategory();
      const before = (await MediaAssetModel.findById(assetId).lean())!;
      await CategoryModel.updateOne(
        { _id: category._id },
        {
          $set: {
            image: {
              asset: before._id,
              alt: 'cat',
              width: before.width,
              height: before.height,
              placeholder: before.placeholder,
              variants: before.variants,
            },
          },
        },
      );
      const productVersion = (await ProductModel.findById(product._id).lean())!.updatedAt;

      const response = await pm.post(`/api/v1/admin/media/${assetId}/recrop`, {
        crop: { x: 100, y: 50, width: 400, height: 400, rotation: 0 },
      });
      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        id: assetId,
        status: 'ready',
        width: 400,
        height: 400,
      });

      const after = (await MediaAssetModel.findById(assetId).lean())!;
      expect(after.revision).toBe(1);
      for (const variant of after.variants) {
        expect(variant.key.startsWith(`img/${assetId}/r1/`)).toBe(true);
        await fs.access(fileOnDisk(variant.key));
      }
      // The previous files are not deleted: old order snapshots and cached pages keep working.
      for (const variant of before.variants) await fs.access(fileOnDisk(variant.key));

      const updatedProduct = (await ProductModel.findById(product._id).lean())!;
      expect(updatedProduct.images[0]!.variants.map((v) => v.key)).toEqual(
        after.variants.map((v) => v.key),
      );
      expect(updatedProduct.images[0]!.width).toBe(400);
      // Editing a product form open elsewhere must not hit a version conflict.
      expect(updatedProduct.updatedAt.getTime()).toBe(productVersion.getTime());
      const updatedCategory = (await CategoryModel.findById(category._id).lean())!;
      expect(updatedCategory.image!.variants.map((v) => v.key)).toEqual(
        after.variants.map((v) => v.key),
      );
    });

    it('replaces the picture with a new upload and applies rotation and alt text', async () => {
      const original = await uploadReady();
      const response = await pm
        .upload(`/api/v1/admin/media/${original.id}/replace`)
        .field('alt', 'Replacement')
        .field('crop', JSON.stringify({ x: 0, y: 0, width: 600, height: 800, rotation: 90 }))
        .attach('file', await makeTestImage(800, 600), {
          filename: 'new.jpg',
          contentType: 'image/jpeg',
        });
      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        id: original.id,
        alt: 'Replacement',
        width: 600,
        height: 800,
        sourceWidth: 800,
      });
      const sizes = response.body.data.variants.map((v: { name: string; width: number }) => v.name);
      expect(sizes).toEqual(['thumb', 'card', 'standard']);
    });

    it('leaves the image untouched when the new file is invalid or storage fails', async () => {
      const original = await uploadReady();
      const url = `/api/v1/admin/media/${original.id}/replace`;
      const notImage = await pm.upload(url).attach('file', Buffer.from('not an image at all'), {
        filename: 'x.jpg',
        contentType: 'image/jpeg',
      });
      expect(notImage.status).toBe(400);
      const tiny = await pm.upload(url).attach('file', await makeTestImage(100, 100), {
        filename: 't.jpg',
        contentType: 'image/jpeg',
      });
      expect(tiny.status).toBe(400);

      const real = harness.ctx.storage.putPublic.bind(harness.ctx.storage);
      let calls = 0;
      harness.ctx.storage.putPublic = async (...args) => {
        if (++calls === 2) throw new Error('storage down');
        return real(...args);
      };
      const failed = await pm.upload(url).attach('file', await makeTestImage(900, 900), {
        filename: 'f.jpg',
        contentType: 'image/jpeg',
      });
      harness.ctx.storage.putPublic = real;
      expect(failed.status).toBe(502);

      const after = (await MediaAssetModel.findById(original.id).lean())!;
      expect(after.revision).toBe(0);
      expect(after.variants.map((v) => v.key)).toEqual(
        original.variants.map((v: { url: string }) =>
          new URL(v.url).pathname.replace(/^\/media\//, ''),
        ),
      );
      // The half-written first file was cleaned up.
      await expect(fs.access(fileOnDisk(`img/${original.id}/r1/thumb-240.webp`))).rejects.toThrow();
    });

    it('blocks image writes when local-disk storage is paired with a remote database', async () => {
      const original = await uploadReady();
      harness.ctx.config.mongo.isLocal = false;
      try {
        const file = { filename: 'a.jpg', contentType: 'image/jpeg' };
        const replace = await pm
          .upload(`/api/v1/admin/media/${original.id}/replace`)
          .attach('file', await makeTestImage(800, 600), file);
        const recrop = await pm.post(`/api/v1/admin/media/${original.id}/recrop`, {});
        const create = await pm
          .upload('/api/v1/admin/media')
          .attach('file', await makeTestImage(800, 600), file);
        for (const response of [replace, recrop, create]) {
          expect(response.status).toBe(409);
          expect(response.body.error.code).toBe('STORAGE_MISMATCH');
        }
        // Nothing changed.
        expect((await MediaAssetModel.findById(original.id).lean())!.revision).toBe(0);
      } finally {
        harness.ctx.config.mongo.isLocal = true;
      }
    });

    it('rejects unknown images, tiny crops, and callers without media permission', async () => {
      const original = await uploadReady();
      expect(
        (await pm.post('/api/v1/admin/media/6a0000000000000000000000/recrop', {})).status,
      ).toBe(404);
      const tiny = await pm.post(`/api/v1/admin/media/${original.id}/recrop`, {
        crop: { x: 0, y: 0, width: 50, height: 50, rotation: 0 },
      });
      expect(tiny.status).toBe(400);
      const orders = adminClient(await signedInAs(harness, 'order_manager'));
      expect((await orders.post(`/api/v1/admin/media/${original.id}/recrop`, {})).status).toBe(403);
      expect(
        (
          await orders
            .upload(`/api/v1/admin/media/${original.id}/replace`)
            .attach('file', await makeTestImage(800, 600), {
              filename: 'a.jpg',
              contentType: 'image/jpeg',
            })
        ).status,
      ).toBe(403);
      const anonymous = await harness
        .request()
        .post(`/api/v1/admin/media/${original.id}/recrop`)
        .set('Origin', 'http://localhost:3000')
        .send({});
      expect(anonymous.status).toBe(401);
    });
  });
});
