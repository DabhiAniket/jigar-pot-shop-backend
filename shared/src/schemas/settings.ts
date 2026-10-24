import { z } from 'zod';
import { INDIAN_STATES } from '../constants';
import { isValidPincode, normalizeWhatsAppNumber } from '../phone';
import {
  linkSchema,
  nullableText,
  nullableUrlSchema,
  objectIdSchema,
  paiseSchema,
  requiredText,
} from './common';

export const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: 'Use HH:MM (24-hour)' });

export const openingHoursSchema = z
  .array(
    z.object({
      day: z.enum(WEEKDAYS),
      isOpen: z.boolean(),
      opens: timeSchema.default('09:00'),
      closes: timeSchema.default('20:00'),
    }),
  )
  .max(7);

const whatsappSettingSchema = z
  .string()
  .trim()
  .max(20)
  .nullish()
  .transform((value, ctx) => {
    if (!value) return null;
    const normalized = normalizeWhatsAppNumber(value);
    if (!normalized) {
      ctx.addIssue({
        code: 'custom',
        message: 'Enter the number with country code, e.g. 919876543210',
      });
      return z.NEVER;
    }
    return normalized;
  });

const phoneDisplaySchema = z
  .string()
  .trim()
  .max(20)
  .regex(/^[+\d][\d\s-]{6,19}$/, { error: 'Enter a valid phone number' })
  .nullish()
  .or(z.literal(''))
  .transform((value) => (value ? value : null));

export const storeSettingsSchema = z.object({
  storeName: requiredText(80, 'Store name'),
  legalName: nullableText(120),
  tagline: nullableText(160),
  phone: phoneDisplaySchema,
  whatsappNumber: whatsappSettingSchema,
  email: z
    .email({ error: 'Enter a valid email' })
    .max(120)
    .nullish()
    .or(z.literal(''))
    .transform((value) => (value ? value : null)),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, { error: 'Enter a valid GSTIN' })
    .nullish()
    .or(z.literal(''))
    .transform((value) => (value ? value : null)),
  address: z.object({
    line1: nullableText(160),
    line2: nullableText(160),
    city: nullableText(80),
    state: z
      .enum(INDIAN_STATES)
      .nullish()
      .or(z.literal(''))
      .transform((value) => (value ? value : null)),
    pincode: z
      .string()
      .trim()
      .refine((value) => value === '' || isValidPincode(value), { error: 'Enter a valid PIN code' })
      .nullish()
      .transform((value) => (value ? value : null)),
    mapUrl: nullableUrlSchema,
  }),
  openingHours: openingHoursSchema.default([]),
  social: z.object({
    instagram: nullableUrlSchema,
    facebook: nullableUrlSchema,
    youtube: nullableUrlSchema,
    x: nullableUrlSchema,
  }),
  delivery: z.object({
    deliveryEnabled: z.boolean(),
    pickupEnabled: z.boolean(),
    flatCharge: paiseSchema,
    freeDeliveryThreshold: paiseSchema.nullish().transform((value) => value ?? null),
    note: nullableText(300),
  }),
  policies: z.object({
    shipping: z.string().trim().max(20_000).default(''),
    returns: z.string().trim().max(20_000).default(''),
    privacy: z.string().trim().max(20_000).default(''),
    terms: z.string().trim().max(20_000).default(''),
  }),
  seo: z.object({
    defaultTitle: nullableText(70),
    defaultDescription: nullableText(170),
  }),
});
export type StoreSettingsInput = z.infer<typeof storeSettingsSchema>;
export type StoreSettingsInputRaw = z.input<typeof storeSettingsSchema>;

const ctaSchema = z.object({
  label: requiredText(40, 'Button label'),
  href: linkSchema,
});

export const homeContentSchema = z.object({
  hero: z.object({
    eyebrow: nullableText(60),
    headline: requiredText(120, 'Headline'),
    headlineLang: z.enum(['gu', 'en']).default('gu'),
    subheadline: nullableText(240),
    primaryCta: ctaSchema,
    secondaryCta: ctaSchema,
    image: z
      .object({ assetId: objectIdSchema, alt: z.string().trim().max(200).default('') })
      .nullish()
      .transform((value) => value ?? null),
    video: z.object({
      mp4Url: nullableUrlSchema,
      webmUrl: nullableUrlSchema,
      posterUrl: nullableUrlSchema,
    }),
  }),
  story: z.object({
    enabled: z.boolean(),
    chapters: z
      .array(z.object({ title: requiredText(80, 'Title'), body: requiredText(400, 'Text') }))
      .min(1)
      .max(5),
  }),
  craft: z.object({
    enabled: z.boolean(),
    title: requiredText(100, 'Title'),
    body: requiredText(1200, 'Text'),
    points: z
      .array(z.object({ title: requiredText(60, 'Title'), body: requiredText(240, 'Text') }))
      .max(4),
  }),
  featuredCategoryIds: z.array(objectIdSchema).max(12).default([]),
  sections: z.object({
    bestsellers: z.boolean(),
    newArrivals: z.boolean(),
    offers: z.boolean(),
    recentlyViewed: z.boolean(),
    visitStore: z.boolean(),
  }),
});
export type HomeContentInput = z.infer<typeof homeContentSchema>;
export type HomeContentInputRaw = z.input<typeof homeContentSchema>;
