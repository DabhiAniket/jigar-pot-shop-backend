import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, createHarness, signedInAs, type Harness } from '../helpers/harness';

let harness: Harness;
beforeAll(async () => {
  harness = await createHarness();
});
afterAll(async () => {
  await harness.close();
});

describe('role-based access control (enforced by the API)', () => {
  it('keeps product managers away from customer data and account administration', async () => {
    const pm = adminClient(await signedInAs(harness, 'product_manager'));
    for (const path of ['/orders', '/customers', '/users', '/audit']) {
      expect((await pm.get(`/api/v1/admin${path}`)).status, path).toBe(403);
    }
    expect((await pm.put('/api/v1/admin/settings', {})).status).toBe(403);
    expect(
      (
        await pm.post('/api/v1/admin/users', {
          email: 'x@example.com',
          name: 'X',
          role: 'super_admin',
          temporaryPassword: 'Terracotta-Kiln-48',
        })
      ).status,
    ).toBe(403);
    expect((await pm.get('/api/v1/admin/products')).status).toBe(200);
    expect((await pm.post('/api/v1/admin/categories', { name: 'Lamps' })).status).toBe(201);
  });

  it('shows product managers a dashboard without order figures', async () => {
    const pm = adminClient(await signedInAs(harness, 'product_manager'));
    const response = await pm.get('/api/v1/admin/dashboard');
    expect(response.status).toBe(200);
    expect(response.body.data.catalog).not.toBeNull();
    expect(response.body.data.orders).toBeNull();
  });

  it('lets order managers handle orders but not change the catalogue or settings', async () => {
    const om = adminClient(await signedInAs(harness, 'order_manager'));
    expect((await om.get('/api/v1/admin/orders')).status).toBe(200);
    expect((await om.get('/api/v1/admin/customers')).status).toBe(200);
    expect((await om.get('/api/v1/admin/products')).status).toBe(200);
    expect((await om.post('/api/v1/admin/products', { name: 'Hacked', price: 100 })).status).toBe(
      403,
    );
    expect((await om.post('/api/v1/admin/categories', { name: 'Hacked' })).status).toBe(403);
    expect((await om.put('/api/v1/admin/settings', {})).status).toBe(403);
    expect((await om.get('/api/v1/admin/users')).status).toBe(403);
    const dashboard = await om.get('/api/v1/admin/dashboard');
    expect(dashboard.body.data.orders).not.toBeNull();
  });

  it('prevents privilege escalation and super-admin lockout', async () => {
    const boss = await signedInAs(harness, 'super_admin');
    const client = adminClient(boss);
    const demoteSelf = await client.patch(`/api/v1/admin/users/${boss.id}`, {
      role: 'order_manager',
    });
    expect(demoteSelf.status).toBe(409);
    const pm = await signedInAs(harness, 'product_manager');
    const selfPromote = await adminClient(pm).patch(`/api/v1/admin/users/${pm.id}`, {
      role: 'super_admin',
    });
    expect(selfPromote.status).toBe(403);
  });

  it('signs out a user whose role was changed', async () => {
    const boss = adminClient(await signedInAs(harness, 'super_admin'));
    const om = await signedInAs(harness, 'order_manager');
    expect(
      (await boss.patch(`/api/v1/admin/users/${om.id}`, { role: 'product_manager' })).status,
    ).toBe(200);
    expect((await om.agent.get('/api/v1/admin/auth/me')).status).toBe(401);
  });

  it('rejects weak temporary passwords and duplicate emails when creating admins', async () => {
    const boss = adminClient(await signedInAs(harness, 'super_admin'));
    const weak = await boss.post('/api/v1/admin/users', {
      email: 'new@example.com',
      name: 'New Person',
      role: 'order_manager',
      temporaryPassword: 'abc',
    });
    expect(weak.status).toBe(400);
    const ok = await boss.post('/api/v1/admin/users', {
      email: 'new@example.com',
      name: 'New Person',
      role: 'order_manager',
      temporaryPassword: 'Spinning-Wheel-2026',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data.mustChangePassword).toBe(true);
    const duplicate = await boss.post('/api/v1/admin/users', {
      email: 'NEW@example.com',
      name: 'Dup',
      role: 'order_manager',
      temporaryPassword: 'Spinning-Wheel-2026',
    });
    expect(duplicate.status).toBe(409);
  });
});
