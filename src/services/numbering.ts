import { pool } from "../config/db";
import { getFinancialYear } from "./financialYear";
import { DocType } from "../types";

const PREFIXES: Record<DocType, string> = {
  quotation: "QTN",
  proforma_invoice: "PI",
  delivery_challan: "DC",
  tax_invoice: "INV",
  receipt: "RCT",
};

/**
 * Atomically produces the next sequence number for a document type within its
 * financial year, using the `INSERT ... ON DUPLICATE KEY UPDATE LAST_INSERT_ID(expr)`
 * trick: the row-level lock MySQL takes during the upsert makes concurrent
 * callers serialize on the same counter row, so two requests can never receive
 * the same number - the failure mode that caused duplicate numbers in Excel.
 *
 * Both statements must run on the same connection (LAST_INSERT_ID() is
 * connection-scoped), so this explicitly checks out a single connection
 * rather than using the shared pool.
 */
export async function getNextDocNumber(docType: DocType, date: Date = new Date()) {
  const financialYear = getFinancialYear(date);
  const conn = await pool.getConnection();

  try {
    await conn.query(
      `INSERT INTO doc_counters (doc_type, financial_year, last_number)
       VALUES (?, ?, LAST_INSERT_ID(1))
       ON DUPLICATE KEY UPDATE last_number = LAST_INSERT_ID(last_number + 1)`,
      [docType, financialYear]
    );
    const [rows] = await conn.query<any[]>("SELECT LAST_INSERT_ID() as seq");
    const seq = Number(rows[0].seq);

    const docNumber = `${PREFIXES[docType]}/${financialYear}/${String(seq).padStart(4, "0")}`;
    return { docNumber, financialYear, seq };
  } finally {
    conn.release();
  }
}
