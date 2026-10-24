/**
 * Loads the ILLUSTRATIVE demo catalogue (development/demo only).
 *
 *   npm run seed:demo            # adds missing demo categories/products; never overwrites
 *   npm run seed:demo -- --reset-catalog   # first removes ONLY products/categories it created
 *
 * Refuses to run when NODE_ENV=production. Images in seed/images are sent through the same
 * Sharp pipeline as admin uploads (crop → resize → WebP variants → storage).
 * Business contact details are never seeded — set them in Admin → Settings.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Types } from 'mongoose';
import { slugify } from '@jmh/shared';
import { connect, createContext } from '../src/bootstrap';
import { getConfig } from '../src/config/env';
import { disconnectDatabase } from '../src/db/connection';
import {
  CategoryModel,
  HomeContentModel,
  InventoryMovementModel,
  MediaAssetModel,
  ProductModel,
  PromotionModel,
  StoreSettingsModel,
  type ImageRef,
} from '../src/db/models';
import { inspectImage } from '../src/media/image-processor';
import { deleteAsset, processAsset } from '../src/media/media.service';
import { runMigrations } from '../src/migrations';
import { invalidateSettingsCache } from '../src/modules/settings/settings.service';
import { DEMO_CATEGORIES, DEMO_PRODUCTS } from '../seed/demo-catalog';

const SEED_TAG = 'demo-seed';
const imagesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'seed', 'images');

const config = getConfig();
if (config.isProd && !process.argv.includes('--allow-production')) {
  console.error(
    'Refusing to seed demo data in production. (Use the admin panel to add real products.)',
  );
  process.exit(1);
}

await connect(config);
await runMigrations(config);
const ctx = createContext(config);

async function listImages(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir))
      .filter((file) => /\.(jpe?g|png|webp)$/i.test(file))
      .sort()
      .map((file) => path.join(dir, file));
  } catch {
    return [];
  }
}

/** Runs a file through the real media pipeline and returns a ready image reference. */
async function importImage(file: string, alt: string): Promise<ImageRef | null> {
  const buffer = await fs.readFile(file);
  const inspected = await inspectImage(buffer, config.media.maxInputPixels);
  const asset = await MediaAssetModel.create({
    status: 'processing',
    alt,
    originalFilename: `${path.basename(path.dirname(file))}-${path.basename(file)}`,
    sourceFormat: inspected.format,
    sourceBytes: buffer.length,
    sourceWidth: inspected.width,
    sourceHeight: inspected.height,
  });
  const ext = inspected.format === 'jpeg' ? 'jpg' : inspected.format;
  asset.incomingKey = `incoming/${asset.id}.${ext}`;
  await ctx.storage.putPrivate(asset.incomingKey, buffer, `image/${inspected.format}`);
  await asset.save();
  await processAsset(ctx, asset.id, { isFinalAttempt: true });
  const ready = await MediaAssetModel.findById(asset._id).lean();
  if (!ready || ready.status !== 'ready') {
    console.warn(`  ! could not process ${path.basename(file)}: ${ready?.error}`);
    return null;
  }
  return {
    asset: ready._id,
    alt,
    width: ready.width!,
    height: ready.height!,
    placeholder: ready.placeholder,
    variants: ready.variants,
  };
}

try {
  if (process.argv.includes('--reset-catalog')) {
    const seeded = await ProductModel.find({ tags: SEED_TAG }).select('_id images.asset').lean();
    const demoCategories = await CategoryModel.find({
      slug: { $in: DEMO_CATEGORIES.map((c) => c.slug) },
    })
      .select('image.asset')
      .lean();
    const assetIds = [
      ...seeded.flatMap((p) => p.images.map((image) => image.asset.toString())),
      ...demoCategories.flatMap((c) => (c.image ? [c.image.asset.toString()] : [])),
    ];
    await ProductModel.deleteMany({ tags: SEED_TAG });
    await InventoryMovementModel.deleteMany({ product: { $in: seeded.map((p) => p._id) } });
    await CategoryModel.deleteMany({ slug: { $in: DEMO_CATEGORIES.map((c) => c.slug) } });
    // Remove the demo images too (deleteAsset re-checks that nothing else uses them).
    let removedImages = 0;
    for (const id of new Set(assetIds)) {
      try {
        await deleteAsset(ctx, id);
        removedImages++;
      } catch {
        // still referenced elsewhere (e.g. reused by a real product) — keep it
      }
    }
    console.log(`Removed ${removedImages} demo image(s).`);
    console.log(`Removed ${seeded.length} demo products and the demo categories.`);
  }

  const categoryIds = new Map<string, Types.ObjectId>();
  for (const [index, category] of DEMO_CATEGORIES.entries()) {
    let doc = await CategoryModel.findOne({ slug: category.slug });
    const [cover] = await listImages(path.join(imagesDir, 'categories')).then((files) =>
      files.filter((file) => path.basename(file).startsWith(category.slug)),
    );
    if (!doc) {
      const image = cover ? await importImage(cover, `${category.name} — handcrafted clay`) : null;
      doc = await CategoryModel.create({
        ...category,
        image,
        sortOrder: index * 10,
        isActive: true,
        showOnHome: true,
      });
      console.log(`+ category ${category.name}${image ? ' (with cover)' : ''}`);
    } else if (!doc.image && cover) {
      // Covers rendered after the first seed run are attached to the existing demo category.
      doc.image = await importImage(cover, `${category.name} — handcrafted clay`);
      await doc.save();
      console.log(`~ category ${category.name}: cover added`);
    }
    categoryIds.set(category.slug, doc._id);
  }

  let created = 0;
  for (const item of DEMO_PRODUCTS) {
    const files = await listImages(path.join(imagesDir, 'products', item.slug));
    const existing = await ProductModel.findOne({ slug: item.slug });
    if (existing) {
      // Gallery images rendered after the first seed run are appended to demo products only.
      if (existing.tags.includes(SEED_TAG) && existing.images.length < files.length) {
        for (const [index, file] of files.entries()) {
          if (index < existing.images.length) continue;
          const ref = await importImage(file, `${item.name} — detail ${index + 1}`);
          if (ref) existing.images.push(ref);
        }
        await existing.save();
        console.log(`~ product ${item.name}: now ${existing.images.length} images`);
      }
      continue;
    }
    const images: ImageRef[] = [];
    for (const [index, file] of files.entries()) {
      const ref = await importImage(
        file,
        index === 0 ? item.name : `${item.name} — detail ${index + 1}`,
      );
      if (ref) images.push(ref);
    }
    const variants = (item.variants ?? []).map((variant) => ({
      _id: new Types.ObjectId(),
      name: variant.name,
      sku: `${slugify(item.slug).toUpperCase().slice(0, 18)}-${slugify(variant.name).toUpperCase()}`.slice(
        0,
        64,
      ),
      price: variant.price * 100,
      salePrice: variant.salePrice ? variant.salePrice * 100 : null,
      stock: variant.stock,
      isActive: true,
    }));
    const product = await ProductModel.create({
      name: item.name,
      nameGu: item.nameGu ?? null,
      slug: item.slug,
      sku: `JMH-${item.slug.toUpperCase()}`.slice(0, 64),
      category: categoryIds.get(item.category) ?? null,
      shortDescription: item.shortDescription,
      description: item.description,
      price: (item.variants?.[0]?.price ?? item.price) * 100,
      salePrice: item.variants ? null : item.salePrice ? item.salePrice * 100 : null,
      trackInventory: true,
      stock: item.stock,
      lowStockThreshold: 3,
      availability: item.availability ?? 'in_stock',
      images,
      variants,
      specs: item.specs,
      shippingInfo:
        'Clay is fragile: every order is packed with care. Before first use, soak in clean water for a few hours. Clean with water only.',
      tags: [...item.tags, SEED_TAG],
      isFeatured: item.featured ?? false,
      isBestseller: item.bestseller ?? false,
      // Without an image a product cannot be published.
      status: images.length ? 'published' : 'draft',
    });
    await InventoryMovementModel.create({
      product: product._id,
      productName: product.name,
      delta: product.stock,
      stockAfter: product.stock,
      reason: 'restock',
      note: 'Demo opening stock',
    });
    created++;
    console.log(
      `+ product ${item.name} (${images.length} image${images.length === 1 ? '' : 's'}, ${product.status})`,
    );
  }

  // A sample promotion during the 2026 Diwali season (dates are relative to the seed run).
  if (!(await PromotionModel.exists({ name: 'Diwali Dhamaka' }))) {
    const now = new Date();
    await PromotionModel.create({
      name: 'Diwali Dhamaka',
      description: 'Sample promotion created by the demo seed.',
      type: 'percentage',
      value: 20,
      scope: 'categories',
      categoryIds: [categoryIds.get('festival-collection')!],
      startsAt: now,
      endsAt: new Date(now.getTime() + 21 * 86_400_000),
      isActive: true,
      priority: 10,
      banner: {
        show: true,
        headline: 'Diwali Dhamaka — 20% off the Festival Collection',
        subtext:
          'Diyas and festive pots for your celebrations. Discount applied automatically at checkout.',
        ctaLabel: 'Shop festive',
        ctaHref: '/collections/festival-collection',
      },
    });
    console.log('+ promotion Diwali Dhamaka');
  }

  // Demo delivery rules (sample values) so the checkout can be tried end to end.
  await StoreSettingsModel.updateOne(
    { _id: 'store', 'delivery.deliveryEnabled': false, 'delivery.flatCharge': 0 },
    {
      $set: {
        delivery: {
          deliveryEnabled: true,
          pickupEnabled: true,
          flatCharge: 120_00,
          freeDeliveryThreshold: 1499_00,
          note: 'Sample delivery rules — set real charges in Admin → Settings.',
        },
      },
    },
  );
  // Feature the demo collections unless the homepage already points at existing categories.
  const home = await HomeContentModel.findById('home').select('featuredCategoryIds').lean();
  const existing = await CategoryModel.countDocuments({
    _id: { $in: (home?.featuredCategoryIds ?? []).filter((id) => Types.ObjectId.isValid(id)) },
  });
  if (!home?.featuredCategoryIds.length || existing === 0) {
    await HomeContentModel.updateOne(
      { _id: 'home' },
      {
        $set: {
          featuredCategoryIds: [
            'clay-matkas',
            'earthen-water-pots',
            'planters',
            'festival-collection',
          ].map((slug) => categoryIds.get(slug)!.toString()),
        },
      },
    );
  }
  invalidateSettingsCache();
  ctx.revalidator.notify(['catalog', 'settings', 'home', 'promotions']);
  console.log(`Done: ${created} new demo product(s).`);
} finally {
  await ctx.jobs.close();
  await disconnectDatabase();
}
