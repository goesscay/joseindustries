import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess, canAccessAccount } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { getNextDocNumber } from "../services/numbering";
import { AccountingError, getJournalBySource, postVendorPaymentJournalTx, reverseJournalTx } from "../services/accounting";
import { Company, Expense, Journal, PaymentMode, Role, Vendor, VendorPayment } from "../types";

export const vendorPaymentsRouter = Router();
const MODULE = "expenses.vendor_payments";
vendorPaymentsRouter.use(requireAuth);

const PAYMENT_MODES: PaymentMode[] = ["cash", "cheque", "bank_transfer", "upi", "card", "other"];

async function findById(id: number): Promise<VendorPayment | undefined> {
  const [rows] = await pool.query<any[]>("SELECT * FROM vendor_payments WHERE id = ? LIMIT 1", [id]);
  return rows[0] as VendorPayment | undefined;
}

vendorPaymentsRouter.get(
  "/",
  requireModuleAccess(MODULE, "view"),
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
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const payment = await findById(Number(req.params.id));
    if (!payment) return res.status(404).json({ message: "Vendor payment not found" });
    res.json({ payment });
  })
);

async function validatePayload(body: any, userId: number, userRole: Role) {
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
    const [accountRows] = await pool.query<any[]>(
      "SELECT id, company_id, is_active FROM accounts WHERE id = ?",
      [account_id]
    );
    const account = accountRows[0];
    if (!account) return { error: "Account not found" };
    if (account.company_id !== Number(company_id)) {
      return { error: "Selected account does not belong to this company" };
    }
    if (!account.is_active) {
      return { error: "Selected account is inactive" };
    }
    if (!(await canAccessAccount(userId, userRole, Number(account_id)))) {
      return { error: "You don't have access to this account" };
    }
  }

  return { company, vendor, expense };
}

// Creating a vendor payment and posting its accounting journal must
// succeed or fail together - see the identical reasoning on receipts.ts's
// POST handler.
vendorPaymentsRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const result = await validatePayload(req.body, req.user!.sub, req.user!.role);
    if ("error" in result) return res.status(400).json({ message: result.error });
    const { company } = result;

    const { vendor_id, expense_id, account_id, amount, payment_mode, reference_no, paid_date, notes } = req.body;

    const { docNumber, financialYear } = await getNextDocNumber("vendor_payment", company!.code, new Date(paid_date));

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [insertResult] = await conn.query<any>(
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
      const paymentId = insertResult.insertId;

      // No account_id means there's no cash-movement account to post
      // against (the field is optional, same as before this phase) - the
      // payment is still recorded as a business document, just left
      // unposted rather than guessing an account.
      let journal: Journal | undefined;
      if (account_id) {
        journal = await postVendorPaymentJournalTx(conn, {
          companyId: Number(req.body.company_id),
          accountId: Number(account_id),
          amount: Number(amount),
          paymentId,
          paymentNo: docNumber,
          paidDate: paid_date,
          createdBy: req.user!.sub,
        });
      }

      await conn.commit();
      const created = await findById(paymentId);
      res.status(201).json({ payment: created, journal: journal ? { id: journal.id, status: journal.status } : null });
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError) {
        return res.status(400).json({ message: `Vendor payment could not be recorded: ${err.message}` });
      }
      throw err;
    } finally {
      conn.release();
    }
  })
);

// A posted journal is never edited in place - reverse whatever journal
// currently exists for this payment (if any) and post a fresh one
// reflecting the corrected figures. See receipts.ts's PUT handler for the
// identical reasoning (locking, atomicity, reverse-then-recreate).
vendorPaymentsRouter.put(
  "/:id",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const result = await validatePayload(req.body, req.user!.sub, req.user!.role);
    if ("error" in result) return res.status(400).json({ message: result.error });

    const { vendor_id, expense_id, account_id, amount, payment_mode, reference_no, paid_date, notes } = req.body;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [existingRows] = await conn.query<any[]>("SELECT * FROM vendor_payments WHERE id = ? FOR UPDATE", [id]);
      const existing = existingRows[0] as VendorPayment | undefined;
      if (!existing) {
        await conn.rollback();
        return res.status(404).json({ message: "Vendor payment not found" });
      }

      await conn.query(
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

      const priorJournal = await getJournalBySource("vendor_payment", id);
      if (priorJournal) {
        await reverseJournalTx(conn, priorJournal.id, req.user!.sub);
      }

      let journal: Journal | undefined;
      if (account_id) {
        journal = await postVendorPaymentJournalTx(conn, {
          companyId: Number(req.body.company_id),
          accountId: Number(account_id),
          amount: Number(amount),
          paymentId: id,
          paymentNo: existing.payment_no,
          paidDate: paid_date,
          createdBy: req.user!.sub,
        });
      }

      await conn.commit();
      const updated = await findById(id);
      res.json({ payment: updated, journal: journal ? { id: journal.id, status: journal.status } : null });
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError) {
        return res.status(400).json({ message: `Vendor payment could not be updated: ${err.message}` });
      }
      throw err;
    } finally {
      conn.release();
    }
  })
);

// The existing business rule already permits permanently deleting a
// vendor payment - preserved as-is. What's new is that a posted journal
// is never left orphaned: it's reversed (never deleted) before the
// payment row is removed, both in one transaction. See receipts.ts's
// DELETE handler for the identical reasoning.
vendorPaymentsRouter.delete(
  "/:id",
  requireModuleAccess(MODULE, "delete"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [existingRows] = await conn.query<any[]>("SELECT id FROM vendor_payments WHERE id = ? FOR UPDATE", [id]);
      if (!existingRows[0]) {
        await conn.rollback();
        return res.status(404).json({ message: "Vendor payment not found" });
      }

      const priorJournal = await getJournalBySource("vendor_payment", id);
      if (priorJournal) {
        await reverseJournalTx(conn, priorJournal.id, req.user!.sub);
      }

      await conn.query("DELETE FROM vendor_payments WHERE id = ?", [id]);
      await conn.commit();
      res.json({ message: "Vendor payment deleted" });
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError) {
        return res.status(400).json({ message: `Vendor payment could not be deleted: ${err.message}` });
      }
      throw err;
    } finally {
      conn.release();
    }
  })
);
