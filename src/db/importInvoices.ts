import dotenv from "dotenv";
import fs from "fs";
import { PoolConnection } from "mysql2/promise";
import { pool } from "../config/db";
import { computeLine, computeTotals } from "../utils/totals";
import { computeGstSplit } from "../utils/gst";
import { getFinancialYear } from "../services/financialYear";
import { postTaxInvoiceJournalTx } from "../services/accounting";
import { GSTIN_PATTERN } from "../services/gstinLookup";

dotenv.config();

// One-off importer for Tax Invoices that were already issued from the old Excel
// sheets (same numbers, same totals) - so they land in the books exactly as
// billed. Usage:
//
//   npx tsx src/db/importInvoices.ts <invoices.json>            (dry run - writes nothing)
//   npx tsx src/db/importInvoices.ts <invoices.json> --commit   (actually imports)
//
// It writes to whatever database DB_* in .env points at - the target is printed
// first. Each invoice is created like POST /tax-invoices does (document, lines
// and the double-entry journal in one transaction) except that:
//   * the invoice number is the one already printed on the invoice, not the next
//     counter value - afterwards the counter is only ever raised (never lowered)
//     to the highest imported number;
//   * the grand total is rounded DOWN to the rupee (what the Excel sheets did),
//     not to the nearest rupee, so the receivable equals what the customer was
//     actually billed. The script refuses to run if any total differs from the
//     sheet's own total;
//   * invoices whose number already exists are skipped, so re-running is safe.
// Lines never reference catalog items, so there is no stock or COGS posting.
//
// JSON shape: { company_code, invoices: [{ doc_number, issue_date, issue_date_override?,
// override_reason?, other_reference, place_of_supply, expected_total,
// customer: { name, gstin, address, state }, items: [{ description, hsn_code, qty, rate, tax_rate }] }] }

interface ImportItem {
  description: string;
  hsn_code: string;
  qty: number;
  rate: number;
  tax_rate: number;
}

interface ImportInvoice {
  doc_number: string;
  issue_date: string;
  issue_date_override?: string;
  override_reason?: string;
  other_reference: string;
  place_of_supply: string;
  expected_total: number;
  customer: { name: string; gstin: string; address: string; state: string };
  items: ImportItem[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const file = process.argv[2];
  const commit = process.argv.includes("--commit");
  if (!file || file.startsWith("--")) throw new Error("Usage: tsx src/db/importInvoices.ts <invoices.json> [--commit]");
  const input = JSON.parse(fs.readFileSync(file, "utf-8")) as { company_code: string; invoices: ImportInvoice[] };

  console.log(`Target database: ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);
  console.log(commit ? "MODE: COMMIT - invoices will be written\n" : "MODE: dry run - nothing will be written\n");

  const [companyRows] = await pool.query<any[]>("SELECT * FROM companies WHERE code = ?", [input.company_code]);
  const company = companyRows[0];
  if (!company) throw new Error(`Company ${input.company_code} not found`);
  const [adminRows] = await pool.query<any[]>("SELECT id FROM users WHERE role = 'super_admin' ORDER BY id LIMIT 1");
  const createdBy: number | null = adminRows[0]?.id ?? null;

  // ---- Plan (read-only): validate everything before writing anything. ----
  const plan = [];
  for (const inv of input.invoices) {
    const issueDate = inv.issue_date_override || inv.issue_date;
    const fy = getFinancialYear(new Date(`${issueDate}T00:00:00`));
    if (!inv.doc_number.endsWith(`/${fy}`)) {
      throw new Error(`${inv.doc_number}: number does not belong to the financial year ${fy} of ${issueDate}`);
    }
    if (!GSTIN_PATTERN.test(inv.customer.gstin)) throw new Error(`${inv.doc_number}: invalid customer GSTIN ${inv.customer.gstin}`);

    const lines = inv.items.map((i) => {
      if (i.description.length > 255) throw new Error(`${inv.doc_number}: a description is longer than 255 characters`);
      return { item_id: null, description: i.description, hsn_code: i.hsn_code || null, qty: i.qty, unit: "pcs", rate: i.rate, discount_percent: 0, tax_rate: i.tax_rate };
    });
    const [existingCustomer] = await pool.query<any[]>("SELECT id, name, state FROM customers WHERE gstin = ?", [inv.customer.gstin]);
    const customerState = existingCustomer[0]?.state ?? inv.customer.state;
    const totals = computeTotals(lines);
    const split = computeGstSplit(lines, company.state, customerState, company.gstin, inv.customer.gstin);
    const taxTotal = split.isInterState ? split.igstTotal : split.cgstTotal + split.sgstTotal;
    if (Math.abs(taxTotal - totals.taxTotal) > 0.011) throw new Error(`${inv.doc_number}: tax split ${taxTotal} differs from line tax ${totals.taxTotal}`);

    const raw = round2(totals.subtotal + totals.taxTotal);
    const grandTotal = Math.floor(raw); // the sheets always rounded down to the rupee
    if (Math.abs(grandTotal - inv.expected_total) > 0.011) {
      throw new Error(`${inv.doc_number}: computed total ${grandTotal} does not match the sheet's total ${inv.expected_total}`);
    }
    const [existingDoc] = await pool.query<any[]>("SELECT id FROM documents WHERE doc_type = 'tax_invoice' AND doc_number = ?", [inv.doc_number]);
    plan.push({ inv, issueDate, fy, lines, totals, split, taxTotal, grandTotal, roundOff: round2(grandTotal - raw), exists: !!existingDoc[0], customerId: existingCustomer[0]?.id ?? null });
  }

  console.log("Invoice        Date        Customer                          Taxable    CGST/SGST/IGST            Round   Total      Notes");
  for (const p of plan) {
    const notes = [
      p.exists ? "ALREADY EXISTS - will skip" : "",
      p.customerId ? "existing customer" : "NEW customer",
      p.inv.issue_date_override ? `date ${p.inv.issue_date} -> ${p.issueDate} (${p.inv.override_reason ?? "override"})` : "",
    ].filter(Boolean).join("; ");
    console.log(
      `${p.inv.doc_number.padEnd(14)} ${p.issueDate}  ${p.inv.customer.name.slice(0, 32).padEnd(32)} ${p.totals.subtotal.toFixed(2).padStart(10)}  ` +
        `${p.split.cgstTotal.toFixed(2)}/${p.split.sgstTotal.toFixed(2)}/${p.split.igstTotal.toFixed(2)}`.padEnd(26) +
        `${p.roundOff.toFixed(2).padStart(6)} ${p.grandTotal.toFixed(2).padStart(10)}  ${notes}`
    );
  }
  const toImport = plan.filter((p) => !p.exists);
  console.log(`\n${toImport.length} to import, ${plan.length - toImport.length} already present.`);
  if (!commit) {
    console.log("Dry run only - re-run with --commit to write.");
    return;
  }

  // ---- Write: one transaction per invoice; stop at the first failure. ----
  const customerIdByGstin = new Map<string, number>();
  for (const p of toImport) {
    const conn: PoolConnection = await pool.getConnection();
    try {
      await conn.beginTransaction();
      let customerId = p.customerId ?? customerIdByGstin.get(p.inv.customer.gstin) ?? null;
      if (!customerId) {
        const c = p.inv.customer;
        const [res] = await conn.query<any>(
          "INSERT INTO customers (name, gstin, billing_address, shipping_address, state) VALUES (?, ?, ?, ?, ?)",
          [c.name, c.gstin, c.address, c.address, c.state]
        );
        customerId = res.insertId as number;
      }
      customerIdByGstin.set(p.inv.customer.gstin, customerId);

      const [docRes] = await conn.query<any>(
        `INSERT INTO documents
           (doc_type, doc_number, financial_year, company_id, customer_id, status, issue_date, place_of_supply, other_reference,
            subtotal, discount_amount, freight_charges, installation_charges,
            cgst_total, sgst_total, igst_total, tax_total, round_off, grand_total, created_by, template_style, gst_type)
         VALUES ('tax_invoice', ?, ?, ?, ?, 'accepted', ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, 'classic_gst', 'gst')`,
        [
          p.inv.doc_number, p.fy, company.id, customerId, p.issueDate, p.inv.place_of_supply || null, p.inv.other_reference || null,
          p.totals.subtotal, p.split.cgstTotal, p.split.sgstTotal, p.split.igstTotal, p.taxTotal, p.roundOff, p.grandTotal, createdBy,
        ]
      );
      const documentId = docRes.insertId as number;
      for (const [index, line] of p.lines.entries()) {
        await conn.query(
          `INSERT INTO document_items
             (document_id, item_id, description, hsn_code, qty, unit, rate, discount_percent, tax_rate, line_total, sort_order, line_kind)
           VALUES (?, NULL, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'item')`,
          [documentId, line.description, line.hsn_code, line.qty, line.unit, line.rate, line.tax_rate, computeLine(line).lineTotal, index]
        );
      }
      await postTaxInvoiceJournalTx(conn, {
        companyId: company.id,
        invoiceId: documentId,
        invoiceNo: p.inv.doc_number,
        issueDate: p.issueDate,
        grandTotal: p.grandTotal,
        taxTotal: p.taxTotal,
        cgstTotal: p.split.cgstTotal,
        sgstTotal: p.split.sgstTotal,
        igstTotal: p.split.igstTotal,
        createdBy,
      });
      await conn.commit();
      console.log(`imported ${p.inv.doc_number} (document #${documentId})`);
    } catch (err) {
      await conn.rollback();
      throw new Error(`${p.inv.doc_number} failed and was rolled back: ${err instanceof Error ? err.message : err}`);
    } finally {
      conn.release();
    }
  }

  // Raise (never lower) each financial year's invoice counter to the highest imported number.
  const highest = new Map<string, number>();
  for (const p of toImport) {
    const seq = Number(p.inv.doc_number.match(/-(\d+)\//)?.[1]);
    if (seq > (highest.get(p.fy) ?? 0)) highest.set(p.fy, seq);
  }
  for (const [fy, seq] of highest) {
    await pool.query(
      `INSERT INTO doc_counters (doc_type, company_code, financial_year, last_number) VALUES ('tax_invoice', ?, ?, ?)
       ON DUPLICATE KEY UPDATE last_number = GREATEST(last_number, VALUES(last_number))`,
      [company.code, fy, seq]
    );
    console.log(`counter tax_invoice ${company.code} ${fy} is now at least ${seq}`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
