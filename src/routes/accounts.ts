import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess, getUserAccountIds } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { Account, JournalDirection, LedgerEntry } from "../types";

export const accountsRouter = Router();
const MODULE = "banking.accounts";
accountsRouter.use(requireAuth);

const BALANCE_EXPR = `
  a.opening_balance
  + COALESCE((SELECT SUM(r.amount) FROM receipts r WHERE r.account_id = a.id), 0)
  - COALESCE((SELECT SUM(vp.amount) FROM vendor_payments vp WHERE vp.account_id = a.id), 0)
  + COALESCE((SELECT SUM(CASE WHEN je.direction = 'in' THEN je.amount ELSE -je.amount END)
              FROM journal_entries je WHERE je.account_id = a.id), 0)
`;

async function findById(id: number): Promise<Account | undefined> {
  const [rows] = await pool.query<any[]>(
    `SELECT a.*, (${BALANCE_EXPR}) as balance FROM accounts a WHERE a.id = ? LIMIT 1`,
    [id]
  );
  return rows[0] as Account | undefined;
}

accountsRouter.get(
  "/",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const allowedIds = await getUserAccountIds(req.user!.sub, req.user!.role);

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (companyId) {
      clauses.push("a.company_id = ?");
      params.push(companyId);
    }
    if (allowedIds !== null) {
      // Scoped to specific accounts (see user_account_access) - an empty
      // allowlist means literally no accounts, so short-circuit with a
      // clause that can never match rather than an invalid empty IN ().
      clauses.push(allowedIds.length ? "a.id IN (?)" : "1 = 0");
      if (allowedIds.length) params.push(allowedIds);
    }
    const whereClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const [rows] = await pool.query<any[]>(
      `SELECT a.*, co.name as company_name, co.code as company_code, (${BALANCE_EXPR}) as balance
       FROM accounts a
       JOIN companies co ON co.id = a.company_id
       ${whereClause}
       ORDER BY co.code ASC, a.account_type ASC, a.name ASC`,
      params
    );
    res.json({ data: rows as Account[] });
  })
);

accountsRouter.get(
  "/:id",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const allowedIds = await getUserAccountIds(req.user!.sub, req.user!.role);
    if (allowedIds !== null && !allowedIds.includes(id)) {
      return res.status(403).json({ message: "You don't have access to this account" });
    }
    const account = await findById(id);
    if (!account) return res.status(404).json({ message: "Account not found" });
    res.json({ account });
  })
);

accountsRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const { company_id, name, account_type, bank_name, account_number, ifsc, opening_balance } = req.body ?? {};
    if (!company_id || !name) return res.status(400).json({ message: "company_id and name are required" });
    if (account_type && !["cash", "bank"].includes(account_type)) {
      return res.status(400).json({ message: "account_type must be 'cash' or 'bank'" });
    }

    try {
      const [result] = await pool.query<any>(
        `INSERT INTO accounts (company_id, name, account_type, bank_name, account_number, ifsc, opening_balance)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          company_id,
          name,
          account_type || "bank",
          bank_name || null,
          account_number || null,
          ifsc || null,
          opening_balance || 0,
        ]
      );
      const created = await findById(result.insertId);
      res.status(201).json({ account: created });
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY") {
        return res.status(400).json({ message: "An account with this name already exists for this company" });
      }
      throw err;
    }
  })
);

accountsRouter.put(
  "/:id",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const allowedIds = await getUserAccountIds(req.user!.sub, req.user!.role);
    if (allowedIds !== null && !allowedIds.includes(id)) {
      return res.status(403).json({ message: "You don't have access to this account" });
    }
    const existing = await findById(id);
    if (!existing) return res.status(404).json({ message: "Account not found" });

    const { name, account_type, bank_name, account_number, ifsc, opening_balance, is_active } = req.body ?? {};
    if (!name) return res.status(400).json({ message: "Name is required" });
    if (account_type && !["cash", "bank"].includes(account_type)) {
      return res.status(400).json({ message: "account_type must be 'cash' or 'bank'" });
    }

    try {
      await pool.query(
        `UPDATE accounts SET
           name = ?, account_type = ?, bank_name = ?, account_number = ?, ifsc = ?,
           opening_balance = ?, is_active = ?
         WHERE id = ?`,
        [
          name,
          account_type || existing.account_type,
          bank_name || null,
          account_number || null,
          ifsc || null,
          opening_balance ?? existing.opening_balance,
          is_active === undefined ? existing.is_active : Boolean(is_active),
          id,
        ]
      );
      const updated = await findById(id);
      res.json({ account: updated });
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY") {
        return res.status(400).json({ message: "An account with this name already exists for this company" });
      }
      throw err;
    }
  })
);

accountsRouter.delete(
  "/:id",
  requireModuleAccess(MODULE, "delete"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const allowedIds = await getUserAccountIds(req.user!.sub, req.user!.role);
    if (allowedIds !== null && !allowedIds.includes(id)) {
      return res.status(403).json({ message: "You don't have access to this account" });
    }
    const existing = await findById(id);
    if (!existing) return res.status(404).json({ message: "Account not found" });

    const [[receiptCount], [paymentCount], [journalCount]] = await Promise.all([
      pool.query<any[]>("SELECT COUNT(*) as c FROM receipts WHERE account_id = ?", [id]),
      pool.query<any[]>("SELECT COUNT(*) as c FROM vendor_payments WHERE account_id = ?", [id]),
      pool.query<any[]>("SELECT COUNT(*) as c FROM journal_entries WHERE account_id = ?", [id]),
    ]);
    const hasActivity = receiptCount[0].c > 0 || paymentCount[0].c > 0 || journalCount[0].c > 0;
    if (hasActivity) {
      return res.status(400).json({ message: "This account has transactions recorded against it and can't be deleted" });
    }

    await pool.query("DELETE FROM accounts WHERE id = ?", [id]);
    res.json({ message: "Account deleted" });
  })
);

// Chronological ledger for one account - Receipts (in), Vendor Payments
// (out), and Journal Entries (either), merged and given a running balance
// starting from the account's opening balance.
accountsRouter.get(
  "/:id/ledger",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const allowedIds = await getUserAccountIds(req.user!.sub, req.user!.role);
    if (allowedIds !== null && !allowedIds.includes(id)) {
      return res.status(403).json({ message: "You don't have access to this account" });
    }
    const account = await findById(id);
    if (!account) return res.status(404).json({ message: "Account not found" });

    const [receipts] = await pool.query<any[]>(
      `SELECT r.id, r.received_date as entry_date, r.amount, r.reference_no, r.created_at,
              c.name as customer_name
       FROM receipts r JOIN customers c ON c.id = r.customer_id
       WHERE r.account_id = ?`,
      [id]
    );
    const [payments] = await pool.query<any[]>(
      `SELECT p.id, p.paid_date as entry_date, p.amount, p.reference_no, p.created_at,
              v.name as vendor_name
       FROM vendor_payments p JOIN vendors v ON v.id = p.vendor_id
       WHERE p.account_id = ?`,
      [id]
    );
    const [journalRows] = await pool.query<any[]>(
      `SELECT id, entry_date, direction, amount, particulars, created_at FROM journal_entries WHERE account_id = ?`,
      [id]
    );

    type RawEntry = {
      id: number;
      source_type: LedgerEntry["source_type"];
      entry_date: string;
      created_at: string;
      direction: JournalDirection;
      amount: number;
      particulars: string;
    };

    const combined: RawEntry[] = [
      ...receipts.map((r): RawEntry => ({
        id: r.id,
        source_type: "receipt",
        entry_date: r.entry_date,
        created_at: r.created_at,
        direction: "in",
        amount: Number(r.amount),
        particulars: `Receipt from ${r.customer_name}${r.reference_no ? ` (${r.reference_no})` : ""}`,
      })),
      ...payments.map((p): RawEntry => ({
        id: p.id,
        source_type: "vendor_payment",
        entry_date: p.entry_date,
        created_at: p.created_at,
        direction: "out",
        amount: Number(p.amount),
        particulars: `Payment to ${p.vendor_name}${p.reference_no ? ` (${p.reference_no})` : ""}`,
      })),
      ...journalRows.map((j): RawEntry => ({
        id: j.id,
        source_type: "journal_entry",
        entry_date: j.entry_date,
        created_at: j.created_at,
        direction: j.direction,
        amount: Number(j.amount),
        particulars: j.particulars,
      })),
    ];

    combined.sort((a, b) => {
      const dateCompare = new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime();
      if (dateCompare !== 0) return dateCompare;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

    const openingBalance = Number(account.opening_balance);
    let running = openingBalance;
    const entries: LedgerEntry[] = combined.map((e) => {
      running += e.direction === "in" ? e.amount : -e.amount;
      return {
        id: e.id,
        source_type: e.source_type,
        source_id: e.id,
        entry_date: e.entry_date,
        direction: e.direction,
        amount: e.amount,
        particulars: e.particulars,
        running_balance: running,
      };
    });

    res.json({ account, openingBalance, entries, closingBalance: running });
  })
);
