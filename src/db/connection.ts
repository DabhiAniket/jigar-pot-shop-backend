import mongoose from 'mongoose';
import type { AppConfig } from '../config/env';
import { dbCommandDuration } from '../lib/metrics';
import { logger } from '../lib/logger';

const SLOW_COMMAND_MS = 250;
const IGNORED_COMMANDS = new Set([
  'hello',
  'isMaster',
  'ping',
  'saslStart',
  'saslContinue',
  'endSessions',
]);

// NoSQL-injection defence: every request value passes through a zod schema that only admits
// primitives (strings, numbers, booleans, validated ids), so client input can never become a
// query operator object. `sanitizeFilter` is deliberately NOT enabled — it would also neuter the
// server's own operators ($gte, $in, …) unless each were wrapped in mongoose.trusted().
mongoose.set('strictQuery', true);

export async function connectDatabase(config: AppConfig): Promise<typeof mongoose> {
  mongoose.set('autoIndex', config.mongo.autoIndex);
  const connection = await mongoose.connect(config.mongo.uri, {
    maxPoolSize: config.mongo.maxPoolSize,
    minPoolSize: Math.min(2, config.mongo.maxPoolSize),
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
    retryWrites: true,
    monitorCommands: true,
  });

  const client = connection.connection.getClient();
  client.on('commandSucceeded', (event) => {
    if (IGNORED_COMMANDS.has(event.commandName)) return;
    dbCommandDuration.observe({ command: event.commandName }, event.duration / 1000);
    if (event.duration >= SLOW_COMMAND_MS) {
      logger.warn(
        { command: event.commandName, durationMs: event.duration },
        'slow MongoDB command',
      );
    }
  });
  client.on('commandFailed', (event) => {
    if (IGNORED_COMMANDS.has(event.commandName)) return;
    dbCommandDuration.observe({ command: event.commandName }, event.duration / 1000);
  });

  logger.info({ db: connection.connection.name }, 'connected to MongoDB');
  return connection;
}

/** Transactions need a replica set or sharded cluster (MongoDB Atlas always qualifies). */
export async function assertTransactionsSupported(): Promise<void> {
  const admin = mongoose.connection.db?.admin();
  if (!admin) throw new Error('Database not connected');
  const hello = (await admin.command({ hello: 1 })) as { setName?: string; msg?: string };
  if (!hello.setName && hello.msg !== 'isdbgrid') {
    throw new Error(
      'MongoDB must run as a replica set (transactions are required for orders). ' +
        'For local development run `npm run dev:db`, which starts a single-node replica set.',
    );
  }
}

export async function pingDatabase(): Promise<boolean> {
  try {
    if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) return false;
    await mongoose.connection.db.admin().command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}
