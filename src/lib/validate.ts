import type { z } from 'zod';
import { validationFailed, zodFieldErrors } from './errors';

/** Parses untrusted input with a schema, throwing a 400 with per-field messages on failure. */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw validationFailed(zodFieldErrors(result.error));
  return result.data;
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
