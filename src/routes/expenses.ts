import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { getNextDocNumber } from "../services/numbering";
import { Company, Expense, Vendor } from "../types";

export const expensesRouter = Router();
expensesRouter.use(requireAuth);

const PAID_AMOUNT_SUBQUERY =
  "COALESCE((SELECT SUM(p.amount) FROM vendor_payments p WHERE p.expense_id = e.id), 0) as paid_amount";

async function findById(id: number): Promise<Expense | undefined> {
  const [rows] = await pool.query<any[]>(
    `SELECT e.*, ${PAID_AMOUNT_SUBQUERY} FROM expenses e WHERE e.id = ? LIMIT 1`,
    [id]
  );
  return rows[0] as Expense | undefined;
}

expensesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const perPage = Math.min(Math.max(Number(req.query.perPage) || 10, 1), 100);
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const offset = (page - 1) * perPage;

    const searchClause = search ? "AND (e.expense_no LIKE ? OR v.name LIKE ? OR e.description LIKE ?)" : "";
    const searchParams = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];

    const [rows] = await pool.query<any[]>(
      `SELECT e.*, ${PAID_AMOUNT_SUBQUERY},
              v.name as vendor_name, cat.name as category_name, co.name as company_name, co.code as company_code
       FROM expenses e
       LEFT JOIN vendors v ON v.id = e.vendor_id
       LEFT JOIN expense_categories cat ON cat.id = e.category_id
       JOIN companies co ON co.id = e.company_id
       WHERE 1=1 ${searchClause}
       ORDER BY e.created_at DESC
       LIMIT ? OFFSET ?`,
      [...searchParams, perPage, offset]
    );
    const [countRows] = await pool.query<any[]>(
      `SELECT COUNT(*) as total FROM expenses e LEFT JOIN vendors v ON v.id = e.vendor_id WHERE 1=1 ${searchClause}`,
      searchParams
    );

    res.json({ data: rows, meta: { page, perPage, total: countRows[0].total as number } });
  })
);

expensesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const expense = await findById(Number(req.params.id));
    if (!expense) return res.status(404).json({ message: "Expense not found" });
    res.json({ expense });
  })
);

async function validatePayload(body: any) {
  const { company_id, amount, expense_date } = body ?? {};
  if (!company_id || amount === undefined || amount === null || !expense_date) {
    return { error: "company_id, amount and expense_date are required" };
  }
  if (!Number.isFinite(Number(amount)) || Number(amount) < 0) {
    return { error: "amount must be a non-negative number" };
  }
  const taxAmount = Number(body.tax_amount) || 0;
  if (taxAmount < 0) return { error: "tax_amount cannot be negative" };

  const [companyRows] = await pool.query<any[]>("SELECT * FROM companies WHERE id = ?", [company_id]);
  const company = companyRows[0] as Company | undefined;
  if (!company) return { error: "Company not found" };

  if (body.vendor_id) {
    const [vendorRows] = await pool.query<any[]>("SELECT * FROM vendors WHERE id = ?", [body.vendor_id]);
    const vendor = vendorRows[0] as Vendor | undefined;
    if (!vendor) return { error: "Vendor not found" };
  }

  if (body.category_id) {
    const [catRows] = await pool.query<any[]>("SELECT id FROM expense_categories WHERE id = ?", [body.category_id]);
    if (!catRows[0]) return { error: "Category not found" };
  }

  return { company, taxAmount };
}

expensesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const result = await validatePayload(req.body);
    if ("error" in result) return res.status(400).json({ message: result.error });
    const { company, taxAmount } = result;

    const { vendor_id, category_id, expense_date, description, amount, reference_no, notes } = req.body;
    const totalAmount = Number(amount) + taxAmount;

    const { docNumber, financialYear } = await getNextDocNumber("expense", company!.code, new Date(expense_date));

    const [insertResult] = await pool.query<any>(
      `INSERT INTO expenses
         (expense_no, financial_year, company_id, vendor_id, category_id, expense_date, description,
          amount, tax_amount, total_amount, reference_no, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        docNumber,
        financialYear,
        req.body.company_id,
        vendor_id || null,
        category_id || null,
        expense_date,
        description || null,
        amount,
        taxAmount,
        totalAmount,
        reference_no || null,
        notes || null,
        req.user!.sub,
      ]
    );

    const created = await findById(insertResult.insertId);
    res.status(201).json({ expense: created });
  })
);

expensesRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findById(id);
    if (!existing) return res.status(404).json({ message: "Expense not found" });

    const result = await validatePayload(req.body);
    if ("error" in result) return res.status(400).json({ message: result.error });
    const { taxAmount } = result;

    const { vendor_id, category_id, expense_date, description, amount, reference_no, notes } = req.body;
    const totalAmount = Number(amount) + taxAmount;

    await pool.query(
      `UPDATE expenses SET
         company_id = ?, vendor_id = ?, category_id = ?, expense_date = ?, description = ?,
         amount = ?, tax_amount = ?, total_amount = ?, reference_no = ?, notes = ?
       WHERE id = ?`,
      [
        req.body.company_id,
        vendor_id || null,
        category_id || null,
        expense_date,
        description || null,
        amount,
        taxAmount,
        totalAmount,
        reference_no || null,
        notes || null,
        id,
      ]
    );

    const updated = await findById(id);
    res.json({ expense: updated });
  })
);

expensesRouter.delete(
  "/:id",
  requireRole("super_admin", "admin"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findById(id);
    if (!existing) return res.status(404).json({ message: "Expense not found" });

    try {
      await pool.query("DELETE FROM expenses WHERE id = ?", [id]);
      res.json({ message: "Expense deleted" });
    } catch (err: any) {
      if (err?.code === "ER_ROW_IS_REFERENCED_2" || err?.code === "ER_ROW_IS_REFERENCED") {
        return res.status(400).json({ message: "This expense has payments recorded against it and can't be deleted" });
      }
      throw err;
    }
  })
);
