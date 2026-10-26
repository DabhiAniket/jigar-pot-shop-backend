/**
 * Rebuilds the demo catalogue's image FILES under the keys the live database already references,
 * for when the files were lost but the records survived. Reads only the public storefront API
 * (no database access), re-runs seed/images through the same Sharp pipeline as seed-demo, and
 * writes the results to STORAGE_LOCAL_DIR/public. Upload them with `npm run media:migrate-blob`.
 * Never deletes or overwrites; dry run by default.
 *
 *   npm run media:restore-demo -- --api https://your-site.example/api/v1          # report
 *   npm run media:restore-demo -- --api https://your-site.example/api/v1 --apply   # write files
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImageDTO } from '@jmh/shared';
import { getConfig } from '../src/config/env';
import { processImage } from '../src/media/image-processor';
import { DEMO_CATEGORIES, DEMO_PRODUCTS } from '../seed/demo-catalog';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const api = (args[args.indexOf('--api') + 1] ?? '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(api)) {
  console.error('Pass --api <public API base URL>, e.g. https://your-site.example/api/v1');
  process.exit(1);
}
const config = getConfig();
const imagesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'seed', 'images');
const outDir = path.join(config.storage.localDir, 'public');

async function getJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url);
  return response.ok ? ((await response.json()) as { data: T }).data : null;
}

async function listImages(dir: string): Promise<string[]> {
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  return files
    .filter((file) => /\.(jpe?g|png|webp)$/i.test(file))
    .sort()
    .map((file) => path.join(dir, file));
}

let written = 0;
let present = 0;
let problems = 0;

/** Same source image → same variants; the database's asset id and variant widths name the files. */
async function restore(
  file: string | undefined,
  image: ImageDTO | null | undefined,
  label: string,
) {
  if (!file || !image) {
    console.warn(`  ? ${label}: no ${file ? 'live image record' : 'seed image'} to match`);
    problems++;
    return;
  }
  const result = await processImage(await fs.readFile(file), null, {
    quality: config.media.webpQuality,
    maxInputPixels: config.media.maxInputPixels,
  });
  const made = new Map(
    result.variants.map((variant) => [`${variant.name}-${variant.width}`, variant]),
  );
  for (const live of image.variants) {
    const variant = made.get(`${live.name}-${live.width}`);
    if (!variant) {
      console.warn(`  ? ${label}: ${live.name}-${live.width} does not match the seed image`);
      problems++;
      continue;
    }
    const key = `img/${image.assetId}/${live.name}-${live.width}.webp`;
    const target = path.join(outDir, key);
    if (
      await fs.stat(target).then(
        () => true,
        () => false,
      )
    ) {
      present++;
      continue;
    }
    if (apply) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, variant.buffer, { flag: 'wx' });
    }
    written++;
  }
}

const categories =
  (await getJson<{ slug: string; image: ImageDTO | null }[]>(`${api}/categories`)) ?? [];
for (const demo of DEMO_CATEGORIES) {
  const live = categories.find((category) => category.slug === demo.slug);
  const [cover] = (await listImages(path.join(imagesDir, 'categories'))).filter((file) =>
    path.basename(file).startsWith(demo.slug),
  );
  if (live) await restore(cover, live.image, `category ${demo.slug}`);
}
for (const demo of DEMO_PRODUCTS) {
  const live = await getJson<{ images: ImageDTO[] }>(`${api}/products/${demo.slug}`);
  if (!live) continue;
  const files = await listImages(path.join(imagesDir, 'products', demo.slug));
  for (const [index, image] of live.images.entries())
    await restore(files[index], image, `product ${demo.slug} #${index + 1}`);
}
console.log(
  `${apply ? 'Wrote' : 'Would write'} ${written} file(s) to ${outDir}; ${present} already there; ${problems} problem(s).`,
);
if (!apply) console.log('Dry run only. Re-run with --apply to write the files locally.');
