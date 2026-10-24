import { z } from 'zod';
import { PROMOTION_SCOPES, PROMOTION_TYPES } from '../constants';
import {
  isoDateSchema,
  linkSchema,
  nullableText,
  objectIdSchema,
  paiseSchema,
  requiredText,
} from './common';

export const promotionInputSchema = z
  .object({
    name: requiredText(80, 'Promotion name'),
    description: z.string().trim().max(500).default(''),
    type: z.enum(PROMOTION_TYPES),
    /** Percent for percentage promotions, paise for fixed-amount promotions. */
    value: z.number().int().positive(),
    maxDiscount: paiseSchema.nullish().transform((value) => value ?? null),
    minOrderValue: paiseSchema.nullish().transform((value) => value ?? null),
    scope: z.enum(PROMOTION_SCOPES).default('all'),
    categoryIds: z.array(objectIdSchema).max(100).default([]),
    productIds: z.array(objectIdSchema).max(500).default([]),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{4,20}$/, { error: 'Codes use 4–20 letters or numbers' })
      .nullish()
      .or(z.literal(''))
      .transform((value) => (value ? value : null)),
    startsAt: isoDateSchema,
    endsAt: isoDateSchema,
    isActive: z.boolean().default(true),
    priority: z.number().int().min(0).max(100).default(0),
    banner: z
      .object({
        show: z.boolean().default(false),
        headline: nullableText(80),
        subtext: nullableText(160),
        ctaLabel: nullableText(40),
        ctaHref: linkSchema
          .nullish()
          .or(z.literal(''))
          .transform((value) => (value ? value : null)),
      })
      .default({ show: false, headline: null, subtext: null, ctaLabel: null, ctaHref: null }),
  })
  .superRefine((promotion, ctx) => {
    if (new Date(promotion.endsAt) <= new Date(promotion.startsAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'End date must be after the start date',
      });
    }
    if (promotion.type === 'percentage' && (promotion.value < 1 || promotion.value > 90)) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Percentage must be between 1 and 90',
      });
    }
    if (promotion.scope === 'categories' && promotion.categoryIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['categoryIds'],
        message: 'Choose at least one category',
      });
    }
    if (promotion.scope === 'products' && promotion.productIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['productIds'],
        message: 'Choose at least one product',
      });
    }
    if (promotion.banner.show && !promotion.banner.headline) {
      ctx.addIssue({
        code: 'custom',
        path: ['banner', 'headline'],
        message: 'Add a banner headline',
      });
    }
  });
export type PromotionInput = z.infer<typeof promotionInputSchema>;
export type PromotionInputRaw = z.input<typeof promotionInputSchema>;
