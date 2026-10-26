/**
 * Removes images that no product, category or homepage section references.
 * Dry run by default; pass --apply to delete. Only touches assets older than --days (default 30)
 * so images uploaded for a product that is still being edited are never removed.
 *
 *   npm run media:cleanup -- --days 30            # report
 *   npm run media:cleanup -- --days 30 --apply    # delete
 */
import { del, list } from '@vercel/blob';
import { connect, createContext } from '../src/bootstrap';
import { getConfig } from '../src/config/env';
import { disconnectDatabase } from '../src/db/connection';
import { CLIENT_UPLOAD_PREFIX, deleteAsset, findOrphanedAssets } from '../src/media/media.service';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const daysIndex = args.indexOf('--days');
const days = daysIndex >= 0 ? Number(args[daysIndex + 1]) : 30;
if (!Number.isFinite(days) || days < 1) {
  console.error('--days must be a positive number');
  process.exit(1);
}

const config = getConfig();
await connect(config);
const ctx = createContext(config);
try {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const orphans = await findOrphanedAssets(cutoff, 5000);
  const bytes = orphans.reduce((sum, asset) => sum + asset.totalBytes, 0);
  console.log(
    `${orphans.length} unreferenced image(s) older than ${days} days (${(bytes / 1024 / 1024).toFixed(1)} MB).`,
  );
  if (!apply) {
    for (const asset of orphans.slice(0, 50))
      console.log(`  - ${asset._id} ${asset.originalFilename}`);
    console.log('Dry run only. Re-run with --apply to delete.');
  } else {
    let deleted = 0;
    for (const asset of orphans) {
      try {
        // deleteAsset re-checks usage, so an image attached meanwhile is kept.
        await deleteAsset(ctx, asset._id.toString());
        deleted++;
      } catch (error) {
        console.warn(`  kept ${asset._id}: ${(error as Error).message}`);
      }
    }
    console.log(`Deleted ${deleted} image(s).`);
  }
  // Browser uploads to Blob that were never turned into an image (e.g. the admin closed the tab).
  const token = config.storage.blobToken;
  if (token) {
    const { blobs } = await list({ prefix: CLIENT_UPLOAD_PREFIX, token, limit: 1000 });
    const stale = blobs.filter((blob) => blob.uploadedAt < new Date(Date.now() - 86_400_000));
    console.log(`${stale.length} abandoned temporary upload(s) older than 1 day.`);
    if (apply && stale.length)
      await del(
        stale.map((blob) => blob.url),
        { token },
      );
  }
} finally {
  await ctx.jobs.close();
  await disconnectDatabase();
}
