import sharp, { type Metadata } from 'sharp';
import {
  IMAGE_VARIANTS,
  IMAGE_VARIANT_WIDTHS,
  type ImageVariantName,
  type MediaCrop,
} from '@jmh/shared';

export const ALLOWED_FORMATS = ['jpeg', 'png', 'webp'] as const;
export type AllowedFormat = (typeof ALLOWED_FORMATS)[number];

export const MIN_SOURCE_DIMENSION = 200;
/** Variants are fitted inside this box; very tall crops are bounded by height. */
const MAX_OUTPUT_HEIGHT_RATIO = 4 / 3;

export class ImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageValidationError';
  }
}

/** Sniffs the real file type from its first bytes; the extension and MIME type are never trusted. */
export function detectFormat(buffer: Buffer): AllowedFormat | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return 'jpeg';
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

export interface InspectedImage {
  format: AllowedFormat;
  /** Dimensions after applying EXIF orientation — what the admin saw in the crop editor. */
  width: number;
  height: number;
  hasAlpha: boolean;
}

export async function inspectImage(
  buffer: Buffer,
  maxInputPixels: number,
): Promise<InspectedImage> {
  const sniffed = detectFormat(buffer);
  if (!sniffed) throw new ImageValidationError('Only JPEG, PNG and WebP images are accepted.');

  let metadata: Metadata;
  try {
    metadata = await sharp(buffer, {
      limitInputPixels: maxInputPixels,
      failOn: 'error',
    }).metadata();
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/pixel limit/i.test(message)) {
      throw new ImageValidationError(
        'Image dimensions are too large. Please resize it below 60 megapixels.',
      );
    }
    throw new ImageValidationError('The file is not a readable image.');
  }

  if (metadata.format !== sniffed) {
    throw new ImageValidationError('The image content does not match its format.');
  }
  const width = metadata.autoOrient?.width ?? metadata.width;
  const height = metadata.autoOrient?.height ?? metadata.height;
  if (!width || !height) throw new ImageValidationError('Could not read the image dimensions.');
  if (width * height > maxInputPixels) {
    throw new ImageValidationError(
      'Image dimensions are too large. Please resize it below 60 megapixels.',
    );
  }
  if (width < MIN_SOURCE_DIMENSION || height < MIN_SOURCE_DIMENSION) {
    throw new ImageValidationError(
      `Images must be at least ${MIN_SOURCE_DIMENSION}×${MIN_SOURCE_DIMENSION} pixels.`,
    );
  }
  return { format: sniffed, width, height, hasAlpha: Boolean(metadata.hasAlpha) };
}

/** Size of the image's bounding box after an arbitrary rotation (matches the crop editor). */
export function rotatedSize(
  width: number,
  height: number,
  rotation: number,
): { width: number; height: number } {
  const radians = (Math.abs(rotation % 360) * Math.PI) / 180;
  const sin = Math.abs(Math.sin(radians));
  const cos = Math.abs(Math.cos(radians));
  return {
    width: Math.round(width * cos + height * sin),
    height: Math.round(width * sin + height * cos),
  };
}

/** Clamps a crop rectangle to the rotated image bounds; rejects degenerate crops. */
export function normalizeCrop(
  crop: MediaCrop | null,
  image: { width: number; height: number },
): MediaCrop | null {
  if (!crop) return null;
  const rotation = ((crop.rotation % 360) + 360) % 360;
  const bounds = rotatedSize(image.width, image.height, rotation);
  // Arbitrary-angle rotation can make libvips' canvas a pixel smaller than the maths says.
  const margin = rotation % 90 === 0 ? 0 : 2;
  const x = Math.min(Math.max(0, crop.x), bounds.width - 1);
  const y = Math.min(Math.max(0, crop.y), bounds.height - 1);
  const width = Math.min(crop.width, bounds.width - x - margin);
  const height = Math.min(crop.height, bounds.height - y - margin);
  if (width < MIN_SOURCE_DIMENSION / 2 || height < MIN_SOURCE_DIMENSION / 2) {
    throw new ImageValidationError('The selected crop area is too small.');
  }
  const isFullImage =
    rotation === 0 && x === 0 && y === 0 && width === bounds.width && height === bounds.height;
  return isFullImage ? null : { x, y, width, height, rotation };
}

export interface ProcessedVariant {
  name: ImageVariantName;
  width: number;
  height: number;
  buffer: Buffer;
}

export interface ProcessedImage {
  width: number;
  height: number;
  variants: ProcessedVariant[];
  placeholder: string;
}

export interface ProcessOptions {
  quality: number;
  maxInputPixels: number;
}

/**
 * Orientation → user rotation → crop → bounded master → WebP variants.
 * Never upscales, never distorts (aspect ratio is always preserved) and strips all metadata.
 */
export async function processImage(
  buffer: Buffer,
  crop: MediaCrop | null,
  options: ProcessOptions,
): Promise<ProcessedImage> {
  const inspected = await inspectImage(buffer, options.maxInputPixels);
  const normalized = normalizeCrop(crop, inspected);

  let pipeline = sharp(buffer, {
    limitInputPixels: options.maxInputPixels,
    failOn: 'error',
  }).autoOrient();
  if (normalized?.rotation) {
    pipeline = pipeline.rotate(normalized.rotation, {
      background: { r: 246, g: 240, b: 229, alpha: 1 },
    });
  }
  if (normalized) {
    pipeline = pipeline.extract({
      left: normalized.x,
      top: normalized.y,
      width: normalized.width,
      height: normalized.height,
    });
  }

  // One decode into a bounded raw master; every variant is derived from it.
  const largest = IMAGE_VARIANT_WIDTHS.large;
  const master = await pipeline
    .resize({
      width: largest,
      height: Math.round(largest * MAX_OUTPUT_HEIGHT_RATIO),
      fit: 'inside',
      withoutEnlargement: true,
    })
    .toColorspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width: masterWidth, height: masterHeight, channels } = master.info;
  const fromMaster = () =>
    sharp(master.data, { raw: { width: masterWidth, height: masterHeight, channels } });

  const variants: ProcessedVariant[] = [];
  let previousWidth = 0;
  for (const name of IMAGE_VARIANTS) {
    const targetWidth = Math.min(IMAGE_VARIANT_WIDTHS[name], masterWidth);
    if (targetWidth <= previousWidth) continue;
    previousWidth = targetWidth;
    const small = name === 'thumb' || name === 'card';
    let variantPipeline = fromMaster().resize({ width: targetWidth, withoutEnlargement: true });
    if (small) variantPipeline = variantPipeline.sharpen({ sigma: 0.5 });
    const output = await variantPipeline
      .webp({
        quality: small ? Math.max(50, options.quality - 4) : options.quality,
        effort: 5,
        smartSubsample: true,
      })
      .toBuffer({ resolveWithObject: true });
    variants.push({
      name,
      width: output.info.width,
      height: output.info.height,
      buffer: output.data,
    });
  }

  // Pre-blurred and encoded without chroma subsampling: tiny images otherwise show colour fringes
  // when the browser scales them up as a loading placeholder.
  const placeholderBuffer = await fromMaster()
    .resize({ width: 32 })
    .blur(1.2)
    .webp({ quality: 70, effort: 4, smartSubsample: true })
    .toBuffer();

  return {
    width: masterWidth,
    height: masterHeight,
    variants,
    placeholder: `data:image/webp;base64,${placeholderBuffer.toString('base64')}`,
  };
}

/** Bound libvips memory/threads; call once per process that processes images. */
export function configureSharp(concurrency: number): void {
  sharp.cache({ memory: 64, files: 0, items: 50 });
  sharp.concurrency(Math.max(1, concurrency));
}
