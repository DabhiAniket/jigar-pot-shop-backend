import path from 'node:path';
import { Types } from 'mongoose';
import type { MediaCrop } from '@jmh/shared';
import type { AppContext } from '../context';
import {
  CategoryModel,
  HomeContentModel,
  MediaAssetModel,
  ProductModel,
  type ImageRef,
  type MediaAsset,
} from '../db/models';
import { conflict, notFound, validationFailed } from '../lib/errors';
import { logger } from '../lib/logger';
import {
  ImageValidationError,
  inspectImage,
  normalizeCrop,
  processImage,
  type AllowedFormat,
} from './image-processor';

const EXTENSIONS: Record<AllowedFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' };
const MIME_TYPES: Record<AllowedFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};
export const STUCK_AFTER_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;

export function sanitizeFilename(name: string): string {
  const base = path.basename(name).normalize('NFKC');
  return base.replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(0, 120) || 'upload';
}

export async function createUpload(
  ctx: AppContext,
  input: {
    buffer: Buffer;
    originalName: string;
    crop: MediaCrop | null;
    alt: string;
    actorId: Types.ObjectId | null;
  },
): Promise<MediaAsset> {
  let inspected;
  let crop;
  try {
    inspected = await inspectImage(input.buffer, ctx.config.media.maxInputPixels);
    crop = normalizeCrop(input.crop, inspected);
  } catch (error) {
    if (error instanceof ImageValidationError)
      throw validationFailed({ file: [error.message] }, error.message);
    throw error;
  }

  const asset = await MediaAssetModel.create({
    status: 'processing',
    alt: input.alt,
    originalFilename: sanitizeFilename(input.originalName),
    sourceFormat: inspected.format,
    sourceBytes: input.buffer.length,
    sourceWidth: inspected.width,
    sourceHeight: inspected.height,
    crop,
    createdBy: input.actorId,
  });

  const incomingKey = `incoming/${asset._id.toString()}.${EXTENSIONS[inspected.format]}`;
  try {
    await ctx.storage.putPrivate(incomingKey, input.buffer, MIME_TYPES[inspected.format]);
    asset.incomingKey = incomingKey;
    await asset.save();
    await ctx.jobs.enqueue('media.process', { assetId: asset._id.toString() });
  } catch (error) {
    logger.error({ err: (error as Error).message, assetId: asset.id }, 'failed to queue upload');
    asset.status = 'failed';
    asset.error = 'The upload could not be stored. Please try again.';
    await asset.save();
    await ctx.storage.deletePrivate([incomingKey]).catch(() => undefined);
  }
  return asset.toObject();
}

/** Job handler: converts the stored original into WebP variants. Safe to run more than once. */
export async function processAsset(
  ctx: AppContext,
  assetId: string,
  options: { isFinalAttempt: boolean },
): Promise<void> {
  const asset = await MediaAssetModel.findById(assetId).lean();
  if (!asset || asset.status !== 'processing') return;
  if (!asset.incomingKey) {
    await markFailed(asset._id, 'The original upload is missing. Please upload the image again.');
    return;
  }
  await MediaAssetModel.updateOne({ _id: asset._id }, { $inc: { attempts: 1 } });

  const uploadedKeys: string[] = [];
  try {
    const source = await ctx.storage.getPrivate(asset.incomingKey);
    const result = await processImage(source, asset.crop, {
      quality: ctx.config.media.webpQuality,
      maxInputPixels: ctx.config.media.maxInputPixels,
    });

    const variants = [];
    for (const variant of result.variants) {
      const key = `img/${asset._id.toString()}/${variant.name}-${variant.width}.webp`;
      await ctx.storage.putPublic(key, variant.buffer, 'image/webp');
      uploadedKeys.push(key);
      variants.push({
        name: variant.name,
        key,
        width: variant.width,
        height: variant.height,
        bytes: variant.buffer.length,
      });
    }

    let originalKey: string | null = null;
    if (ctx.config.media.keepOriginals && asset.sourceFormat) {
      const format = asset.sourceFormat as AllowedFormat;
      originalKey = `originals/${asset._id.toString()}.${EXTENSIONS[format]}`;
      await ctx.storage.putPrivate(originalKey, source, MIME_TYPES[format]);
    }

    const updated = await MediaAssetModel.updateOne(
      { _id: asset._id, status: 'processing' },
      {
        $set: {
          status: 'ready',
          variants,
          width: result.width,
          height: result.height,
          placeholder: result.placeholder,
          totalBytes: variants.reduce((sum, variant) => sum + variant.bytes, 0),
          processedAt: new Date(),
          error: null,
          incomingKey: null,
          originalKey,
        },
      },
    );
    if (updated.modifiedCount === 0) {
      // Another attempt finished first (or the asset was deleted): discard our copies.
      await ctx.storage.deletePublic(uploadedKeys);
      return;
    }
    await ctx.storage
      .deletePrivate([asset.incomingKey])
      .catch((error: Error) =>
        logger.warn({ err: error.message, assetId }, 'could not delete incoming original'),
      );
    logger.info({ assetId, variants: variants.length }, 'image processed');
  } catch (error) {
    await ctx.storage.deletePublic(uploadedKeys).catch(() => undefined);
    const permanent = error instanceof ImageValidationError;
    if (permanent || options.isFinalAttempt) {
      await markFailed(
        asset._id,
        permanent ? (error as Error).message : 'Image processing failed. Please try again.',
      );
      await ctx.storage.deletePrivate([asset.incomingKey]).catch(() => undefined);
      return;
    }
    throw error;
  }
}

async function markFailed(id: Types.ObjectId, message: string): Promise<void> {
  await MediaAssetModel.updateOne(
    { _id: id, status: 'processing' },
    { $set: { status: 'failed', error: message } },
  );
}

/** Re-queues uploads interrupted by a restart; gives up after the retry budget. */
export async function recoverStuckAssets(ctx: AppContext): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_AFTER_MS);
  const stuck = await MediaAssetModel.find({ status: 'processing', updatedAt: { $lt: cutoff } })
    .select('_id attempts')
    .limit(100)
    .lean();
  for (const asset of stuck) {
    if (asset.attempts >= MAX_ATTEMPTS) {
      await markFailed(
        asset._id,
        'Image processing did not complete. Please upload the image again.',
      );
    } else {
      await MediaAssetModel.updateOne({ _id: asset._id }, { $set: { updatedAt: new Date() } });
      await ctx.jobs.enqueue('media.process', { assetId: asset._id.toString() });
    }
  }
  if (stuck.length) logger.info({ count: stuck.length }, 'recovered stuck media assets');
  return stuck.length;
}

export async function assetUsage(
  assetId: Types.ObjectId,
): Promise<{ products: number; categories: number; home: number }> {
  const [products, categories, home] = await Promise.all([
    ProductModel.countDocuments({ 'images.asset': assetId }),
    CategoryModel.countDocuments({ 'image.asset': assetId }),
    HomeContentModel.countDocuments({ 'hero.image.asset': assetId }),
  ]);
  return { products, categories, home };
}

export async function deleteAsset(ctx: AppContext, assetId: string): Promise<MediaAsset> {
  const asset = await MediaAssetModel.findById(assetId).lean();
  if (!asset) throw notFound('Image');
  const usage = await assetUsage(asset._id);
  const total = usage.products + usage.categories + usage.home;
  if (total > 0) {
    throw conflict(
      `This image is still used by ${usage.products} product(s), ${usage.categories} categor${usage.categories === 1 ? 'y' : 'ies'} and ${usage.home} homepage section(s). Remove it there first.`,
      'MEDIA_IN_USE',
    );
  }
  await MediaAssetModel.deleteOne({ _id: asset._id });
  await ctx.storage.deletePublic(asset.variants.map((variant) => variant.key));
  await ctx.storage.deletePrivate(
    [asset.incomingKey, asset.originalKey].filter((key): key is string => Boolean(key)),
  );
  return asset;
}

/**
 * Turns `{ assetId, alt }` inputs into denormalised image references.
 * Every referenced asset must exist and be fully processed, so pages never show broken images.
 */
export async function resolveImageRefs(
  inputs: readonly { assetId: string; alt: string }[],
  fieldPath = 'images',
): Promise<ImageRef[]> {
  if (inputs.length === 0) return [];
  const ids = inputs.map((input) => new Types.ObjectId(input.assetId));
  const assets = await MediaAssetModel.find({ _id: { $in: ids } }).lean();
  const byId = new Map(assets.map((asset) => [asset._id.toString(), asset]));
  const errors: Record<string, string[]> = {};
  const refs: ImageRef[] = [];
  inputs.forEach((input, index) => {
    const asset = byId.get(input.assetId);
    if (!asset || asset.status !== 'ready' || !asset.width || !asset.height) {
      errors[`${fieldPath}.${index}`] = [
        asset?.status === 'processing'
          ? 'This image is still processing.'
          : 'This image is not available.',
      ];
      return;
    }
    refs.push({
      asset: asset._id,
      alt: input.alt || asset.alt,
      width: asset.width,
      height: asset.height,
      placeholder: asset.placeholder,
      variants: asset.variants,
    });
  });
  if (Object.keys(errors).length) throw validationFailed(errors);
  return refs;
}

/** Unreferenced, processed assets older than the cutoff (candidates for cleanup). */
export async function findOrphanedAssets(olderThan: Date, limit = 500): Promise<MediaAsset[]> {
  const candidates = await MediaAssetModel.find({
    createdAt: { $lt: olderThan },
    status: { $in: ['ready', 'failed'] },
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();
  const orphans: MediaAsset[] = [];
  for (const asset of candidates) {
    const usage = await assetUsage(asset._id);
    if (usage.products + usage.categories + usage.home === 0) orphans.push(asset);
  }
  return orphans;
}
