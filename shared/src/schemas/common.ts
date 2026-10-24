import { z } from 'zod';
import { LIMITS } from '../constants';
import { SLUG_PATTERN } from '../slug';

/** ₹10,00,000 — an upper bound that catches typos such as entering paise twice. */
export const MAX_PRICE_PAISE = 10_00_000_00;

export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, { error: 'Invalid id' });

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(80)
  .regex(SLUG_PATTERN, { error: 'Use lowercase letters, numbers and single hyphens' });

export const paiseSchema = z
  .number({ error: 'Enter an amount' })
  .int({ error: 'Amount must be in whole paise' })
  .min(0)
  .max(MAX_PRICE_PAISE);

export const positivePaiseSchema = paiseSchema.min(1, {
  error: 'Amount must be greater than zero',
});

/** Optional free text: trims and turns empty strings into undefined. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));

/** Nullable free text: trims and stores empty strings as null. */
export const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));

export const requiredText = (max: number, label = 'This field') =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .min(1, { error: `${label} is required` })
    .max(max, { error: `${label} must be at most ${max} characters` });

export const httpsUrlSchema = z.url({ protocol: /^https?$/, error: 'Enter a valid URL' }).max(500);

export const nullableUrlSchema = z
  .union([httpsUrlSchema, z.literal(''), z.null()])
  .optional()
  .transform((value) => (value ? value : null));

/** Site-relative path ("/shop?category=planters") or absolute http(s) URL. */
export const linkSchema = z
  .string()
  .trim()
  .max(300)
  .refine((value) => /^\/(?!\/)/.test(value) || /^https?:\/\//.test(value), {
    error: 'Use a path starting with / or a full URL',
  });

export const booleanQuerySchema = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

export const pageQuerySchema = z.coerce.number().int().min(1).max(10_000).default(1);

export const limitQuerySchema = (
  max: number = LIMITS.maxPageSize,
  fallback: number = LIMITS.defaultPageSize,
) => z.coerce.number().int().min(1).max(max).default(fallback);

export const searchQuerySchema = z
  .string()
  .trim()
  .max(LIMITS.maxSearchLength)
  .optional()
  .transform((value) => (value ? value : undefined));

export const seoSchema = z
  .object({
    title: nullableText(70),
    description: nullableText(170),
  })
  .default({ title: null, description: null });

export const isoDateSchema = z.iso.datetime({ offset: true, error: 'Enter a valid date and time' });

export const dateQuerySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'Use YYYY-MM-DD' })
  .optional();
