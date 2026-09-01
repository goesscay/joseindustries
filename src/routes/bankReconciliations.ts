import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess, canAccessAccount, getUserAccountIds } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { resolveBankCashChartAccountId } from "../services/accounting";
import { BankReconciliation } from "../types";

// Double-entry rollout, Phase E: Bank Reconciliation. Matches one Bank/Cash
// account's book-side ledger against a real-world bank statement as of a
// chosen date - see schema.sql's comment on bank_reconciliations for the
// full design (why reconciliation state lives on journal_lines directly,
// and how src/services/accounting.ts's insertReversalRows refuses to
// reverse an already-reconciled line).
export const bankReconciliationsRouter = Router();
const MODULE = "banking.reconciliation";
bankReconciliationsRouter.use(requireAuth);

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

class ValidationError extends Error {
  status = 400;
}

async function findById(id: number): Promise<BankReconciliation | undefined> {
  const [rows] = await pool.query<any[]>(
    `SELECT br.*, a.name as account_name, co.name as company_name, co.code as company_code
     FROM bank_reconciliations br
     JOIN accounts a ON a.id = br.account_id
     JOIN companies co ON co.id = br.company_id
     WHERE br.id = ? LIMIT 1`,
    [id]
  );
  return rows[0] as BankReconciliation | undefined;
}

interface WorksheetLine {
  id: number;
  journal_id: number;
  journal_date: string;
  description: string | null;
  source_type: string | null;
  source_id: number | null;
  debit: number;
  credit: number;
}

/**
 * The reconciliation worksheet for one bank_reconciliations row: the book
 * balance already locked in by earlier, completed reconciliations
 * (openingBalance), the lines this reconciliation has cleared so far
 * (clearedLines - toggled via PATCH /:id/lines), and the candidate lines
 * still available to clear (unclearedLines - posted, dated on or before the
 * statement date, never reconciled by any reconciliation). Bank/Cash
 * accounts are always debit-normal (see accounts.ts's own BALANCE_EXPR), so
 * debit-minus-credit is a line's signed contribution directly, with no need
 * to look up normal_balance dynamically.
 */
async function buildWorksheet(reconciliation: BankReconciliation, chartAccountId: number) {
  const [openingRows] = await pool.query<any[]>(
    `SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) as total
     FROM journal_lines jl
     WHERE jl.account_id = ? AND jl.reconciled_at IS NOT NULL AND jl.bank_reconciliation_id != ?`,
    [chartAccountId, reconciliation.id]
  );
  const openingBalance = round2(Number(openingRows[0].total));

  const [clearedRows] = await pool.query<any[]>(
    `SELECT jl.id, jl.journal_id, jl.debit, jl.credit, jl.description as line_description,
            j.journal_date, j.description as journal_description, j.source_type, j.source_id
     FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
     WHERE jl.bank_reconciliation_id = ?
     ORDER BY j.journal_date ASC, jl.id ASC`,
    [reconciliation.id]
  );
  const [unclearedRows] = await pool.query<any[]>(
    `SELECT jl.id, jl.journal_id, jl.debit, jl.credit, jl.description as line_description,
            j.journal_date, j.description as journal_description, j.source_type, j.source_id
     FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
     WHERE jl.account_id = ? AND jl.bank_reconciliation_id IS NULL AND j.status = 'posted'
       AND j.journal_date <= ?
     ORDER BY j.journal_date ASC, jl.id ASC`,
    [chartAccountId, reconciliation.statement_date]
  );

  const mapLine = (r: any): WorksheetLine => ({
    id: r.id,
    journal_id: r.journal_id,
    journal_date: r.journal_date,
    description: r.line_description || r.journal_description,
    source_type: r.source_type,
    source_id: r.source_id,
    debit: Number(r.debit),
    credit: Number(r.credit),
  });

  const clearedLines = clearedRows.map(mapLine);
  const unclearedLines = unclearedRows.map(mapLine);
  const clearedTotal = round2(clearedLines.reduce((sum, l) => sum + (l.debit - l.credit), 0));
  const difference = round2(Number(reconciliation.statement_balance) - (openingBalance + clearedTotal));

  return { reconciliation, openingBalance, clearedLines, unclearedLines, clearedTotal, difference };
}

bankReconciliationsRouter.get(
  "/",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const accountId = req.query.account_id ? Number(req.query.account_id) : null;
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    if (accountId && !(await canAccessAccount(req.user!.sub, req.user!.role, accountId))) {
      return res.status(403).json({ message: "You don't have access to this account" });
    }
    const allowedIds = await getUserAccountIds(req.user!.sub, req.user!.role);

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (accountId) {
      clauses.push("br.account_id = ?");
      params.push(accountId);
    }
    if (companyId) {
      clauses.push("br.company_id = ?");
      params.push(companyId);
    }
    if (allowedIds !== null) {
      clauses.push(allowedIds.length ? "br.account_id IN (?)" : "1 = 0");
      if (allowedIds.length) params.push(allowedIds);
    }
    const whereClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const [rows] = await pool.query<any[]>(
      `SELECT br.*, a.name as account_name, co.name as company_name, co.code as company_code
       FROM bank_reconciliations br
       JOIN accounts a ON a.id = br.account_id
       JOIN companies co ON co.id = br.company_id
       ${whereClause}
       ORDER BY br.statement_date DESC, br.id DESC`,
      params
    );
    res.json({ data: rows as BankReconciliation[] });
  })
);

bankReconciliationsRouter.get(
  "/:id",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const reconciliation = await findById(Number(req.params.id));
    if (!reconciliation) return res.status(404).json({ message: "Reconciliation not found" });
    if (!(await canAccessAccount(req.user!.sub, req.user!.role, reconciliation.account_id))) {
      return res.status(403).json({ message: "You don't have access to this account" });
    }
    const chartAccountId = await resolveBankCashChartAccountId(reconciliation.account_id);
    if (!chartAccountId) return res.status(404).json({ message: "This account has no ledger activity" });
    res.json(await buildWorksheet(reconciliation, chartAccountId));
  })
);

bankReconciliationsRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const { account_id, statement_date, statement_balance } = req.body ?? {};
    if (!account_id || !statement_date || statement_balance === undefined || statement_balance === null) {
      return res.status(400).json({ message: "account_id, statement_date and statement_balance are required" });
    }
    if (!(await canAccessAccount(req.user!.sub, req.user!.role, Number(account_id)))) {
      return res.status(403).json({ message: "You don't have access to this account" });
    }
    const [accountRows] = await pool.query<any[]>("SELECT * FROM accounts WHERE id = ?", [account_id]);
    const account = accountRows[0];
    if (!account) return res.status(404).json({ message: "Account not found" });

    const chartAccountId = await resolveBankCashChartAccountId(Number(account_id));
    if (!chartAccountId) {
      return res.status(400).json({ message: "This account has no postings yet - there is nothing to reconcile" });
    }

    const [existingRows] = await pool.query<any[]>(
      "SELECT id FROM bank_reconciliations WHERE account_id = ? AND status = 'in_progress' LIMIT 1",
      [account_id]
    );
    if (existingRows[0]) {
      return res.status(400).json({
        message: `This account already has an in-progress reconciliation (#${existingRows[0].id}) - finish or delete it first`,
      });
    }

    const [result] = await pool.query<any>(
      `INSERT INTO bank_reconciliations (account_id, company_id, statement_date, statement_balance, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [account_id, account.company_id, statement_date, statement_balance, req.user!.sub]
    );
    const created = (await findById(result.insertId))!;
    res.status(201).json(await buildWorksheet(created, chartAccountId));
  })
);

// Edits the statement_date/statement_balance of an in-progress
// reconciliation (e.g. correcting a typo before finishing) - never once
// completed, matching how a completed reconciliation is otherwise locked.
bankReconciliationsRouter.patch(
  "/:id",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const reconciliation = await findById(id);
    if (!reconciliation) return res.status(404).json({ message: "Reconciliation not found" });
    if (!(await canAccessAccount(req.user!.sub, req.user!.role, reconciliation.account_id))) {
      return res.status(403).json({ message: "You don't have access to this account" });
    }
    if (reconciliation.status !== "in_progress") {
      return res.status(400).json({ message: "This reconciliation is completed - reopen it first to make changes" });
    }
    const { statement_date, statement_balance } = req.body ?? {};
    await pool.query(
      `UPDATE bank_reconciliations SET
         statement_date = COALESCE(?, statement_date),
         statement_balance = COALESCE(?, statement_balance)
       WHERE id = ?`,
      [statement_date || null, statement_balance ?? null, id]
    );
    const updated = (await findById(id))!;
    const chartAccountId = await resolveBankCashChartAccountId(updated.account_id);
    res.json(await buildWorksheet(updated, chartAccountId!));
  })
);

// Toggles which journal_lines this in-progress reconciliation has matched
// to the bank statement. `clear` picks up brand-new lines (must currently
// be untouched by any reconciliation); `unclear` releases lines this same
// reconciliation had already claimed. Both directions are validated by row
// count so a stale/invalid id never silently no-ops.
bankReconciliationsRouter.patch(
  "/:id/lines",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const reconciliation = await findById(id);
    if (!reconciliation) return res.status(404).json({ message: "Reconciliation not found" });
    if (!(await canAccessAccount(req.user!.sub, req.user!.role, reconciliation.account_id))) {
      return res.status(403).json({ message: "You don't have access to this account" });
    }
    if (reconciliation.status !== "in_progress") {
      return res.status(400).json({ message: "This reconciliation is completed - reopen it first to make changes" });
    }
    const chartAccountId = await resolveBankCashChartAccountId(reconciliation.account_id);
    if (!chartAccountId) return res.status(404).json({ message: "This account has no ledger activity" });

    const clear: number[] = Array.isArray(req.body?.clear) ? req.body.clear.map(Number) : [];
    const unclear: number[] = Array.isArray(req.body?.unclear) ? req.body.unclear.map(Number) : [];
    if (clear.length === 0 && unclear.length === 0) {
      return res.status(400).json({ message: "Provide at least one line id to clear or unclear" });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      if (clear.length) {
        const [result] = await conn.query<any>(
          `UPDATE journal_lines jl JOIN journals j ON j.id = jl.journal_id
           SET jl.reconciled_at = NOW(), jl.bank_reconciliation_id = ?
           WHERE jl.id IN (?) AND jl.account_id = ? AND jl.bank_reconciliation_id IS NULL
             AND j.status = 'posted' AND j.journal_date <= ?`,
          [id, clear, chartAccountId, reconciliation.statement_date]
        );
        if (result.affectedRows !== clear.length) {
          throw new ValidationError(
            "One or more selected entries are not eligible to clear (already reconciled, reversed, or dated after the statement date)"
          );
        }
      }
      if (unclear.length) {
        const [result] = await conn.query<any>(
          `UPDATE journal_lines SET reconciled_at = NULL, bank_reconciliation_id = NULL
           WHERE id IN (?) AND bank_reconciliation_id = ?`,
          [unclear, id]
        );
        if (result.affectedRows !== unclear.length) {
          throw new ValidationError("One or more selected entries are not part of this reconciliation");
        }
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      if (err instanceof ValidationError) return res.status(err.status).json({ message: err.message });
      throw err;
    } finally {
      conn.release();
    }

    const updated = (await findById(id))!;
    res.json(await buildWorksheet(updated, chartAccountId));
  })
);

// Finishing is refused unless the statement balance and the cleared book
// balance match exactly - recomputed server-side, never trusting whatever
// difference the client last displayed. This is the one real control this
// whole feature exists to enforce.
bankReconciliationsRouter.post(
  "/:id/complete",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const reconciliation = await findById(id);
    if (!reconciliation) return res.status(404).json({ message: "Reconciliation not found" });
    if (!(await canAccessAccount(req.user!.sub, req.user!.role, reconciliation.account_id))) {
      return res.status(403).json({ message: "You don't have access to this account" });
    }
    if (reconciliation.status !== "in_progress") {
      return res.status(400).json({ message: "This reconciliation is already completed" });
    }
    const chartAccountId = await resolveBankCashChartAccountId(reconciliation.account_id);
    if (!chartAccountId) return res.status(404).json({ message: "This account has no ledger activity" });

    const worksheet = await buildWorksheet(reconciliation, chartAccountId);
    if (Math.abs(worksheet.difference) > 0.01) {
      return res.status(400).json({
        message: `Statement balance and cleared book balance don't match yet (difference: Rs. ${worksheet.difference.toFixed(2)})`,
      });
    }

    await pool.query("UPDATE bank_reconciliations SET status = 'completed', completed_at = NOW() WHERE id = ?", [id]);
    const updated = (await findById(id))!;
    res.json(await buildWorksheet(updated, chartAccountId));
  })
);

// Puts a completed reconciliation back in_progress WITHOUT blanket-unclearing
// its lines - see schema.sql's comment on bank_reconciliations. The user
// then un-clears only the specific line(s) that actually need fixing via
// PATCH /:id/lines before re-completing.
bankReconciliationsRouter.post(
  "/:id/reopen",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const reconciliation = await findById(id);
    if (!reconciliation) return res.status(404).json({ message: "Reconciliation not found" });
    if (!(await canAccessAccount(req.user!.sub, req.user!.role, reconciliation.account_id))) {
      return res.status(403).json({ message: "You don't have access to this account" });
    }
    if (reconciliation.status !== "completed") {
      return res.status(400).json({ message: "Only a completed reconciliation can be reopened" });
    }
    await pool.query("UPDATE bank_reconciliations SET status = 'in_progress', completed_at = NULL WHERE id = ?", [id]);
    const updated = (await findById(id))!;
    const chartAccountId = await resolveBankCashChartAccountId(updated.account_id);
    res.json(await buildWorksheet(updated, chartAccountId!));
  })
);

// Abandons an in-progress reconciliation entirely - releases every line it
// had claimed back to unreconciled, then removes the row. Mirrors Credit/
// Debit Notes' "draft-only delete" - a completed reconciliation is never
// deleted, only reopened (which is itself reversible by re-completing).
bankReconciliationsRouter.delete(
  "/:id",
  requireModuleAccess(MODULE, "delete"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const reconciliation = await findById(id);
    if (!reconciliation) return res.status(404).json({ message: "Reconciliation not found" });
    if (!(await canAccessAccount(req.user!.sub, req.user!.role, reconciliation.account_id))) {
      return res.status(403).json({ message: "You don't have access to this account" });
    }
    if (reconciliation.status !== "in_progress") {
      return res.status(400).json({ message: "A completed reconciliation can't be deleted - reopen it first" });
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query("UPDATE journal_lines SET reconciled_at = NULL, bank_reconciliation_id = NULL WHERE bank_reconciliation_id = ?", [id]);
      await conn.query("DELETE FROM bank_reconciliations WHERE id = ?", [id]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    res.json({ message: "Reconciliation deleted" });
  })
);
