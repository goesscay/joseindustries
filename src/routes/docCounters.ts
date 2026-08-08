import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { DocCounter } from "../types";

export const docCountersRouter = Router();
const MODULE = "settings.document_numbering";
docCountersRouter.use(requireAuth);

docCountersRouter.get(
  "/",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (_req, res) => {
    const [rows] = await pool.query<any[]>(
      `SELECT dc.*, co.name as company_name
       FROM doc_counters dc
       LEFT JOIN companies co ON co.code = dc.company_code
       ORDER BY dc.company_code ASC, dc.financial_year DESC, dc.doc_type ASC`
    );
    res.json({ data: rows as (DocCounter & { company_name: string | null })[] });
  })
);

// Editing a document's sequence directly is a break-glass correction tool
// (e.g. after cleaning up test data left the counter ahead of reality) - a
// wrong edit can cause duplicate or skipped invoice numbers, so it's
// restricted to super_admin only.
docCountersRouter.put(
  "/",
  requireRole("super_admin"),
  asyncHandler(async (req, res) => {
    const { doc_type, company_code, financial_year, last_number } = req.body ?? {};
    if (!doc_type || !company_code || !financial_year || last_number === undefined) {
      return res.status(400).json({ message: "doc_type, company_code, financial_year and last_number are required" });
    }
    if (!Number.isInteger(Number(last_number)) || Number(last_number) < 0) {
      return res.status(400).json({ message: "last_number must be a non-negative integer" });
    }

    const [existing] = await pool.query<any[]>(
      "SELECT * FROM doc_counters WHERE doc_type = ? AND company_code = ? AND financial_year = ?",
      [doc_type, company_code, financial_year]
    );
    if (!existing[0]) return res.status(404).json({ message: "Counter not found" });

    await pool.query(
      "UPDATE doc_counters SET last_number = ? WHERE doc_type = ? AND company_code = ? AND financial_year = ?",
      [last_number, doc_type, company_code, financial_year]
    );
    res.json({ message: "Counter updated" });
  })
);
