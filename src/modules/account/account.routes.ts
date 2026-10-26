import { Router, type Response } from 'express';
import { Types } from 'mongoose';
import {
  cancellationRequestSchema,
  cartMergeSchema,
  cartSetItemSchema,
  customerProfileSchema,
  customerRegisterSchema,
  limitQuerySchema,
  loginSchema,
  LIMITS,
  objectIdSchema,
  orderNumberSchema,
  ORDER_STATUSES,
  pageQuerySchema,
  savedAddressSchema,
  type CustomerMe,
  type ServerCartDTO,
} from '@jmh/shared';
import { z } from 'zod';
import type { AppContext } from '../../context';
import {
  CustomerAccountModel,
  OrderModel,
  ProductModel,
  ServerCartModel,
  type CustomerAccount,
  type Order,
} from '../../db/models';
import { sha256 } from '../../lib/crypto';
import { conflict, notFound, validationFailed } from '../../lib/errors';
import { parseInput } from '../../lib/validate';
import { requireCustomer } from '../../middleware/auth';
import { ipAndBodyEmailKey, type LimiterFactory } from '../../middleware/rate-limit';
import { quoteCart } from '../cart/cart.service';
import { findOwnOrder, requestCancellation } from '../orders/order.service';
import { customerOrderDTO, customerOrderListItem } from '../orders/order.serialize';
import { getStoreSettings } from '../settings/settings.service';
import {
  customerCsrfTokenFor,
  loginCustomer,
  registerCustomer,
  revokeCustomerSession,
} from './account.service';

const MAX_SAVED_ADDRESSES = 10;

export function accountRoutes(ctx: AppContext, limiter: LimiterFactory): Router {
  const router = Router();
  const { config } = ctx;

  // Everything here is personal data: never cache, and never index.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const cookieOptions = {
    httpOnly: true,
    secure: config.cookies.secure,
    sameSite: 'lax' as const,
    path: '/',
  };
  const setCookie = (res: Response, token: string) =>
    res.cookie(config.cookies.customerName, token, {
      ...cookieOptions,
      maxAge: config.session.ttlMs,
    });

  const me = (account: CustomerAccount, sessionTokenHash: string): CustomerMe => ({
    id: account._id.toString(),
    name: account.name,
    email: account.email,
    phone: account.phone,
    addresses: account.addresses.map((address) => ({
      id: address._id.toString(),
      label: address.label,
      isDefault: address.isDefault,
      line1: address.line1,
      line2: address.line2 ?? null,
      landmark: address.landmark ?? null,
      city: address.city,
      state: address.state,
      pincode: address.pincode,
    })),
    csrfToken: customerCsrfTokenFor(config, sessionTokenHash),
  });

  const authIpLimiter = limiter({ name: 'customer-auth-ip', windowMs: 15 * 60_000, limit: 30 });
  const loginLimiter = limiter({
    name: 'customer-login',
    windowMs: 15 * 60_000,
    limit: 6,
    key: ipAndBodyEmailKey,
    skipSuccessfulRequests: true,
    message: 'Too many sign-in attempts. Please wait 15 minutes and try again.',
  });
  const writeLimiter = limiter({ name: 'customer-write', windowMs: 10 * 60_000, limit: 120 });

  router.post('/register', authIpLimiter, async (req, res) => {
    const input = parseInput(customerRegisterSchema, req.body);
    const { token, account } = await registerCustomer(config, input);
    setCookie(res, token);
    res.status(201).json({ data: me(account, sha256(token)) });
  });

  router.post('/login', authIpLimiter, loginLimiter, async (req, res) => {
    const input = parseInput(loginSchema, req.body);
    const { token, account } = await loginCustomer(config, input);
    setCookie(res, token);
    res.json({ data: me(account, sha256(token)) });
  });

  router.post('/logout', async (req, res) => {
    if (req.customer) await revokeCustomerSession(req.customer.sessionId);
    res.clearCookie(config.cookies.customerName, cookieOptions);
    res.status(204).end();
  });

  // Everything below needs a verified customer session. The account id used for every query
  // comes from req.customer (the session), never from the URL, body or query string.
  router.use(requireCustomer);

  const loadAccount = async (req: { customer?: { id: Types.ObjectId } }) => {
    const account = await CustomerAccountModel.findById(req.customer!.id).lean<CustomerAccount>();
    if (!account) throw notFound('Account');
    return account;
  };

  router.get('/me', async (req, res) => {
    res.json({ data: me(await loadAccount(req), req.customer!.sessionTokenHash) });
  });

  router.patch('/me', writeLimiter, async (req, res) => {
    const input = parseInput(customerProfileSchema, req.body);
    await CustomerAccountModel.updateOne({ _id: req.customer!.id }, { $set: input });
    res.json({ data: me(await loadAccount(req), req.customer!.sessionTokenHash) });
  });

  // ── saved addresses ──
  router.post('/addresses', writeLimiter, async (req, res) => {
    const input = parseInput(savedAddressSchema, req.body);
    const account = await loadAccount(req);
    if (account.addresses.length >= MAX_SAVED_ADDRESSES)
      throw conflict(`You can save up to ${MAX_SAVED_ADDRESSES} addresses.`);
    const makeDefault = input.isDefault || account.addresses.length === 0;
    if (makeDefault)
      await CustomerAccountModel.updateOne(
        { _id: account._id },
        { $set: { 'addresses.$[].isDefault': false } },
      );
    await CustomerAccountModel.updateOne(
      { _id: account._id },
      { $push: { addresses: { ...input, isDefault: makeDefault } } },
    );
    res.status(201).json({ data: me(await loadAccount(req), req.customer!.sessionTokenHash) });
  });

  router.put('/addresses/:id', writeLimiter, async (req, res) => {
    const id = parseInput(objectIdSchema, req.params.id);
    const input = parseInput(savedAddressSchema, req.body);
    if (input.isDefault)
      await CustomerAccountModel.updateOne(
        { _id: req.customer!.id },
        { $set: { 'addresses.$[].isDefault': false } },
      );
    const result = await CustomerAccountModel.updateOne(
      { _id: req.customer!.id, 'addresses._id': id },
      { $set: { 'addresses.$': { ...input, _id: new Types.ObjectId(id) } } },
    );
    if (result.matchedCount === 0) throw notFound('Address');
    res.json({ data: me(await loadAccount(req), req.customer!.sessionTokenHash) });
  });

  router.delete('/addresses/:id', writeLimiter, async (req, res) => {
    const id = parseInput(objectIdSchema, req.params.id);
    await CustomerAccountModel.updateOne(
      { _id: req.customer!.id },
      { $pull: { addresses: { _id: new Types.ObjectId(id) } } },
    );
    res.json({ data: me(await loadAccount(req), req.customer!.sessionTokenHash) });
  });

  // ── cart: one per account, prices always read from the catalogue ──
  const cartDTO = async (accountId: Types.ObjectId): Promise<ServerCartDTO> => {
    const cart = await ServerCartModel.findOne({ account: accountId }).lean();
    const items = (cart?.items ?? []).map((item) => ({
      productId: item.product.toString(),
      variantId: item.variant?.toString() ?? null,
      quantity: item.quantity,
    }));
    return {
      items,
      quote: items.length
        ? await quoteCart(ctx, { items, promoCode: null, fulfillment: 'delivery' })
        : null,
    };
  };
  const saveCart = (accountId: Types.ObjectId, items: ServerCartDTO['items']) =>
    ServerCartModel.updateOne(
      { account: accountId },
      {
        $set: {
          items: items.map((item) => ({
            product: new Types.ObjectId(item.productId),
            variant: item.variantId ? new Types.ObjectId(item.variantId) : null,
            quantity: item.quantity,
          })),
        },
      },
      { upsert: true },
    );

  router.get('/cart', async (req, res) => {
    res.json({ data: await cartDTO(req.customer!.id) });
  });

  router.put('/cart/items', writeLimiter, async (req, res) => {
    const input = parseInput(cartSetItemSchema, req.body);
    const current = (await cartDTO(req.customer!.id)).items;
    const same = (item: { productId: string; variantId: string | null }) =>
      item.productId === input.productId && item.variantId === input.variantId;
    if (input.quantity > 0) {
      // Only real, published products can be added; unknown ids are rejected, not stored.
      const exists = await ProductModel.exists({ _id: input.productId, status: 'published' });
      if (!exists) throw validationFailed({ productId: ['This product is not available.'] });
    }
    const next = current.filter((item) => !same(item));
    if (input.quantity > 0) next.push({ ...input });
    if (next.length > LIMITS.maxCartLines) throw conflict('Your cart is full.');
    await saveCart(req.customer!.id, next);
    res.json({ data: await cartDTO(req.customer!.id) });
  });

  // Called right after sign-in: folds the browser's guest cart into the saved one.
  router.post('/cart/merge', writeLimiter, async (req, res) => {
    const input = parseInput(cartMergeSchema, req.body);
    const current = (await cartDTO(req.customer!.id)).items;
    const known = new Set(
      (
        await ProductModel.find({
          _id: { $in: input.items.map((item) => item.productId) },
          status: 'published',
        })
          .select('_id')
          .lean()
      ).map((product) => product._id.toString()),
    );
    // Same line on both sides keeps the larger quantity: signing in again on the same browser
    // must not double what is already in the cart.
    const byLine = new Map(
      current.map((item) => [`${item.productId}:${item.variantId ?? ''}`, item]),
    );
    for (const item of input.items.filter((candidate) => known.has(candidate.productId))) {
      const key = `${item.productId}:${item.variantId ?? ''}`;
      const existing = byLine.get(key);
      byLine.set(key, {
        productId: item.productId,
        variantId: item.variantId,
        quantity: Math.max(existing?.quantity ?? 0, item.quantity),
      });
    }
    const merged = [...byLine.values()].slice(0, LIMITS.maxCartLines);
    await saveCart(req.customer!.id, merged);
    res.json({ data: await cartDTO(req.customer!.id) });
  });

  router.delete('/cart', writeLimiter, async (req, res) => {
    await saveCart(req.customer!.id, []);
    res.json({ data: await cartDTO(req.customer!.id) });
  });

  // ── orders: own orders only ──
  const listQuery = z.object({
    page: pageQuerySchema,
    limit: limitQuerySchema(30, 10),
    status: z.enum(ORDER_STATUSES).optional(),
  });

  router.get('/orders', async (req, res) => {
    const query = parseInput(listQuery, req.query);
    const filter = {
      accountId: req.customer!.id,
      ...(query.status ? { status: query.status } : {}),
    };
    const [orders, total] = await Promise.all([
      OrderModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean<Order[]>(),
      OrderModel.countDocuments(filter),
    ]);
    res.json({
      data: orders.map((order) => customerOrderListItem(order, ctx.storage)),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    });
  });

  router.get('/orders/:orderNumber', async (req, res) => {
    const orderNumber = parseInput(orderNumberSchema, req.params.orderNumber);
    const order = await findOwnOrder(req.customer!.id, orderNumber);
    const settings = await getStoreSettings();
    res.json({ data: customerOrderDTO(order, ctx.storage, settings, config.whatsappNumber) });
  });

  router.post('/orders/:orderNumber/cancellation-request', writeLimiter, async (req, res) => {
    const orderNumber = parseInput(orderNumberSchema, req.params.orderNumber);
    const { reason } = parseInput(cancellationRequestSchema, req.body);
    const order = await requestCancellation(req.customer!.id, orderNumber, reason);
    const settings = await getStoreSettings();
    res.json({ data: customerOrderDTO(order, ctx.storage, settings, config.whatsappNumber) });
  });

  return router;
}
