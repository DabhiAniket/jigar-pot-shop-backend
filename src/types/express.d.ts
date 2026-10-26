import type { AdminRole } from '@jmh/shared';
import type { Types } from 'mongoose';

export interface AuthenticatedAdmin {
  id: Types.ObjectId;
  email: string;
  name: string;
  role: AdminRole;
  mustChangePassword: boolean;
  sessionId: Types.ObjectId;
  sessionTokenHash: string;
}

export interface AuthenticatedCustomer {
  id: Types.ObjectId;
  email: string;
  name: string;
  phone: string;
  sessionId: Types.ObjectId;
  sessionTokenHash: string;
}

declare global {
  namespace Express {
    interface Request {
      admin?: AuthenticatedAdmin;
      /** Set only from a verified customer session cookie, never from request data. */
      customer?: AuthenticatedCustomer;
    }
  }
}
