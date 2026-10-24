import argon2 from 'argon2';
import { Types } from 'mongoose';
import { checkPasswordStrength } from '@jmh/shared';
import type { AppConfig } from '../../config/env';
import {
  AdminSessionModel,
  AdminUserModel,
  PasswordResetTokenModel,
  type AdminUser,
} from '../../db/models';
import { hmac, randomToken, sha256 } from '../../lib/crypto';
import { AppError, unauthorized, validationFailed } from '../../lib/errors';
import type { AuthenticatedAdmin } from '../../types/express';

/** OWASP-recommended Argon2id parameters (19 MiB memory, 2 iterations). */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MS = 15 * 60_000;
const SESSION_TOUCH_INTERVAL_MS = 60_000;
export const RESET_TOKEN_TTL_MS = 30 * 60_000;

const GENERIC_LOGIN_ERROR = 'Incorrect email or password.';
let dummyHash: Promise<string> | null = null;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function assertStrongPassword(
  password: string,
  context: { email?: string; name?: string },
  field = 'newPassword',
): void {
  const problems = checkPasswordStrength(password, context);
  if (problems.length) throw validationFailed({ [field]: problems }, problems[0]);
}

export interface LoginResult {
  token: string;
  admin: AdminUser;
}

export async function login(
  config: AppConfig,
  input: { email: string; password: string; ip: string | null; userAgent: string | null },
): Promise<LoginResult> {
  const admin = await AdminUserModel.findOne({ email: input.email.toLowerCase() }).select(
    '+passwordHash',
  );
  if (!admin) {
    // Spend the same time as a real verification so response timing does not reveal accounts.
    dummyHash ??= hashPassword(randomToken(16));
    await verifyPassword(await dummyHash, input.password);
    throw unauthorized(GENERIC_LOGIN_ERROR);
  }
  const now = new Date();
  if (admin.lockedUntil && admin.lockedUntil > now) throw unauthorized(GENERIC_LOGIN_ERROR);

  const valid = await verifyPassword(admin.passwordHash, input.password);
  if (!valid) {
    const failures = admin.failedLoginAttempts + 1;
    await AdminUserModel.updateOne(
      { _id: admin._id },
      failures >= MAX_FAILED_LOGINS
        ? { $set: { failedLoginAttempts: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) } }
        : { $set: { failedLoginAttempts: failures } },
    );
    throw unauthorized(GENERIC_LOGIN_ERROR);
  }
  if (!admin.isActive) throw unauthorized(GENERIC_LOGIN_ERROR);

  const update: Record<string, unknown> = {
    failedLoginAttempts: 0,
    lockedUntil: null,
    lastLoginAt: now,
  };
  if (argon2.needsRehash(admin.passwordHash, ARGON2_OPTIONS)) {
    update.passwordHash = await hashPassword(input.password);
  }
  await AdminUserModel.updateOne({ _id: admin._id }, { $set: update });

  const token = await createSession(config, admin._id, input.ip, input.userAgent);
  const plain = admin.toObject();
  delete (plain as Partial<AdminUser>).passwordHash;
  return { token, admin: plain };
}

export async function createSession(
  config: AppConfig,
  adminId: Types.ObjectId,
  ip: string | null,
  userAgent: string | null,
): Promise<string> {
  const token = randomToken(32);
  const now = Date.now();
  await AdminSessionModel.create({
    tokenHash: sha256(token),
    admin: adminId,
    ip,
    userAgent: userAgent?.slice(0, 300) ?? null,
    lastSeenAt: new Date(now),
    expiresAt: new Date(now + Math.min(config.session.idleMs, config.session.ttlMs)),
    absoluteExpiresAt: new Date(now + config.session.ttlMs),
  });
  return token;
}

/** Validates a session cookie; slides the idle timeout at most once a minute. */
export async function resolveSession(
  config: AppConfig,
  token: string,
): Promise<AuthenticatedAdmin | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const tokenHash = sha256(token);
  const now = new Date();
  const session = await AdminSessionModel.findOne({
    tokenHash,
    expiresAt: { $gt: now },
    absoluteExpiresAt: { $gt: now },
  }).lean();
  if (!session) return null;
  const admin = await AdminUserModel.findById(session.admin).lean();
  if (!admin || !admin.isActive) {
    await AdminSessionModel.deleteOne({ _id: session._id });
    return null;
  }
  if (now.getTime() - session.lastSeenAt.getTime() > SESSION_TOUCH_INTERVAL_MS) {
    const expiresAt = new Date(
      Math.min(now.getTime() + config.session.idleMs, session.absoluteExpiresAt.getTime()),
    );
    await AdminSessionModel.updateOne(
      { _id: session._id },
      { $set: { lastSeenAt: now, expiresAt } },
    );
  }
  return {
    id: admin._id,
    email: admin.email,
    name: admin.name,
    role: admin.role,
    mustChangePassword: admin.mustChangePassword,
    sessionId: session._id,
    sessionTokenHash: tokenHash,
  };
}

/** CSRF token bound to the session; derivable server-side so nothing extra is stored. */
export function csrfTokenFor(config: AppConfig, sessionTokenHash: string): string {
  return hmac(config.appSecret, `csrf:${sessionTokenHash}`);
}

export async function revokeSession(sessionId: Types.ObjectId): Promise<void> {
  await AdminSessionModel.deleteOne({ _id: sessionId });
}

export async function revokeAllSessions(
  adminId: Types.ObjectId,
  exceptSessionId?: Types.ObjectId,
): Promise<number> {
  const result = await AdminSessionModel.deleteMany({
    admin: adminId,
    ...(exceptSessionId ? { _id: { $ne: exceptSessionId } } : {}),
  });
  return result.deletedCount;
}

export async function changePassword(
  actor: AuthenticatedAdmin,
  input: { currentPassword: string; newPassword: string },
): Promise<void> {
  const admin = await AdminUserModel.findById(actor.id).select('+passwordHash');
  if (!admin) throw unauthorized();
  if (!(await verifyPassword(admin.passwordHash, input.currentPassword))) {
    throw validationFailed({ currentPassword: ['Your current password is incorrect.'] });
  }
  if (input.currentPassword === input.newPassword) {
    throw validationFailed({ newPassword: ['Choose a password you have not used here before.'] });
  }
  assertStrongPassword(input.newPassword, { email: admin.email, name: admin.name });
  admin.passwordHash = await hashPassword(input.newPassword);
  admin.mustChangePassword = false;
  admin.passwordChangedAt = new Date();
  await admin.save();
  await revokeAllSessions(admin._id, actor.sessionId);
}

/** Creates a single-use reset token (only its hash is stored) and invalidates older ones. */
export async function issuePasswordResetToken(
  adminId: Types.ObjectId,
  issuedBy: Types.ObjectId | null,
): Promise<string> {
  const token = randomToken(32);
  await PasswordResetTokenModel.deleteMany({ admin: adminId });
  await PasswordResetTokenModel.create({
    tokenHash: sha256(token),
    admin: adminId,
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    issuedBy,
  });
  return token;
}

export async function resetPasswordWithToken(input: {
  token: string;
  newPassword: string;
}): Promise<AdminUser> {
  const record = await PasswordResetTokenModel.findOne({
    tokenHash: sha256(input.token),
    usedAt: null,
    expiresAt: { $gt: new Date() },
  });
  if (!record)
    throw new AppError(400, 'INVALID_RESET_TOKEN', 'This reset link is invalid or has expired.');
  const admin = await AdminUserModel.findById(record.admin).select('+passwordHash');
  if (!admin || !admin.isActive) {
    throw new AppError(400, 'INVALID_RESET_TOKEN', 'This reset link is invalid or has expired.');
  }
  assertStrongPassword(input.newPassword, { email: admin.email, name: admin.name });
  // Claim the token atomically so two concurrent requests cannot both use it.
  const claimed = await PasswordResetTokenModel.updateOne(
    { _id: record._id, usedAt: null },
    { $set: { usedAt: new Date() } },
  );
  if (claimed.modifiedCount !== 1) {
    throw new AppError(400, 'INVALID_RESET_TOKEN', 'This reset link is invalid or has expired.');
  }
  admin.passwordHash = await hashPassword(input.newPassword);
  admin.mustChangePassword = false;
  admin.passwordChangedAt = new Date();
  admin.failedLoginAttempts = 0;
  admin.lockedUntil = null;
  await admin.save();
  await revokeAllSessions(admin._id);
  const plain = admin.toObject();
  delete (plain as Partial<AdminUser>).passwordHash;
  return plain;
}
