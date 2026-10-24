import { Router } from 'express';
import { z } from 'zod';
import {
  adminProductListQuerySchema,
  categoryInputSchema,
  categoryReorderSchema,
  objectIdSchema,
  productBulkActionSchema,
  productInputSchema,
} from '@jmh/shared';
import type { AppContext } from '../../context';
import { ProductModel, type Product } from '../../db/models';
import { notFound } from '../../lib/errors';
import { parseInput } from '../../lib/validate';
import { requirePermission } from '../../middleware/auth';
import { audit } from '../audit/audit.service';
import {
  categorySummaryMap,
  createCategory,
  deleteCategory,
  listAdminCategories,
  reorderCategories,
  updateCategory,
} from './category.service';
import { adminProductDetail, adminProductListItem } from './product.serialize';
import {
  bulkUpdateProducts,
  createProduct,
  deleteProduct,
  duplicateProduct,
  listAdminProducts,
  updateProduct,
} from './product.service';

const idParam = (value: unknown) => parseInput(objectIdSchema, value);
const versionSchema = z.object({ version: z.iso.datetime().optional() });

export function catalogAdminRoutes(ctx: AppContext): Router {
  const router = Router();
  const invalidate = () => {
    void ctx.cache.invalidate('catalog');
    ctx.revalidator.notify(['catalog']);
  };

  router.get('/products', requirePermission('products:read'), async (req, res) => {
    const query = parseInput(adminProductListQuerySchema, req.query);
    const [{ items, total }, categories] = await Promise.all([
      listAdminProducts(query),
      categorySummaryMap(),
    ]);
    res.json({
      data: items.map((product) => adminProductListItem(product, categories, ctx.storage)),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    });
  });

  router.get('/products/:id', requirePermission('products:read'), async (req, res) => {
    const product = await ProductModel.findById(idParam(req.params.id)).lean<Product>();
    if (!product) throw notFound('Product');
    res.json({ data: adminProductDetail(product, ctx.storage) });
  });

  router.post('/products', requirePermission('products:write'), async (req, res) => {
    const input = parseInput(productInputSchema, req.body);
    const product = await createProduct(ctx, input, req.admin!);
    await audit(req, {
      action: 'product.create',
      entityType: 'product',
      entityId: product._id.toString(),
      summary: `Created product “${product.name}” (${product.status})`,
    });
    res.status(201).json({ data: adminProductDetail(product, ctx.storage) });
  });

  router.put('/products/:id', requirePermission('products:write'), async (req, res) => {
    const id = idParam(req.params.id);
    const input = parseInput(productInputSchema, req.body);
    const { version } = parseInput(versionSchema, { version: req.body?.version });
    const product = await updateProduct(ctx, id, input, version, req.admin!);
    await audit(req, {
      action: 'product.update',
      entityType: 'product',
      entityId: id,
      summary: `Updated product “${product.name}” (${product.status})`,
    });
    res.json({ data: adminProductDetail(product, ctx.storage) });
  });

  router.post('/products/:id/duplicate', requirePermission('products:write'), async (req, res) => {
    const id = idParam(req.params.id);
    const copy = await duplicateProduct(ctx, id, req.admin!);
    await audit(req, {
      action: 'product.duplicate',
      entityType: 'product',
      entityId: copy._id.toString(),
      summary: `Duplicated product ${id} as “${copy.name}”`,
    });
    res.status(201).json({ data: adminProductDetail(copy, ctx.storage) });
  });

  router.delete('/products/:id', requirePermission('products:delete'), async (req, res) => {
    const id = idParam(req.params.id);
    const product = await deleteProduct(ctx, id);
    await audit(req, {
      action: 'product.delete',
      entityType: 'product',
      entityId: id,
      summary: `Deleted product “${product.name}” (SKU ${product.sku ?? 'none'})`,
    });
    res.status(204).end();
  });

  router.post('/products/bulk', requirePermission('products:write'), async (req, res) => {
    const input = parseInput(productBulkActionSchema, req.body);
    const result = await bulkUpdateProducts(
      ctx,
      input.ids,
      input.action,
      input.categoryId,
      req.admin!,
    );
    await audit(req, {
      action: `product.bulk_${input.action}`,
      entityType: 'product',
      summary: `Bulk ${input.action.replace(/_/g, ' ')} on ${result.modified} product(s)`,
      metadata: { ids: input.ids, categoryId: input.categoryId ?? null, skipped: result.skipped },
    });
    res.json({ data: result });
  });

  router.get('/categories', requirePermission('products:read'), async (_req, res) => {
    res.json({ data: await listAdminCategories(ctx) });
  });

  router.post('/categories', requirePermission('categories:write'), async (req, res) => {
    const input = parseInput(categoryInputSchema, req.body);
    const category = await createCategory(input);
    invalidate();
    await audit(req, {
      action: 'category.create',
      entityType: 'category',
      entityId: category._id.toString(),
      summary: `Created category “${category.name}”`,
    });
    res.status(201).json({ data: { id: category._id.toString() } });
  });

  router.put('/categories/:id', requirePermission('categories:write'), async (req, res) => {
    const id = idParam(req.params.id);
    const input = parseInput(categoryInputSchema, req.body);
    const category = await updateCategory(id, input);
    invalidate();
    await audit(req, {
      action: 'category.update',
      entityType: 'category',
      entityId: id,
      summary: `Updated category “${category.name}”`,
    });
    res.json({ data: { id } });
  });

  router.delete('/categories/:id', requirePermission('categories:write'), async (req, res) => {
    const id = idParam(req.params.id);
    const category = await deleteCategory(id);
    invalidate();
    await audit(req, {
      action: 'category.delete',
      entityType: 'category',
      entityId: id,
      summary: `Deleted category “${category.name}”`,
    });
    res.status(204).end();
  });

  router.post('/categories/reorder', requirePermission('categories:write'), async (req, res) => {
    const input = parseInput(categoryReorderSchema, req.body);
    await reorderCategories(input.ids);
    invalidate();
    await audit(req, {
      action: 'category.reorder',
      entityType: 'category',
      summary: `Reordered ${input.ids.length} categories`,
    });
    res.status(204).end();
  });

  return router;
}
