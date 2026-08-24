import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { Lead, LeadStatus } from "../types";

export const leadsRouter = Router();
const MODULE = "sales.leads";

leadsRouter.use(requireAuth);

const SOURCES = [
  "website",
  "referral",
  "cold_call",
  "walk_in",
  "advertisement",
  "social_media",
  "trade_show",
  "existing_customer",
  "other",
];
const STATUSES: LeadStatus[] = ["new", "contacted", "qualified", "proposal", "negotiation", "won", "lost"];

async function findLeadById(id: number): Promise<Lead | undefined> {
  const [rows] = await pool.query<any[]>("SELECT * FROM leads WHERE id = ? LIMIT 1", [id]);
  return rows[0] as Lead | undefined;
}

function pickFields(body: any) {
  const {
    name,
    contact_person,
    designation,
    phone,
    email,
    source,
    industry,
    estimated_value,
    expected_close_date,
    gstin,
    state,
    address,
    assigned_to,
    next_follow_up_date,
    notes,
  } = body ?? {};
  return {
    name,
    contact_person: contact_person || null,
    designation: designation || null,
    phone: phone || null,
    email: email || null,
    source: source && SOURCES.includes(source) ? source : "other",
    industry: industry || null,
    estimated_value: Number(estimated_value) || 0,
    expected_close_date: expected_close_date || null,
    gstin: gstin || null,
    state: state || null,
    address: address || null,
    assigned_to: assigned_to || null,
    next_follow_up_date: next_follow_up_date || null,
    notes: notes || null,
  };
}

// Lightweight "who can this be assigned to" list - deliberately not the
// admin-only /users endpoint, since any staff member with Leads access
// needs to see assignable teammates when creating/editing a lead.
leadsRouter.get(
  "/assignable-users",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (_req, res) => {
    const [rows] = await pool.query<any[]>(
      "SELECT id, name FROM users WHERE status = 'active' ORDER BY name ASC"
    );
    res.json({ data: rows });
  })
);

leadsRouter.get(
  "/",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const perPage = Math.min(Math.max(Number(req.query.perPage) || 10, 1), 100);
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const offset = (page - 1) * perPage;

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (search) {
      clauses.push("(l.name LIKE ? OR l.contact_person LIKE ? OR l.phone LIKE ? OR l.email LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (status && STATUSES.includes(status as LeadStatus)) {
      clauses.push("l.status = ?");
      params.push(status);
    }
    const whereClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const [rows] = await pool.query<any[]>(
      `SELECT l.*, u.name as assigned_to_name
       FROM leads l
       LEFT JOIN users u ON u.id = l.assigned_to
       ${whereClause}
       ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
      [...params, perPage, offset]
    );
    const [countRows] = await pool.query<any[]>(`SELECT COUNT(*) as total FROM leads l ${whereClause}`, params);

    res.json({ data: rows, meta: { page, perPage, total: countRows[0].total as number } });
  })
);

leadsRouter.get(
  "/:id",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const lead = await findLeadById(Number(req.params.id));
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    res.json({ lead });
  })
);

leadsRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const fields = pickFields(req.body);
    if (!fields.name) return res.status(400).json({ message: "Name is required" });

    if (fields.assigned_to) {
      const [userRows] = await pool.query<any[]>("SELECT id FROM users WHERE id = ?", [fields.assigned_to]);
      if (!userRows[0]) return res.status(400).json({ message: "Assigned user not found" });
    }

    const [result] = await pool.query<any>(
      `INSERT INTO leads
         (name, contact_person, designation, phone, email, source, industry, estimated_value,
          expected_close_date, gstin, state, address, assigned_to, next_follow_up_date, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fields.name,
        fields.contact_person,
        fields.designation,
        fields.phone,
        fields.email,
        fields.source,
        fields.industry,
        fields.estimated_value,
        fields.expected_close_date,
        fields.gstin,
        fields.state,
        fields.address,
        fields.assigned_to,
        fields.next_follow_up_date,
        fields.notes,
        req.user!.sub,
      ]
    );
    const created = await findLeadById(result.insertId);
    res.status(201).json({ lead: created });
  })
);

leadsRouter.put(
  "/:id",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findLeadById(id);
    if (!existing) return res.status(404).json({ message: "Lead not found" });

    const fields = pickFields(req.body);
    if (!fields.name) return res.status(400).json({ message: "Name is required" });

    if (fields.assigned_to) {
      const [userRows] = await pool.query<any[]>("SELECT id FROM users WHERE id = ?", [fields.assigned_to]);
      if (!userRows[0]) return res.status(400).json({ message: "Assigned user not found" });
    }

    await pool.query(
      `UPDATE leads SET
         name = ?, contact_person = ?, designation = ?, phone = ?, email = ?, source = ?, industry = ?,
         estimated_value = ?, expected_close_date = ?, gstin = ?, state = ?, address = ?, assigned_to = ?,
         next_follow_up_date = ?, notes = ?
       WHERE id = ?`,
      [
        fields.name,
        fields.contact_person,
        fields.designation,
        fields.phone,
        fields.email,
        fields.source,
        fields.industry,
        fields.estimated_value,
        fields.expected_close_date,
        fields.gstin,
        fields.state,
        fields.address,
        fields.assigned_to,
        fields.next_follow_up_date,
        fields.notes,
        id,
      ]
    );
    const updated = await findLeadById(id);
    res.json({ lead: updated });
  })
);

// Pipeline-stage change, kept separate from the full edit form (same pattern
// as PATCH /:id/status on sales documents) - a quick drag/click action, not
// a full re-save of every field. Moving to "lost" accepts an optional
// lost_reason alongside the new status.
leadsRouter.patch(
  "/:id/status",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { status, lost_reason } = req.body ?? {};
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }
    const existing = await findLeadById(id);
    if (!existing) return res.status(404).json({ message: "Lead not found" });

    await pool.query("UPDATE leads SET status = ?, lost_reason = ? WHERE id = ?", [
      status,
      status === "lost" ? lost_reason || null : null,
      id,
    ]);
    const updated = await findLeadById(id);
    res.json({ lead: updated });
  })
);

// Turns a qualified lead into a real Customer record (name/phone/email/
// gstin/state/address carried over so nothing needs retyping), links the
// two via converted_customer_id, and marks the lead "won". Requires create
// access on Customers as well as edit access on Leads, since it's really
// creating a Customer under the hood.
leadsRouter.post(
  "/:id/convert",
  requireModuleAccess(MODULE, "edit"),
  requireModuleAccess("contacts.customers", "create"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const lead = await findLeadById(id);
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    if (lead.converted_customer_id) {
      return res.status(400).json({ message: "This lead has already been converted" });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query<any>(
        `INSERT INTO customers (name, gstin, phone, email, billing_address, state)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [lead.name, lead.gstin, lead.phone, lead.email, lead.address, lead.state]
      );
      const customerId = result.insertId;
      await conn.query("UPDATE leads SET converted_customer_id = ?, status = 'won', lost_reason = NULL WHERE id = ?", [
        customerId,
        id,
      ]);
      await conn.commit();

      const [customerRows] = await pool.query<any[]>("SELECT * FROM customers WHERE id = ?", [customerId]);
      const updatedLead = await findLeadById(id);
      res.status(201).json({ lead: updatedLead, customer: customerRows[0] });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  })
);

leadsRouter.delete(
  "/:id",
  requireModuleAccess(MODULE, "delete"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findLeadById(id);
    if (!existing) return res.status(404).json({ message: "Lead not found" });

    await pool.query("DELETE FROM leads WHERE id = ?", [id]);
    res.json({ message: "Lead deleted" });
  })
);
