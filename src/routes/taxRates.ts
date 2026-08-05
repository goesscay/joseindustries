import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { TaxRate } from "../types";

export const taxRatesRouter = Router();
taxRatesRouter.use(requireAuth);

async function findById(id: number): Promise<TaxRate | undefined> {
  const [rows] = await pool.query<any[]>("SELECT * FROM tax_rates WHERE id = ? LIMIT 1", [id]);
  return rows[0] as TaxRate | undefined;
}

taxRatesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const [rows] = await pool.query<any[]>("SELECT * FROM tax_rates ORDER BY rate ASC");
    res.json({ data: rows as TaxRate[] });
  })
);

taxRatesRouter.post(
  "/",
  requireRole("super_admin", "admin"),
  asyncHandler(async (req, res) => {
    const { label, rate, is_default } = req.body ?? {};
    if (!label || rate === undefined || rate === null) {
      return res.status(400).json({ message: "label and rate are required" });
    }
    if (!Number.isFinite(Number(rate)) || Number(rate) < 0 || Number(rate) > 100) {
      return res.status(400).json({ message: "rate must be between 0 and 100" });
    }

    try {
      if (is_default) {
        await pool.query("UPDATE tax_rates SET is_default = FALSE");
      }
      const [result] = await pool.query<any>(
        "INSERT INTO tax_rates (label, rate, is_default) VALUES (?, ?, ?)",
        [label, rate, Boolean(is_default)]
      );
      const created = await findById(result.insertId);
      res.status(201).json({ taxRate: created });
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY") {
        return res.status(400).json({ message: "A tax rate with this percentage already exists" });
      }
      throw err;
    }
  })
);

taxRatesRouter.put(
  "/:id",
  requireRole("super_admin", "admin"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findById(id);
    if (!existing) return res.status(404).json({ message: "Tax rate not found" });

    const { label, rate, is_default } = req.body ?? {};
    if (!label || rate === undefined || rate === null) {
      return res.status(400).json({ message: "label and rate are required" });
    }
    if (!Number.isFinite(Number(rate)) || Number(rate) < 0 || Number(rate) > 100) {
      return res.status(400).json({ message: "rate must be between 0 and 100" });
    }

    try {
      if (is_default) {
        await pool.query("UPDATE tax_rates SET is_default = FALSE");
      }
      await pool.query("UPDATE tax_rates SET label = ?, rate = ?, is_default = ? WHERE id = ?", [
        label,
        rate,
        Boolean(is_default),
        id,
      ]);
      const updated = await findById(id);
      res.json({ taxRate: updated });
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY") {
        return res.status(400).json({ message: "A tax rate with this percentage already exists" });
      }
      throw err;
    }
  })
);

taxRatesRouter.delete(
  "/:id",
  requireRole("super_admin", "admin"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findById(id);
    if (!existing) return res.status(404).json({ message: "Tax rate not found" });

    await pool.query("DELETE FROM tax_rates WHERE id = ?", [id]);
    res.json({ message: "Tax rate deleted" });
  })
);
