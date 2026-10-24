import type { ImageDTO, MediaAssetDTO } from '@jmh/shared';
import type { ImageRef, MediaAsset } from '../db/models';
import type { Storage } from '../storage/storage';

export function imageDTO(ref: ImageRef | null | undefined, storage: Storage): ImageDTO | null {
  if (!ref || ref.variants.length === 0) return null;
  return {
    assetId: ref.asset.toString(),
    alt: ref.alt,
    width: ref.width,
    height: ref.height,
    placeholder: ref.placeholder,
    variants: ref.variants.map((variant) => ({
      name: variant.name,
      url: storage.publicUrl(variant.key),
      width: variant.width,
      height: variant.height,
    })),
  };
}

/** Smallest variant URL, for admin tables and order line thumbnails. */
export function thumbnailUrl(ref: ImageRef | null | undefined, storage: Storage): string | null {
  const variant = ref?.variants[0];
  return variant ? storage.publicUrl(variant.key) : null;
}

export function mediaAssetDTO(
  asset: MediaAsset,
  storage: Storage,
  usageCount: number | null = null,
): MediaAssetDTO {
  return {
    id: asset._id.toString(),
    status: asset.status,
    alt: asset.alt,
    originalFilename: asset.originalFilename,
    sourceFormat: asset.sourceFormat,
    sourceBytes: asset.sourceBytes,
    sourceWidth: asset.sourceWidth,
    sourceHeight: asset.sourceHeight,
    width: asset.width,
    height: asset.height,
    totalBytes: asset.totalBytes,
    placeholder: asset.placeholder,
    variants: asset.variants.map((variant) => ({
      name: variant.name,
      url: storage.publicUrl(variant.key),
      width: variant.width,
      height: variant.height,
      bytes: variant.bytes,
    })),
    error: asset.error,
    usageCount,
    createdAt: asset.createdAt.toISOString(),
  };
}
