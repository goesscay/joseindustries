import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { getNextDocNumber } from "../services/numbering";
import { computeLine, LineInput } from "../utils/totals";
import { Company, PurchaseOrder, PurchaseOrderItem, Vendor } from "../types";

// Purchase Orders (Phase 7B) - a commitment/order document, NOT an
// accounting liability. This file deliberately imports NOTHING from
// ../services/accounting - no createJournalTx, no postXJournalTx, no
// getJournalBySource. That is not an oversight to double-check elsewhere;
// it is the entire mechanism by which "a Purchase Order can never create
// a journal" is guaranteed - there is no accounting code path in this
// router for a bug to accidentally reach. Only src/routes/purchaseBills.ts
// (already accounting-integrated since Phase 7A) posts a journal, and only
// when an actual Purchase Bill is created - whether typed directly or via
// conversion from a PO.
export const purchaseOrdersRouter = Router();
const MODULE = "purchases.orders";
purchaseOrdersRouter.use(requireAuth);

// Whether a bill already exists for this PO is a derived fact (a LEFT JOIN
// against purchase_bills), never a cached column on purchase_orders - see
// schema.sql's comment on why (keeps the data model one-to-many-ready for
// a future partial-billing phase without a migration).
const BILLED_JOIN = `LEFT JOIN purchase_bills pb ON pb.purchase_order_id = po.id`;
const BILLED_SELECT = `, pb.id as billed_bill_id, pb.bill_no as billed_bill_no`;

async function findById(id: number): Promise<PurchaseOrder | undefined> {
  const [rows] = await pool.query<any[]>(
    `SELECT po.*${BILLED_SELECT} FROM purchase_orders po ${BILLED_JOIN} WHERE po.id = ? LIMIT 1`,
    [id]
  );
  return rows[0] as PurchaseOrder | undefined;
}

async function findItemsForOrder(orderId: number): Promise<PurchaseOrderItem[]> {
  const [rows] = await pool.query<any[]>(
    "SELECT * FROM purchase_order_items WHERE purchase_order_id = ? ORDER BY sort_order ASC, id ASC",
    [orderId]
  );
  return rows as PurchaseOrderItem[];
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
  const { company_id, vendor_id, po_date, items } = body ?? {};
  if (!company_id || !vendor_id || !po_date) {
    return { error: "company_id, vendor_id and po_date are required" };
  }

  const [companyRows] = await pool.query<any[]>("SELECT * FROM companies WHERE id = ?", [company_id]);
  const company = companyRows[0] as Company | undefined;
  if (!company) return { error: "Company not found" };

  // Vendors are a single global list (no company_id, no active/inactive
  // concept - same as Purchase Bills, confirmed by inspection before
  // implementing this) - existence is the only check possible.
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

function computeTotalsFromLines<T extends LineInput>(lines: T[]) {
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
  return { computedLines, subtotal, taxAmount, totalAmount };
}

purchaseOrdersRouter.get(
  "/",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const perPage = Math.min(Math.max(Number(req.query.perPage) || 10, 1), 100);
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const offset = (page - 1) * perPage;

    const searchClause = search ? "AND (po.po_no LIKE ? OR v.name LIKE ?)" : "";
    const searchParams = search ? [`%${search}%`, `%${search}%`] : [];

    const [rows] = await pool.query<any[]>(
      `SELECT po.*, v.name as vendor_name, co.name as company_name, co.code as company_code${BILLED_SELECT}
       FROM purchase_orders po
       JOIN vendors v ON v.id = po.vendor_id
       JOIN companies co ON co.id = po.company_id
       ${BILLED_JOIN}
       WHERE 1=1 ${searchClause}
       ORDER BY po.created_at DESC
       LIMIT ? OFFSET ?`,
      [...searchParams, perPage, offset]
    );
    const [countRows] = await pool.query<any[]>(
      `SELECT COUNT(*) as total FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id WHERE 1=1 ${searchClause}`,
      searchParams
    );

    res.json({ data: rows, meta: { page, perPage, total: countRows[0].total as number } });
  })
);

purchaseOrdersRouter.get(
  "/:id",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const order = await findById(Number(req.params.id));
    if (!order) return res.status(404).json({ message: "Purchase order not found" });
    const items = await findItemsForOrder(order.id);
    res.json({ order, items });
  })
);

purchaseOrdersRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const result = await validatePayload(req.body);
    if ("error" in result) return res.status(400).json({ message: result.error });
    const { company, lines } = result;

    const { vendor_id, po_date, expected_date, reference_no, notes } = req.body ?? {};
    const { computedLines, subtotal, taxAmount, totalAmount } = computeTotalsFromLines(lines);

    const { docNumber, financialYear } = await getNextDocNumber("purchase_order", company!.code, new Date(po_date));

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [insertResult] = await conn.query<any>(
        `INSERT INTO purchase_orders
           (po_no, financial_year, company_id, vendor_id, status, po_date, expected_date,
            reference_no, notes, subtotal, tax_amount, total_amount, created_by)
         VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          docNumber,
          financialYear,
          req.body.company_id,
          vendor_id,
          po_date,
          expected_date || null,
          reference_no || null,
          notes || null,
          subtotal,
          taxAmount,
          totalAmount,
          req.user!.sub,
        ]
      );
      const orderId = insertResult.insertId;

      let sortOrder = 0;
      for (const { line, computed } of computedLines) {
        await conn.query(
          `INSERT INTO purchase_order_items
             (purchase_order_id, item_id, description, hsn_code, qty, unit, rate, tax_rate, taxable_amount, tax_amount, line_total, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            orderId,
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

      await conn.commit();
      const created = await findById(orderId);
      const items = await findItemsForOrder(orderId);
      res.status(201).json({ order: created, items });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  })
);

purchaseOrdersRouter.put(
  "/:id",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const result = await validatePayload(req.body);
    if ("error" in result) return res.status(400).json({ message: result.error });
    const { lines } = result;

    const { vendor_id, po_date, expected_date, reference_no, notes, status } = req.body ?? {};
    const { computedLines, subtotal, taxAmount, totalAmount } = computeTotalsFromLines(lines);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [existingRows] = await conn.query<any[]>(
        `SELECT po.*${BILLED_SELECT} FROM purchase_orders po ${BILLED_JOIN} WHERE po.id = ? FOR UPDATE`,
        [id]
      );
      const existing = existingRows[0] as PurchaseOrder | undefined;
      if (!existing) {
        await conn.rollback();
        return res.status(404).json({ message: "Purchase order not found" });
      }
      if (existing.billed_bill_id) {
        await conn.rollback();
        return res.status(400).json({
          message: `This purchase order has already been converted to Purchase Bill ${existing.billed_bill_no} and cannot be edited`,
        });
      }
      if (existing.status === "cancelled") {
        await conn.rollback();
        return res.status(400).json({ message: "Cannot edit a cancelled purchase order" });
      }

      await conn.query(
        `UPDATE purchase_orders SET
           company_id = ?, vendor_id = ?, status = ?, po_date = ?, expected_date = ?,
           reference_no = ?, notes = ?, subtotal = ?, tax_amount = ?, total_amount = ?
         WHERE id = ?`,
        [
          req.body.company_id,
          vendor_id,
          status && ["draft", "confirmed", "cancelled"].includes(status) ? status : existing.status,
          po_date,
          expected_date || null,
          reference_no || null,
          notes || null,
          subtotal,
          taxAmount,
          totalAmount,
          id,
        ]
      );

      await conn.query("DELETE FROM purchase_order_items WHERE purchase_order_id = ?", [id]);
      let sortOrder = 0;
      for (const { line, computed } of computedLines) {
        await conn.query(
          `INSERT INTO purchase_order_items
             (purchase_order_id, item_id, description, hsn_code, qty, unit, rate, tax_rate, taxable_amount, tax_amount, line_total, sort_order)
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

      await conn.commit();
      const updated = await findById(id);
      const items = await findItemsForOrder(id);
      res.json({ order: updated, items });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  })
);

// Draft + unbilled -> deletable. Confirmed (even if unbilled) is NOT
// hard-deletable - same existing convention as Purchase Bills/Sales
// documents ("only draft can be deleted"); a confirmed PO the user no
// longer wants is cancelled via PUT (status: 'cancelled'), not removed.
// Billed -> never deletable regardless of status, checked via the same
// derived billed_bill_id join used everywhere else in this file.
purchaseOrdersRouter.delete(
  "/:id",
  requireModuleAccess(MODULE, "delete"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findById(id);
    if (!existing) return res.status(404).json({ message: "Purchase order not found" });
    if (existing.billed_bill_id) {
      return res.status(400).json({
        message: `This purchase order has already been converted to Purchase Bill ${existing.billed_bill_no} and cannot be deleted`,
      });
    }
    if (existing.status !== "draft") {
      return res.status(400).json({ message: "Only draft purchase orders can be deleted" });
    }

    await pool.query("DELETE FROM purchase_orders WHERE id = ?", [id]);
    res.json({ message: "Purchase order deleted" });
  })
);
