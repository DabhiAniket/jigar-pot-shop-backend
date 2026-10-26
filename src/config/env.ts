import path from 'node:path';
import { normalizeWhatsAppNumber } from '@jmh/shared';
import { z } from 'zod';

const flag = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined));

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),

    APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters of random data'),

    MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, 'MONGODB_URI must be a mongodb:// URI'),
    MONGODB_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(500).default(50),
    MONGODB_AUTO_INDEX: flag.optional(),

    REDIS_URL: z
      .string()
      .regex(/^rediss?:\/\//, 'REDIS_URL must start with redis:// or rediss://')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    JOBS_DRIVER: z.enum(['inline', 'bullmq', 'direct']).optional(),
    // Set by the Vercel runtime.
    VERCEL: optionalString,

    PUBLIC_WEB_URL: z.url(),
    CORS_ORIGINS: optionalString,
    TRUST_PROXY: z.string().default('loopback, linklocal, uniquelocal'),
    COOKIE_SECURE: flag.optional(),
    SESSION_TTL_HOURS: z.coerce.number().min(1).max(720).default(12),
    SESSION_IDLE_MINUTES: z.coerce.number().min(5).max(1440).default(120),

    STORAGE_DRIVER: z.enum(['local', 's3', 'blob']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('./storage'),
    MEDIA_PUBLIC_BASE_URL: z.url(),
    S3_BUCKET: optionalString,
    S3_REGION: optionalString,
    S3_ENDPOINT: optionalString,
    S3_ACCESS_KEY_ID: optionalString,
    S3_SECRET_ACCESS_KEY: optionalString,
    S3_FORCE_PATH_STYLE: flag.default(false),
    // Vercel Blob read-write token. Server-only: never send it to the browser.
    BLOB_READ_WRITE_TOKEN: optionalString,

    MEDIA_MAX_UPLOAD_MB: z.coerce.number().min(1).max(50).default(15),
    MEDIA_MAX_INPUT_PIXELS: z.coerce
      .number()
      .int()
      .min(1_000_000)
      .max(268_402_689)
      .default(60_000_000),
    MEDIA_WEBP_QUALITY: z.coerce.number().int().min(50).max(100).default(82),
    MEDIA_KEEP_ORIGINALS: flag.default(false),
    MEDIA_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),

    WHATSAPP_BUSINESS_NUMBER: optionalString,
    WEB_REVALIDATE_URL: z
      .url()
      .optional()
      .or(z.literal('').transform(() => undefined)),
    REVALIDATE_SECRET: optionalString,

    SMTP_URL: optionalString,
    MAIL_FROM: optionalString,

    METRICS_TOKEN: optionalString,
    INTERNAL_API_TOKEN: optionalString,
    ORDER_NUMBER_PREFIX: z
      .string()
      .regex(/^[A-Z]{2,6}$/)
      .default('JMH'),
    AUDIT_RETENTION_DAYS: z.coerce.number().int().min(30).max(3650).default(730),
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_DRIVER === 's3') {
      for (const key of ['S3_BUCKET', 'S3_REGION'] as const) {
        if (!env[key])
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when STORAGE_DRIVER=s3`,
          });
      }
    }
    if (env.STORAGE_DRIVER === 'blob') {
      if (!env.BLOB_READ_WRITE_TOKEN)
        ctx.addIssue({
          code: 'custom',
          path: ['BLOB_READ_WRITE_TOKEN'],
          message: 'BLOB_READ_WRITE_TOKEN is required when STORAGE_DRIVER=blob',
        });
      if (
        !/^https:\/\/[^/]+\.public\.blob\.vercel-storage\.com\/?$/.test(env.MEDIA_PUBLIC_BASE_URL)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['MEDIA_PUBLIC_BASE_URL'],
          message:
            'MEDIA_PUBLIC_BASE_URL must be the Blob store public URL (https://<id>.public.blob.vercel-storage.com)',
        });
    }
    if (env.VERCEL && env.STORAGE_DRIVER === 'local') {
      ctx.addIssue({
        code: 'custom',
        path: ['STORAGE_DRIVER'],
        message: 'Vercel functions have a read-only filesystem: set STORAGE_DRIVER=blob (or s3)',
      });
    }
    if (env.JOBS_DRIVER === 'bullmq' && !env.REDIS_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_URL'],
        message: 'REDIS_URL is required when JOBS_DRIVER=bullmq',
      });
    }
    if (env.INTERNAL_API_TOKEN && env.INTERNAL_API_TOKEN.length < 24) {
      ctx.addIssue({
        code: 'custom',
        path: ['INTERNAL_API_TOKEN'],
        message: 'INTERNAL_API_TOKEN must be at least 24 characters',
      });
    }
    if (env.REVALIDATE_SECRET && env.REVALIDATE_SECRET.length < 16) {
      ctx.addIssue({
        code: 'custom',
        path: ['REVALIDATE_SECRET'],
        message: 'REVALIDATE_SECRET must be at least 16 characters',
      });
    }
    if (env.WHATSAPP_BUSINESS_NUMBER && !normalizeWhatsAppNumber(env.WHATSAPP_BUSINESS_NUMBER)) {
      ctx.addIssue({
        code: 'custom',
        path: ['WHATSAPP_BUSINESS_NUMBER'],
        message: 'Use the international format without "+", e.g. 919876543210',
      });
    }
    if (env.NODE_ENV === 'production' && env.COOKIE_SECURE === false) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'Cookies must be Secure in production',
      });
    }
  });

export type AppConfig = ReturnType<typeof buildConfig>;

function buildConfig(source: NodeJS.ProcessEnv) {
  // FRONTEND_URL is accepted as an alias for PUBLIC_WEB_URL.
  const parsed = envSchema.safeParse({
    ...source,
    PUBLIC_WEB_URL: source.PUBLIC_WEB_URL ?? source.FRONTEND_URL,
  });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  const env = parsed.data;
  const isProd = env.NODE_ENV === 'production';
  const cookieSecure = env.COOKIE_SECURE ?? isProd;
  const webOrigin = new URL(env.PUBLIC_WEB_URL).origin;

  return {
    env: env.NODE_ENV,
    isProd,
    isTest: env.NODE_ENV === 'test',
    port: env.PORT,
    host: env.HOST,
    logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : 'info'),
    appSecret: env.APP_SECRET,
    mongo: {
      uri: env.MONGODB_URI,
      maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
      autoIndex: env.MONGODB_AUTO_INDEX ?? !isProd,
    },
    redisUrl: env.REDIS_URL ?? null,
    // Serverless functions may be frozen once the response is sent, so jobs run within the request.
    jobsDriver: env.JOBS_DRIVER ?? (env.VERCEL ? 'direct' : env.REDIS_URL ? 'bullmq' : 'inline'),
    publicWebUrl: webOrigin,
    // Explicit allowlist (never a wildcard): the frontend origin plus any extra CORS_ORIGINS.
    corsOrigins: [
      ...new Set([
        webOrigin,
        ...(env.CORS_ORIGINS ?? '')
          .split(',')
          .filter((origin) => origin.trim())
          .map((origin) => new URL(origin.trim()).origin),
      ]),
    ],
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    cookies: {
      secure: cookieSecure,
      // __Host- cookies must be Secure, host-only and Path=/ — the browser enforces it.
      sessionName: cookieSecure ? '__Host-jmh_session' : 'jmh_session',
      customerName: cookieSecure ? '__Host-jmh_customer' : 'jmh_customer',
    },
    session: {
      ttlMs: env.SESSION_TTL_HOURS * 3_600_000,
      idleMs: env.SESSION_IDLE_MINUTES * 60_000,
    },
    storage: {
      driver: env.STORAGE_DRIVER,
      localDir: path.resolve(env.STORAGE_LOCAL_DIR),
      publicBaseUrl: env.MEDIA_PUBLIC_BASE_URL.replace(/\/+$/, ''),
      blobToken: env.BLOB_READ_WRITE_TOKEN ?? null,
      s3:
        env.STORAGE_DRIVER === 's3'
          ? {
              bucket: env.S3_BUCKET!,
              region: env.S3_REGION!,
              endpoint: env.S3_ENDPOINT,
              accessKeyId: env.S3_ACCESS_KEY_ID,
              secretAccessKey: env.S3_SECRET_ACCESS_KEY,
              forcePathStyle: env.S3_FORCE_PATH_STYLE,
            }
          : null,
    },
    media: {
      maxUploadBytes: Math.round(env.MEDIA_MAX_UPLOAD_MB * 1024 * 1024),
      maxInputPixels: env.MEDIA_MAX_INPUT_PIXELS,
      webpQuality: env.MEDIA_WEBP_QUALITY,
      keepOriginals: env.MEDIA_KEEP_ORIGINALS,
      workerConcurrency: env.MEDIA_WORKER_CONCURRENCY,
    },
    whatsappNumber: env.WHATSAPP_BUSINESS_NUMBER
      ? normalizeWhatsAppNumber(env.WHATSAPP_BUSINESS_NUMBER)
      : null,
    revalidate:
      env.WEB_REVALIDATE_URL && env.REVALIDATE_SECRET
        ? { url: env.WEB_REVALIDATE_URL, secret: env.REVALIDATE_SECRET }
        : null,
    mail: env.SMTP_URL
      ? { smtpUrl: env.SMTP_URL, from: env.MAIL_FROM ?? 'no-reply@localhost' }
      : null,
    metricsToken: env.METRICS_TOKEN ?? null,
    internalApiToken: env.INTERNAL_API_TOKEN ?? null,
    orderNumberPrefix: env.ORDER_NUMBER_PREFIX,
    auditRetentionDays: env.AUDIT_RETENTION_DAYS,
  };
}

function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  cached ??= buildConfig(process.env);
  return cached;
}

/** Test helper: re-read process.env on next access. */
export function resetConfigForTests(): void {
  cached = null;
}
