import { z } from 'zod';
import { ADMIN_ROLES } from '../permissions';
import { requiredText } from './common';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

const COMMON_PASSWORDS = new Set([
  'password1234',
  'password@123',
  'admin@123456',
  'qwerty123456',
  '123456789012',
  'welcome@1234',
  'jigarmatka123',
  'jigarmatkahouse',
]);

/** Returns human-readable problems; an empty array means the password is acceptable. */
export function checkPasswordStrength(
  password: string,
  context: { email?: string | null; name?: string | null } = {},
): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    problems.push(`Use at most ${PASSWORD_MAX_LENGTH} characters.`);
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) {
    problems.push('Mix at least three of: lowercase, uppercase, numbers and symbols.');
  }
  if (/(.)\1{3,}/.test(password)) {
    problems.push('Avoid repeating the same character many times.');
  }
  const lowered = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lowered)) problems.push('This password is too common.');
  const localPart = context.email?.split('@')[0]?.toLowerCase();
  if (localPart && localPart.length >= 4 && lowered.includes(localPart)) {
    problems.push('Do not include your email address in the password.');
  }
  const firstName = context.name?.split(/\s+/)[0]?.toLowerCase();
  if (firstName && firstName.length >= 4 && lowered.includes(firstName)) {
    problems.push('Do not include your name in the password.');
  }
  return problems;
}

export const emailSchema = z
  .email({ error: 'Enter a valid email address' })
  .trim()
  .toLowerCase()
  .max(160);

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(160),
  password: z
    .string()
    .min(1, { error: 'Enter your password' })
    .max(PASSWORD_MAX_LENGTH * 2),
});

export const newPasswordSchema = z.string().max(PASSWORD_MAX_LENGTH);

export const changePasswordSchema = z.object({
  currentPassword: z
    .string()
    .min(1)
    .max(PASSWORD_MAX_LENGTH * 2),
  newPassword: newPasswordSchema,
});

export const forgotPasswordSchema = z.object({ email: z.string().trim().toLowerCase().max(160) });

export const resetPasswordSchema = z.object({
  token: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{32,128}$/, { error: 'Invalid reset link' }),
  newPassword: newPasswordSchema,
});

export const createAdminUserSchema = z.object({
  email: emailSchema,
  name: requiredText(80, 'Name'),
  role: z.enum(ADMIN_ROLES),
  /** Temporary password; the user must change it on first sign-in. */
  temporaryPassword: newPasswordSchema,
});

export const updateAdminUserSchema = z
  .object({
    name: requiredText(80, 'Name').optional(),
    role: z.enum(ADMIN_ROLES).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { error: 'Nothing to update' });

export const auditListQuerySchema = z.object({
  action: z.string().trim().max(60).optional(),
  entityType: z.string().trim().max(40).optional(),
  entityId: z.string().trim().max(40).optional(),
  actorId: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
