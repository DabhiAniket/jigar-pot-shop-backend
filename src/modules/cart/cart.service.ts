import { Types, type ClientSession } from 'mongoose';
import {
  calculatePricing,
  LIMITS,
  PROMO_CODE_MESSAGES,
  type CartIssue,
  type CartItemInput,
  type CartQuote,
  type CartQuoteLine,
  type FulfillmentMethod,
  type PricingResult,
  type PromotionRule,
} from '@jmh/shared';
import type { AppContext } from '../../context';
import {
  ProductModel,
  PromotionModel,
  type Product,
  type ProductVariant,
  type Promotion,
  type StoreSettingsDoc,
} from '../../db/models';
import { imageDTO } from '../../media/serialize';
import { getStoreSettings } from '../settings/settings.service';
import {
  effectiveAvailability,
  isTrackedStock,
  maxPurchasable,
  variantPrices,
} from '../catalog/product.serialize';

export interface ResolvedLine {
  key: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  requestedQuantity: number;
  product: Product | null;
  variant: ProductVariant | null;
  listPrice: number;
  unitPrice: number;
  maxQuantity: number;
  tracked: boolean;
  issue: CartIssue | null;
}

/** Merges duplicate lines (same product and variant) and caps quantities. */
export function mergeCartItems(items: readonly CartItemInput[]): CartItemInput[] {
  const merged = new Map<string, CartItemInput>();
  for (const item of items) {
    const key = `${item.productId}:${item.variantId ?? ''}`;
    const existing = merged.get(key);
    merged.set(key, {
      ...item,
      quantity: Math.min(LIMITS.maxLineQuantity, (existing?.quantity ?? 0) + item.quantity),
    });
  }
  return [...merged.values()];
}

/**
 * Looks every line up in the database: prices, stock and availability always come from the
 * server, never from the client.
 */
export async function resolveCartLines(
  items: readonly CartItemInput[],
  session?: ClientSession,
): Promise<ResolvedLine[]> {
  const merged = mergeCartItems(items);
  const ids = [...new Set(merged.map((item) => item.productId))].map(
    (id) => new Types.ObjectId(id),
  );
  const query = ProductModel.find(
    { _id: { $in: ids } },
    { description: 0, shippingInfo: 0, seo: 0, specs: 0, previousSlugs: 0 },
  );
  if (session) query.session(session);
  const products = await query.lean<Product[]>();
  const byId = new Map(products.map((product) => [product._id.toString(), product]));

  return merged.map((item) => {
    const key = `${item.productId}:${item.variantId ?? ''}`;
    const product = byId.get(item.productId) ?? null;
    const base: ResolvedLine = {
      key,
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      requestedQuantity: item.quantity,
      product,
      variant: null,
      listPrice: 0,
      unitPrice: 0,
      maxQuantity: 0,
      tracked: false,
      issue: null,
    };
    if (!product || product.status !== 'published') {
      return {
        ...base,
        issue: { code: 'not_found', message: 'This product is no longer available.' },
      };
    }

    const activeVariants = product.variants.filter((variant) => variant.isActive);
    let variant: ProductVariant | null = null;
    if (activeVariants.length > 0) {
      if (!item.variantId) {
        return {
          ...base,
          issue: { code: 'variant_required', message: 'Please choose an option for this product.' },
        };
      }
      variant =
        activeVariants.find((candidate) => candidate._id.toString() === item.variantId) ?? null;
      if (!variant) {
        return {
          ...base,
          issue: {
            code: 'variant_unavailable',
            message: 'The selected option is no longer available.',
          },
        };
      }
    } else if (item.variantId) {
      return {
        ...base,
        issue: {
          code: 'variant_unavailable',
          message: 'The selected option is no longer available.',
        },
      };
    }

    const prices = variant
      ? variantPrices(product, variant)
      : (() => {
          const salePrice =
            product.salePrice != null && product.salePrice < product.price
              ? product.salePrice
              : null;
          return { price: product.price, salePrice, effective: salePrice ?? product.price };
        })();
    const maxQuantity = maxPurchasable(product, variant);
    const resolved: ResolvedLine = {
      ...base,
      variant,
      listPrice: prices.price,
      unitPrice: prices.effective,
      maxQuantity,
      tracked: isTrackedStock(product),
    };

    if (effectiveAvailability(product, variant) === 'out_of_stock') {
      return {
        ...resolved,
        quantity: 0,
        issue: { code: 'out_of_stock', message: 'Out of stock.' },
      };
    }
    if (item.quantity > maxQuantity) {
      return {
        ...resolved,
        quantity: maxQuantity,
        issue: {
          code: 'insufficient_stock',
          message: `Only ${maxQuantity} available. Please reduce the quantity.`,
        },
      };
    }
    return resolved;
  });
}

export function toPromotionRule(promotion: Promotion): PromotionRule {
  return {
    id: promotion._id.toString(),
    name: promotion.name,
    type: promotion.type,
    value: promotion.value,
    maxDiscount: promotion.maxDiscount,
    minOrderValue: promotion.minOrderValue,
    scope: promotion.scope,
    categoryIds: promotion.categoryIds.map((id) => id.toString()),
    productIds: promotion.productIds.map((id) => id.toString()),
    code: promotion.code,
    startsAt: promotion.startsAt,
    endsAt: promotion.endsAt,
    isActive: promotion.isActive,
    priority: promotion.priority,
  };
}

export async function loadLivePromotions(
  now = new Date(),
  session?: ClientSession,
): Promise<PromotionRule[]> {
  const query = PromotionModel.find({
    isActive: true,
    startsAt: { $lte: now },
    endsAt: { $gt: now },
  });
  if (session) query.session(session);
  const promotions = await query.lean<Promotion[]>();
  return promotions.map(toPromotionRule);
}

export function priceLines(
  lines: readonly ResolvedLine[],
  promotions: readonly PromotionRule[],
  input: { promoCode: string | null; fulfillment: FulfillmentMethod },
  settings: StoreSettingsDoc,
  now = new Date(),
): PricingResult {
  return calculatePricing({
    lines: lines
      .filter((line) => !line.issue && line.quantity > 0)
      .map((line) => ({
        key: line.key,
        productId: line.productId,
        categoryId: line.product?.category?.toString() ?? null,
        unitPrice: line.unitPrice,
        quantity: line.quantity,
      })),
    promotions,
    promoCode: input.promoCode,
    fulfillment: input.fulfillment,
    delivery: settings.delivery,
    now,
  });
}

export async function quoteCart(
  ctx: AppContext,
  input: { items: CartItemInput[]; promoCode: string | null; fulfillment: FulfillmentMethod },
): Promise<CartQuote> {
  const [lines, promotions, settings] = await Promise.all([
    resolveCartLines(input.items),
    loadLivePromotions(),
    getStoreSettings(),
  ]);
  const pricing = priceLines(lines, promotions, input, settings);
  const priced = new Map(pricing.lines.map((line) => [line.key, line]));

  const quoteLines: CartQuoteLine[] = lines.map((line) => {
    const amounts = priced.get(line.key);
    return {
      key: line.key,
      productId: line.productId,
      variantId: line.variantId,
      slug: line.product?.slug ?? null,
      name: line.product?.name ?? 'Unavailable product',
      variantName: line.variant?.name ?? null,
      image: imageDTO(line.product?.images[0], ctx.storage),
      listPrice: line.listPrice,
      unitPrice: line.unitPrice,
      quantity: line.quantity,
      requestedQuantity: line.requestedQuantity,
      maxQuantity: line.maxQuantity,
      lineSubtotal: amounts?.lineSubtotal ?? 0,
      lineDiscount: amounts?.lineDiscount ?? 0,
      lineTotal: amounts?.lineTotal ?? 0,
      issue: line.issue,
    };
  });

  const promoBlocking =
    pricing.promoCode && ['invalid', 'inactive', 'not_eligible'].includes(pricing.promoCode.status);
  return {
    lines: quoteLines,
    subtotal: pricing.subtotal,
    discountTotal: pricing.discountTotal,
    deliveryCharge: pricing.deliveryCharge,
    total: pricing.total,
    appliedPromotion: pricing.appliedPromotion,
    promoCode: pricing.promoCode
      ? { ...pricing.promoCode, message: PROMO_CODE_MESSAGES[pricing.promoCode.status] }
      : null,
    fulfillment: input.fulfillment,
    fulfillmentAvailable: pricing.fulfillmentAvailable,
    delivery: settings.delivery,
    canCheckout:
      quoteLines.length > 0 &&
      quoteLines.every((line) => !line.issue) &&
      pricing.fulfillmentAvailable &&
      !promoBlocking,
  };
}
