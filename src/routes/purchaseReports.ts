import { Router, Request } from "express";
import { pool } from "../config/db";
import { asyncHandler } from "../utils/asyncHandler";
import { isInterStateSupply } from "../utils/gst";

// Purchase Reports. Mounted under /api/reports/purchases, so the auth +
// "reports.reports" view gate on reportsRouter already covers every route -
// all of them are reads.
export const purchaseReportsRouter = Router();

const round2 = (n: number) => Math.round(n * 100) / 100;

interface Filters {
  companyId: number | null;
  vendorId: number | null;
  from: string;
  to: string;
  gst: "all" | "gst" | "non_gst";
  status: "active" | "all" | "draft" | "received" | "cancelled";
}

function filtersOf(req: Request): Filters {
  const q = req.query;
  const today = new Date().toISOString().slice(0, 10);
  const status = ["all", "draft", "received", "cancelled"].includes(String(q.status)) ? (q.status as Filters["status"]) : "active";
  return {
    companyId: q.company_id ? Number(q.company_id) : null,
    vendorId: q.vendor_id ? Number(q.vendor_id) : null,
    from: typeof q.from === "string" && q.from ? q.from : "1900-01-01",
    to: typeof q.to === "string" && q.to ? q.to : today,
    gst: q.gst_type === "gst" || q.gst_type === "non_gst" ? q.gst_type : "all",
    status,
  };
}

/** WHERE fragments shared by every purchase-bill query: `b` is the bill alias. */
function billWhere(f: Filters, withStatus = true): { sql: string; params: any[] } {
  const parts: string[] = ["b.bill_date BETWEEN ? AND ?"];
  const params: any[] = [f.from, f.to];
  if (f.companyId) {
    parts.push("b.company_id = ?");
    params.push(f.companyId);
  }
  if (f.vendorId) {
    parts.push("b.vendor_id = ?");
    params.push(f.vendorId);
  }
  if (f.gst !== "all") {
    parts.push("b.gst_type = ?");
    params.push(f.gst);
  }
  if (withStatus) {
    if (f.status === "active") parts.push("b.status != 'cancelled'");
    else if (f.status !== "all") {
      parts.push("b.status = ?");
      params.push(f.status);
    }
  }
  return { sql: parts.join(" AND "), params };
}

// ---- Purchase Register: one row per Purchase Bill with the GST split. A
// purchase bill stores one tax figure, so CGST/SGST/IGST is derived the same
// way sales documents do it: GSTIN state codes of company and vendor decide
// inter- vs intra-state. Bills in the Without GST book carry no tax. ----
purchaseReportsRouter.get(
  "/register",
  asyncHandler(async (req, res) => {
    const f = filtersOf(req);
    const w = billWhere(f);
    const [rows] = await pool.query<any[]>(
      `SELECT b.id, b.bill_no, b.reference_no, b.bill_date, b.status, b.gst_type,
              b.subtotal, b.tax_amount, b.round_off, b.total_amount,
              v.id as vendor_id, v.name as vendor_name, v.gstin as vendor_gstin, v.state as vendor_state,
              co.code as company_code, co.gstin as company_gstin, co.state as company_state
       FROM purchase_bills b
       JOIN vendors v ON v.id = b.vendor_id
       JOIN companies co ON co.id = b.company_id
       WHERE ${w.sql}
       ORDER BY b.bill_date DESC, b.financial_year DESC, SUBSTRING_INDEX(b.bill_no, '/', -1) DESC, b.id DESC`,
      w.params
    );

    const bills = rows.map((r) => {
      const tax = Number(r.tax_amount);
      const inter = isInterStateSupply(r.company_state, r.vendor_state, r.company_gstin, r.vendor_gstin);
      const cgst = inter ? 0 : round2(tax / 2);
      const sgst = inter ? 0 : round2(tax - cgst);
      return {
        id: r.id,
        bill_date: r.bill_date,
        reference_no: r.reference_no,
        bill_no: r.bill_no,
        company_code: r.company_code,
        gst_type: r.gst_type,
        status: r.status,
        vendor_id: r.vendor_id,
        vendor_name: r.vendor_name,
        vendor_gstin: r.vendor_gstin,
        taxable: Number(r.subtotal),
        cgst,
        sgst,
        igst: inter ? tax : 0,
        tax,
        round_off: Number(r.round_off),
        total: Number(r.total_amount),
      };
    });

    const sum = (key: "taxable" | "cgst" | "sgst" | "igst" | "tax" | "round_off" | "total") =>
      round2(bills.reduce((s, b) => s + b[key], 0));
    res.json({
      bills,
      totals: { count: bills.length, taxable: sum("taxable"), cgst: sum("cgst"), sgst: sum("sgst"), igst: sum("igst"), tax: sum("tax"), round_off: sum("round_off"), total: sum("total") },
    });
  })
);

// ---- Vendor-wise: what each vendor billed us in the period, what came back
// as Debit Notes, what we paid, and the balance still payable at the end
// date. The balance deliberately uses the same sources as the vendor's Party
// Ledger (Purchase Bills + Expenses - Debit Notes - Payments, all dates up to
// the end date) so the two always agree. ----
purchaseReportsRouter.get(
  "/vendor-summary",
  asyncHandler(async (req, res) => {
    const f = filtersOf(req);
    const gstFor = (alias: string) => (f.gst === "all" ? "" : ` AND ${alias}.gst_type = '${f.gst}'`);
    const coFor = (alias: string) => (f.companyId ? ` AND ${alias}.company_id = ${Number(f.companyId)}` : "");
    const vendFor = (alias: string) => (f.vendorId ? ` AND ${alias}.vendor_id = ${Number(f.vendorId)}` : "");

    const w = billWhere(f);
    const [billRows] = await pool.query<any[]>(
      `SELECT b.vendor_id, COUNT(*) as bills, SUM(b.subtotal) as taxable, SUM(b.tax_amount) as tax, SUM(b.total_amount) as total
       FROM purchase_bills b WHERE ${w.sql} GROUP BY b.vendor_id`,
      w.params
    );
    const [dnRows] = await pool.query<any[]>(
      `SELECT d.vendor_id, SUM(d.total_amount) as total FROM debit_notes d
       WHERE d.status != 'cancelled' AND d.issue_date BETWEEN ? AND ?${coFor("d")}${vendFor("d")}${gstFor("d")}
       GROUP BY d.vendor_id`,
      [f.from, f.to]
    );
    const [payRows] = await pool.query<any[]>(
      `SELECT p.vendor_id, SUM(p.amount) as total FROM vendor_payments p
       WHERE p.vendor_id IS NOT NULL AND p.paid_date BETWEEN ? AND ?${coFor("p")}${vendFor("p")}${gstFor("p")}
       GROUP BY p.vendor_id`,
      [f.from, f.to]
    );
    // Closing balance as on the end date, across all earlier periods too.
    const [balRows] = await pool.query<any[]>(
      `SELECT vendor_id, SUM(amt) as balance FROM (
         SELECT b.vendor_id, b.total_amount as amt FROM purchase_bills b
           WHERE b.status != 'cancelled' AND b.bill_date <= ?${coFor("b")}${vendFor("b")}${gstFor("b")}
         UNION ALL
         SELECT e.vendor_id, e.total_amount FROM expenses e
           WHERE e.vendor_id IS NOT NULL AND e.expense_date <= ?${coFor("e")}${vendFor("e")}${gstFor("e")}
         UNION ALL
         SELECT d.vendor_id, -d.total_amount FROM debit_notes d
           WHERE d.status != 'cancelled' AND d.issue_date <= ?${coFor("d")}${vendFor("d")}${gstFor("d")}
         UNION ALL
         SELECT p.vendor_id, -p.amount FROM vendor_payments p
           WHERE p.vendor_id IS NOT NULL AND p.paid_date <= ?${coFor("p")}${vendFor("p")}${gstFor("p")}
       ) x GROUP BY vendor_id`,
      [f.to, f.to, f.to, f.to]
    );

    const byVendor = new Map<number, { bills: number; taxable: number; tax: number; total: number; debit_notes: number; paid: number; balance: number }>();
    const row = (id: number) => {
      let r = byVendor.get(id);
      if (!r) byVendor.set(id, (r = { bills: 0, taxable: 0, tax: 0, total: 0, debit_notes: 0, paid: 0, balance: 0 }));
      return r;
    };
    for (const r of billRows) Object.assign(row(r.vendor_id), { bills: Number(r.bills), taxable: Number(r.taxable), tax: Number(r.tax), total: Number(r.total) });
    for (const r of dnRows) row(r.vendor_id).debit_notes = Number(r.total);
    for (const r of payRows) row(r.vendor_id).paid = Number(r.total);
    for (const r of balRows) row(r.vendor_id).balance = round2(Number(r.balance));

    const ids = [...byVendor.keys()];
    const [vendorRows] = ids.length
      ? await pool.query<any[]>("SELECT id, name, gstin FROM vendors WHERE id IN (?)", [ids])
      : [[] as any[]];
    const names = new Map<number, { name: string; gstin: string | null }>(vendorRows.map((v: any) => [v.id, { name: v.name, gstin: v.gstin }]));

    const vendors = ids
      .map((id) => ({ vendor_id: id, vendor_name: names.get(id)?.name ?? `Vendor #${id}`, vendor_gstin: names.get(id)?.gstin ?? null, ...byVendor.get(id)! }))
      // Keep vendors with period activity or something still payable.
      .filter((v) => v.bills || v.debit_notes || v.paid || Math.abs(v.balance) > 0.005)
      .sort((a, b) => b.total - a.total || a.vendor_name.localeCompare(b.vendor_name));

    const sum = (k: "taxable" | "tax" | "total" | "debit_notes" | "paid" | "balance") => round2(vendors.reduce((s, v) => s + v[k], 0));
    res.json({
      vendors,
      totals: { vendors: vendors.length, bills: vendors.reduce((s, v) => s + v.bills, 0), taxable: sum("taxable"), tax: sum("tax"), total: sum("total"), debit_notes: sum("debit_notes"), paid: sum("paid"), balance: sum("balance") },
    });
  })
);

// ---- Item-wise (by description) and HSN-wise (by HSN + tax rate) from the
// bill lines. ----
purchaseReportsRouter.get(
  "/item-summary",
  asyncHandler(async (req, res) => {
    const f = filtersOf(req);
    const w = billWhere(f);
    const mode = req.query.mode === "hsn" ? "hsn" : "item";
    const [rows] = await pool.query<any[]>(
      mode === "item"
        ? `SELECT i.description, i.hsn_code, i.unit, COUNT(DISTINCT b.id) as bills, SUM(i.qty) as qty,
                  SUM(i.taxable_amount) as taxable, SUM(i.tax_amount) as tax, SUM(i.line_total) as total
           FROM purchase_bill_items i JOIN purchase_bills b ON b.id = i.purchase_bill_id
           WHERE ${w.sql}
           GROUP BY i.description, i.hsn_code, i.unit
           ORDER BY total DESC, i.description ASC`
        : `SELECT i.hsn_code, i.tax_rate, COUNT(DISTINCT b.id) as bills,
                  SUM(i.taxable_amount) as taxable, SUM(i.tax_amount) as tax, SUM(i.line_total) as total
           FROM purchase_bill_items i JOIN purchase_bills b ON b.id = i.purchase_bill_id
           WHERE ${w.sql}
           GROUP BY i.hsn_code, i.tax_rate
           ORDER BY total DESC, i.hsn_code ASC`,
      w.params
    );
    const lines = rows.map((r) => ({
      description: r.description ?? null,
      hsn_code: r.hsn_code || null,
      unit: r.unit ?? null,
      tax_rate: r.tax_rate !== undefined ? Number(r.tax_rate) : null,
      bills: Number(r.bills),
      qty: r.qty !== undefined ? Number(r.qty) : null,
      taxable: Number(r.taxable),
      tax: Number(r.tax),
      total: Number(r.total),
    }));
    const sum = (k: "taxable" | "tax" | "total") => round2(lines.reduce((s, l) => s + l[k], 0));
    res.json({ mode, lines, totals: { taxable: sum("taxable"), tax: sum("tax"), total: sum("total") } });
  })
);

// ---- Month-wise: bills and debit notes per calendar month. ----
purchaseReportsRouter.get(
  "/monthly",
  asyncHandler(async (req, res) => {
    const f = filtersOf(req);
    const w = billWhere(f);
    const [billRows] = await pool.query<any[]>(
      `SELECT DATE_FORMAT(b.bill_date, '%Y-%m') as month, COUNT(*) as bills, SUM(b.subtotal) as taxable,
              SUM(b.tax_amount) as tax, SUM(b.round_off) as round_off, SUM(b.total_amount) as total
       FROM purchase_bills b WHERE ${w.sql} GROUP BY month`,
      w.params
    );
    const dnParts = ["d.status != 'cancelled'", "d.issue_date BETWEEN ? AND ?"];
    const dnParams: any[] = [f.from, f.to];
    if (f.companyId) (dnParts.push("d.company_id = ?"), dnParams.push(f.companyId));
    if (f.vendorId) (dnParts.push("d.vendor_id = ?"), dnParams.push(f.vendorId));
    if (f.gst !== "all") (dnParts.push("d.gst_type = ?"), dnParams.push(f.gst));
    const [dnRows] = await pool.query<any[]>(
      `SELECT DATE_FORMAT(d.issue_date, '%Y-%m') as month, SUM(d.total_amount) as total
       FROM debit_notes d WHERE ${dnParts.join(" AND ")} GROUP BY month`,
      dnParams
    );

    const months = new Map<string, { month: string; bills: number; taxable: number; tax: number; round_off: number; total: number; debit_notes: number }>();
    const get = (m: string) => {
      let r = months.get(m);
      if (!r) months.set(m, (r = { month: m, bills: 0, taxable: 0, tax: 0, round_off: 0, total: 0, debit_notes: 0 }));
      return r;
    };
    for (const r of billRows) Object.assign(get(r.month), { bills: Number(r.bills), taxable: Number(r.taxable), tax: Number(r.tax), round_off: Number(r.round_off), total: Number(r.total) });
    for (const r of dnRows) get(r.month).debit_notes = Number(r.total);

    const list = [...months.values()]
      .sort((a, b) => b.month.localeCompare(a.month))
      .map((m) => ({ ...m, net: round2(m.total - m.debit_notes) }));
    const sum = (k: "bills" | "taxable" | "tax" | "round_off" | "total" | "debit_notes" | "net") => round2(list.reduce((s, m) => s + m[k], 0));
    res.json({
      months: list,
      totals: { bills: sum("bills"), taxable: sum("taxable"), tax: sum("tax"), round_off: sum("round_off"), total: sum("total"), debit_notes: sum("debit_notes"), net: sum("net") },
    });
  })
);
