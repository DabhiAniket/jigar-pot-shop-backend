import { model, Schema, type HydratedDocument, type Types } from 'mongoose';
import { AVAILABILITY, PRODUCT_STATUSES, type Availability, type ProductStatus } from '@jmh/shared';
import {
  imageRefSchema,
  integerValidator,
  seoSchema,
  type ImageRef,
  type Seo,
} from './shared-schemas';

export interface ProductVariant {
  _id: Types.ObjectId;
  name: string;
  sku: string | null;
  price: number | null;
  salePrice: number | null;
  stock: number;
  isActive: boolean;
}

export interface ProductSpecsDoc {
  material: string | null;
  finish: string | null;
  color: string | null;
  heightCm: number | null;
  widthCm: number | null;
  depthCm: number | null;
  diameterCm: number | null;
  capacityLitres: number | null;
  weightKg: number | null;
}

export interface Product {
  _id: Types.ObjectId;
  name: string;
  nameGu: string | null;
  slug: string;
  previousSlugs: string[];
  sku: string | null;
  category: Types.ObjectId | null;
  shortDescription: string;
  description: string;
  price: number;
  salePrice: number | null;
  trackInventory: boolean;
  /** Product-level stock, or the sum of active variant stock when variants exist. */
  stock: number;
  lowStockThreshold: number;
  availability: Availability;
  images: ImageRef[];
  variants: ProductVariant[];
  specs: ProductSpecsDoc;
  shippingInfo: string;
  tags: string[];
  isFeatured: boolean;
  isBestseller: boolean;
  status: ProductStatus;
  publishedAt: Date | null;
  seo: Seo;
  // Denormalised fields maintained by applyDerivedFields() for indexed filtering/sorting.
  minEffectivePrice: number;
  maxEffectivePrice: number;
  onSale: boolean;
  inStock: boolean;
  rank: number;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const variantSchema = new Schema<ProductVariant>({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  sku: { type: String, default: null, maxlength: 64 },
  price: { type: Number, default: null, min: 0, validate: integerValidator },
  salePrice: { type: Number, default: null, min: 0, validate: integerValidator },
  stock: { type: Number, default: 0, min: 0, validate: integerValidator },
  isActive: { type: Boolean, default: true },
});

const specsSchema = new Schema<ProductSpecsDoc>(
  {
    material: { type: String, default: null },
    finish: { type: String, default: null },
    color: { type: String, default: null },
    heightCm: { type: Number, default: null },
    widthCm: { type: Number, default: null },
    depthCm: { type: Number, default: null },
    diameterCm: { type: Number, default: null },
    capacityLitres: { type: Number, default: null },
    weightKg: { type: Number, default: null },
  },
  { _id: false },
);

const productSchema = new Schema<Product>(
  {
    name: { type: String, required: true, trim: true, maxlength: 140 },
    nameGu: { type: String, default: null, maxlength: 140 },
    slug: { type: String, required: true, lowercase: true, trim: true, maxlength: 80 },
    previousSlugs: { type: [String], default: [] },
    sku: { type: String, default: null, maxlength: 64 },
    category: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    shortDescription: { type: String, default: '', maxlength: 300 },
    description: { type: String, default: '', maxlength: 8000 },
    price: { type: Number, required: true, min: 0, validate: integerValidator },
    salePrice: { type: Number, default: null, min: 0, validate: integerValidator },
    trackInventory: { type: Boolean, default: true },
    stock: { type: Number, default: 0, min: 0, validate: integerValidator },
    lowStockThreshold: { type: Number, default: 3, min: 0 },
    availability: { type: String, enum: AVAILABILITY, default: 'in_stock' },
    images: { type: [imageRefSchema], default: [] },
    variants: { type: [variantSchema], default: [] },
    specs: { type: specsSchema, default: () => ({}) },
    shippingInfo: { type: String, default: '', maxlength: 2000 },
    tags: { type: [String], default: [] },
    isFeatured: { type: Boolean, default: false },
    isBestseller: { type: Boolean, default: false },
    status: { type: String, enum: PRODUCT_STATUSES, default: 'draft' },
    publishedAt: { type: Date, default: null },
    seo: { type: seoSchema, default: () => ({}) },
    minEffectivePrice: { type: Number, default: 0 },
    maxEffectivePrice: { type: Number, default: 0 },
    onSale: { type: Boolean, default: false },
    inStock: { type: Boolean, default: true },
    rank: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'AdminUser', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'AdminUser', default: null },
  },
  { timestamps: true, optimisticConcurrency: false },
);

productSchema.index({ slug: 1 }, { unique: true });
productSchema.index({ previousSlugs: 1 });
productSchema.index(
  { sku: 1 },
  { unique: true, partialFilterExpression: { sku: { $type: 'string' } } },
);
productSchema.index({ category: 1 });
productSchema.index({ status: 1, publishedAt: -1 });
productSchema.index({ status: 1, category: 1, publishedAt: -1 });
productSchema.index({ status: 1, rank: -1, publishedAt: -1 });
productSchema.index({ status: 1, category: 1, rank: -1, publishedAt: -1 });
productSchema.index({ status: 1, minEffectivePrice: 1 });
productSchema.index({ status: 1, category: 1, minEffectivePrice: 1 });
productSchema.index({ status: 1, isFeatured: 1, publishedAt: -1 });
productSchema.index({ status: 1, isBestseller: 1, publishedAt: -1 });
productSchema.index({ status: 1, onSale: 1, publishedAt: -1 });
productSchema.index({ status: 1, name: 1 });
productSchema.index({ status: 1, updatedAt: -1 });
productSchema.index({ updatedAt: -1 });
productSchema.index({ 'images.asset': 1 });
productSchema.index(
  { name: 'text', nameGu: 'text', tags: 'text', shortDescription: 'text' },
  {
    name: 'product_text_search',
    weights: { name: 10, nameGu: 8, tags: 5, shortDescription: 2 },
    default_language: 'english',
    language_override: 'textSearchLanguage',
  },
);

/** Effective (customer-facing) unit price of an option. */
export function optionPrice(price: number, salePrice: number | null): number {
  return salePrice != null && salePrice < price ? salePrice : price;
}

/** Keeps the denormalised filter/sort fields consistent with prices, variants and stock. */
export function applyDerivedFields(product: Product): void {
  const activeVariants = product.variants.filter((variant) => variant.isActive);
  const options =
    activeVariants.length > 0
      ? activeVariants.map((variant) => {
          const regular = variant.price ?? product.price;
          return {
            regular,
            effective: optionPrice(regular, variant.salePrice),
            stock: variant.stock,
          };
        })
      : [
          {
            regular: product.price,
            effective: optionPrice(product.price, product.salePrice),
            stock: product.stock,
          },
        ];

  const effectivePrices = options.map((option) => option.effective);
  product.minEffectivePrice = Math.min(...effectivePrices);
  product.maxEffectivePrice = Math.max(...effectivePrices);
  product.onSale = options.some((option) => option.effective < option.regular);
  if (activeVariants.length > 0) {
    product.stock = activeVariants.reduce((sum, variant) => sum + variant.stock, 0);
  }
  product.inStock =
    product.availability === 'made_to_order' ||
    (product.availability === 'in_stock' &&
      (!product.trackInventory || options.some((o) => o.stock > 0)));
  product.rank = (product.isFeatured ? 2 : 0) + (product.isBestseller ? 1 : 0);
  if (product.status === 'published' && !product.publishedAt) product.publishedAt = new Date();
}

productSchema.pre('validate', function () {
  applyDerivedFields(this);
});

export const ProductModel = model<Product>('Product', productSchema);
export type ProductDocument = HydratedDocument<Product>;
