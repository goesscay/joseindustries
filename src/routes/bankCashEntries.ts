import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess, canAccessAccount } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import {
  AccountingError,
  getJournalById,
  getJournalLines,
  postAccountTransferJournalTx,
  postBankCashEntryJournalTx,
  reverseJournal,
} from "../services/accounting";

// Phase B replacement for the old journal_entries table's two flows - a
// plain in/out entry against one Bank & Cash account (needs a user-chosen
// contra account, since real double-entry has no fixed "other side" the
// way a Receipt/Vendor Payment does), and a transfer between two of a
// company's own accounts (the contra is just the other account, so the UI
// only ever asks for From/To/Amount). Both post through
// src/services/accounting.ts's createJournalTx exactly like every other
// document type, and both are reversed - never deleted - via their own
// dedicated endpoint below, gated on the SAME "banking.accounts" module a
// Bank & Cash user already has, rather than requiring the separate
// "accounting.journals" permission the generic /journals/:id/reverse
// endpoint needs.

export const bankCashEntriesRouter = Router();
const MODULE = "banking.accounts";
bankCashEntriesRouter.use(requireAuth);

bankCashEntriesRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const { account_id, contra_account_id, entry_date, direction, amount, particulars, notes } = req.body ?? {};
    if (!account_id || !contra_account_id || !entry_date || !direction || !amount || !particulars) {
      return res.status(400).json({
        message: "account_id, contra_account_id, entry_date, direction, amount and particulars are required",
      });
    }
    if (!["in", "out"].includes(direction)) return res.status(400).json({ message: "direction must be 'in' or 'out'" });
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ message: "amount must be a positive number" });
    }
    if (!(await canAccessAccount(req.user!.sub, req.user!.role, Number(account_id)))) {
      return res.status(403).json({ message: "You don't have access to this account" });
    }

    const [accountRows] = await pool.query<any[]>("SELECT id, company_id FROM accounts WHERE id = ?", [account_id]);
    const account = accountRows[0];
    if (!account) return res.status(404).json({ message: "Account not found" });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const journal = await postBankCashEntryJournalTx(conn, {
        companyId: account.company_id,
        accountId: Number(account_id),
        contraAccountId: Number(contra_account_id),
        direction,
        amount: Number(amount),
        entryDate: entry_date,
        particulars,
        notes: notes || null,
        createdBy: req.user!.sub,
      });
      await conn.commit();
      const lines = await getJournalLines(journal.id);
      res.status(201).json({ journal, lines });
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError) return res.status(400).json({ message: `Entry could not be recorded: ${err.message}` });
      throw err;
    } finally {
      conn.release();
    }
  })
);

// Never a literal DELETE - reverses the journal (posts an offsetting entry,
// keeps the original for the audit trail), same convention as every other
// document type in this app.
bankCashEntriesRouter.delete(
  "/:journalId",
  requireModuleAccess(MODULE, "delete"),
  asyncHandler(async (req, res) => {
    const journalId = Number(req.params.journalId);
    const journal = await getJournalById(journalId);
    if (!journal || journal.source_type !== "bank_cash_entry") {
      return res.status(404).json({ message: "Entry not found" });
    }
    const lines = await getJournalLines(journalId);
    const accountIds = await resolveAccountsForChartLines(journal.company_id, lines.map((l) => l.account_id));
    for (const accountId of accountIds) {
      if (!(await canAccessAccount(req.user!.sub, req.user!.role, accountId))) {
        return res.status(403).json({ message: "You don't have access to this account" });
      }
    }

    try {
      const reversal = await reverseJournal(journalId, req.user!.sub);
      res.json({ message: "Entry deleted", journal: reversal });
    } catch (err) {
      if (err instanceof AccountingError) return res.status(400).json({ message: err.message });
      throw err;
    }
  })
);

// Resolves which Bank & Cash `accounts` rows (if any) a set of journal
// lines' Chart of Accounts ids correspond to, so the reverse routes can
// re-check per-account access the same way creation did - a line whose
// account isn't a Bank & Cash node at all (shouldn't happen for these two
// source types, but defensive) is simply skipped.
async function resolveAccountsForChartLines(companyId: number, chartAccountIds: number[]): Promise<number[]> {
  if (chartAccountIds.length === 0) return [];
  const [rows] = await pool.query<any[]>(
    "SELECT id FROM accounts WHERE company_id = ? AND chart_account_id IN (?)",
    [companyId, chartAccountIds]
  );
  return rows.map((r) => r.id as number);
}

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

    if (Number(fromAccount.company_id) !== Number(toAccount.company_id)) {
      return res.status(400).json({ message: "Both accounts must belong to the same company" });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const journal = await postAccountTransferJournalTx(conn, {
        companyId: fromAccount.company_id,
        fromAccountId: Number(from_account_id),
        toAccountId: Number(to_account_id),
        amount: Number(amount),
        entryDate: entry_date,
        fromAccountName: fromAccount.name,
        toAccountName: toAccount.name,
        notes: notes || null,
        createdBy: req.user!.sub,
      });
      await conn.commit();
      res.status(201).json({ message: "Transfer recorded", journal });
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError) return res.status(400).json({ message: `Transfer could not be recorded: ${err.message}` });
      throw err;
    } finally {
      conn.release();
    }
  })
);

accountTransfersRouter.delete(
  "/:journalId",
  requireModuleAccess(MODULE, "delete"),
  asyncHandler(async (req, res) => {
    const journalId = Number(req.params.journalId);
    const journal = await getJournalById(journalId);
    if (!journal || journal.source_type !== "account_transfer") {
      return res.status(404).json({ message: "Transfer not found" });
    }
    const lines = await getJournalLines(journalId);
    const accountIds = await resolveAccountsForChartLines(journal.company_id, lines.map((l) => l.account_id));
    for (const accountId of accountIds) {
      if (!(await canAccessAccount(req.user!.sub, req.user!.role, accountId))) {
        return res.status(403).json({ message: "You don't have access to one of these accounts" });
      }
    }

    try {
      const reversal = await reverseJournal(journalId, req.user!.sub);
      res.json({ message: "Transfer deleted (both entries)", journal: reversal });
    } catch (err) {
      if (err instanceof AccountingError) return res.status(400).json({ message: err.message });
      throw err;
    }
  })
);
