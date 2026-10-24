import type { FulfillmentMethod, PromotionScope, PromotionType } from './constants';
import type { Paise } from './money';

/**
 * Pricing rules (the server is the only authority; clients just display the result):
 *  - `unitPrice` is what one unit costs today (the sale price when a product is on sale).
 *  - At most ONE promotion applies per order: the one giving the largest discount among
 *    live automatic promotions and the promotion matching an entered code.
 *  - A promotion's discount is computed on the subtotal of the lines it covers and is
 *    spread across those lines proportionally, so line discounts always sum exactly.
 *  - Delivery is free for pickup; otherwise a flat charge that is waived once the
 *    discounted merchandise value reaches the free-delivery threshold.
 */

export interface PricingLine {
  key: string;
  productId: string;
  categoryId: string | null;
  unitPrice: Paise;
  quantity: number;
}

export interface PromotionRule {
  id: string;
  name: string;
  type: PromotionType;
  /** Percent (1–90) for percentage promotions, paise for fixed-amount promotions. */
  value: number;
  /** Upper bound on the discount of a percentage promotion. */
  maxDiscount: Paise | null;
  /** Minimum cart subtotal for the promotion to apply. */
  minOrderValue: Paise | null;
  scope: PromotionScope;
  categoryIds: readonly string[];
  productIds: readonly string[];
  /** Upper-case coupon code; null means the promotion applies automatically. */
  code: string | null;
  startsAt: Date | string;
  endsAt: Date | string;
  isActive: boolean;
  priority: number;
}

export interface DeliveryRules {
  deliveryEnabled: boolean;
  pickupEnabled: boolean;
  flatCharge: Paise;
  freeDeliveryThreshold: Paise | null;
}

export type PromoCodeStatus =
  'applied' | 'invalid' | 'inactive' | 'not_eligible' | 'better_offer_applied';

export const PROMO_CODE_MESSAGES: Record<PromoCodeStatus, string> = {
  applied: 'Promo code applied.',
  invalid: 'This promo code is not valid.',
  inactive: 'This promo code is not active right now.',
  not_eligible: 'Your cart does not meet the conditions for this promo code.',
  better_offer_applied: 'A better offer is already applied to your order.',
};

export interface PricingInput {
  lines: readonly PricingLine[];
  promotions: readonly PromotionRule[];
  promoCode?: string | null;
  fulfillment: FulfillmentMethod;
  delivery: DeliveryRules;
  now?: Date;
}

export interface PricedLine {
  key: string;
  lineSubtotal: Paise;
  lineDiscount: Paise;
  lineTotal: Paise;
}

export interface AppliedPromotion {
  id: string;
  name: string;
  code: string | null;
  amount: Paise;
}

export interface PricingResult {
  lines: PricedLine[];
  subtotal: Paise;
  discountTotal: Paise;
  deliveryCharge: Paise;
  total: Paise;
  appliedPromotion: AppliedPromotion | null;
  promoCode: { code: string; status: PromoCodeStatus } | null;
  /** False when the chosen fulfilment method is switched off in store settings. */
  fulfillmentAvailable: boolean;
}

export function normalizePromoCode(code: string | null | undefined): string | null {
  const trimmed = code?.trim().toUpperCase();
  return trimmed ? trimmed : null;
}

export function isPromotionLive(promotion: PromotionRule, now: Date): boolean {
  if (!promotion.isActive) return false;
  const starts = new Date(promotion.startsAt).getTime();
  const ends = new Date(promotion.endsAt).getTime();
  const t = now.getTime();
  return starts <= t && t < ends;
}

function lineInScope(promotion: PromotionRule, line: PricingLine): boolean {
  switch (promotion.scope) {
    case 'all':
      return true;
    case 'categories':
      return line.categoryId !== null && promotion.categoryIds.includes(line.categoryId);
    case 'products':
      return promotion.productIds.includes(line.productId);
  }
}

interface Evaluation {
  promotion: PromotionRule;
  amount: Paise;
  eligible: { key: string; subtotal: Paise }[];
}

function evaluatePromotion(
  promotion: PromotionRule,
  lines: readonly PricingLine[],
  cartSubtotal: Paise,
): Evaluation | null {
  if (promotion.minOrderValue != null && cartSubtotal < promotion.minOrderValue) return null;
  const eligible = lines
    .filter((line) => lineInScope(promotion, line))
    .map((line) => ({ key: line.key, subtotal: line.unitPrice * line.quantity }))
    .filter((line) => line.subtotal > 0);
  const base = eligible.reduce((sum, line) => sum + line.subtotal, 0);
  if (base <= 0) return null;

  let amount: number;
  if (promotion.type === 'percentage') {
    const percent = Math.min(Math.max(promotion.value, 0), 100);
    amount = Number((BigInt(base) * BigInt(Math.round(percent * 100))) / 10000n);
    if (promotion.maxDiscount != null) amount = Math.min(amount, promotion.maxDiscount);
  } else {
    amount = Math.max(0, Math.floor(promotion.value));
  }
  amount = Math.min(amount, base);
  return amount > 0 ? { promotion, amount, eligible } : null;
}

/** Splits `amount` across lines in proportion to their subtotals using exact integer maths. */
export function allocateProportionally(
  amount: Paise,
  lines: readonly { key: string; subtotal: Paise }[],
): Map<string, Paise> {
  const result = new Map<string, Paise>();
  const base = lines.reduce((sum, line) => sum + line.subtotal, 0);
  if (amount <= 0 || base <= 0) return result;

  const bigAmount = BigInt(amount);
  const bigBase = BigInt(base);
  const shares = lines.map((line, index) => {
    const numerator = bigAmount * BigInt(line.subtotal);
    return { key: line.key, index, floor: numerator / bigBase, remainder: numerator % bigBase };
  });

  let leftover = amount - shares.reduce((sum, share) => sum + Number(share.floor), 0);
  const byRemainder = [...shares].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const share of byRemainder) {
    const extra = leftover > 0 ? 1 : 0;
    leftover -= extra;
    result.set(share.key, Number(share.floor) + extra);
  }
  return result;
}

function compareEvaluations(a: Evaluation, b: Evaluation): number {
  if (a.amount !== b.amount) return b.amount - a.amount;
  if (a.promotion.priority !== b.promotion.priority)
    return b.promotion.priority - a.promotion.priority;
  // Prefer automatic offers on ties so an entered code never looks like it "lost" money.
  if ((a.promotion.code === null) !== (b.promotion.code === null)) {
    return a.promotion.code === null ? -1 : 1;
  }
  return a.promotion.id < b.promotion.id ? -1 : a.promotion.id > b.promotion.id ? 1 : 0;
}

export function calculateDeliveryCharge(
  fulfillment: FulfillmentMethod,
  merchandiseTotal: Paise,
  delivery: DeliveryRules,
): { charge: Paise; available: boolean } {
  if (fulfillment === 'pickup') return { charge: 0, available: delivery.pickupEnabled };
  if (merchandiseTotal <= 0) return { charge: 0, available: delivery.deliveryEnabled };
  const free =
    delivery.freeDeliveryThreshold != null && merchandiseTotal >= delivery.freeDeliveryThreshold;
  return { charge: free ? 0 : delivery.flatCharge, available: delivery.deliveryEnabled };
}

export function calculatePricing(input: PricingInput): PricingResult {
  const now = input.now ?? new Date();
  for (const line of input.lines) {
    if (!Number.isSafeInteger(line.unitPrice) || line.unitPrice < 0) {
      throw new RangeError(`Invalid unit price for line ${line.key}`);
    }
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new RangeError(`Invalid quantity for line ${line.key}`);
    }
  }

  const subtotal = input.lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  const code = normalizePromoCode(input.promoCode);

  const candidates: Evaluation[] = [];
  let codeEvaluation: Evaluation | null = null;
  let codeStatus: PromoCodeStatus | null = code ? 'invalid' : null;

  for (const promotion of input.promotions) {
    const matchesCode = code !== null && promotion.code === code;
    if (promotion.code !== null && !matchesCode) continue;
    if (!isPromotionLive(promotion, now)) {
      if (matchesCode) codeStatus = 'inactive';
      continue;
    }
    const evaluation = evaluatePromotion(promotion, input.lines, subtotal);
    if (matchesCode) {
      codeStatus = evaluation ? 'applied' : 'not_eligible';
      codeEvaluation = evaluation;
    }
    if (evaluation) candidates.push(evaluation);
  }

  candidates.sort(compareEvaluations);
  const best = candidates[0] ?? null;
  if (codeEvaluation && best && best !== codeEvaluation) codeStatus = 'better_offer_applied';

  const allocation = best ? allocateProportionally(best.amount, best.eligible) : new Map();
  const lines: PricedLine[] = input.lines.map((line) => {
    const lineSubtotal = line.unitPrice * line.quantity;
    const lineDiscount = allocation.get(line.key) ?? 0;
    return { key: line.key, lineSubtotal, lineDiscount, lineTotal: lineSubtotal - lineDiscount };
  });

  const discountTotal = best?.amount ?? 0;
  const delivery = calculateDeliveryCharge(
    input.fulfillment,
    subtotal - discountTotal,
    input.delivery,
  );

  return {
    lines,
    subtotal,
    discountTotal,
    deliveryCharge: delivery.charge,
    total: subtotal - discountTotal + delivery.charge,
    appliedPromotion: best
      ? {
          id: best.promotion.id,
          name: best.promotion.name,
          code: best.promotion.code,
          amount: best.amount,
        }
      : null,
    promoCode: code && codeStatus ? { code, status: codeStatus } : null,
    fulfillmentAvailable: delivery.available,
  };
}
