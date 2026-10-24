import { Router } from 'express';
import { Types } from 'mongoose';
import {
  objectIdSchema,
  promotionInputSchema,
  type AdminPromotion,
  type PromotionInput,
} from '@jmh/shared';
import type { AppContext } from '../../context';
import { PromotionModel, type Promotion } from '../../db/models';
import { conflict, isDuplicateKeyError, notFound } from '../../lib/errors';
import { parseInput } from '../../lib/validate';
import { requirePermission } from '../../middleware/auth';
import { audit } from '../audit/audit.service';

export function promotionState(
  promotion: Pick<Promotion, 'isActive' | 'startsAt' | 'endsAt'>,
  now = new Date(),
): AdminPromotion['state'] {
  if (!promotion.isActive) return 'disabled';
  if (promotion.startsAt > now) return 'scheduled';
  if (promotion.endsAt <= now) return 'expired';
  return 'live';
}

function promotionDTO(promotion: Promotion): AdminPromotion {
  return {
    id: promotion._id.toString(),
    name: promotion.name,
    description: promotion.description,
    type: promotion.type,
    value: promotion.value,
    maxDiscount: promotion.maxDiscount,
    minOrderValue: promotion.minOrderValue,
    scope: promotion.scope,
    categoryIds: promotion.categoryIds.map(String),
    productIds: promotion.productIds.map(String),
    code: promotion.code,
    startsAt: promotion.startsAt.toISOString(),
    endsAt: promotion.endsAt.toISOString(),
    isActive: promotion.isActive,
    priority: promotion.priority,
    state: promotionState(promotion),
    banner: {
      show: promotion.banner?.show ?? false,
      headline: promotion.banner?.headline ?? null,
      subtext: promotion.banner?.subtext ?? null,
      ctaLabel: promotion.banner?.ctaLabel ?? null,
      ctaHref: promotion.banner?.ctaHref ?? null,
    },
    updatedAt: promotion.updatedAt.toISOString(),
  };
}

function toDocument(input: PromotionInput) {
  return {
    ...input,
    startsAt: new Date(input.startsAt),
    endsAt: new Date(input.endsAt),
    categoryIds:
      input.scope === 'categories' ? input.categoryIds.map((id) => new Types.ObjectId(id)) : [],
    productIds:
      input.scope === 'products' ? input.productIds.map((id) => new Types.ObjectId(id)) : [],
    maxDiscount: input.type === 'percentage' ? input.maxDiscount : null,
  };
}

export function promotionsAdminRoutes(ctx: AppContext): Router {
  const router = Router();
  const changed = () => {
    void ctx.cache.invalidate('settings', 'catalog');
    ctx.revalidator.notify(['promotions', 'settings', 'home']);
  };
  const saveError = (error: unknown) => {
    if (isDuplicateKeyError(error, 'code'))
      return conflict('Another promotion already uses this code.', 'CODE_TAKEN');
    return error;
  };

  router.get('/', requirePermission('promotions:read'), async (_req, res) => {
    const promotions = await PromotionModel.find()
      .sort({ endsAt: -1 })
      .limit(500)
      .lean<Promotion[]>();
    res.json({ data: promotions.map(promotionDTO) });
  });

  router.get('/:id', requirePermission('promotions:read'), async (req, res) => {
    const promotion = await PromotionModel.findById(
      parseInput(objectIdSchema, req.params.id),
    ).lean<Promotion>();
    if (!promotion) throw notFound('Promotion');
    res.json({ data: promotionDTO(promotion) });
  });

  router.post('/', requirePermission('promotions:write'), async (req, res) => {
    const input = parseInput(promotionInputSchema, req.body);
    const promotion = await PromotionModel.create(toDocument(input)).catch((error) => {
      throw saveError(error);
    });
    changed();
    await audit(req, {
      action: 'promotion.create',
      entityType: 'promotion',
      entityId: promotion.id,
      summary: `Created promotion “${promotion.name}”`,
    });
    res.status(201).json({ data: promotionDTO(promotion.toObject()) });
  });

  router.put('/:id', requirePermission('promotions:write'), async (req, res) => {
    const id = parseInput(objectIdSchema, req.params.id);
    const input = parseInput(promotionInputSchema, req.body);
    const promotion = await PromotionModel.findByIdAndUpdate(
      id,
      { $set: toDocument(input) },
      { returnDocument: 'after', runValidators: true },
    )
      .lean<Promotion>()
      .catch((error) => {
        throw saveError(error);
      });
    if (!promotion) throw notFound('Promotion');
    changed();
    await audit(req, {
      action: 'promotion.update',
      entityType: 'promotion',
      entityId: id,
      summary: `Updated promotion “${promotion.name}”`,
    });
    res.json({ data: promotionDTO(promotion) });
  });

  router.delete('/:id', requirePermission('promotions:write'), async (req, res) => {
    const id = parseInput(objectIdSchema, req.params.id);
    const promotion = await PromotionModel.findByIdAndDelete(id).lean<Promotion>();
    if (!promotion) throw notFound('Promotion');
    changed();
    await audit(req, {
      action: 'promotion.delete',
      entityType: 'promotion',
      entityId: id,
      summary: `Deleted promotion “${promotion.name}”`,
    });
    res.status(204).end();
  });

  return router;
}
