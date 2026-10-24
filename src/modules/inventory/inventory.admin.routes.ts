import { Router } from 'express';
import { z } from 'zod';
import { inventoryAdjustSchema, inventoryListQuerySchema, objectIdSchema } from '@jmh/shared';
import type { AppContext } from '../../context';
import { parseInput } from '../../lib/validate';
import { requirePermission } from '../../middleware/auth';
import { audit } from '../audit/audit.service';
import { adjustInventory, listInventory, listMovements } from './inventory.service';

const movementsQuerySchema = z.object({
  productId: objectIdSchema.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function inventoryAdminRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/', requirePermission('inventory:read'), async (req, res) => {
    const query = parseInput(inventoryListQuerySchema, req.query);
    const { rows, total } = await listInventory(ctx, query);
    res.set('Cache-Control', 'no-store').json({
      data: rows,
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    });
  });

  router.get('/movements', requirePermission('inventory:read'), async (req, res) => {
    const query = parseInput(movementsQuerySchema, req.query);
    const { data, total } = await listMovements(query);
    res.json({
      data,
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    });
  });

  router.post('/adjust', requirePermission('inventory:write'), async (req, res) => {
    const input = parseInput(inventoryAdjustSchema, req.body);
    const movement = await adjustInventory(input, req.admin!);
    await audit(req, {
      action: 'inventory.adjust',
      entityType: 'product',
      entityId: input.productId,
      summary: `Stock ${movement.delta > 0 ? '+' : ''}${movement.delta} for “${movement.productName}${movement.variantName ? ` (${movement.variantName})` : ''}” → ${movement.stockAfter} (${input.reason.replace(/_/g, ' ')})`,
    });
    void ctx.cache.invalidate('catalog');
    ctx.revalidator.notify(['catalog']);
    res.status(201).json({ data: { delta: movement.delta, stockAfter: movement.stockAfter } });
  });

  return router;
}
