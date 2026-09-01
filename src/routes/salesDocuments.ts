import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { getNextDocNumber } from "../services/numbering";
import { computeLine, computeTotals, LineInput } from "../utils/totals";
import { computeGstSplit } from "../utils/gst";
import { streamDocumentPdf } from "../services/pdf/documentPdf";
import {
  AccountingError,
  getJournalBySource,
  postSaleCogsJournalTx,
  postTaxInvoiceJournalTx,
  reverseJournalTx,
} from "../services/accounting";
import { InsufficientStockError, InventoryError, postDocumentStockMovementTx, reverseStockForSourceTx } from "../services/inventory";
import { Company, Customer, DocType, DocumentItem, DocumentRecord, Journal, StockTransaction, Role } from "../types";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Phase 12E: COGS = sum(qty * unit_cost) read directly from the
 * stock_transactions rows postDocumentStockMovementTx just posted/returned
 * - never recomputed via a second resolveSaleCost call - so "stock issue
 * value = COGS value" holds by construction. unit_cost is nullable on the
 * type (a purchase_receipt or opening entry can lack one) but every
 * 'sale_issue' row always has one (resolveSaleCost never returns undefined,
 * falling back to 0 with isFallback rather than leaving it unset) - the
 * `?? 0` here is defensive, not a real fallback path.
 */
function computeCogsAmount(posted: StockTransaction[]): number {
  return round2(
    posted
      .filter((t) => t.txn_type === "sale_issue")
      .reduce((sum, t) => sum + Number(t.qty) * Number(t.unit_cost ?? 0), 0)
  );
}

export interface SalesDocumentRouterOptions {
  /**
   * If set, only these roles may create/edit this document type, no matter
   * what a staff member's granted module permissions say - a hard business
   * rule (e.g. only Admin/Super Admin may issue a legally-binding Tax
   * Invoice), layered UNDER the normal module permission check rather than
   * replacing it. Leave unset for document types where the usual
   * view/create/edit/delete grants (see utils/permissions.ts) are the only
   * gate.
   */
  createRoles?: Role[];
  /** If set, list/detail responses include paid_amount/balance_due from the receipts table. */
  includePaymentSummary?: boolean;
}

const MODULE_BY_DOC_TYPE: Partial<Record<DocType, string>> = {
  quotation: "sales.quotations",
  proforma_invoice: "sales.proforma_invoices",
  delivery_challan: "sales.delivery_challans",
  tax_invoice: "sales.tax_invoices",
};

class ValidationError extends Error {
  status = 400;
}

// Optional Tally-style reference fields carried on the document, all nullable strings.
const OPTIONAL_TEXT_FIELDS = [
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
  "terms_and_conditions",
  "due_date",
  "credit_period",
] as const;

function pickOptionalTextFields(body: any): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const field of OPTIONAL_TEXT_FIELDS) {
    result[field] = body[field] || null;
  }
  return result;
}

interface NormalizedLine extends LineInput {
  item_id: number | null;
  description: string;
  hsn_code: string | null;
  unit: string;
}

function validateAndNormalizeLines(rawItems: unknown): NormalizedLine[] {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new ValidationError("At least one line item is required");
  }
  return rawItems.map((raw) => {
    const qty = Number(raw.qty);
    const rate = Number(raw.rate);
    const tax_rate = Number(raw.tax_rate ?? 0);
    const discount_percent = Number(raw.discount_percent ?? 0);
    if (!raw.description || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(rate) || rate < 0) {
      throw new ValidationError("Each line item needs a description, positive qty, and rate");
    }
    if (!Number.isFinite(discount_percent) || discount_percent < 0 || discount_percent > 100) {
      throw new ValidationError("Discount % must be between 0 and 100");
    }
    return {
      item_id: raw.item_id ?? null,
      description: String(raw.description),
      hsn_code: raw.hsn_code ?? null,
      qty,
      unit: raw.unit || "pcs",
      rate,
      discount_percent,
      tax_rate,
    };
  });
}

/**
 * Builds a CRUD + PDF router shared across all sales document types
 * (Quotation, Proforma Invoice, Delivery Challan, ...). Each type lives in the
 * same `documents`/`document_items` tables, distinguished by `docType`, and
 * gets its own independent numbering series via `getNextDocNumber`.
 */
export function createSalesDocumentRouter(
  docType: DocType,
  title: string,
  options: SalesDocumentRouterOptions = {}
) {
  const router = Router();
  router.use(requireAuth);

  const MODULE = MODULE_BY_DOC_TYPE[docType] ?? "sales.quotations";
  const createGuard = options.createRoles ? [requireRole(...options.createRoles)] : [];
  // Receipts enhancement: sourced from receipt_allocations (one receipt can
  // now settle several invoices, and the legacy receipts.tax_invoice_id
  // column is no longer authoritative - see schema.sql's comment on
  // receipt_allocations) rather than receipts directly, and now also nets
  // out non-cancelled Credit Notes - a real pre-existing bug fixed here:
  // this figure previously ignored Credit Notes entirely, so an invoice's
  // displayed balance (including in the old Receipts page's invoice
  // dropdown) could overstate what a customer actually still owed once any
  // Credit Note existed against it. reports.ts's Outstanding report already
  // got the Credit Notes term right; this brings the invoice list/detail
  // endpoints' own paid_amount into agreement with it.
  const paymentSelect = options.includePaymentSummary
    ? `, COALESCE((SELECT SUM(ra.amount) FROM receipt_allocations ra WHERE ra.tax_invoice_id = d.id), 0)
         + COALESCE((SELECT SUM(cn.grand_total) FROM credit_notes cn WHERE cn.tax_invoice_id = d.id AND cn.status != 'cancelled'), 0)
         as paid_amount`
    : "";

  async function findById(id: number): Promise<DocumentRecord | undefined> {
    const [rows] = await pool.query<any[]>(
      `SELECT d.*${paymentSelect} FROM documents d WHERE d.id = ? AND d.doc_type = ? LIMIT 1`,
      [id, docType]
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

  router.get(
    "/",
    requireModuleAccess(MODULE, "view"),
    asyncHandler(async (req, res) => {
      const page = Math.max(Number(req.query.page) || 1, 1);
      const perPage = Math.min(Math.max(Number(req.query.perPage) || 10, 1), 100);
      const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
      const companyId = req.query.company_id ? Number(req.query.company_id) : null;
      const offset = (page - 1) * perPage;

      const searchClause = search ? "AND (d.doc_number LIKE ? OR c.name LIKE ?)" : "";
      const searchParams = search ? [`%${search}%`, `%${search}%`] : [];
      const companyClause = companyId ? "AND d.company_id = ?" : "";
      const companyParams = companyId ? [companyId] : [];

      const [rows] = await pool.query<any[]>(
        `SELECT d.*, c.name as customer_name, co.name as company_name, co.code as company_code${paymentSelect}
         FROM documents d
         JOIN customers c ON c.id = d.customer_id
         JOIN companies co ON co.id = d.company_id
         WHERE d.doc_type = ? ${searchClause} ${companyClause}
         ORDER BY d.issue_date DESC, d.id DESC
         LIMIT ? OFFSET ?`,
        [docType, ...searchParams, ...companyParams, perPage, offset]
      );
      const [countRows] = await pool.query<any[]>(
        `SELECT COUNT(*) as total
         FROM documents d
         JOIN customers c ON c.id = d.customer_id
         WHERE d.doc_type = ? ${searchClause} ${companyClause}`,
        [docType, ...searchParams, ...companyParams]
      );

      res.json({ data: rows, meta: { page, perPage, total: countRows[0].total as number } });
    })
  );

  router.get(
    "/:id",
    requireModuleAccess(MODULE, "view"),
    asyncHandler(async (req, res) => {
      const doc = await findById(Number(req.params.id));
      if (!doc) return res.status(404).json({ message: `${title} not found` });
      const items = await findItemsForDocument(doc.id);
      res.json({ document: doc, items });
    })
  );

  router.post(
    "/",
    ...createGuard,
    requireModuleAccess(MODULE, "create"),
    asyncHandler(async (req, res) => {
      const {
        company_id,
        customer_id,
        issue_date,
        notes,
        items,
        converted_from_id,
        reverse_charge,
        freight_charges,
        installation_charges,
        confirm_negative_stock,
      } = req.body ?? {};
      if (!company_id || !customer_id || !issue_date) {
        return res.status(400).json({ message: "company_id, customer_id and issue_date are required" });
      }

      const [companyRows] = await pool.query<any[]>("SELECT * FROM companies WHERE id = ?", [company_id]);
      const company = companyRows[0] as Company | undefined;
      if (!company) return res.status(404).json({ message: "Company not found" });

      const [customerRows] = await pool.query<any[]>("SELECT * FROM customers WHERE id = ?", [customer_id]);
      const customer = customerRows[0] as Customer | undefined;
      if (!customer) return res.status(404).json({ message: "Customer not found" });

      let convertedFromId: number | null = null;
      if (converted_from_id) {
        const [sourceRows] = await pool.query<any[]>("SELECT id FROM documents WHERE id = ?", [converted_from_id]);
        if (!sourceRows[0]) return res.status(404).json({ message: "Source document not found" });
        convertedFromId = Number(converted_from_id);
      }

      let lines;
      try {
        lines = validateAndNormalizeLines(items);
      } catch (err) {
        if (err instanceof ValidationError) return res.status(err.status).json({ message: err.message });
        throw err;
      }

      const freightCharges = Number(freight_charges) || 0;
      const installationCharges = Number(installation_charges) || 0;
      const { subtotal, discountAmount, freightCharges: freight, installationCharges: installation, roundOff, grandTotal } =
        computeTotals(lines, { freightCharges, installationCharges });
      const { isInterState, cgstTotal, sgstTotal, igstTotal } = computeGstSplit(lines, company.state, customer.state);
      const taxTotal = isInterState ? igstTotal : cgstTotal + sgstTotal;
      const optionalFields = pickOptionalTextFields(req.body ?? {});

      const { docNumber, financialYear } = await getNextDocNumber(docType, company.code, new Date(issue_date));

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [result] = await conn.query<any>(
          `INSERT INTO documents
             (doc_type, doc_number, financial_year, company_id, customer_id, status, converted_from_id, issue_date, notes,
              consignee_name, consignee_address, consignee_gstin, consignee_state,
              transport_mode, vehicle_number, date_of_supply, place_of_supply,
              buyers_order_no, buyers_order_date, dispatch_doc_no, dispatched_through,
              destination, terms_of_delivery, delivery_note, delivery_note_date,
              mode_terms_of_payment, other_reference, supplier_reference, terms_and_conditions,
              due_date, credit_period, reverse_charge,
              subtotal, discount_amount, freight_charges, installation_charges,
              cgst_total, sgst_total, igst_total, tax_total, round_off, grand_total, created_by)
           VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?,
                   ?, ?, ?, ?,
                   ?, ?, ?, ?,
                   ?, ?, ?, ?,
                   ?, ?, ?, ?,
                   ?, ?, ?, ?,
                   ?, ?, ?,
                   ?, ?, ?, ?,
                   ?, ?, ?, ?, ?, ?, ?)`,
          [
            docType,
            docNumber,
            financialYear,
            company_id,
            customer_id,
            convertedFromId,
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
            optionalFields.terms_and_conditions,
            optionalFields.due_date,
            optionalFields.credit_period,
            reverse_charge ? 1 : 0,
            subtotal,
            discountAmount,
            freight,
            installation,
            cgstTotal,
            sgstTotal,
            igstTotal,
            taxTotal,
            roundOff,
            grandTotal,
            req.user!.sub,
          ]
        );
        const documentId = result.insertId;

        for (const [index, line] of lines.entries()) {
          const { lineTotal } = computeLine(line);
          await conn.query(
            `INSERT INTO document_items
               (document_id, item_id, description, hsn_code, qty, unit, rate, discount_percent, tax_rate, line_total, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              documentId,
              line.item_id,
              line.description,
              line.hsn_code,
              line.qty,
              line.unit,
              line.rate,
              line.discount_percent,
              line.tax_rate,
              lineTotal,
              index,
            ]
          );
        }

        // Only a FINAL Tax Invoice creates the accounting journal - Leads,
        // Quotations, Proforma Invoices and Delivery Challans never do,
        // since this same factory function is shared across all of them
        // and docType is the only thing distinguishing this call.
        let journal: Journal | undefined;
        let cogsJournal: Journal | undefined;
        let stock: Awaited<ReturnType<typeof postDocumentStockMovementTx>> | undefined;
        if (docType === "tax_invoice") {
          journal = await postTaxInvoiceJournalTx(conn, {
            companyId: Number(company_id),
            invoiceId: documentId,
            invoiceNo: docNumber,
            issueDate: issue_date,
            grandTotal,
            taxTotal,
            cgstTotal,
            sgstTotal,
            igstTotal,
            createdBy: req.user!.sub,
          });
          // Phase 12: stock-out follows the journal's own timing exactly -
          // posted unconditionally at creation regardless of the document's
          // 'draft' status, since the journal already does the same (a
          // "draft" Tax Invoice has real ledger effect in this app - see
          // Phase 11B's own audit). Soft-blocks on negative stock unless
          // the caller explicitly confirms.
          stock = await postDocumentStockMovementTx(conn, {
            companyId: Number(company_id),
            sourceType: "tax_invoice",
            sourceId: documentId,
            txnDate: issue_date,
            direction: "out",
            lines: lines.map((l) => ({ item_id: l.item_id, qty: l.qty, unit: l.unit })),
            createdBy: req.user!.sub,
            confirmNegativeStock: Boolean(confirm_negative_stock),
          });
          // Phase 12E: COGS is its own separate journal (see the Phase 12E
          // audit's "Option B" decision) - the revenue/GST journal just
          // posted above is completely untouched by this. Computed from
          // the stock rows just posted, never recomputed independently, so
          // it can never disagree with the stock issue's own value. Only
          // posted when nonzero (a 100% non-tracked invoice, or a fallback-
          // to-0-cost sale, correctly posts no COGS journal at all - same
          // "skip the zero bucket" rule postPurchaseBillJournalTx uses).
          const cogsAmount = computeCogsAmount(stock.posted);
          if (cogsAmount > 0) {
            cogsJournal = await postSaleCogsJournalTx(conn, {
              companyId: Number(company_id),
              invoiceId: documentId,
              invoiceNo: docNumber,
              issueDate: issue_date,
              cogsAmount,
              createdBy: req.user!.sub,
            });
          }
        }

        await conn.commit();
        const created = await findById(documentId);
        const docItems = await findItemsForDocument(documentId);
        res.status(201).json({
          document: created,
          items: docItems,
          journal: journal ? { id: journal.id, status: journal.status } : null,
          cogsJournal: cogsJournal ? { id: cogsJournal.id, status: cogsJournal.status } : null,
          stock: stock ? { posted: stock.posted.length, skipped: stock.skipped, costFallbacks: stock.costFallbacks } : null,
        });
      } catch (err) {
        await conn.rollback();
        if (err instanceof InsufficientStockError) {
          return res.status(err.status).json({ message: err.message, code: "INSUFFICIENT_STOCK", items: err.items });
        }
        if (err instanceof AccountingError || err instanceof InventoryError) {
          return res.status(err.status).json({ message: `${title} could not be recorded: ${err.message}` });
        }
        throw err;
      } finally {
        conn.release();
      }
    })
  );

  router.put(
    "/:id",
    ...createGuard,
    requireModuleAccess(MODULE, "edit"),
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const existing = await findById(id);
      if (!existing) return res.status(404).json({ message: `${title} not found` });
      if (existing.status === "cancelled") {
        return res.status(400).json({ message: `Cannot edit a cancelled ${title.toLowerCase()}` });
      }

      const {
        company_id,
        customer_id,
        issue_date,
        notes,
        items,
        reverse_charge,
        freight_charges,
        installation_charges,
        confirm_negative_stock,
      } = req.body ?? {};
      if (!company_id || !customer_id || !issue_date) {
        return res.status(400).json({ message: "company_id, customer_id and issue_date are required" });
      }

      const [companyRows] = await pool.query<any[]>("SELECT * FROM companies WHERE id = ?", [company_id]);
      const company = companyRows[0] as Company | undefined;
      if (!company) return res.status(404).json({ message: "Company not found" });

      const [customerRows] = await pool.query<any[]>("SELECT * FROM customers WHERE id = ?", [customer_id]);
      const customer = customerRows[0] as Customer | undefined;
      if (!customer) return res.status(404).json({ message: "Customer not found" });

      let lines;
      try {
        lines = validateAndNormalizeLines(items);
      } catch (err) {
        if (err instanceof ValidationError) return res.status(err.status).json({ message: err.message });
        throw err;
      }

      const freightCharges = Number(freight_charges) || 0;
      const installationCharges = Number(installation_charges) || 0;
      const { subtotal, discountAmount, freightCharges: freight, installationCharges: installation, roundOff, grandTotal } =
        computeTotals(lines, { freightCharges, installationCharges });
      const { isInterState, cgstTotal, sgstTotal, igstTotal } = computeGstSplit(lines, company.state, customer.state);
      const taxTotal = isInterState ? igstTotal : cgstTotal + sgstTotal;
      const optionalFields = pickOptionalTextFields(req.body ?? {});

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
             mode_terms_of_payment = ?, other_reference = ?, supplier_reference = ?, terms_and_conditions = ?,
             due_date = ?, credit_period = ?, reverse_charge = ?,
             subtotal = ?, discount_amount = ?, freight_charges = ?, installation_charges = ?,
             cgst_total = ?, sgst_total = ?, igst_total = ?, tax_total = ?, round_off = ?, grand_total = ?
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
            optionalFields.terms_and_conditions,
            optionalFields.due_date,
            optionalFields.credit_period,
            reverse_charge ? 1 : 0,
            subtotal,
            discountAmount,
            freight,
            installation,
            cgstTotal,
            sgstTotal,
            igstTotal,
            taxTotal,
            roundOff,
            grandTotal,
            id,
          ]
        );
        await conn.query("DELETE FROM document_items WHERE document_id = ?", [id]);
        for (const [index, line] of lines.entries()) {
          const { lineTotal } = computeLine(line);
          await conn.query(
            `INSERT INTO document_items
               (document_id, item_id, description, hsn_code, qty, unit, rate, discount_percent, tax_rate, line_total, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              line.item_id,
              line.description,
              line.hsn_code,
              line.qty,
              line.unit,
              line.rate,
              line.discount_percent,
              line.tax_rate,
              lineTotal,
              index,
            ]
          );
        }
        // A posted journal is never edited in place: reverse whatever
        // journal currently exists for this invoice (if any) and post a
        // fresh one for the corrected figures, in the same transaction as
        // the document update above. The UPDATE statement just above this
        // already took an exclusive row lock on this document for the rest
        // of the transaction, so a concurrent edit of the same invoice is
        // already serialized by the time we get here - no separate FOR
        // UPDATE needed (see receipts.ts/vendorPayments.ts for the pattern
        // this mirrors, where the lock had to be taken explicitly first
        // because nothing else in that handler took one).
        let journal: Journal | undefined;
        let cogsJournal: Journal | undefined;
        let stock: Awaited<ReturnType<typeof postDocumentStockMovementTx>> | undefined;
        if (docType === "tax_invoice") {
          const priorJournal = await getJournalBySource("tax_invoice", id);
          if (priorJournal) {
            await reverseJournalTx(conn, priorJournal.id, req.user!.sub);
          }
          journal = await postTaxInvoiceJournalTx(conn, {
            companyId: Number(company_id),
            invoiceId: id,
            invoiceNo: existing.doc_number,
            issueDate: issue_date,
            grandTotal,
            taxTotal,
            cgstTotal,
            sgstTotal,
            igstTotal,
            createdBy: req.user!.sub,
          });
          // Phase 12E: the COGS journal is reversed here too - independent
          // of the revenue journal above (different source_type, its own
          // reversal chain) - unconditionally, mirroring the revenue
          // journal's own unconditional reverse-then-repost. A no-op if the
          // prior edit's invoice had no tracked lines (nothing to reverse).
          const priorCogsJournal = await getJournalBySource("tax_invoice_cogs", id);
          if (priorCogsJournal) {
            await reverseJournalTx(conn, priorCogsJournal.id, req.user!.sub);
          }
          // Phase 12: same reverse-then-repost shape as the journal just
          // above - reverse whatever stock is currently active for this
          // invoice, then post fresh movements for the corrected lines
          // (evaluated against the balance AFTER that reversal, so editing
          // an invoice down doesn't spuriously warn about stock the
          // reversal just gave back).
          await reverseStockForSourceTx(conn, "tax_invoice", id, req.user!.sub);
          stock = await postDocumentStockMovementTx(conn, {
            companyId: Number(company_id),
            sourceType: "tax_invoice",
            sourceId: id,
            txnDate: issue_date,
            direction: "out",
            lines: lines.map((l) => ({ item_id: l.item_id, qty: l.qty, unit: l.unit })),
            createdBy: req.user!.sub,
            confirmNegativeStock: Boolean(confirm_negative_stock),
          });
          // Phase 12E: repost COGS from the FRESH stock rows just posted
          // above - re-resolved against the post-reversal balance, exactly
          // per the approved edit sequence (reverse, recalculate, repost).
          const cogsAmount = computeCogsAmount(stock.posted);
          if (cogsAmount > 0) {
            cogsJournal = await postSaleCogsJournalTx(conn, {
              companyId: Number(company_id),
              invoiceId: id,
              invoiceNo: existing.doc_number,
              issueDate: issue_date,
              cogsAmount,
              createdBy: req.user!.sub,
            });
          }
        }

        await conn.commit();
        const updated = await findById(id);
        const docItems = await findItemsForDocument(id);
        res.json({
          document: updated,
          items: docItems,
          journal: journal ? { id: journal.id, status: journal.status } : null,
          cogsJournal: cogsJournal ? { id: cogsJournal.id, status: cogsJournal.status } : null,
          stock: stock ? { posted: stock.posted.length, skipped: stock.skipped, costFallbacks: stock.costFallbacks } : null,
        });
      } catch (err) {
        await conn.rollback();
        if (err instanceof InsufficientStockError) {
          return res.status(err.status).json({ message: err.message, code: "INSUFFICIENT_STOCK", items: err.items });
        }
        if (err instanceof AccountingError || err instanceof InventoryError) {
          return res.status(err.status).json({ message: `${title} could not be updated: ${err.message}` });
        }
        throw err;
      } finally {
        conn.release();
      }
    })
  );

  router.patch(
    "/:id/status",
    requireModuleAccess(MODULE, "edit"),
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const { status } = req.body ?? {};
      const allowed = ["draft", "sent", "accepted", "rejected", "cancelled"];
      if (!allowed.includes(status)) {
        return res.status(400).json({ message: "Invalid status" });
      }

      // Phase 11A fix: a status change to 'cancelled' used to be a bare
      // UPDATE with no accounting effect at all - a Tax Invoice's Output
      // GST/Sales/AR journal stayed fully posted forever, even though the
      // document itself now read "cancelled" (confirmed live during Phase
      // 11's audit: Output CGST/SGST stayed at their full posted amount
      // after cancelling). Cancelling now reverses whatever journal is
      // currently active for this invoice, in the same transaction as the
      // status update - if the reversal fails, the cancellation rolls back
      // too. No replacement journal is posted for a cancelled invoice; the
      // original (now status='reversed') and its reversal are both kept,
      // never deleted, preserving the full audit trail exactly like the
      // existing PUT/DELETE handlers already do. Every other status
      // transition is unchanged - a bare UPDATE, no accounting involved,
      // same as before.
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [existingRows] = await conn.query<any[]>(
          "SELECT * FROM documents WHERE id = ? AND doc_type = ? FOR UPDATE",
          [id, docType]
        );
        const existing = existingRows[0] as DocumentRecord | undefined;
        if (!existing) {
          await conn.rollback();
          return res.status(404).json({ message: `${title} not found` });
        }

        if (docType === "tax_invoice" && status === "cancelled") {
          const priorJournal = await getJournalBySource("tax_invoice", id);
          if (priorJournal) {
            await reverseJournalTx(conn, priorJournal.id, req.user!.sub);
          }
          // Phase 12E: reverse the COGS journal too - independent of the
          // revenue journal above, no replacement posted, same "reverse
          // only, never repost" rule extended to this second journal.
          const priorCogsJournal = await getJournalBySource("tax_invoice_cogs", id);
          if (priorCogsJournal) {
            await reverseJournalTx(conn, priorCogsJournal.id, req.user!.sub);
          }
          // Phase 12: cancelling reverses stock exactly like it reverses
          // the journal just above - no replacement stock transaction is
          // posted for a cancelled invoice, same "reverse only, never
          // repost" rule.
          await reverseStockForSourceTx(conn, "tax_invoice", id, req.user!.sub);
        }

        await conn.query("UPDATE documents SET status = ? WHERE id = ?", [status, id]);
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        if (err instanceof AccountingError || err instanceof InventoryError || err instanceof InsufficientStockError) {
          return res.status(err.status).json({ message: `${title} could not be cancelled: ${err.message}` });
        }
        throw err;
      } finally {
        conn.release();
      }

      const updated = await findById(id);
      res.json({ document: updated });
    })
  );

  router.delete(
    "/:id",
    requireModuleAccess(MODULE, "delete"),
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      // Transactional (unlike before) so a Tax Invoice's journal reversal
      // and the document delete either both happen or neither does - the
      // existing "only draft can be deleted" business rule is unchanged
      // for every doc type, just now evaluated inside that transaction.
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [existingRows] = await conn.query<any[]>(
          "SELECT * FROM documents WHERE id = ? AND doc_type = ? FOR UPDATE",
          [id, docType]
        );
        const existing = existingRows[0] as DocumentRecord | undefined;
        if (!existing) {
          await conn.rollback();
          return res.status(404).json({ message: `${title} not found` });
        }
        if (existing.status !== "draft") {
          await conn.rollback();
          return res.status(400).json({ message: `Only draft ${title.toLowerCase()}s can be deleted` });
        }

        if (docType === "tax_invoice") {
          const priorJournal = await getJournalBySource("tax_invoice", id);
          if (priorJournal) {
            await reverseJournalTx(conn, priorJournal.id, req.user!.sub);
          }
          // Phase 12E: a "draft" Tax Invoice already has real COGS effect
          // too (same reasoning as the journal above - it posts at
          // creation regardless of status) - reverse it here as well.
          const priorCogsJournal = await getJournalBySource("tax_invoice_cogs", id);
          if (priorCogsJournal) {
            await reverseJournalTx(conn, priorCogsJournal.id, req.user!.sub);
          }
          // Phase 12: a "draft" Tax Invoice already has real stock effect
          // (stock posts unconditionally at creation, same timing as the
          // journal - see the POST handler above) - so deleting one must
          // reverse that stock too, not just its journal, or the deleted
          // invoice would leave a permanently-understated on-hand quantity
          // behind with no document left to explain it.
          await reverseStockForSourceTx(conn, "tax_invoice", id, req.user!.sub);
        }

        await conn.query("DELETE FROM documents WHERE id = ?", [id]);
        await conn.commit();
        res.json({ message: `${title} deleted` });
      } catch (err) {
        await conn.rollback();
        if (err instanceof AccountingError || err instanceof InventoryError || err instanceof InsufficientStockError) {
          return res.status(err.status).json({ message: `${title} could not be deleted: ${err.message}` });
        }
        throw err;
      } finally {
        conn.release();
      }
    })
  );

  router.get(
    "/:id/pdf",
    requireModuleAccess(MODULE, "view"),
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const doc = await findById(id);
      if (!doc) return res.status(404).json({ message: `${title} not found` });

      const items = await findItemsForDocument(id);
      const [companyRows] = await pool.query<any[]>("SELECT * FROM companies WHERE id = ?", [doc.company_id]);
      const [customerRows] = await pool.query<any[]>("SELECT * FROM customers WHERE id = ?", [doc.customer_id]);
      const company = companyRows[0] as Company;
      const customer = customerRows[0] as Customer;

      streamDocumentPdf(
        res,
        title,
        doc,
        items.map((i) => ({
          ...i,
          qty: Number(i.qty),
          rate: Number(i.rate),
          discount_percent: Number(i.discount_percent),
          tax_rate: Number(i.tax_rate),
          line_total: Number(i.line_total),
        })),
        customer,
        company
      );
    })
  );

  return router;
}
