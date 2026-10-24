import type { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST') =>
  new AppError(400, code, message);

export const validationFailed = (
  fields: Record<string, string[]>,
  message = 'Please correct the highlighted fields.',
) => new AppError(400, 'VALIDATION_ERROR', message, fields);

export const unauthorized = (message = 'Please sign in to continue.') =>
  new AppError(401, 'UNAUTHENTICATED', message);

export const forbidden = (message = 'You do not have permission to do that.', code = 'FORBIDDEN') =>
  new AppError(403, code, message);

export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found.`);

export const conflict = (message: string, code = 'CONFLICT') => new AppError(409, code, message);

export function zodFieldErrors(error: ZodError): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join('.') : '_';
    (fields[key] ??= []).push(issue.message);
  }
  return fields;
}

/** MongoDB duplicate-key error (E11000), optionally for a specific index key. */
export function isDuplicateKeyError(error: unknown, field?: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    code?: number;
    keyPattern?: Record<string, unknown>;
    message?: string;
  };
  if (candidate.code !== 11000) return false;
  if (!field) return true;
  if (candidate.keyPattern) return field in candidate.keyPattern;
  return candidate.message?.includes(field) ?? false;
}
