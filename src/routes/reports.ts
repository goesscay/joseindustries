import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { getPartyLedgerReport, PartyLedgerError } from "../services/partyLedger";
import { streamPartyLedgerPdf } from "../services/pdf/partyLedgerPdf";

export const reportsRouter = Router();
// Every route here is a read - one router-level gate covers all of them.
reportsRouter.use(requireAuth, requireModuleAccess("reports.reports", "view"));

function dateRange(query: any): { from: string; to: string } {
  const to = typeof query.to === "string" && query.to ? query.to : new Date().toISOString().slice(0, 10);
  const from = typeof query.from === "string" && query.from ? query.from : "1900-01-01";
  return { from, to };
}

// ---- Day Book: every money movement (Receipts in, Vendor Payments out,
// Journal Entries either way) across all of a company's accounts, merged
// chronologically. ----
reportsRouter.get(
  "/day-book",
  asyncHandler(async (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const { from, to } = dateRange(req.query);
    if (!companyId) return res.status(400).json({ message: "company_id is required" });

    const [receipts] = await pool.query<any[]>(
      `SELECT r.id, r.received_date as entry_date, r.amount, r.reference_no, r.created_at,
              c.name as party_name, a.name as account_name
       FROM receipts r
       JOIN customers c ON c.id = r.customer_id
       LEFT JOIN accounts a ON a.id = r.account_id
       WHERE r.company_id = ? AND r.received_date BETWEEN ? AND ?`,
      [companyId, from, to]
    );
    const [payments] = await pool.query<any[]>(
      `SELECT p.id, p.paid_date as entry_date, p.amount, p.reference_no, p.created_at,
              v.name as party_name, a.name as account_name
       FROM vendor_payments p
       JOIN vendors v ON v.id = p.vendor_id
       LEFT JOIN accounts a ON a.id = p.account_id
       WHERE p.company_id = ? AND p.paid_date BETWEEN ? AND ?`,
      [companyId, from, to]
    );
    // Phase B: plain Bank & Cash entries and transfers are now journals
    // posted against each account's linked Chart of Accounts node, not rows
    // in the retired journal_entries table - joining accounts on
    // a.chart_account_id = jl.account_id picks up exactly the postings that
    // table used to hold. Opening-balance journals are deliberately
    // excluded (journal_entries never held those either - they were a
    // separate accounts.opening_balance column, invisible to the Day Book).
    const [journalRows] = await pool.query<any[]>(
      `SELECT j.id, j.journal_date as entry_date, j.description as particulars, j.created_at,
              a.name as account_name, jl.debit, jl.credit
       FROM journal_lines jl
       JOIN journals j ON j.id = jl.journal_id
       JOIN accounts a ON a.chart_account_id = jl.account_id
       WHERE a.company_id = ? AND j.journal_date BETWEEN ? AND ?
         AND j.source_type IN ('bank_cash_entry', 'account_transfer')
         AND j.status = 'posted'`,
      [companyId, from, to]
    );

    const entries = [
      ...receipts.map((r) => ({
        entry_date: r.entry_date,
        created_at: r.created_at,
        source_type: "receipt" as const,
        account_name: r.account_name || "-",
        direction: "in" as const,
        amount: Number(r.amount),
        particulars: `Receipt from ${r.party_name}${r.reference_no ? ` (${r.reference_no})` : ""}`,
      })),
      ...payments.map((p) => ({
        entry_date: p.entry_date,
        created_at: p.created_at,
        source_type: "vendor_payment" as const,
        account_name: p.account_name || "-",
        direction: "out" as const,
        amount: Number(p.amount),
        particulars: `Payment to ${p.party_name}${p.reference_no ? ` (${p.reference_no})` : ""}`,
      })),
      ...journalRows.map((j) => {
        const debit = Number(j.debit);
        const isIn = debit > 0;
        return {
          entry_date: j.entry_date,
          created_at: j.created_at,
          source_type: "journal_entry" as const,
          account_name: j.account_name,
          direction: (isIn ? "in" : "out") as "in" | "out",
          amount: isIn ? debit : Number(j.credit),
          particulars: j.particulars || "-",
        };
      }),
    ];

    entries.sort((a, b) => {
      const d = new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime();
      if (d !== 0) return d;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

    const totalIn = entries.filter((e) => e.direction === "in").reduce((s, e) => s + e.amount, 0);
    const totalOut = entries.filter((e) => e.direction === "out").reduce((s, e) => s + e.amount, 0);

    res.json({
      entries: entries.map(({ created_at, ...rest }) => rest),
      totalIn,
      totalOut,
      net: totalIn - totalOut,
    });
  })
);

// ---- Party Ledger: statement for one customer (Tax Invoices raise what
// they owe us, Receipts reduce it) or one vendor (Expenses raise what we
// owe them, Vendor Payments reduce it). Both this JSON route and the /pdf
// route below share the exact same computation via getPartyLedgerReport -
// never two copies of this logic. ----
reportsRouter.get(
  "/party-ledger",
  asyncHandler(async (req, res) => {
    const partyType = req.query.type;
    const partyId = Number(req.query.id);
    const { from, to } = dateRange(req.query);
    if (partyType !== "customer" && partyType !== "vendor") {
      return res.status(400).json({ message: "type must be 'customer' or 'vendor'" });
    }
    if (!partyId) return res.status(400).json({ message: "id is required" });

    try {
      const { party, openingBalance, entries, closingBalance } = await getPartyLedgerReport(partyType, partyId, from, to);
      res.json({ party, openingBalance, entries, closingBalance });
    } catch (err) {
      if (err instanceof PartyLedgerError) {
        return res.status(err.status).json({ message: err.message });
      }
      throw err;
    }
  })
);

// ---- Party Ledger PDF: same figures as the JSON route above, streamed as
// a downloadable/printable statement instead - mirrors the existing
// "open the PDF in a new tab" convention used for Tax Invoices/Quotations/
// Receipts elsewhere in this app (the browser's own PDF viewer covers both
// "Print" and "Save as PDF" from there). ----
reportsRouter.get(
  "/party-ledger/pdf",
  asyncHandler(async (req, res) => {
    const partyType = req.query.type;
    const partyId = Number(req.query.id);
    const { from, to } = dateRange(req.query);
    if (partyType !== "customer" && partyType !== "vendor") {
      return res.status(400).json({ message: "type must be 'customer' or 'vendor'" });
    }
    if (!partyId) return res.status(400).json({ message: "id is required" });

    try {
      const report = await getPartyLedgerReport(partyType, partyId, from, to);
      streamPartyLedgerPdf(res, report, from, to);
    } catch (err) {
      if (err instanceof PartyLedgerError) {
        return res.status(err.status).json({ message: err.message });
      }
      throw err;
    }
  })
);

// ---- GST Summary: Output GST (from Tax Invoices) vs Input GST (from
// Expenses) -> net payable. Input GST has no CGST/SGST/IGST split in the
// simple Expenses model, so it's shown as one figure. ----
reportsRouter.get(
  "/gst-summary",
  asyncHandler(async (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const { from, to } = dateRange(req.query);
    const companyClause = companyId ? "AND company_id = ?" : "";
    const companyParam = companyId ? [companyId] : [];

    const [outputRows] = await pool.query<any[]>(
      `SELECT COALESCE(SUM(cgst_total), 0) as cgst, COALESCE(SUM(sgst_total), 0) as sgst,
              COALESCE(SUM(igst_total), 0) as igst, COALESCE(SUM(tax_total), 0) as total
       FROM documents
       WHERE doc_type = 'tax_invoice' AND status != 'cancelled' ${companyClause} AND issue_date BETWEEN ? AND ?`,
      [...companyParam, from, to]
    );
    const [inputRows] = await pool.query<any[]>(
      `SELECT COALESCE(SUM(tax_amount), 0) as total FROM expenses
       WHERE 1=1 ${companyId ? "AND company_id = ?" : ""} AND expense_date BETWEEN ? AND ?`,
      [...companyParam, from, to]
    );

    const outputCgst = Number(outputRows[0].cgst);
    const outputSgst = Number(outputRows[0].sgst);
    const outputIgst = Number(outputRows[0].igst);
    const outputTotal = Number(outputRows[0].total);
    const inputGst = Number(inputRows[0].total);

    res.json({
      outputCgst,
      outputSgst,
      outputIgst,
      outputTotal,
      inputGst,
      netPayable: outputTotal - inputGst,
    });
  })
);

// ---- Outstanding: unpaid Tax Invoices (Receivables) and unpaid Expenses
// (Payables), with totals. ----
reportsRouter.get(
  "/outstanding",
  asyncHandler(async (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const companyClause = companyId ? "AND d.company_id = ?" : "";
    const companyParam = companyId ? [companyId] : [];

    const [receivables] = await pool.query<any[]>(
      `SELECT d.id, d.doc_number, d.issue_date, d.grand_total,
              COALESCE((SELECT SUM(r.amount) FROM receipts r WHERE r.tax_invoice_id = d.id), 0) as paid_amount,
              c.name as customer_name
       FROM documents d
       JOIN customers c ON c.id = d.customer_id
       WHERE d.doc_type = 'tax_invoice' AND d.status != 'cancelled' ${companyClause}
       HAVING (grand_total - paid_amount) > 0.01
       ORDER BY d.issue_date ASC`,
      companyParam
    );

    const payableCompanyClause = companyId ? "AND e.company_id = ?" : "";
    const [payables] = await pool.query<any[]>(
      `SELECT e.id, e.expense_no, e.expense_date, e.total_amount,
              COALESCE((SELECT SUM(p.amount) FROM vendor_payments p WHERE p.expense_id = e.id), 0) as paid_amount,
              COALESCE(v.name, 'Unspecified') as vendor_name
       FROM expenses e
       LEFT JOIN vendors v ON v.id = e.vendor_id
       WHERE 1=1 ${payableCompanyClause}
       HAVING (total_amount - paid_amount) > 0.01
       ORDER BY e.expense_date ASC`,
      companyParam
    );

    const receivableRows = receivables.map((r) => ({
      id: r.id,
      doc_number: r.doc_number,
      party_name: r.customer_name,
      date: r.issue_date,
      total: Number(r.grand_total),
      paid: Number(r.paid_amount),
      balance: Number(r.grand_total) - Number(r.paid_amount),
    }));
    const payableRows = payables.map((p) => ({
      id: p.id,
      doc_number: p.expense_no,
      party_name: p.vendor_name,
      date: p.expense_date,
      total: Number(p.total_amount),
      paid: Number(p.paid_amount),
      balance: Number(p.total_amount) - Number(p.paid_amount),
    }));

    res.json({
      receivables: receivableRows,
      totalReceivable: receivableRows.reduce((s, r) => s + r.balance, 0),
      payables: payableRows,
      totalPayable: payableRows.reduce((s, r) => s + r.balance, 0),
    });
  })
);
