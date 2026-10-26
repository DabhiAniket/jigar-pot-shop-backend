import { model, Schema, type HydratedDocument, type Types } from 'mongoose';
import { addressSchema, integerValidator, type AddressSnapshot } from './shared-schemas';

export interface SavedAddress extends AddressSnapshot {
  _id: Types.ObjectId;
  label: string | null;
  isDefault: boolean;
}

/** A signed-in shopper. Separate from AdminUser so a customer session can never reach admin APIs. */
export interface CustomerAccount {
  _id: Types.ObjectId;
  email: string;
  name: string;
  phone: string;
  passwordHash: string;
  addresses: SavedAddress[];
  isActive: boolean;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const savedAddressSchema = new Schema<SavedAddress>({
  ...(addressSchema.obj as Record<string, unknown>),
  label: { type: String, default: null, maxlength: 40 },
  isDefault: { type: Boolean, default: false },
});

const customerAccountSchema = new Schema<CustomerAccount>(
  {
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 160 },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, required: true, match: /^[6-9]\d{9}$/ },
    passwordHash: { type: String, required: true, select: false },
    addresses: { type: [savedAddressSchema], default: [] },
    isActive: { type: Boolean, default: true },
    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
);
customerAccountSchema.index({ email: 1 }, { unique: true });

export const CustomerAccountModel = model<CustomerAccount>(
  'CustomerAccount',
  customerAccountSchema,
);
export type CustomerAccountDocument = HydratedDocument<CustomerAccount>;

/** Server-side session; only a SHA-256 hash of the cookie token is stored. */
export interface CustomerSession {
  _id: Types.ObjectId;
  tokenHash: string;
  account: Types.ObjectId;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
}

const customerSessionSchema = new Schema<CustomerSession>(
  {
    tokenHash: { type: String, required: true },
    account: { type: Schema.Types.ObjectId, ref: 'CustomerAccount', required: true },
    expiresAt: { type: Date, required: true },
    absoluteExpiresAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
customerSessionSchema.index({ tokenHash: 1 }, { unique: true });
customerSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
customerSessionSchema.index({ account: 1 });

export const CustomerSessionModel = model<CustomerSession>(
  'CustomerSession',
  customerSessionSchema,
);

/** One persistent cart per account. Prices are never stored: they are read at quote time. */
export interface ServerCart {
  _id: Types.ObjectId;
  account: Types.ObjectId;
  items: { product: Types.ObjectId; variant: Types.ObjectId | null; quantity: number }[];
  updatedAt: Date;
}

const serverCartSchema = new Schema<ServerCart>(
  {
    account: { type: Schema.Types.ObjectId, ref: 'CustomerAccount', required: true },
    items: {
      type: [
        new Schema(
          {
            product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
            variant: { type: Schema.Types.ObjectId, default: null },
            quantity: { type: Number, required: true, min: 1, validate: integerValidator },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
);
serverCartSchema.index({ account: 1 }, { unique: true });

export const ServerCartModel = model<ServerCart>('ServerCart', serverCartSchema);
