import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { BALANCE_EXPR } from "./accounts";

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth, requireModuleAccess("dashboard", "view"));

const DOC_TYPE_LABELS: Record<string, string> = {
  quotation: "Quotation",
  proforma_invoice: "Proforma Invoice",
  delivery_challan: "Delivery Challan",
  tax_invoice: "Tax Invoice",
};

dashboardRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const companyClause = companyId ? "AND company_id = ?" : "";
    const companyParam = companyId ? [companyId] : [];
    const monthStart = new Date();
    monthStart.setDate(1);
    const monthStartStr = monthStart.toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    // Cash + Bank balance across all (or one company's) accounts - shares
    // accounts.ts's own BALANCE_EXPR (Phase B) rather than a second
    // hand-rolled copy of the same formula.
    const accountCompanyClause = companyId ? "WHERE a.company_id = ?" : "";
    const [balanceRows] = await pool.query<any[]>(
      `SELECT COALESCE(SUM(${BALANCE_EXPR}), 0) as balance
       FROM accounts a ${accountCompanyClause}`,
      companyParam
    );

    // Outstanding receivable/payable (unpaid Tax Invoices / Expenses).
    const [receivableRows] = await pool.query<any[]>(
      `SELECT COALESCE(SUM(d.grand_total - COALESCE(
                (SELECT SUM(r.amount) FROM receipts r WHERE r.tax_invoice_id = d.id), 0)), 0) as total
       FROM documents d
       WHERE d.doc_type = 'tax_invoice' AND d.status != 'cancelled' ${companyId ? "AND d.company_id = ?" : ""}`,
      companyParam
    );
    const [payableRows] = await pool.query<any[]>(
      `SELECT COALESCE(SUM(e.total_amount - COALESCE(
                (SELECT SUM(p.amount) FROM vendor_payments p WHERE p.expense_id = e.id), 0)), 0) as total
       FROM expenses e
       WHERE 1=1 ${companyId ? "AND e.company_id = ?" : ""}`,
      companyParam
    );

    // This month's revenue (excl. GST) and expenses (excl. input GST).
    const [revenueRows] = await pool.query<any[]>(
      `SELECT COALESCE(SUM(grand_total - tax_total), 0) as revenue
       FROM documents
       WHERE doc_type = 'tax_invoice' AND status != 'cancelled' ${companyClause}
         AND issue_date BETWEEN ? AND ?`,
      [...companyParam, monthStartStr, today]
    );
    const [expenseRows] = await pool.query<any[]>(
      `SELECT COALESCE(SUM(amount), 0) as total FROM expenses
       WHERE 1=1 ${companyId ? "AND company_id = ?" : ""} AND expense_date BETWEEN ? AND ?`,
      [...companyParam, monthStartStr, today]
    );

    // Recent sales documents across all types.
    const [recentDocuments] = await pool.query<any[]>(
      `SELECT d.id, d.doc_type, d.doc_number, d.issue_date, d.grand_total, d.status, c.name as party_name
       FROM documents d
       JOIN customers c ON c.id = d.customer_id
       WHERE d.doc_type IN ('quotation', 'proforma_invoice', 'delivery_challan', 'tax_invoice') ${companyClause}
       ORDER BY d.created_at DESC
       LIMIT 8`,
      companyParam
    );

    // Recent money movement (Receipts in, Vendor Payments out).
    const [recentReceipts] = await pool.query<any[]>(
      `SELECT r.id, r.received_date as entry_date, r.amount, r.created_at, c.name as party_name
       FROM receipts r JOIN customers c ON c.id = r.customer_id
       WHERE 1=1 ${companyId ? "AND r.company_id = ?" : ""}
       ORDER BY r.created_at DESC LIMIT 8`,
      companyParam
    );
    const [recentPayments] = await pool.query<any[]>(
      `SELECT p.id, p.paid_date as entry_date, p.amount, p.created_at, COALESCE(v.name, 'Unspecified vendor') as party_name
       FROM vendor_payments p LEFT JOIN vendors v ON v.id = p.vendor_id
       WHERE 1=1 ${companyId ? "AND p.company_id = ?" : ""}
       ORDER BY p.created_at DESC LIMIT 8`,
      companyParam
    );

    const recentActivity = [
      ...recentReceipts.map((r) => ({
        entry_date: r.entry_date,
        created_at: r.created_at,
        direction: "in" as const,
        amount: Number(r.amount),
        particulars: `Receipt from ${r.party_name}`,
      })),
      ...recentPayments.map((p) => ({
        entry_date: p.entry_date,
        created_at: p.created_at,
        direction: "out" as const,
        amount: Number(p.amount),
        particulars: `Payment to ${p.party_name}`,
      })),
    ]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 8)
      .map(({ created_at, ...rest }) => rest);

    const revenue = Number(revenueRows[0].revenue);
    const expenses = Number(expenseRows[0].total);

    res.json({
      cashBankBalance: Number(balanceRows[0].balance),
      totalReceivable: Number(receivableRows[0].total),
      totalPayable: Number(payableRows[0].total),
      monthRevenue: revenue,
      monthExpenses: expenses,
      netProfitThisMonth: revenue - expenses,
      recentDocuments: recentDocuments.map((d) => ({
        id: d.id,
        doc_type: d.doc_type,
        doc_type_label: DOC_TYPE_LABELS[d.doc_type] || d.doc_type,
        doc_number: d.doc_number,
        party_name: d.party_name,
        issue_date: d.issue_date,
        grand_total: Number(d.grand_total),
        status: d.status,
      })),
      recentActivity,
    });
  })
);
