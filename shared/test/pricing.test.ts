import { describe, expect, it } from 'vitest';
import {
  allocateProportionally,
  calculateDeliveryCharge,
  calculatePricing,
  type DeliveryRules,
  type PricingLine,
  type PromotionRule,
} from '../src/pricing';

const now = new Date('2026-10-20T10:00:00Z');
const delivery: DeliveryRules = {
  deliveryEnabled: true,
  pickupEnabled: true,
  flatCharge: 150_00,
  freeDeliveryThreshold: 2000_00,
};

const line = (overrides: Partial<PricingLine> & { key: string }): PricingLine => ({
  productId: overrides.key,
  categoryId: 'cat-matka',
  unitPrice: 500_00,
  quantity: 1,
  ...overrides,
});

const promo = (overrides: Partial<PromotionRule> & { id: string }): PromotionRule => ({
  name: overrides.id,
  type: 'percentage',
  value: 10,
  maxDiscount: null,
  minOrderValue: null,
  scope: 'all',
  categoryIds: [],
  productIds: [],
  code: null,
  startsAt: '2026-10-01T00:00:00Z',
  endsAt: '2026-11-01T00:00:00Z',
  isActive: true,
  priority: 0,
  ...overrides,
});

describe('calculatePricing', () => {
  it('totals lines and adds the flat delivery charge below the free threshold', () => {
    const result = calculatePricing({
      lines: [line({ key: 'a', quantity: 2 }), line({ key: 'b', unitPrice: 349_50 })],
      promotions: [],
      fulfillment: 'delivery',
      delivery,
      now,
    });
    expect(result.subtotal).toBe(1349_50);
    expect(result.discountTotal).toBe(0);
    expect(result.deliveryCharge).toBe(150_00);
    expect(result.total).toBe(1499_50);
    expect(result.lines.map((l) => l.lineTotal)).toEqual([1000_00, 349_50]);
  });

  it('waives delivery once the discounted merchandise value reaches the threshold', () => {
    const result = calculatePricing({
      lines: [line({ key: 'a', unitPrice: 1000_00, quantity: 2 })],
      promotions: [],
      fulfillment: 'delivery',
      delivery,
      now,
    });
    expect(result.deliveryCharge).toBe(0);
    expect(result.total).toBe(2000_00);
  });

  it('charges delivery again when a discount takes the order below the threshold', () => {
    const result = calculatePricing({
      lines: [line({ key: 'a', unitPrice: 1000_00, quantity: 2 })],
      promotions: [promo({ id: 'p10', value: 10 })],
      fulfillment: 'delivery',
      delivery,
      now,
    });
    expect(result.discountTotal).toBe(200_00);
    expect(result.deliveryCharge).toBe(150_00);
    expect(result.total).toBe(1950_00);
  });

  it('never charges delivery for store pickup and reports when pickup is disabled', () => {
    const result = calculatePricing({
      lines: [line({ key: 'a' })],
      promotions: [],
      fulfillment: 'pickup',
      delivery: { ...delivery, pickupEnabled: false },
      now,
    });
    expect(result.deliveryCharge).toBe(0);
    expect(result.fulfillmentAvailable).toBe(false);
  });

  it('applies only the single best live promotion', () => {
    const result = calculatePricing({
      lines: [line({ key: 'a', unitPrice: 1000_00 })],
      promotions: [
        promo({ id: 'ten', value: 10 }),
        promo({ id: 'flat', type: 'fixed_amount', value: 150_00 }),
        promo({ id: 'expired', value: 50, endsAt: '2026-10-10T00:00:00Z' }),
        promo({ id: 'disabled', value: 40, isActive: false }),
        promo({ id: 'future', value: 30, startsAt: '2026-10-25T00:00:00Z' }),
      ],
      fulfillment: 'pickup',
      delivery,
      now,
    });
    expect(result.appliedPromotion).toEqual({
      id: 'flat',
      name: 'flat',
      code: null,
      amount: 150_00,
    });
    expect(result.total).toBe(850_00);
  });

  it('caps percentage promotions at maxDiscount', () => {
    const result = calculatePricing({
      lines: [line({ key: 'a', unitPrice: 5000_00 })],
      promotions: [promo({ id: 'p30', value: 30, maxDiscount: 500_00 })],
      fulfillment: 'pickup',
      delivery,
      now,
    });
    expect(result.discountTotal).toBe(500_00);
  });

  it('respects minimum order value', () => {
    const base = {
      promotions: [promo({ id: 'min', value: 10, minOrderValue: 1000_00 })],
      fulfillment: 'pickup' as const,
      delivery,
      now,
    };
    expect(
      calculatePricing({ ...base, lines: [line({ key: 'a', unitPrice: 999_99 })] }).discountTotal,
    ).toBe(0);
    expect(
      calculatePricing({ ...base, lines: [line({ key: 'a', unitPrice: 1000_00 })] }).discountTotal,
    ).toBe(100_00);
  });

  it('limits category- and product-scoped promotions to matching lines', () => {
    const lines = [
      line({ key: 'matka', categoryId: 'cat-matka', unitPrice: 1000_00 }),
      line({ key: 'planter', categoryId: 'cat-planter', unitPrice: 600_00 }),
    ];
    const byCategory = calculatePricing({
      lines,
      promotions: [
        promo({ id: 'planters', scope: 'categories', categoryIds: ['cat-planter'], value: 25 }),
      ],
      fulfillment: 'pickup',
      delivery,
      now,
    });
    expect(byCategory.discountTotal).toBe(150_00);
    expect(byCategory.lines.find((l) => l.key === 'matka')?.lineDiscount).toBe(0);
    expect(byCategory.lines.find((l) => l.key === 'planter')?.lineDiscount).toBe(150_00);

    const byProduct = calculatePricing({
      lines,
      promotions: [
        promo({
          id: 'one',
          scope: 'products',
          productIds: ['matka'],
          type: 'fixed_amount',
          value: 2000_00,
        }),
      ],
      fulfillment: 'pickup',
      delivery,
      now,
    });
    // A fixed discount can never exceed the value of the lines it covers.
    expect(byProduct.discountTotal).toBe(1000_00);
  });

  it('applies a valid promo code and reports its status', () => {
    const promotions = [promo({ id: 'code', code: 'DIWALI20', value: 20 })];
    const lines = [line({ key: 'a', unitPrice: 1000_00 })];
    const applied = calculatePricing({
      lines,
      promotions,
      promoCode: ' diwali20 ',
      fulfillment: 'pickup',
      delivery,
      now,
    });
    expect(applied.discountTotal).toBe(200_00);
    expect(applied.promoCode).toEqual({ code: 'DIWALI20', status: 'applied' });

    const withoutCode = calculatePricing({
      lines,
      promotions,
      fulfillment: 'pickup',
      delivery,
      now,
    });
    expect(withoutCode.discountTotal).toBe(0);

    const invalid = calculatePricing({
      lines,
      promotions,
      promoCode: 'NOPE',
      fulfillment: 'pickup',
      delivery,
      now,
    });
    expect(invalid.promoCode?.status).toBe('invalid');
  });

  it('keeps an automatic offer when it beats the entered code', () => {
    const result = calculatePricing({
      lines: [line({ key: 'a', unitPrice: 1000_00 })],
      promotions: [
        promo({ id: 'auto', value: 25 }),
        promo({ id: 'code', code: 'SAVE10', value: 10 }),
      ],
      promoCode: 'SAVE10',
      fulfillment: 'pickup',
      delivery,
      now,
    });
    expect(result.appliedPromotion?.id).toBe('auto');
    expect(result.promoCode?.status).toBe('better_offer_applied');
  });

  it('reports inactive and ineligible codes', () => {
    const lines = [line({ key: 'a', unitPrice: 100_00 })];
    const inactive = calculatePricing({
      lines,
      promotions: [
        promo({
          id: 'old',
          code: 'OLD10',
          endsAt: '2026-10-01T00:00:00Z',
          startsAt: '2026-09-01T00:00:00Z',
        }),
      ],
      promoCode: 'OLD10',
      fulfillment: 'pickup',
      delivery,
      now,
    });
    expect(inactive.promoCode?.status).toBe('inactive');
    const ineligible = calculatePricing({
      lines,
      promotions: [promo({ id: 'big', code: 'BIG', minOrderValue: 5000_00 })],
      promoCode: 'BIG',
      fulfillment: 'pickup',
      delivery,
      now,
    });
    expect(ineligible.promoCode?.status).toBe('not_eligible');
  });

  it('allocates the discount so line discounts sum exactly to the total', () => {
    const lines = [
      line({ key: 'a', unitPrice: 333_33 }),
      line({ key: 'b', unitPrice: 333_33 }),
      line({ key: 'c', unitPrice: 333_34, quantity: 3 }),
    ];
    const result = calculatePricing({
      lines,
      promotions: [promo({ id: 'odd', type: 'fixed_amount', value: 100_01 })],
      fulfillment: 'pickup',
      delivery,
      now,
    });
    const sum = result.lines.reduce((total, l) => total + l.lineDiscount, 0);
    expect(sum).toBe(100_01);
    expect(result.lines.every((l) => l.lineTotal === l.lineSubtotal - l.lineDiscount)).toBe(true);
    expect(result.total).toBe(result.subtotal - 100_01);
  });

  it('rejects invalid quantities and prices', () => {
    expect(() =>
      calculatePricing({
        lines: [line({ key: 'a', quantity: 0 })],
        promotions: [],
        fulfillment: 'pickup',
        delivery,
        now,
      }),
    ).toThrow(RangeError);
    expect(() =>
      calculatePricing({
        lines: [line({ key: 'a', unitPrice: 10.5 })],
        promotions: [],
        fulfillment: 'pickup',
        delivery,
        now,
      }),
    ).toThrow(RangeError);
  });
});

describe('allocateProportionally', () => {
  it('is exact for large amounts', () => {
    const allocation = allocateProportionally(9_999_999_99, [
      { key: 'x', subtotal: 7_777_777_77 },
      { key: 'y', subtotal: 3_333_333_33 },
      { key: 'z', subtotal: 1 },
    ]);
    const total = [...allocation.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(9_999_999_99);
  });
});

describe('calculateDeliveryCharge', () => {
  it('handles a missing free-delivery threshold', () => {
    expect(
      calculateDeliveryCharge('delivery', 99_999_00, { ...delivery, freeDeliveryThreshold: null }),
    ).toEqual({
      charge: 150_00,
      available: true,
    });
  });
});
