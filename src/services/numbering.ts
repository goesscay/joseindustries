import { pool } from "../config/db";
import { getFinancialYear } from "./financialYear";
import { DocType } from "../types";

// Accounts-module series (expenses/vendor_payments) live in their own tables,
// not the `documents` table, so they're kept out of the ENUM-bound DocType
// and just widen the numbering series here.
export type SeriesType =
  | DocType
  | "expense"
  | "vendor_payment"
  | "purchase_bill"
  | "purchase_order"
  | "credit_note"
  | "debit_note";

const PREFIXES: Record<SeriesType, string> = {
  quotation: "QTN",
  proforma_invoice: "PI",
  delivery_challan: "DC",
  tax_invoice: "INV",
  receipt: "RCT",
  expense: "EXP",
  vendor_payment: "PMT",
  purchase_bill: "PB",
  purchase_order: "PO",
  credit_note: "CN",
  debit_note: "DN",
};

/**
 * Atomically produces the next sequence number for a document type, scoped to
 * one company and its financial year (each company has its own independent
 * invoice series - Jose Enterprises and Jose Industries must never share a
 * counter). Uses the `INSERT ... ON DUPLICATE KEY UPDATE LAST_INSERT_ID(expr)`
 * trick: the row-level lock MySQL takes during the upsert makes concurrent
 * callers serialize on the same counter row, so two requests can never receive
 * the same number - the failure mode that caused duplicate numbers in Excel.
 *
 * Both statements must run on the same connection (LAST_INSERT_ID() is
 * connection-scoped), so this explicitly checks out a single connection
 * rather than using the shared pool.
 */
export async function getNextDocNumber(docType: SeriesType, companyCode: string, date: Date = new Date()) {
  const financialYear = getFinancialYear(date);
  const conn = await pool.getConnection();

  try {
    await conn.query(
      `INSERT INTO doc_counters (doc_type, company_code, financial_year, last_number)
       VALUES (?, ?, ?, LAST_INSERT_ID(1))
       ON DUPLICATE KEY UPDATE last_number = LAST_INSERT_ID(last_number + 1)`,
      [docType, companyCode, financialYear]
    );
    const [rows] = await conn.query<any[]>("SELECT LAST_INSERT_ID() as seq");
    const seq = Number(rows[0].seq);

    const docNumber = formatDocNumber(docType, companyCode, financialYear, seq);
    return { docNumber, financialYear, seq };
  } finally {
    conn.release();
  }
}

/**
 * Tax Invoice and Quotation each follow the company's own required
 * numbering convention instead of the generic
 * "{PREFIX}/{companyCode}/{financialYear}/{seq}" shape every other series
 * (proforma, delivery challan, receipt, expense, vendor payment, purchase
 * bill/order) still uses:
 *   - tax_invoice: "{companyCode}-{seq}/{financialYear}", 3-digit seq
 *     (e.g. "JI-001/26-27", "JE-001/26-27")
 *   - quotation:   "{companyCode}-QT-{seq}/{financialYear}", 2-digit seq
 *     (e.g. "JI-QT-01/26-27", "JE-QT-01/26-27")
 */
function formatDocNumber(docType: SeriesType, companyCode: string, financialYear: string, seq: number): string {
  if (docType === "tax_invoice") {
    return `${companyCode}-${String(seq).padStart(3, "0")}/${financialYear}`;
  }
  if (docType === "quotation") {
    return `${companyCode}-QT-${String(seq).padStart(2, "0")}/${financialYear}`;
  }
  return `${PREFIXES[docType]}/${companyCode}/${financialYear}/${String(seq).padStart(4, "0")}`;
}
