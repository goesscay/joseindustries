import { Router } from "express";
import { PoolConnection } from "mysql2/promise";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess, canAccessAccount } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { getNextDocNumber } from "../services/numbering";
import { streamReceiptPdf } from "../services/pdf/receiptPdf";
import { getEffectiveDocumentTemplate } from "../services/documentTemplates";
import { AccountingError, getJournalBySource, postReceiptJournalTx, reverseJournalTx } from "../services/accounting";
import { Company, Customer, DocumentRecord, Journal, OutstandingInvoice, PaymentMode, Receipt, ReceiptAllocation, Role } from "../types";

export const receiptsRouter = Router();
const MODULE = "sales.receipts";
receiptsRouter.use(requireAuth);

const PAYMENT_MODES: PaymentMode[] = ["cash", "cheque", "bank_transfer", "upi", "card", "other"];

class ValidationError extends Error {
  status = 400;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function findById(id: number): Promise<Receipt | undefined> {
  const [rows] = await pool.query<any[]>("SELECT * FROM receipts WHERE id = ? LIMIT 1", [id]);
  return rows[0] as Receipt | undefined;
}

async function findAllocations(receiptId: number): Promise<ReceiptAllocation[]> {
  const [rows] = await pool.query<any[]>(
    `SELECT ra.*, d.doc_number as invoice_number
     FROM receipt_allocations ra JOIN documents d ON d.id = ra.tax_invoice_id
     WHERE ra.receipt_id = ? ORDER BY d.issue_date ASC, ra.id ASC`,
    [receiptId]
  );
  return rows as ReceiptAllocation[];
}

/**
 * Every non-cancelled Tax Invoice for one customer+company with a balance
 * still outstanding, oldest `issue_date` first - what the New Receipt flow
 * auto-allocates a payment against. Net of both prior receipts (via
 * receipt_allocations, never the legacy single receipts.tax_invoice_id
 * column - see schema.sql's comment on receipt_allocations for why that
 * column is no longer authoritative) and non-cancelled Credit Notes -
 * omitting the Credit Notes term here was a real display bug in the
 * pre-existing invoice-list `paid_amount` column (see
 * salesDocuments.ts's own fix), fixed for good in this one shared query.
 *
 * `excludeReceiptId`, when given, backs that receipt's own existing
 * allocations out of the "already paid" figure first - editing a receipt
 * must not have its own prior amounts count against itself when
 * recomputing what's newly available to allocate.
 */
async function getOutstandingInvoices(
  customerId: number,
  companyId: number,
  excludeReceiptId?: number
): Promise<OutstandingInvoice[]> {
  const [rows] = await pool.query<any[]>(
    `SELECT d.id, d.doc_number, d.issue_date, d.grand_total,
            COALESCE((SELECT SUM(ra.amount) FROM receipt_allocations ra
                      WHERE ra.tax_invoice_id = d.id ${excludeReceiptId ? "AND ra.receipt_id != ?" : ""}), 0)
              + COALESCE((SELECT SUM(cn.grand_total) FROM credit_notes cn
                          WHERE cn.tax_invoice_id = d.id AND cn.status != 'cancelled'), 0)
              as paid_amount
     FROM documents d
     WHERE d.doc_type = 'tax_invoice' AND d.status != 'cancelled'
       AND d.customer_id = ? AND d.company_id = ?
     ORDER BY d.issue_date ASC, d.id ASC`,
    excludeReceiptId ? [excludeReceiptId, customerId, companyId] : [customerId, companyId]
  );
  return rows
    .map((r) => {
      const grandTotal = Number(r.grand_total);
      const paid = round2(Number(r.paid_amount));
      return {
        id: r.id,
        doc_number: r.doc_number,
        issue_date: r.issue_date,
        grand_total: grandTotal,
        paid_amount: paid,
        balance_due: round2(grandTotal - paid),
      };
    })
    .filter((r) => r.balance_due > 0.01);
}

interface ResolvedAllocation {
  tax_invoice_id: number;
  amount: number;
}

/**
 * Normalizes either input shape a client can submit - the new `allocations`
 * array (the New Receipt flow's oldest-first auto-fill, possibly
 * user-adjusted) or the legacy single `tax_invoice_id` field (still
 * accepted as-is, treated as one implicit allocation for the full amount) -
 * into one common list, then validates every allocation server-side:
 * amounts are positive, every referenced invoice actually belongs to this
 * customer+company, and - the one figure never trusted from the client -
 * no allocation exceeds that invoice's own current balance_due (recomputed
 * fresh here, excluding this same receipt's own prior allocations when
 * editing). The total allocated is allowed to be less than `amount` (the
 * remainder is an implicit on-account/advance credit) but never more.
 */
async function resolveAllocations(
  body: any,
  customerId: number,
  companyId: number,
  amount: number,
  excludeReceiptId?: number
): Promise<ResolvedAllocation[]> {
  const raw = Array.isArray(body.allocations)
    ? body.allocations
    : body.tax_invoice_id
      ? [{ tax_invoice_id: body.tax_invoice_id, amount: body.amount }]
      : [];
  if (raw.length === 0) return [];

  const resolved: ResolvedAllocation[] = raw.map((a: any) => ({
    tax_invoice_id: Number(a.tax_invoice_id),
    amount: round2(Number(a.amount)),
  }));
  for (const a of resolved) {
    if (!a.tax_invoice_id || !Number.isFinite(a.amount) || a.amount <= 0) {
      throw new ValidationError("Each allocation needs a valid tax_invoice_id and a positive amount");
    }
  }
  const totalAllocated = round2(resolved.reduce((s, a) => s + a.amount, 0));
  if (totalAllocated > amount + 0.01) {
    throw new ValidationError("Allocated amounts can't add up to more than the amount received");
  }

  const outstanding = await getOutstandingInvoices(customerId, companyId, excludeReceiptId);
  const balanceById = new Map(outstanding.map((o) => [o.id, o.balance_due]));
  for (const a of resolved) {
    const balance = balanceById.get(a.tax_invoice_id);
    if (balance === undefined) {
      throw new ValidationError(`Invoice ${a.tax_invoice_id} does not belong to this customer or has no balance outstanding`);
    }
    if (a.amount > balance + 0.01) {
      throw new ValidationError(`Allocated amount exceeds invoice ${a.tax_invoice_id}'s outstanding balance of Rs. ${balance.toFixed(2)}`);
    }
  }
  return resolved;
}

async function insertAllocations(conn: PoolConnection, receiptId: number, allocations: ResolvedAllocation[]): Promise<void> {
  for (const a of allocations) {
    await conn.query(
      "INSERT INTO receipt_allocations (receipt_id, tax_invoice_id, amount) VALUES (?, ?, ?)",
      [receiptId, a.tax_invoice_id, a.amount]
    );
  }
}

receiptsRouter.get(
  "/",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const perPage = Math.min(Math.max(Number(req.query.perPage) || 10, 1), 100);
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const offset = (page - 1) * perPage;

    const searchClause = search ? "AND (r.receipt_no LIKE ? OR c.name LIKE ?)" : "";
    const searchParams = search ? [`%${search}%`, `%${search}%`] : [];
    const companyClause = companyId ? "AND r.company_id = ?" : "";
    const companyParams = companyId ? [companyId] : [];

    const [rows] = await pool.query<any[]>(
      `SELECT r.*, c.name as customer_name, co.name as company_name, co.code as company_code,
              inv.doc_number as invoice_number,
              (SELECT COUNT(*) FROM receipt_allocations ra WHERE ra.receipt_id = r.id) as allocation_count
       FROM receipts r
       JOIN customers c ON c.id = r.customer_id
       JOIN companies co ON co.id = r.company_id
       LEFT JOIN documents inv ON inv.id = r.tax_invoice_id
       WHERE 1=1 ${searchClause} ${companyClause}
       ORDER BY r.received_date DESC, r.id DESC
       LIMIT ? OFFSET ?`,
      [...searchParams, ...companyParams, perPage, offset]
    );
    const [countRows] = await pool.query<any[]>(
      `SELECT COUNT(*) as total FROM receipts r JOIN customers c ON c.id = r.customer_id WHERE 1=1 ${searchClause} ${companyClause}`,
      [...searchParams, ...companyParams]
    );

    res.json({ data: rows, meta: { page, perPage, total: countRows[0].total as number } });
  })
);

receiptsRouter.get(
  "/outstanding-invoices",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const customerId = req.query.customer_id ? Number(req.query.customer_id) : null;
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    if (!customerId || !companyId) return res.status(400).json({ message: "customer_id and company_id are required" });
    const excludeReceiptId = req.query.exclude_receipt_id ? Number(req.query.exclude_receipt_id) : undefined;
    const invoices = await getOutstandingInvoices(customerId, companyId, excludeReceiptId);
    res.json({ data: invoices });
  })
);

receiptsRouter.get(
  "/:id",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const receipt = await findById(Number(req.params.id));
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    const allocations = await findAllocations(receipt.id);
    res.json({ receipt, allocations });
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

  // Legacy single-invoice path (still supported, unchanged in spirit) -
  // the new multi-invoice `allocations` array is validated separately by
  // resolveAllocations, called from the POST/PUT handlers themselves once
  // they know whether this is a create or an edit (an edit must exclude
  // its own prior allocations before checking balances).
  let invoice: DocumentRecord | undefined;
  if (tax_invoice_id && !Array.isArray(body.allocations)) {
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

// Creating a receipt, its accounting journal, and its invoice allocations
// must all succeed or fail together - every write shares one connection/
// transaction.
receiptsRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const result = await validatePayload(req.body, req.user!.sub, req.user!.role);
    if ("error" in result) return res.status(400).json({ message: result.error });
    const { company } = result;

    const { customer_id, account_id, amount, payment_mode, reference_no, received_date, notes } = req.body;

    let allocations: ResolvedAllocation[];
    try {
      allocations = await resolveAllocations(req.body, Number(customer_id), Number(req.body.company_id), Number(amount));
    } catch (err) {
      if (err instanceof ValidationError) return res.status(err.status).json({ message: err.message });
      throw err;
    }
    // A single-invoice allocation still populates the legacy column, for
    // any older code/report that reads it directly - two or more (or zero,
    // a pure on-account payment) leaves it null, correctly reflecting that
    // no single invoice describes this receipt any more.
    const legacyTaxInvoiceId = allocations.length === 1 ? allocations[0].tax_invoice_id : null;

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
          legacyTaxInvoiceId,
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
      await insertAllocations(conn, receiptId, allocations);

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
      const createdAllocations = await findAllocations(receiptId);
      res.status(201).json({
        receipt: created,
        allocations: createdAllocations,
        journal: journal ? { id: journal.id, status: journal.status } : null,
      });
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
// and a full replace of its allocations, share one transaction. The
// receipt row is locked FOR UPDATE for the duration so two concurrent
// edits of the same receipt can't race each other into posting/reversing
// journals (or allocations) out of order.
receiptsRouter.put(
  "/:id",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const result = await validatePayload(req.body, req.user!.sub, req.user!.role);
    if ("error" in result) return res.status(400).json({ message: result.error });

    const { company_id, customer_id, account_id, amount, payment_mode, reference_no, received_date, notes } = req.body;

    let allocations: ResolvedAllocation[];
    try {
      allocations = await resolveAllocations(req.body, Number(customer_id), Number(company_id), Number(amount), id);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(err.status).json({ message: err.message });
      throw err;
    }
    const legacyTaxInvoiceId = allocations.length === 1 ? allocations[0].tax_invoice_id : null;

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
          legacyTaxInvoiceId,
          account_id || null,
          amount,
          payment_mode,
          reference_no || null,
          received_date,
          notes || null,
          id,
        ]
      );

      await conn.query("DELETE FROM receipt_allocations WHERE receipt_id = ?", [id]);
      await insertAllocations(conn, id, allocations);

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
      const updatedAllocations = await findAllocations(id);
      res.json({
        receipt: updated,
        allocations: updatedAllocations,
        journal: journal ? { id: journal.id, status: journal.status } : null,
      });
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
// transaction. Its allocation rows are removed automatically by the
// receipt_allocations.receipt_id foreign key's ON DELETE CASCADE - no
// separate DELETE needed for those.
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
    const allocations = await findAllocations(receipt.id);
    const template = await getEffectiveDocumentTemplate(receipt.company_id, "receipt", {
      accentColor: "#16A34A",
      headerLabel: null,
      footerNote: "This is a computer-generated receipt.",
      // No classic_gst renderer exists for Receipts - "modern" (this
      // renderer's only look) stays the default regardless of what the 4
      // sales doc types default to.
      templateStyle: "modern",
    });

    streamReceiptPdf(res, receipt, customerRows[0] as Customer, companyRows[0] as Company, allocations, template);
  })
);
