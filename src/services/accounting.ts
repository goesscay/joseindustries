import { pool } from "../config/db";
import { ChartOfAccount, CreateJournalInput, Journal, JournalLine, JournalLineInput } from "../types";

/** Thrown for any accounting-rule violation (unbalanced journal, negative
 * amount, cross-company account, ...). Routes catch this and respond 400
 * with `.message` - never a generic 500 - so a rejected posting always
 * comes back as a clear, actionable error. */
export class AccountingError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "AccountingError";
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pure validation - no DB access. Enforces Step 4/8's data-integrity rules
 * on the shape of a journal's lines before anything is ever written:
 *   - at least two lines (a journal with one line can't balance)
 *   - no negative debit/credit
 *   - a line is never both a debit and a credit
 *   - a line is never neither (every line moves *something*)
 *   - total debits === total credits (the balancing rule itself)
 * Throws AccountingError with a specific, human-readable reason on the
 * first violation found.
 */
export function validateJournalLines(lines: JournalLineInput[]): void {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new AccountingError("A journal needs at least two lines");
  }

  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of lines) {
    if (!line.account_id) {
      throw new AccountingError("Each journal line must specify an account");
    }
    const debit = Number(line.debit) || 0;
    const credit = Number(line.credit) || 0;
    if (debit < 0 || credit < 0) {
      throw new AccountingError("Debit and credit amounts cannot be negative");
    }
    if (debit > 0 && credit > 0) {
      throw new AccountingError("A single journal line cannot be both a debit and a credit");
    }
    if (debit === 0 && credit === 0) {
      throw new AccountingError("Each journal line must have either a debit or a credit amount greater than zero");
    }
    totalDebit = round2(totalDebit + debit);
    totalCredit = round2(totalCredit + credit);
  }

  if (totalDebit <= 0) {
    throw new AccountingError("A journal must have a positive total debit");
  }
  if (totalDebit !== totalCredit) {
    throw new AccountingError(
      `Journal is not balanced: total debits (${totalDebit.toFixed(2)}) must equal total credits (${totalCredit.toFixed(2)})`
    );
  }
}

export async function getJournalById(id: number): Promise<Journal | undefined> {
  const [rows] = await pool.query<any[]>("SELECT * FROM journals WHERE id = ? LIMIT 1", [id]);
  return rows[0] as Journal | undefined;
}

export async function getJournalLines(journalId: number): Promise<JournalLine[]> {
  const [rows] = await pool.query<any[]>(
    "SELECT * FROM journal_lines WHERE journal_id = ? ORDER BY sort_order ASC, id ASC",
    [journalId]
  );
  return rows as JournalLine[];
}

/**
 * Validates and posts a balanced journal in a single transaction. Beyond
 * validateJournalLines' shape checks, this additionally enforces (Step 8):
 *   - every line's account actually exists
 *   - every line's account belongs to the *same company* as the journal
 *     (never silently cross-posts between Jose Enterprises and Jose
 *     Industries' books)
 *   - every line's account is active (not soft-deleted/deactivated)
 * On any failure the whole transaction is rolled back - nothing is ever
 * left half-written. There is deliberately no "update a posted journal"
 * function; see reverseJournal for how a mistake gets corrected instead.
 */
export async function createJournal(input: CreateJournalInput): Promise<Journal> {
  validateJournalLines(input.lines);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const accountIds = [...new Set(input.lines.map((l) => l.account_id))];
    const [accountRows] = await conn.query<any[]>(
      "SELECT id, company_id, is_active FROM chart_of_accounts WHERE id IN (?) FOR UPDATE",
      [accountIds]
    );
    const accountsById = new Map<number, any>(accountRows.map((a) => [a.id, a]));
    for (const id of accountIds) {
      const account = accountsById.get(id);
      if (!account) {
        throw new AccountingError(`Account ${id} does not exist`);
      }
      if (Number(account.company_id) !== Number(input.company_id)) {
        throw new AccountingError(`Account ${id} does not belong to this journal's company`);
      }
      if (!account.is_active) {
        throw new AccountingError(`Account ${id} is inactive and cannot be posted to`);
      }
    }

    const [journalResult] = await conn.query<any>(
      `INSERT INTO journals (company_id, journal_date, reference, source_type, source_id, description, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'posted', ?)`,
      [
        input.company_id,
        input.journal_date,
        input.reference || null,
        input.source_type || null,
        input.source_id || null,
        input.description || null,
        input.created_by || null,
      ]
    );
    const journalId = journalResult.insertId;

    let sortOrder = 0;
    for (const line of input.lines) {
      await conn.query(
        `INSERT INTO journal_lines (journal_id, account_id, debit, credit, description, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [journalId, line.account_id, line.debit || 0, line.credit || 0, line.description || null, sortOrder]
      );
      sortOrder += 1;
    }

    await conn.commit();
    return (await getJournalById(journalId))!;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Posts a new journal with every original line's debit/credit swapped, and
 * marks the original `reversed` - the original row is never edited or
 * deleted, preserving a full audit trail. Reversing an already-reversed
 * journal is rejected (each mistake gets corrected exactly once).
 */
export async function reverseJournal(journalId: number, userId: number | null): Promise<Journal> {
  const original = await getJournalById(journalId);
  if (!original) throw new AccountingError("Journal not found");
  if (original.status === "reversed") {
    throw new AccountingError("This journal has already been reversed");
  }

  const lines = await getJournalLines(journalId);
  const reversedLines: JournalLineInput[] = lines.map((l) => ({
    account_id: l.account_id,
    debit: Number(l.credit),
    credit: Number(l.debit),
    description: l.description ? `Reversal: ${l.description}` : "Reversal",
  }));
  // The original journal was itself valid, so its lines swapped are
  // automatically balanced too - this is defense-in-depth, not load-bearing.
  validateJournalLines(reversedLines);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [journalResult] = await conn.query<any>(
      `INSERT INTO journals (company_id, journal_date, reference, source_type, source_id, description, status, reverses_journal_id, created_by)
       VALUES (?, CURDATE(), ?, ?, ?, ?, 'posted', ?, ?)`,
      [
        original.company_id,
        original.reference,
        original.source_type,
        original.source_id,
        original.description ? `Reversal of: ${original.description}` : `Reversal of journal #${original.id}`,
        original.id,
        userId,
      ]
    );
    const reversalId = journalResult.insertId;

    let sortOrder = 0;
    for (const line of reversedLines) {
      await conn.query(
        `INSERT INTO journal_lines (journal_id, account_id, debit, credit, description, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [reversalId, line.account_id, line.debit, line.credit, line.description, sortOrder]
      );
      sortOrder += 1;
    }

    await conn.query("UPDATE journals SET status = 'reversed' WHERE id = ?", [journalId]);

    await conn.commit();
    return (await getJournalById(reversalId))!;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Net balance of one account, optionally as of a given date (inclusive),
 * signed by its normal_balance so an Asset/Expense account reads positive
 * when it carries a debit balance and a Liability/Equity/Revenue account
 * reads positive when it carries a credit balance - the conventional
 * presentation for a Trial Balance/financial statement (not built yet -
 * this is the primitive a future one would call per account).
 */
export async function getAccountBalance(accountId: number, asOfDate?: string): Promise<number> {
  const [accountRows] = await pool.query<any[]>("SELECT * FROM chart_of_accounts WHERE id = ?", [accountId]);
  const account = accountRows[0] as ChartOfAccount | undefined;
  if (!account) throw new AccountingError("Account not found");

  const dateClause = asOfDate ? "AND j.journal_date <= ?" : "";
  const params = asOfDate ? [accountId, asOfDate] : [accountId];
  const [rows] = await pool.query<any[]>(
    `SELECT COALESCE(SUM(jl.debit), 0) as total_debit, COALESCE(SUM(jl.credit), 0) as total_credit
     FROM journal_lines jl
     JOIN journals j ON j.id = jl.journal_id
     WHERE jl.account_id = ? ${dateClause}`,
    params
  );
  const totalDebit = Number(rows[0].total_debit);
  const totalCredit = Number(rows[0].total_credit);
  return account.normal_balance === "debit" ? round2(totalDebit - totalCredit) : round2(totalCredit - totalDebit);
}

/**
 * Chronological postings to one account with a running balance, signed the
 * same way as getAccountBalance. The general-ledger view for a single
 * account - a Trial Balance (not built yet) would call getAccountBalance
 * across every account instead.
 */
export async function getLedger(accountId: number, from?: string, to?: string) {
  const [accountRows] = await pool.query<any[]>("SELECT * FROM chart_of_accounts WHERE id = ?", [accountId]);
  const account = accountRows[0] as ChartOfAccount | undefined;
  if (!account) throw new AccountingError("Account not found");

  const clauses = ["jl.account_id = ?"];
  const params: unknown[] = [accountId];
  if (from) {
    clauses.push("j.journal_date >= ?");
    params.push(from);
  }
  if (to) {
    clauses.push("j.journal_date <= ?");
    params.push(to);
  }

  const [rows] = await pool.query<any[]>(
    `SELECT jl.id, jl.debit, jl.credit, jl.description as line_description,
            j.id as journal_id, j.journal_date, j.reference, j.source_type, j.source_id,
            j.description as journal_description, j.status
     FROM journal_lines jl
     JOIN journals j ON j.id = jl.journal_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY j.journal_date ASC, j.id ASC, jl.sort_order ASC`,
    params
  );

  const sign = account.normal_balance === "debit" ? 1 : -1;
  let running = 0;
  const entries = rows.map((r) => {
    const debit = Number(r.debit);
    const credit = Number(r.credit);
    running = round2(running + sign * (debit - credit));
    return {
      journal_id: r.journal_id,
      journal_date: r.journal_date,
      reference: r.reference,
      source_type: r.source_type,
      source_id: r.source_id,
      description: r.line_description || r.journal_description,
      status: r.status,
      debit,
      credit,
      running_balance: running,
    };
  });

  return { account, entries, closingBalance: running };
}
