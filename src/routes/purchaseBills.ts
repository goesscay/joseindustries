import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { getNextDocNumber } from "../services/numbering";
import { computeLine, LineInput } from "../utils/totals";
import { AccountingError, getJournalBySource, postPurchaseBillJournalTx, reverseJournalTx } from "../services/accounting";
import {
  InsufficientStockError,
  InventoryError,
  getTrackedItemIds,
  postDocumentStockMovementTx,
  reverseStockForSourceTx,
} from "../services/inventory";
import { Company, Journal, PurchaseBill, PurchaseBillItem, Vendor } from "../types";

// Purchase Bills - the first real purchase-side document (Phase 7A).
// Deliberately its own router/tables, not a doc_type on the Sales module's
// shared documents/document_items (see schema.sql's comment on
// purchase_bills for why). Purchase Orders are explicitly NOT built in
// this phase - purchase_order_id stays NULL for every bill created here.
export const purchaseBillsRouter = Router();
const MODULE = "purchases.bills";
purchaseBillsRouter.use(requireAuth);

// source_po_no (Phase 7B) is a derived join, not a stored/cached field -
// same "query the relationship, don't cache it" approach as
// purchaseOrders.ts's billed_bill_no.
async function findById(id: number): Promise<PurchaseBill | undefined> {
  const [rows] = await pool.query<any[]>(
    `SELECT b.*, po.po_no as source_po_no
     FROM purchase_bills b
     LEFT JOIN purchase_orders po ON po.id = b.purchase_order_id
     WHERE b.id = ? LIMIT 1`,
    [id]
  );
  return rows[0] as PurchaseBill | undefined;
}

async function findItemsForBill(billId: number): Promise<PurchaseBillItem[]> {
  const [rows] = await pool.query<any[]>(
    "SELECT * FROM purchase_bill_items WHERE purchase_bill_id = ? ORDER BY sort_order ASC, id ASC",
    [billId]
  );
  return rows as PurchaseBillItem[];
}

interface NormalizedLine extends LineInput {
  item_id: number | null;
  description: string;
  hsn_code: string | null;
  unit: string;
}

class ValidationError extends Error {
  status = 400;
}

function validateAndNormalizeLines(rawItems: unknown): NormalizedLine[] {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new ValidationError("At least one line item is required");
  }
  return rawItems.map((raw) => {
    const qty = Number(raw.qty);
    const rate = Number(raw.rate);
    const tax_rate = Number(raw.tax_rate ?? 0);
    if (!raw.description || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(rate) || rate < 0) {
      throw new ValidationError("Each line item needs a description, positive qty, and rate");
    }
    return {
      item_id: raw.item_id ?? null,
      description: String(raw.description),
      hsn_code: raw.hsn_code ?? null,
      qty,
      unit: raw.unit || "pcs",
      rate,
      discount_percent: 0,
      tax_rate,
    };
  });
}

/**
 * Phase 12D: classifies each already-computed line as inventory-tracked or
 * not (via items.track_inventory, the exact same definition
 * postDocumentStockMovementTx itself uses - see getTrackedItemIds), so
 * postPurchaseBillJournalTx can split Dr Inventory vs Dr Purchases per
 * line. A line with no item_id is never tracked (nothing to track it
 * against - same rule the stock layer already applies).
 */
async function classifyLinesForJournal(
  conn: import("mysql2/promise").PoolConnection,
  computedLines: { line: NormalizedLine; computed: { taxableValue: number; taxAmount: number } }[]
) {
  const itemIds = [...new Set(computedLines.map(({ line }) => line.item_id).filter((id): id is number => id !== null))];
  const trackedIds = await getTrackedItemIds(conn, itemIds);
  return computedLines.map(({ line, computed }) => ({
    isInventoryTracked: line.item_id !== null && trackedIds.has(line.item_id),
    taxableValue: computed.taxableValue,
    taxAmount: computed.taxAmount,
  }));
}

async function validatePayload(body: any) {
  const { company_id, vendor_id, bill_date, items } = body ?? {};
  if (!company_id || !vendor_id || !bill_date) {
    return { error: "company_id, vendor_id and bill_date are required" };
  }

  const [companyRows] = await pool.query<any[]>("SELECT * FROM companies WHERE id = ?", [company_id]);
  const company = companyRows[0] as Company | undefined;
  if (!company) return { error: "Company not found" };

  // Vendors are a single global list (no company_id, no active/inactive
  // concept - confirmed by inspecting the vendors table/route before
  // implementing this) - so there is no cross-company vendor check to make
  // here, only that the vendor exists at all.
  const [vendorRows] = await pool.query<any[]>("SELECT * FROM vendors WHERE id = ?", [vendor_id]);
  const vendor = vendorRows[0] as Vendor | undefined;
  if (!vendor) return { error: "Vendor not found" };

  let lines: NormalizedLine[];
  try {
    lines = validateAndNormalizeLines(items);
  } catch (err) {
    if (err instanceof ValidationError) return { error: err.message };
    throw err;
  }

  return { company, vendor, lines };
}

/**
 * Phase 7B: PO -> Purchase Bill conversion. The frontend may prefill its
 * form from a Purchase Order, but that is presentation only - the backend
 * never trusts the submitted vendor_id/items when purchase_order_id is
 * present. Instead it re-reads the PO's own current row + line items
 * fresh from the database (on `conn`, inside the caller's transaction,
 * with the PO row locked FOR UPDATE) and builds the bill from THOSE,
 * ignoring whatever the client sent for vendor/items - "full conversion"
 * means the bill is always an exact, authoritative copy of the PO at
 * conversion time, never something that can silently contradict it.
 *
 * The FOR UPDATE lock on the PO row is what makes duplicate-conversion
 * protection race-safe: two concurrent "Convert to Bill" requests for the
 * same PO serialize on this lock, so the second one's "does a bill already
 * exist" check runs only after the first has committed (and therefore sees
 * the first bill), rather than both checking a stale "no bill yet" state.
 */
async function resolvePurchaseOrderSource(
  conn: import("mysql2/promise").PoolConnection,
  purchaseOrderId: number,
  billCompanyId: number
) {
  const [poRows] = await conn.query<any[]>("SELECT * FROM purchase_orders WHERE id = ? FOR UPDATE", [purchaseOrderId]);
  const po = poRows[0];
  if (!po) return { error: "Purchase order not found" };
  if (Number(po.company_id) !== Number(billCompanyId)) {
    return { error: "This purchase order does not belong to the selected company" };
  }
  if (po.status === "cancelled") {
    return { error: "This purchase order has been cancelled and cannot be converted" };
  }

  const [existingBillRows] = await conn.query<any[]>(
    "SELECT id, bill_no FROM purchase_bills WHERE purchase_order_id = ?",
    [purchaseOrderId]
  );
  if (existingBillRows.length > 0) {
    return { error: `This purchase order has already been converted to Purchase Bill ${existingBillRows[0].bill_no}` };
  }

  const [vendorRows] = await conn.query<any[]>("SELECT * FROM vendors WHERE id = ?", [po.vendor_id]);
  if (!vendorRows[0]) return { error: "The purchase order's vendor no longer exists" };

  const [poItemRows] = await conn.query<any[]>(
    "SELECT * FROM purchase_order_items WHERE purchase_order_id = ? ORDER BY sort_order ASC, id ASC",
    [purchaseOrderId]
  );
  if (!poItemRows.length) {
    return { error: "This purchase order has no line items to convert" };
  }

  const lines: NormalizedLine[] = poItemRows.map((i: any) => ({
    item_id: i.item_id,
    description: i.description,
    hsn_code: i.hsn_code,
    qty: Number(i.qty),
    unit: i.unit,
    rate: Number(i.rate),
    discount_percent: 0,
    tax_rate: Number(i.tax_rate),
  }));

  return { po, vendorId: po.vendor_id as number, lines };
}

purchaseBillsRouter.get(
  "/",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const perPage = Math.min(Math.max(Number(req.query.perPage) || 10, 1), 100);
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const offset = (page - 1) * perPage;

    const searchClause = search ? "AND (b.bill_no LIKE ? OR v.name LIKE ?)" : "";
    const searchParams = search ? [`%${search}%`, `%${search}%`] : [];

    const [rows] = await pool.query<any[]>(
      `SELECT b.*, v.name as vendor_name, co.name as company_name, co.code as company_code, po.po_no as source_po_no
       FROM purchase_bills b
       JOIN vendors v ON v.id = b.vendor_id
       JOIN companies co ON co.id = b.company_id
       LEFT JOIN purchase_orders po ON po.id = b.purchase_order_id
       WHERE 1=1 ${searchClause}
       ORDER BY b.created_at DESC
       LIMIT ? OFFSET ?`,
      [...searchParams, perPage, offset]
    );
    const [countRows] = await pool.query<any[]>(
      `SELECT COUNT(*) as total FROM purchase_bills b JOIN vendors v ON v.id = b.vendor_id WHERE 1=1 ${searchClause}`,
      searchParams
    );

    res.json({ data: rows, meta: { page, perPage, total: countRows[0].total as number } });
  })
);

purchaseBillsRouter.get(
  "/:id",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const bill = await findById(Number(req.params.id));
    if (!bill) return res.status(404).json({ message: "Purchase bill not found" });
    const items = await findItemsForBill(bill.id);
    res.json({ bill, items });
  })
);

// Creating a Purchase Bill and posting its journal must succeed or fail
// together - identical reasoning to every prior phase's POST handler.
// Two shapes of request land here: a direct bill (vendor_id + items come
// from the request body, validated by validatePayload exactly as in
// Phase 7A) or a PO conversion (purchase_order_id is set - vendor_id/items
// in the body are ignored entirely; resolvePurchaseOrderSource re-reads
// the authoritative figures from the database instead, inside this same
// transaction, with the PO row locked). Either way, everything from here
// down (totals, insert, journal) is identical.
purchaseBillsRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const { company_id, purchase_order_id, bill_date, due_date, reference_no, notes } = req.body ?? {};
    if (!company_id || !bill_date) {
      return res.status(400).json({ message: "company_id and bill_date are required" });
    }

    const [companyRows] = await pool.query<any[]>("SELECT * FROM companies WHERE id = ?", [company_id]);
    const company = companyRows[0] as Company | undefined;
    if (!company) return res.status(404).json({ message: "Company not found" });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      let vendorId: number;
      let lines: NormalizedLine[];
      let sourcePurchaseOrderId: number | null = null;

      if (purchase_order_id) {
        const poResult = await resolvePurchaseOrderSource(conn, Number(purchase_order_id), Number(company_id));
        if ("error" in poResult) {
          await conn.rollback();
          return res.status(400).json({ message: poResult.error });
        }
        vendorId = poResult.vendorId;
        lines = poResult.lines;
        sourcePurchaseOrderId = poResult.po.id;
      } else {
        const result = await validatePayload(req.body);
        if ("error" in result) {
          await conn.rollback();
          return res.status(400).json({ message: result.error });
        }
        vendorId = Number(req.body.vendor_id);
        lines = result.lines;
      }

      let subtotal = 0;
      let taxAmount = 0;
      const computedLines = lines.map((line) => {
        const computed = computeLine(line);
        subtotal += computed.taxableValue;
        taxAmount += computed.taxAmount;
        return { line, computed };
      });
      subtotal = Math.round(subtotal * 100) / 100;
      taxAmount = Math.round(taxAmount * 100) / 100;
      const totalAmount = Math.round((subtotal + taxAmount) * 100) / 100;

      const { docNumber, financialYear } = await getNextDocNumber("purchase_bill", company.code, new Date(bill_date));

      const [insertResult] = await conn.query<any>(
        `INSERT INTO purchase_bills
           (bill_no, financial_year, company_id, vendor_id, purchase_order_id, status, bill_date, due_date,
            reference_no, notes, subtotal, tax_amount, total_amount, created_by)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          docNumber,
          financialYear,
          company_id,
          vendorId,
          sourcePurchaseOrderId,
          bill_date,
          due_date || null,
          reference_no || null,
          notes || null,
          subtotal,
          taxAmount,
          totalAmount,
          req.user!.sub,
        ]
      );
      const billId = insertResult.insertId;

      let sortOrder = 0;
      for (const { line, computed } of computedLines) {
        await conn.query(
          `INSERT INTO purchase_bill_items
             (purchase_bill_id, item_id, description, hsn_code, qty, unit, rate, tax_rate, taxable_amount, tax_amount, line_total, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            billId,
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
            sortOrder,
          ]
        );
        sortOrder += 1;
      }

      const journal = await postPurchaseBillJournalTx(conn, {
        companyId: Number(company_id),
        billId,
        billNo: docNumber,
        billDate: bill_date,
        lines: await classifyLinesForJournal(conn, computedLines),
        createdBy: req.user!.sub,
      });

      await conn.commit();
      const created = await findById(billId);
      const items = await findItemsForBill(billId);
      res
        .status(201)
        .json({ bill: created, items, journal: { id: journal.id, status: journal.status } });
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError) {
        return res.status(400).json({ message: `Purchase bill could not be recorded: ${err.message}` });
      }
      throw err;
    } finally {
      conn.release();
    }
  })
);

// A posted journal is never edited in place - reverse whatever journal
// currently exists for this bill and post a fresh one for the corrected
// figures, in the same transaction as the bill/line update. See
// receipts.ts's PUT handler for the identical reasoning.
purchaseBillsRouter.put(
  "/:id",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const result = await validatePayload(req.body);
    if ("error" in result) return res.status(400).json({ message: result.error });
    const { lines } = result;

    const { vendor_id, purchase_order_id, bill_date, due_date, reference_no, notes, status } = req.body ?? {};

    let subtotal = 0;
    let taxAmount = 0;
    const computedLines = lines.map((line) => {
      const computed = computeLine(line);
      subtotal += computed.taxableValue;
      taxAmount += computed.taxAmount;
      return { line, computed };
    });
    subtotal = Math.round(subtotal * 100) / 100;
    taxAmount = Math.round(taxAmount * 100) / 100;
    const totalAmount = Math.round((subtotal + taxAmount) * 100) / 100;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [existingRows] = await conn.query<any[]>("SELECT * FROM purchase_bills WHERE id = ? FOR UPDATE", [id]);
      const existing = existingRows[0] as PurchaseBill | undefined;
      if (!existing) {
        await conn.rollback();
        return res.status(404).json({ message: "Purchase bill not found" });
      }
      if (existing.status === "cancelled") {
        await conn.rollback();
        return res.status(400).json({ message: "Cannot edit a cancelled purchase bill" });
      }

      const resolvedStatus =
        status && ["draft", "received", "cancelled"].includes(status) ? status : existing.status;

      await conn.query(
        `UPDATE purchase_bills SET
           company_id = ?, vendor_id = ?, purchase_order_id = ?, status = ?, bill_date = ?, due_date = ?,
           reference_no = ?, notes = ?, subtotal = ?, tax_amount = ?, total_amount = ?
         WHERE id = ?`,
        [
          req.body.company_id,
          vendor_id,
          purchase_order_id || null,
          resolvedStatus,
          bill_date,
          due_date || null,
          reference_no || null,
          notes || null,
          subtotal,
          taxAmount,
          totalAmount,
          id,
        ]
      );

      await conn.query("DELETE FROM purchase_bill_items WHERE purchase_bill_id = ?", [id]);
      let sortOrder = 0;
      for (const { line, computed } of computedLines) {
        await conn.query(
          `INSERT INTO purchase_bill_items
             (purchase_bill_id, item_id, description, hsn_code, qty, unit, rate, tax_rate, taxable_amount, tax_amount, line_total, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
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
            sortOrder,
          ]
        );
        sortOrder += 1;
      }

      // The UPDATE statement above already took an exclusive row lock on
      // this bill for the rest of the transaction, so a concurrent edit of
      // the same bill is already serialized by the time we get here - see
      // salesDocuments.ts's PUT handler for the identical reasoning.
      //
      // Phase 11A fix: cancelling used to reverse-then-*always repost* a
      // fresh journal, even when the new status was 'cancelled' - so a
      // "cancelled" purchase bill still carried a fully live Input GST/AP/
      // Purchases posting, with zero accounting effect from the
      // cancellation itself. Cancelling now reverses whatever journal is
      // active and stops there - no replacement journal is posted. Every
      // other edit (draft/received, or a cancelled bill's own figures being
      // corrected before it's cancelled) keeps the existing reverse-then-
      // repost behavior unchanged. The original and its reversal are both
      // kept, never deleted, preserving the audit trail.
      const priorJournal = await getJournalBySource("purchase_bill", id);
      if (priorJournal) {
        await reverseJournalTx(conn, priorJournal.id, req.user!.sub);
      }
      const journal =
        resolvedStatus === "cancelled"
          ? null
          : await postPurchaseBillJournalTx(conn, {
              companyId: Number(req.body.company_id),
              billId: id,
              billNo: existing.bill_no,
              billDate: bill_date,
              lines: await classifyLinesForJournal(conn, computedLines),
              createdBy: req.user!.sub,
            });

      // Phase 12: stock mirrors the same reverse-then-conditionally-repost
      // shape as the journal just above, but its OWN condition - stock
      // should only be active while status IS 'received', never 'draft' -
      // is deliberately different from the journal's (which reposts for
      // both 'draft' and 'received', only skipping 'cancelled'). Reversing
      // is unconditional (a no-op if nothing was ever posted, e.g. a
      // draft-to-draft edit); reposting only happens when the new status is
      // 'received'. Receiving can never go negative, so no confirmation
      // flow applies here (unlike a Tax Invoice's stock-out).
      await reverseStockForSourceTx(conn, "purchase_bill", id, req.user!.sub);
      if (resolvedStatus === "received") {
        await postDocumentStockMovementTx(conn, {
          companyId: Number(req.body.company_id),
          sourceType: "purchase_bill",
          sourceId: id,
          txnDate: bill_date,
          direction: "in",
          // Phase 12C: unit_cost = the bill line's own (GST-exclusive) rate,
          // per the approved valuation model - purchase_bill_items has no
          // discount, so `rate` is already the final per-unit cost, nothing
          // else to net out.
          lines: lines.map((l) => ({ item_id: l.item_id, qty: l.qty, unit: l.unit, unitCost: l.rate })),
          createdBy: req.user!.sub,
        });
      }

      await conn.commit();
      const updated = await findById(id);
      const items = await findItemsForBill(id);
      res.json({ bill: updated, items, journal: journal ? { id: journal.id, status: journal.status } : null });
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError || err instanceof InventoryError || err instanceof InsufficientStockError) {
        return res.status(err.status).json({ message: `Purchase bill could not be updated: ${err.message}` });
      }
      throw err;
    } finally {
      conn.release();
    }
  })
);

// Mirrors expenses.ts's/salesDocuments.ts's delete pattern: reverse the
// journal first, then perform the existing business-document deletion
// (only a draft bill can be hard-deleted, same rule as Sales documents),
// all in one transaction - if the delete itself is blocked, everything
// (including the reversal) rolls back.
purchaseBillsRouter.delete(
  "/:id",
  requireModuleAccess(MODULE, "delete"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [existingRows] = await conn.query<any[]>("SELECT * FROM purchase_bills WHERE id = ? FOR UPDATE", [id]);
      const existing = existingRows[0] as PurchaseBill | undefined;
      if (!existing) {
        await conn.rollback();
        return res.status(404).json({ message: "Purchase bill not found" });
      }
      if (existing.status !== "draft") {
        await conn.rollback();
        return res.status(400).json({ message: "Only draft purchase bills can be deleted" });
      }

      const priorJournal = await getJournalBySource("purchase_bill", id);
      if (priorJournal) {
        await reverseJournalTx(conn, priorJournal.id, req.user!.sub);
      }
      // A draft bill (the only kind deletable here) can never have live
      // stock in practice - stock only ever posts while status='received',
      // and PUT already reverses stock the moment status leaves 'received'
      // - but this call is a no-op-safe defensive mirror of the journal
      // reversal just above, not load-bearing.
      await reverseStockForSourceTx(conn, "purchase_bill", id, req.user!.sub);

      await conn.query("DELETE FROM purchase_bills WHERE id = ?", [id]);
      await conn.commit();
      res.json({ message: "Purchase bill deleted" });
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError || err instanceof InventoryError || err instanceof InsufficientStockError) {
        return res.status(err.status).json({ message: `Purchase bill could not be deleted: ${err.message}` });
      }
      throw err;
    } finally {
      conn.release();
    }
  })
);
