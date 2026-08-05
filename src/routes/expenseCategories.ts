import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { ExpenseCategory } from "../types";

export const expenseCategoriesRouter = Router();

expenseCategoriesRouter.use(requireAuth);

async function findById(id: number): Promise<ExpenseCategory | undefined> {
  const [rows] = await pool.query<any[]>("SELECT * FROM expense_categories WHERE id = ? LIMIT 1", [id]);
  return rows[0] as ExpenseCategory | undefined;
}

// Short lookup list - no pagination, just the full set ordered by name.
expenseCategoriesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const [rows] = await pool.query<any[]>("SELECT * FROM expense_categories ORDER BY name ASC");
    res.json({ data: rows as ExpenseCategory[] });
  })
);

expenseCategoriesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { name } = req.body ?? {};
    if (!name) return res.status(400).json({ message: "Name is required" });

    try {
      const [result] = await pool.query<any>("INSERT INTO expense_categories (name) VALUES (?)", [name]);
      const created = await findById(result.insertId);
      res.status(201).json({ category: created });
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY") {
        return res.status(400).json({ message: "A category with this name already exists" });
      }
      throw err;
    }
  })
);

expenseCategoriesRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findById(id);
    if (!existing) return res.status(404).json({ message: "Category not found" });

    const { name } = req.body ?? {};
    if (!name) return res.status(400).json({ message: "Name is required" });

    try {
      await pool.query("UPDATE expense_categories SET name = ? WHERE id = ?", [name, id]);
      const updated = await findById(id);
      res.json({ category: updated });
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY") {
        return res.status(400).json({ message: "A category with this name already exists" });
      }
      throw err;
    }
  })
);

expenseCategoriesRouter.delete(
  "/:id",
  requireRole("super_admin", "admin"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findById(id);
    if (!existing) return res.status(404).json({ message: "Category not found" });

    try {
      await pool.query("DELETE FROM expense_categories WHERE id = ?", [id]);
      res.json({ message: "Category deleted" });
    } catch (err: any) {
      if (err?.code === "ER_ROW_IS_REFERENCED_2" || err?.code === "ER_ROW_IS_REFERENCED") {
        return res.status(400).json({ message: "This category is used by existing expenses and can't be deleted" });
      }
      throw err;
    }
  })
);
