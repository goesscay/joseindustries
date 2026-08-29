import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { getNextDocNumber } from "../services/numbering";
import { computeLine, LineInput } from "../utils/totals";
import { AccountingError, getJournalBySource, postPurchaseBillJournalTx, reverseJournalTx } from "../services/accounting";
import { Company, Journal, PurchaseBill, PurchaseBillItem, Vendor } from "../types";

// Purchase Bills - the first real purchase-side document (Phase 7A).
// Deliberately its own router/tables, not a doc_type on the Sales module's
// shared documents/document_items (see schema.sql's comment on
// purchase_bills for why). Purchase Orders are explicitly NOT built in
// this phase - purchase_order_id stays NULL for every bill created here.
export const purchaseBillsRouter = Router();
const MODULE = "purchases.bills";
purchaseBillsRouter.use(requireAuth);

async function findById(id: number): Promise<PurchaseBill | undefined> {
  const [rows] = await pool.query<any[]>("SELECT * FROM purchase_bills WHERE id = ? LIMIT 1", [id]);
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
      `SELECT b.*, v.name as vendor_name, co.name as company_name, co.code as company_code
       FROM purchase_bills b
       JOIN vendors v ON v.id = b.vendor_id
       JOIN companies co ON co.id = b.company_id
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
purchaseBillsRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const result = await validatePayload(req.body);
    if ("error" in result) return res.status(400).json({ message: result.error });
    const { company, lines } = result;

    const { vendor_id, purchase_order_id, bill_date, due_date, reference_no, notes } = req.body ?? {};

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

    const { docNumber, financialYear } = await getNextDocNumber("purchase_bill", company!.code, new Date(bill_date));

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [insertResult] = await conn.query<any>(
        `INSERT INTO purchase_bills
           (bill_no, financial_year, company_id, vendor_id, purchase_order_id, status, bill_date, due_date,
            reference_no, notes, subtotal, tax_amount, total_amount, created_by)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          docNumber,
          financialYear,
          req.body.company_id,
          vendor_id,
          purchase_order_id || null,
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
        companyId: Number(req.body.company_id),
        billId,
        billNo: docNumber,
        billDate: bill_date,
        subtotal,
        taxAmount,
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

      await conn.query(
        `UPDATE purchase_bills SET
           company_id = ?, vendor_id = ?, purchase_order_id = ?, status = ?, bill_date = ?, due_date = ?,
           reference_no = ?, notes = ?, subtotal = ?, tax_amount = ?, total_amount = ?
         WHERE id = ?`,
        [
          req.body.company_id,
          vendor_id,
          purchase_order_id || null,
          status && ["draft", "received", "cancelled"].includes(status) ? status : existing.status,
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
      const priorJournal = await getJournalBySource("purchase_bill", id);
      if (priorJournal) {
        await reverseJournalTx(conn, priorJournal.id, req.user!.sub);
      }
      const journal = await postPurchaseBillJournalTx(conn, {
        companyId: Number(req.body.company_id),
        billId: id,
        billNo: existing.bill_no,
        billDate: bill_date,
        subtotal,
        taxAmount,
        createdBy: req.user!.sub,
      });

      await conn.commit();
      const updated = await findById(id);
      const items = await findItemsForBill(id);
      res.json({ bill: updated, items, journal: { id: journal.id, status: journal.status } });
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError) {
        return res.status(400).json({ message: `Purchase bill could not be updated: ${err.message}` });
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

      await conn.query("DELETE FROM purchase_bills WHERE id = ?", [id]);
      await conn.commit();
      res.json({ message: "Purchase bill deleted" });
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError) {
        return res.status(400).json({ message: `Purchase bill could not be deleted: ${err.message}` });
      }
      throw err;
    } finally {
      conn.release();
    }
  })
);
