import { model, Schema, type Types } from 'mongoose';
import type { HomeContentInput, StoreSettingsInput } from '@jmh/shared';
import { imageRefSchema, type ImageRef } from './shared-schemas';

/**
 * Singleton documents. The shape is validated by the shared zod schemas before every write,
 * so the Mongoose schema stays permissive (Mixed) and only enforces the singleton id.
 */
export interface StoreSettingsDoc extends StoreSettingsInput {
  _id: 'store';
  updatedBy: Types.ObjectId | null;
  updatedAt: Date;
  createdAt: Date;
  policiesUpdatedAt: Date | null;
}

const storeSettingsSchema = new Schema<StoreSettingsDoc>(
  {
    _id: { type: String, default: 'store' },
    storeName: { type: String, required: true },
    legalName: { type: String, default: null },
    tagline: { type: String, default: null },
    phone: { type: String, default: null },
    whatsappNumber: { type: String, default: null },
    email: { type: String, default: null },
    gstin: { type: String, default: null },
    address: { type: Schema.Types.Mixed, default: () => ({}) },
    openingHours: { type: Schema.Types.Mixed, default: () => [] },
    social: { type: Schema.Types.Mixed, default: () => ({}) },
    delivery: { type: Schema.Types.Mixed, required: true },
    policies: { type: Schema.Types.Mixed, default: () => ({}) },
    seo: { type: Schema.Types.Mixed, default: () => ({}) },
    policiesUpdatedAt: { type: Date, default: null },
    updatedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, minimize: false },
);

export const StoreSettingsModel = model<StoreSettingsDoc>(
  'StoreSettings',
  storeSettingsSchema,
  'store_settings',
);

export interface HomeContentDoc extends Omit<HomeContentInput, 'hero'> {
  _id: 'home';
  hero: Omit<HomeContentInput['hero'], 'image'> & { image: ImageRef | null };
  updatedBy: Types.ObjectId | null;
  updatedAt: Date;
  createdAt: Date;
}

const homeContentSchema = new Schema<HomeContentDoc>(
  {
    _id: { type: String, default: 'home' },
    hero: {
      type: new Schema(
        {
          eyebrow: { type: String, default: null },
          headline: { type: String, required: true },
          headlineLang: { type: String, enum: ['gu', 'en'], default: 'gu' },
          subheadline: { type: String, default: null },
          primaryCta: { type: Schema.Types.Mixed, required: true },
          secondaryCta: { type: Schema.Types.Mixed, required: true },
          image: { type: imageRefSchema, default: null },
          video: {
            type: Schema.Types.Mixed,
            default: () => ({ mp4Url: null, webmUrl: null, posterUrl: null }),
          },
        },
        { _id: false },
      ),
      required: true,
    },
    story: { type: Schema.Types.Mixed, required: true },
    craft: { type: Schema.Types.Mixed, required: true },
    featuredCategoryIds: { type: [String], default: [] },
    sections: { type: Schema.Types.Mixed, required: true },
    updatedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, minimize: false },
);

export const HomeContentModel = model<HomeContentDoc>(
  'HomeContent',
  homeContentSchema,
  'home_content',
);

export interface MigrationRecord {
  _id: string;
  name: string;
  appliedAt: Date;
}

const migrationSchema = new Schema<MigrationRecord>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    appliedAt: { type: Date, required: true },
  },
  { versionKey: false },
);

export const MigrationModel = model<MigrationRecord>('Migration', migrationSchema, 'migrations');
