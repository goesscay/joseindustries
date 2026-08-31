import { pool } from "../config/db";
import { Customer, Vendor } from "../types";

export interface PartyLedgerEntry {
  entry_date: string;
  doc_number: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface PartyLedgerReport {
  party: Customer | Vendor;
  partyType: "customer" | "vendor";
  openingBalance: number;
  entries: PartyLedgerEntry[];
  closingBalance: number;
}

export class PartyLedgerError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Statement for one customer (Tax Invoices raise what they owe us,
 * Receipts reduce it) or one vendor (Expenses raise what we owe them,
 * Vendor Payments reduce it). Extracted from the original inline
 * `/reports/party-ledger` handler so both the JSON route and the PDF
 * route (see services/pdf/partyLedgerPdf.ts) compute the exact same
 * figures from one place - never two copies of this logic drifting
 * apart.
 */
export async function getPartyLedgerReport(
  partyType: "customer" | "vendor",
  partyId: number,
  from: string,
  to: string
): Promise<PartyLedgerReport> {
  if (partyType === "customer") {
    const [partyRows] = await pool.query<any[]>("SELECT * FROM customers WHERE id = ?", [partyId]);
    if (!partyRows[0]) throw new PartyLedgerError(404, "Customer not found");

    const [openingDebit] = await pool.query<any[]>(
      `SELECT COALESCE(SUM(grand_total), 0) as total FROM documents
       WHERE doc_type = 'tax_invoice' AND customer_id = ? AND status != 'cancelled' AND issue_date < ?`,
      [partyId, from]
    );
    const [openingCredit] = await pool.query<any[]>(
      `SELECT COALESCE(SUM(amount), 0) as total FROM receipts WHERE customer_id = ? AND received_date < ?`,
      [partyId, from]
    );
    const openingBalance = Number(openingDebit[0].total) - Number(openingCredit[0].total);

    const [invoices] = await pool.query<any[]>(
      `SELECT id, doc_number, issue_date as entry_date, grand_total as amount, created_at
       FROM documents
       WHERE doc_type = 'tax_invoice' AND customer_id = ? AND status != 'cancelled' AND issue_date BETWEEN ? AND ?`,
      [partyId, from, to]
    );
    const [receipts] = await pool.query<any[]>(
      `SELECT id, receipt_no as doc_number, received_date as entry_date, amount, created_at
       FROM receipts WHERE customer_id = ? AND received_date BETWEEN ? AND ?`,
      [partyId, from, to]
    );

    const combined = [
      ...invoices.map((i) => ({
        entry_date: i.entry_date,
        created_at: i.created_at,
        doc_number: i.doc_number,
        description: "Tax Invoice",
        debit: Number(i.amount),
        credit: 0,
      })),
      ...receipts.map((r) => ({
        entry_date: r.entry_date,
        created_at: r.created_at,
        doc_number: r.doc_number,
        description: "Receipt",
        debit: 0,
        credit: Number(r.amount),
      })),
    ];
    combined.sort((a, b) => {
      const d = new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime();
      if (d !== 0) return d;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

    let running = openingBalance;
    const entries: PartyLedgerEntry[] = combined.map((e) => {
      running += e.debit - e.credit;
      return { entry_date: e.entry_date, doc_number: e.doc_number, description: e.description, debit: e.debit, credit: e.credit, balance: running };
    });

    return { party: partyRows[0], partyType, openingBalance, entries, closingBalance: running };
  }

  const [partyRows] = await pool.query<any[]>("SELECT * FROM vendors WHERE id = ?", [partyId]);
  if (!partyRows[0]) throw new PartyLedgerError(404, "Vendor not found");

  const [openingDebit] = await pool.query<any[]>(
    `SELECT COALESCE(SUM(total_amount), 0) as total FROM expenses WHERE vendor_id = ? AND expense_date < ?`,
    [partyId, from]
  );
  const [openingCredit] = await pool.query<any[]>(
    `SELECT COALESCE(SUM(amount), 0) as total FROM vendor_payments WHERE vendor_id = ? AND paid_date < ?`,
    [partyId, from]
  );
  const openingBalance = Number(openingDebit[0].total) - Number(openingCredit[0].total);

  const [expenses] = await pool.query<any[]>(
    `SELECT id, expense_no as doc_number, expense_date as entry_date, total_amount as amount, created_at
     FROM expenses WHERE vendor_id = ? AND expense_date BETWEEN ? AND ?`,
    [partyId, from, to]
  );
  const [payments] = await pool.query<any[]>(
    `SELECT id, payment_no as doc_number, paid_date as entry_date, amount, created_at
     FROM vendor_payments WHERE vendor_id = ? AND paid_date BETWEEN ? AND ?`,
    [partyId, from, to]
  );

  const combined = [
    ...expenses.map((e) => ({
      entry_date: e.entry_date,
      created_at: e.created_at,
      doc_number: e.doc_number,
      description: "Expense",
      debit: Number(e.amount),
      credit: 0,
    })),
    ...payments.map((p) => ({
      entry_date: p.entry_date,
      created_at: p.created_at,
      doc_number: p.doc_number,
      description: "Vendor Payment",
      debit: 0,
      credit: Number(p.amount),
    })),
  ];
  combined.sort((a, b) => {
    const d = new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime();
    if (d !== 0) return d;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });

  let running = openingBalance;
  const entries: PartyLedgerEntry[] = combined.map((e) => {
    running += e.debit - e.credit;
    return { entry_date: e.entry_date, doc_number: e.doc_number, description: e.description, debit: e.debit, credit: e.credit, balance: running };
  });

  return { party: partyRows[0], partyType, openingBalance, entries, closingBalance: running };
}
