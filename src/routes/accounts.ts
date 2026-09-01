import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess, getUserAccountIds } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import {
  AccountingError,
  getJournalBySource,
  getLedger,
  postAccountOpeningBalanceJournalTx,
  resolveBankCashChartAccountId,
  reverseJournalTx,
} from "../services/accounting";
import { Account, LedgerEntry } from "../types";

export const accountsRouter = Router();
const MODULE = "banking.accounts";
accountsRouter.use(requireAuth);

// Phase B: a Bank & Cash account's balance is now purely the net of every
// journal line ever posted against its linked Chart of Accounts node
// (accounts.chart_account_id) - Receipts, Vendor Payments, plain entries,
// transfers, and its own opening balance all flow through the same
// journals/journal_lines tables, so summing them here replaces the old
// opening_balance + receipts + vendor_payments + journal_entries
// hand-rolled formula entirely. Bank & Cash accounts are always debit-normal
// (Cash/Bank are Asset accounts), so debit-minus-credit is the balance
// directly, with no need to look up normal_balance dynamically here.
// A NULL chart_account_id (an account that has never had a single posting,
// including no opening balance) correlates to zero rows below and correctly
// yields 0 via COALESCE. Exported so dashboard.ts's own aggregate balance
// query can share this exact expression instead of drifting from it.
export const BALANCE_EXPR = `
  COALESCE((
    SELECT SUM(jl.debit) - SUM(jl.credit)
    FROM journal_lines jl
    WHERE jl.account_id = a.chart_account_id
  ), 0)
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

// Creating an account and posting its opening-balance journal must succeed
// or fail together - both writes share one connection/transaction, same
// reasoning as receipts.ts's own POST route.
accountsRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const { company_id, name, account_type, bank_name, account_number, ifsc, opening_balance } = req.body ?? {};
    if (!company_id || !name) return res.status(400).json({ message: "company_id and name are required" });
    if (account_type && !["cash", "bank"].includes(account_type)) {
      return res.status(400).json({ message: "account_type must be 'cash' or 'bank'" });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [result] = await conn.query<any>(
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
      const accountId = result.insertId;

      if (Number(opening_balance)) {
        await postAccountOpeningBalanceJournalTx(conn, {
          companyId: Number(company_id),
          accountId,
          amount: Number(opening_balance),
          openingDate: new Date().toISOString().slice(0, 10),
          createdBy: req.user!.sub,
        });
      }

      await conn.commit();
      const created = await findById(accountId);
      res.status(201).json({ account: created });
    } catch (err: any) {
      await conn.rollback();
      if (err?.code === "ER_DUP_ENTRY") {
        return res.status(400).json({ message: "An account with this name already exists for this company" });
      }
      if (err instanceof AccountingError) {
        return res.status(400).json({ message: `Account could not be created: ${err.message}` });
      }
      throw err;
    } finally {
      conn.release();
    }
  })
);

// A posted journal is never edited in place - if the opening balance
// changes, whatever opening-balance journal currently exists for this
// account (there's at most one, found via getJournalBySource) is reversed
// and a fresh one posted for the new figure, exactly like receipts.ts's own
// PUT route reverses-and-reposts on edit.
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

    const newOpeningBalance = opening_balance ?? existing.opening_balance;
    const openingBalanceChanged = Number(newOpeningBalance) !== Number(existing.opening_balance);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      await conn.query(
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
          newOpeningBalance,
          is_active === undefined ? existing.is_active : Boolean(is_active),
          id,
        ]
      );

      if (openingBalanceChanged) {
        const priorJournal = await getJournalBySource("account_opening_balance", id);
        if (priorJournal) {
          await reverseJournalTx(conn, priorJournal.id, req.user!.sub);
        }
        if (Number(newOpeningBalance)) {
          await postAccountOpeningBalanceJournalTx(conn, {
            companyId: existing.company_id,
            accountId: id,
            amount: Number(newOpeningBalance),
            openingDate: new Date().toISOString().slice(0, 10),
            createdBy: req.user!.sub,
          });
        }
      }

      await conn.commit();
      const updated = await findById(id);
      res.json({ account: updated });
    } catch (err: any) {
      await conn.rollback();
      if (err?.code === "ER_DUP_ENTRY") {
        return res.status(400).json({ message: "An account with this name already exists for this company" });
      }
      if (err instanceof AccountingError) {
        return res.status(400).json({ message: `Account could not be updated: ${err.message}` });
      }
      throw err;
    } finally {
      conn.release();
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

    // "Activity" now includes any journal ever posted against this
    // account's linked Chart of Accounts node - Receipts, Vendor Payments,
    // plain entries, transfers, AND its own opening balance. An account
    // that only ever had a non-zero opening balance is therefore no longer
    // deletable (it used to be, back when opening_balance was just a
    // static column) - a real, if narrow, behaviour tightening, and the
    // correct one: deleting it now would silently orphan a real journal.
    const [journalRows] = await pool.query<any[]>(
      `SELECT COUNT(*) as c FROM journal_lines jl WHERE jl.account_id = ?`,
      [existing.chart_account_id ?? 0]
    );
    const [[receiptCount], [paymentCount]] = await Promise.all([
      pool.query<any[]>("SELECT COUNT(*) as c FROM receipts WHERE account_id = ?", [id]),
      pool.query<any[]>("SELECT COUNT(*) as c FROM vendor_payments WHERE account_id = ?", [id]),
    ]);
    const hasActivity = receiptCount[0].c > 0 || paymentCount[0].c > 0 || journalRows[0].c > 0;
    if (hasActivity) {
      return res.status(400).json({ message: "This account has transactions recorded against it and can't be deleted" });
    }

    await pool.query("DELETE FROM accounts WHERE id = ?", [id]);
    res.json({ message: "Account deleted" });
  })
);

const SOURCE_TYPE_TO_LEDGER: Record<string, LedgerEntry["source_type"]> = {
  receipt: "receipt",
  vendor_payment: "vendor_payment",
  bank_cash_entry: "bank_cash_entry",
  account_transfer: "account_transfer",
  account_opening_balance: "account_opening_balance",
};

// Chronological ledger for one account, now a thin adapter over the real
// double-entry General Ledger (getLedger, keyed by this account's linked
// Chart of Accounts node) instead of a hand-rolled UNION of
// receipts/vendor_payments/journal_entries - Receipts and Vendor Payments
// already posted journals against this node before Phase B, so this single
// query picks up everything Phase B's own postings add for free, with
// correct reversal handling included (getLedger already folds a reversed
// journal's own lines into the running balance without displaying them
// twice - see its own comment in accounting.ts).
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

    const chartAccountId = await resolveBankCashChartAccountId(id);
    if (!chartAccountId) {
      // No linked Chart of Accounts node yet means literally nothing has
      // ever been posted against this account (not even an opening
      // balance) - an empty ledger, not an error.
      return res.json({ account, openingBalance: 0, entries: [] as LedgerEntry[], closingBalance: 0 });
    }

    const result = await getLedger(chartAccountId);
    const entries: LedgerEntry[] = result.entries
      .filter((e) => e.source_type && e.source_type in SOURCE_TYPE_TO_LEDGER)
      .map((e) => {
        const debit = e.debit;
        const isIn = debit > 0;
        return {
          id: e.journal_id,
          source_type: SOURCE_TYPE_TO_LEDGER[e.source_type as string],
          source_id: e.source_id ?? e.journal_id,
          entry_date: e.journal_date,
          direction: isIn ? "in" : "out",
          amount: isIn ? debit : e.credit,
          particulars: e.description || "-",
          running_balance: e.running_balance,
        };
      });

    res.json({ account, openingBalance: result.openingBalance, entries, closingBalance: result.closingBalance });
  })
);
