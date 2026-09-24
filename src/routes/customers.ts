import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess, getModuleAccess } from "../utils/permissions";
import { GSTIN_PATTERN, GstinLookupError, fetchGstinDetails, normalizeGstin } from "../services/gstinLookup";
import { asyncHandler } from "../utils/asyncHandler";
import { Customer } from "../types";

export const customersRouter = Router();
const MODULE = "contacts.customers";

customersRouter.use(requireAuth);

async function findCustomerById(id: number): Promise<Customer | undefined> {
  const [rows] = await pool.query<any[]>("SELECT * FROM customers WHERE id = ? LIMIT 1", [id]);
  return rows[0] as Customer | undefined;
}

customersRouter.get(
  "/",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const perPage = Math.min(Math.max(Number(req.query.perPage) || 10, 1), 100);
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const offset = (page - 1) * perPage;

    // GSTIN is searchable too (spaces ignored, any case) - it is how customers
    // are usually identified when raising a document.
    const searchClause = search ? "WHERE name LIKE ? OR phone LIKE ? OR email LIKE ? OR gstin LIKE ?" : "";
    const searchParams = search ? [`%${search}%`, `%${search}%`, `%${search}%`, `%${normalizeGstin(search)}%`] : [];

    const [rows] = await pool.query<any[]>(
      `SELECT * FROM customers ${searchClause} ORDER BY name ASC LIMIT ? OFFSET ?`,
      [...searchParams, perPage, offset]
    );
    const [countRows] = await pool.query<any[]>(
      `SELECT COUNT(*) as total FROM customers ${searchClause}`,
      searchParams
    );

    res.json({ data: rows as Customer[], meta: { page, perPage, total: countRows[0].total as number } });
  })
);

// Find a customer by GSTIN: our own database first; only if we have never
// seen that GSTIN is the external GSTIN API asked (each call costs a credit),
// and what it returns is saved as a new customer straight away so the next
// lookup - by anyone - is a plain database hit. Registered before "/:id".
customersRouter.get(
  "/lookup-gstin/:gstin",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const gstin = normalizeGstin(String(req.params.gstin));
    if (!GSTIN_PATTERN.test(gstin)) {
      return res.status(400).json({ message: "That is not a valid 15-character GSTIN" });
    }

    const [rows] = await pool.query<any[]>("SELECT * FROM customers WHERE gstin = ? ORDER BY id ASC LIMIT 1", [gstin]);
    if (rows[0]) return res.json({ source: "database", customer: rows[0] as Customer });

    const access = await getModuleAccess(req.user!.sub, req.user!.role, MODULE);
    if (!access.can_create) {
      return res.status(403).json({ message: "This GSTIN is not in your customers yet, and you do not have permission to add customers" });
    }

    try {
      const details = await fetchGstinDetails(gstin);
      const [result] = await pool.query<any>(
        `INSERT INTO customers (name, gstin, billing_address, shipping_address, state) VALUES (?, ?, ?, ?, ?)`,
        [details.name, gstin, details.billing_address, details.billing_address, details.state]
      );
      const created = await findCustomerById(result.insertId);
      res.status(201).json({ source: "gstin_api", customer: created, gstStatus: details.gstStatus });
    } catch (err) {
      if (err instanceof GstinLookupError) return res.status(err.status).json({ message: err.message });
      throw err;
    }
  })
);

customersRouter.get(
  "/:id",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const customer = await findCustomerById(Number(req.params.id));
    if (!customer) return res.status(404).json({ message: "Customer not found" });
    res.json({ customer });
  })
);

customersRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const { name, phone, email, billing_address, shipping_address, state } = req.body ?? {};
    const gstin = req.body?.gstin ? normalizeGstin(String(req.body.gstin)) : "";
    if (!name) return res.status(400).json({ message: "Name is required" });
    if (gstin) {
      const [dupes] = await pool.query<any[]>("SELECT name FROM customers WHERE gstin = ? LIMIT 1", [gstin]);
      if (dupes[0]) return res.status(409).json({ message: `A customer with GSTIN ${gstin} already exists: ${dupes[0].name}` });
    }

    const [result] = await pool.query<any>(
      `INSERT INTO customers (name, gstin, phone, email, billing_address, shipping_address, state)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, gstin || null, phone || null, email || null, billing_address || null, shipping_address || null, state || null]
    );
    const created = await findCustomerById(result.insertId);
    res.status(201).json({ customer: created });
  })
);

customersRouter.put(
  "/:id",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findCustomerById(id);
    if (!existing) return res.status(404).json({ message: "Customer not found" });

    const { name, phone, email, billing_address, shipping_address, state } = req.body ?? {};
    const gstin = req.body?.gstin ? normalizeGstin(String(req.body.gstin)) : "";
    if (!name) return res.status(400).json({ message: "Name is required" });
    // Only checked when the GSTIN actually changes, so editing a customer whose
    // GSTIN is already shared with an older duplicate is not blocked.
    if (gstin && gstin !== (existing.gstin || "")) {
      const [dupes] = await pool.query<any[]>("SELECT name FROM customers WHERE gstin = ? AND id <> ? LIMIT 1", [gstin, id]);
      if (dupes[0]) return res.status(409).json({ message: `A customer with GSTIN ${gstin} already exists: ${dupes[0].name}` });
    }

    await pool.query(
      `UPDATE customers SET name = ?, gstin = ?, phone = ?, email = ?, billing_address = ?, shipping_address = ?, state = ?
       WHERE id = ?`,
      [name, gstin || null, phone || null, email || null, billing_address || null, shipping_address || null, state || null, id]
    );
    const updated = await findCustomerById(id);
    res.json({ customer: updated });
  })
);

customersRouter.delete(
  "/:id",
  requireModuleAccess(MODULE, "delete"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findCustomerById(id);
    if (!existing) return res.status(404).json({ message: "Customer not found" });

    await pool.query("DELETE FROM customers WHERE id = ?", [id]);
    res.json({ message: "Customer deleted" });
  })
);
