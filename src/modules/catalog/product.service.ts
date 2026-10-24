import { Types, type QueryFilter, type SortOrder } from 'mongoose';
import {
  slugify,
  type AdminProductListQuery,
  type ProductBulkAction,
  type ProductDetail,
  type ProductInput,
  type ProductListQuery,
  type ProductRedirect,
  type ProductSummary,
} from '@jmh/shared';
import type { AppContext } from '../../context';
import { InventoryMovementModel, ProductModel, type Product } from '../../db/models';
import { AppError, conflict, notFound, validationFailed } from '../../lib/errors';
import { escapeRegex } from '../../lib/validate';
import { resolveImageRefs } from '../../media/media.service';
import type { AuthenticatedAdmin } from '../../types/express';
import { categorySummaryMap, findActiveCategoryBySlug } from './category.service';
import { productDetailDTO, productSummaryDTO } from './product.serialize';

/** Fields a listing card needs; long text and SEO fields stay in the database. */
const SUMMARY_PROJECTION = {
  description: 0,
  shippingInfo: 0,
  specs: 0,
  seo: 0,
  previousSlugs: 0,
  tags: 0,
  images: { $slice: 2 },
} as const;

const SORTS: Record<string, Record<string, SortOrder>> = {
  featured: { rank: -1, publishedAt: -1, _id: -1 },
  newest: { publishedAt: -1, _id: -1 },
  price_asc: { minEffectivePrice: 1, _id: 1 },
  price_desc: { minEffectivePrice: -1, _id: -1 },
  name_asc: { name: 1, _id: 1 },
};

export interface ProductPage {
  data: ProductSummary[];
  meta: { page: number; limit: number; total: number; totalPages: number };
  category: { id: string; name: string; slug: string } | null;
}

export async function listPublicProducts(
  ctx: AppContext,
  query: ProductListQuery,
): Promise<ProductPage> {
  const filter: QueryFilter<Product> = { status: 'published' };
  let category: ProductPage['category'] = null;
  if (query.category) {
    const found = await findActiveCategoryBySlug(query.category);
    if (!found)
      return {
        data: [],
        meta: { page: query.page, limit: query.limit, total: 0, totalPages: 0 },
        category: null,
      };
    category = { id: found._id.toString(), name: found.name, slug: found.slug };
    filter.category = found._id;
  }
  if (query.q) filter.$text = { $search: query.q };
  if (query.inStock) filter.inStock = true;
  if (query.onSale) filter.onSale = true;
  if (query.featured) filter.isFeatured = true;
  if (query.bestseller) filter.isBestseller = true;
  if (query.minPrice != null || query.maxPrice != null) {
    filter.minEffectivePrice = {
      ...(query.minPrice != null ? { $gte: query.minPrice * 100 } : {}),
      ...(query.maxPrice != null ? { $lte: query.maxPrice * 100 } : {}),
    };
  }
  const idFilter: Record<string, unknown> = {};
  if (query.ids?.length) idFilter.$in = query.ids.map((id) => new Types.ObjectId(id));
  if (query.exclude) idFilter.$ne = new Types.ObjectId(query.exclude);
  if (Object.keys(idFilter).length) filter._id = idFilter;

  const useTextScore = Boolean(query.q) && query.sort === 'featured';
  const sort: Record<string, SortOrder | { $meta: 'textScore' }> = useTextScore
    ? { score: { $meta: 'textScore' }, rank: -1, _id: -1 }
    : SORTS[query.sort]!;
  const projection = useTextScore
    ? { ...SUMMARY_PROJECTION, score: { $meta: 'textScore' } }
    : SUMMARY_PROJECTION;

  const [products, total, categories] = await Promise.all([
    ProductModel.find(filter, projection)
      .sort(sort as Record<string, SortOrder>)
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean<Product[]>(),
    ProductModel.countDocuments(filter),
    categorySummaryMap(),
  ]);

  let ordered = products;
  if (query.ids?.length) {
    const position = new Map(query.ids.map((id, index) => [id, index]));
    ordered = [...products].sort(
      (a, b) => (position.get(a._id.toString()) ?? 0) - (position.get(b._id.toString()) ?? 0),
    );
  }
  return {
    data: ordered.map((product) => productSummaryDTO(product, categories, ctx.storage)),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
    category,
  };
}

export async function getPublicProduct(
  ctx: AppContext,
  slug: string,
): Promise<ProductDetail | ProductRedirect | null> {
  const product = await ProductModel.findOne({ slug, status: 'published' }).lean<Product>();
  if (!product) {
    const renamed = await ProductModel.findOne({ previousSlugs: slug, status: 'published' })
      .select('slug')
      .lean();
    return renamed ? { redirectTo: renamed.slug } : null;
  }
  return productDetailDTO(product, await categorySummaryMap(), ctx.storage);
}

export async function relatedProducts(
  ctx: AppContext,
  slug: string,
  limit = 8,
): Promise<ProductSummary[]> {
  const product = await ProductModel.findOne({ slug, status: 'published' })
    .select('_id category')
    .lean();
  if (!product) return [];
  const categories = await categorySummaryMap();
  const sameCategory = product.category
    ? await ProductModel.find(
        { status: 'published', category: product.category, _id: { $ne: product._id } },
        SUMMARY_PROJECTION,
      )
        .sort({ rank: -1, publishedAt: -1 })
        .limit(limit)
        .lean<Product[]>()
    : [];
  let results = sameCategory;
  if (results.length < 4) {
    const exclude = [product._id, ...results.map((item) => item._id)];
    const fill = await ProductModel.find(
      { status: 'published', _id: { $nin: exclude } },
      SUMMARY_PROJECTION,
    )
      .sort({ rank: -1, publishedAt: -1 })
      .limit(limit - results.length)
      .lean<Product[]>();
    results = [...results, ...fill];
  }
  return results.map((item) => productSummaryDTO(item, categories, ctx.storage));
}

export async function homeProductSections(ctx: AppContext) {
  const categories = await categorySummaryMap();
  const find = (filter: QueryFilter<Product>, sort: Record<string, SortOrder>, limit = 8) =>
    ProductModel.find({ status: 'published', ...filter }, SUMMARY_PROJECTION)
      .sort(sort)
      .limit(limit)
      .lean<Product[]>()
      .then((items) => items.map((item) => productSummaryDTO(item, categories, ctx.storage)));
  const [bestsellers, newArrivals, featured, offers] = await Promise.all([
    find({ isBestseller: true }, { publishedAt: -1 }),
    find({}, { publishedAt: -1 }),
    find({ isFeatured: true }, { publishedAt: -1 }),
    find({ onSale: true }, { publishedAt: -1 }),
  ]);
  return { bestsellers, newArrivals, featured, offers };
}

// ---------------------------------------------------------------------------------------------
// Admin

export async function listAdminProducts(query: AdminProductListQuery) {
  const filter: QueryFilter<Product> = {};
  if (query.status) filter.status = query.status;
  else filter.status = { $ne: 'archived' };
  if (query.categoryId) filter.category = new Types.ObjectId(query.categoryId);
  if (query.q) {
    const pattern = new RegExp(escapeRegex(query.q), 'i');
    filter.$or = [
      { name: pattern },
      { sku: pattern },
      { 'variants.sku': pattern },
      { slug: pattern },
    ];
  }
  if (query.stock === 'out') {
    filter.trackInventory = true;
    filter.stock = { $lte: 0 };
  } else if (query.stock === 'low') {
    filter.trackInventory = true;
    filter.$expr = { $lte: ['$stock', '$lowStockThreshold'] };
  }
  const sorts: Record<AdminProductListQuery['sort'], Record<string, SortOrder>> = {
    updated: { updatedAt: -1 },
    newest: { createdAt: -1 },
    name: { name: 1 },
    price_asc: { price: 1 },
    price_desc: { price: -1 },
    stock_asc: { stock: 1 },
  };
  const [items, total] = await Promise.all([
    ProductModel.find(filter, { description: 0, shippingInfo: 0, images: { $slice: 1 } })
      .sort({ ...sorts[query.sort], _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean<Product[]>(),
    ProductModel.countDocuments(filter),
  ]);
  return { items, total };
}

async function uniqueProductSlug(base: string, excludeId?: Types.ObjectId): Promise<string> {
  const root = base || `product-${new Types.ObjectId().toString().slice(-6)}`;
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const exists = await ProductModel.exists({
      slug: candidate,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    });
    if (!exists) return candidate;
  }
  throw conflict('Could not generate a unique slug. Please enter one manually.');
}

async function assertSkusAvailable(input: ProductInput, excludeId?: Types.ObjectId): Promise<void> {
  const skus = [input.sku, ...input.variants.map((variant) => variant.sku)].filter(
    (sku): sku is string => Boolean(sku),
  );
  if (skus.length === 0) return;
  const clash = await ProductModel.findOne({
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    $or: [{ sku: { $in: skus } }, { 'variants.sku': { $in: skus } }],
  })
    .select('name')
    .lean();
  if (clash) throw validationFailed({ sku: [`SKU already used by “${clash.name}”.`] });
}

function assertPublishable(input: Pick<ProductInput, 'status' | 'images'>): void {
  if (input.status === 'published' && input.images.length === 0) {
    throw validationFailed({ images: ['Add at least one image before publishing.'] });
  }
}

function buildVariants(input: ProductInput, existing: Product['variants'] = []) {
  const known = new Set(existing.map((variant) => variant._id.toString()));
  return input.variants.map((variant) => {
    if (variant.id && !known.has(variant.id)) {
      throw validationFailed({ variants: ['A variant does not belong to this product.'] });
    }
    return {
      _id: variant.id ? new Types.ObjectId(variant.id) : new Types.ObjectId(),
      name: variant.name,
      sku: variant.sku,
      price: variant.price,
      salePrice: variant.salePrice,
      stock: variant.stock,
      isActive: variant.isActive,
    };
  });
}

function productFields(input: ProductInput) {
  return {
    name: input.name,
    nameGu: input.nameGu,
    sku: input.sku,
    category: input.categoryId ? new Types.ObjectId(input.categoryId) : null,
    shortDescription: input.shortDescription,
    description: input.description,
    price: input.price,
    salePrice: input.salePrice,
    trackInventory: input.trackInventory,
    stock: input.stock,
    lowStockThreshold: input.lowStockThreshold,
    availability: input.availability,
    specs: input.specs,
    shippingInfo: input.shippingInfo,
    tags: [...new Set(input.tags)],
    isFeatured: input.isFeatured,
    isBestseller: input.isBestseller,
    status: input.status,
    seo: input.seo,
  };
}

function onCatalogChanged(ctx: AppContext): void {
  void ctx.cache.invalidate('catalog');
  ctx.revalidator.notify(['catalog']);
}

export async function createProduct(
  ctx: AppContext,
  input: ProductInput,
  actor: AuthenticatedAdmin,
): Promise<Product> {
  assertPublishable(input);
  await assertSkusAvailable(input);
  if (input.slug && (await ProductModel.exists({ slug: input.slug }))) {
    throw validationFailed({ slug: ['Another product already uses this URL slug.'] });
  }
  const slug = input.slug ?? (await uniqueProductSlug(slugify(input.name)));
  const images = await resolveImageRefs(input.images);
  const product = new ProductModel({
    ...productFields(input),
    slug,
    images,
    variants: buildVariants(input),
    createdBy: actor.id,
    updatedBy: actor.id,
  });
  await product.save();
  const stock = product.stock;
  if (product.trackInventory && stock > 0) {
    await InventoryMovementModel.create({
      product: product._id,
      variant: null,
      productName: product.name,
      variantName: null,
      delta: stock,
      stockAfter: stock,
      reason: 'restock',
      note: 'Opening stock',
      actor: actor.id,
      actorName: actor.name,
    });
  }
  onCatalogChanged(ctx);
  return product.toObject();
}

/**
 * Full replacement update. `version` (the updatedAt the editor loaded) prevents silently
 * overwriting stock that changed meanwhile, e.g. because an order was placed.
 */
export async function updateProduct(
  ctx: AppContext,
  id: string,
  input: ProductInput,
  version: string | undefined,
  actor: AuthenticatedAdmin,
): Promise<Product> {
  const product = await ProductModel.findById(id);
  if (!product) throw notFound('Product');
  if (version && product.updatedAt.toISOString() !== version) {
    throw new AppError(
      409,
      'STALE_PRODUCT',
      'This product was changed since you opened it (for example, a new order updated its stock). Reload to see the latest version.',
    );
  }
  assertPublishable(input);
  await assertSkusAvailable(input, product._id);

  const nextSlug = input.slug ?? product.slug;
  if (nextSlug !== product.slug) {
    if (await ProductModel.exists({ slug: nextSlug, _id: { $ne: product._id } })) {
      throw validationFailed({ slug: ['Another product already uses this URL slug.'] });
    }
    // The new owner of a slug wins over an old redirect pointing elsewhere.
    await ProductModel.updateMany(
      { previousSlugs: nextSlug },
      { $pull: { previousSlugs: nextSlug } },
    );
    product.previousSlugs = [...new Set([product.slug, ...product.previousSlugs])]
      .filter((slug) => slug !== nextSlug)
      .slice(0, 20);
  }

  const before = {
    stock: product.stock,
    variants: new Map(
      product.variants.map((variant) => [
        variant._id.toString(),
        { stock: variant.stock, name: variant.name },
      ]),
    ),
  };
  const images = await resolveImageRefs(input.images);
  product.set({
    ...productFields(input),
    slug: nextSlug,
    images,
    variants: buildVariants(input, product.variants),
    updatedBy: actor.id,
  });
  await product.save();

  // Record stock edits made in the product editor as manual adjustments.
  const movements = [];
  const base = {
    product: product._id,
    productName: product.name,
    reason: 'manual_adjustment' as const,
    note: 'Edited in product editor',
    actor: actor.id,
    actorName: actor.name,
  };
  if (product.variants.length === 0 && product.stock !== before.stock) {
    movements.push({
      ...base,
      variant: null,
      variantName: null,
      delta: product.stock - before.stock,
      stockAfter: product.stock,
    });
  }
  for (const variant of product.variants) {
    const previous = before.variants.get(variant._id.toString())?.stock ?? 0;
    if (variant.stock !== previous) {
      movements.push({
        ...base,
        variant: variant._id,
        variantName: variant.name,
        delta: variant.stock - previous,
        stockAfter: variant.stock,
      });
    }
  }
  if (movements.length) await InventoryMovementModel.insertMany(movements);
  onCatalogChanged(ctx);
  return product.toObject();
}

export async function duplicateProduct(
  ctx: AppContext,
  id: string,
  actor: AuthenticatedAdmin,
): Promise<Product> {
  const source = await ProductModel.findById(id).lean<Product>();
  if (!source) throw notFound('Product');
  const name = `${source.name} (Copy)`.slice(0, 140);
  const copy = new ProductModel({
    ...source,
    _id: new Types.ObjectId(),
    name,
    slug: await uniqueProductSlug(slugify(name)),
    previousSlugs: [],
    sku: null,
    stock: 0,
    variants: source.variants.map((variant) => ({
      ...variant,
      _id: new Types.ObjectId(),
      sku: null,
      stock: 0,
    })),
    status: 'draft',
    publishedAt: null,
    isFeatured: false,
    isBestseller: false,
    createdBy: actor.id,
    updatedBy: actor.id,
    createdAt: undefined,
    updatedAt: undefined,
  });
  await copy.save();
  return copy.toObject();
}

export async function deleteProduct(ctx: AppContext, id: string): Promise<Product> {
  const product = await ProductModel.findByIdAndDelete(id).lean<Product>();
  if (!product) throw notFound('Product');
  // Orders keep their own snapshots; images become unreferenced and are removed by the
  // media cleanup job after the retention period.
  onCatalogChanged(ctx);
  return product;
}

export async function bulkUpdateProducts(
  ctx: AppContext,
  ids: string[],
  action: ProductBulkAction,
  categoryId: string | null | undefined,
  actor: AuthenticatedAdmin,
): Promise<{ matched: number; modified: number; skipped: number }> {
  const objectIds = ids.map((id) => new Types.ObjectId(id));
  let filter: QueryFilter<Product> = { _id: { $in: objectIds } };
  let update: Record<string, unknown>;
  let skipped = 0;
  switch (action) {
    case 'publish': {
      // Products without images are not publishable; leave them as they are.
      const withoutImages = await ProductModel.countDocuments({
        _id: { $in: objectIds },
        images: { $size: 0 },
      });
      skipped = withoutImages;
      filter = { _id: { $in: objectIds }, 'images.0': { $exists: true } };
      update = { $set: { status: 'published', updatedBy: actor.id } };
      break;
    }
    case 'unpublish':
      update = { $set: { status: 'draft', updatedBy: actor.id } };
      break;
    case 'archive':
      update = { $set: { status: 'archived', updatedBy: actor.id } };
      break;
    case 'assign_category':
      update = {
        $set: { category: categoryId ? new Types.ObjectId(categoryId) : null, updatedBy: actor.id },
      };
      break;
    case 'feature':
      update = { $set: { isFeatured: true, updatedBy: actor.id } };
      break;
    case 'unfeature':
      update = { $set: { isFeatured: false, updatedBy: actor.id } };
      break;
    case 'mark_bestseller':
      update = { $set: { isBestseller: true, updatedBy: actor.id } };
      break;
    case 'unmark_bestseller':
      update = { $set: { isBestseller: false, updatedBy: actor.id } };
      break;
  }
  const result = await ProductModel.updateMany(filter, update);
  // Keep publishedAt and the derived ranking fields consistent after a raw update.
  await ProductModel.updateMany(
    { _id: { $in: objectIds }, status: 'published', publishedAt: null },
    { $set: { publishedAt: new Date() } },
  );
  await ProductModel.updateMany(
    { _id: { $in: objectIds } },
    [
      {
        $set: {
          rank: {
            $add: [{ $cond: ['$isFeatured', 2, 0] }, { $cond: ['$isBestseller', 1, 0] }],
          },
        },
      },
    ],
    { updatePipeline: true },
  );
  onCatalogChanged(ctx);
  return { matched: result.matchedCount, modified: result.modifiedCount, skipped };
}
