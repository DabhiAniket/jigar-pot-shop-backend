import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  InventoryMovementModel,
  OrderModel,
  ProductModel,
  PromotionModel,
  StoreSettingsModel,
} from '../../src/db/models';
import { invalidateSettingsCache } from '../../src/modules/settings/settings.service';
import {
  adminClient,
  checkoutBody,
  createCategory,
  createHarness,
  createPublishedProduct,
  ORIGIN,
  signedInAs,
  type Harness,
} from '../helpers/harness';

let harness: Harness;
beforeAll(async () => {
  harness = await createHarness();
});
afterAll(async () => {
  await harness.close();
});

async function configureDelivery(delivery: {
  deliveryEnabled: boolean;
  pickupEnabled: boolean;
  flatCharge: number;
  freeDeliveryThreshold: number | null;
}) {
  await StoreSettingsModel.updateOne(
    { _id: 'store' },
    { $set: { delivery: { ...delivery, note: null } } },
  );
  invalidateSettingsCache();
}

const address = { line1: '12 Shanti Nagar', city: 'Rajkot', state: 'Gujarat', pincode: '360001' };

function placeOrder(body: object, key: string = randomUUID()) {
  return harness
    .request()
    .post('/api/v1/orders')
    .set('Origin', ORIGIN)
    .set('Idempotency-Key', key)
    .send(body);
}

describe('cart quote', () => {
  beforeEach(async () => {
    await configureDelivery({
      deliveryEnabled: true,
      pickupEnabled: true,
      flatCharge: 120_00,
      freeDeliveryThreshold: 2000_00,
    });
  });

  it('prices lines from the database and ignores client-supplied prices', async () => {
    const product = await createPublishedProduct(harness, { price: 900_00, salePrice: 750_00 });
    const response = await harness
      .request()
      .post('/api/v1/cart/quote')
      .send({
        items: [{ productId: product.id, quantity: 2, price: 1 }],
        fulfillment: 'delivery',
        total: 1,
      });
    expect(response.status).toBe(200);
    const quote = response.body.data;
    expect(quote.lines[0]).toMatchObject({
      unitPrice: 750_00,
      listPrice: 900_00,
      lineTotal: 1500_00,
      issue: null,
    });
    expect(quote.subtotal).toBe(1500_00);
    expect(quote.deliveryCharge).toBe(120_00);
    expect(quote.total).toBe(1620_00);
    expect(quote.canCheckout).toBe(true);
  });

  it('flags unavailable lines instead of pricing them', async () => {
    const soldOut = await createPublishedProduct(harness, { stock: 0 });
    const scarce = await createPublishedProduct(harness, { stock: 2 });
    const response = await harness
      .request()
      .post('/api/v1/cart/quote')
      .send({
        items: [
          { productId: soldOut.id, quantity: 1 },
          { productId: scarce.id, quantity: 5 },
        ],
        fulfillment: 'pickup',
      });
    const [first, second] = response.body.data.lines;
    expect(first.issue.code).toBe('out_of_stock');
    expect(second.issue.code).toBe('insufficient_stock');
    expect(second.maxQuantity).toBe(2);
    expect(response.body.data.canCheckout).toBe(false);
  });

  it('requires a variant choice for products with variants', async () => {
    const product = await createPublishedProduct(harness, {
      variants: [
        { name: '5 L', stock: 3 },
        { name: '10 L', price: 1500_00, stock: 3 },
      ],
    });
    const response = await harness
      .request()
      .post('/api/v1/cart/quote')
      .send({ items: [{ productId: product.id, quantity: 1 }], fulfillment: 'pickup' });
    expect(response.body.data.lines[0].issue.code).toBe('variant_required');
    const big = product.variants.find((variant) => variant.name === '10 L')!;
    const ok = await harness
      .request()
      .post('/api/v1/cart/quote')
      .send({
        items: [{ productId: product.id, variantId: big._id.toString(), quantity: 1 }],
        fulfillment: 'pickup',
      });
    expect(ok.body.data.lines[0]).toMatchObject({
      unitPrice: 1500_00,
      variantName: '10 L',
      issue: null,
    });
  });

  it('applies live promotions and reports promo code status', async () => {
    const category = await createCategory('Festival Pots');
    const product = await createPublishedProduct(harness, {
      price: 1000_00,
      category: category._id,
    });
    const now = Date.now();
    await PromotionModel.create([
      {
        name: 'Diwali Dhamaka',
        type: 'percentage',
        value: 30,
        scope: 'categories',
        categoryIds: [category._id],
        startsAt: new Date(now - 3600_000),
        endsAt: new Date(now + 3600_000),
      },
      {
        name: 'Expired',
        type: 'percentage',
        value: 50,
        scope: 'all',
        startsAt: new Date(now - 7200_000),
        endsAt: new Date(now - 3600_000),
      },
      {
        name: 'Code',
        type: 'fixed_amount',
        value: 100_00,
        scope: 'all',
        code: 'CLAY100',
        startsAt: new Date(now - 3600_000),
        endsAt: new Date(now + 3600_000),
      },
    ]);
    const response = await harness
      .request()
      .post('/api/v1/cart/quote')
      .send({
        items: [{ productId: product.id, quantity: 1 }],
        fulfillment: 'pickup',
        promoCode: 'clay100',
      });
    const quote = response.body.data;
    expect(quote.appliedPromotion.name).toBe('Diwali Dhamaka');
    expect(quote.discountTotal).toBe(300_00);
    expect(quote.promoCode.status).toBe('better_offer_applied');
    await PromotionModel.deleteMany({});
  });
});

describe('order placement', () => {
  beforeEach(async () => {
    await configureDelivery({
      deliveryEnabled: true,
      pickupEnabled: true,
      flatCharge: 120_00,
      freeDeliveryThreshold: null,
    });
  });

  it('persists the order, reserves stock and records inventory movements', async () => {
    const product = await createPublishedProduct(harness, { price: 650_00, stock: 5 });
    const response = await placeOrder(
      checkoutBody([{ productId: product.id, quantity: 2 }], {
        fulfillment: 'delivery',
        address,
        customer: { name: 'Riya Patel', phone: '+91 98765 43210', whatsapp: '91234 56789' },
        notes: 'Please call before delivery',
      }),
    );
    expect(response.status).toBe(201);
    const { order, accessToken, replayed } = response.body.data;
    expect(replayed).toBe(false);
    expect(order.orderNumber).toMatch(/^JMH-\d{6}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(order.status).toBe('pending');
    expect(order.pricing).toMatchObject({
      subtotal: 1300_00,
      deliveryCharge: 120_00,
      total: 1420_00,
    });
    expect(order.phoneMasked).toBe('+91 98•••••210');
    expect(accessToken).toEqual(expect.any(String));

    const saved = await OrderModel.findOne({ orderNumber: order.orderNumber }).lean();
    expect(saved?.customer).toMatchObject({
      name: 'Riya Patel',
      phone: '9876543210',
      whatsapp: '9123456789',
    });
    expect(saved?.items[0]).toMatchObject({
      name: product.name,
      unitPrice: 650_00,
      quantity: 2,
      lineTotal: 1300_00,
    });
    expect((await ProductModel.findById(product._id).lean())?.stock).toBe(3);
    const movement = await InventoryMovementModel.findOne({ order: saved!._id }).lean();
    expect(movement).toMatchObject({ delta: -2, stockAfter: 3, reason: 'order_placed' });
  });

  it('builds the WhatsApp link from the saved order', async () => {
    const product = await createPublishedProduct(harness, {
      name: 'Classic Clay Matka',
      price: 899_00,
    });
    const response = await placeOrder(
      checkoutBody([{ productId: product.id, quantity: 1 }], { fulfillment: 'delivery', address }),
    );
    const { order } = response.body.data;
    const url = new URL(order.whatsappUrl);
    expect(url.origin + url.pathname).toBe('https://wa.me/919000000001');
    const text = url.searchParams.get('text')!;
    expect(text).toContain(`Order ID: ${order.orderNumber}`);
    expect(text).toContain('Customer: Riya Patel');
    expect(text).toContain('- Classic Clay Matka × 1 — ₹899');
    expect(text).toContain('Delivery: ₹120');
    expect(text).toContain('Total: ₹1,019');
    expect(text).toContain('Delivery address: 12 Shanti Nagar, Rajkot, Gujarat 360001');
  });

  it('is idempotent: retries with the same key return the same order without double-booking stock', async () => {
    const product = await createPublishedProduct(harness, { stock: 4 });
    const key = randomUUID();
    const body = checkoutBody([{ productId: product.id, quantity: 1 }]);
    const [first, second, third] = await Promise.all([
      placeOrder(body, key),
      placeOrder(body, key),
      placeOrder(body, key),
    ]);
    const statuses = [first.status, second.status, third.status].sort();
    expect(statuses).toEqual([200, 200, 201]);
    const numbers = new Set([first, second, third].map((r) => r.body.data.order.orderNumber));
    expect(numbers.size).toBe(1);
    expect(await OrderModel.countDocuments({ idempotencyKey: key })).toBe(1);
    expect((await ProductModel.findById(product._id).lean())?.stock).toBe(3);

    const changedBody = await placeOrder(
      checkoutBody([{ productId: product.id, quantity: 2 }]),
      key,
    );
    expect(changedBody.status).toBe(422);
  });

  it('never oversells under concurrent checkouts', async () => {
    const product = await createPublishedProduct(harness, { stock: 3 });
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        placeOrder(
          checkoutBody([{ productId: product.id, quantity: 1 }], {
            customer: { name: 'Buyer', phone: `98765432${10 + i}` },
          }),
        ),
      ),
    );
    const created = attempts.filter((response) => response.status === 201);
    expect(created).toHaveLength(3);
    expect(attempts.filter((response) => response.status === 409)).toHaveLength(5);
    const stored = await ProductModel.findById(product._id).lean();
    expect(stored?.stock).toBe(0);
    expect(stored?.inStock).toBe(false);
  });

  it('rejects stale carts, disabled fulfilment and invalid promo codes', async () => {
    const draft = await createPublishedProduct(harness);
    await ProductModel.updateOne({ _id: draft._id }, { $set: { status: 'draft' } });
    const unavailable = await placeOrder(checkoutBody([{ productId: draft.id, quantity: 1 }]));
    expect(unavailable.status).toBe(409);
    expect(unavailable.body.error.code).toBe('CART_CHANGED');

    const product = await createPublishedProduct(harness);
    await configureDelivery({
      deliveryEnabled: false,
      pickupEnabled: true,
      flatCharge: 0,
      freeDeliveryThreshold: null,
    });
    const noDelivery = await placeOrder(
      checkoutBody([{ productId: product.id, quantity: 1 }], { fulfillment: 'delivery', address }),
    );
    expect(noDelivery.status).toBe(400);
    expect(noDelivery.body.error.code).toBe('FULFILLMENT_UNAVAILABLE');

    const badCode = await placeOrder(
      checkoutBody([{ productId: product.id, quantity: 1 }], { promoCode: 'NOPE' }),
    );
    expect(badCode.status).toBe(409);
    expect(badCode.body.error.code).toBe('PROMO_CODE_REJECTED');
    expect(await OrderModel.countDocuments({ 'items.product': product._id })).toBe(0);
  });

  it('validates customer details', async () => {
    const product = await createPublishedProduct(harness);
    const response = await placeOrder(
      checkoutBody([{ productId: product.id, quantity: 1 }], {
        fulfillment: 'delivery',
        customer: { name: '', phone: '12345' },
        address: { ...address, pincode: '12' },
      }),
    );
    expect(response.status).toBe(400);
    expect(Object.keys(response.body.error.fields)).toEqual(
      expect.arrayContaining(['customer.name', 'customer.phone', 'address.pincode']),
    );
  });

  it('protects the confirmation page with the access token and tracking with the phone number', async () => {
    const product = await createPublishedProduct(harness);
    const { order, accessToken } = (
      await placeOrder(checkoutBody([{ productId: product.id, quantity: 1 }]))
    ).body.data;
    expect(
      (await harness.request().get(`/api/v1/orders/${order.orderNumber}?token=${accessToken}`))
        .status,
    ).toBe(200);
    expect(
      (await harness.request().get(`/api/v1/orders/${order.orderNumber}?token=wrong`)).status,
    ).toBe(404);
    expect((await harness.request().get(`/api/v1/orders/${order.orderNumber}`)).status).toBe(404);

    const tracked = await harness
      .request()
      .post('/api/v1/orders/track')
      .send({ orderNumber: order.orderNumber, phone: '9876543210' });
    expect(tracked.status).toBe(200);
    expect(tracked.body.data.status).toBe('pending');
    const wrongPhone = await harness
      .request()
      .post('/api/v1/orders/track')
      .send({ orderNumber: order.orderNumber, phone: '9876500000' });
    expect(wrongPhone.status).toBe(404);
  });
});

describe('order management', () => {
  beforeEach(async () => {
    await configureDelivery({
      deliveryEnabled: true,
      pickupEnabled: true,
      flatCharge: 0,
      freeDeliveryThreshold: null,
    });
  });

  it('moves through allowed statuses only and records who did what', async () => {
    const product = await createPublishedProduct(harness);
    const { order } = (await placeOrder(checkoutBody([{ productId: product.id, quantity: 1 }])))
      .body.data;
    const saved = await OrderModel.findOne({ orderNumber: order.orderNumber }).lean();
    const om = adminClient(await signedInAs(harness, 'order_manager'));

    const skip = await om.post(`/api/v1/admin/orders/${saved!._id}/status`, {
      status: 'delivered',
    });
    expect(skip.status).toBe(409);
    expect(skip.body.error.code).toBe('INVALID_TRANSITION');

    const confirmed = await om.post(`/api/v1/admin/orders/${saved!._id}/status`, {
      status: 'confirmed',
      note: 'Confirmed on WhatsApp',
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.status).toBe('confirmed');
    expect(confirmed.body.data.allowedTransitions).toEqual(['processing', 'cancelled']);
    const lastEvent = confirmed.body.data.statusHistory.at(-1);
    expect(lastEvent).toMatchObject({
      from: 'pending',
      to: 'confirmed',
      note: 'Confirmed on WhatsApp',
    });
    expect(lastEvent.byName).toMatch(/order manager/i);

    const note = await om.post(`/api/v1/admin/orders/${saved!._id}/notes`, {
      text: 'Customer prefers evening delivery',
    });
    expect(note.body.data.internalNotes).toHaveLength(1);
  });

  it('restocks exactly once when an order is cancelled', async () => {
    const product = await createPublishedProduct(harness, { stock: 2 });
    const { order } = (await placeOrder(checkoutBody([{ productId: product.id, quantity: 2 }])))
      .body.data;
    const saved = await OrderModel.findOne({ orderNumber: order.orderNumber }).lean();
    expect((await ProductModel.findById(product._id).lean())?.stock).toBe(0);

    const om = adminClient(await signedInAs(harness, 'order_manager'));
    const missingReason = await om.post(`/api/v1/admin/orders/${saved!._id}/status`, {
      status: 'cancelled',
    });
    expect(missingReason.status).toBe(400);

    const results = await Promise.all([
      om.post(`/api/v1/admin/orders/${saved!._id}/status`, {
        status: 'cancelled',
        cancellationReason: 'Customer changed mind',
      }),
      om.post(`/api/v1/admin/orders/${saved!._id}/status`, {
        status: 'cancelled',
        cancellationReason: 'Duplicate click',
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);

    const restored = await ProductModel.findById(product._id).lean();
    expect(restored?.stock).toBe(2);
    expect(restored?.inStock).toBe(true);
    expect(
      await InventoryMovementModel.countDocuments({ order: saved!._id, reason: 'order_cancelled' }),
    ).toBe(1);
    const cancelled = await OrderModel.findById(saved!._id).lean();
    expect(cancelled?.cancellationReason).toBeTruthy();
    expect(cancelled?.inventory.restockedAt).toBeInstanceOf(Date);
  });

  it('keeps historical orders accurate after the product changes', async () => {
    const product = await createPublishedProduct(harness, { name: 'Original Name', price: 500_00 });
    const { order } = (await placeOrder(checkoutBody([{ productId: product.id, quantity: 1 }])))
      .body.data;
    await ProductModel.updateOne(
      { _id: product._id },
      { $set: { name: 'Renamed', price: 999_00 } },
    );
    const saved = await OrderModel.findOne({ orderNumber: order.orderNumber }).lean();
    expect(saved?.items[0]).toMatchObject({ name: 'Original Name', unitPrice: 500_00 });
  });

  it('finds orders by number, phone and status', async () => {
    const product = await createPublishedProduct(harness);
    const { order } = (
      await placeOrder(
        checkoutBody([{ productId: product.id, quantity: 1 }], {
          customer: { name: 'Search Me', phone: '9988776655' },
        }),
      )
    ).body.data;
    const om = adminClient(await signedInAs(harness, 'order_manager'));
    expect((await om.get(`/api/v1/admin/orders?q=${order.orderNumber}`)).body.data).toHaveLength(1);
    expect((await om.get('/api/v1/admin/orders?q=99887%2076655')).body.data[0].orderNumber).toBe(
      order.orderNumber,
    );
    expect((await om.get('/api/v1/admin/orders?q=search%20me')).body.data[0].orderNumber).toBe(
      order.orderNumber,
    );
    const pending = await om.get('/api/v1/admin/orders?status=pending&limit=100');
    expect(pending.body.data.every((row: { status: string }) => row.status === 'pending')).toBe(
      true,
    );
  });
});
