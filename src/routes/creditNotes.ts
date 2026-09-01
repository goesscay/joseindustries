import { Router } from "express";
import { PoolConnection } from "mysql2/promise";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { getNextDocNumber } from "../services/numbering";
import { computeLine, computeTotals, LineInput } from "../utils/totals";
import { computeGstSplit } from "../utils/gst";
import {
  AccountingError,
  getJournalBySource,
  postCreditNoteJournalTx,
  postCreditNoteStockReversalJournalTx,
  reverseJournalTx,
} from "../services/accounting";
import {
  InsufficientStockError,
  InventoryError,
  postDocumentStockMovementTx,
  reverseStockForSourceTx,
} from "../services/inventory";
import { Company, CreditNote, CreditNoteItem, Customer, Journal } from "../types";

// Double-entry rollout, Phase D: Credit Notes - a correction against an
// existing, non-cancelled Tax Invoice. Deliberately its own router/tables,
// not another doc_type on the Sales module's shared documents/document_items
// (see schema.sql's comment on credit_notes for why) and deliberately
// create-and-cancel only, no PUT/edit (see the same comment).
export const creditNotesRouter = Router();
const MODULE = "sales.credit_notes";
creditNotesRouter.use(requireAuth);

class ValidationError extends Error {
  status = 400;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Joined the same way the list query above does (customer_name/company_name/
// company_code/source_invoice_no) - a bare `SELECT * FROM credit_notes` here
// would leave the single-record GET response missing every display field the
// list endpoint has, blanking the View modal's Customer/Against Invoice
// fields on the client.
async function findById(id: number): Promise<CreditNote | undefined> {
  const [rows] = await pool.query<any[]>(
    `SELECT cn.*, c.name as customer_name, co.name as company_name, co.code as company_code,
            d.doc_number as source_invoice_no
     FROM credit_notes cn
     JOIN customers c ON c.id = cn.customer_id
     JOIN companies co ON co.id = cn.company_id
     JOIN documents d ON d.id = cn.tax_invoice_id
     WHERE cn.id = ? LIMIT 1`,
    [id]
  );
  return rows[0] as CreditNote | undefined;
}

async function findItemsForCreditNote(creditNoteId: number): Promise<CreditNoteItem[]> {
  const [rows] = await pool.query<any[]>(
    "SELECT * FROM credit_note_items WHERE credit_note_id = ? ORDER BY sort_order ASC, id ASC",
    [creditNoteId]
  );
  return rows as CreditNoteItem[];
}

interface ResolvedCreditLine extends LineInput {
  item_id: number | null;
  description: string;
  hsn_code: string | null;
  unit: string;
  restock: boolean;
}

/**
 * Every credit note line must trace back to a real line on the source Tax
 * Invoice - the client submits which original document_items row it's
 * crediting and how much of it (`qty`, `restock`), but description/hsn_code/
 * unit/rate/tax_rate/discount_percent are always re-read fresh from that
 * original row here, never trusted from the request body, so a credit note
 * can never invent a new item, a higher quantity, or a different rate than
 * what was actually invoiced - exactly the same "never trust the client for
 * the authoritative figures" rule purchaseBills.ts's PO conversion already
 * applies.
 */
async function resolveCreditNoteLines(
  conn: PoolConnection,
  taxInvoiceId: number,
  rawItems: unknown
): Promise<ResolvedCreditLine[]> {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new ValidationError("At least one line item is required");
  }
  const [originalRows] = await conn.query<any[]>("SELECT * FROM document_items WHERE document_id = ?", [taxInvoiceId]);
  const originalById = new Map<number, any>(originalRows.map((r) => [r.id, r]));

  return rawItems.map((raw: any) => {
    const original = originalById.get(Number(raw.document_item_id));
    if (!original) {
      throw new ValidationError("A line references an item that is not on the source Tax Invoice");
    }
    const qty = Number(raw.qty);
    if (!Number.isFinite(qty) || qty <= 0 || qty > Number(original.qty) + 1e-9) {
      throw new ValidationError(
        `Credited quantity for "${original.description}" must be more than 0 and at most ${original.qty}`
      );
    }
    return {
      item_id: original.item_id,
      description: original.description,
      hsn_code: original.hsn_code,
      unit: original.unit,
      rate: Number(original.rate),
      discount_percent: Number(original.discount_percent) || 0,
      tax_rate: Number(original.tax_rate),
      qty,
      restock: raw.restock === undefined ? true : Boolean(raw.restock),
    };
  });
}

/**
 * The unit_cost to reverse stock at for each item this credit note restocks
 * - the ORIGINAL Tax Invoice's own posted 'sale_issue' rows for that item,
 * qty-weighted (in case the same item appeared on more than one line),
 * never today's current average. This is what makes the COGS reversal exact
 * rather than an approximation - see postCreditNoteStockReversalJournalTx's
 * own comment.
 */
async function resolveOriginalUnitCosts(conn: PoolConnection, taxInvoiceId: number): Promise<Map<number, number>> {
  const [rows] = await conn.query<any[]>(
    `SELECT item_id, qty, unit_cost FROM stock_transactions
     WHERE source_type = 'tax_invoice' AND source_id = ? AND txn_type = 'sale_issue'
       AND status = 'posted' AND reverses_txn_id IS NULL`,
    [taxInvoiceId]
  );
  const totals = new Map<number, { qty: number; value: number }>();
  for (const r of rows) {
    const qty = Number(r.qty);
    const cost = Number(r.unit_cost ?? 0);
    const existing = totals.get(r.item_id) ?? { qty: 0, value: 0 };
    existing.qty += qty;
    existing.value += qty * cost;
    totals.set(r.item_id, existing);
  }
  const costs = new Map<number, number>();
  for (const [itemId, { qty, value }] of totals) {
    costs.set(itemId, qty > 0 ? round2(value / qty) : 0);
  }
  return costs;
}

function computeRestockAmount(posted: { txn_type: string; qty: string; unit_cost: string | null }[]): number {
  return round2(
    posted
      .filter((t) => t.txn_type === "adjustment_in")
      .reduce((sum, t) => sum + Number(t.qty) * Number(t.unit_cost ?? 0), 0)
  );
}

creditNotesRouter.get(
  "/",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const perPage = Math.min(Math.max(Number(req.query.perPage) || 10, 1), 100);
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const offset = (page - 1) * perPage;

    const searchClause = search ? "AND (cn.credit_note_no LIKE ? OR c.name LIKE ?)" : "";
    const searchParams = search ? [`%${search}%`, `%${search}%`] : [];
    const companyClause = companyId ? "AND cn.company_id = ?" : "";
    const companyParams = companyId ? [companyId] : [];

    const [rows] = await pool.query<any[]>(
      `SELECT cn.*, c.name as customer_name, co.name as company_name, co.code as company_code,
              d.doc_number as source_invoice_no
       FROM credit_notes cn
       JOIN customers c ON c.id = cn.customer_id
       JOIN companies co ON co.id = cn.company_id
       JOIN documents d ON d.id = cn.tax_invoice_id
       WHERE 1=1 ${searchClause} ${companyClause}
       ORDER BY cn.issue_date DESC, cn.id DESC
       LIMIT ? OFFSET ?`,
      [...searchParams, ...companyParams, perPage, offset]
    );
    const [countRows] = await pool.query<any[]>(
      `SELECT COUNT(*) as total FROM credit_notes cn JOIN customers c ON c.id = cn.customer_id
       WHERE 1=1 ${searchClause} ${companyClause}`,
      [...searchParams, ...companyParams]
    );

    res.json({ data: rows, meta: { page, perPage, total: countRows[0].total as number } });
  })
);

creditNotesRouter.get(
  "/:id",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const note = await findById(Number(req.params.id));
    if (!note) return res.status(404).json({ message: "Credit note not found" });
    const items = await findItemsForCreditNote(note.id);
    res.json({ creditNote: note, items });
  })
);

creditNotesRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const { tax_invoice_id, issue_date, reason, notes, items, confirm_negative_stock } = req.body ?? {};
    if (!tax_invoice_id || !issue_date) {
      return res.status(400).json({ message: "tax_invoice_id and issue_date are required" });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // company_id/customer_id are ALWAYS derived from the source invoice,
      // never accepted from the client - a credit note is inseparable from
      // the invoice it corrects.
      const [invoiceRows] = await conn.query<any[]>(
        "SELECT * FROM documents WHERE id = ? AND doc_type = 'tax_invoice' FOR UPDATE",
        [tax_invoice_id]
      );
      const invoice = invoiceRows[0];
      if (!invoice) {
        await conn.rollback();
        return res.status(404).json({ message: "Source Tax Invoice not found" });
      }
      if (invoice.status === "cancelled") {
        await conn.rollback();
        return res.status(400).json({ message: "Cannot credit a cancelled Tax Invoice" });
      }

      const [companyRows] = await conn.query<any[]>("SELECT * FROM companies WHERE id = ?", [invoice.company_id]);
      const company = companyRows[0] as Company;
      const [customerRows] = await conn.query<any[]>("SELECT * FROM customers WHERE id = ?", [invoice.customer_id]);
      const customer = customerRows[0] as Customer;

      let lines: ResolvedCreditLine[];
      try {
        lines = await resolveCreditNoteLines(conn, invoice.id, items);
      } catch (err) {
        await conn.rollback();
        if (err instanceof ValidationError) return res.status(err.status).json({ message: err.message });
        throw err;
      }

      const { subtotal, grandTotal } = computeTotals(lines);
      const { isInterState, cgstTotal, sgstTotal, igstTotal } = computeGstSplit(lines, company.state, customer.state);
      const taxTotal = isInterState ? igstTotal : cgstTotal + sgstTotal;

      const { docNumber, financialYear } = await getNextDocNumber("credit_note", company.code, new Date(issue_date));

      const [result] = await conn.query<any>(
        `INSERT INTO credit_notes
           (credit_note_no, financial_year, company_id, customer_id, tax_invoice_id, status, issue_date, reason, notes,
            subtotal, cgst_total, sgst_total, igst_total, tax_total, grand_total, created_by)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          docNumber,
          financialYear,
          invoice.company_id,
          invoice.customer_id,
          invoice.id,
          issue_date,
          reason || null,
          notes || null,
          subtotal,
          cgstTotal,
          sgstTotal,
          igstTotal,
          taxTotal,
          grandTotal,
          req.user!.sub,
        ]
      );
      const creditNoteId = result.insertId;

      let sortOrder = 0;
      for (const line of lines) {
        const { taxableValue, taxAmount, lineTotal } = computeLine(line);
        await conn.query(
          `INSERT INTO credit_note_items
             (credit_note_id, item_id, description, hsn_code, qty, unit, rate, tax_rate, taxable_amount, tax_amount, line_total, restock, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            creditNoteId,
            line.item_id,
            line.description,
            line.hsn_code,
            line.qty,
            line.unit,
            line.rate,
            line.tax_rate,
            taxableValue,
            taxAmount,
            lineTotal,
            line.restock,
            sortOrder,
          ]
        );
        sortOrder += 1;
      }

      const journal = await postCreditNoteJournalTx(conn, {
        companyId: invoice.company_id,
        creditNoteId,
        creditNoteNo: docNumber,
        issueDate: issue_date,
        grandTotal,
        taxTotal,
        cgstTotal,
        sgstTotal,
        igstTotal,
        createdBy: req.user!.sub,
      });

      // Restock only the lines flagged for it - a pure price/billing
      // adjustment (restock: false) never touches stock, same as how a
      // non-tracked item never does.
      const restockLines = lines.filter((l) => l.restock);
      let stockJournal: Journal | undefined;
      let stock: Awaited<ReturnType<typeof postDocumentStockMovementTx>> | undefined;
      if (restockLines.length > 0) {
        const originalCosts = await resolveOriginalUnitCosts(conn, invoice.id);
        stock = await postDocumentStockMovementTx(conn, {
          companyId: invoice.company_id,
          sourceType: "credit_note",
          sourceId: creditNoteId,
          txnDate: issue_date,
          direction: "in",
          txnType: "adjustment_in",
          lines: restockLines.map((l) => ({
            item_id: l.item_id,
            qty: l.qty,
            unit: l.unit,
            unitCost: l.item_id ? originalCosts.get(l.item_id) ?? 0 : undefined,
          })),
          createdBy: req.user!.sub,
          confirmNegativeStock: Boolean(confirm_negative_stock),
        });
        const restockAmount = computeRestockAmount(stock.posted);
        if (restockAmount > 0) {
          stockJournal = await postCreditNoteStockReversalJournalTx(conn, {
            companyId: invoice.company_id,
            creditNoteId,
            creditNoteNo: docNumber,
            issueDate: issue_date,
            restockAmount,
            createdBy: req.user!.sub,
          });
        }
      }

      await conn.commit();
      const created = await findById(creditNoteId);
      const docItems = await findItemsForCreditNote(creditNoteId);
      res.status(201).json({
        creditNote: created,
        items: docItems,
        journal: { id: journal.id, status: journal.status },
        stockJournal: stockJournal ? { id: stockJournal.id, status: stockJournal.status } : null,
        stock: stock ? { posted: stock.posted.length, skipped: stock.skipped } : null,
      });
    } catch (err) {
      await conn.rollback();
      if (err instanceof InsufficientStockError) {
        return res.status(err.status).json({ message: err.message, code: "INSUFFICIENT_STOCK", items: err.items });
      }
      if (err instanceof AccountingError || err instanceof InventoryError) {
        return res.status(err.status).json({ message: `Credit note could not be recorded: ${err.message}` });
      }
      throw err;
    } finally {
      conn.release();
    }
  })
);

// Cancel-only status change - a credit note is itself a correction, so it
// is never edited in place; a mistake is cancelled (reversing its journals
// and stock, never reposting) and a fresh one issued. See schema.sql's
// comment on credit_notes for the full reasoning.
creditNotesRouter.patch(
  "/:id/status",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (req.body?.status !== "cancelled") {
      return res.status(400).json({ message: "Only 'cancelled' is a valid status transition here" });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [existingRows] = await conn.query<any[]>("SELECT * FROM credit_notes WHERE id = ? FOR UPDATE", [id]);
      const existing = existingRows[0] as CreditNote | undefined;
      if (!existing) {
        await conn.rollback();
        return res.status(404).json({ message: "Credit note not found" });
      }
      if (existing.status === "cancelled") {
        await conn.rollback();
        return res.status(400).json({ message: "This credit note is already cancelled" });
      }

      const priorJournal = await getJournalBySource("credit_note", id);
      if (priorJournal) await reverseJournalTx(conn, priorJournal.id, req.user!.sub);
      const priorStockJournal = await getJournalBySource("credit_note_stock", id);
      if (priorStockJournal) await reverseJournalTx(conn, priorStockJournal.id, req.user!.sub);
      await reverseStockForSourceTx(conn, "credit_note", id, req.user!.sub);

      await conn.query("UPDATE credit_notes SET status = 'cancelled' WHERE id = ?", [id]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError || err instanceof InventoryError) {
        return res.status(err.status).json({ message: `Credit note could not be cancelled: ${err.message}` });
      }
      throw err;
    } finally {
      conn.release();
    }

    const updated = await findById(id);
    res.json({ creditNote: updated });
  })
);

// Only a draft can be hard-deleted (same rule as every other document type).
creditNotesRouter.delete(
  "/:id",
  requireModuleAccess(MODULE, "delete"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [existingRows] = await conn.query<any[]>("SELECT * FROM credit_notes WHERE id = ? FOR UPDATE", [id]);
      const existing = existingRows[0] as CreditNote | undefined;
      if (!existing) {
        await conn.rollback();
        return res.status(404).json({ message: "Credit note not found" });
      }
      if (existing.status !== "draft") {
        await conn.rollback();
        return res.status(400).json({ message: "Only a draft credit note can be deleted" });
      }

      const priorJournal = await getJournalBySource("credit_note", id);
      if (priorJournal) await reverseJournalTx(conn, priorJournal.id, req.user!.sub);
      const priorStockJournal = await getJournalBySource("credit_note_stock", id);
      if (priorStockJournal) await reverseJournalTx(conn, priorStockJournal.id, req.user!.sub);
      await reverseStockForSourceTx(conn, "credit_note", id, req.user!.sub);

      await conn.query("DELETE FROM credit_notes WHERE id = ?", [id]);
      await conn.commit();
      res.json({ message: "Credit note deleted" });
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError || err instanceof InventoryError) {
        return res.status(err.status).json({ message: `Credit note could not be deleted: ${err.message}` });
      }
      throw err;
    } finally {
      conn.release();
    }
  })
);
