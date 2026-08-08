import crypto from "crypto";
import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess, getUserAccountIds, canAccessAccount } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { JournalEntry } from "../types";

export const journalEntriesRouter = Router();
const MODULE = "banking.accounts";
journalEntriesRouter.use(requireAuth);

async function findById(id: number): Promise<JournalEntry | undefined> {
  const [rows] = await pool.query<any[]>("SELECT * FROM journal_entries WHERE id = ? LIMIT 1", [id]);
  return rows[0] as JournalEntry | undefined;
}

journalEntriesRouter.get(
  "/",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const accountId = req.query.account_id ? Number(req.query.account_id) : null;
    const allowedIds = await getUserAccountIds(req.user!.sub, req.user!.role);
    if (accountId && allowedIds !== null && !allowedIds.includes(accountId)) {
      return res.status(403).json({ message: "You don't have access to this account" });
    }

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (accountId) {
      clauses.push("je.account_id = ?");
      params.push(accountId);
    }
    if (allowedIds !== null) {
      clauses.push(allowedIds.length ? "je.account_id IN (?)" : "1 = 0");
      if (allowedIds.length) params.push(allowedIds);
    }
    const whereClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const [rows] = await pool.query<any[]>(
      `SELECT je.*, a.name as account_name
       FROM journal_entries je
       JOIN accounts a ON a.id = je.account_id
       ${whereClause}
       ORDER BY je.entry_date DESC, je.id DESC`,
      params
    );
    res.json({ data: rows });
  })
);

journalEntriesRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const { account_id, entry_date, direction, amount, particulars, notes } = req.body ?? {};
    if (!account_id || !entry_date || !direction || !amount || !particulars) {
      return res.status(400).json({ message: "account_id, entry_date, direction, amount and particulars are required" });
    }
    if (!["in", "out"].includes(direction)) return res.status(400).json({ message: "direction must be 'in' or 'out'" });
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ message: "amount must be a positive number" });
    }
    if (!(await canAccessAccount(req.user!.sub, req.user!.role, Number(account_id)))) {
      return res.status(403).json({ message: "You don't have access to this account" });
    }

    const [accountRows] = await pool.query<any[]>("SELECT id FROM accounts WHERE id = ?", [account_id]);
    if (!accountRows[0]) return res.status(404).json({ message: "Account not found" });

    const [result] = await pool.query<any>(
      `INSERT INTO journal_entries (account_id, entry_date, direction, amount, particulars, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [account_id, entry_date, direction, amount, particulars, notes || null, req.user!.sub]
    );
    const created = await findById(result.insertId);
    res.status(201).json({ entry: created });
  })
);

journalEntriesRouter.delete(
  "/:id",
  requireModuleAccess(MODULE, "delete"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findById(id);
    if (!existing) return res.status(404).json({ message: "Journal entry not found" });
    if (!(await canAccessAccount(req.user!.sub, req.user!.role, existing.account_id))) {
      return res.status(403).json({ message: "You don't have access to this account" });
    }

    // A transfer is two linked entries (same transfer_group) - remove both
    // sides together so the books never end up with just one leg posted.
    if (existing.transfer_group) {
      await pool.query("DELETE FROM journal_entries WHERE transfer_group = ?", [existing.transfer_group]);
      return res.json({ message: "Transfer deleted (both entries)" });
    }

    await pool.query("DELETE FROM journal_entries WHERE id = ?", [id]);
    res.json({ message: "Journal entry deleted" });
  })
);

export const accountTransfersRouter = Router();
accountTransfersRouter.use(requireAuth);

accountTransfersRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const { from_account_id, to_account_id, amount, entry_date, notes } = req.body ?? {};
    if (!from_account_id || !to_account_id || !amount || !entry_date) {
      return res.status(400).json({ message: "from_account_id, to_account_id, amount and entry_date are required" });
    }
    if (Number(from_account_id) === Number(to_account_id)) {
      return res.status(400).json({ message: "Source and destination accounts must be different" });
    }
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ message: "amount must be a positive number" });
    }
    const [fromOk, toOk] = await Promise.all([
      canAccessAccount(req.user!.sub, req.user!.role, Number(from_account_id)),
      canAccessAccount(req.user!.sub, req.user!.role, Number(to_account_id)),
    ]);
    if (!fromOk || !toOk) {
      return res.status(403).json({ message: "You don't have access to one of these accounts" });
    }

    const [fromRows] = await pool.query<any[]>("SELECT * FROM accounts WHERE id = ?", [from_account_id]);
    const fromAccount = fromRows[0];
    if (!fromAccount) return res.status(404).json({ message: "Source account not found" });

    const [toRows] = await pool.query<any[]>("SELECT * FROM accounts WHERE id = ?", [to_account_id]);
    const toAccount = toRows[0];
    if (!toAccount) return res.status(404).json({ message: "Destination account not found" });

    const transferGroup = crypto.randomUUID();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO journal_entries (account_id, entry_date, direction, amount, particulars, notes, transfer_group, created_by)
         VALUES (?, ?, 'out', ?, ?, ?, ?, ?)`,
        [from_account_id, entry_date, amount, `Transfer to ${toAccount.name}`, notes || null, transferGroup, req.user!.sub]
      );
      await conn.query(
        `INSERT INTO journal_entries (account_id, entry_date, direction, amount, particulars, notes, transfer_group, created_by)
         VALUES (?, ?, 'in', ?, ?, ?, ?, ?)`,
        [to_account_id, entry_date, amount, `Transfer from ${fromAccount.name}`, notes || null, transferGroup, req.user!.sub]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    res.status(201).json({ message: "Transfer recorded", transferGroup });
  })
);
