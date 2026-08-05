import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { getNextDocNumber } from "../services/numbering";
import { computeTotals } from "../utils/totals";
import { computeGstSplit } from "../utils/gst";
import { streamQuotationPdf } from "../services/pdf/quotationPdf";
import { Company, Customer, DocumentItem, DocumentRecord } from "../types";

export const quotationsRouter = Router();

quotationsRouter.use(requireAuth);

interface LineItemInput {
  item_id: number | null;
  description: string;
  hsn_code: string | null;
  qty: number;
  unit: string;
  rate: number;
  tax_rate: number;
}

class ValidationError extends Error {
  status = 400;
}

// Optional Tally-style reference fields carried on the document, all nullable.
const OPTIONAL_FIELDS = [
  "consignee_name",
  "consignee_address",
  "consignee_gstin",
  "consignee_state",
  "transport_mode",
  "vehicle_number",
  "date_of_supply",
  "place_of_supply",
  "buyers_order_no",
  "buyers_order_date",
  "dispatch_doc_no",
  "dispatched_through",
  "destination",
  "terms_of_delivery",
  "delivery_note",
  "delivery_note_date",
  "mode_terms_of_payment",
  "other_reference",
  "supplier_reference",
] as const;

function pickOptionalFields(body: any): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const field of OPTIONAL_FIELDS) {
    result[field] = body[field] || null;
  }
  return result;
}

async function findQuotationById(id: number): Promise<DocumentRecord | undefined> {
  const [rows] = await pool.query<any[]>(
    "SELECT * FROM documents WHERE id = ? AND doc_type = 'quotation' LIMIT 1",
    [id]
  );
  return rows[0] as DocumentRecord | undefined;
}

async function findItemsForDocument(documentId: number): Promise<DocumentItem[]> {
  const [rows] = await pool.query<any[]>(
    "SELECT * FROM document_items WHERE document_id = ? ORDER BY sort_order ASC, id ASC",
    [documentId]
  );
  return rows as DocumentItem[];
}

function validateAndNormalizeLines(rawItems: unknown): LineItemInput[] {
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
      tax_rate,
    };
  });
}

quotationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const perPage = Math.min(Math.max(Number(req.query.perPage) || 10, 1), 100);
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const offset = (page - 1) * perPage;

    const searchClause = search ? "AND (d.doc_number LIKE ? OR c.name LIKE ?)" : "";
    const searchParams = search ? [`%${search}%`, `%${search}%`] : [];

    const [rows] = await pool.query<any[]>(
      `SELECT d.*, c.name as customer_name, co.name as company_name, co.code as company_code
       FROM documents d
       JOIN customers c ON c.id = d.customer_id
       JOIN companies co ON co.id = d.company_id
       WHERE d.doc_type = 'quotation' ${searchClause}
       ORDER BY d.created_at DESC
       LIMIT ? OFFSET ?`,
      [...searchParams, perPage, offset]
    );
    const [countRows] = await pool.query<any[]>(
      `SELECT COUNT(*) as total
       FROM documents d
       JOIN customers c ON c.id = d.customer_id
       WHERE d.doc_type = 'quotation' ${searchClause}`,
      searchParams
    );

    res.json({ data: rows, meta: { page, perPage, total: countRows[0].total as number } });
  })
);

quotationsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const quotation = await findQuotationById(Number(req.params.id));
    if (!quotation) return res.status(404).json({ message: "Quotation not found" });
    const items = await findItemsForDocument(quotation.id);
    res.json({ quotation, items });
  })
);

quotationsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { company_id, customer_id, issue_date, notes, items } = req.body ?? {};
    if (!company_id || !customer_id || !issue_date) {
      return res.status(400).json({ message: "company_id, customer_id and issue_date are required" });
    }

    const [companyRows] = await pool.query<any[]>("SELECT * FROM companies WHERE id = ?", [company_id]);
    const company = companyRows[0] as Company | undefined;
    if (!company) return res.status(404).json({ message: "Company not found" });

    const [customerRows] = await pool.query<any[]>("SELECT * FROM customers WHERE id = ?", [customer_id]);
    const customer = customerRows[0] as Customer | undefined;
    if (!customer) return res.status(404).json({ message: "Customer not found" });

    let lines: LineItemInput[];
    try {
      lines = validateAndNormalizeLines(items);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(err.status).json({ message: err.message });
      throw err;
    }

    const { subtotal, grandTotal } = computeTotals(lines);
    const { isInterState, cgstTotal, sgstTotal, igstTotal } = computeGstSplit(lines, company.state, customer.state);
    const taxTotal = isInterState ? igstTotal : cgstTotal + sgstTotal;
    const optionalFields = pickOptionalFields(req.body ?? {});

    const { docNumber, financialYear } = await getNextDocNumber("quotation", company.code, new Date(issue_date));

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query<any>(
        `INSERT INTO documents
           (doc_type, doc_number, financial_year, company_id, customer_id, status, issue_date, notes,
            consignee_name, consignee_address, consignee_gstin, consignee_state,
            transport_mode, vehicle_number, date_of_supply, place_of_supply,
            buyers_order_no, buyers_order_date, dispatch_doc_no, dispatched_through,
            destination, terms_of_delivery, delivery_note, delivery_note_date,
            mode_terms_of_payment, other_reference, supplier_reference,
            subtotal, cgst_total, sgst_total, igst_total, tax_total, grand_total, created_by)
         VALUES ('quotation', ?, ?, ?, ?, 'draft', ?, ?,
                 ?, ?, ?, ?,
                 ?, ?, ?, ?,
                 ?, ?, ?, ?,
                 ?, ?, ?, ?,
                 ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?)`,
        [
          docNumber,
          financialYear,
          company_id,
          customer_id,
          issue_date,
          notes || null,
          optionalFields.consignee_name,
          optionalFields.consignee_address,
          optionalFields.consignee_gstin,
          optionalFields.consignee_state,
          optionalFields.transport_mode,
          optionalFields.vehicle_number,
          optionalFields.date_of_supply,
          optionalFields.place_of_supply,
          optionalFields.buyers_order_no,
          optionalFields.buyers_order_date,
          optionalFields.dispatch_doc_no,
          optionalFields.dispatched_through,
          optionalFields.destination,
          optionalFields.terms_of_delivery,
          optionalFields.delivery_note,
          optionalFields.delivery_note_date,
          optionalFields.mode_terms_of_payment,
          optionalFields.other_reference,
          optionalFields.supplier_reference,
          subtotal,
          cgstTotal,
          sgstTotal,
          igstTotal,
          taxTotal,
          grandTotal,
          req.user!.sub,
        ]
      );
      const documentId = result.insertId;

      for (const [index, line] of lines.entries()) {
        const lineTotal = Math.round(line.qty * line.rate * 100) / 100;
        await conn.query(
          `INSERT INTO document_items
             (document_id, item_id, description, hsn_code, qty, unit, rate, tax_rate, line_total, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            documentId,
            line.item_id,
            line.description,
            line.hsn_code,
            line.qty,
            line.unit,
            line.rate,
            line.tax_rate,
            lineTotal,
            index,
          ]
        );
      }

      await conn.commit();
      const quotation = await findQuotationById(documentId);
      const docItems = await findItemsForDocument(documentId);
      res.status(201).json({ quotation, items: docItems });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  })
);

quotationsRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findQuotationById(id);
    if (!existing) return res.status(404).json({ message: "Quotation not found" });
    if (existing.status === "cancelled") {
      return res.status(400).json({ message: "Cannot edit a cancelled quotation" });
    }

    const { company_id, customer_id, issue_date, notes, items } = req.body ?? {};
    if (!company_id || !customer_id || !issue_date) {
      return res.status(400).json({ message: "company_id, customer_id and issue_date are required" });
    }

    const [companyRows] = await pool.query<any[]>("SELECT * FROM companies WHERE id = ?", [company_id]);
    const company = companyRows[0] as Company | undefined;
    if (!company) return res.status(404).json({ message: "Company not found" });

    const [customerRows] = await pool.query<any[]>("SELECT * FROM customers WHERE id = ?", [customer_id]);
    const customer = customerRows[0] as Customer | undefined;
    if (!customer) return res.status(404).json({ message: "Customer not found" });

    let lines: LineItemInput[];
    try {
      lines = validateAndNormalizeLines(items);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(err.status).json({ message: err.message });
      throw err;
    }

    const { subtotal, grandTotal } = computeTotals(lines);
    const { isInterState, cgstTotal, sgstTotal, igstTotal } = computeGstSplit(lines, company.state, customer.state);
    const taxTotal = isInterState ? igstTotal : cgstTotal + sgstTotal;
    const optionalFields = pickOptionalFields(req.body ?? {});

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `UPDATE documents SET
           company_id = ?, customer_id = ?, issue_date = ?, notes = ?,
           consignee_name = ?, consignee_address = ?, consignee_gstin = ?, consignee_state = ?,
           transport_mode = ?, vehicle_number = ?, date_of_supply = ?, place_of_supply = ?,
           buyers_order_no = ?, buyers_order_date = ?, dispatch_doc_no = ?, dispatched_through = ?,
           destination = ?, terms_of_delivery = ?, delivery_note = ?, delivery_note_date = ?,
           mode_terms_of_payment = ?, other_reference = ?, supplier_reference = ?,
           subtotal = ?, cgst_total = ?, sgst_total = ?, igst_total = ?, tax_total = ?, grand_total = ?
         WHERE id = ?`,
        [
          company_id,
          customer_id,
          issue_date,
          notes || null,
          optionalFields.consignee_name,
          optionalFields.consignee_address,
          optionalFields.consignee_gstin,
          optionalFields.consignee_state,
          optionalFields.transport_mode,
          optionalFields.vehicle_number,
          optionalFields.date_of_supply,
          optionalFields.place_of_supply,
          optionalFields.buyers_order_no,
          optionalFields.buyers_order_date,
          optionalFields.dispatch_doc_no,
          optionalFields.dispatched_through,
          optionalFields.destination,
          optionalFields.terms_of_delivery,
          optionalFields.delivery_note,
          optionalFields.delivery_note_date,
          optionalFields.mode_terms_of_payment,
          optionalFields.other_reference,
          optionalFields.supplier_reference,
          subtotal,
          cgstTotal,
          sgstTotal,
          igstTotal,
          taxTotal,
          grandTotal,
          id,
        ]
      );
      await conn.query("DELETE FROM document_items WHERE document_id = ?", [id]);
      for (const [index, line] of lines.entries()) {
        const lineTotal = Math.round(line.qty * line.rate * 100) / 100;
        await conn.query(
          `INSERT INTO document_items
             (document_id, item_id, description, hsn_code, qty, unit, rate, tax_rate, line_total, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, line.item_id, line.description, line.hsn_code, line.qty, line.unit, line.rate, line.tax_rate, lineTotal, index]
        );
      }
      await conn.commit();
      const quotation = await findQuotationById(id);
      const docItems = await findItemsForDocument(id);
      res.json({ quotation, items: docItems });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  })
);

quotationsRouter.patch(
  "/:id/status",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { status } = req.body ?? {};
    const allowed = ["draft", "sent", "accepted", "rejected", "cancelled"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }
    const existing = await findQuotationById(id);
    if (!existing) return res.status(404).json({ message: "Quotation not found" });

    await pool.query("UPDATE documents SET status = ? WHERE id = ?", [status, id]);
    const quotation = await findQuotationById(id);
    res.json({ quotation });
  })
);

quotationsRouter.delete(
  "/:id",
  requireRole("super_admin", "admin"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findQuotationById(id);
    if (!existing) return res.status(404).json({ message: "Quotation not found" });
    if (existing.status !== "draft") {
      return res.status(400).json({ message: "Only draft quotations can be deleted" });
    }
    await pool.query("DELETE FROM documents WHERE id = ?", [id]);
    res.json({ message: "Quotation deleted" });
  })
);

quotationsRouter.get(
  "/:id/pdf",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const quotation = await findQuotationById(id);
    if (!quotation) return res.status(404).json({ message: "Quotation not found" });

    const items = await findItemsForDocument(id);
    const [companyRows] = await pool.query<any[]>("SELECT * FROM companies WHERE id = ?", [quotation.company_id]);
    const [customerRows] = await pool.query<any[]>("SELECT * FROM customers WHERE id = ?", [quotation.customer_id]);
    const company = companyRows[0] as Company;
    const customer = customerRows[0] as Customer;

    streamQuotationPdf(
      res,
      quotation,
      items.map((i) => ({
        ...i,
        qty: Number(i.qty),
        rate: Number(i.rate),
        tax_rate: Number(i.tax_rate),
        line_total: Number(i.line_total),
      })),
      customer,
      company
    );
  })
);
