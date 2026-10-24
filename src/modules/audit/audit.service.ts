import type { Request } from 'express';
import type { Types } from 'mongoose';
import type { AuditEventDTO } from '@jmh/shared';
import { AuditEventModel, type AuditEvent } from '../../db/models';
import { logger } from '../../lib/logger';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  metadata?: Record<string, unknown> | null;
}

export interface AuditActor {
  id: Types.ObjectId;
  email: string;
  name: string;
}

/**
 * Records a sensitive admin action with who did it, when and from where. The actor defaults to
 * the signed-in admin; pass one explicitly for sign-in and reset flows (or null for none).
 */
export async function audit(
  req: Request,
  input: AuditInput,
  actor: AuditActor | null | undefined = req.admin,
): Promise<void> {
  try {
    await AuditEventModel.create({
      actor: actor?.id ?? null,
      actorEmail: actor?.email ?? null,
      actorName: actor?.name ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      summary: input.summary.slice(0, 500),
      metadata: input.metadata ?? null,
      ip: req.ip ?? null,
    });
  } catch (error) {
    // Auditing must not break the action itself, but a failure here is worth an alert.
    logger.error(
      { err: (error as Error).message, action: input.action },
      'failed to write audit event',
    );
  }
}

export function auditEventDTO(event: AuditEvent): AuditEventDTO {
  return {
    id: event._id.toString(),
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    summary: event.summary,
    actorName: event.actorName,
    actorEmail: event.actorEmail,
    ip: event.ip,
    createdAt: event.createdAt.toISOString(),
  };
}
