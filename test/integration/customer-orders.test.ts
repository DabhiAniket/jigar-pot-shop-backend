import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrderModel, ServerCartModel, StoreSettingsModel } from '../../src/db/models';
import { invalidateSettingsCache } from '../../src/modules/settings/settings.service';
import {
  adminClient,
  checkoutBody,
  createHarness,
  createPublishedProduct,
  customerClient,
  ORIGIN,
  registerCustomer,
  signedInAs,
  type Harness,
  type SignedInCustomer,
} from '../helpers/harness';

let harness: Harness;
let alice: SignedInCustomer;
let bob: SignedInCustomer;
let a: ReturnType<typeof customerClient>;
let b: ReturnType<typeof customerClient>;
let staff: ReturnType<typeof adminClient>;

beforeAll(async () => {
  harness = await createHarness();
  await StoreSettingsModel.updateOne(
    { _id: 'store' },
    {
      $set: {
        delivery: {
          deliveryEnabled: true,
          pickupEnabled: true,
          flatCharge: 100_00,
          freeDeliveryThreshold: null,
          note: null,
        },
      },
    },
  );
  invalidateSettingsCache();
  alice = await registerCustomer(harness, { name: 'Alice Shah', phone: '9876500001' });
  bob = await registerCustomer(harness, { name: 'Bob Mehta', phone: '9876500002' });
  a = customerClient(alice);
  b = customerClient(bob);
  staff = adminClient(await signedInAs(harness, 'order_manager'));
});
afterAll(async () => {
  await harness.close();
});

const address = { line1: '12 Shanti Nagar', city: 'Rajkot', state: 'Gujarat', pincode: '360001' };

async function aliceOrders(fulfillment: 'delivery' | 'pickup' = 'pickup') {
  const product = await createPublishedProduct(harness, { stock: 20 });
  const response = await a
    .post(
      '/api/v1/orders',
      checkoutBody([{ productId: product.id, quantity: 1 }], {
        fulfillment,
        address: fulfillment === 'delivery' ? address : null,
      }),
    )
    .set('Idempotency-Key', randomUUID());
  expect(response.status).toBe(201);
  const order = await OrderModel.findOne({
    orderNumber: response.body.data.order.orderNumber,
  }).lean();
  return {
    number: response.body.data.order.orderNumber as string,
    id: order!._id.toString(),
    product,
  };
}

describe('customer accounts', () => {
  it('registers, signs in and out with a session cookie', async () => {
    const fresh = await registerCustomer(harness, { name: 'Dev Patel' });
    const client = customerClient(fresh);
    const me = await client.get('/api/v1/account/me');
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ name: 'Dev Patel', email: fresh.email });
    expect(JSON.stringify(me.body)).not.toMatch(/passwordHash/);

    expect((await client.post('/api/v1/account/logout')).status).toBe(204);
    expect((await client.get('/api/v1/account/me')).status).toBe(401);

    const again = await harness
      .request()
      .post('/api/v1/account/login')
      .set('Origin', ORIGIN)
      .send({ email: fresh.email, password: 'Terracotta-Kiln-48' });
    expect(again.status).toBe(200);
  });

  it('rejects wrong passwords and duplicate emails without revealing which accounts exist', async () => {
    const wrong = await harness
      .request()
      .post('/api/v1/account/login')
      .set('Origin', ORIGIN)
      .send({ email: alice.email, password: 'wrong-password' });
    const unknown = await harness
      .request()
      .post('/api/v1/account/login')
      .set('Origin', ORIGIN)
      .send({ email: 'nobody@example.com', password: 'wrong-password' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);

    const duplicate = await harness
      .request()
      .post('/api/v1/account/register')
      .set('Origin', ORIGIN)
      .send({
        name: 'Alice Shah',
        email: alice.email,
        phone: '9876500001',
        password: 'Terracotta-Kiln-48',
      });
    expect(duplicate.status).toBe(400);
  });

  it('requires the CSRF token on customer mutations and a session on every account route', async () => {
    const noCsrf = await alice.agent
      .patch('/api/v1/account/me')
      .set('Origin', ORIGIN)
      .send({ name: 'Alice Shah', phone: '9876500001' });
    expect(noCsrf.status).toBe(403);

    const anonymous = harness.request();
    for (const path of ['/me', '/cart', '/orders', '/orders/JMH-260101-ABCDE']) {
      expect((await anonymous.get(`/api/v1/account${path}`)).status, path).toBe(401);
    }
  });

  it('keeps customer sessions out of the admin API and admin sessions out of customer routes', async () => {
    expect((await alice.agent.get('/api/v1/admin/orders')).status).toBe(401);
    expect((await alice.agent.get('/api/v1/admin/auth/me')).status).toBe(401);
    const adminAgent = (await signedInAs(harness, 'super_admin')).agent;
    expect((await adminAgent.get('/api/v1/account/orders')).status).toBe(401);
  });

  it('saves addresses per account', async () => {
    const created = await a.post('/api/v1/account/addresses', { ...address, label: 'Home' });
    expect(created.status).toBe(201);
    expect(created.body.data.addresses).toHaveLength(1);
    expect(created.body.data.addresses[0]).toMatchObject({ label: 'Home', isDefault: true });
    expect((await b.get('/api/v1/account/me')).body.data.addresses).toHaveLength(0);
    const id = created.body.data.addresses[0].id;
    // Bob cannot change or remove Alice's address by guessing its id.
    await b.put(`/api/v1/account/addresses/${id}`, { ...address, line1: 'Hacked' });
    await b.delete(`/api/v1/account/addresses/${id}`);
    expect((await a.get('/api/v1/account/me')).body.data.addresses[0].line1).toBe(address.line1);
  });
});

describe('order ownership: Customer B can never reach Customer A’s order', () => {
  it('lists, reads and tracks only the signed-in customer’s own orders', async () => {
    const mine = await aliceOrders();
    const aliceList = await a.get('/api/v1/account/orders');
    expect(aliceList.body.data.map((o: { orderNumber: string }) => o.orderNumber)).toContain(
      mine.number,
    );
    expect((await a.get(`/api/v1/account/orders/${mine.number}`)).status).toBe(200);

    // Bob knows the exact order number and still sees nothing.
    const bobList = await b.get('/api/v1/account/orders');
    expect(bobList.body.data).toEqual([]);
    expect(bobList.body.meta.total).toBe(0);
    const bobRead = await b.get(`/api/v1/account/orders/${mine.number}`);
    const missing = await b.get('/api/v1/account/orders/JMH-260101-ZZZZZ');
    expect(bobRead.status).toBe(404);
    // Indistinguishable from an order that does not exist: nothing about Alice leaks.
    expect(bobRead.body.error.code).toBe(missing.body.error.code);
    expect(bobRead.body.error.message).toBe(missing.body.error.message);
    expect(JSON.stringify(bobRead.body)).not.toMatch(/Alice|9876500001/);
  });

  it('blocks cancelling, and ignores any owner supplied in the request', async () => {
    const mine = await aliceOrders();
    const attempt = await b.post(`/api/v1/account/orders/${mine.number}/cancellation-request`, {
      reason: 'Not my order but trying anyway',
    });
    expect(attempt.status).toBe(404);
    const forged = await b
      .post(`/api/v1/account/orders/${mine.number}/cancellation-request`, {
        reason: 'Forged owner field',
        accountId: alice.id,
        customerId: alice.id,
      })
      .query({ accountId: alice.id });
    expect(forged.status).toBe(404);
    expect((await OrderModel.findById(mine.id).lean())!.cancellationRequest).toBeNull();
    expect((await b.get(`/api/v1/account/orders?accountId=${alice.id}`)).body.data).toEqual([]);
  });

  it('does not let the legacy token or phone lookups expose an owned order', async () => {
    const mine = await aliceOrders();
    const byPhone = await harness
      .request()
      .post('/api/v1/orders/track')
      .send({ orderNumber: mine.number, phone: '9876543210' });
    expect(byPhone.status).toBe(404);
    expect((await harness.request().get(`/api/v1/orders/${mine.number}`)).status).toBe(404);
  });

  it('assigns a new order to the session account even if the body names someone else', async () => {
    const product = await createPublishedProduct(harness, { stock: 5 });
    const response = await b
      .post('/api/v1/orders', {
        ...checkoutBody([{ productId: product.id, quantity: 1 }]),
        accountId: alice.id,
        customerId: alice.id,
      })
      .set('Idempotency-Key', randomUUID());
    expect(response.status).toBe(201);
    const order = await OrderModel.findOne({
      orderNumber: response.body.data.order.orderNumber,
    }).lean();
    expect(order!.accountId!.toString()).toBe(bob.id);
    expect((await a.get(`/api/v1/account/orders/${order!.orderNumber}`)).status).toBe(404);
  });

  it('does not replay one customer’s order to another who reuses its idempotency key', async () => {
    const product = await createPublishedProduct(harness, { stock: 5 });
    const key = randomUUID();
    const body = checkoutBody([{ productId: product.id, quantity: 1 }]);
    const first = await a.post('/api/v1/orders', body).set('Idempotency-Key', key);
    expect(first.status).toBe(201);
    const stolen = await b.post('/api/v1/orders', body).set('Idempotency-Key', key);
    expect(stolen.status).toBe(422);
    expect(JSON.stringify(stolen.body)).not.toContain(first.body.data.order.orderNumber);
    expect(
      await OrderModel.countDocuments({ accountId: bob.id, 'items.product': product._id }),
    ).toBe(0);
  });

  it('shows customers only customer-safe fields', async () => {
    const mine = await aliceOrders();
    await staff.post(`/api/v1/admin/orders/${mine.id}/notes`, { text: 'INTERNAL: fraud check' });
    const dto = (await a.get(`/api/v1/account/orders/${mine.number}`)).body.data;
    expect(JSON.stringify(dto)).not.toMatch(
      /INTERNAL|internalNotes|idempotency|requestHash|byName/,
    );
  });
});

describe('server cart', () => {
  it('keeps each customer’s cart private and persistent', async () => {
    const product = await createPublishedProduct(harness, { price: 500_00, stock: 9 });
    const put = await a.put('/api/v1/account/cart/items', { productId: product.id, quantity: 3 });
    expect(put.status).toBe(200);
    expect(put.body.data.items).toEqual([{ productId: product.id, variantId: null, quantity: 3 }]);
    // "Survives refresh / login": a fresh session of the same account sees the same cart.
    const again = await harness
      .request()
      .post('/api/v1/account/login')
      .set('Origin', ORIGIN)
      .send({ email: alice.email, password: 'Terracotta-Kiln-48' });
    expect(again.status).toBe(200);
    const cart =
      (await again.body) &&
      (await harness
        .request()
        .get('/api/v1/account/cart')
        .set('Cookie', again.headers['set-cookie']!));
    expect(cart.body.data.items).toHaveLength(1);
    expect((await b.get('/api/v1/account/cart')).body.data.items).toEqual([]);
  });

  it('prices from the catalogue, never from the browser, and flags stock problems', async () => {
    const product = await createPublishedProduct(harness, { price: 400_00, stock: 2 });
    const put = await a.put('/api/v1/account/cart/items', {
      productId: product.id,
      quantity: 5,
      price: 1,
      unitPrice: 1,
    });
    expect(put.status).toBe(200);
    const line = put.body.data.quote.lines.find(
      (l: { productId: string }) => l.productId === product.id,
    );
    expect(line.unitPrice).toBe(400_00);
    expect(line.issue).not.toBeNull();
    expect(put.body.data.quote.canCheckout).toBe(false);
    // The server also refuses to order more than exists.
    const order = await a
      .post('/api/v1/orders', checkoutBody([{ productId: product.id, quantity: 5 }]))
      .set('Idempotency-Key', randomUUID());
    expect(order.status).toBe(409);
  });

  it('merging is idempotent: signing in again never doubles the cart', async () => {
    const product = await createPublishedProduct(harness, { stock: 9 });
    const fresh = customerClient(await registerCustomer(harness));
    const body = { items: [{ productId: product.id, quantity: 3 }] };
    for (let i = 0; i < 3; i++) await fresh.post('/api/v1/account/cart/merge', body);
    const cart = (await fresh.get('/api/v1/account/cart')).body.data;
    expect(cart.items).toEqual([{ productId: product.id, variantId: null, quantity: 3 }]);
  });

  it('removes lines, rejects unknown products and merges a guest cart', async () => {
    const one = await createPublishedProduct(harness, { stock: 9 });
    const two = await createPublishedProduct(harness, { stock: 9 });
    await b.put('/api/v1/account/cart/items', { productId: one.id, quantity: 2 });
    const merged = await b.post('/api/v1/account/cart/merge', {
      items: [
        { productId: one.id, quantity: 1 },
        { productId: two.id, quantity: 4 },
        { productId: '6a0000000000000000000001', quantity: 1 },
      ],
    });
    const items = merged.body.data.items as { productId: string; quantity: number }[];
    // Same line on both sides keeps the larger quantity (2 in the account, 1 in the browser).
    expect(items.find((i) => i.productId === one.id)!.quantity).toBe(2);
    expect(items.find((i) => i.productId === two.id)!.quantity).toBe(4);
    expect(items.some((i) => i.productId === '6a0000000000000000000001')).toBe(false);

    const unknown = await b.put('/api/v1/account/cart/items', {
      productId: '6a0000000000000000000001',
      quantity: 1,
    });
    expect(unknown.status).toBe(400);
    const removed = await b.put('/api/v1/account/cart/items', { productId: one.id, quantity: 0 });
    expect(removed.body.data.items.some((i: { productId: string }) => i.productId === one.id)).toBe(
      false,
    );
  });

  it('empties the cart after a successful checkout', async () => {
    const product = await createPublishedProduct(harness, { stock: 5 });
    const fresh = await registerCustomer(harness);
    const f = customerClient(fresh);
    await f.put('/api/v1/account/cart/items', { productId: product.id, quantity: 1 });
    const order = await f
      .post('/api/v1/orders', checkoutBody([{ productId: product.id, quantity: 1 }]))
      .set('Idempotency-Key', randomUUID());
    expect(order.status).toBe(201);
    expect((await ServerCartModel.findOne({ account: fresh.id }).lean())!.items).toEqual([]);
  });
});

describe('cancellation requests', () => {
  it('records a customer request, then the admin approves it: attribution and timestamps', async () => {
    const mine = await aliceOrders();
    const asked = await a.post(`/api/v1/account/orders/${mine.number}/cancellation-request`, {
      reason: 'Ordered by mistake',
    });
    expect(asked.status).toBe(200);
    expect(asked.body.data.cancellationRequest).toMatchObject({
      status: 'requested',
      reason: 'Ordered by mistake',
    });
    expect(asked.body.data.canRequestCancellation).toBe(false);
    // The order is NOT cancelled until staff decide.
    expect(asked.body.data.status).toBe('pending');
    expect(
      (
        await a.post(`/api/v1/account/orders/${mine.number}/cancellation-request`, {
          reason: 'Again please',
        })
      ).status,
    ).toBe(409);

    const open = await staff.get(`/api/v1/admin/orders?cancellationRequest=requested`);
    expect(open.body.data.map((o: { orderNumber: string }) => o.orderNumber)).toContain(
      mine.number,
    );

    const cancelled = await staff.post(`/api/v1/admin/orders/${mine.id}/status`, {
      status: 'cancelled',
      cancellationReason: 'Customer asked to cancel',
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.cancelledBy).toMatchObject({ kind: 'customer_request' });
    expect(cancelled.body.data.cancelledBy.byName).toEqual(expect.any(String));
    expect(cancelled.body.data.cancellationRequest.status).toBe('approved');
    expect(cancelled.body.data.statusHistory.at(-1)).toMatchObject({
      from: 'pending',
      to: 'cancelled',
    });
    expect(cancelled.body.data.statusHistory.at(-1).at).toEqual(expect.any(String));

    const view = (await a.get(`/api/v1/account/orders/${mine.number}`)).body.data;
    expect(view.status).toBe('cancelled');
    expect(view.cancelledBy).toBe('customer_request');
    expect(view.timeline.map((t: { status: string }) => t.status)).toEqual([
      'pending',
      'cancelled',
    ]);
    expect(view.cancellationRequest.status).toBe('approved');
  });

  it('distinguishes an admin cancellation from a customer request', async () => {
    const mine = await aliceOrders();
    const cancelled = await staff.post(`/api/v1/admin/orders/${mine.id}/status`, {
      status: 'cancelled',
      cancellationReason: 'Out of clay',
    });
    expect(cancelled.body.data.cancelledBy.kind).toBe('admin');
    expect(cancelled.body.data.cancellationRequest).toBeNull();
    expect((await a.get(`/api/v1/account/orders/${mine.number}`)).body.data.cancelledBy).toBe(
      'admin',
    );
  });

  it('lets staff reject a request with a note the customer can read', async () => {
    const mine = await aliceOrders();
    await a.post(`/api/v1/account/orders/${mine.number}/cancellation-request`, {
      reason: 'Changed my mind',
    });
    const rejected = await staff.post(
      `/api/v1/admin/orders/${mine.id}/cancellation-request/reject`,
      {
        note: 'Already being packed',
      },
    );
    expect(rejected.status).toBe(200);
    const view = (await a.get(`/api/v1/account/orders/${mine.number}`)).body.data;
    expect(view.status).toBe('pending');
    expect(view.cancellationRequest).toMatchObject({
      status: 'rejected',
      resolutionNote: 'Already being packed',
    });
    expect(view.cancellationRequest.resolvedAt).toEqual(expect.any(String));
    expect(
      (
        await staff.post(`/api/v1/admin/orders/${mine.id}/cancellation-request/reject`, {
          note: 'again',
        })
      ).status,
    ).toBe(409);
  });

  it('refuses a request once the order is on its way', async () => {
    const mine = await aliceOrders('delivery');
    for (const status of ['confirmed', 'processing', 'ready_for_dispatch'] as const)
      await staff.post(`/api/v1/admin/orders/${mine.id}/status`, { status });
    await staff.post(`/api/v1/admin/orders/${mine.id}/status`, {
      status: 'shipped',
      shipment: { provider: 'India Post', trackingNumber: 'EE123456789IN' },
    });
    const late = await a.post(`/api/v1/account/orders/${mine.number}/cancellation-request`, {
      reason: 'Too late for this one',
    });
    expect(late.status).toBe(409);
    const view = (await a.get(`/api/v1/account/orders/${mine.number}`)).body.data;
    expect(view.canRequestCancellation).toBe(false);
  });
});

describe('shipment and status rules (admin)', () => {
  it('requires shipment details to ship a delivery order and shows tracking to its owner only', async () => {
    const mine = await aliceOrders('delivery');
    for (const status of ['confirmed', 'processing', 'ready_for_dispatch'] as const)
      expect((await staff.post(`/api/v1/admin/orders/${mine.id}/status`, { status })).status).toBe(
        200,
      );

    const bare = await staff.post(`/api/v1/admin/orders/${mine.id}/status`, { status: 'shipped' });
    expect(bare.status).toBe(400);
    expect(bare.body.error.fields.shipment).toBeDefined();

    const shipped = await staff.post(`/api/v1/admin/orders/${mine.id}/status`, {
      status: 'shipped',
      shipment: {
        provider: 'DTDC',
        trackingNumber: 'D1234567',
        trackingUrl: 'https://track.example.com/D1234567',
        estimatedDelivery: '2026-11-05',
      },
    });
    expect(shipped.status).toBe(200);
    expect(shipped.body.data.shipment).toMatchObject({
      provider: 'DTDC',
      trackingNumber: 'D1234567',
    });

    const view = (await a.get(`/api/v1/account/orders/${mine.number}`)).body.data;
    expect(view.shipment).toMatchObject({
      provider: 'DTDC',
      trackingNumber: 'D1234567',
      estimatedDelivery: '2026-11-05',
    });
    expect((await b.get(`/api/v1/account/orders/${mine.number}`)).status).toBe(404);

    const fixed = await staff.put(`/api/v1/admin/orders/${mine.id}/shipment`, {
      provider: 'DTDC',
      trackingNumber: 'D7654321',
    });
    expect(fixed.body.data.shipment.trackingNumber).toBe('D7654321');
    expect(fixed.body.data.shipment.shippedAt).toBe(shipped.body.data.shipment.shippedAt);
  });

  it('rejects invalid status transitions and bad shipment links', async () => {
    const mine = await aliceOrders();
    const skip = await staff.post(`/api/v1/admin/orders/${mine.id}/status`, {
      status: 'delivered',
    });
    expect(skip.status).toBe(409);
    expect(skip.body.error.code).toBe('INVALID_TRANSITION');
    const early = await staff.put(`/api/v1/admin/orders/${mine.id}/shipment`, {
      provider: 'DTDC',
      trackingNumber: 'X',
    });
    expect(early.status).toBe(409);
    const bad = await staff.put(`/api/v1/admin/orders/${mine.id}/shipment`, {
      provider: 'DTDC',
      trackingNumber: 'X',
      trackingUrl: 'javascript:alert(1)',
    });
    expect(bad.status).toBe(400);
  });

  it('keeps shipment and cancellation actions behind order permissions', async () => {
    const mine = await aliceOrders();
    const catalogStaff = adminClient(await signedInAs(harness, 'product_manager'));
    expect(
      (
        await catalogStaff.put(`/api/v1/admin/orders/${mine.id}/shipment`, {
          provider: 'x',
          trackingNumber: 'y',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await catalogStaff.post(`/api/v1/admin/orders/${mine.id}/cancellation-request/reject`, {
          note: 'x',
        })
      ).status,
    ).toBe(403);
    expect((await catalogStaff.get(`/api/v1/admin/orders/${mine.id}`)).status).toBe(403);
  });
});
