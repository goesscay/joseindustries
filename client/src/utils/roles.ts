import { Role } from "../types";

const ASSIGNABLE_ROLES: Record<Role, Role[]> = {
  super_admin: ["super_admin", "admin", "staff"],
  admin: ["admin", "staff"],
  staff: [],
};

export function assignableRoles(actorRole: Role): Role[] {
  return ASSIGNABLE_ROLES[actorRole];
}

export function canManageTarget(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === "super_admin") return true;
  if (actorRole === "admin") return targetRole !== "super_admin";
  return false;
}

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  staff: "Staff",
};

export const ROLE_COLORS: Record<Role, string> = {
  super_admin: "green",
  admin: "blue",
  staff: "default",
};
