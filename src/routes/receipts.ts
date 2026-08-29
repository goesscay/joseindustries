import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess, canAccessAccount } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { getNextDocNumber } from "../services/numbering";
import { streamReceiptPdf } from "../services/pdf/receiptPdf";
import { AccountingError, getJournalBySource, postReceiptJournalTx, reverseJournalTx } from "../services/accounting";
import { Company, Customer, DocumentRecord, Journal, PaymentMode, Receipt, Role } from "../types";

export const receiptsRouter = Router();
const MODULE = "sales.receipts";
receiptsRouter.use(requireAuth);

const PAYMENT_MODES: PaymentMode[] = ["cash", "cheque", "bank_transfer", "upi", "card", "other"];

async function findById(id: number): Promise<Receipt | undefined> {
  const [rows] = await pool.query<any[]>("SELECT * FROM receipts WHERE id = ? LIMIT 1", [id]);
  return rows[0] as Receipt | undefined;
}

receiptsRouter.get(
  "/",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const perPage = Math.min(Math.max(Number(req.query.perPage) || 10, 1), 100);
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const offset = (page - 1) * perPage;

    const searchClause = search ? "AND (r.receipt_no LIKE ? OR c.name LIKE ?)" : "";
    const searchParams = search ? [`%${search}%`, `%${search}%`] : [];

    const [rows] = await pool.query<any[]>(
      `SELECT r.*, c.name as customer_name, co.name as company_name, co.code as company_code,
              inv.doc_number as invoice_number
       FROM receipts r
       JOIN customers c ON c.id = r.customer_id
       JOIN companies co ON co.id = r.company_id
       LEFT JOIN documents inv ON inv.id = r.tax_invoice_id
       WHERE 1=1 ${searchClause}
       ORDER BY r.created_at DESC
       LIMIT ? OFFSET ?`,
      [...searchParams, perPage, offset]
    );
    const [countRows] = await pool.query<any[]>(
      `SELECT COUNT(*) as total FROM receipts r JOIN customers c ON c.id = r.customer_id WHERE 1=1 ${searchClause}`,
      searchParams
    );

    res.json({ data: rows, meta: { page, perPage, total: countRows[0].total as number } });
  })
);

receiptsRouter.get(
  "/:id",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const receipt = await findById(Number(req.params.id));
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    res.json({ receipt });
  })
);

async function validatePayload(body: any, userId: number, userRole: Role) {
  const { company_id, customer_id, tax_invoice_id, account_id, amount, payment_mode, received_date } = body ?? {};

  if (!company_id || !customer_id || !amount || !payment_mode || !received_date) {
    return { error: "company_id, customer_id, amount, payment_mode and received_date are required" };
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

  const [customerRows] = await pool.query<any[]>("SELECT * FROM customers WHERE id = ?", [customer_id]);
  const customer = customerRows[0] as Customer | undefined;
  if (!customer) return { error: "Customer not found" };

  let invoice: DocumentRecord | undefined;
  if (tax_invoice_id) {
    const [invoiceRows] = await pool.query<any[]>(
      "SELECT * FROM documents WHERE id = ? AND doc_type = 'tax_invoice'",
      [tax_invoice_id]
    );
    invoice = invoiceRows[0] as DocumentRecord | undefined;
    if (!invoice) return { error: "Tax invoice not found" };
    if (invoice.customer_id !== Number(customer_id)) {
      return { error: "Selected invoice does not belong to this customer" };
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

  return { company, customer, invoice };
}

// Creating a receipt and posting its accounting journal must succeed or
// fail together - both writes share one connection/transaction so a
// journal-posting failure (e.g. no Accounts Receivable account configured
// for the company) rolls back the receipt instead of leaving it unposted.
receiptsRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const result = await validatePayload(req.body, req.user!.sub, req.user!.role);
    if ("error" in result) return res.status(400).json({ message: result.error });
    const { company } = result;

    const { customer_id, tax_invoice_id, account_id, amount, payment_mode, reference_no, received_date, notes } = req.body;

    const { docNumber, financialYear } = await getNextDocNumber("receipt", company!.code, new Date(received_date));

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [insertResult] = await conn.query<any>(
        `INSERT INTO receipts
           (receipt_no, financial_year, company_id, customer_id, tax_invoice_id, account_id, amount, payment_mode, reference_no, received_date, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          docNumber,
          financialYear,
          req.body.company_id,
          customer_id,
          tax_invoice_id || null,
          account_id || null,
          amount,
          payment_mode,
          reference_no || null,
          received_date,
          notes || null,
          req.user!.sub,
        ]
      );
      const receiptId = insertResult.insertId;

      // No account_id means there's no cash-movement account to post
      // against (the field is optional, same as before this phase) - the
      // receipt is still recorded as a business document, just left
      // unposted rather than guessing an account.
      let journal: Journal | undefined;
      if (account_id) {
        journal = await postReceiptJournalTx(conn, {
          companyId: Number(req.body.company_id),
          accountId: Number(account_id),
          amount: Number(amount),
          receiptId,
          receiptNo: docNumber,
          receivedDate: received_date,
          createdBy: req.user!.sub,
        });
      }

      await conn.commit();
      const created = await findById(receiptId);
      res.status(201).json({ receipt: created, journal: journal ? { id: journal.id, status: journal.status } : null });
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError) {
        return res.status(400).json({ message: `Receipt could not be recorded: ${err.message}` });
      }
      throw err;
    } finally {
      conn.release();
    }
  })
);

// A posted journal is never edited in place. Instead: reverse whatever
// journal currently exists for this receipt (if any) and post a fresh one
// reflecting the corrected figures - both steps, plus the receipt update
// itself, share one transaction. The receipt row is locked FOR UPDATE for
// the duration so two concurrent edits of the same receipt can't race each
// other into posting/reversing journals out of order.
receiptsRouter.put(
  "/:id",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const result = await validatePayload(req.body, req.user!.sub, req.user!.role);
    if ("error" in result) return res.status(400).json({ message: result.error });

    const { company_id, customer_id, tax_invoice_id, account_id, amount, payment_mode, reference_no, received_date, notes } =
      req.body;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [existingRows] = await conn.query<any[]>("SELECT * FROM receipts WHERE id = ? FOR UPDATE", [id]);
      const existing = existingRows[0] as Receipt | undefined;
      if (!existing) {
        await conn.rollback();
        return res.status(404).json({ message: "Receipt not found" });
      }

      await conn.query(
        `UPDATE receipts SET
           company_id = ?, customer_id = ?, tax_invoice_id = ?, account_id = ?, amount = ?, payment_mode = ?,
           reference_no = ?, received_date = ?, notes = ?
         WHERE id = ?`,
        [
          company_id,
          customer_id,
          tax_invoice_id || null,
          account_id || null,
          amount,
          payment_mode,
          reference_no || null,
          received_date,
          notes || null,
          id,
        ]
      );

      const priorJournal = await getJournalBySource("receipt", id);
      if (priorJournal) {
        await reverseJournalTx(conn, priorJournal.id, req.user!.sub);
      }

      let journal: Journal | undefined;
      if (account_id) {
        journal = await postReceiptJournalTx(conn, {
          companyId: Number(company_id),
          accountId: Number(account_id),
          amount: Number(amount),
          receiptId: id,
          receiptNo: existing.receipt_no,
          receivedDate: received_date,
          createdBy: req.user!.sub,
        });
      }

      await conn.commit();
      const updated = await findById(id);
      res.json({ receipt: updated, journal: journal ? { id: journal.id, status: journal.status } : null });
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError) {
        return res.status(400).json({ message: `Receipt could not be updated: ${err.message}` });
      }
      throw err;
    } finally {
      conn.release();
    }
  })
);

// The existing business rule already permits permanently deleting a
// receipt (no soft-delete concept in this app) - preserved as-is. What's
// new is that a posted journal is never left orphaned: if one exists for
// this receipt, it's reversed (never deleted - the reversal itself is the
// audit trail) before the receipt row is removed, and both happen in one
// transaction.
receiptsRouter.delete(
  "/:id",
  requireModuleAccess(MODULE, "delete"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [existingRows] = await conn.query<any[]>("SELECT id FROM receipts WHERE id = ? FOR UPDATE", [id]);
      if (!existingRows[0]) {
        await conn.rollback();
        return res.status(404).json({ message: "Receipt not found" });
      }

      const priorJournal = await getJournalBySource("receipt", id);
      if (priorJournal) {
        await reverseJournalTx(conn, priorJournal.id, req.user!.sub);
      }

      await conn.query("DELETE FROM receipts WHERE id = ?", [id]);
      await conn.commit();
      res.json({ message: "Receipt deleted" });
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError) {
        return res.status(400).json({ message: `Receipt could not be deleted: ${err.message}` });
      }
      throw err;
    } finally {
      conn.release();
    }
  })
);

receiptsRouter.get(
  "/:id/pdf",
  asyncHandler(async (req, res) => {
    const receipt = await findById(Number(req.params.id));
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });

    const [companyRows] = await pool.query<any[]>("SELECT * FROM companies WHERE id = ?", [receipt.company_id]);
    const [customerRows] = await pool.query<any[]>("SELECT * FROM customers WHERE id = ?", [receipt.customer_id]);
    let invoice: DocumentRecord | null = null;
    if (receipt.tax_invoice_id) {
      const [invoiceRows] = await pool.query<any[]>("SELECT * FROM documents WHERE id = ?", [receipt.tax_invoice_id]);
      invoice = (invoiceRows[0] as DocumentRecord) ?? null;
    }

    streamReceiptPdf(res, receipt, customerRows[0] as Customer, companyRows[0] as Company, invoice);
  })
);
