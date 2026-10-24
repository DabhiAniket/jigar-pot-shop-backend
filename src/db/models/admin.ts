import { model, Schema, type HydratedDocument, type Types } from 'mongoose';
import { ADMIN_ROLES, type AdminRole } from '@jmh/shared';

export interface AdminUser {
  _id: Types.ObjectId;
  email: string;
  name: string;
  passwordHash: string;
  role: AdminRole;
  isActive: boolean;
  mustChangePassword: boolean;
  passwordChangedAt: Date | null;
  lastLoginAt: Date | null;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const adminUserSchema = new Schema<AdminUser>(
  {
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 160 },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ADMIN_ROLES, required: true },
    isActive: { type: Boolean, default: true },
    mustChangePassword: { type: Boolean, default: true },
    passwordChangedAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'AdminUser', default: null },
  },
  { timestamps: true },
);
adminUserSchema.index({ email: 1 }, { unique: true });

export const AdminUserModel = model<AdminUser>('AdminUser', adminUserSchema);
export type AdminUserDocument = HydratedDocument<AdminUser>;

/** Server-side session. Only a SHA-256 hash of the cookie token is stored. */
export interface AdminSession {
  _id: Types.ObjectId;
  tokenHash: string;
  admin: Types.ObjectId;
  ip: string | null;
  userAgent: string | null;
  lastSeenAt: Date;
  /** Sliding idle expiry; the TTL index deletes the document after this time. */
  expiresAt: Date;
  /** Hard limit regardless of activity. */
  absoluteExpiresAt: Date;
  createdAt: Date;
}

const adminSessionSchema = new Schema<AdminSession>(
  {
    tokenHash: { type: String, required: true },
    admin: { type: Schema.Types.ObjectId, ref: 'AdminUser', required: true },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null, maxlength: 300 },
    lastSeenAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    absoluteExpiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
adminSessionSchema.index({ tokenHash: 1 }, { unique: true });
adminSessionSchema.index({ admin: 1 });
adminSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AdminSessionModel = model<AdminSession>('AdminSession', adminSessionSchema);

export interface PasswordResetToken {
  _id: Types.ObjectId;
  tokenHash: string;
  admin: Types.ObjectId;
  expiresAt: Date;
  usedAt: Date | null;
  issuedBy: Types.ObjectId | null;
  createdAt: Date;
}

const passwordResetTokenSchema = new Schema<PasswordResetToken>(
  {
    tokenHash: { type: String, required: true },
    admin: { type: Schema.Types.ObjectId, ref: 'AdminUser', required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    issuedBy: { type: Schema.Types.ObjectId, ref: 'AdminUser', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
passwordResetTokenSchema.index({ tokenHash: 1 }, { unique: true });
passwordResetTokenSchema.index({ admin: 1 });
passwordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PasswordResetTokenModel = model<PasswordResetToken>(
  'PasswordResetToken',
  passwordResetTokenSchema,
);

export interface AuditEvent {
  _id: Types.ObjectId;
  actor: Types.ObjectId | null;
  actorEmail: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  createdAt: Date;
}

const auditEventSchema = new Schema<AuditEvent>(
  {
    actor: { type: Schema.Types.ObjectId, ref: 'AdminUser', default: null },
    actorEmail: { type: String, default: null },
    actorName: { type: String, default: null },
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, default: null },
    summary: { type: String, required: true, maxlength: 500 },
    metadata: { type: Schema.Types.Mixed, default: null },
    ip: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
// Recency sorting uses the TTL index on { createdAt: 1 } created by migration 003.
auditEventSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
auditEventSchema.index({ actor: 1, createdAt: -1 });
auditEventSchema.index({ action: 1, createdAt: -1 });

export const AuditEventModel = model<AuditEvent>('AuditEvent', auditEventSchema);
