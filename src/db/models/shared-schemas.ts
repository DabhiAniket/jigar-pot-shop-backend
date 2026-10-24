import { Schema, type Types } from 'mongoose';
import type { ImageVariantName } from '@jmh/shared';

export interface StoredVariant {
  name: ImageVariantName;
  key: string;
  width: number;
  height: number;
  bytes: number;
}

/**
 * A product/category image: a reference to the MediaAsset plus a denormalised copy of its
 * processed variants, so storefront reads never need a join. URLs are built from storage
 * keys at response time, so changing the CDN host does not require a data migration.
 */
export interface ImageRef {
  asset: Types.ObjectId;
  alt: string;
  width: number;
  height: number;
  placeholder: string | null;
  variants: StoredVariant[];
}

export const storedVariantSchema = new Schema<StoredVariant>(
  {
    name: { type: String, required: true },
    key: { type: String, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    bytes: { type: Number, required: true },
  },
  { _id: false },
);

export const imageRefSchema = new Schema<ImageRef>(
  {
    asset: { type: Schema.Types.ObjectId, ref: 'MediaAsset', required: true },
    alt: { type: String, default: '', maxlength: 200 },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    placeholder: { type: String, default: null },
    variants: { type: [storedVariantSchema], default: [] },
  },
  { _id: false },
);

export interface Seo {
  title: string | null;
  description: string | null;
}

export const seoSchema = new Schema<Seo>(
  {
    title: { type: String, default: null, maxlength: 70 },
    description: { type: String, default: null, maxlength: 170 },
  },
  { _id: false },
);

export interface AddressSnapshot {
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  pincode: string;
}

export const addressSchema = new Schema<AddressSnapshot>(
  {
    line1: { type: String, required: true, maxlength: 160 },
    line2: { type: String, default: null, maxlength: 160 },
    landmark: { type: String, default: null, maxlength: 120 },
    city: { type: String, required: true, maxlength: 80 },
    state: { type: String, required: true, maxlength: 60 },
    pincode: { type: String, required: true, match: /^[1-9]\d{5}$/ },
  },
  { _id: false },
);

export const integerValidator = {
  validator: (value: number | null | undefined) => value == null || Number.isInteger(value),
  message: '{PATH} must be an integer',
};
