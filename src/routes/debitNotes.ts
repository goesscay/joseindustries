import { Router } from "express";
import { PoolConnection } from "mysql2/promise";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { getNextDocNumber } from "../services/numbering";
import { computeLine, LineInput } from "../utils/totals";
import { AccountingError, getJournalBySource, postDebitNoteJournalTx, reverseJournalTx } from "../services/accounting";
import {
  InsufficientStockError,
  InventoryError,
  getTrackedItemIds,
  postDocumentStockMovementTx,
  reverseStockForSourceTx,
} from "../services/inventory";
import { Company, DebitNote, DebitNoteItem } from "../types";

// Double-entry rollout, Phase D: Debit Notes - the vendor-side mirror of
// Credit Notes, a correction against an existing, non-cancelled Purchase
// Bill. Deliberately its own router/tables (mirroring purchase_bills' own
// choice to not share the Sales module's documents/document_items) and
// deliberately create-and-cancel only, no PUT/edit - see schema.sql's
// comment on debit_notes for the full reasoning.
export const debitNotesRouter = Router();
const MODULE = "purchases.debit_notes";
debitNotesRouter.use(requireAuth);

class ValidationError extends Error {
  status = 400;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Joined the same way the list query below does (vendor_name/company_name/
// company_code/source_bill_no) - a bare `SELECT * FROM debit_notes` here
// would leave the single-record GET response missing every display field the
// list endpoint has, blanking the View modal's Vendor/Against Bill fields on
// the client.
async function findById(id: number): Promise<DebitNote | undefined> {
  const [rows] = await pool.query<any[]>(
    `SELECT dn.*, v.name as vendor_name, co.name as company_name, co.code as company_code,
            b.bill_no as source_bill_no
     FROM debit_notes dn
     JOIN vendors v ON v.id = dn.vendor_id
     JOIN companies co ON co.id = dn.company_id
     JOIN purchase_bills b ON b.id = dn.purchase_bill_id
     WHERE dn.id = ? LIMIT 1`,
    [id]
  );
  return rows[0] as DebitNote | undefined;
}

async function findItemsForDebitNote(debitNoteId: number): Promise<DebitNoteItem[]> {
  const [rows] = await pool.query<any[]>(
    "SELECT * FROM debit_note_items WHERE debit_note_id = ? ORDER BY sort_order ASC, id ASC",
    [debitNoteId]
  );
  return rows as DebitNoteItem[];
}

interface ResolvedDebitLine extends LineInput {
  item_id: number | null;
  description: string;
  hsn_code: string | null;
  unit: string;
  restock: boolean;
}

/**
 * Every debit note line must trace back to a real line on the source
 * Purchase Bill - same "never trust the client for the authoritative
 * figures" rule creditNotes.ts's resolveCreditNoteLines applies, re-reading
 * description/hsn_code/unit/rate/tax_rate fresh from the original
 * purchase_bill_items row every time.
 */
async function resolveDebitNoteLines(
  conn: PoolConnection,
  purchaseBillId: number,
  rawItems: unknown
): Promise<ResolvedDebitLine[]> {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new ValidationError("At least one line item is required");
  }
  const [originalRows] = await conn.query<any[]>("SELECT * FROM purchase_bill_items WHERE purchase_bill_id = ?", [
    purchaseBillId,
  ]);
  const originalById = new Map<number, any>(originalRows.map((r) => [r.id, r]));

  return rawItems.map((raw: any) => {
    const original = originalById.get(Number(raw.purchase_bill_item_id));
    if (!original) {
      throw new ValidationError("A line references an item that is not on the source Purchase Bill");
    }
    const qty = Number(raw.qty);
    if (!Number.isFinite(qty) || qty <= 0 || qty > Number(original.qty) + 1e-9) {
      throw new ValidationError(
        `Debited quantity for "${original.description}" must be more than 0 and at most ${original.qty}`
      );
    }
    return {
      item_id: original.item_id,
      description: original.description,
      hsn_code: original.hsn_code,
      unit: original.unit,
      rate: Number(original.rate),
      discount_percent: 0,
      tax_rate: Number(original.tax_rate),
      qty,
      restock: raw.restock === undefined ? true : Boolean(raw.restock),
    };
  });
}

/** Same shape/purpose as purchaseBills.ts's own classifyLinesForJournal -
 * whichever account category the ORIGINAL bill line posted to (Inventory vs
 * Purchases) is exactly what a debit note reversing it must credit back. */
async function classifyLinesForJournal(
  conn: PoolConnection,
  computedLines: { line: ResolvedDebitLine; computed: { taxableValue: number; taxAmount: number } }[]
) {
  const itemIds = [...new Set(computedLines.map(({ line }) => line.item_id).filter((id): id is number => id !== null))];
  const trackedIds = await getTrackedItemIds(conn, itemIds);
  return computedLines.map(({ line, computed }) => ({
    isInventoryTracked: line.item_id !== null && trackedIds.has(line.item_id),
    taxableValue: computed.taxableValue,
    taxAmount: computed.taxAmount,
  }));
}

debitNotesRouter.get(
  "/",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const perPage = Math.min(Math.max(Number(req.query.perPage) || 10, 1), 100);
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const offset = (page - 1) * perPage;

    const searchClause = search ? "AND (dn.debit_note_no LIKE ? OR v.name LIKE ?)" : "";
    const searchParams = search ? [`%${search}%`, `%${search}%`] : [];
    const companyClause = companyId ? "AND dn.company_id = ?" : "";
    const companyParams = companyId ? [companyId] : [];

    const [rows] = await pool.query<any[]>(
      `SELECT dn.*, v.name as vendor_name, co.name as company_name, co.code as company_code,
              b.bill_no as source_bill_no
       FROM debit_notes dn
       JOIN vendors v ON v.id = dn.vendor_id
       JOIN companies co ON co.id = dn.company_id
       JOIN purchase_bills b ON b.id = dn.purchase_bill_id
       WHERE 1=1 ${searchClause} ${companyClause}
       ORDER BY dn.issue_date DESC, dn.id DESC
       LIMIT ? OFFSET ?`,
      [...searchParams, ...companyParams, perPage, offset]
    );
    const [countRows] = await pool.query<any[]>(
      `SELECT COUNT(*) as total FROM debit_notes dn JOIN vendors v ON v.id = dn.vendor_id
       WHERE 1=1 ${searchClause} ${companyClause}`,
      [...searchParams, ...companyParams]
    );

    res.json({ data: rows, meta: { page, perPage, total: countRows[0].total as number } });
  })
);

debitNotesRouter.get(
  "/:id",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const note = await findById(Number(req.params.id));
    if (!note) return res.status(404).json({ message: "Debit note not found" });
    const items = await findItemsForDebitNote(note.id);
    res.json({ debitNote: note, items });
  })
);

debitNotesRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const { purchase_bill_id, issue_date, reason, notes, items, confirm_negative_stock } = req.body ?? {};
    if (!purchase_bill_id || !issue_date) {
      return res.status(400).json({ message: "purchase_bill_id and issue_date are required" });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // company_id/vendor_id are ALWAYS derived from the source bill, never
      // accepted from the client - a debit note is inseparable from the
      // bill it corrects.
      const [billRows] = await conn.query<any[]>("SELECT * FROM purchase_bills WHERE id = ? FOR UPDATE", [
        purchase_bill_id,
      ]);
      const bill = billRows[0];
      if (!bill) {
        await conn.rollback();
        return res.status(404).json({ message: "Source Purchase Bill not found" });
      }
      if (bill.status === "cancelled") {
        await conn.rollback();
        return res.status(400).json({ message: "Cannot debit a cancelled Purchase Bill" });
      }

      // Vendor existence is already guaranteed by purchase_bills.vendor_id's
      // FK constraint - only the company's code is actually needed here,
      // for the numbering series.
      const [companyRows] = await conn.query<any[]>("SELECT * FROM companies WHERE id = ?", [bill.company_id]);
      const company = companyRows[0] as Company;

      let lines: ResolvedDebitLine[];
      try {
        lines = await resolveDebitNoteLines(conn, bill.id, items);
      } catch (err) {
        await conn.rollback();
        if (err instanceof ValidationError) return res.status(err.status).json({ message: err.message });
        throw err;
      }

      let subtotal = 0;
      let taxAmount = 0;
      const computedLines = lines.map((line) => {
        const computed = computeLine(line);
        subtotal += computed.taxableValue;
        taxAmount += computed.taxAmount;
        return { line, computed };
      });
      subtotal = round2(subtotal);
      taxAmount = round2(taxAmount);
      const totalAmount = round2(subtotal + taxAmount);

      const { docNumber, financialYear } = await getNextDocNumber("debit_note", company.code, new Date(issue_date));

      const [result] = await conn.query<any>(
        `INSERT INTO debit_notes
           (debit_note_no, financial_year, company_id, vendor_id, purchase_bill_id, status, issue_date, reason, notes,
            subtotal, tax_amount, total_amount, created_by)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
        [
          docNumber,
          financialYear,
          bill.company_id,
          bill.vendor_id,
          bill.id,
          issue_date,
          reason || null,
          notes || null,
          subtotal,
          taxAmount,
          totalAmount,
          req.user!.sub,
        ]
      );
      const debitNoteId = result.insertId;

      let sortOrder = 0;
      for (const { line, computed } of computedLines) {
        await conn.query(
          `INSERT INTO debit_note_items
             (debit_note_id, item_id, description, hsn_code, qty, unit, rate, tax_rate, taxable_amount, tax_amount, line_total, restock, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            debitNoteId,
            line.item_id,
            line.description,
            line.hsn_code,
            line.qty,
            line.unit,
            line.rate,
            line.tax_rate,
            computed.taxableValue,
            computed.taxAmount,
            computed.lineTotal,
            line.restock,
            sortOrder,
          ]
        );
        sortOrder += 1;
      }

      const journal = await postDebitNoteJournalTx(conn, {
        companyId: bill.company_id,
        debitNoteId,
        debitNoteNo: docNumber,
        issueDate: issue_date,
        lines: await classifyLinesForJournal(conn, computedLines),
        createdBy: req.user!.sub,
      });

      // Only lines flagged to restock actually leave the stock ledger - a
      // pure price/billing adjustment (restock: false) never touches stock.
      // Valued at the ORIGINAL bill line's own rate (never today's average -
      // see postDocumentStockMovementTx's unitCost override), so this is an
      // exact reversal of what that specific purchase added, not a guess.
      const restockLines = computedLines.filter(({ line }) => line.restock);
      let stock: Awaited<ReturnType<typeof postDocumentStockMovementTx>> | undefined;
      if (restockLines.length > 0) {
        stock = await postDocumentStockMovementTx(conn, {
          companyId: bill.company_id,
          sourceType: "debit_note",
          sourceId: debitNoteId,
          txnDate: issue_date,
          direction: "out",
          txnType: "adjustment_out",
          lines: restockLines.map(({ line }) => ({ item_id: line.item_id, qty: line.qty, unit: line.unit, unitCost: line.rate })),
          createdBy: req.user!.sub,
          confirmNegativeStock: Boolean(confirm_negative_stock),
        });
      }

      await conn.commit();
      const created = await findById(debitNoteId);
      const docItems = await findItemsForDebitNote(debitNoteId);
      res.status(201).json({
        debitNote: created,
        items: docItems,
        journal: { id: journal.id, status: journal.status },
        stock: stock ? { posted: stock.posted.length, skipped: stock.skipped } : null,
      });
    } catch (err) {
      await conn.rollback();
      if (err instanceof InsufficientStockError) {
        return res.status(err.status).json({ message: err.message, code: "INSUFFICIENT_STOCK", items: err.items });
      }
      if (err instanceof AccountingError || err instanceof InventoryError) {
        return res.status(err.status).json({ message: `Debit note could not be recorded: ${err.message}` });
      }
      throw err;
    } finally {
      conn.release();
    }
  })
);

// Cancel-only status change - see schema.sql's comment on debit_notes for
// why there is no PUT/edit route.
debitNotesRouter.patch(
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
      const [existingRows] = await conn.query<any[]>("SELECT * FROM debit_notes WHERE id = ? FOR UPDATE", [id]);
      const existing = existingRows[0] as DebitNote | undefined;
      if (!existing) {
        await conn.rollback();
        return res.status(404).json({ message: "Debit note not found" });
      }
      if (existing.status === "cancelled") {
        await conn.rollback();
        return res.status(400).json({ message: "This debit note is already cancelled" });
      }

      const priorJournal = await getJournalBySource("debit_note", id);
      if (priorJournal) await reverseJournalTx(conn, priorJournal.id, req.user!.sub);
      await reverseStockForSourceTx(conn, "debit_note", id, req.user!.sub);

      await conn.query("UPDATE debit_notes SET status = 'cancelled' WHERE id = ?", [id]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError || err instanceof InventoryError) {
        return res.status(err.status).json({ message: `Debit note could not be cancelled: ${err.message}` });
      }
      throw err;
    } finally {
      conn.release();
    }

    const updated = await findById(id);
    res.json({ debitNote: updated });
  })
);

// Only a draft can be hard-deleted (same rule as every other document type).
debitNotesRouter.delete(
  "/:id",
  requireModuleAccess(MODULE, "delete"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [existingRows] = await conn.query<any[]>("SELECT * FROM debit_notes WHERE id = ? FOR UPDATE", [id]);
      const existing = existingRows[0] as DebitNote | undefined;
      if (!existing) {
        await conn.rollback();
        return res.status(404).json({ message: "Debit note not found" });
      }
      if (existing.status !== "draft") {
        await conn.rollback();
        return res.status(400).json({ message: "Only a draft debit note can be deleted" });
      }

      const priorJournal = await getJournalBySource("debit_note", id);
      if (priorJournal) await reverseJournalTx(conn, priorJournal.id, req.user!.sub);
      await reverseStockForSourceTx(conn, "debit_note", id, req.user!.sub);

      await conn.query("DELETE FROM debit_notes WHERE id = ?", [id]);
      await conn.commit();
      res.json({ message: "Debit note deleted" });
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError || err instanceof InventoryError) {
        return res.status(err.status).json({ message: `Debit note could not be deleted: ${err.message}` });
      }
      throw err;
    } finally {
      conn.release();
    }
  })
);
