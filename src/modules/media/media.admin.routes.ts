import { Router } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import multer from 'multer';
import { Types, type QueryFilter } from 'mongoose';
import {
  ACCEPTED_IMAGE_MIME_TYPES,
  mediaCropSchema,
  mediaListQuerySchema,
  mediaUpdateSchema,
  objectIdSchema,
} from '@jmh/shared';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { MediaAssetModel, type MediaAsset } from '../../db/models';
import { notFound, validationFailed } from '../../lib/errors';
import { escapeRegex, parseInput } from '../../lib/validate';
import { requirePermission } from '../../middleware/auth';
import type { LimiterFactory } from '../../middleware/rate-limit';
import {
  assetUsage,
  createUpload,
  deleteAsset,
  findOrphanedAssets,
  CLIENT_UPLOAD_PREFIX,
  takeClientUpload,
} from '../../media/media.service';
import { mediaAssetDTO } from '../../media/serialize';
import { audit } from '../audit/audit.service';

export function mediaAdminRoutes(ctx: AppContext, limiter: LimiterFactory): Router {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: ctx.config.media.maxUploadBytes, files: 1, fields: 10, fieldSize: 4096 },
    fileFilter: (_req, file, callback) => {
      // A cheap first gate only; the real check sniffs the bytes in inspectImage().
      if ((ACCEPTED_IMAGE_MIME_TYPES as readonly string[]).includes(file.mimetype))
        callback(null, true);
      else callback(validationFailed({ file: ['Only JPEG, PNG and WebP images are accepted.'] }));
    },
  });
  const uploadLimiter = limiter({
    name: 'media-upload',
    windowMs: 10 * 60_000,
    limit: 120,
    key: (req) =>
      req.admin ? `admin:${req.admin.id.toString()}` : ipKeyGenerator(req.ip ?? 'unknown'),
  });

  // Step 1 of the large-file flow: hands the browser a short-lived token scoped to one pathname,
  // image types and the size cap. The read-write token itself never leaves the server.
  router.post('/blob-token', requirePermission('media:write'), uploadLimiter, async (req, res) => {
    const token = ctx.config.storage.blobToken;
    if (!token) throw validationFailed({ file: ['Direct uploads are not available.'] });
    const result = await handleUpload({
      token,
      request: req,
      body: req.body as HandleUploadBody,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith(CLIENT_UPLOAD_PREFIX) || pathname.includes('..'))
          throw validationFailed({ file: ['Invalid upload path.'] });
        return {
          allowedContentTypes: [...ACCEPTED_IMAGE_MIME_TYPES],
          maximumSizeInBytes: ctx.config.media.maxUploadBytes,
          addRandomSuffix: true,
        };
      },
    });
    res.json(result);
  });

  router.post(
    '/',
    requirePermission('media:write'),
    uploadLimiter,
    upload.single('file'),
    async (req, res) => {
      let buffer: Buffer;
      let originalName: string;
      let rawCrop: unknown = req.body.crop;
      if (req.is('application/json')) {
        // Large file: it already sits in Blob (step 2 of the flow above).
        const input = parseInput(
          z.object({
            blobPathname: z.string().max(300),
            originalName: z.string().max(300),
            crop: mediaCropSchema.nullable().default(null),
          }),
          req.body,
        );
        buffer = await takeClientUpload(ctx, input.blobPathname);
        originalName = input.originalName;
        rawCrop = input.crop;
      } else {
        if (!req.file) throw validationFailed({ file: ['Choose an image to upload.'] });
        buffer = req.file.buffer;
        originalName = req.file.originalname;
        rawCrop = rawCrop ? safeJson(rawCrop) : null;
      }
      const crop = rawCrop ? parseInput(mediaCropSchema, rawCrop) : null;
      const { alt } = parseInput(z.object({ alt: z.string().trim().max(200).default('') }), {
        alt: req.body.alt,
      });
      const asset = await createUpload(ctx, {
        buffer,
        originalName,
        crop,
        alt,
        actorId: req.admin!.id,
      });
      await audit(req, {
        action: 'media.upload',
        entityType: 'media',
        entityId: asset._id.toString(),
        summary: `Uploaded image “${asset.originalFilename}” (${Math.round(asset.sourceBytes / 1024)} KB)`,
      });
      res.status(202).json({ data: mediaAssetDTO(asset, ctx.storage, 0) });
    },
  );

  router.get('/', requirePermission('media:read'), async (req, res) => {
    const query = parseInput(mediaListQuerySchema, req.query);
    const filter: QueryFilter<MediaAsset> = {};
    if (query.status) filter.status = query.status;
    if (query.q) {
      const pattern = new RegExp(escapeRegex(query.q), 'i');
      filter.$or = [{ originalFilename: pattern }, { alt: pattern }];
    }
    if (query.unused) {
      const orphans = await findOrphanedAssets(new Date(), 1000);
      filter._id = { $in: orphans.map((asset) => asset._id) };
    }
    const [items, total] = await Promise.all([
      MediaAssetModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean(),
      MediaAssetModel.countDocuments(filter),
    ]);
    res.json({
      data: items.map((asset) => mediaAssetDTO(asset, ctx.storage)),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    });
  });

  router.get('/:id', requirePermission('media:read'), async (req, res) => {
    const id = parseInput(objectIdSchema, req.params.id);
    const asset = await MediaAssetModel.findById(id).lean();
    if (!asset) throw notFound('Image');
    const usage = await assetUsage(new Types.ObjectId(id));
    res.set('Cache-Control', 'no-store').json({
      data: {
        ...mediaAssetDTO(asset, ctx.storage, usage.products + usage.categories + usage.home),
        usage,
      },
    });
  });

  router.patch('/:id', requirePermission('media:write'), async (req, res) => {
    const id = parseInput(objectIdSchema, req.params.id);
    const input = parseInput(mediaUpdateSchema, req.body);
    const asset = await MediaAssetModel.findByIdAndUpdate(
      id,
      { $set: { alt: input.alt } },
      { returnDocument: 'after' },
    ).lean();
    if (!asset) throw notFound('Image');
    res.json({ data: mediaAssetDTO(asset, ctx.storage) });
  });

  router.delete('/:id', requirePermission('media:write'), async (req, res) => {
    const id = parseInput(objectIdSchema, req.params.id);
    const asset = await deleteAsset(ctx, id);
    await audit(req, {
      action: 'media.delete',
      entityType: 'media',
      entityId: id,
      summary: `Deleted image “${asset.originalFilename}”`,
    });
    res.status(204).end();
  });

  return router;
}

function safeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw validationFailed({ crop: ['Invalid crop data.'] });
  }
}
