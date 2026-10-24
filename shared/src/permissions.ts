export const ADMIN_ROLES = ['super_admin', 'product_manager', 'order_manager'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const ADMIN_ROLE_LABELS: Record<AdminRole, string> = {
  super_admin: 'Super Admin',
  product_manager: 'Product Manager',
  order_manager: 'Order Manager',
};

export const PERMISSIONS = [
  'dashboard:read',
  'products:read',
  'products:write',
  'products:delete',
  'categories:write',
  'media:read',
  'media:write',
  'inventory:read',
  'inventory:write',
  'orders:read',
  'orders:write',
  'customers:read',
  'promotions:read',
  'promotions:write',
  'content:write',
  'settings:read',
  'settings:write',
  'users:manage',
  'audit:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Least-privilege role map. Product managers never see customer data (orders, customers);
 * order managers can read the catalogue but not change it. Only super admins manage
 * accounts, store settings and audit logs.
 */
export const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  super_admin: PERMISSIONS,
  product_manager: [
    'dashboard:read',
    'products:read',
    'products:write',
    'products:delete',
    'categories:write',
    'media:read',
    'media:write',
    'inventory:read',
    'inventory:write',
    'promotions:read',
    'promotions:write',
    'content:write',
    'settings:read',
  ],
  order_manager: [
    'dashboard:read',
    'products:read',
    'media:read',
    'inventory:read',
    'orders:read',
    'orders:write',
    'customers:read',
    'promotions:read',
    'settings:read',
  ],
};

export function hasPermission(role: AdminRole | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function permissionsFor(role: AdminRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}
