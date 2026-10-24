import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Crockford base32 without I, L, O, U — easy to read aloud over the phone. */
const READABLE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function readableCode(length: number): string {
  let code = '';
  for (let i = 0; i < length; i++) code += READABLE_ALPHABET[randomInt(READABLE_ALPHABET.length)];
  return code;
}

/** Stable hash of a JSON-compatible value (object keys sorted) for idempotency checks. */
export function canonicalHash(value: unknown): string {
  return sha256(JSON.stringify(sortKeys(value)));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
