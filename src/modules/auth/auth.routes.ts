import { Router, type Response } from 'express';
import { Types } from 'mongoose';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  permissionsFor,
  resetPasswordSchema,
  type AdminMe,
  type AdminSessionDTO,
} from '@jmh/shared';
import type { AppContext } from '../../context';
import { AdminSessionModel, AdminUserModel } from '../../db/models';
import { sha256 } from '../../lib/crypto';
import { notFound } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { parseInput } from '../../lib/validate';
import { clientIp, requireAdmin } from '../../middleware/auth';
import { ipAndBodyEmailKey, type LimiterFactory } from '../../middleware/rate-limit';
import { audit } from '../audit/audit.service';
import {
  changePassword,
  csrfTokenFor,
  issuePasswordResetToken,
  login,
  resetPasswordWithToken,
  revokeSession,
  RESET_TOKEN_TTL_MS,
} from './auth.service';

export function authRoutes(ctx: AppContext, limiter: LimiterFactory): Router {
  const router = Router();
  const { config } = ctx;

  const setSessionCookie = (res: Response, token: string) =>
    res.cookie(config.cookies.sessionName, token, {
      httpOnly: true,
      secure: config.cookies.secure,
      sameSite: 'lax',
      path: '/',
      maxAge: config.session.ttlMs,
    });

  const clearSessionCookie = (res: Response) =>
    res.clearCookie(config.cookies.sessionName, {
      httpOnly: true,
      secure: config.cookies.secure,
      sameSite: 'lax',
      path: '/',
    });

  const loginIpLimiter = limiter({ name: 'login-ip', windowMs: 15 * 60_000, limit: 20 });
  const loginAccountLimiter = limiter({
    name: 'login-account',
    windowMs: 15 * 60_000,
    limit: 6,
    key: ipAndBodyEmailKey,
    // Successful sign-ins do not use up the budget; only failed attempts count.
    skipSuccessfulRequests: true,
    message: 'Too many sign-in attempts. Please wait 15 minutes and try again.',
  });
  const recoveryLimiter = limiter({ name: 'password-recovery', windowMs: 60 * 60_000, limit: 6 });

  router.post('/login', loginIpLimiter, loginAccountLimiter, async (req, res) => {
    const input = parseInput(loginSchema, req.body);
    const result = await login(config, {
      email: input.email,
      password: input.password,
      ip: clientIp(req),
      userAgent: req.get('user-agent') ?? null,
    });
    setSessionCookie(res, result.token);
    await audit(
      req,
      {
        action: 'auth.login',
        entityType: 'admin_user',
        entityId: result.admin._id.toString(),
        summary: `${result.admin.email} signed in`,
      },
      { id: result.admin._id, email: result.admin.email, name: result.admin.name },
    );
    const me: AdminMe = {
      id: result.admin._id.toString(),
      email: result.admin.email,
      name: result.admin.name,
      role: result.admin.role,
      permissions: [...permissionsFor(result.admin.role)],
      mustChangePassword: result.admin.mustChangePassword,
      csrfToken: csrfTokenFor(config, sha256(result.token)),
    };
    res.json({ data: me });
  });

  router.post('/logout', async (req, res) => {
    if (req.admin) {
      await revokeSession(req.admin.sessionId);
      await audit(req, {
        action: 'auth.logout',
        entityType: 'admin_user',
        entityId: req.admin.id.toString(),
        summary: `${req.admin.email} signed out`,
      });
    }
    clearSessionCookie(res);
    res.status(204).end();
  });

  router.get('/me', requireAdmin({ allowPendingPasswordChange: true }), (req, res) => {
    const admin = req.admin!;
    const me: AdminMe = {
      id: admin.id.toString(),
      email: admin.email,
      name: admin.name,
      role: admin.role,
      permissions: [...permissionsFor(admin.role)],
      mustChangePassword: admin.mustChangePassword,
      csrfToken: csrfTokenFor(config, admin.sessionTokenHash),
    };
    res.set('Cache-Control', 'no-store').json({ data: me });
  });

  router.post(
    '/change-password',
    requireAdmin({ allowPendingPasswordChange: true }),
    async (req, res) => {
      const input = parseInput(changePasswordSchema, req.body);
      await changePassword(req.admin!, input);
      await audit(req, {
        action: 'auth.password_changed',
        entityType: 'admin_user',
        entityId: req.admin!.id.toString(),
        summary: `${req.admin!.email} changed their password (other sessions signed out)`,
      });
      res.status(204).end();
    },
  );

  router.post('/forgot-password', recoveryLimiter, async (req, res) => {
    const input = parseInput(forgotPasswordSchema, req.body);
    // Same response whether or not the account exists.
    res.status(202).json({
      data: {
        message: ctx.mailer.enabled
          ? 'If that email belongs to an active admin, a reset link has been sent.'
          : 'Email delivery is not configured. Ask a super admin to issue a reset link.',
      },
    });
    if (!ctx.mailer.enabled) return;
    try {
      const admin = await AdminUserModel.findOne({ email: input.email, isActive: true }).lean();
      if (!admin) return;
      const token = await issuePasswordResetToken(admin._id, null);
      await ctx.mailer.send({
        to: admin.email,
        subject: 'Reset your Jigar Matka House admin password',
        text: `A password reset was requested for your account.\n\nReset link (valid for ${RESET_TOKEN_TTL_MS / 60_000} minutes):\n${config.publicWebUrl}/admin/reset-password?token=${token}\n\nIf you did not request this, you can ignore this email.`,
      });
    } catch (error) {
      logger.error({ err: (error as Error).message }, 'failed to send reset email');
    }
  });

  router.post('/reset-password', recoveryLimiter, async (req, res) => {
    const input = parseInput(resetPasswordSchema, req.body);
    const admin = await resetPasswordWithToken(input);
    await audit(
      req,
      {
        action: 'auth.password_reset',
        entityType: 'admin_user',
        entityId: admin._id.toString(),
        summary: `Password reset via link for ${admin.email} (all sessions signed out)`,
      },
      { id: admin._id, email: admin.email, name: admin.name },
    );
    res.status(204).end();
  });

  router.get('/sessions', requireAdmin({ allowPendingPasswordChange: true }), async (req, res) => {
    const sessions = await AdminSessionModel.find({
      admin: req.admin!.id,
      expiresAt: { $gt: new Date() },
    })
      .sort({ lastSeenAt: -1 })
      .lean();
    const data: AdminSessionDTO[] = sessions.map((session) => ({
      id: session._id.toString(),
      current: session._id.equals(req.admin!.sessionId),
      ip: session.ip,
      userAgent: session.userAgent,
      createdAt: session.createdAt.toISOString(),
      lastSeenAt: session.lastSeenAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
    }));
    res.set('Cache-Control', 'no-store').json({ data });
  });

  router.delete(
    '/sessions/:id',
    requireAdmin({ allowPendingPasswordChange: true }),
    async (req, res) => {
      const id = String(req.params.id);
      if (!Types.ObjectId.isValid(id)) throw notFound('Session');
      const result = await AdminSessionModel.deleteOne({ _id: id, admin: req.admin!.id });
      if (result.deletedCount === 0) throw notFound('Session');
      await audit(req, {
        action: 'auth.session_revoked',
        entityType: 'admin_session',
        entityId: id,
        summary: `${req.admin!.email} signed out a session`,
      });
      res.status(204).end();
    },
  );

  return router;
}
