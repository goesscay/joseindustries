import { pool } from "../config/db";
import { Customer, GstType, Vendor } from "../types";

export type GstBookFilter = GstType | "all";

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
  gstFilter: GstBookFilter;
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
  to: string,
  gstFilter: GstBookFilter = "all"
): Promise<PartyLedgerReport> {
  // "With GST" / "Without GST" transactions are separate books; "all"
  // (the default) is the combined statement.
  const g = gstFilter === "all" ? "" : " AND gst_type = ?";
  const gp: unknown[] = gstFilter === "all" ? [] : [gstFilter];
  if (partyType === "customer") {
    const [partyRows] = await pool.query<any[]>("SELECT * FROM customers WHERE id = ?", [partyId]);
    if (!partyRows[0]) throw new PartyLedgerError(404, "Customer not found");

    const [openingDebit] = await pool.query<any[]>(
      `SELECT COALESCE(SUM(grand_total), 0) as total FROM documents
       WHERE doc_type = 'tax_invoice' AND customer_id = ? AND status != 'cancelled' AND issue_date < ?${g}`,
      [partyId, from, ...gp]
    );
    const [openingCredit] = await pool.query<any[]>(
      `SELECT COALESCE(SUM(amount), 0) as total FROM receipts WHERE customer_id = ? AND received_date < ?${g}`,
      [partyId, from, ...gp]
    );
    // Phase D: a (non-cancelled) Credit Note reduces what a customer owes
    // exactly like a Receipt does - both are credits against the invoices'
    // debits - so the opening balance and the statement below must include
    // credit_notes or a customer's Party Ledger balance would silently
    // overstate what they actually still owe once any credit note exists.
    const [openingCreditNotes] = await pool.query<any[]>(
      `SELECT COALESCE(SUM(grand_total), 0) as total FROM credit_notes
       WHERE customer_id = ? AND status != 'cancelled' AND issue_date < ?${g}`,
      [partyId, from, ...gp]
    );
    const openingBalance =
      Number(openingDebit[0].total) - Number(openingCredit[0].total) - Number(openingCreditNotes[0].total);

    const [invoices] = await pool.query<any[]>(
      `SELECT id, doc_number, issue_date as entry_date, grand_total as amount, created_at
       FROM documents
       WHERE doc_type = 'tax_invoice' AND customer_id = ? AND status != 'cancelled' AND issue_date BETWEEN ? AND ?${g}`,
      [partyId, from, to, ...gp]
    );
    const [receipts] = await pool.query<any[]>(
      `SELECT id, receipt_no as doc_number, received_date as entry_date, amount, created_at
       FROM receipts WHERE customer_id = ? AND received_date BETWEEN ? AND ?${g}`,
      [partyId, from, to, ...gp]
    );
    const [creditNotes] = await pool.query<any[]>(
      `SELECT id, credit_note_no as doc_number, issue_date as entry_date, grand_total as amount, created_at
       FROM credit_notes WHERE customer_id = ? AND status != 'cancelled' AND issue_date BETWEEN ? AND ?${g}`,
      [partyId, from, to, ...gp]
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
      ...creditNotes.map((cn) => ({
        entry_date: cn.entry_date,
        created_at: cn.created_at,
        doc_number: cn.doc_number,
        description: "Credit Note",
        debit: 0,
        credit: Number(cn.amount),
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

    return { party: partyRows[0], partyType, gstFilter, openingBalance, entries, closingBalance: running };
  }

  const [partyRows] = await pool.query<any[]>("SELECT * FROM vendors WHERE id = ?", [partyId]);
  if (!partyRows[0]) throw new PartyLedgerError(404, "Vendor not found");

  const [openingExpenses] = await pool.query<any[]>(
    `SELECT COALESCE(SUM(total_amount), 0) as total FROM expenses WHERE vendor_id = ? AND expense_date < ?${g}`,
    [partyId, from, ...gp]
  );
  const [openingPayments] = await pool.query<any[]>(
    `SELECT COALESCE(SUM(amount), 0) as total FROM vendor_payments WHERE vendor_id = ? AND paid_date < ?${g}`,
    [partyId, from, ...gp]
  );
  // Purchase Bills are what vendors are actually billed through now, and a
  // Debit Note (a return / price correction on a bill) takes some of it back,
  // so both belong in the statement next to expenses and payments: a bill
  // raises what we owe, a debit note reduces it, exactly like a payment.
  // Cancelled ones carry no ledger effect (their journal is reversed).
  const [openingBills] = await pool.query<any[]>(
    `SELECT COALESCE(SUM(total_amount), 0) as total FROM purchase_bills WHERE vendor_id = ? AND status != 'cancelled' AND bill_date < ?${g}`,
    [partyId, from, ...gp]
  );
  const [openingDebitNotes] = await pool.query<any[]>(
    `SELECT COALESCE(SUM(total_amount), 0) as total FROM debit_notes WHERE vendor_id = ? AND status != 'cancelled' AND issue_date < ?${g}`,
    [partyId, from, ...gp]
  );
  const openingBalance =
    Number(openingExpenses[0].total) + Number(openingBills[0].total) - Number(openingPayments[0].total) - Number(openingDebitNotes[0].total);

  const [expenses] = await pool.query<any[]>(
    `SELECT id, expense_no as doc_number, expense_date as entry_date, total_amount as amount, created_at
     FROM expenses WHERE vendor_id = ? AND expense_date BETWEEN ? AND ?${g}`,
    [partyId, from, to, ...gp]
  );
  const [payments] = await pool.query<any[]>(
    `SELECT id, payment_no as doc_number, paid_date as entry_date, amount, created_at
     FROM vendor_payments WHERE vendor_id = ? AND paid_date BETWEEN ? AND ?${g}`,
    [partyId, from, to, ...gp]
  );
  const [bills] = await pool.query<any[]>(
    `SELECT id, bill_no as doc_number, bill_date as entry_date, total_amount as amount, created_at
     FROM purchase_bills WHERE vendor_id = ? AND status != 'cancelled' AND bill_date BETWEEN ? AND ?${g}`,
    [partyId, from, to, ...gp]
  );
  const [debitNotes] = await pool.query<any[]>(
    `SELECT id, debit_note_no as doc_number, issue_date as entry_date, total_amount as amount, created_at
     FROM debit_notes WHERE vendor_id = ? AND status != 'cancelled' AND issue_date BETWEEN ? AND ?${g}`,
    [partyId, from, to, ...gp]
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
    ...bills.map((b) => ({
      entry_date: b.entry_date,
      created_at: b.created_at,
      doc_number: b.doc_number,
      description: "Purchase Bill",
      debit: Number(b.amount),
      credit: 0,
    })),
    ...debitNotes.map((d) => ({
      entry_date: d.entry_date,
      created_at: d.created_at,
      doc_number: d.doc_number,
      description: "Debit Note",
      debit: 0,
      credit: Number(d.amount),
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

  return { party: partyRows[0], partyType, gstFilter, openingBalance, entries, closingBalance: running };
}
