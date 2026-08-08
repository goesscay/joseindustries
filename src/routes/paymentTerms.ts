import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { PaymentTerm } from "../types";

export const paymentTermsRouter = Router();
const MODULE = "settings.payment_terms";
paymentTermsRouter.use(requireAuth);

async function findById(id: number): Promise<PaymentTerm | undefined> {
  const [rows] = await pool.query<any[]>("SELECT * FROM payment_terms WHERE id = ? LIMIT 1", [id]);
  return rows[0] as PaymentTerm | undefined;
}

paymentTermsRouter.get(
  "/",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (_req, res) => {
    const [rows] = await pool.query<any[]>("SELECT * FROM payment_terms ORDER BY label ASC");
    res.json({ data: rows as PaymentTerm[] });
  })
);

paymentTermsRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const { label } = req.body ?? {};
    if (!label) return res.status(400).json({ message: "label is required" });

    try {
      const [result] = await pool.query<any>("INSERT INTO payment_terms (label) VALUES (?)", [label]);
      const created = await findById(result.insertId);
      res.status(201).json({ paymentTerm: created });
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY") {
        return res.status(400).json({ message: "This payment term already exists" });
      }
      throw err;
    }
  })
);

paymentTermsRouter.put(
  "/:id",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findById(id);
    if (!existing) return res.status(404).json({ message: "Payment term not found" });

    const { label } = req.body ?? {};
    if (!label) return res.status(400).json({ message: "label is required" });

    try {
      await pool.query("UPDATE payment_terms SET label = ? WHERE id = ?", [label, id]);
      const updated = await findById(id);
      res.json({ paymentTerm: updated });
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY") {
        return res.status(400).json({ message: "This payment term already exists" });
      }
      throw err;
    }
  })
);

paymentTermsRouter.delete(
  "/:id",
  requireModuleAccess(MODULE, "delete"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findById(id);
    if (!existing) return res.status(404).json({ message: "Payment term not found" });

    await pool.query("DELETE FROM payment_terms WHERE id = ?", [id]);
    res.json({ message: "Payment term deleted" });
  })
);
