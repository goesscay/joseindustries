import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { PaymentTerm } from "../types";

export const paymentTermsRouter = Router();
paymentTermsRouter.use(requireAuth);

async function findById(id: number): Promise<PaymentTerm | undefined> {
  const [rows] = await pool.query<any[]>("SELECT * FROM payment_terms WHERE id = ? LIMIT 1", [id]);
  return rows[0] as PaymentTerm | undefined;
}

paymentTermsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const [rows] = await pool.query<any[]>("SELECT * FROM payment_terms ORDER BY label ASC");
    res.json({ data: rows as PaymentTerm[] });
  })
);

paymentTermsRouter.post(
  "/",
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
  requireRole("super_admin", "admin"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findById(id);
    if (!existing) return res.status(404).json({ message: "Payment term not found" });

    await pool.query("DELETE FROM payment_terms WHERE id = ?", [id]);
    res.json({ message: "Payment term deleted" });
  })
);
