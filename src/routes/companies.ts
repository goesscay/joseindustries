import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { Company } from "../types";

export const companiesRouter = Router();

companiesRouter.use(requireAuth);

async function findCompanyById(id: number): Promise<Company | undefined> {
  const [rows] = await pool.query<any[]>("SELECT * FROM companies WHERE id = ? LIMIT 1", [id]);
  return rows[0] as Company | undefined;
}

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
  requireRole("super_admin", "admin"),
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
