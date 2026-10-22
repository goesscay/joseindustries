import dotenv from "dotenv";
import fs from "fs";
import { PoolConnection } from "mysql2/promise";
import { pool } from "../config/db";
import { getNextDocNumber } from "../services/numbering";
import { postReceiptJournalTx } from "../services/accounting";

dotenv.config();

// One-off importer for customer receipts taken from a bank statement. Usage:
//
//   npx tsx src/db/importReceipts.ts <receipts.json>            (dry run - writes nothing)
//   npx tsx src/db/importReceipts.ts <receipts.json> --commit   (actually imports)
//
// It writes to whatever database DB_* in .env points at - the target is printed first. Each receipt is
// created like POST /receipts does (receipt, its invoice allocations and the Dr Bank / Cr Accounts
// Receivable journal in one transaction), in date order so the receipt numbers follow the dates. A
// receipt with no allocations is an on-account receipt: it still appears in the customer's ledger.
//
// Re-running is safe: a statement row that already has a receipt (its notes start with
// "Bank statement row <n>:") is skipped. Nothing is imported unless every receipt passes validation.
//
// JSON shape: { company_code, account_id, receipts: [{ row, date, amount, customer_id, payment_mode,
// reference_no, gst_type, desc, match, allocations: [{ invoice_id, amount }] }] }

interface Allocation {
  invoice_id: number;
  amount: number;
}

interface ImportReceipt {
  row: number;
  date: string;
  amount: number;
  customer_id: number;
  payment_mode: "cash" | "cheque" | "bank_transfer" | "upi" | "card" | "other";
  reference_no: string | null;
  gst_type: "gst" | "non_gst";
  desc: string;
  match: string;
  allocations: Allocation[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const file = process.argv[2];
  const commit = process.argv.includes("--commit");
  if (!file || file.startsWith("--")) throw new Error("Usage: tsx src/db/importReceipts.ts <receipts.json> [--commit]");
  const input = JSON.parse(fs.readFileSync(file, "utf-8")) as { company_code: string; account_id: number; receipts: ImportReceipt[] };

  console.log(`Target database: ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);
  console.log(commit ? "MODE: COMMIT - receipts will be written\n" : "MODE: dry run - nothing will be written\n");

  const [companyRows] = await pool.query<any[]>("SELECT * FROM companies WHERE code = ?", [input.company_code]);
  const company = companyRows[0];
  if (!company) throw new Error(`Company ${input.company_code} not found`);
  const [accountRows] = await pool.query<any[]>("SELECT id, company_id, account_type, is_active FROM accounts WHERE id = ?", [input.account_id]);
  const account = accountRows[0];
  if (!account || account.company_id !== company.id || !account.is_active) throw new Error(`Account ${input.account_id} is not an active account of ${company.code}`);
  const [adminRows] = await pool.query<any[]>("SELECT id FROM users WHERE role = 'super_admin' ORDER BY id LIMIT 1");
  const createdBy: number | null = adminRows[0]?.id ?? null;

  const receipts = [...input.receipts].sort((a, b) => a.date.localeCompare(b.date) || a.row - b.row);

  // ---- Validation (read-only): everything must pass before anything is written. ----
  const remaining = new Map<number, number>(); // invoice id -> outstanding balance, reduced as this run's receipts consume it
  const invoiceInfo = new Map<number, { doc_number: string; customer_id: number; gst_type: string; status: string }>();
  async function outstanding(invoiceId: number): Promise<number> {
    if (remaining.has(invoiceId)) return remaining.get(invoiceId)!;
    const [rows] = await pool.query<any[]>(
      `SELECT d.id, d.doc_number, d.customer_id, d.gst_type, d.status, d.grand_total, d.company_id,
              COALESCE((SELECT SUM(ra.amount) FROM receipt_allocations ra WHERE ra.tax_invoice_id = d.id), 0)
              + COALESCE((SELECT SUM(cn.grand_total) FROM credit_notes cn WHERE cn.tax_invoice_id = d.id AND cn.status != 'cancelled'), 0) AS paid
       FROM documents d WHERE d.id = ? AND d.doc_type = 'tax_invoice'`,
      [invoiceId]
    );
    const d = rows[0];
    if (!d || d.company_id !== company.id) throw new Error(`Invoice ${invoiceId} is not a ${company.code} tax invoice`);
    invoiceInfo.set(invoiceId, { doc_number: d.doc_number, customer_id: d.customer_id, gst_type: d.gst_type, status: d.status });
    const bal = round2(Number(d.grand_total) - Number(d.paid));
    remaining.set(invoiceId, bal);
    return bal;
  }

  const plan: { r: ImportReceipt; exists: boolean; customer: string }[] = [];
  for (const r of receipts) {
    if (!(r.amount > 0)) throw new Error(`row ${r.row}: amount must be positive`);
    const [cust] = await pool.query<any[]>("SELECT id, name FROM customers WHERE id = ?", [r.customer_id]);
    if (!cust[0]) throw new Error(`row ${r.row}: customer ${r.customer_id} not found`);
    const [ex] = await pool.query<any[]>("SELECT id FROM receipts WHERE company_id = ? AND notes LIKE ?", [company.id, `Bank statement row ${r.row}:%`]);
    const exists = !!ex[0];
    if (!exists) {
      const total = round2(r.allocations.reduce((s, a) => s + a.amount, 0));
      if (total > r.amount + 0.01) throw new Error(`row ${r.row}: allocations (${total}) exceed the amount received (${r.amount})`);
      for (const a of r.allocations) {
        const bal = await outstanding(a.invoice_id);
        const info = invoiceInfo.get(a.invoice_id)!;
        if (info.customer_id !== r.customer_id) throw new Error(`row ${r.row}: ${info.doc_number} belongs to a different customer`);
        if (info.gst_type !== r.gst_type) throw new Error(`row ${r.row}: ${info.doc_number} is in a different GST book than the receipt`);
        if (info.status === "cancelled") throw new Error(`row ${r.row}: ${info.doc_number} is cancelled`);
        if (a.amount > bal + 0.01) throw new Error(`row ${r.row}: allocation ${a.amount} exceeds the outstanding ${bal} of ${info.doc_number}`);
        remaining.set(a.invoice_id, round2(bal - a.amount));
      }
    }
    plan.push({ r, exists, customer: cust[0].name });
  }

  console.log("Date        Amount      Customer                         Mode           Allocated to");
  for (const p of plan) {
    const al = p.exists
      ? ""
      : p.r.allocations.map((a) => `${invoiceInfo.get(a.invoice_id)!.doc_number.replace("/26-27", "")}:${a.amount.toFixed(2)}`).join(", ") || "on account";
    console.log(`${p.r.date}  ${p.r.amount.toFixed(2).padStart(11)}  ${p.customer.slice(0, 30).padEnd(30)}  ${p.r.payment_mode.padEnd(13)}  ${p.exists ? "ALREADY IMPORTED - skip" : al}${p.r.gst_type === "non_gst" ? "  [NON-GST]" : ""}`);
  }
  const todo = plan.filter((p) => !p.exists);
  const allocated = round2(todo.reduce((s, p) => s + p.r.allocations.reduce((x, a) => x + a.amount, 0), 0));
  const total = round2(todo.reduce((s, p) => s + p.r.amount, 0));
  console.log(`\n${todo.length} to import (${plan.length - todo.length} already present): total ${total.toFixed(2)}, allocated to invoices ${allocated.toFixed(2)}, on account ${round2(total - allocated).toFixed(2)}`);
  if (!commit) {
    console.log("Dry run only - re-run with --commit to write.");
    return;
  }

  // ---- Write: one transaction per receipt, in date order; stop at the first failure. ----
  for (const p of todo) {
    const r = p.r;
    const { docNumber, financialYear } = await getNextDocNumber("receipt", company.code, new Date(`${r.date}T00:00:00`), r.gst_type);
    const conn: PoolConnection = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const notes = `Bank statement row ${r.row}: ${r.desc.slice(0, 120)} | ${r.match}`.slice(0, 1000);
      const legacyInvoiceId = r.allocations.length === 1 ? r.allocations[0].invoice_id : null;
      const [res] = await conn.query<any>(
        `INSERT INTO receipts
           (receipt_no, financial_year, company_id, customer_id, tax_invoice_id, account_id, amount, payment_mode, reference_no, received_date, notes, created_by, gst_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [docNumber, financialYear, company.id, r.customer_id, legacyInvoiceId, input.account_id, r.amount, r.payment_mode, r.reference_no, r.date, notes, createdBy, r.gst_type]
      );
      const receiptId = res.insertId as number;
      for (const a of r.allocations) {
        await conn.query("INSERT INTO receipt_allocations (receipt_id, tax_invoice_id, amount) VALUES (?, ?, ?)", [receiptId, a.invoice_id, a.amount]);
      }
      await postReceiptJournalTx(conn, {
        companyId: company.id,
        accountId: input.account_id,
        amount: r.amount,
        receiptId,
        receiptNo: docNumber,
        receivedDate: r.date,
        createdBy,
      });
      await conn.commit();
      console.log(`imported ${docNumber}  ${r.date}  ${r.amount.toFixed(2)}  (row ${r.row})`);
    } catch (err) {
      await conn.rollback();
      throw new Error(`row ${r.row} failed and was rolled back: ${err instanceof Error ? err.message : err}`);
    } finally {
      conn.release();
    }
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
