import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { getNextDocNumber } from "../services/numbering";
import { Company, Expense, PaymentMode, Vendor, VendorPayment } from "../types";

export const vendorPaymentsRouter = Router();
vendorPaymentsRouter.use(requireAuth);

const PAYMENT_MODES: PaymentMode[] = ["cash", "cheque", "bank_transfer", "upi", "card", "other"];

async function findById(id: number): Promise<VendorPayment | undefined> {
  const [rows] = await pool.query<any[]>("SELECT * FROM vendor_payments WHERE id = ? LIMIT 1", [id]);
  return rows[0] as VendorPayment | undefined;
}

vendorPaymentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const perPage = Math.min(Math.max(Number(req.query.perPage) || 10, 1), 100);
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const offset = (page - 1) * perPage;

    const searchClause = search ? "AND (p.payment_no LIKE ? OR v.name LIKE ?)" : "";
    const searchParams = search ? [`%${search}%`, `%${search}%`] : [];

    const [rows] = await pool.query<any[]>(
      `SELECT p.*, v.name as vendor_name, co.name as company_name, co.code as company_code,
              e.expense_no as expense_number
       FROM vendor_payments p
       JOIN vendors v ON v.id = p.vendor_id
       JOIN companies co ON co.id = p.company_id
       LEFT JOIN expenses e ON e.id = p.expense_id
       WHERE 1=1 ${searchClause}
       ORDER BY p.created_at DESC
       LIMIT ? OFFSET ?`,
      [...searchParams, perPage, offset]
    );
    const [countRows] = await pool.query<any[]>(
      `SELECT COUNT(*) as total FROM vendor_payments p JOIN vendors v ON v.id = p.vendor_id WHERE 1=1 ${searchClause}`,
      searchParams
    );

    res.json({ data: rows, meta: { page, perPage, total: countRows[0].total as number } });
  })
);

vendorPaymentsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const payment = await findById(Number(req.params.id));
    if (!payment) return res.status(404).json({ message: "Vendor payment not found" });
    res.json({ payment });
  })
);

async function validatePayload(body: any) {
  const { company_id, vendor_id, expense_id, account_id, amount, payment_mode, paid_date } = body ?? {};

  if (!company_id || !vendor_id || !amount || !payment_mode || !paid_date) {
    return { error: "company_id, vendor_id, amount, payment_mode and paid_date are required" };
  }
  if (!PAYMENT_MODES.includes(payment_mode)) {
    return { error: "Invalid payment_mode" };
  }
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    return { error: "amount must be a positive number" };
  }

  const [companyRows] = await pool.query<any[]>("SELECT * FROM companies WHERE id = ?", [company_id]);
  const company = companyRows[0] as Company | undefined;
  if (!company) return { error: "Company not found" };

  const [vendorRows] = await pool.query<any[]>("SELECT * FROM vendors WHERE id = ?", [vendor_id]);
  const vendor = vendorRows[0] as Vendor | undefined;
  if (!vendor) return { error: "Vendor not found" };

  let expense: Expense | undefined;
  if (expense_id) {
    const [expenseRows] = await pool.query<any[]>("SELECT * FROM expenses WHERE id = ?", [expense_id]);
    expense = expenseRows[0] as Expense | undefined;
    if (!expense) return { error: "Expense not found" };
    if (expense.vendor_id !== Number(vendor_id)) {
      return { error: "Selected expense does not belong to this vendor" };
    }
  }

  if (account_id) {
    const [accountRows] = await pool.query<any[]>("SELECT id, company_id FROM accounts WHERE id = ?", [account_id]);
    const account = accountRows[0];
    if (!account) return { error: "Account not found" };
    if (account.company_id !== Number(company_id)) {
      return { error: "Selected account does not belong to this company" };
    }
  }

  return { company, vendor, expense };
}

vendorPaymentsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const result = await validatePayload(req.body);
    if ("error" in result) return res.status(400).json({ message: result.error });
    const { company } = result;

    const { vendor_id, expense_id, account_id, amount, payment_mode, reference_no, paid_date, notes } = req.body;

    const { docNumber, financialYear } = await getNextDocNumber("vendor_payment", company!.code, new Date(paid_date));

    const [insertResult] = await pool.query<any>(
      `INSERT INTO vendor_payments
         (payment_no, financial_year, company_id, vendor_id, expense_id, account_id, amount, payment_mode, reference_no, paid_date, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        docNumber,
        financialYear,
        req.body.company_id,
        vendor_id,
        expense_id || null,
        account_id || null,
        amount,
        payment_mode,
        reference_no || null,
        paid_date,
        notes || null,
        req.user!.sub,
      ]
    );

    const created = await findById(insertResult.insertId);
    res.status(201).json({ payment: created });
  })
);

vendorPaymentsRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findById(id);
    if (!existing) return res.status(404).json({ message: "Vendor payment not found" });

    const result = await validatePayload(req.body);
    if ("error" in result) return res.status(400).json({ message: result.error });

    const { vendor_id, expense_id, account_id, amount, payment_mode, reference_no, paid_date, notes } = req.body;

    await pool.query(
      `UPDATE vendor_payments SET
         company_id = ?, vendor_id = ?, expense_id = ?, account_id = ?, amount = ?, payment_mode = ?,
         reference_no = ?, paid_date = ?, notes = ?
       WHERE id = ?`,
      [
        req.body.company_id,
        vendor_id,
        expense_id || null,
        account_id || null,
        amount,
        payment_mode,
        reference_no || null,
        paid_date,
        notes || null,
        id,
      ]
    );

    const updated = await findById(id);
    res.json({ payment: updated });
  })
);

vendorPaymentsRouter.delete(
  "/:id",
  requireRole("super_admin", "admin"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findById(id);
    if (!existing) return res.status(404).json({ message: "Vendor payment not found" });
    await pool.query("DELETE FROM vendor_payments WHERE id = ?", [id]);
    res.json({ message: "Vendor payment deleted" });
  })
);
