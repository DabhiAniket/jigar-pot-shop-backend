# Image upload, crop and WebP pipeline

## Flow

1. **Admin UI** (`components/admin/image-uploader.tsx`): pick or drop a JPEG/PNG/WebP (≤15 MB,
   ≥200×200), crop with zoom, free rotation, 90° buttons, aspect presets (1:1, 4:5, 3:4, 16:9,
   original) and reset. The crop area is keyboard-movable and every control is labelled. A canvas
   preview shows exactly what the server will produce. Alt text is required-by-convention.
2. **Upload** (`POST /api/v1/admin/media`, multipart, progress via XHR): the API sniffs magic bytes,
   probes with libvips (`failOn: error`, 60 MP limit), checks the format matches, validates and
   clamps the crop, stores the original in **private** storage (`incoming/<id>.<ext>`), creates a
   `processing` MediaAsset and enqueues a job. Responds `202`.
3. **Worker** (`media.service.processAsset`): EXIF auto-orient → user rotation → crop → one bounded
   decode into a raw master (≤1800 px wide, ≤2400 px tall, sRGB) → WebP variants. Metadata
   (EXIF/GPS) is stripped. Images are never upscaled or distorted; widths larger than the source are
   skipped. A 32 px blurred placeholder is embedded as a data URL.
4. The UI polls `GET /admin/media/:id` until `ready` and attaches the asset to the product.
   Products store a snapshot of the variant keys, so storefront reads need no joins.

## Variants

| Name       | Width | Use                         | Quality                   |
| ---------- | ----- | --------------------------- | ------------------------- |
| `thumb`    | 240   | admin tables, cart lines    | q−4, light sharpen        |
| `card`     | 560   | product cards               | q−4, light sharpen        |
| `standard` | 1080  | product page                | `MEDIA_WEBP_QUALITY` (82) |
| `large`    | 1800  | gallery / zoom / Open Graph | `MEDIA_WEBP_QUALITY`      |

WebP uses `smartSubsample` to keep terracotta reds and painted-pattern edges crisp. Keys are
`img/<assetId>/<variant>-<width>.webp`; asset ids never repeat, so files are served with
`Cache-Control: public, max-age=31536000, immutable`.

## Storage

| Area    | Local (development)                           | S3-compatible (production)            | Exposure     |
| ------- | --------------------------------------------- | ------------------------------------- | ------------ |
| public  | `STORAGE_LOCAL_DIR/public` served at `/media` | `s3://BUCKET/public/…` behind the CDN | public       |
| private | `STORAGE_LOCAL_DIR/private`                   | `s3://BUCKET/private/…`               | never public |

`MEDIA_PUBLIC_BASE_URL` is the CDN origin for `public/` (e.g. CloudFront/Cloudflare with origin
path `/public`). Credentials stay on the server (`S3_*` or an IAM role). Add a bucket lifecycle
rule expiring `private/incoming/` after 2 days as a safety net.

**Originals**: deleted after processing unless `MEDIA_KEEP_ORIGINALS=true`, in which case one copy
is kept under `private/originals/` (useful for re-processing at new sizes later).

## Failure handling

- Validation failures (corrupt/unsupported/too large) fail permanently with a clear message.
- Transient failures retry 3× with exponential backoff (BullMQ). Partially written variants are
  removed. Uploads interrupted by a restart are re-queued by a sweep every 5 minutes (or marked
  failed after the retry budget).
- Processing is idempotent: a second run on a ready asset is a no-op, and a race between two runs
  keeps exactly one set of files.

## Deleting and cleanup

- An image used by any product, category or the homepage cannot be deleted (`409 MEDIA_IN_USE`).
- Replacing an image leaves the old asset unreferenced. `npm run media:cleanup -- --days 30`
  lists unreferenced images older than 30 days; add `--apply` to delete them (it re-checks usage
  for each image before deleting).

## Replacing the demo renders and adding a hero video

Upload real product photos through Admin → Products. The homepage hero image and an optional
background video (`mp4`/`webm` URL + poster, e.g. a short, muted, compressed clip on the CDN) are
set in Admin → Homepage. The cinematic scroll sequence uses `public/story/v1/` in the frontend repository
(generated there by `node scripts/build-story-assets.mjs <renders>`); a real filmed turntable can be
exported as numbered frames and converted with the same script.
