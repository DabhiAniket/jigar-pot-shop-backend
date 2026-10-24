import { Types, type QueryFilter } from 'mongoose';
import type { InventoryAdjustInput, InventoryMovementDTO, InventoryRow } from '@jmh/shared';
import type { AppContext } from '../../context';
import { runTransaction } from '../../db/transaction';
import {
  InventoryMovementModel,
  ProductModel,
  type InventoryMovement,
  type Product,
} from '../../db/models';
import { AppError, notFound, validationFailed } from '../../lib/errors';
import { escapeRegex } from '../../lib/validate';
import { thumbnailUrl } from '../../media/serialize';
import type { AuthenticatedAdmin } from '../../types/express';

/** One row per product, or per variant for products with variants. */
export async function listInventory(
  ctx: AppContext,
  query: { q?: string; filter: 'all' | 'low' | 'out'; page: number; limit: number },
): Promise<{ rows: InventoryRow[]; total: number }> {
  const conditions: QueryFilter<Product>[] = [
    { trackInventory: true, status: { $ne: 'archived' } },
  ];
  if (query.q) {
    const pattern = new RegExp(escapeRegex(query.q), 'i');
    conditions.push({ $or: [{ name: pattern }, { sku: pattern }, { 'variants.sku': pattern }] });
  }
  if (query.filter === 'out') {
    conditions.push({
      $or: [
        { variants: { $size: 0 }, stock: { $lte: 0 } },
        { variants: { $elemMatch: { isActive: true, stock: { $lte: 0 } } } },
      ],
    });
  } else if (query.filter === 'low') {
    conditions.push({
      $expr: {
        $or: [
          {
            $and: [
              { $eq: [{ $size: '$variants' }, 0] },
              { $lte: ['$stock', '$lowStockThreshold'] },
            ],
          },
          {
            $gt: [
              {
                $size: {
                  $filter: {
                    input: '$variants',
                    cond: {
                      $and: ['$$this.isActive', { $lte: ['$$this.stock', '$lowStockThreshold'] }],
                    },
                  },
                },
              },
              0,
            ],
          },
        ],
      },
    });
  }
  const filter: QueryFilter<Product> = { $and: conditions };

  const [products, total] = await Promise.all([
    ProductModel.find(filter, {
      name: 1,
      slug: 1,
      sku: 1,
      status: 1,
      stock: 1,
      lowStockThreshold: 1,
      variants: 1,
      images: { $slice: 1 },
    })
      .sort({ stock: 1, name: 1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean<Product[]>(),
    ProductModel.countDocuments(filter),
  ]);

  const rows: InventoryRow[] = [];
  for (const product of products) {
    const thumbnail = thumbnailUrl(product.images[0], ctx.storage);
    const base = {
      productId: product._id.toString(),
      name: product.name,
      slug: product.slug,
      status: product.status,
      lowStockThreshold: product.lowStockThreshold,
      thumbnail,
    };
    const variants = product.variants.filter((variant) => variant.isActive);
    if (variants.length === 0) {
      rows.push({
        ...base,
        variantId: null,
        variantName: null,
        sku: product.sku,
        stock: product.stock,
      });
    } else {
      for (const variant of variants) {
        if (query.filter === 'low' && variant.stock > product.lowStockThreshold) continue;
        if (query.filter === 'out' && variant.stock > 0) continue;
        rows.push({
          ...base,
          variantId: variant._id.toString(),
          variantName: variant.name,
          sku: variant.sku,
          stock: variant.stock,
        });
      }
    }
  }
  return { rows, total };
}

/** Manual stock adjustment, applied atomically and recorded as an inventory movement. */
export async function adjustInventory(
  input: InventoryAdjustInput,
  actor: AuthenticatedAdmin,
): Promise<InventoryMovement> {
  return runTransaction(async (session) => {
    const product = await ProductModel.findById(input.productId).session(session).lean<Product>();
    if (!product) throw notFound('Product');
    const variant = input.variantId
      ? product.variants.find((v) => v._id.toString() === input.variantId)
      : null;
    if (input.variantId && !variant) throw notFound('Variant');
    if (!input.variantId && product.variants.length > 0) {
      throw validationFailed({ variantId: ['Choose which variant to adjust.'] });
    }

    const current = variant ? variant.stock : product.stock;
    const delta = input.mode === 'set' ? input.quantity - current : input.quantity;
    if (delta === 0)
      throw new AppError(400, 'NO_CHANGE', 'The stock level is already at that value.');
    if (current + delta < 0) throw validationFailed({ quantity: ['Stock cannot go below zero.'] });

    const result = variant
      ? await ProductModel.updateOne(
          { _id: product._id, variants: { $elemMatch: { _id: variant._id, stock: current } } },
          { $inc: { 'variants.$.stock': delta, stock: delta } },
          { session },
        )
      : await ProductModel.updateOne(
          { _id: product._id, stock: current },
          { $inc: { stock: delta } },
          { session },
        );
    if (result.modifiedCount !== 1) {
      throw new AppError(
        409,
        'STOCK_CHANGED',
        'Stock changed while you were editing. Refresh and try again.',
      );
    }
    const productStockAfter = product.stock + delta;
    await ProductModel.updateOne(
      { _id: product._id },
      {
        $set: {
          inStock:
            product.availability === 'made_to_order' ||
            (product.availability === 'in_stock' &&
              (!product.trackInventory || productStockAfter > 0)),
        },
      },
      { session },
    );
    const [movement] = await InventoryMovementModel.create(
      [
        {
          product: product._id,
          variant: variant?._id ?? null,
          productName: product.name,
          variantName: variant?.name ?? null,
          delta,
          stockAfter: current + delta,
          reason: input.reason,
          note: input.note ?? null,
          actor: actor.id,
          actorName: actor.name,
        },
      ],
      { session },
    );
    return movement!.toObject();
  });
}

export async function listMovements(query: { productId?: string; page: number; limit: number }) {
  const filter = query.productId ? { product: new Types.ObjectId(query.productId) } : {};
  const [movements, total] = await Promise.all([
    InventoryMovementModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean<InventoryMovement[]>(),
    InventoryMovementModel.countDocuments(filter),
  ]);
  const data: InventoryMovementDTO[] = movements.map((movement) => ({
    id: movement._id.toString(),
    productId: movement.product.toString(),
    productName: movement.productName,
    variantName: movement.variantName,
    delta: movement.delta,
    stockAfter: movement.stockAfter,
    reason: movement.reason,
    orderNumber: movement.orderNumber,
    note: movement.note,
    byName: movement.actorName,
    createdAt: movement.createdAt.toISOString(),
  }));
  return { data, total };
}
