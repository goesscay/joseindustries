import { Role } from "../types";

const ASSIGNABLE_ROLES: Record<Role, Role[]> = {
  super_admin: ["super_admin", "admin", "staff"],
  admin: ["admin", "staff"],
  staff: [],
};

export function canAssignRole(actorRole: Role, targetRole: Role): boolean {
  return ASSIGNABLE_ROLES[actorRole].includes(targetRole);
}

export function canManageTarget(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === "super_admin") return true;
  if (actorRole === "admin") return targetRole !== "super_admin";
  return false;
}
