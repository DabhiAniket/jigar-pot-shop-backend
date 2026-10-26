import { Types } from 'mongoose';
import type { AppConfig } from '../../config/env';
import { CustomerAccountModel, CustomerSessionModel, type CustomerAccount } from '../../db/models';
import { hmac, randomToken, sha256 } from '../../lib/crypto';
import { isDuplicateKeyError, unauthorized, validationFailed } from '../../lib/errors';
import type { AuthenticatedCustomer } from '../../types/express';
import { assertStrongPassword, hashPassword, verifyPassword } from '../auth/auth.service';

const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MS = 15 * 60_000;
const SESSION_TOUCH_INTERVAL_MS = 60_000;
const GENERIC_LOGIN_ERROR = 'Incorrect email or password.';
let dummyHash: Promise<string> | null = null;

async function createSession(config: AppConfig, accountId: Types.ObjectId): Promise<string> {
  const token = randomToken(32);
  const now = Date.now();
  await CustomerSessionModel.create({
    tokenHash: sha256(token),
    account: accountId,
    lastSeenAt: new Date(now),
    expiresAt: new Date(now + Math.min(config.session.idleMs, config.session.ttlMs)),
    absoluteExpiresAt: new Date(now + config.session.ttlMs),
  });
  return token;
}

export function publicAccount(account: CustomerAccount) {
  const { passwordHash: _hash, ...rest } = account;
  return rest;
}

export async function registerCustomer(
  config: AppConfig,
  input: { name: string; email: string; phone: string; password: string },
): Promise<{ token: string; account: CustomerAccount }> {
  assertStrongPassword(input.password, { email: input.email, name: input.name }, 'password');
  try {
    const created = await CustomerAccountModel.create({
      email: input.email,
      name: input.name,
      phone: input.phone,
      passwordHash: await hashPassword(input.password),
    });
    const token = await createSession(config, created._id);
    return { token, account: publicAccount(created.toObject()) as CustomerAccount };
  } catch (error) {
    if (isDuplicateKeyError(error, 'email'))
      throw validationFailed(
        { email: ['An account with this email already exists. Please sign in.'] },
        'An account with this email already exists. Please sign in.',
      );
    throw error;
  }
}

export async function loginCustomer(
  config: AppConfig,
  input: { email: string; password: string },
): Promise<{ token: string; account: CustomerAccount }> {
  const account = await CustomerAccountModel.findOne({ email: input.email.toLowerCase() }).select(
    '+passwordHash',
  );
  if (!account) {
    // Same cost as a real check, so timing does not reveal which emails have accounts.
    dummyHash ??= hashPassword(randomToken(16));
    await verifyPassword(await dummyHash, input.password);
    throw unauthorized(GENERIC_LOGIN_ERROR);
  }
  const now = new Date();
  if (account.lockedUntil && account.lockedUntil > now) throw unauthorized(GENERIC_LOGIN_ERROR);
  if (!(await verifyPassword(account.passwordHash, input.password))) {
    const failures = account.failedLoginAttempts + 1;
    await CustomerAccountModel.updateOne(
      { _id: account._id },
      failures >= MAX_FAILED_LOGINS
        ? { $set: { failedLoginAttempts: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) } }
        : { $set: { failedLoginAttempts: failures } },
    );
    throw unauthorized(GENERIC_LOGIN_ERROR);
  }
  if (!account.isActive) throw unauthorized(GENERIC_LOGIN_ERROR);
  await CustomerAccountModel.updateOne(
    { _id: account._id },
    { $set: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: now } },
  );
  const token = await createSession(config, account._id);
  return { token, account: publicAccount(account.toObject()) as CustomerAccount };
}

/** Validates a customer session cookie; slides the idle timeout at most once a minute. */
export async function resolveCustomerSession(
  config: AppConfig,
  token: string,
): Promise<AuthenticatedCustomer | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const tokenHash = sha256(token);
  const now = new Date();
  const session = await CustomerSessionModel.findOne({
    tokenHash,
    expiresAt: { $gt: now },
    absoluteExpiresAt: { $gt: now },
  }).lean();
  if (!session) return null;
  const account = await CustomerAccountModel.findById(session.account).lean();
  if (!account || !account.isActive) {
    await CustomerSessionModel.deleteOne({ _id: session._id });
    return null;
  }
  if (now.getTime() - session.lastSeenAt.getTime() > SESSION_TOUCH_INTERVAL_MS) {
    const expiresAt = new Date(
      Math.min(now.getTime() + config.session.idleMs, session.absoluteExpiresAt.getTime()),
    );
    await CustomerSessionModel.updateOne(
      { _id: session._id },
      { $set: { lastSeenAt: now, expiresAt } },
    );
  }
  return {
    id: account._id,
    email: account.email,
    name: account.name,
    phone: account.phone,
    sessionId: session._id,
    sessionTokenHash: tokenHash,
  };
}

export const customerCsrfTokenFor = (config: AppConfig, sessionTokenHash: string): string =>
  hmac(config.appSecret, `csrf-customer:${sessionTokenHash}`);

export async function revokeCustomerSession(sessionId: Types.ObjectId): Promise<void> {
  await CustomerSessionModel.deleteOne({ _id: sessionId });
}
