import { model, Schema, type Types } from 'mongoose';
import {
  MEDIA_STATUSES,
  PROMOTION_SCOPES,
  PROMOTION_TYPES,
  type MediaStatus,
  type PromotionScope,
  type PromotionType,
} from '@jmh/shared';
import {
  imageRefSchema,
  seoSchema,
  storedVariantSchema,
  type ImageRef,
  type Seo,
  type StoredVariant,
} from './shared-schemas';

export interface Category {
  _id: Types.ObjectId;
  name: string;
  nameGu: string | null;
  slug: string;
  description: string;
  image: ImageRef | null;
  sortOrder: number;
  isActive: boolean;
  showOnHome: boolean;
  seo: Seo;
  createdAt: Date;
  updatedAt: Date;
}

const categorySchema = new Schema<Category>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    nameGu: { type: String, default: null, maxlength: 80 },
    slug: { type: String, required: true, lowercase: true, trim: true, maxlength: 80 },
    description: { type: String, default: '', maxlength: 1000 },
    image: { type: imageRefSchema, default: null },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    showOnHome: { type: Boolean, default: true },
    seo: { type: seoSchema, default: () => ({}) },
  },
  { timestamps: true },
);
categorySchema.index({ slug: 1 }, { unique: true });
categorySchema.index({ isActive: 1, sortOrder: 1 });
categorySchema.index({ 'image.asset': 1 });

export const CategoryModel = model<Category>('Category', categorySchema);

export interface MediaAsset {
  _id: Types.ObjectId;
  status: MediaStatus;
  alt: string;
  originalFilename: string;
  sourceFormat: string | null;
  sourceBytes: number;
  sourceWidth: number | null;
  sourceHeight: number | null;
  crop: { x: number; y: number; width: number; height: number; rotation: number } | null;
  width: number | null;
  height: number | null;
  variants: StoredVariant[];
  totalBytes: number;
  placeholder: string | null;
  /** Private storage key of the uploaded original while it waits for processing. */
  incomingKey: string | null;
  /** Private storage key of the retained original (only when MEDIA_KEEP_ORIGINALS=true). */
  originalKey: string | null;
  error: string | null;
  attempts: number;
  processedAt: Date | null;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const mediaAssetSchema = new Schema<MediaAsset>(
  {
    status: { type: String, enum: MEDIA_STATUSES, default: 'processing' },
    alt: { type: String, default: '', maxlength: 200 },
    originalFilename: { type: String, default: 'upload', maxlength: 200 },
    sourceFormat: { type: String, default: null },
    sourceBytes: { type: Number, default: 0 },
    sourceWidth: { type: Number, default: null },
    sourceHeight: { type: Number, default: null },
    crop: {
      type: new Schema(
        {
          x: Number,
          y: Number,
          width: Number,
          height: Number,
          rotation: { type: Number, default: 0 },
        },
        { _id: false },
      ),
      default: null,
    },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    variants: { type: [storedVariantSchema], default: [] },
    totalBytes: { type: Number, default: 0 },
    placeholder: { type: String, default: null },
    incomingKey: { type: String, default: null },
    originalKey: { type: String, default: null },
    error: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    processedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'AdminUser', default: null },
  },
  { timestamps: true },
);
mediaAssetSchema.index({ createdAt: -1 });
mediaAssetSchema.index({ status: 1, updatedAt: 1 });

export const MediaAssetModel = model<MediaAsset>('MediaAsset', mediaAssetSchema);

export interface Promotion {
  _id: Types.ObjectId;
  name: string;
  description: string;
  type: PromotionType;
  value: number;
  maxDiscount: number | null;
  minOrderValue: number | null;
  scope: PromotionScope;
  categoryIds: Types.ObjectId[];
  productIds: Types.ObjectId[];
  code: string | null;
  startsAt: Date;
  endsAt: Date;
  isActive: boolean;
  priority: number;
  banner: {
    show: boolean;
    headline: string | null;
    subtext: string | null;
    ctaLabel: string | null;
    ctaHref: string | null;
  };
  createdAt: Date;
  updatedAt: Date;
}

const promotionSchema = new Schema<Promotion>(
  {
    name: { type: String, required: true, maxlength: 80 },
    description: { type: String, default: '', maxlength: 500 },
    type: { type: String, enum: PROMOTION_TYPES, required: true },
    value: { type: Number, required: true, min: 1 },
    maxDiscount: { type: Number, default: null },
    minOrderValue: { type: Number, default: null },
    scope: { type: String, enum: PROMOTION_SCOPES, default: 'all' },
    categoryIds: { type: [Schema.Types.ObjectId], default: [] },
    productIds: { type: [Schema.Types.ObjectId], default: [] },
    code: { type: String, default: null, uppercase: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    isActive: { type: Boolean, default: true },
    priority: { type: Number, default: 0 },
    banner: {
      type: new Schema(
        {
          show: { type: Boolean, default: false },
          headline: { type: String, default: null },
          subtext: { type: String, default: null },
          ctaLabel: { type: String, default: null },
          ctaHref: { type: String, default: null },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
  },
  { timestamps: true },
);
promotionSchema.index({ isActive: 1, endsAt: 1, startsAt: 1 });
promotionSchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { code: { $type: 'string' } } },
);

export const PromotionModel = model<Promotion>('Promotion', promotionSchema);
