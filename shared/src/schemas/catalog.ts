import { z } from 'zod';
import { AVAILABILITY, LIMITS, PRODUCT_SORTS, PRODUCT_STATUSES } from '../constants';
import {
  booleanQuerySchema,
  limitQuerySchema,
  nullableText,
  objectIdSchema,
  optionalText,
  pageQuerySchema,
  paiseSchema,
  positivePaiseSchema,
  requiredText,
  searchQuerySchema,
  seoSchema,
  slugSchema,
} from './common';

const skuSchema = z
  .string()
  .trim()
  .toUpperCase()
  .max(64)
  .regex(/^[A-Z0-9][A-Z0-9._-]*$/, {
    error: 'SKU may contain letters, numbers, dot, dash and underscore',
  })
  .nullish()
  .or(z.literal(''))
  .transform((value) => (value ? value : null));

const measurement = (max: number) =>
  z
    .number()
    .positive()
    .max(max)
    .nullish()
    .transform((value) => value ?? null);

export const productImageInputSchema = z.object({
  assetId: objectIdSchema,
  alt: z.string().trim().max(200).default(''),
});

export const productVariantInputSchema = z.object({
  id: objectIdSchema.optional(),
  name: requiredText(80, 'Variant name'),
  sku: skuSchema,
  /** null = use the product price */
  price: positivePaiseSchema.nullish().transform((value) => value ?? null),
  salePrice: paiseSchema.nullish().transform((value) => value ?? null),
  stock: z.number().int().min(0).max(1_000_000).default(0),
  isActive: z.boolean().default(true),
});

export const productSpecsSchema = z
  .object({
    material: nullableText(80),
    finish: nullableText(80),
    color: nullableText(60),
    heightCm: measurement(1000),
    widthCm: measurement(1000),
    depthCm: measurement(1000),
    diameterCm: measurement(1000),
    capacityLitres: measurement(1000),
    weightKg: measurement(1000),
  })
  .default({
    material: null,
    finish: null,
    color: null,
    heightCm: null,
    widthCm: null,
    depthCm: null,
    diameterCm: null,
    capacityLitres: null,
    weightKg: null,
  });

export const productInputSchema = z
  .object({
    name: requiredText(140, 'Product name'),
    nameGu: nullableText(140),
    slug: slugSchema.optional(),
    sku: skuSchema,
    categoryId: objectIdSchema.nullish().transform((value) => value ?? null),
    shortDescription: z.string().trim().max(300).default(''),
    description: z.string().trim().max(8000).default(''),
    price: positivePaiseSchema,
    salePrice: paiseSchema.nullish().transform((value) => value ?? null),
    trackInventory: z.boolean().default(true),
    stock: z.number().int().min(0).max(1_000_000).default(0),
    lowStockThreshold: z.number().int().min(0).max(10_000).default(3),
    availability: z.enum(AVAILABILITY).default('in_stock'),
    images: z.array(productImageInputSchema).max(LIMITS.maxImagesPerProduct).default([]),
    variants: z.array(productVariantInputSchema).max(LIMITS.maxVariantsPerProduct).default([]),
    specs: productSpecsSchema,
    shippingInfo: z.string().trim().max(2000).default(''),
    tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(20).default([]),
    isFeatured: z.boolean().default(false),
    isBestseller: z.boolean().default(false),
    status: z.enum(PRODUCT_STATUSES).default('draft'),
    seo: seoSchema,
  })
  .superRefine((product, ctx) => {
    if (product.salePrice != null && product.salePrice >= product.price) {
      ctx.addIssue({
        code: 'custom',
        path: ['salePrice'],
        message: 'Sale price must be lower than the regular price',
      });
    }
    const names = new Set<string>();
    const skus = new Set<string>(product.sku ? [product.sku] : []);
    product.variants.forEach((variant, index) => {
      const key = variant.name.toLowerCase();
      if (names.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['variants', index, 'name'],
          message: 'Duplicate variant name',
        });
      }
      names.add(key);
      if (variant.sku) {
        if (skus.has(variant.sku)) {
          ctx.addIssue({
            code: 'custom',
            path: ['variants', index, 'sku'],
            message: 'Duplicate SKU',
          });
        }
        skus.add(variant.sku);
      }
      const regular = variant.price ?? product.price;
      if (variant.salePrice != null && variant.salePrice >= regular) {
        ctx.addIssue({
          code: 'custom',
          path: ['variants', index, 'salePrice'],
          message: 'Sale price must be lower than the variant price',
        });
      }
    });
    const assetIds = new Set<string>();
    product.images.forEach((image, index) => {
      if (assetIds.has(image.assetId)) {
        ctx.addIssue({ code: 'custom', path: ['images', index], message: 'Image added twice' });
      }
      assetIds.add(image.assetId);
    });
  });

export type ProductInput = z.infer<typeof productInputSchema>;
export type ProductInputRaw = z.input<typeof productInputSchema>;

const idListSchema = z
  .string()
  .trim()
  .transform((value) =>
    value
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  )
  .pipe(z.array(objectIdSchema).max(LIMITS.maxPageSize));

/** Public catalogue listing query (query-string values arrive as strings). */
export const productListQuerySchema = z.object({
  q: searchQuerySchema,
  category: slugSchema.optional(),
  sort: z.enum(PRODUCT_SORTS).default('featured'),
  inStock: booleanQuerySchema.optional(),
  onSale: booleanQuerySchema.optional(),
  featured: booleanQuerySchema.optional(),
  bestseller: booleanQuerySchema.optional(),
  /** Whole rupees, as shown in the filter UI. */
  minPrice: z.coerce.number().int().min(0).max(1_000_000).optional(),
  maxPrice: z.coerce.number().int().min(0).max(1_000_000).optional(),
  ids: idListSchema.optional(),
  exclude: objectIdSchema.optional(),
  page: pageQuerySchema,
  limit: limitQuerySchema(),
});
export type ProductListQuery = z.infer<typeof productListQuerySchema>;

export const adminProductListQuerySchema = z.object({
  q: searchQuerySchema,
  status: z.enum(PRODUCT_STATUSES).optional(),
  categoryId: objectIdSchema.optional(),
  stock: z.enum(['low', 'out']).optional(),
  sort: z
    .enum(['updated', 'newest', 'name', 'price_asc', 'price_desc', 'stock_asc'])
    .default('updated'),
  page: pageQuerySchema,
  limit: limitQuerySchema(LIMITS.maxAdminPageSize, 25),
});
export type AdminProductListQuery = z.infer<typeof adminProductListQuerySchema>;

export const PRODUCT_BULK_ACTIONS = [
  'publish',
  'unpublish',
  'archive',
  'assign_category',
  'feature',
  'unfeature',
  'mark_bestseller',
  'unmark_bestseller',
] as const;
export type ProductBulkAction = (typeof PRODUCT_BULK_ACTIONS)[number];

export const productBulkActionSchema = z
  .object({
    ids: z.array(objectIdSchema).min(1).max(LIMITS.maxAdminPageSize),
    action: z.enum(PRODUCT_BULK_ACTIONS),
    categoryId: objectIdSchema.nullish(),
  })
  .refine((value) => value.action !== 'assign_category' || value.categoryId, {
    path: ['categoryId'],
    error: 'Choose a category',
  });

export const categoryInputSchema = z.object({
  name: requiredText(80, 'Category name'),
  nameGu: nullableText(80),
  slug: slugSchema.optional(),
  description: z.string().trim().max(1000).default(''),
  image: productImageInputSchema.nullish().transform((value) => value ?? null),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  isActive: z.boolean().default(true),
  showOnHome: z.boolean().default(true),
  seo: seoSchema,
});
export type CategoryInput = z.infer<typeof categoryInputSchema>;

export const categoryReorderSchema = z.object({
  ids: z.array(objectIdSchema).min(1).max(200),
});

export const mediaCropSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  rotation: z.number().int().min(-360).max(360).default(0),
});
export type MediaCrop = z.infer<typeof mediaCropSchema>;

export const mediaUpdateSchema = z.object({
  alt: z.string().trim().max(200),
});

export const mediaListQuerySchema = z.object({
  q: searchQuerySchema,
  status: z.enum(['processing', 'ready', 'failed']).optional(),
  unused: booleanQuerySchema.optional(),
  page: pageQuerySchema,
  limit: limitQuerySchema(60, 30),
});

export const inventoryAdjustSchema = z.object({
  productId: objectIdSchema,
  variantId: objectIdSchema.nullish().transform((value) => value ?? null),
  mode: z.enum(['delta', 'set']),
  quantity: z.number().int().min(-1_000_000).max(1_000_000),
  reason: z.enum(['manual_adjustment', 'restock', 'damaged', 'return']),
  note: optionalText(300),
});
export type InventoryAdjustInput = z.infer<typeof inventoryAdjustSchema>;

export const inventoryListQuerySchema = z.object({
  q: searchQuerySchema,
  filter: z.enum(['all', 'low', 'out']).default('low'),
  page: pageQuerySchema,
  limit: limitQuerySchema(LIMITS.maxAdminPageSize, 50),
});
