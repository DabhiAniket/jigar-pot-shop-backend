import { Types, type ClientSession } from 'mongoose';
import {
  buildOrderWhatsAppMessage,
  buildWhatsAppUrl,
  canTransitionOrder,
  PROMO_CODE_MESSAGES,
  transitionRestocksInventory,
  type CheckoutInput,
  type OrderStatus,
} from '@jmh/shared';
import type { AppContext } from '../../context';
import { runTransaction } from '../../db/transaction';
import {
  CustomerModel,
  InventoryMovementModel,
  OrderModel,
  ProductModel,
  type Order,
  type OrderItem,
  type StoreSettingsDoc,
} from '../../db/models';
import { canonicalHash, hmac, readableCode, safeEqual } from '../../lib/crypto';
import { AppError, conflict, isDuplicateKeyError, notFound } from '../../lib/errors';
import { logger } from '../../lib/logger';
import type { AuthenticatedAdmin } from '../../types/express';
import {
  loadLivePromotions,
  priceLines,
  resolveCartLines,
  type ResolvedLine,
} from '../cart/cart.service';
import { getStoreSettings, resolveWhatsAppNumber } from '../settings/settings.service';

const ORDER_NUMBER_ATTEMPTS = 4;

/** e.g. JMH-261022-7K3QX: prefix, order date in India, 5 unambiguous characters. */
export function generateOrderNumber(prefix: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${prefix}-${get('year')}${get('month')}${get('day')}-${readableCode(5)}`;
}

/** Capability token for the confirmation page; derived, so retries return the same link. */
export function orderAccessToken(appSecret: string, orderNumber: string): string {
  return hmac(appSecret, `order-access:${orderNumber}`).slice(0, 32);
}

export function verifyOrderAccessToken(
  appSecret: string,
  orderNumber: string,
  token: string,
): boolean {
  return safeEqual(orderAccessToken(appSecret, orderNumber), token);
}

export function orderWhatsAppUrl(
  order: Order,
  settings: StoreSettingsDoc,
  envNumber: string | null,
): string | null {
  const number = resolveWhatsAppNumber(settings, envNumber);
  if (!number) return null;
  const message = buildOrderWhatsAppMessage({
    storeName: settings.storeName,
    orderNumber: order.orderNumber,
    customerName: order.customer.name,
    items: order.items.map((item) => ({
      name: item.name,
      variantName: item.variantName,
      quantity: item.quantity,
      lineTotal: item.lineTotal,
    })),
    subtotal: order.pricing.subtotal,
    discountTotal: order.pricing.discountTotal,
    deliveryCharge: order.pricing.deliveryCharge,
    total: order.pricing.total,
    fulfillment: order.fulfillment,
    address: order.address,
    notes: order.notes,
  });
  return buildWhatsAppUrl(number, message);
}

class CartValidationError extends AppError {
  constructor(lines: ResolvedLine[]) {
    const fields: Record<string, string[]> = {};
    lines.forEach((line, index) => {
      if (line.issue) fields[`items.${index}`] = [line.issue.message];
    });
    super(409, 'CART_CHANGED', 'Some items in your cart changed. Please review your cart.', fields);
  }
}

export interface CreateOrderResult {
  order: Order;
  replayed: boolean;
}

/**
 * Places an order in one MongoDB transaction: re-validates every line against current data,
 * recalculates all totals, reserves stock with conditional updates (never below zero), upserts
 * the customer and writes inventory movements. Retries with the same Idempotency-Key return
 * the original order instead of creating a duplicate.
 */
export async function createOrder(
  ctx: AppContext,
  input: CheckoutInput,
  idempotencyKey: string | null,
): Promise<CreateOrderResult> {
  const requestHash = canonicalHash(input);
  if (idempotencyKey) {
    const existing = await OrderModel.findOne({ idempotencyKey }).lean<Order>();
    if (existing) return replay(existing, requestHash);
  }

  const settings = await getStoreSettings();
  for (let attempt = 1; attempt <= ORDER_NUMBER_ATTEMPTS; attempt++) {
    const orderNumber = generateOrderNumber(ctx.config.orderNumberPrefix);
    try {
      const order = await runTransaction((session) =>
        placeOrder(input, { orderNumber, idempotencyKey, requestHash, settings, session }),
      );
      return { order, replayed: false };
    } catch (error) {
      if (isDuplicateKeyError(error, 'orderNumber')) {
        logger.warn({ attempt }, 'order number collision, retrying');
        continue;
      }
      if (idempotencyKey && isDuplicateKeyError(error, 'idempotencyKey')) {
        const existing = await OrderModel.findOne({ idempotencyKey }).lean<Order>();
        if (existing) return replay(existing, requestHash);
      }
      throw error;
    }
  }
  throw new AppError(
    503,
    'ORDER_NUMBER_UNAVAILABLE',
    'Could not place the order right now. Please try again.',
  );
}

function replay(existing: Order, requestHash: string): CreateOrderResult {
  if (existing.requestHash && existing.requestHash !== requestHash) {
    throw new AppError(
      422,
      'IDEMPOTENCY_KEY_REUSED',
      'This checkout was already submitted with different details. Please refresh the page and try again.',
    );
  }
  return { order: existing, replayed: true };
}

async function placeOrder(
  input: CheckoutInput,
  meta: {
    orderNumber: string;
    idempotencyKey: string | null;
    requestHash: string;
    settings: StoreSettingsDoc;
    session: ClientSession;
  },
): Promise<Order> {
  const { session, settings } = meta;
  const now = new Date();
  const lines = await resolveCartLines(input.items, session);
  if (lines.some((line) => line.issue)) throw new CartValidationError(lines);

  const promotions = await loadLivePromotions(now, session);
  const pricing = priceLines(
    lines,
    promotions,
    { promoCode: input.promoCode, fulfillment: input.fulfillment },
    settings,
    now,
  );
  if (!pricing.fulfillmentAvailable) {
    throw new AppError(
      400,
      'FULFILLMENT_UNAVAILABLE',
      input.fulfillment === 'delivery'
        ? 'Home delivery is not available right now.'
        : 'Store pickup is not available right now.',
    );
  }
  if (
    pricing.promoCode &&
    ['invalid', 'inactive', 'not_eligible'].includes(pricing.promoCode.status)
  ) {
    throw new AppError(409, 'PROMO_CODE_REJECTED', PROMO_CODE_MESSAGES[pricing.promoCode.status], {
      promoCode: [PROMO_CODE_MESSAGES[pricing.promoCode.status]],
    });
  }

  // Reserve stock. Each update only matches while enough stock remains, so concurrent orders
  // can never oversell; a write conflict makes the driver retry the whole transaction.
  const deductedByProduct = new Map<string, number>();
  for (const [index, line] of lines.entries()) {
    if (!line.tracked) continue;
    const productId = new Types.ObjectId(line.productId);
    const result = line.variant
      ? await ProductModel.updateOne(
          {
            _id: productId,
            variants: { $elemMatch: { _id: line.variant._id, stock: { $gte: line.quantity } } },
          },
          { $inc: { 'variants.$.stock': -line.quantity, stock: -line.quantity } },
          { session },
        )
      : await ProductModel.updateOne(
          { _id: productId, stock: { $gte: line.quantity } },
          { $inc: { stock: -line.quantity } },
          { session },
        );
    if (result.modifiedCount !== 1) {
      throw new AppError(
        409,
        'OUT_OF_STOCK',
        'An item in your cart just sold out. Please review your cart.',
        {
          [`items.${index}`]: ['Not enough stock.'],
        },
      );
    }
    deductedByProduct.set(
      line.productId,
      (deductedByProduct.get(line.productId) ?? 0) + line.quantity,
    );
  }
  for (const [productId, deducted] of deductedByProduct) {
    const product = lines.find((line) => line.productId === productId)!.product!;
    if (product.stock - deducted <= 0) {
      await ProductModel.updateOne({ _id: product._id }, { $set: { inStock: false } }, { session });
    }
  }

  const priced = new Map(pricing.lines.map((line) => [line.key, line]));
  const items: OrderItem[] = lines.map((line) => {
    const amounts = priced.get(line.key)!;
    return {
      product: line.product!._id,
      variant: line.variant?._id ?? null,
      slug: line.product!.slug,
      name: line.product!.name,
      variantName: line.variant?.name ?? null,
      sku: line.variant?.sku ?? line.product!.sku,
      imageKey: line.product!.images[0]?.variants[0]?.key ?? null,
      categoryId: line.product!.category,
      listPrice: line.listPrice,
      unitPrice: line.unitPrice,
      quantity: line.quantity,
      lineSubtotal: amounts.lineSubtotal,
      lineDiscount: amounts.lineDiscount,
      lineTotal: amounts.lineTotal,
      inventoryTracked: line.tracked,
    };
  });

  const customer = await CustomerModel.findOneAndUpdate(
    { phone: input.customer.phone },
    {
      $set: {
        name: input.customer.name,
        whatsapp: input.customer.whatsapp,
        lastOrderAt: now,
        ...(input.address ? { lastAddress: input.address, city: input.address.city } : {}),
      },
      $setOnInsert: { firstOrderAt: now },
      $inc: { orderCount: 1 },
    },
    { upsert: true, returnDocument: 'after', session },
  );

  const [order] = await OrderModel.create(
    [
      {
        orderNumber: meta.orderNumber,
        status: 'pending',
        channel: input.channel,
        fulfillment: input.fulfillment,
        customer: input.customer,
        customerId: customer._id,
        address: input.fulfillment === 'delivery' ? input.address : null,
        notes: input.notes ?? null,
        items,
        pricing: {
          subtotal: pricing.subtotal,
          discountTotal: pricing.discountTotal,
          deliveryCharge: pricing.deliveryCharge,
          total: pricing.total,
          currency: 'INR',
          appliedPromotion: pricing.appliedPromotion
            ? { ...pricing.appliedPromotion, id: new Types.ObjectId(pricing.appliedPromotion.id) }
            : null,
        },
        promoCode: input.promoCode,
        statusHistory: [
          { from: null, to: 'pending', at: now, note: 'Order placed', by: null, byName: null },
        ],
        inventory: { committed: deductedByProduct.size > 0, restockedAt: null },
        idempotencyKey: meta.idempotencyKey,
        requestHash: meta.requestHash,
      },
    ],
    { session },
  );

  const movements = lines
    .filter((line) => line.tracked)
    .map((line) => ({
      product: line.product!._id,
      variant: line.variant?._id ?? null,
      productName: line.product!.name,
      variantName: line.variant?.name ?? null,
      delta: -line.quantity,
      stockAfter: (line.variant ? line.variant.stock : line.product!.stock) - line.quantity,
      reason: 'order_placed' as const,
      order: order!._id,
      orderNumber: meta.orderNumber,
    }));
  if (movements.length) await InventoryMovementModel.insertMany(movements, { session });

  return order!.toObject();
}

/** Returns reserved stock exactly once; the unique movement index blocks duplicate restocks. */
async function restockOrder(
  order: Order,
  actor: AuthenticatedAdmin,
  session: ClientSession,
): Promise<void> {
  const movements = [];
  for (const item of order.items) {
    if (!item.inventoryTracked) continue;
    const result = item.variant
      ? await ProductModel.updateOne(
          { _id: item.product, 'variants._id': item.variant },
          {
            $inc: { 'variants.$.stock': item.quantity, stock: item.quantity },
            $set: { inStock: true },
          },
          { session },
        )
      : await ProductModel.updateOne(
          { _id: item.product },
          { $inc: { stock: item.quantity }, $set: { inStock: true } },
          { session },
        );
    if (result.matchedCount === 0) continue; // product or variant deleted since; nothing to restock
    movements.push({
      product: item.product,
      variant: item.variant,
      productName: item.name,
      variantName: item.variantName,
      delta: item.quantity,
      stockAfter: null,
      reason: 'order_cancelled' as const,
      order: order._id,
      orderNumber: order.orderNumber,
      actor: actor.id,
      actorName: actor.name,
    });
  }
  // Products that are made to order or out of stock by choice must not flip back to in stock.
  await ProductModel.updateMany(
    { _id: { $in: order.items.map((item) => item.product) }, availability: { $ne: 'in_stock' } },
    { $set: { inStock: false } },
    { session },
  );
  await ProductModel.updateMany(
    { _id: { $in: order.items.map((item) => item.product) }, availability: 'made_to_order' },
    { $set: { inStock: true } },
    { session },
  );
  if (movements.length) await InventoryMovementModel.insertMany(movements, { session });
}

export async function updateOrderStatus(
  orderId: string,
  input: { status: OrderStatus; note?: string; cancellationReason?: string },
  actor: AuthenticatedAdmin,
): Promise<Order> {
  return runTransaction(async (session) => {
    const order = await OrderModel.findById(orderId).session(session).lean<Order>();
    if (!order) throw notFound('Order');
    if (!canTransitionOrder(order.status, input.status)) {
      throw new AppError(
        409,
        'INVALID_TRANSITION',
        `An order cannot move from “${order.status}” to “${input.status}”.`,
      );
    }
    const now = new Date();
    const restock =
      transitionRestocksInventory(input.status) &&
      order.inventory.committed &&
      !order.inventory.restockedAt;
    const set: Record<string, unknown> = { status: input.status };
    if (input.status === 'cancelled') set.cancellationReason = input.cancellationReason ?? null;
    if (restock) set['inventory.restockedAt'] = now;

    // Guard on the status we read, so two admins cannot apply conflicting transitions.
    const result = await OrderModel.updateOne(
      { _id: order._id, status: order.status },
      {
        $set: set,
        $push: {
          statusHistory: {
            from: order.status,
            to: input.status,
            at: now,
            note: input.note ?? null,
            by: actor.id,
            byName: actor.name,
          },
        },
      },
      { session },
    );
    if (result.modifiedCount !== 1)
      throw conflict('This order was just updated by someone else. Refresh and try again.');
    if (restock) await restockOrder(order, actor, session);
    return (await OrderModel.findById(order._id).session(session).lean<Order>())!;
  });
}

export async function addInternalNote(
  orderId: string,
  text: string,
  actor: AuthenticatedAdmin,
): Promise<Order> {
  const order = await OrderModel.findByIdAndUpdate(
    orderId,
    { $push: { internalNotes: { text, at: new Date(), by: actor.id, byName: actor.name } } },
    { returnDocument: 'after' },
  ).lean<Order>();
  if (!order) throw notFound('Order');
  return order;
}
