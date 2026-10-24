import { describe, expect, it } from 'vitest';
import {
  buildOrderWhatsAppMessage,
  buildWhatsAppUrl,
  canTransitionOrder,
  checkPasswordStrength,
  checkoutSchema,
  discountPercent,
  formatINR,
  hasPermission,
  maskIndianMobile,
  normalizeIndianMobile,
  normalizeWhatsAppNumber,
  ORDER_STATUSES,
  productInputSchema,
  promotionInputSchema,
  slugify,
  transitionRestocksInventory,
} from '../src';

describe('money', () => {
  it('formats rupees in the Indian numbering system', () => {
    expect(formatINR(123456_00)).toBe('₹1,23,456');
    expect(formatINR(1234_50)).toBe('₹1,234.50');
    expect(formatINR(0)).toBe('₹0');
  });
  it('computes whole discount percentages', () => {
    expect(discountPercent(1000_00, 700_00)).toBe(30);
    expect(discountPercent(1000_00, null)).toBeNull();
    expect(discountPercent(1000_00, 1000_00)).toBeNull();
  });
});

describe('phone numbers', () => {
  it('normalises Indian mobiles', () => {
    expect(normalizeIndianMobile('+91 98765-43210')).toBe('9876543210');
    expect(normalizeIndianMobile('09876543210')).toBe('9876543210');
    expect(normalizeIndianMobile('5876543210')).toBeNull();
    expect(normalizeIndianMobile('98765')).toBeNull();
  });
  it('produces wa.me-compatible numbers', () => {
    expect(normalizeWhatsAppNumber('98765 43210')).toBe('919876543210');
    expect(normalizeWhatsAppNumber('+44 7700 900123')).toBe('447700900123');
    expect(normalizeWhatsAppNumber('abc')).toBeNull();
  });
  it('masks numbers for public pages', () => {
    expect(maskIndianMobile('9876543210')).toBe('+91 98•••••210');
  });
});

describe('order status machine', () => {
  it('allows the normal fulfilment path', () => {
    const path = [
      'pending',
      'confirmed',
      'processing',
      'ready_for_dispatch',
      'shipped',
      'delivered',
    ] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransitionOrder(path[i]!, path[i + 1]!)).toBe(true);
    }
  });
  it('blocks skipping steps, reopening and leaving terminal states', () => {
    expect(canTransitionOrder('pending', 'shipped')).toBe(false);
    expect(canTransitionOrder('delivered', 'pending')).toBe(false);
    expect(canTransitionOrder('cancelled', 'confirmed')).toBe(false);
    expect(canTransitionOrder('shipped', 'cancelled')).toBe(false);
    for (const status of ORDER_STATUSES) expect(canTransitionOrder('refunded', status)).toBe(false);
  });
  it('restocks only on cancellation', () => {
    expect(transitionRestocksInventory('cancelled')).toBe(true);
    expect(transitionRestocksInventory('refunded')).toBe(false);
  });
});

describe('permissions', () => {
  it('keeps customer data away from product managers', () => {
    expect(hasPermission('product_manager', 'products:write')).toBe(true);
    expect(hasPermission('product_manager', 'orders:read')).toBe(false);
    expect(hasPermission('product_manager', 'customers:read')).toBe(false);
    expect(hasPermission('product_manager', 'users:manage')).toBe(false);
  });
  it('lets order managers handle orders but not the catalogue or accounts', () => {
    expect(hasPermission('order_manager', 'orders:write')).toBe(true);
    expect(hasPermission('order_manager', 'products:write')).toBe(false);
    expect(hasPermission('order_manager', 'settings:write')).toBe(false);
  });
  it('grants super admins everything and nobody anything without a role', () => {
    expect(hasPermission('super_admin', 'audit:read')).toBe(true);
    expect(hasPermission(null, 'dashboard:read')).toBe(false);
  });
});

describe('WhatsApp', () => {
  const order = {
    storeName: 'Jigar Matka House',
    orderNumber: 'JMH-261020-7K3QX',
    customerName: 'Riya Patel',
    items: [
      { name: 'Classic Clay Matka', variantName: '10 L', quantity: 2, lineTotal: 1798_00 },
      { name: 'Clay Surahi', quantity: 1, lineTotal: 449_00 },
    ],
    subtotal: 2247_00,
    discountTotal: 224_70,
    deliveryCharge: 0,
    total: 2022_30,
    fulfillment: 'delivery' as const,
    address: {
      line1: '12 Shanti Nagar',
      city: 'Rajkot',
      state: 'Gujarat',
      pincode: '360001',
      landmark: 'Ram Mandir',
    },
  };

  it('builds the order message from the saved order', () => {
    const message = buildOrderWhatsAppMessage(order);
    expect(message).toContain('Hello Jigar Matka House!');
    expect(message).toContain('Order ID: JMH-261020-7K3QX');
    expect(message).toContain('- Classic Clay Matka (10 L) × 2 — ₹1,798');
    expect(message).toContain('Discount: -₹224.70');
    expect(message).toContain('Delivery: Free');
    expect(message).toContain('Total: ₹2,022.30');
    expect(message).toContain(
      'Delivery address: 12 Shanti Nagar, Near Ram Mandir, Rajkot, Gujarat 360001',
    );
  });

  it('describes pickup orders without an address', () => {
    const message = buildOrderWhatsAppMessage({ ...order, fulfillment: 'pickup', address: null });
    expect(message).toContain('Delivery: Store pickup');
    expect(message).toContain('pick up the order from the store');
  });

  it('produces an official, fully encoded click-to-chat URL', () => {
    const url = buildWhatsAppUrl('919876543210', 'Order: JMH-1 & ₹100\nThanks');
    expect(url).toBe(
      'https://wa.me/919876543210?text=Order%3A%20JMH-1%20%26%20%E2%82%B9100%0AThanks',
    );
    expect(() => buildWhatsAppUrl('+91 98765 43210', 'x')).toThrow();
  });
});

describe('slugify', () => {
  it('creates clean slugs', () => {
    expect(slugify('Classic Clay Matka — 10 L')).toBe('classic-clay-matka-10-l');
    expect(slugify('Diwali & Festival')).toBe('diwali-and-festival');
    expect(slugify('માટલું')).toBe('');
  });
});

describe('password policy', () => {
  it('rejects weak passwords and accepts strong ones', () => {
    expect(checkPasswordStrength('short')).not.toHaveLength(0);
    expect(checkPasswordStrength('alllowercaseletters')).not.toHaveLength(0);
    expect(
      checkPasswordStrength('owner.jigar!2026X', { email: 'owner@example.com' }),
    ).not.toHaveLength(0);
    expect(checkPasswordStrength('Terracotta-Kiln-48')).toHaveLength(0);
  });
});

describe('product validation', () => {
  const valid = { name: 'Classic Clay Matka', price: 899_00 };

  it('applies defaults', () => {
    const parsed = productInputSchema.parse(valid);
    expect(parsed.status).toBe('draft');
    expect(parsed.trackInventory).toBe(true);
    expect(parsed.images).toEqual([]);
  });

  it('rejects a sale price that is not lower than the price', () => {
    const result = productInputSchema.safeParse({ ...valid, salePrice: 899_00 });
    expect(result.success).toBe(false);
  });

  it('rejects fractional paise, negative stock and duplicate variants', () => {
    expect(productInputSchema.safeParse({ ...valid, price: 899.5 }).success).toBe(false);
    expect(productInputSchema.safeParse({ ...valid, stock: -1 }).success).toBe(false);
    expect(
      productInputSchema.safeParse({
        ...valid,
        variants: [
          { name: '5 L', stock: 1 },
          { name: '5 l', stock: 2 },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects operator objects (NoSQL injection attempts)', () => {
    expect(productInputSchema.safeParse({ ...valid, name: { $gt: '' } }).success).toBe(false);
  });
});

describe('checkout validation', () => {
  const base = {
    items: [{ productId: '64b7f0c2a1b2c3d4e5f60718', quantity: 1 }],
    fulfillment: 'delivery',
    channel: 'whatsapp',
    customer: { name: 'Riya Patel', phone: '+91 98765 43210' },
    address: { line1: '12 Shanti Nagar', city: 'Rajkot', state: 'Gujarat', pincode: '360001' },
  };

  it('normalises the phone number', () => {
    const parsed = checkoutSchema.parse(base);
    expect(parsed.customer.phone).toBe('9876543210');
    expect(parsed.customer.whatsapp).toBeNull();
  });

  it('requires an address for delivery but not for pickup', () => {
    expect(checkoutSchema.safeParse({ ...base, address: null }).success).toBe(false);
    expect(
      checkoutSchema.safeParse({ ...base, fulfillment: 'pickup', address: null }).success,
    ).toBe(true);
  });

  it('rejects bad phone numbers, PIN codes and quantities', () => {
    expect(
      checkoutSchema.safeParse({ ...base, customer: { name: 'A', phone: '12345' } }).success,
    ).toBe(false);
    expect(
      checkoutSchema.safeParse({ ...base, address: { ...base.address, pincode: '012345' } })
        .success,
    ).toBe(false);
    expect(
      checkoutSchema.safeParse({
        ...base,
        items: [{ productId: '64b7f0c2a1b2c3d4e5f60718', quantity: 500 }],
      }).success,
    ).toBe(false);
  });

  it('ignores client-supplied prices and totals', () => {
    const parsed = checkoutSchema.parse({
      ...base,
      total: 1,
      items: [{ ...base.items[0], price: 1 }],
    });
    expect(parsed).not.toHaveProperty('total');
    expect(parsed.items[0]).not.toHaveProperty('price');
  });
});

describe('promotion validation', () => {
  it('requires the end date after the start date and sane percentages', () => {
    const base = {
      name: 'Diwali Dhamaka',
      type: 'percentage',
      value: 30,
      startsAt: '2026-10-25T00:00:00+05:30',
      endsAt: '2026-11-05T00:00:00+05:30',
    };
    expect(promotionInputSchema.safeParse(base).success).toBe(true);
    expect(promotionInputSchema.safeParse({ ...base, endsAt: base.startsAt }).success).toBe(false);
    expect(promotionInputSchema.safeParse({ ...base, value: 95 }).success).toBe(false);
  });
});
