import { z } from 'zod';
import { CHECKOUT_CHANNELS, FULFILLMENT_METHODS, INDIAN_STATES, LIMITS } from '../constants';
import { ORDER_STATUSES } from '../order-status';
import { isValidPincode, normalizeIndianMobile } from '../phone';
import {
  dateQuerySchema,
  limitQuerySchema,
  objectIdSchema,
  optionalText,
  pageQuerySchema,
  requiredText,
  searchQuerySchema,
} from './common';

export const indianMobileSchema = z
  .string({ error: 'Enter a mobile number' })
  .trim()
  .max(20)
  .transform((value, ctx) => {
    const normalized = normalizeIndianMobile(value);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid 10-digit Indian mobile number' });
      return z.NEVER;
    }
    return normalized;
  });

export const promoCodeInputSchema = z
  .string()
  .trim()
  .max(24)
  .nullish()
  .transform((value) => (value ? value.toUpperCase() : null));

export const cartItemInputSchema = z.object({
  productId: objectIdSchema,
  variantId: objectIdSchema.nullish().transform((value) => value ?? null),
  quantity: z.number().int().min(1).max(LIMITS.maxLineQuantity),
});
export type CartItemInput = z.infer<typeof cartItemInputSchema>;

export const cartQuoteSchema = z.object({
  items: z.array(cartItemInputSchema).min(1).max(LIMITS.maxCartLines),
  promoCode: promoCodeInputSchema,
  fulfillment: z.enum(FULFILLMENT_METHODS).default('delivery'),
});
export type CartQuoteInput = z.infer<typeof cartQuoteSchema>;

export const addressSchema = z.object({
  line1: requiredText(160, 'Address line 1'),
  line2: optionalText(160),
  landmark: optionalText(120),
  city: requiredText(80, 'City'),
  state: z.enum(INDIAN_STATES, { error: 'Choose a state' }),
  pincode: z
    .string({ error: 'Enter a PIN code' })
    .trim()
    .refine(isValidPincode, { error: 'Enter a valid 6-digit PIN code' }),
});
export type AddressInput = z.infer<typeof addressSchema>;

export const customerNameSchema = requiredText(80, 'Name').refine(
  (value) => /^[\p{L}\p{M}][\p{L}\p{M}\s.'-]*$/u.test(value),
  { error: 'Enter your name using letters only' },
);

export const checkoutSchema = z
  .object({
    items: z
      .array(cartItemInputSchema)
      .min(1, { error: 'Your cart is empty' })
      .max(LIMITS.maxCartLines),
    promoCode: promoCodeInputSchema,
    fulfillment: z.enum(FULFILLMENT_METHODS),
    channel: z.enum(CHECKOUT_CHANNELS),
    customer: z.object({
      name: customerNameSchema,
      phone: indianMobileSchema,
      whatsapp: z
        .string()
        .trim()
        .max(20)
        .optional()
        .transform((value, ctx) => {
          if (!value) return null;
          const normalized = normalizeIndianMobile(value);
          if (!normalized) {
            ctx.addIssue({ code: 'custom', message: 'Enter a valid 10-digit WhatsApp number' });
            return z.NEVER;
          }
          return normalized;
        }),
    }),
    address: addressSchema.nullish().transform((value) => value ?? null),
    notes: optionalText(500),
  })
  .superRefine((value, ctx) => {
    if (value.fulfillment === 'delivery' && !value.address) {
      ctx.addIssue({ code: 'custom', path: ['address'], message: 'Delivery address is required' });
    }
  });
export type CheckoutInput = z.infer<typeof checkoutSchema>;
export type CheckoutInputRaw = z.input<typeof checkoutSchema>;

export const idempotencyKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{16,64}$/, { error: 'Invalid Idempotency-Key header' });

export const orderNumberSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2,6}-\d{6}-[0-9A-Z]{5}$/, { error: 'Enter a valid order number' });

export const orderTrackSchema = z.object({
  orderNumber: orderNumberSchema,
  phone: indianMobileSchema,
});

const shipmentFields = z.object({
  provider: requiredText(80, 'Shipping provider'),
  trackingNumber: requiredText(80, 'Tracking number'),
  trackingUrl: z
    .url({ protocol: /^https?$/, error: 'Enter a valid tracking link' })
    .max(300)
    .nullish()
    .transform((value) => value ?? null),
  estimatedDelivery: z.iso
    .date({ error: 'Use the format YYYY-MM-DD' })
    .nullish()
    .transform((value) => value ?? null),
  notes: optionalText(300),
});
export const shipmentSchema = shipmentFields;
export type ShipmentInput = z.infer<typeof shipmentSchema>;

export const orderStatusUpdateSchema = z
  .object({
    status: z.enum(ORDER_STATUSES),
    note: optionalText(500),
    cancellationReason: optionalText(300),
    /** Required when a home-delivery order is marked shipped (enforced by the API). */
    shipment: shipmentFields.optional(),
  })
  .refine((value) => value.status !== 'cancelled' || value.cancellationReason, {
    path: ['cancellationReason'],
    error: 'Record why the order is being cancelled',
  });

export const orderNoteSchema = z.object({
  text: requiredText(1000, 'Note'),
});

export const adminOrderListQuerySchema = z.object({
  q: searchQuerySchema,
  status: z.enum(ORDER_STATUSES).optional(),
  channel: z.enum(CHECKOUT_CHANNELS).optional(),
  /** Only orders whose customer asked to cancel and is still waiting for an answer. */
  cancellationRequest: z.enum(['requested']).optional(),
  from: dateQuerySchema,
  to: dateQuerySchema,
  page: pageQuerySchema,
  limit: limitQuerySchema(LIMITS.maxAdminPageSize, 25),
});
export type AdminOrderListQuery = z.infer<typeof adminOrderListQuerySchema>;

export const adminCustomerListQuerySchema = z.object({
  q: searchQuerySchema,
  page: pageQuerySchema,
  limit: limitQuerySchema(LIMITS.maxAdminPageSize, 25),
});
