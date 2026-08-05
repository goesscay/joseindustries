import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { Customer } from "../types";

export const customersRouter = Router();

customersRouter.use(requireAuth);

async function findCustomerById(id: number): Promise<Customer | undefined> {
  const [rows] = await pool.query<any[]>("SELECT * FROM customers WHERE id = ? LIMIT 1", [id]);
  return rows[0] as Customer | undefined;
}

customersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const perPage = Math.min(Math.max(Number(req.query.perPage) || 10, 1), 100);
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const offset = (page - 1) * perPage;

    const searchClause = search ? "WHERE name LIKE ? OR phone LIKE ? OR email LIKE ?" : "";
    const searchParams = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];

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

customersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const customer = await findCustomerById(Number(req.params.id));
    if (!customer) return res.status(404).json({ message: "Customer not found" });
    res.json({ customer });
  })
);

customersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { name, gstin, phone, email, billing_address, shipping_address, state } = req.body ?? {};
    if (!name) return res.status(400).json({ message: "Name is required" });

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
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findCustomerById(id);
    if (!existing) return res.status(404).json({ message: "Customer not found" });

    const { name, gstin, phone, email, billing_address, shipping_address, state } = req.body ?? {};
    if (!name) return res.status(400).json({ message: "Name is required" });

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
  requireRole("super_admin", "admin"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findCustomerById(id);
    if (!existing) return res.status(404).json({ message: "Customer not found" });

    await pool.query("DELETE FROM customers WHERE id = ?", [id]);
    res.json({ message: "Customer deleted" });
  })
);
