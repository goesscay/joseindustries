import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { Item } from "../types";

export const itemsRouter = Router();
const MODULE = "items.items";

itemsRouter.use(requireAuth);

async function findItemById(id: number): Promise<Item | undefined> {
  const [rows] = await pool.query<any[]>("SELECT * FROM items WHERE id = ? LIMIT 1", [id]);
  return rows[0] as Item | undefined;
}

itemsRouter.get(
  "/",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const perPage = Math.min(Math.max(Number(req.query.perPage) || 10, 1), 100);
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const offset = (page - 1) * perPage;

    const searchClause = search ? "WHERE name LIKE ? OR hsn_code LIKE ?" : "";
    const searchParams = search ? [`%${search}%`, `%${search}%`] : [];

    const [rows] = await pool.query<any[]>(
      `SELECT * FROM items ${searchClause} ORDER BY name ASC LIMIT ? OFFSET ?`,
      [...searchParams, perPage, offset]
    );
    const [countRows] = await pool.query<any[]>(
      `SELECT COUNT(*) as total FROM items ${searchClause}`,
      searchParams
    );

    res.json({ data: rows as Item[], meta: { page, perPage, total: countRows[0].total as number } });
  })
);

itemsRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const { name, hsn_code, unit, default_rate, tax_rate, track_inventory } = req.body ?? {};
    if (!name) return res.status(400).json({ message: "Name is required" });

    const [result] = await pool.query<any>(
      `INSERT INTO items (name, hsn_code, unit, default_rate, tax_rate, track_inventory) VALUES (?, ?, ?, ?, ?, ?)`,
      [name, hsn_code || null, unit || "pcs", default_rate || 0, tax_rate ?? 18, track_inventory ? 1 : 0]
    );
    const created = await findItemById(result.insertId);
    res.status(201).json({ item: created });
  })
);

itemsRouter.put(
  "/:id",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findItemById(id);
    if (!existing) return res.status(404).json({ message: "Item not found" });

    const { name, hsn_code, unit, default_rate, tax_rate, track_inventory } = req.body ?? {};
    if (!name) return res.status(400).json({ message: "Name is required" });

    await pool.query(
      `UPDATE items SET name = ?, hsn_code = ?, unit = ?, default_rate = ?, tax_rate = ?, track_inventory = ? WHERE id = ?`,
      [name, hsn_code || null, unit || "pcs", default_rate || 0, tax_rate ?? 18, track_inventory ? 1 : 0, id]
    );
    const updated = await findItemById(id);
    res.json({ item: updated });
  })
);

itemsRouter.delete(
  "/:id",
  requireModuleAccess(MODULE, "delete"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findItemById(id);
    if (!existing) return res.status(404).json({ message: "Item not found" });

    await pool.query("DELETE FROM items WHERE id = ?", [id]);
    res.json({ message: "Item deleted" });
  })
);
