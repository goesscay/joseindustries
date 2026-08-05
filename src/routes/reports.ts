import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../utils/asyncHandler";

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

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
    const [journalRows] = await pool.query<any[]>(
      `SELECT je.id, je.entry_date, je.direction, je.amount, je.particulars, je.created_at, a.name as account_name
       FROM journal_entries je
       JOIN accounts a ON a.id = je.account_id
       WHERE a.company_id = ? AND je.entry_date BETWEEN ? AND ?`,
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
      ...journalRows.map((j) => ({
        entry_date: j.entry_date,
        created_at: j.created_at,
        source_type: "journal_entry" as const,
        account_name: j.account_name,
        direction: j.direction as "in" | "out",
        amount: Number(j.amount),
        particulars: j.particulars,
      })),
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
// owe them, Vendor Payments reduce it). ----
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

    if (partyType === "customer") {
      const [partyRows] = await pool.query<any[]>("SELECT * FROM customers WHERE id = ?", [partyId]);
      if (!partyRows[0]) return res.status(404).json({ message: "Customer not found" });

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
      const entries = combined.map((e) => {
        running += e.debit - e.credit;
        return { ...e, created_at: undefined, balance: running };
      });

      return res.json({ party: partyRows[0], openingBalance, entries, closingBalance: running });
    }

    const [partyRows] = await pool.query<any[]>("SELECT * FROM vendors WHERE id = ?", [partyId]);
    if (!partyRows[0]) return res.status(404).json({ message: "Vendor not found" });

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
    const entries = combined.map((e) => {
      running += e.debit - e.credit;
      return { ...e, created_at: undefined, balance: running };
    });

    res.json({ party: partyRows[0], openingBalance, entries, closingBalance: running });
  })
);

// ---- Profit & Loss: Sales (Tax Invoices, excluding GST - it isn't income)
// minus Expenses (excluding input GST), by category. ----
reportsRouter.get(
  "/profit-loss",
  asyncHandler(async (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const { from, to } = dateRange(req.query);
    const companyClause = companyId ? "AND company_id = ?" : "";
    const companyParam = companyId ? [companyId] : [];

    const [revenueRows] = await pool.query<any[]>(
      `SELECT COALESCE(SUM(grand_total - tax_total), 0) as revenue
       FROM documents
       WHERE doc_type = 'tax_invoice' AND status != 'cancelled' ${companyClause} AND issue_date BETWEEN ? AND ?`,
      [...companyParam, from, to]
    );

    const [expenseRows] = await pool.query<any[]>(
      `SELECT COALESCE(cat.name, 'Uncategorized') as category, COALESCE(SUM(e.amount), 0) as total
       FROM expenses e
       LEFT JOIN expense_categories cat ON cat.id = e.category_id
       WHERE 1=1 ${companyId ? "AND e.company_id = ?" : ""} AND e.expense_date BETWEEN ? AND ?
       GROUP BY COALESCE(cat.name, 'Uncategorized')
       ORDER BY total DESC`,
      [...companyParam, from, to]
    );

    const revenue = Number(revenueRows[0].revenue);
    const expensesByCategory = expenseRows.map((r) => ({ category: r.category, amount: Number(r.total) }));
    const totalExpenses = expensesByCategory.reduce((s, r) => s + r.amount, 0);

    res.json({ revenue, expensesByCategory, totalExpenses, netProfit: revenue - totalExpenses });
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
