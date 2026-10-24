import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminSessionModel, AuditEventModel } from '../../src/db/models';
import {
  adminClient,
  createAdmin,
  createHarness,
  ORIGIN,
  signIn,
  signedInAs,
  STRONG_PASSWORD,
  type Harness,
} from '../helpers/harness';

let harness: Harness;
beforeAll(async () => {
  harness = await createHarness();
});
afterAll(async () => {
  await harness.close();
});

describe('admin authentication', () => {
  it('signs in with an HttpOnly session cookie and never returns the password hash', async () => {
    const { email } = await createAdmin('super_admin');
    const response = await harness
      .request()
      .post('/api/v1/admin/auth/login')
      .set('Origin', ORIGIN)
      .send({ email, password: STRONG_PASSWORD });
    expect(response.status).toBe(200);
    const cookie = response.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toMatch(/^jmh_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(JSON.stringify(response.body)).not.toMatch(/passwordHash|argon2/);
    expect(response.body.data).toMatchObject({
      email,
      role: 'super_admin',
      mustChangePassword: false,
    });
    expect(response.body.data.csrfToken).toEqual(expect.any(String));
  });

  it('uses one generic message for unknown accounts and wrong passwords', async () => {
    const { email } = await createAdmin('order_manager');
    const wrongPassword = await harness
      .request()
      .post('/api/v1/admin/auth/login')
      .send({ email, password: 'Wrong-Password-99' });
    const unknown = await harness
      .request()
      .post('/api/v1/admin/auth/login')
      .send({ email: 'nobody@example.com', password: 'Wrong-Password-99' });
    expect(wrongPassword.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe(unknown.body.error.message);
  });

  it('locks an account after repeated failures without revealing it', async () => {
    const { email } = await createAdmin('order_manager');
    for (let i = 0; i < 8; i++) {
      await harness
        .request()
        .post('/api/v1/admin/auth/login')
        .send({ email, password: 'Wrong-Password-99' });
    }
    const locked = await harness
      .request()
      .post('/api/v1/admin/auth/login')
      .send({ email, password: STRONG_PASSWORD });
    expect(locked.status).toBe(401);
  });

  it('rejects unauthenticated access to every admin area', async () => {
    const paths = [
      '/dashboard',
      '/products',
      '/orders',
      '/customers',
      '/users',
      '/audit',
      '/settings',
      '/media',
      '/inventory',
      '/promotions',
    ];
    for (const path of paths) {
      const response = await harness.request().get(`/api/v1/admin${path}`);
      expect(response.status, path).toBe(401);
    }
  });

  it('lets a browser that still holds a session cookie sign in again', async () => {
    const admin = await signedInAs(harness, 'order_manager');
    // Same agent (cookie jar still has the old session), no CSRF header — like the login page.
    const again = await admin.agent
      .post('/api/v1/admin/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: admin.email, password: STRONG_PASSWORD });
    expect(again.status).toBe(200);
    expect(again.body.data.csrfToken).toEqual(expect.any(String));
  });

  it('still blocks cross-site sign-in attempts', async () => {
    const { email } = await createAdmin('order_manager');
    const response = await harness
      .request()
      .post('/api/v1/admin/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email, password: STRONG_PASSWORD });
    expect(response.status).toBe(403);
  });

  it('requires the CSRF token for mutations', async () => {
    const admin = await signedInAs(harness, 'super_admin');
    const withoutToken = await admin.agent
      .post('/api/v1/admin/categories')
      .set('Origin', ORIGIN)
      .send({ name: 'Bowls' });
    expect(withoutToken.status).toBe(403);
    expect(withoutToken.body.error.code).toBe('CSRF_FAILED');
    const withToken = await adminClient(admin).post('/api/v1/admin/categories', { name: 'Bowls' });
    expect(withToken.status).toBe(201);
  });

  it('blocks cross-site requests by Origin', async () => {
    const admin = await signedInAs(harness, 'super_admin');
    const response = await admin.agent
      .post('/api/v1/admin/categories')
      .set('Origin', 'https://evil.example')
      .set('X-CSRF-Token', admin.csrf)
      .send({ name: 'Evil' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('BAD_ORIGIN');
  });

  it('forces a password change before anything else on first sign-in', async () => {
    const { email } = await createAdmin('super_admin', { mustChangePassword: true });
    const admin = await signIn(harness, email);
    const client = adminClient(admin);
    const blocked = await client.get('/api/v1/admin/products');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await client.get('/api/v1/admin/auth/me')).body.data.mustChangePassword).toBe(true);

    const weak = await client.post('/api/v1/admin/auth/change-password', {
      currentPassword: STRONG_PASSWORD,
      newPassword: 'password',
    });
    expect(weak.status).toBe(400);
    const same = await client.post('/api/v1/admin/auth/change-password', {
      currentPassword: STRONG_PASSWORD,
      newPassword: STRONG_PASSWORD,
    });
    expect(same.status).toBe(400);
    const changed = await client.post('/api/v1/admin/auth/change-password', {
      currentPassword: STRONG_PASSWORD,
      newPassword: 'Glazed-Surahi-2027!',
    });
    expect(changed.status).toBe(204);
    expect((await client.get('/api/v1/admin/products')).status).toBe(200);
    await expect(signIn(harness, email, 'Glazed-Surahi-2027!')).resolves.toBeTruthy();
  });

  it('signs out and revokes the server-side session', async () => {
    const admin = await signedInAs(harness, 'order_manager');
    const client = adminClient(admin);
    expect((await client.get('/api/v1/admin/auth/me')).status).toBe(200);
    expect((await client.post('/api/v1/admin/auth/logout')).status).toBe(204);
    expect((await admin.agent.get('/api/v1/admin/auth/me')).status).toBe(401);
  });

  it('lets a super admin revoke another admin’s sessions', async () => {
    const victim = await signedInAs(harness, 'product_manager');
    const boss = adminClient(await signedInAs(harness, 'super_admin'));
    const revoked = await boss.post(`/api/v1/admin/users/${victim.id}/revoke-sessions`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.data.revoked).toBeGreaterThan(0);
    expect((await victim.agent.get('/api/v1/admin/auth/me')).status).toBe(401);
  });

  it('resets a password with a single-use, expiring link and signs out other sessions', async () => {
    const target = await signedInAs(harness, 'order_manager');
    const boss = adminClient(await signedInAs(harness, 'super_admin'));
    const link = await boss.post(`/api/v1/admin/users/${target.id}/reset-link`);
    expect(link.status).toBe(200);
    const token = new URL(link.body.data.url).searchParams.get('token')!;

    const weak = await harness
      .request()
      .post('/api/v1/admin/auth/reset-password')
      .send({ token, newPassword: 'short' });
    expect(weak.status).toBe(400);
    const reset = await harness
      .request()
      .post('/api/v1/admin/auth/reset-password')
      .send({ token, newPassword: 'Fresh-Kulhad-Morning-7' });
    expect(reset.status).toBe(204);
    const reused = await harness
      .request()
      .post('/api/v1/admin/auth/reset-password')
      .send({ token, newPassword: 'Another-Kulhad-Morning-8' });
    expect(reused.status).toBe(400);

    expect((await target.agent.get('/api/v1/admin/auth/me')).status).toBe(401);
    expect(await AdminSessionModel.countDocuments({ admin: target.id })).toBe(0);
    await expect(signIn(harness, target.email, 'Fresh-Kulhad-Morning-7')).resolves.toBeTruthy();
  });

  it('answers forgot-password identically whether or not the account exists', async () => {
    const { email } = await createAdmin('order_manager');
    const known = await harness
      .request()
      .post('/api/v1/admin/auth/forgot-password')
      .send({ email });
    const unknown = await harness
      .request()
      .post('/api/v1/admin/auth/forgot-password')
      .send({ email: 'ghost@example.com' });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
  });

  it('records sign-ins in the audit log', async () => {
    const { email } = await createAdmin('product_manager');
    await signIn(harness, email);
    expect(await AuditEventModel.exists({ action: 'auth.login', actorEmail: email })).toBeTruthy();
  });
});
