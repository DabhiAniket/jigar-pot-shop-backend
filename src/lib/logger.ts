import pino from 'pino';

const defaultLevel = process.env.NODE_ENV === 'test' ? 'silent' : 'info';

/**
 * Structured JSON logs. Credentials, cookies and personal fields are redacted at the
 * serializer level so a careless log statement cannot leak them.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? defaultLevel,
  base: { service: process.env.SERVICE_NAME ?? 'jmh-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.headers["x-csrf-token"]',
      'res.headers["set-cookie"]',
      '*.password',
      '*.newPassword',
      '*.currentPassword',
      '*.temporaryPassword',
      '*.passwordHash',
      '*.token',
      '*.accessToken',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
