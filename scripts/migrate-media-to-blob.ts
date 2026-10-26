/**
 * Copies the processed images in STORAGE_LOCAL_DIR/public to Vercel Blob under the SAME keys, so
 * the database (which stores keys, not URLs) needs no change: only MEDIA_PUBLIC_BASE_URL switches.
 * Never deletes anything, locally or in Blob. Dry run by default.
 *
 *   npm run media:migrate-blob                       # dry run: what would be uploaded
 *   npm run media:migrate-blob -- --check-db         # also compare against the database
 *   npm run media:migrate-blob -- --apply            # upload (skips files already in Blob)
 *   npm run media:migrate-blob -- --verify           # fetch every public URL and compare sizes
 *
 * --apply/--verify need STORAGE_DRIVER=blob, BLOB_READ_WRITE_TOKEN and MEDIA_PUBLIC_BASE_URL.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { connect } from '../src/bootstrap';
import { getConfig } from '../src/config/env';
import { disconnectDatabase } from '../src/db/connection';
import { MediaAssetModel } from '../src/db/models';
import { assertSafeKey, getStorage } from '../src/storage/storage';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const verify = args.has('--verify');
const checkDb = args.has('--check-db');
const CONCURRENCY = 3; // Hobby allows 15 advanced operations per second.
const TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
};

const config = getConfig();
const root = path.join(config.storage.localDir, 'public');

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
    ),
  );
  return nested.flat();
}

async function sameInBlob(url: string, size: number): Promise<boolean> {
  const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
  const length = response.headers.get('content-length');
  return response.ok && (length === null || Number(length) === size);
}

async function inBatches<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += CONCURRENCY)
    await Promise.all(items.slice(i, i + CONCURRENCY).map(work));
}

const files = await fs.readdir(root).then(
  () => walk(root),
  () => {
    console.error(`No local images found: ${root} does not exist.`);
    process.exit(1);
  },
);
const items = (
  await Promise.all(
    files.map(async (file) => ({
      key: path.relative(root, file).split(path.sep).join('/'),
      file,
      size: (await fs.stat(file)).size,
    })),
  )
).filter((item) => {
  const supported = path.extname(item.key).toLowerCase() in TYPES && !item.key.endsWith('.tmp');
  if (!supported) console.warn(`  skipped (unsupported type): ${item.key}`);
  return supported;
});
items.forEach((item) => assertSafeKey(item.key));
const totalBytes = items.reduce((sum, item) => sum + item.size, 0);
console.log(
  `${items.length} local image file(s), ${(totalBytes / 1024 / 1024).toFixed(1)} MB in ${root}`,
);

if (checkDb) {
  await connect(config);
  const assets = await MediaAssetModel.find({ status: 'ready' }).select('variants.key').lean();
  const referenced = new Set(assets.flatMap((asset) => asset.variants.map((v) => v.key)));
  const local = new Set(items.map((item) => item.key));
  const missing = [...referenced].filter((key) => !local.has(key));
  const unreferenced = [...local].filter((key) => !referenced.has(key));
  console.log(
    `Database references ${referenced.size} key(s): ${missing.length} missing locally, ${unreferenced.length} local file(s) not referenced.`,
  );
  missing.slice(0, 20).forEach((key) => console.log(`  missing locally: ${key}`));
  await disconnectDatabase();
}

if (!apply && !verify) {
  console.log(
    `Dry run: --apply would upload up to ${items.length} file(s) (${items.length} Blob advanced operations; Hobby includes 2,000/month and 1 GB storage).`,
  );
  items.slice(0, 10).forEach((item) => console.log(`  ${item.key} (${item.size} B)`));
  if (items.length > 10) console.log(`  … and ${items.length - 10} more`);
  process.exit(0);
}

if (config.storage.driver !== 'blob') {
  console.error('Set STORAGE_DRIVER=blob (with BLOB_READ_WRITE_TOKEN and MEDIA_PUBLIC_BASE_URL).');
  process.exit(1);
}
const storage = getStorage(config);
let failed = 0;
let uploaded = 0;
let skipped = 0;
await inBatches(items, async (item) => {
  const url = storage.publicUrl(item.key);
  try {
    if (apply) {
      if (await sameInBlob(url, item.size)) skipped++;
      else {
        await storage.putPublic(
          item.key,
          await fs.readFile(item.file),
          TYPES[path.extname(item.key).toLowerCase()]!,
        );
        uploaded++;
      }
    }
    // Always confirm the live URL serves the file, so nothing is trusted on upload success alone.
    if (!(await sameInBlob(url, item.size))) throw new Error('live URL missing or size differs');
  } catch (error) {
    failed++;
    console.error(`  FAILED ${item.key}: ${(error as Error).message}`);
  }
});
console.log(
  `${apply ? `Uploaded ${uploaded}, already present ${skipped}. ` : ''}Live check: ${items.length - failed}/${items.length} OK.`,
);
console.log(
  failed
    ? 'Some files failed. Re-run; local files are untouched.'
    : 'All live URLs verified. This script never deletes: remove local files yourself only after checking the site.',
);
process.exit(failed ? 1 : 0);
