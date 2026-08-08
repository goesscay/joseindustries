import { Request, Response, NextFunction } from "express";
import { pool } from "../config/db";
import { Role } from "../types";
import { PermissionAction } from "../constants/permissions";

export interface ModuleAccess {
  can_view: boolean;
  can_create: boolean;
  can_edit: boolean;
  can_delete: boolean;
}

const FULL_ACCESS: ModuleAccess = { can_view: true, can_create: true, can_edit: true, can_delete: true };
const NO_ACCESS: ModuleAccess = { can_view: false, can_create: false, can_edit: false, can_delete: false };

function isTrusted(role: Role): boolean {
  return role === "super_admin" || role === "admin";
}

/**
 * Full module-permission matrix for a user, keyed by module_key.
 * super_admin/admin always get FULL_ACCESS for every module, regardless of
 * what's in the table - this system only ever restricts 'staff'.
 *
 * Fallback contract: a staff user with zero rows in user_permissions has
 * full access to everything (matches app behaviour before this table
 * existed, so existing staff accounts are unaffected until an admin opens
 * the Access tab and configures them). The moment they have >=1 row, it
 * becomes an allowlist - any module without a row is denied.
 */
export async function getUserPermissions(
  userId: number,
  role: Role
): Promise<{ restricted: boolean; modules: Record<string, ModuleAccess> }> {
  if (isTrusted(role)) return { restricted: false, modules: {} };

  const [rows] = await pool.query<any[]>(
    "SELECT module_key, can_view, can_create, can_edit, can_delete FROM user_permissions WHERE user_id = ?",
    [userId]
  );
  if (rows.length === 0) return { restricted: false, modules: {} };

  const modules: Record<string, ModuleAccess> = {};
  for (const row of rows) {
    modules[row.module_key] = {
      can_view: Boolean(row.can_view),
      can_create: Boolean(row.can_create),
      can_edit: Boolean(row.can_edit),
      can_delete: Boolean(row.can_delete),
    };
  }
  return { restricted: true, modules };
}

export async function getModuleAccess(userId: number, role: Role, moduleKey: string): Promise<ModuleAccess> {
  if (isTrusted(role)) return FULL_ACCESS;
  const { restricted, modules } = await getUserPermissions(userId, role);
  if (!restricted) return FULL_ACCESS;
  return modules[moduleKey] ?? NO_ACCESS;
}

const ACTION_FIELD: Record<PermissionAction, keyof ModuleAccess> = {
  view: "can_view",
  create: "can_create",
  edit: "can_edit",
  delete: "can_delete",
};

/**
 * Express middleware factory gating a route by module + action. Mirrors
 * requireRole's shape so it drops into existing routers the same way:
 *   router.get("/", requireModuleAccess("contacts.customers", "view"), ...)
 */
export function requireModuleAccess(moduleKey: string, action: PermissionAction) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ message: "Not authenticated" });
    const access = await getModuleAccess(req.user.sub, req.user.role, moduleKey);
    if (!access[ACTION_FIELD[action]]) {
      return res.status(403).json({ message: "Insufficient permissions" });
    }
    next();
  };
}

/**
 * Which Bank & Cash account IDs a user may see/use. Same fallback contract:
 * null = unrestricted (super_admin/admin, or a staff member with zero
 * explicit grants - today's behaviour). A non-null array is an allowlist -
 * the exact accounts an admin has scoped this staff member to.
 */
export async function getUserAccountIds(userId: number, role: Role): Promise<number[] | null> {
  if (isTrusted(role)) return null;
  const [rows] = await pool.query<any[]>("SELECT account_id FROM user_account_access WHERE user_id = ?", [userId]);
  if (rows.length === 0) return null;
  return rows.map((r) => r.account_id as number);
}

/** True if the user is unrestricted, or the account is in their allowlist. */
export async function canAccessAccount(userId: number, role: Role, accountId: number): Promise<boolean> {
  const allowed = await getUserAccountIds(userId, role);
  return allowed === null || allowed.includes(accountId);
}
