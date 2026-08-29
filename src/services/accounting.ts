import { PoolConnection } from "mysql2/promise";
import { pool } from "../config/db";
import {
  ChartOfAccount,
  CreateJournalInput,
  Journal,
  JournalLine,
  JournalLineInput,
  JournalStatus,
  LedgerAccountType,
  NormalBalance,
} from "../types";

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
 * The current posted journal for a given source document, or undefined if
 * none exists yet. This is the "does a journal already exist for this
 * transaction" check (Phase 3, Step 4) - callers use it before deciding
 * whether to post a new journal or correct an existing one.
 *
 * `reverses_journal_id IS NULL` is load-bearing, not decorative: a
 * reversal journal (see insertReversalRows) is also status='posted' and
 * also carries the original's source_type/source_id (so it still shows up
 * when browsing "everything that happened to receipt X"), which would
 * otherwise make this query match both the reversal-of-the-old-journal
 * *and* the fresh corrected journal at once. Excluding rows that are
 * themselves a reversal-of-something isolates exactly the one journal that
 * currently represents this source's accounting effect.
 */
export async function getJournalBySource(sourceType: string, sourceId: number): Promise<Journal | undefined> {
  const [rows] = await pool.query<any[]>(
    `SELECT * FROM journals
     WHERE source_type = ? AND source_id = ? AND status = 'posted' AND reverses_journal_id IS NULL
     ORDER BY id DESC LIMIT 1`,
    [sourceType, sourceId]
  );
  return rows[0] as Journal | undefined;
}

/**
 * Resolves a company's seeded system account by its category label (e.g.
 * "Accounts Receivable", "Accounts Payable", "Cash", "Bank" - the exact
 * `category` values schema.sql seeds as is_system=1 rows). Scoped to
 * companyId by construction, so a caller can never end up with another
 * company's account this way.
 */
export async function getSystemAccountByCategory(companyId: number, category: string): Promise<number | undefined> {
  const [rows] = await pool.query<any[]>(
    "SELECT id FROM chart_of_accounts WHERE company_id = ? AND category = ? AND is_system = 1 LIMIT 1",
    [companyId, category]
  );
  return rows[0]?.id as number | undefined;
}

/**
 * Resolves the Chart-of-Accounts row backing an existing Bank & Cash
 * `accounts` row, so callers never have to hard-code a Chart of Accounts
 * id. Uses the stored `accounts.chart_account_id` link when present
 * (backfilled by schema.sql's migration for every account that existed at
 * the time); otherwise falls back to the company's generic system
 * Cash/Bank node by `account_type` - the same mapping the backfill itself
 * uses - which covers any Bank & Cash account created *after* that
 * migration ran (accounts.ts's own POST route doesn't set this column).
 * The link is healed in place so the fallback only runs once per account.
 * Returns undefined if the account doesn't exist or truly has no
 * corresponding system node - callers must treat that as "cannot post a
 * journal for this account", never guess one.
 */
export async function resolveBankCashChartAccountId(accountId: number): Promise<number | undefined> {
  const [rows] = await pool.query<any[]>(
    "SELECT id, company_id, account_type, chart_account_id FROM accounts WHERE id = ? LIMIT 1",
    [accountId]
  );
  const account = rows[0];
  if (!account) return undefined;
  if (account.chart_account_id) return account.chart_account_id as number;

  const category = account.account_type === "cash" ? "Cash" : "Bank";
  const coaId = await getSystemAccountByCategory(account.company_id, category);
  if (!coaId) return undefined;

  await pool.query("UPDATE accounts SET chart_account_id = ? WHERE id = ? AND chart_account_id IS NULL", [
    coaId,
    accountId,
  ]);
  return coaId;
}

async function getJournalByIdConn(conn: PoolConnection, id: number): Promise<Journal | undefined> {
  const [rows] = await conn.query<any[]>("SELECT * FROM journals WHERE id = ? LIMIT 1", [id]);
  return rows[0] as Journal | undefined;
}

async function getJournalLinesConn(conn: PoolConnection, journalId: number): Promise<JournalLine[]> {
  const [rows] = await conn.query<any[]>(
    "SELECT * FROM journal_lines WHERE journal_id = ? ORDER BY sort_order ASC, id ASC",
    [journalId]
  );
  return rows as JournalLine[];
}

/**
 * Core validate-and-insert logic shared by createJournal() and
 * createJournalTx() - assumes `conn` is already inside a transaction that
 * the caller owns (begins/commits/rolls back/releases). Beyond
 * validateJournalLines' shape checks, this additionally enforces (Step 8):
 *   - every line's account actually exists
 *   - every line's account belongs to the *same company* as the journal
 *     (never silently cross-posts between Jose Enterprises and Jose
 *     Industries' books)
 *   - every line's account is active (not soft-deleted/deactivated)
 */
async function insertJournalRows(conn: PoolConnection, input: CreateJournalInput): Promise<Journal> {
  validateJournalLines(input.lines);

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

  return (await getJournalByIdConn(conn, journalId))!;
}

/**
 * Core reversal logic shared by reverseJournal() and reverseJournalTx() -
 * same transaction-ownership contract as insertJournalRows. Posts a new
 * journal with every original line's debit/credit swapped, and marks the
 * original `reversed` - the original row is never edited or deleted,
 * preserving a full audit trail. Reversing an already-reversed journal is
 * rejected (each mistake gets corrected exactly once).
 */
async function insertReversalRows(conn: PoolConnection, journalId: number, userId: number | null): Promise<Journal> {
  const original = await getJournalByIdConn(conn, journalId);
  if (!original) throw new AccountingError("Journal not found");
  if (original.status === "reversed") {
    throw new AccountingError("This journal has already been reversed");
  }

  const lines = await getJournalLinesConn(conn, journalId);
  const reversedLines: JournalLineInput[] = lines.map((l) => ({
    account_id: l.account_id,
    debit: Number(l.credit),
    credit: Number(l.debit),
    description: l.description ? `Reversal: ${l.description}` : "Reversal",
  }));
  // The original journal was itself valid, so its lines swapped are
  // automatically balanced too - this is defense-in-depth, not load-bearing.
  validateJournalLines(reversedLines);

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

  return (await getJournalByIdConn(conn, reversalId))!;
}

/**
 * Validates and posts a balanced journal in its own, self-contained
 * transaction. Use this when nothing else needs to share the transaction
 * (e.g. the /api/journals POST route). When the journal must succeed or
 * fail atomically together with some other write (a receipt, a vendor
 * payment), use createJournalTx with a connection *you* already began a
 * transaction on instead - see Phase 3's receipts.ts/vendorPayments.ts.
 */
export async function createJournal(input: CreateJournalInput): Promise<Journal> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const journal = await insertJournalRows(conn, input);
    await conn.commit();
    return journal;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Same validation and insert logic as createJournal, but participates in a
 * transaction the caller already began on `conn` - the caller is
 * responsible for beginTransaction/commit/rollback/release. This is what
 * lets "create the business document" and "post its journal" succeed or
 * roll back together as one atomic unit (Phase 3, Step 3).
 */
export async function createJournalTx(conn: PoolConnection, input: CreateJournalInput): Promise<Journal> {
  return insertJournalRows(conn, input);
}

/** Self-contained-transaction counterpart to reverseJournalTx - see
 * createJournal vs createJournalTx above for the same distinction. */
export async function reverseJournal(journalId: number, userId: number | null): Promise<Journal> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const reversal = await insertReversalRows(conn, journalId, userId);
    await conn.commit();
    return reversal;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Transaction-participant counterpart to reverseJournal - see
 * createJournalTx's doc comment for the contract. */
export async function reverseJournalTx(conn: PoolConnection, journalId: number, userId: number | null): Promise<Journal> {
  return insertReversalRows(conn, journalId, userId);
}

// ---- Phase 3: transaction-specific posting rules (receipts / vendor
// payments). Each function below is the one place that decides "which
// accounts, which side is debit vs credit" for its transaction type, so
// that logic is never duplicated across route files. ----

export interface PostReceiptJournalInput {
  companyId: number;
  /** The receipt's existing Bank & Cash `accounts.id` - never a hard-coded id. */
  accountId: number;
  amount: number;
  receiptId: number;
  receiptNo: string;
  receivedDate: string;
  createdBy: number | null;
}

/**
 * Dr Bank/Cash, Cr Accounts Receivable - the accounting effect of a
 * customer receipt. Must run on a `conn` already inside the caller's
 * transaction (see createJournalTx). Throws AccountingError if the
 * account isn't linked to a Chart of Accounts node or the company has no
 * Accounts Receivable system account - callers should let that roll back
 * the whole transaction rather than leave the receipt unposted.
 */
export async function postReceiptJournalTx(conn: PoolConnection, input: PostReceiptJournalInput): Promise<Journal> {
  const bankChartAccountId = await resolveBankCashChartAccountId(input.accountId);
  if (!bankChartAccountId) {
    throw new AccountingError("Selected account has no linked Chart of Accounts Bank/Cash account");
  }
  const arAccountId = await getSystemAccountByCategory(input.companyId, "Accounts Receivable");
  if (!arAccountId) {
    throw new AccountingError("Accounts Receivable system account not found for this company");
  }

  const description = `Receipt ${input.receiptNo}`;
  return createJournalTx(conn, {
    company_id: input.companyId,
    journal_date: input.receivedDate,
    reference: input.receiptNo,
    source_type: "receipt",
    source_id: input.receiptId,
    description,
    created_by: input.createdBy,
    lines: [
      { account_id: bankChartAccountId, debit: input.amount, credit: 0, description },
      { account_id: arAccountId, debit: 0, credit: input.amount, description },
    ],
  });
}

export interface PostVendorPaymentJournalInput {
  companyId: number;
  /** The vendor payment's existing Bank & Cash `accounts.id` - never a hard-coded id. */
  accountId: number;
  amount: number;
  paymentId: number;
  paymentNo: string;
  paidDate: string;
  createdBy: number | null;
}

/**
 * Dr Accounts Payable, Cr Bank/Cash - the accounting effect of a payment
 * to a vendor. Same transaction contract as postReceiptJournalTx.
 */
export async function postVendorPaymentJournalTx(
  conn: PoolConnection,
  input: PostVendorPaymentJournalInput
): Promise<Journal> {
  const bankChartAccountId = await resolveBankCashChartAccountId(input.accountId);
  if (!bankChartAccountId) {
    throw new AccountingError("Selected account has no linked Chart of Accounts Bank/Cash account");
  }
  const apAccountId = await getSystemAccountByCategory(input.companyId, "Accounts Payable");
  if (!apAccountId) {
    throw new AccountingError("Accounts Payable system account not found for this company");
  }

  const description = `Vendor payment ${input.paymentNo}`;
  return createJournalTx(conn, {
    company_id: input.companyId,
    journal_date: input.paidDate,
    reference: input.paymentNo,
    source_type: "vendor_payment",
    source_id: input.paymentId,
    description,
    created_by: input.createdBy,
    lines: [
      { account_id: apAccountId, debit: input.amount, credit: 0, description },
      { account_id: bankChartAccountId, debit: 0, credit: input.amount, description },
    ],
  });
}

export interface PostTaxInvoiceJournalInput {
  companyId: number;
  invoiceId: number;
  invoiceNo: string;
  issueDate: string;
  grandTotal: number;
  taxTotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  createdBy: number | null;
}

/**
 * Dr Accounts Receivable (full grand total), Cr Sales Revenue (grand total
 * minus tax - this absorbs freight/installation charges and the rounding
 * residual along with the taxable value, since none of those get their own
 * dedicated ledger account in this phase), Cr Output CGST/SGST/IGST (split
 * exactly as the invoice's own already-computed cgst_total/sgst_total/
 * igst_total - never recomputed here). Only the GST lines that are
 * actually nonzero are included (an interstate invoice has no CGST/SGST
 * line; a 0%-GST invoice has no GST line at all) - validateJournalLines
 * would reject a zero-amount line anyway. Must run on a `conn` already
 * inside the caller's transaction (see createJournalTx).
 */
export async function postTaxInvoiceJournalTx(conn: PoolConnection, input: PostTaxInvoiceJournalInput): Promise<Journal> {
  const arAccountId = await getSystemAccountByCategory(input.companyId, "Accounts Receivable");
  if (!arAccountId) {
    throw new AccountingError("Accounts Receivable system account not found for this company");
  }
  const revenueAccountId = await getSystemAccountByCategory(input.companyId, "Sales");
  if (!revenueAccountId) {
    throw new AccountingError("Sales Revenue system account not found for this company");
  }

  const description = `Tax Invoice ${input.invoiceNo}`;
  const revenueAmount = round2(input.grandTotal - input.taxTotal);
  const lines: JournalLineInput[] = [{ account_id: arAccountId, debit: input.grandTotal, credit: 0, description }];
  if (revenueAmount > 0) {
    lines.push({ account_id: revenueAccountId, debit: 0, credit: revenueAmount, description });
  }

  if (input.igstTotal > 0) {
    const igstAccountId = await getSystemAccountByCategory(input.companyId, "Output IGST");
    if (!igstAccountId) {
      throw new AccountingError("Output IGST system account not found for this company");
    }
    lines.push({ account_id: igstAccountId, debit: 0, credit: input.igstTotal, description });
  } else {
    if (input.cgstTotal > 0) {
      const cgstAccountId = await getSystemAccountByCategory(input.companyId, "Output CGST");
      if (!cgstAccountId) {
        throw new AccountingError("Output CGST system account not found for this company");
      }
      lines.push({ account_id: cgstAccountId, debit: 0, credit: input.cgstTotal, description });
    }
    if (input.sgstTotal > 0) {
      const sgstAccountId = await getSystemAccountByCategory(input.companyId, "Output SGST");
      if (!sgstAccountId) {
        throw new AccountingError("Output SGST system account not found for this company");
      }
      lines.push({ account_id: sgstAccountId, debit: 0, credit: input.sgstTotal, description });
    }
  }

  return createJournalTx(conn, {
    company_id: input.companyId,
    journal_date: input.issueDate,
    reference: input.invoiceNo,
    source_type: "tax_invoice",
    source_id: input.invoiceId,
    description,
    created_by: input.createdBy,
    lines,
  });
}

// ---- A note on `journals.status` and arithmetic -----------------------
// A reversal is an OFFSETTING entry, not a retroactive void: posted
// journals are immutable, so "correcting" one means posting a brand new
// journal with every line's debit/credit swapped, and only then flipping
// the ORIGINAL's status to 'reversed' as a superseded-marker. The
// original's lines are still real, historical amounts - they happened.
// That means original + its reversal must BOTH be summed for any balance
// calculation to net to exactly zero (or, when a reversal is immediately
// followed by a fresh corrected journal - exactly how edits work in
// receipts.ts/vendorPayments.ts/salesDocuments.ts - to net to exactly the
// corrected journal's own figures). Filtering a SUM to `status = 'posted'`
// only would silently drop the original's amount while keeping its
// reversal's opposite-signed amount, which is not "excluding a superseded
// entry" - it's actively getting the arithmetic wrong by exactly double the
// reversed amount. Proven by this phase's own test script: editing an
// invoice from 118,000 to 236,000 must net to 236,000, not 354,000.
//
// So: every balance/aggregate function below (getAccountBalance,
// getAccountOpeningBalance, getLedger's running balance, getTrialBalance)
// sums ALL journal_lines regardless of status. `status = 'posted'` is used
// ONLY to decide which individual journals are shown as separate ROWS in
// getLedger's displayed transaction list - a pure display concern, kept
// mathematically honest by still folding a hidden (reversed) row's amount
// into the running balance shown on the rows around it.

/**
 * Net balance of one account, optionally as of a given date (inclusive),
 * signed by its normal_balance so an Asset/Expense account reads positive
 * when it carries a debit balance and a Liability/Equity/Revenue account
 * reads positive when it carries a credit balance - the conventional
 * presentation for a Trial Balance/financial statement.
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
 * Net balance of one account from journal lines strictly BEFORE
 * `beforeDate` (exclusive) - the "opening balance" a General Ledger view
 * starts its running total from, rather than assuming everything before
 * the requested range is zero (Phase 5, Step 3). Signed the same way as
 * getAccountBalance.
 */
export async function getAccountOpeningBalance(accountId: number, beforeDate: string): Promise<number> {
  const [accountRows] = await pool.query<any[]>("SELECT * FROM chart_of_accounts WHERE id = ?", [accountId]);
  const account = accountRows[0] as ChartOfAccount | undefined;
  if (!account) throw new AccountingError("Account not found");

  const [rows] = await pool.query<any[]>(
    `SELECT COALESCE(SUM(jl.debit), 0) as total_debit, COALESCE(SUM(jl.credit), 0) as total_credit
     FROM journal_lines jl
     JOIN journals j ON j.id = jl.journal_id
     WHERE jl.account_id = ? AND j.journal_date < ?`,
    [accountId, beforeDate]
  );
  const totalDebit = Number(rows[0].total_debit);
  const totalCredit = Number(rows[0].total_credit);
  return account.normal_balance === "debit" ? round2(totalDebit - totalCredit) : round2(totalCredit - totalDebit);
}

export interface GetLedgerOptions {
  sourceType?: string;
  reference?: string;
}

/**
 * Chronological postings to one account with an opening balance (from
 * getAccountOpeningBalance, when `from` is given) and a running balance
 * from there, signed the same way as getAccountBalance.
 *
 * The running balance is accumulated over EVERY journal line in range,
 * regardless of status (see the note above this section) - but only rows
 * whose journal is `status = 'posted'` are pushed into the returned
 * `entries` list. A reversed original is folded into the running balance
 * silently, without appearing as its own row (Phase 5, Step 2: "do not
 * include reversed journals as active ledger entries"), while its
 * reversal - itself posted - both appears as a row AND is what makes the
 * displayed running-balance numbers add up correctly.
 */
export async function getLedger(accountId: number, from?: string, to?: string, options: GetLedgerOptions = {}) {
  const [accountRows] = await pool.query<any[]>("SELECT * FROM chart_of_accounts WHERE id = ?", [accountId]);
  const account = accountRows[0] as ChartOfAccount | undefined;
  if (!account) throw new AccountingError("Account not found");

  const openingBalance = from ? await getAccountOpeningBalance(accountId, from) : 0;

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
  if (options.sourceType) {
    clauses.push("j.source_type = ?");
    params.push(options.sourceType);
  }
  if (options.reference) {
    clauses.push("j.reference LIKE ?");
    params.push(`%${options.reference}%`);
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
  let running = openingBalance;
  const entries: {
    journal_id: number;
    journal_date: string;
    reference: string | null;
    source_type: string | null;
    source_id: number | null;
    description: string | null;
    status: JournalStatus;
    debit: number;
    credit: number;
    running_balance: number;
  }[] = [];
  for (const r of rows) {
    const debit = Number(r.debit);
    const credit = Number(r.credit);
    running = round2(running + sign * (debit - credit));
    if (r.status !== "posted") continue; // folded into `running` above, not shown as its own row
    entries.push({
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
    });
  }

  return { account, openingBalance, entries, closingBalance: running };
}

export interface GetGeneralLedgerInput extends GetLedgerOptions {
  companyId: number;
  accountId: number;
  from: string;
  to: string;
}

/**
 * The company-isolation-enforcing entry point for the General Ledger API
 * (Phase 5, Step 10): rejects the request outright if the requested
 * account does not actually belong to the requested company, rather than
 * quietly returning another company's data. Delegates everything else to
 * getLedger - no logic is duplicated between the two.
 */
export async function getGeneralLedger(input: GetGeneralLedgerInput) {
  const [accountRows] = await pool.query<any[]>("SELECT company_id FROM chart_of_accounts WHERE id = ?", [input.accountId]);
  const account = accountRows[0];
  if (!account) throw new AccountingError("Account not found");
  if (Number(account.company_id) !== Number(input.companyId)) {
    throw new AccountingError("This account does not belong to the requested company");
  }

  const result = await getLedger(input.accountId, input.from, input.to, {
    sourceType: input.sourceType,
    reference: input.reference,
  });
  return { ...result, from: input.from, to: input.to };
}

export interface TrialBalanceRow {
  account_id: number;
  account_code: string;
  name: string;
  account_type: LedgerAccountType;
  category: string | null;
  normal_balance: NormalBalance;
  debit: number;
  credit: number;
}

export interface TrialBalanceResult {
  asOfDate: string;
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  /** True when totalDebit === totalCredit, which a correctly-enforced
   * double-entry ledger guarantees mathematically - this is a defensive
   * integrity check, surfaced honestly, never silently corrected
   * (Phase 5, Step 16). */
  isBalanced: boolean;
}

/**
 * Built entirely from journals + journal_lines + chart_of_accounts (never
 * receipts/vendor_payments/expenses/documents/accounts.balance/
 * journal_entries - those are source/business tables, not the accounting
 * ledger), for one company's active accounts, up to `asOfDate` (inclusive).
 * Sums every journal line regardless of `status` - see the note above
 * getAccountBalance: a reversed original and its reversal must both be
 * summed for the net to correctly come out to zero (or, after an edit, to
 * exactly the corrected journal's figures) - filtering to `status =
 * 'posted'` only would silently drop the original half of that
 * cancelling pair and get every edited/reversed account's total wrong.
 * Each account nets its debits and credits into a single signed figure,
 * placed in whichever column it's actually on (positive net -> Debit
 * column, negative net -> Credit column) - this is presentation, not
 * per-account normal_balance logic; normal_balance only matters for the
 * General Ledger's running-balance sign. An account with zero net
 * activity (including one whose activity was fully offset by a reversal)
 * is omitted, per "include all active posting accounts that have
 * accounting activity".
 */
export async function getTrialBalance(companyId: number, asOfDate: string): Promise<TrialBalanceResult> {
  const [rows] = await pool.query<any[]>(
    `SELECT coa.id as account_id, coa.account_code, coa.name, coa.account_type, coa.category, coa.normal_balance,
            COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0) as net
     FROM chart_of_accounts coa
     LEFT JOIN journal_lines jl ON jl.account_id = coa.id
     LEFT JOIN journals j ON j.id = jl.journal_id AND j.journal_date <= ?
     WHERE coa.company_id = ? AND coa.is_active = 1
     GROUP BY coa.id, coa.account_code, coa.name, coa.account_type, coa.category, coa.normal_balance
     HAVING net <> 0
     ORDER BY coa.account_code ASC`,
    [asOfDate, companyId]
  );

  const tbRows: TrialBalanceRow[] = rows.map((r) => {
    const net = round2(Number(r.net));
    return {
      account_id: r.account_id,
      account_code: r.account_code,
      name: r.name,
      account_type: r.account_type,
      category: r.category,
      normal_balance: r.normal_balance,
      debit: net > 0 ? net : 0,
      credit: net < 0 ? -net : 0,
    };
  });

  const totalDebit = round2(tbRows.reduce((s, r) => s + r.debit, 0));
  const totalCredit = round2(tbRows.reduce((s, r) => s + r.credit, 0));

  return {
    asOfDate,
    rows: tbRows,
    totalDebit,
    totalCredit,
    isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
  };
}
