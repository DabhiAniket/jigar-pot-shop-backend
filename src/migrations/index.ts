import mongoose from 'mongoose';
import type { AppConfig } from '../config/env';
import {
  AdminSessionModel,
  AdminUserModel,
  AuditEventModel,
  CategoryModel,
  CustomerModel,
  HomeContentModel,
  InventoryMovementModel,
  MediaAssetModel,
  MigrationModel,
  OrderModel,
  PasswordResetTokenModel,
  ProductModel,
  PromotionModel,
  StoreSettingsModel,
} from '../db/models';
import { logger } from '../lib/logger';
import { getHomeContent, getStoreSettings } from '../modules/settings/settings.service';

interface Migration {
  id: string;
  name: string;
  up: (config: AppConfig) => Promise<void>;
}

/**
 * Forward-only, additive migrations. They never drop collections or data; each runs once and
 * is recorded in the `migrations` collection. Add new entries at the end — never edit old ones.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: '001',
    name: 'create-indexes',
    up: async () => {
      const models = [
        ProductModel,
        CategoryModel,
        MediaAssetModel,
        PromotionModel,
        OrderModel,
        CustomerModel,
        InventoryMovementModel,
        AdminUserModel,
        AdminSessionModel,
        PasswordResetTokenModel,
        AuditEventModel,
        StoreSettingsModel,
        HomeContentModel,
      ];
      for (const model of models) {
        await model.createCollection().catch(() => undefined);
        // createIndexes only adds missing indexes; it never removes existing ones.
        await model.createIndexes();
      }
    },
  },
  {
    id: '002',
    name: 'singleton-defaults',
    up: async () => {
      await getStoreSettings();
      await getHomeContent();
    },
  },
  {
    id: '003',
    name: 'audit-retention-ttl',
    up: async (config) => {
      const seconds = config.auditRetentionDays * 86_400;
      await AuditEventModel.collection.createIndex(
        { createdAt: 1 },
        { name: 'audit_retention_ttl', expireAfterSeconds: seconds },
      );
    },
  },
];

const LOCK_ID = '__lock__';
const LOCK_TTL_MS = 10 * 60_000;

export async function runMigrations(config: AppConfig): Promise<string[]> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database not connected');
  const locks = db.collection<{ _id: string; expiresAt: Date }>('migrations_lock');
  const now = new Date();
  await locks.deleteOne({ _id: LOCK_ID, expiresAt: { $lt: now } });
  try {
    await locks.insertOne({ _id: LOCK_ID, expiresAt: new Date(now.getTime() + LOCK_TTL_MS) });
  } catch {
    logger.warn('another process is running migrations; skipping');
    return [];
  }

  const applied: string[] = [];
  try {
    const done = new Set(
      (await MigrationModel.find().select('_id').lean()).map((record) => record._id),
    );
    for (const migration of MIGRATIONS) {
      if (done.has(migration.id)) continue;
      logger.info({ id: migration.id, name: migration.name }, 'applying migration');
      await migration.up(config);
      await MigrationModel.create({
        _id: migration.id,
        name: migration.name,
        appliedAt: new Date(),
      });
      applied.push(migration.id);
    }
  } finally {
    await locks.deleteOne({ _id: LOCK_ID });
  }
  if (applied.length) logger.info({ applied }, 'migrations complete');
  return applied;
}
