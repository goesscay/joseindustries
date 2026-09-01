import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { getFinancialYear, getFinancialYearBounds, getNextFinancialYear, getPreviousFinancialYear } from "../services/financialYear";
import { AccountingError, getProfitAndLoss, postYearEndClosingJournalTx, reverseJournalTx } from "../services/accounting";
import { FinancialYearClosing } from "../types";

// Double-entry rollout, Phase G: Year-End Closing / Period Lock - see
// schema.sql's comment on financial_year_closings for the full design
// (strict chronological ordering, LIFO-only reopening, and how this table's
// existence is what actually blocks new/reversed postings via
// src/services/accounting.ts's getLockedThroughDate).
export const financialYearClosingsRouter = Router();
const MODULE = "accounting.year_end_closing";
financialYearClosingsRouter.use(requireAuth);

class ValidationError extends Error {
  status = 400;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const FY_PATTERN = /^\d{2}-\d{2}$/;

async function findLatestClosed(companyId: number): Promise<FinancialYearClosing | undefined> {
  const [rows] = await pool.query<any[]>(
    "SELECT * FROM financial_year_closings WHERE company_id = ? AND status = 'closed' ORDER BY end_date DESC LIMIT 1",
    [companyId]
  );
  return rows[0] as FinancialYearClosing | undefined;
}

async function findByCompanyAndYear(companyId: number, financialYear: string): Promise<FinancialYearClosing | undefined> {
  const [rows] = await pool.query<any[]>(
    "SELECT * FROM financial_year_closings WHERE company_id = ? AND financial_year = ? LIMIT 1",
    [companyId, financialYear]
  );
  return rows[0] as FinancialYearClosing | undefined;
}

financialYearClosingsRouter.get(
  "/",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    if (!companyId) return res.status(400).json({ message: "company_id is required" });
    const [rows] = await pool.query<any[]>(
      "SELECT * FROM financial_year_closings WHERE company_id = ? ORDER BY end_date DESC",
      [companyId]
    );
    res.json({ data: rows as FinancialYearClosing[] });
  })
);

// Drives the "Close Financial Year" UI: what's already locked, and what the
// next eligible financial year to close is - computed server-side so the
// client never has to reimplement the ordering rule just to show a sane
// default.
financialYearClosingsRouter.get(
  "/status",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    if (!companyId) return res.status(400).json({ message: "company_id is required" });
    const latestClosed = await findLatestClosed(companyId);
    const suggestedFinancialYear = latestClosed
      ? getNextFinancialYear(latestClosed.financial_year)
      : getPreviousFinancialYear(getFinancialYear(new Date()));
    res.json({
      latestClosedFinancialYear: latestClosed?.financial_year ?? null,
      lockedThroughDate: latestClosed?.end_date ?? null,
      suggestedFinancialYear,
    });
  })
);

/**
 * Financial years must close in strict, gapless chronological order: once
 * ANY financial year has been closed for this company, the next one closed
 * must be exactly the one immediately following it (getNextFinancialYear) -
 * closing "27-28" while "25-26" is the latest closed is rejected outright,
 * not silently reinterpreted. Before the very first closing, any financial
 * year may be chosen as the starting point (a company adopting this system
 * mid-history doesn't have to retroactively close everything before it).
 */
function assertClosableInOrder(latestClosed: FinancialYearClosing | undefined, financialYear: string): void {
  if (!FY_PATTERN.test(financialYear)) {
    throw new ValidationError('financial_year must look like "25-26"');
  }
  if (latestClosed) {
    const expected = getNextFinancialYear(latestClosed.financial_year);
    if (financialYear !== expected) {
      throw new ValidationError(
        `Financial years must be closed in order. The latest closed year is ${latestClosed.financial_year} - the next one to close is ${expected}.`
      );
    }
  }
}

financialYearClosingsRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const { company_id, financial_year } = req.body ?? {};
    if (!company_id || !financial_year) {
      return res.status(400).json({ message: "company_id and financial_year are required" });
    }
    const [companyRows] = await pool.query<any[]>("SELECT id FROM companies WHERE id = ?", [company_id]);
    if (!companyRows[0]) return res.status(404).json({ message: "Company not found" });

    const latestClosed = await findLatestClosed(Number(company_id));
    try {
      assertClosableInOrder(latestClosed, financial_year);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(err.status).json({ message: err.message });
      throw err;
    }

    // A previously reopened FY has its own row already (uniq_company_fy) -
    // re-closing it is an UPDATE of that row with fresh figures, never a
    // second INSERT. A currently-closed FY can't be re-closed at all.
    const existing = await findByCompanyAndYear(Number(company_id), financial_year);
    if (existing && existing.status === "closed") {
      return res.status(400).json({ message: `Financial year ${financial_year} is already closed` });
    }

    const { startDate, endDate } = getFinancialYearBounds(financial_year);
    const { income, expenses, totalIncome, totalExpenses, netProfit } = await getProfitAndLoss(
      Number(company_id),
      startDate,
      endDate
    );

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      let journalId: number | null = null;
      if (totalIncome !== 0 || totalExpenses !== 0) {
        const journal = await postYearEndClosingJournalTx(conn, {
          companyId: Number(company_id),
          endDate,
          financialYear: financial_year,
          // getProfitAndLoss includes a row for any account with nonzero
          // GROSS activity in the period (total_debit != 0 OR total_credit
          // != 0), not nonzero NET activity - an account posted to and then
          // fully reversed within the same period nets to exactly zero but
          // still gets a row with amount === 0. Filtered out here: a
          // zero-amount line would fail validateJournalLines ("must have
          // either a debit or a credit amount greater than zero") and
          // contributes nothing to close anyway.
          incomeLines: income.filter((r) => round2(r.amount) !== 0).map((r) => ({ accountId: r.account_id, amount: r.amount })),
          expenseLines: expenses.filter((r) => round2(r.amount) !== 0).map((r) => ({ accountId: r.account_id, amount: r.amount })),
          netProfit,
          createdBy: req.user!.sub,
        });
        journalId = journal.id;
      }

      if (existing) {
        await conn.query(
          `UPDATE financial_year_closings SET
             status = 'closed', net_profit = ?, closing_journal_id = ?,
             closed_by = ?, closed_at = NOW(), reopened_by = NULL, reopened_at = NULL
           WHERE id = ?`,
          [round2(netProfit), journalId, req.user!.sub, existing.id]
        );
      } else {
        await conn.query(
          `INSERT INTO financial_year_closings
             (company_id, financial_year, start_date, end_date, net_profit, closing_journal_id, closed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [company_id, financial_year, startDate, endDate, round2(netProfit), journalId, req.user!.sub]
        );
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError) return res.status(400).json({ message: `Financial year could not be closed: ${err.message}` });
      throw err;
    } finally {
      conn.release();
    }

    const closed = await findByCompanyAndYear(Number(company_id), financial_year);
    res.status(201).json({ closing: closed });
  })
);

// LIFO-only: reopening any FY but the single most-recently-closed one would
// retroactively unlock a period a LATER closing already depended on being
// settled - see schema.sql's comment on financial_year_closings.
financialYearClosingsRouter.post(
  "/:id/reopen",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const [rows] = await pool.query<any[]>("SELECT * FROM financial_year_closings WHERE id = ?", [id]);
    const closing = rows[0] as FinancialYearClosing | undefined;
    if (!closing) return res.status(404).json({ message: "Financial year closing not found" });
    if (closing.status !== "closed") {
      return res.status(400).json({ message: "This financial year is not currently closed" });
    }
    const latestClosed = await findLatestClosed(closing.company_id);
    if (!latestClosed || latestClosed.id !== closing.id) {
      return res.status(400).json({
        message: `Only the most recently closed financial year can be reopened - that's currently ${latestClosed?.financial_year ?? "none"}`,
      });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // Flip the status FIRST, on this same connection - getLockedThroughDate
      // (called next, from inside reverseJournalTx) must stop seeing this FY
      // as closed before its own closing journal can be reversed, or the
      // reversal would be blocked by the very closure it's undoing.
      await conn.query(
        "UPDATE financial_year_closings SET status = 'reopened', reopened_by = ?, reopened_at = NOW() WHERE id = ?",
        [req.user!.sub, id]
      );
      if (closing.closing_journal_id) {
        await reverseJournalTx(conn, closing.closing_journal_id, req.user!.sub);
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError) return res.status(400).json({ message: err.message });
      throw err;
    } finally {
      conn.release();
    }

    const [updatedRows] = await pool.query<any[]>("SELECT * FROM financial_year_closings WHERE id = ?", [id]);
    res.json({ closing: updatedRows[0] });
  })
);
