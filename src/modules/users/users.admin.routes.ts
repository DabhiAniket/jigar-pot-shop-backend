import { Router } from 'express';
import { Types, type QueryFilter } from 'mongoose';
import {
  ADMIN_ROLE_LABELS,
  auditListQuerySchema,
  createAdminUserSchema,
  objectIdSchema,
  updateAdminUserSchema,
  type AdminUserDTO,
} from '@jmh/shared';
import type { AppContext } from '../../context';
import {
  AdminSessionModel,
  AdminUserModel,
  AuditEventModel,
  type AdminUser,
  type AuditEvent,
} from '../../db/models';
import { AppError, conflict, isDuplicateKeyError, notFound } from '../../lib/errors';
import { parseInput } from '../../lib/validate';
import { requirePermission } from '../../middleware/auth';
import { audit, auditEventDTO } from '../audit/audit.service';
import {
  assertStrongPassword,
  hashPassword,
  issuePasswordResetToken,
  RESET_TOKEN_TTL_MS,
  revokeAllSessions,
} from '../auth/auth.service';

async function userDTOs(users: AdminUser[]): Promise<AdminUserDTO[]> {
  const counts = await AdminSessionModel.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { admin: { $in: users.map((user) => user._id) }, expiresAt: { $gt: new Date() } } },
    { $group: { _id: '$admin', count: { $sum: 1 } } },
  ]);
  const byAdmin = new Map(counts.map((row) => [row._id.toString(), row.count]));
  return users.map((user) => ({
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    activeSessions: byAdmin.get(user._id.toString()) ?? 0,
    createdAt: user.createdAt.toISOString(),
  }));
}

/** Prevents locking the shop out: there must always be an active super admin. */
async function assertKeepsASuperAdmin(userId: Types.ObjectId): Promise<void> {
  const others = await AdminUserModel.countDocuments({
    role: 'super_admin',
    isActive: true,
    _id: { $ne: userId },
  });
  if (others === 0) {
    throw new AppError(409, 'LAST_SUPER_ADMIN', 'At least one active Super Admin must remain.');
  }
}

export function usersAdminRoutes(ctx: AppContext): Router {
  const router = Router();
  const manageUsers = requirePermission('users:manage');

  router.get('/users', manageUsers, async (_req, res) => {
    const users = await AdminUserModel.find().sort({ createdAt: 1 }).lean<AdminUser[]>();
    res.set('Cache-Control', 'no-store').json({ data: await userDTOs(users) });
  });

  router.post('/users', manageUsers, async (req, res) => {
    const input = parseInput(createAdminUserSchema, req.body);
    assertStrongPassword(input.temporaryPassword, input, 'temporaryPassword');
    try {
      const user = await AdminUserModel.create({
        email: input.email,
        name: input.name,
        role: input.role,
        passwordHash: await hashPassword(input.temporaryPassword),
        mustChangePassword: true,
        createdBy: req.admin!.id,
      });
      await audit(req, {
        action: 'user.create',
        entityType: 'admin_user',
        entityId: user.id,
        summary: `Created ${ADMIN_ROLE_LABELS[user.role]} account for ${user.email}`,
      });
      res.status(201).json({ data: (await userDTOs([user.toObject()]))[0] });
    } catch (error) {
      if (isDuplicateKeyError(error, 'email'))
        throw conflict('An admin with this email already exists.', 'EMAIL_TAKEN');
      throw error;
    }
  });

  router.patch('/users/:id', manageUsers, async (req, res) => {
    const id = new Types.ObjectId(parseInput(objectIdSchema, req.params.id));
    const input = parseInput(updateAdminUserSchema, req.body);
    const user = await AdminUserModel.findById(id).lean<AdminUser>();
    if (!user) throw notFound('Admin user');
    const demoting =
      input.role !== undefined && input.role !== 'super_admin' && user.role === 'super_admin';
    const deactivating = input.isActive === false && user.isActive;
    if (user.role === 'super_admin' && (demoting || deactivating)) await assertKeepsASuperAdmin(id);
    if (id.equals(req.admin!.id) && (demoting || deactivating)) {
      throw new AppError(409, 'SELF_LOCKOUT', 'You cannot remove your own Super Admin access.');
    }
    const updated = await AdminUserModel.findByIdAndUpdate(
      id,
      { $set: input },
      { returnDocument: 'after' },
    ).lean<AdminUser>();
    // Role or status changes take effect immediately: existing sessions are signed out.
    if (deactivating || (input.role && input.role !== user.role)) await revokeAllSessions(id);
    const changes = [
      input.role && input.role !== user.role
        ? `role ${ADMIN_ROLE_LABELS[user.role]} → ${ADMIN_ROLE_LABELS[input.role]}`
        : null,
      input.isActive !== undefined && input.isActive !== user.isActive
        ? input.isActive
          ? 'activated'
          : 'deactivated'
        : null,
      input.name && input.name !== user.name ? 'renamed' : null,
    ].filter(Boolean);
    await audit(req, {
      action: 'user.update',
      entityType: 'admin_user',
      entityId: id.toString(),
      summary: `Updated ${user.email}: ${changes.join(', ') || 'no changes'}`,
    });
    res.json({ data: (await userDTOs([updated!]))[0] });
  });

  router.post('/users/:id/revoke-sessions', manageUsers, async (req, res) => {
    const id = new Types.ObjectId(parseInput(objectIdSchema, req.params.id));
    const user = await AdminUserModel.findById(id).lean<AdminUser>();
    if (!user) throw notFound('Admin user');
    const count = await revokeAllSessions(
      id,
      id.equals(req.admin!.id) ? req.admin!.sessionId : undefined,
    );
    await audit(req, {
      action: 'user.sessions_revoked',
      entityType: 'admin_user',
      entityId: id.toString(),
      summary: `Signed out ${count} session(s) of ${user.email}`,
    });
    res.json({ data: { revoked: count } });
  });

  router.post('/users/:id/reset-link', manageUsers, async (req, res) => {
    const id = new Types.ObjectId(parseInput(objectIdSchema, req.params.id));
    const user = await AdminUserModel.findById(id).lean<AdminUser>();
    if (!user || !user.isActive) throw notFound('Active admin user');
    const token = await issuePasswordResetToken(id, req.admin!.id);
    await audit(req, {
      action: 'user.reset_link',
      entityType: 'admin_user',
      entityId: id.toString(),
      summary: `Issued a password reset link for ${user.email}`,
    });
    res.set('Cache-Control', 'no-store').json({
      data: {
        url: `${ctx.config.publicWebUrl}/admin/reset-password?token=${token}`,
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString(),
      },
    });
  });

  router.get('/audit', requirePermission('audit:read'), async (req, res) => {
    const query = parseInput(auditListQuerySchema, req.query);
    const filter: QueryFilter<AuditEvent> = {};
    if (query.action) filter.action = query.action;
    if (query.entityType) filter.entityType = query.entityType;
    if (query.entityId) filter.entityId = query.entityId;
    if (query.actorId && Types.ObjectId.isValid(query.actorId))
      filter.actor = new Types.ObjectId(query.actorId);
    const [events, total] = await Promise.all([
      AuditEventModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean<AuditEvent[]>(),
      AuditEventModel.countDocuments(filter),
    ]);
    res.set('Cache-Control', 'no-store').json({
      data: events.map(auditEventDTO),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    });
  });

  return router;
}
