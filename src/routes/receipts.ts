import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { getNextDocNumber } from "../services/numbering";
import { streamReceiptPdf } from "../services/pdf/receiptPdf";
import { Company, Customer, DocumentRecord, PaymentMode, Receipt } from "../types";

export const receiptsRouter = Router();
receiptsRouter.use(requireAuth);

const PAYMENT_MODES: PaymentMode[] = ["cash", "cheque", "bank_transfer", "upi", "card", "other"];

async function findById(id: number): Promise<Receipt | undefined> {
  const [rows] = await pool.query<any[]>("SELECT * FROM receipts WHERE id = ? LIMIT 1", [id]);
  return rows[0] as Receipt | undefined;
}

receiptsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const perPage = Math.min(Math.max(Number(req.query.perPage) || 10, 1), 100);
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const offset = (page - 1) * perPage;

    const searchClause = search ? "AND (r.receipt_no LIKE ? OR c.name LIKE ?)" : "";
    const searchParams = search ? [`%${search}%`, `%${search}%`] : [];

    const [rows] = await pool.query<any[]>(
      `SELECT r.*, c.name as customer_name, co.name as company_name, co.code as company_code,
              inv.doc_number as invoice_number
       FROM receipts r
       JOIN customers c ON c.id = r.customer_id
       JOIN companies co ON co.id = r.company_id
       LEFT JOIN documents inv ON inv.id = r.tax_invoice_id
       WHERE 1=1 ${searchClause}
       ORDER BY r.created_at DESC
       LIMIT ? OFFSET ?`,
      [...searchParams, perPage, offset]
    );
    const [countRows] = await pool.query<any[]>(
      `SELECT COUNT(*) as total FROM receipts r JOIN customers c ON c.id = r.customer_id WHERE 1=1 ${searchClause}`,
      searchParams
    );

    res.json({ data: rows, meta: { page, perPage, total: countRows[0].total as number } });
  })
);

receiptsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const receipt = await findById(Number(req.params.id));
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });
    res.json({ receipt });
  })
);

async function validatePayload(body: any) {
  const { company_id, customer_id, tax_invoice_id, account_id, amount, payment_mode, received_date } = body ?? {};

  if (!company_id || !customer_id || !amount || !payment_mode || !received_date) {
    return { error: "company_id, customer_id, amount, payment_mode and received_date are required" };
  }
  if (!PAYMENT_MODES.includes(payment_mode)) {
    return { error: "Invalid payment_mode" };
  }
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    return { error: "amount must be a positive number" };
  }

  const [companyRows] = await pool.query<any[]>("SELECT * FROM companies WHERE id = ?", [company_id]);
  const company = companyRows[0] as Company | undefined;
  if (!company) return { error: "Company not found" };

  const [customerRows] = await pool.query<any[]>("SELECT * FROM customers WHERE id = ?", [customer_id]);
  const customer = customerRows[0] as Customer | undefined;
  if (!customer) return { error: "Customer not found" };

  let invoice: DocumentRecord | undefined;
  if (tax_invoice_id) {
    const [invoiceRows] = await pool.query<any[]>(
      "SELECT * FROM documents WHERE id = ? AND doc_type = 'tax_invoice'",
      [tax_invoice_id]
    );
    invoice = invoiceRows[0] as DocumentRecord | undefined;
    if (!invoice) return { error: "Tax invoice not found" };
    if (invoice.customer_id !== Number(customer_id)) {
      return { error: "Selected invoice does not belong to this customer" };
    }
  }

  if (account_id) {
    const [accountRows] = await pool.query<any[]>("SELECT id, company_id FROM accounts WHERE id = ?", [account_id]);
    const account = accountRows[0];
    if (!account) return { error: "Account not found" };
    if (account.company_id !== Number(company_id)) {
      return { error: "Selected account does not belong to this company" };
    }
  }

  return { company, customer, invoice };
}

receiptsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const result = await validatePayload(req.body);
    if ("error" in result) return res.status(400).json({ message: result.error });
    const { company } = result;

    const { customer_id, tax_invoice_id, account_id, amount, payment_mode, reference_no, received_date, notes } = req.body;

    const { docNumber, financialYear } = await getNextDocNumber("receipt", company!.code, new Date(received_date));

    const [insertResult] = await pool.query<any>(
      `INSERT INTO receipts
         (receipt_no, financial_year, company_id, customer_id, tax_invoice_id, account_id, amount, payment_mode, reference_no, received_date, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        docNumber,
        financialYear,
        req.body.company_id,
        customer_id,
        tax_invoice_id || null,
        account_id || null,
        amount,
        payment_mode,
        reference_no || null,
        received_date,
        notes || null,
        req.user!.sub,
      ]
    );

    const created = await findById(insertResult.insertId);
    res.status(201).json({ receipt: created });
  })
);

receiptsRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findById(id);
    if (!existing) return res.status(404).json({ message: "Receipt not found" });

    const result = await validatePayload(req.body);
    if ("error" in result) return res.status(400).json({ message: result.error });

    const { company_id, customer_id, tax_invoice_id, account_id, amount, payment_mode, reference_no, received_date, notes } =
      req.body;

    await pool.query(
      `UPDATE receipts SET
         company_id = ?, customer_id = ?, tax_invoice_id = ?, account_id = ?, amount = ?, payment_mode = ?,
         reference_no = ?, received_date = ?, notes = ?
       WHERE id = ?`,
      [
        company_id,
        customer_id,
        tax_invoice_id || null,
        account_id || null,
        amount,
        payment_mode,
        reference_no || null,
        received_date,
        notes || null,
        id,
      ]
    );

    const updated = await findById(id);
    res.json({ receipt: updated });
  })
);

receiptsRouter.delete(
  "/:id",
  requireRole("super_admin", "admin"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findById(id);
    if (!existing) return res.status(404).json({ message: "Receipt not found" });
    await pool.query("DELETE FROM receipts WHERE id = ?", [id]);
    res.json({ message: "Receipt deleted" });
  })
);

receiptsRouter.get(
  "/:id/pdf",
  asyncHandler(async (req, res) => {
    const receipt = await findById(Number(req.params.id));
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });

    const [companyRows] = await pool.query<any[]>("SELECT * FROM companies WHERE id = ?", [receipt.company_id]);
    const [customerRows] = await pool.query<any[]>("SELECT * FROM customers WHERE id = ?", [receipt.customer_id]);
    let invoice: DocumentRecord | null = null;
    if (receipt.tax_invoice_id) {
      const [invoiceRows] = await pool.query<any[]>("SELECT * FROM documents WHERE id = ?", [receipt.tax_invoice_id]);
      invoice = (invoiceRows[0] as DocumentRecord) ?? null;
    }

    streamReceiptPdf(res, receipt, customerRows[0] as Customer, companyRows[0] as Company, invoice);
  })
);
