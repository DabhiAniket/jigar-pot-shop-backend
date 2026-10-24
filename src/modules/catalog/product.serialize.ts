import {
  LIMITS,
  type AdminProductDetail,
  type AdminProductListItem,
  type Availability,
  type CategorySummary,
  type ProductDetail,
  type ProductSummary,
  type VariantDTO,
} from '@jmh/shared';
import type { Category, Product, ProductVariant } from '../../db/models';
import { imageDTO, thumbnailUrl } from '../../media/serialize';
import type { Storage } from '../../storage/storage';

type ProductLike = Pick<
  Product,
  | 'availability'
  | 'trackInventory'
  | 'stock'
  | 'lowStockThreshold'
  | 'price'
  | 'salePrice'
  | 'variants'
>;

export function isTrackedStock(product: Pick<Product, 'availability' | 'trackInventory'>): boolean {
  return product.trackInventory && product.availability === 'in_stock';
}

/** What a customer can actually do right now, for the product or one of its variants. */
export function effectiveAvailability(
  product: ProductLike,
  variant?: ProductVariant | null,
): Availability {
  if (product.availability !== 'in_stock') return product.availability;
  if (!product.trackInventory) return 'in_stock';
  const stock = variant ? variant.stock : product.stock;
  return stock > 0 ? 'in_stock' : 'out_of_stock';
}

export function maxPurchasable(product: ProductLike, variant?: ProductVariant | null): number {
  const availability = effectiveAvailability(product, variant);
  if (availability === 'out_of_stock') return 0;
  if (!isTrackedStock(product)) return LIMITS.maxLineQuantity;
  return Math.min(variant ? variant.stock : product.stock, LIMITS.maxLineQuantity);
}

export function isLowStock(product: ProductLike, variant?: ProductVariant | null): boolean {
  if (!isTrackedStock(product)) return false;
  const stock = variant ? variant.stock : product.stock;
  return stock > 0 && stock <= product.lowStockThreshold;
}

export function variantPrices(
  product: Pick<Product, 'price' | 'salePrice'>,
  variant: ProductVariant,
) {
  const price = variant.price ?? product.price;
  const salePrice =
    variant.salePrice != null && variant.salePrice < price ? variant.salePrice : null;
  return { price, salePrice, effective: salePrice ?? price };
}

function cheapestOption(product: ProductLike) {
  const active = product.variants.filter((variant) => variant.isActive);
  if (active.length === 0) {
    const salePrice =
      product.salePrice != null && product.salePrice < product.price ? product.salePrice : null;
    return { price: product.price, salePrice };
  }
  const options = active
    .map((variant) => variantPrices(product, variant))
    .sort((a, b) => a.effective - b.effective);
  return { price: options[0]!.price, salePrice: options[0]!.salePrice };
}

export function categorySummary(
  category: Pick<Category, '_id' | 'name' | 'nameGu' | 'slug'> | null | undefined,
): CategorySummary | null {
  if (!category) return null;
  return {
    id: category._id.toString(),
    name: category.name,
    nameGu: category.nameGu,
    slug: category.slug,
  };
}

export function productSummaryDTO(
  product: Product,
  categories: Map<string, CategorySummary>,
  storage: Storage,
): ProductSummary {
  const cheapest = cheapestOption(product);
  const activeVariants = product.variants.filter((variant) => variant.isActive);
  // For variant products `stock` holds the sum of active variant stock (see applyDerivedFields).
  const availability = effectiveAvailability(product);
  return {
    id: product._id.toString(),
    name: product.name,
    nameGu: product.nameGu,
    slug: product.slug,
    category: product.category ? (categories.get(product.category.toString()) ?? null) : null,
    image: imageDTO(product.images[0], storage),
    secondaryImage: imageDTO(product.images[1], storage),
    price: cheapest.price,
    salePrice: cheapest.salePrice,
    effectivePrice: product.minEffectivePrice,
    hasPriceRange: product.minEffectivePrice !== product.maxEffectivePrice,
    hasVariants: activeVariants.length > 0,
    availability,
    lowStock: activeVariants.length === 0 && isLowStock(product),
    isFeatured: product.isFeatured,
    isBestseller: product.isBestseller,
    publishedAt: product.publishedAt?.toISOString() ?? null,
  };
}

export function variantDTO(product: Product, variant: ProductVariant): VariantDTO {
  const prices = variantPrices(product, variant);
  return {
    id: variant._id.toString(),
    name: variant.name,
    sku: variant.sku,
    price: prices.price,
    salePrice: prices.salePrice,
    availability: effectiveAvailability(product, variant),
    maxQuantity: maxPurchasable(product, variant),
    lowStock: isLowStock(product, variant),
  };
}

export function productDetailDTO(
  product: Product,
  categories: Map<string, CategorySummary>,
  storage: Storage,
): ProductDetail {
  const summary = productSummaryDTO(product, categories, storage);
  const variants = product.variants
    .filter((variant) => variant.isActive)
    .map((variant) => variantDTO(product, variant));
  return {
    ...summary,
    sku: product.sku,
    shortDescription: product.shortDescription,
    description: product.description,
    images: product.images
      .map((image) => imageDTO(image, storage))
      .filter((image) => image !== null),
    variants,
    specs: {
      material: product.specs?.material ?? null,
      finish: product.specs?.finish ?? null,
      color: product.specs?.color ?? null,
      heightCm: product.specs?.heightCm ?? null,
      widthCm: product.specs?.widthCm ?? null,
      depthCm: product.specs?.depthCm ?? null,
      diameterCm: product.specs?.diameterCm ?? null,
      capacityLitres: product.specs?.capacityLitres ?? null,
      weightKg: product.specs?.weightKg ?? null,
    },
    shippingInfo: product.shippingInfo,
    tags: product.tags,
    seo: { title: product.seo?.title ?? null, description: product.seo?.description ?? null },
    maxQuantity: variants.length ? 0 : maxPurchasable(product),
    lowStock: variants.length ? false : isLowStock(product),
    updatedAt: product.updatedAt.toISOString(),
  };
}

export function adminProductListItem(
  product: Product,
  categories: Map<string, CategorySummary>,
  storage: Storage,
): AdminProductListItem {
  return {
    id: product._id.toString(),
    name: product.name,
    slug: product.slug,
    sku: product.sku,
    status: product.status,
    category: product.category ? (categories.get(product.category.toString()) ?? null) : null,
    thumbnail: thumbnailUrl(product.images[0], storage),
    price: product.price,
    salePrice: product.salePrice,
    stock: product.stock,
    trackInventory: product.trackInventory,
    hasVariants: product.variants.length > 0,
    lowStock: product.trackInventory && product.stock <= product.lowStockThreshold,
    isFeatured: product.isFeatured,
    isBestseller: product.isBestseller,
    updatedAt: product.updatedAt.toISOString(),
  };
}

export function adminProductDetail(product: Product, storage: Storage): AdminProductDetail {
  return {
    id: product._id.toString(),
    name: product.name,
    nameGu: product.nameGu,
    slug: product.slug,
    sku: product.sku,
    categoryId: product.category?.toString() ?? null,
    shortDescription: product.shortDescription,
    description: product.description,
    price: product.price,
    salePrice: product.salePrice,
    trackInventory: product.trackInventory,
    stock: product.stock,
    lowStockThreshold: product.lowStockThreshold,
    availability: product.availability,
    images: product.images
      .map((image) => imageDTO(image, storage))
      .filter((image) => image !== null)
      .map((image) => ({ ...image, status: 'ready' as const })),
    variants: product.variants.map((variant) => ({
      id: variant._id.toString(),
      name: variant.name,
      sku: variant.sku,
      price: variant.price,
      salePrice: variant.salePrice,
      stock: variant.stock,
      isActive: variant.isActive,
    })),
    specs: {
      material: product.specs?.material ?? null,
      finish: product.specs?.finish ?? null,
      color: product.specs?.color ?? null,
      heightCm: product.specs?.heightCm ?? null,
      widthCm: product.specs?.widthCm ?? null,
      depthCm: product.specs?.depthCm ?? null,
      diameterCm: product.specs?.diameterCm ?? null,
      capacityLitres: product.specs?.capacityLitres ?? null,
      weightKg: product.specs?.weightKg ?? null,
    },
    shippingInfo: product.shippingInfo,
    tags: product.tags,
    isFeatured: product.isFeatured,
    isBestseller: product.isBestseller,
    status: product.status,
    seo: { title: product.seo?.title ?? null, description: product.seo?.description ?? null },
    previousSlugs: product.previousSlugs,
    publishedAt: product.publishedAt?.toISOString() ?? null,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}
