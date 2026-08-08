import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { Company } from "../types";

export const companiesRouter = Router();
const MODULE = "settings.company_profile";

companiesRouter.use(requireAuth);

async function findCompanyById(id: number): Promise<Company | undefined> {
  const [rows] = await pool.query<any[]>("SELECT * FROM companies WHERE id = ? LIMIT 1", [id]);
  return rows[0] as Company | undefined;
}

// Deliberately NOT gated by MODULE view: the company list is basic
// reference data (name/code/GSTIN) needed to populate the "Company"
// dropdown on almost every business form across the app (Quotations,
// Receipts, Expenses, Accounts...), not just the Settings > Company
// Profile screen. Gating it would risk breaking those unrelated forms for
// a staff member who's simply never been granted the Settings module.
// Editing company details below is the actually sensitive action, and
// that stays gated.
companiesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const [rows] = await pool.query<any[]>("SELECT * FROM companies ORDER BY name ASC");
    res.json({ data: rows as Company[] });
  })
);

companiesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const company = await findCompanyById(Number(req.params.id));
    if (!company) return res.status(404).json({ message: "Company not found" });
    res.json({ company });
  })
);

companiesRouter.put(
  "/:id",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findCompanyById(id);
    if (!existing) return res.status(404).json({ message: "Company not found" });

    const {
      name,
      tagline,
      address,
      phone,
      email,
      gstin,
      state,
      state_code,
      bank_name,
      bank_account_no,
      bank_ifsc,
      terms_and_conditions,
      is_active,
    } = req.body ?? {};
    if (!name) return res.status(400).json({ message: "Name is required" });

    await pool.query(
      `UPDATE companies SET
         name = ?, tagline = ?, address = ?, phone = ?, email = ?, gstin = ?,
         state = ?, state_code = ?, bank_name = ?, bank_account_no = ?, bank_ifsc = ?,
         terms_and_conditions = ?, is_active = ?
       WHERE id = ?`,
      [
        name,
        tagline || null,
        address || null,
        phone || null,
        email || null,
        gstin || null,
        state || null,
        state_code || null,
        bank_name || null,
        bank_account_no || null,
        bank_ifsc || null,
        terms_and_conditions || null,
        is_active ?? true,
        id,
      ]
    );
    const updated = await findCompanyById(id);
    res.json({ company: updated });
  })
);
