import { pool } from "../config/db";
import { computeLine } from "../utils/totals";
import { getGstSummary, getProfitAndLoss } from "./accounting";

// Phase 11B: GST Returns (GSTR-1 / GSTR-3B preparation).
//
// Deliberately its own service file, separate from accounting.ts, because
// this is a HYBRID data source by design (per Phase 11B's own audit):
// aggregate liability figures are ledger-derived (reusing getGstSummary/
// getProfitAndLoss exactly as-is, unmodified), while invoice/line-level
// detail (invoice numbers, customer GSTIN, per-line HSN) is inherently a
// source-document fact the ledger has no concept of - journals only know
// account-level debit/credit sums, never "invoice X, line Y, HSN Z".
// accounting.ts stays a pure ledger reader; this file is where the two
// data sources are deliberately combined.
//
// This module is an internal preparation/reporting tool only - there is no
// GST portal filing/submission integration anywhere in this codebase, and
// none is added here.

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface Gstr1InvoiceRow {
  documentId: number;
  docNumber: string;
  issueDate: string;
  status: string;
  customerName: string;
  customerGstin: string | null;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  taxTotal: number;
  grandTotal: number;
}

export interface Gstr1HsnRow {
  hsnCode: string;
  taxRate: number;
  qty: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  taxTotal: number;
}

export interface Gstr1Result {
  from: string;
  to: string;
  b2b: {
    invoices: Gstr1InvoiceRow[];
    totalTaxableValue: number;
    totalCgst: number;
    totalSgst: number;
    totalIgst: number;
  };
  /** B2C(Others) is conventionally reported state-wise in a real GSTR-1,
   * but customers here have no reliable state_code (only a free-text
   * state field, per Phase 11's audit) - rather than fabricate a
   * possibly-wrong state grouping, every B2C invoice is combined into one
   * honest total. */
  b2c: {
    invoiceCount: number;
    totalTaxableValue: number;
    totalCgst: number;
    totalSgst: number;
    totalIgst: number;
  };
  hsnSummary: Gstr1HsnRow[];
  /** Excluded from every total above; listed separately so the invoice
   * number sequence stays visibly complete, per GST filing convention. */
  cancelledInvoices: Gstr1InvoiceRow[];
  /** Draft-status invoices ARE included in the totals above (a "draft"
   * status in this app does not mean "unposted" - editing a Tax Invoice
   * posts its ledger journal regardless of what status the document is
   * left in, confirmed during Phase 11A's own testing), but their count is
   * surfaced separately so drafts stay visually distinguishable, per your
   * requirement, without duplicating them into a second list. Each row's
   * own `status` field also carries this through into the invoice tables. */
  draftCount: number;
  unsupported: string[];
}

const UNSUPPORTED_GSTR1_SECTIONS = [
  "Credit/Debit Notes (feature does not exist in this application)",
  "Exports/SEZ supplies (no export or SEZ classification is stored)",
  "Exempt/Nil-rated/Non-GST supplies (only a generic 0% tax rate exists, not a distinct classification)",
  "B2C state-wise breakup (customers have no reliable state code; shown as one combined total instead)",
];

/**
 * GSTR-1 preparation data - entirely source-document-derived (documents +
 * document_items), never the ledger. An invoice's own already-computed
 * cgst_total/sgst_total/igst_total/subtotal are used directly (never
 * recomputed for the invoice-level total), matching Phase 4's own
 * computeGstSplit output exactly. Per-line taxable value/tax (needed only
 * for the HSN summary, since document_items itself has no stored
 * taxable_amount column - unlike purchase_bill_items) is recomputed via
 * the same computeLine() used at posting time - deterministic, since
 * qty/rate/discount_percent/tax_rate never change after an invoice is
 * saved (an edit reverses+reposts a fresh journal, it doesn't mutate a
 * line in place).
 *
 * Cancelled invoices are excluded from every total but returned separately
 * for invoice-number-sequence visibility (GST filing convention - a
 * cancelled invoice number must still be accounted for, not hidden).
 * Draft-status invoices ARE included in the totals (see draftCount's own
 * doc comment for why), with their status carried through per-row.
 */
export async function getGstr1(companyId: number, from: string, to: string): Promise<Gstr1Result> {
  const [rows] = await pool.query<any[]>(
    `SELECT d.id, d.doc_number, d.issue_date, d.status,
            d.subtotal, d.cgst_total, d.sgst_total, d.igst_total, d.tax_total, d.grand_total,
            c.name as customer_name, c.gstin as customer_gstin
     FROM documents d
     JOIN customers c ON c.id = d.customer_id
     WHERE d.doc_type = 'tax_invoice' AND d.company_id = ? AND d.issue_date BETWEEN ? AND ?
     ORDER BY d.issue_date ASC, d.doc_number ASC`,
    [companyId, from, to]
  );

  const toRow = (r: any): Gstr1InvoiceRow => ({
    documentId: r.id,
    docNumber: r.doc_number,
    issueDate: r.issue_date,
    status: r.status,
    customerName: r.customer_name,
    customerGstin: r.customer_gstin,
    taxableValue: Number(r.subtotal),
    cgst: Number(r.cgst_total),
    sgst: Number(r.sgst_total),
    igst: Number(r.igst_total),
    taxTotal: Number(r.tax_total),
    grandTotal: Number(r.grand_total),
  });

  const cancelledInvoices = rows.filter((r) => r.status === "cancelled").map(toRow);
  const activeRows = rows.filter((r) => r.status !== "cancelled");
  const draftCount = activeRows.filter((r) => r.status === "draft").length;

  const b2bInvoices = activeRows.filter((r) => r.customer_gstin && String(r.customer_gstin).trim() !== "").map(toRow);
  const b2cRows = activeRows.filter((r) => !r.customer_gstin || String(r.customer_gstin).trim() === "");

  const b2bTotals = {
    totalTaxableValue: round2(b2bInvoices.reduce((s, r) => s + r.taxableValue, 0)),
    totalCgst: round2(b2bInvoices.reduce((s, r) => s + r.cgst, 0)),
    totalSgst: round2(b2bInvoices.reduce((s, r) => s + r.sgst, 0)),
    totalIgst: round2(b2bInvoices.reduce((s, r) => s + r.igst, 0)),
  };
  const b2cTotals = {
    invoiceCount: b2cRows.length,
    totalTaxableValue: round2(b2cRows.reduce((s, r) => s + Number(r.subtotal), 0)),
    totalCgst: round2(b2cRows.reduce((s, r) => s + Number(r.cgst_total), 0)),
    totalSgst: round2(b2cRows.reduce((s, r) => s + Number(r.sgst_total), 0)),
    totalIgst: round2(b2cRows.reduce((s, r) => s + Number(r.igst_total), 0)),
  };

  // HSN summary - per-line, recomputed via computeLine(), for every
  // active (non-cancelled) invoice's items in range.
  const activeIds = activeRows.map((r) => r.id);
  const hsnMap = new Map<string, Gstr1HsnRow>();
  if (activeIds.length) {
    const [itemRows] = await pool.query<any[]>(
      `SELECT hsn_code, qty, rate, discount_percent, tax_rate
       FROM document_items
       WHERE document_id IN (?)`,
      [activeIds]
    );
    for (const item of itemRows) {
      const hsnCode = item.hsn_code || "(no HSN)";
      const taxRate = Number(item.tax_rate);
      const computed = computeLine({
        qty: Number(item.qty),
        rate: Number(item.rate),
        discount_percent: Number(item.discount_percent),
        tax_rate: taxRate,
      });
      // Note: intra/inter-state (CGST+SGST vs IGST) is determined once per
      // invoice (computeGstSplit runs at the header level, not per line),
      // so a per-HSN CGST/SGST/IGST split cannot be honestly derived here -
      // only the combined tax amount is reported per HSN; cgst/sgst/igst
      // are left at 0 rather than guessed.
      const key = `${hsnCode}|${taxRate}`;
      const existing = hsnMap.get(key) || {
        hsnCode,
        taxRate,
        qty: 0,
        taxableValue: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
        taxTotal: 0,
      };
      existing.qty = round2(existing.qty + Number(item.qty));
      existing.taxableValue = round2(existing.taxableValue + computed.taxableValue);
      existing.taxTotal = round2(existing.taxTotal + computed.taxAmount);
      hsnMap.set(key, existing);
    }
  }

  return {
    from,
    to,
    b2b: { invoices: b2bInvoices, ...b2bTotals },
    b2c: b2cTotals,
    hsnSummary: [...hsnMap.values()].sort((a, b) => a.hsnCode.localeCompare(b.hsnCode)),
    cancelledInvoices,
    draftCount,
    unsupported: UNSUPPORTED_GSTR1_SECTIONS,
  };
}

export interface Gstr3bSection {
  label: string;
  taxableValue: number | null;
  igst: number | null;
  cgst: number | null;
  sgst: number | null;
  notTracked: boolean;
  note?: string;
}

export interface Gstr3bResult {
  from: string;
  to: string;
  outwardSupplies: Gstr3bSection[]; // Table 3.1
  itc: Gstr3bSection[]; // Table 4
  netGstPayable: number;
  netGstRefundable: number;
  unsupported: string[];
}

const UNSUPPORTED_GSTR3B_SECTIONS = [
  "Zero-rated (export/SEZ) outward supplies - no export/SEZ classification exists",
  "Exempt/Nil-rated/Non-GST outward supplies - only a generic 0% tax rate exists, not a distinct classification",
  "Inward supplies liable to reverse charge - no reverse-charge flag exists on Purchase Bills/Expenses",
  "Import of goods/services ITC, ISD credit, and eligible/ineligible ITC split - Input GST is tracked as one combined figure only",
];

/**
 * GSTR-3B preparation data - a reshaping of the existing, unmodified
 * getGstSummary()/getProfitAndLoss() ledger figures into the standard
 * 3.1 (outward supplies) / 4 (ITC) table layout. No new calculation logic
 * - Table 3.1(a)'s taxable value is getProfitAndLoss's own totalIncome
 * (the Sales/Service Revenue/Other Income accounts net exactly the
 * tax-exclusive amount a Tax Invoice credits, confirmed by
 * postTaxInvoiceJournalTx's own posting logic), and 3.1(a)'s
 * CGST/SGST/IGST plus Table 4's combined ITC are getGstSummary's own
 * outputCgst/outputSgst/outputIgst/inputGst, completely unchanged.
 *
 * Rows this system cannot honestly support (zero-rated exports, exempt/
 * nil-rated supplies, inward reverse charge, ITC sub-classification) are
 * still rendered - a real GSTR-3B has named rows for all of them - but
 * marked notTracked: true with an explanatory note, never estimated or
 * defaulted to a guessed figure.
 */
export async function getGstr3b(companyId: number, from: string, to: string): Promise<Gstr3bResult> {
  const summary = await getGstSummary(companyId, from, to);
  const pnl = await getProfitAndLoss(companyId, from, to);

  const outwardSupplies: Gstr3bSection[] = [
    {
      label: "3.1(a) Outward taxable supplies (other than zero rated, nil rated, exempted)",
      taxableValue: pnl.totalIncome,
      igst: summary.outputIgst,
      cgst: summary.outputCgst,
      sgst: summary.outputSgst,
      notTracked: false,
    },
    {
      label: "3.1(b) Outward taxable supplies (zero rated - exports/SEZ)",
      taxableValue: null,
      igst: null,
      cgst: null,
      sgst: null,
      notTracked: true,
      note: "No export/SEZ classification exists in this system",
    },
    {
      label: "3.1(c) Other outward supplies (nil rated, exempted)",
      taxableValue: null,
      igst: null,
      cgst: null,
      sgst: null,
      notTracked: true,
      note: "Only a generic 0% tax rate exists, not a distinct exempt/nil-rated classification",
    },
    {
      label: "3.1(d) Inward supplies liable to reverse charge",
      taxableValue: null,
      igst: null,
      cgst: null,
      sgst: null,
      notTracked: true,
      note: "No reverse-charge flag exists on Purchase Bills/Expenses",
    },
  ];

  const itc: Gstr3bSection[] = [
    {
      label: "4(A)(5) All other ITC",
      taxableValue: null,
      igst: null,
      cgst: null,
      sgst: null,
      notTracked: false,
      note: `Rs. ${summary.inputGst.toFixed(2)} combined - Input GST is tracked as one figure, not split by CGST/SGST/IGST`,
    },
    {
      label: "4(A)(1) Import of goods",
      taxableValue: null,
      igst: null,
      cgst: null,
      sgst: null,
      notTracked: true,
      note: "Not tracked in this system",
    },
    {
      label: "4(A)(2) Import of services",
      taxableValue: null,
      igst: null,
      cgst: null,
      sgst: null,
      notTracked: true,
      note: "Not tracked in this system",
    },
    {
      label: "4(A)(3) Inward supplies liable to reverse charge (ITC)",
      taxableValue: null,
      igst: null,
      cgst: null,
      sgst: null,
      notTracked: true,
      note: "Not tracked in this system",
    },
    {
      label: "4(A)(4) Input Service Distributor credit",
      taxableValue: null,
      igst: null,
      cgst: null,
      sgst: null,
      notTracked: true,
      note: "Not tracked in this system",
    },
    {
      label: "4(B) Ineligible ITC",
      taxableValue: null,
      igst: null,
      cgst: null,
      sgst: null,
      notTracked: true,
      note: "No ITC eligibility classification exists - all Input GST is shown as 4(A)(5) above",
    },
  ];

  return {
    from,
    to,
    outwardSupplies,
    itc,
    netGstPayable: summary.netGst > 0 ? summary.netGst : 0,
    netGstRefundable: summary.netGst < 0 ? -summary.netGst : 0,
    unsupported: UNSUPPORTED_GSTR3B_SECTIONS,
  };
}
