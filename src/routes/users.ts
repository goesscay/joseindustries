import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { hashPassword } from "../utils/password";
import { canAssignRole, canManageTarget } from "../utils/roles";
import { asyncHandler } from "../utils/asyncHandler";
import { getUserPermissions, getUserAccountIds } from "../utils/permissions";
import { MODULE_KEYS } from "../constants/permissions";
import { Role, Status, User } from "../types";

export const usersRouter = Router();

usersRouter.use(requireAuth, requireRole("super_admin", "admin"));

function toPublicUser(user: User) {
  const { password_hash, ...publicUser } = user;
  return publicUser;
}

async function findUserById(id: number): Promise<User | undefined> {
  const [rows] = await pool.query<any[]>("SELECT * FROM users WHERE id = ? LIMIT 1", [id]);
  return rows[0] as User | undefined;
}

async function countActiveSuperAdmins(): Promise<number> {
  const [rows] = await pool.query<any[]>(
    "SELECT COUNT(*) as count FROM users WHERE role = 'super_admin' AND status = 'active'"
  );
  return rows[0].count as number;
}

usersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const perPage = Math.min(Math.max(Number(req.query.perPage) || 10, 1), 50);
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const offset = (page - 1) * perPage;

    const searchClause = search ? "WHERE name LIKE ? OR email LIKE ?" : "";
    const searchParams = search ? [`%${search}%`, `%${search}%`] : [];

    const [rows] = await pool.query<any[]>(
      `SELECT * FROM users ${searchClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...searchParams, perPage, offset]
    );
    const [countRows] = await pool.query<any[]>(
      `SELECT COUNT(*) as total FROM users ${searchClause}`,
      searchParams
    );

    res.json({
      data: (rows as User[]).map(toPublicUser),
      meta: { page, perPage, total: countRows[0].total as number },
    });
  })
);

usersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { name, email, password, role } = req.body ?? {};
    const actorRole = req.user!.role;

    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: "name, email, password, and role are required" });
    }

    if (!canAssignRole(actorRole, role as Role)) {
      return res.status(403).json({ message: "You cannot assign this role" });
    }

    const password_hash = await hashPassword(password);

    try {
      const [result] = await pool.query<any>(
        "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)",
        [name, email, password_hash, role]
      );
      const created = await findUserById(result.insertId);
      res.status(201).json({ user: toPublicUser(created!) });
    } catch (err: any) {
      if (err.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ message: "A user with this email already exists" });
      }
      throw err;
    }
  })
);

usersRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { name, email, password } = req.body ?? {};
    const actorRole = req.user!.role;

    const target = await findUserById(id);
    if (!target) {
      return res.status(404).json({ message: "User not found" });
    }
    if (!canManageTarget(actorRole, target.role)) {
      return res.status(403).json({ message: "You cannot manage this user" });
    }
    if (!name || !email) {
      return res.status(400).json({ message: "name and email are required" });
    }

    try {
      if (password) {
        const password_hash = await hashPassword(password);
        await pool.query("UPDATE users SET name = ?, email = ?, password_hash = ? WHERE id = ?", [
          name,
          email,
          password_hash,
          id,
        ]);
      } else {
        await pool.query("UPDATE users SET name = ?, email = ? WHERE id = ?", [name, email, id]);
      }
      const updated = await findUserById(id);
      res.json({ user: toPublicUser(updated!) });
    } catch (err: any) {
      if (err.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ message: "A user with this email already exists" });
      }
      throw err;
    }
  })
);

usersRouter.patch(
  "/:id/role",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { role } = req.body ?? {};
    const actorRole = req.user!.role;

    const target = await findUserById(id);
    if (!target) {
      return res.status(404).json({ message: "User not found" });
    }
    if (!canManageTarget(actorRole, target.role) || !canAssignRole(actorRole, role as Role)) {
      return res.status(403).json({ message: "You cannot assign this role" });
    }
    if (target.role === "super_admin" && role !== "super_admin" && (await countActiveSuperAdmins()) <= 1) {
      return res.status(400).json({ message: "At least one super admin must remain" });
    }

    await pool.query("UPDATE users SET role = ? WHERE id = ?", [role, id]);
    const updated = await findUserById(id);
    res.json({ user: toPublicUser(updated!) });
  })
);

usersRouter.patch(
  "/:id/status",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { status } = req.body ?? {};
    const actorRole = req.user!.role;

    if (id === req.user!.sub) {
      return res.status(400).json({ message: "You cannot change your own status" });
    }

    const target = await findUserById(id);
    if (!target) {
      return res.status(404).json({ message: "User not found" });
    }
    if (!canManageTarget(actorRole, target.role)) {
      return res.status(403).json({ message: "You cannot manage this user" });
    }
    if (target.role === "super_admin" && status !== "active" && (await countActiveSuperAdmins()) <= 1) {
      return res.status(400).json({ message: "At least one super admin must remain active" });
    }

    await pool.query("UPDATE users SET status = ? WHERE id = ?", [status as Status, id]);
    const updated = await findUserById(id);
    res.json({ user: toPublicUser(updated!) });
  })
);

// ---- Fine-grained module permissions (view/create/edit/delete per module) ----
// Meaningless for super_admin/admin (they always have full access - see
// utils/permissions.ts), so this is really "staff access control", but any
// authenticated admin/super_admin can read or set it for any manageable
// target regardless of the target's current role.

usersRouter.get(
  "/:id/permissions",
  asyncHandler(async (req, res) => {
    const target = await findUserById(Number(req.params.id));
    if (!target) return res.status(404).json({ message: "User not found" });
    const { restricted, modules } = await getUserPermissions(target.id, target.role);
    res.json({ restricted, modules });
  })
);

usersRouter.put(
  "/:id/permissions",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const target = await findUserById(id);
    if (!target) return res.status(404).json({ message: "User not found" });
    if (!canManageTarget(req.user!.role, target.role)) {
      return res.status(403).json({ message: "You cannot manage this user" });
    }

    const { restricted, modules } = req.body ?? {};
    if (typeof restricted !== "boolean") {
      return res.status(400).json({ message: "restricted (boolean) is required" });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query("DELETE FROM user_permissions WHERE user_id = ?", [id]);
      if (restricted) {
        const entries = Object.entries(modules ?? {}).filter(([key]) => MODULE_KEYS.includes(key));
        for (const [moduleKey, flags] of entries) {
          const f = flags as Record<string, unknown>;
          await conn.query(
            `INSERT INTO user_permissions (user_id, module_key, can_view, can_create, can_edit, can_delete)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [id, moduleKey, Boolean(f.can_view), Boolean(f.can_create), Boolean(f.can_edit), Boolean(f.can_delete)]
          );
        }
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    const result = await getUserPermissions(id, target.role);
    res.json(result);
  })
);

// ---- Per-account access (Banking) ----

usersRouter.get(
  "/:id/account-access",
  asyncHandler(async (req, res) => {
    const target = await findUserById(Number(req.params.id));
    if (!target) return res.status(404).json({ message: "User not found" });
    const accountIds = await getUserAccountIds(target.id, target.role);
    res.json({ restricted: accountIds !== null, accountIds: accountIds ?? [] });
  })
);

usersRouter.put(
  "/:id/account-access",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const target = await findUserById(id);
    if (!target) return res.status(404).json({ message: "User not found" });
    if (!canManageTarget(req.user!.role, target.role)) {
      return res.status(403).json({ message: "You cannot manage this user" });
    }

    const { restricted, accountIds } = req.body ?? {};
    if (typeof restricted !== "boolean") {
      return res.status(400).json({ message: "restricted (boolean) is required" });
    }
    if (restricted && !Array.isArray(accountIds)) {
      return res.status(400).json({ message: "accountIds (array) is required when restricted is true" });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query("DELETE FROM user_account_access WHERE user_id = ?", [id]);
      if (restricted) {
        for (const accountId of accountIds as number[]) {
          await conn.query("INSERT INTO user_account_access (user_id, account_id) VALUES (?, ?)", [id, accountId]);
        }
      }
      await conn.commit();
    } catch (err: any) {
      await conn.rollback();
      if (err?.code === "ER_NO_REFERENCED_ROW_2") {
        return res.status(400).json({ message: "One of the selected accounts does not exist" });
      }
      throw err;
    } finally {
      conn.release();
    }

    const updatedIds = await getUserAccountIds(id, target.role);
    res.json({ restricted: updatedIds !== null, accountIds: updatedIds ?? [] });
  })
);

usersRouter.delete(
  "/:id",
  requireRole("super_admin"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);

    if (id === req.user!.sub) {
      return res.status(400).json({ message: "You cannot delete your own account" });
    }

    const target = await findUserById(id);
    if (!target) {
      return res.status(404).json({ message: "User not found" });
    }
    if (target.role === "super_admin" && (await countActiveSuperAdmins()) <= 1) {
      return res.status(400).json({ message: "At least one super admin must remain" });
    }

    await pool.query("DELETE FROM users WHERE id = ?", [id]);
    res.json({ message: "User deleted" });
  })
);
