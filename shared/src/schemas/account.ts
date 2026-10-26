import { z } from 'zod';
import { LIMITS } from '../constants';
import { emailSchema, newPasswordSchema } from './auth';
import { nullableText, objectIdSchema, requiredText } from './common';
import { addressSchema, customerNameSchema, indianMobileSchema } from './orders';

export const customerRegisterSchema = z.object({
  name: customerNameSchema,
  email: emailSchema,
  phone: indianMobileSchema,
  password: newPasswordSchema,
});

export const customerProfileSchema = z.object({
  name: customerNameSchema,
  phone: indianMobileSchema,
});

export const savedAddressSchema = addressSchema.extend({
  label: nullableText(40),
  isDefault: z.boolean().default(false),
});
export type SavedAddressInput = z.infer<typeof savedAddressSchema>;

/** quantity 0 removes the line. The browser never sends prices: they are read server-side. */
export const cartSetItemSchema = z.object({
  productId: objectIdSchema,
  variantId: objectIdSchema.nullish().transform((value) => value ?? null),
  quantity: z.number().int().min(0).max(LIMITS.maxLineQuantity),
});

export const cartMergeSchema = z.object({
  items: z
    .array(
      cartSetItemSchema.extend({ quantity: z.number().int().min(1).max(LIMITS.maxLineQuantity) }),
    )
    .max(LIMITS.maxCartLines),
});

export const cancellationRequestSchema = z.object({
  reason: requiredText(300, 'Reason').refine((value) => value.length >= 5, {
    error: 'Please tell us why in a few words',
  }),
});

export const cancellationRejectSchema = z.object({
  note: requiredText(300, 'A note for the customer'),
});
