import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { getNextDocNumber } from "../services/numbering";
import { AccountingError, getJournalBySource, postExpenseJournalTx, reverseJournalTx } from "../services/accounting";
import { Company, Expense, Journal, Vendor } from "../types";

export const expensesRouter = Router();
const MODULE = "expenses.expenses";
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
  requireModuleAccess(MODULE, "view"),
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
  requireModuleAccess(MODULE, "view"),
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

// Creating an expense and posting its accounting journal must succeed or
// fail together - see the identical reasoning on receipts.ts's POST
// handler. Expenses have no payment-account field (see accounting.ts's
// postExpenseJournalTx doc comment) - the journal here is always Dr
// Expense (+Input GST) / Cr Accounts Payable, never Cr Bank directly.
expensesRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const result = await validatePayload(req.body);
    if ("error" in result) return res.status(400).json({ message: result.error });
    const { company, taxAmount } = result;

    const { vendor_id, category_id, expense_date, description, amount, reference_no, notes } = req.body;
    const totalAmount = Number(amount) + taxAmount;

    const { docNumber, financialYear } = await getNextDocNumber("expense", company!.code, new Date(expense_date));

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [insertResult] = await conn.query<any>(
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
      const expenseId = insertResult.insertId;

      const journal = await postExpenseJournalTx(conn, {
        companyId: Number(req.body.company_id),
        expenseId,
        expenseNo: docNumber,
        expenseDate: expense_date,
        amount: Number(amount),
        taxAmount,
        categoryId: category_id || null,
        createdBy: req.user!.sub,
      });

      await conn.commit();
      const created = await findById(expenseId);
      res.status(201).json({ expense: created, journal: { id: journal.id, status: journal.status } });
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError) {
        return res.status(400).json({ message: `Expense could not be recorded: ${err.message}` });
      }
      throw err;
    } finally {
      conn.release();
    }
  })
);

// A posted journal is never edited in place - reverse whatever journal
// currently exists for this expense and post a fresh one reflecting the
// corrected figures, in the same transaction as the expense update. See
// receipts.ts's PUT handler for the identical reasoning.
expensesRouter.put(
  "/:id",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const result = await validatePayload(req.body);
    if ("error" in result) return res.status(400).json({ message: result.error });
    const { taxAmount } = result;

    const { vendor_id, category_id, expense_date, description, amount, reference_no, notes } = req.body;
    const totalAmount = Number(amount) + taxAmount;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [existingRows] = await conn.query<any[]>("SELECT * FROM expenses WHERE id = ? FOR UPDATE", [id]);
      const existing = existingRows[0] as Expense | undefined;
      if (!existing) {
        await conn.rollback();
        return res.status(404).json({ message: "Expense not found" });
      }

      await conn.query(
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

      const priorJournal = await getJournalBySource("expense", id);
      if (priorJournal) {
        await reverseJournalTx(conn, priorJournal.id, req.user!.sub);
      }

      const journal = await postExpenseJournalTx(conn, {
        companyId: Number(req.body.company_id),
        expenseId: id,
        expenseNo: existing.expense_no,
        expenseDate: expense_date,
        amount: Number(amount),
        taxAmount,
        categoryId: category_id || null,
        createdBy: req.user!.sub,
      });

      await conn.commit();
      const updated = await findById(id);
      res.json({ expense: updated, journal: { id: journal.id, status: journal.status } });
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError) {
        return res.status(400).json({ message: `Expense could not be updated: ${err.message}` });
      }
      throw err;
    } finally {
      conn.release();
    }
  })
);

// The existing business rule already blocks deleting an expense that has
// vendor_payments recorded against it (an FK violation, caught below and
// turned into a friendly message) - preserved exactly as-is. What's new:
// the expense's own journal is reversed first, in the same transaction,
// so a successful delete never leaves an orphan journal - and if the
// delete itself is blocked (payments exist), the whole transaction rolls
// back, including the reversal, so nothing changes at all.
expensesRouter.delete(
  "/:id",
  requireModuleAccess(MODULE, "delete"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [existingRows] = await conn.query<any[]>("SELECT id FROM expenses WHERE id = ? FOR UPDATE", [id]);
      if (!existingRows[0]) {
        await conn.rollback();
        return res.status(404).json({ message: "Expense not found" });
      }

      const priorJournal = await getJournalBySource("expense", id);
      if (priorJournal) {
        await reverseJournalTx(conn, priorJournal.id, req.user!.sub);
      }

      await conn.query("DELETE FROM expenses WHERE id = ?", [id]);
      await conn.commit();
      res.json({ message: "Expense deleted" });
    } catch (err: any) {
      await conn.rollback();
      if (err?.code === "ER_ROW_IS_REFERENCED_2" || err?.code === "ER_ROW_IS_REFERENCED") {
        return res.status(400).json({ message: "This expense has payments recorded against it and can't be deleted" });
      }
      if (err instanceof AccountingError) {
        return res.status(400).json({ message: `Expense could not be deleted: ${err.message}` });
      }
      throw err;
    } finally {
      conn.release();
    }
  })
);
