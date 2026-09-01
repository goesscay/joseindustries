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
 * Creates a fresh Chart of Accounts leaf, as a child of the company's
 * generic system Cash/Bank node, dedicated to one Bank & Cash `accounts`
 * row - used when that generic node is already claimed by a different
 * account of the same type (see resolveBankCashChartAccountId below). Named
 * after the Bank & Cash account itself (e.g. "HDFC Current Account") so it
 * reads clearly in the Trial Balance/General Ledger, with a code derived
 * from the parent's ("1120" -> "1120-2", "1120-3", ...). Retries a handful
 * of times on a code collision (two accounts created in the same instant)
 * rather than trusting a single COUNT(*) to be race-free.
 */
async function createDedicatedBankCashChartAccount(
  runner: PoolConnection | typeof pool,
  companyId: number,
  parentId: number,
  accountName: string
): Promise<number> {
  const [parentRows] = await runner.query<any[]>(
    "SELECT account_code, account_type, category, normal_balance FROM chart_of_accounts WHERE id = ?",
    [parentId]
  );
  const parent = parentRows[0];
  for (let attempt = 0; attempt < 5; attempt++) {
    const [siblingRows] = await runner.query<any[]>("SELECT COUNT(*) as c FROM chart_of_accounts WHERE parent_id = ?", [
      parentId,
    ]);
    // The parent itself is conceptually "1" - the first dedicated sibling is "2".
    const code = `${parent.account_code}-${Number(siblingRows[0].c) + 2 + attempt}`;
    try {
      const [result] = await runner.query<any>(
        `INSERT INTO chart_of_accounts (company_id, parent_id, account_code, name, account_type, category, normal_balance, is_system)
         VALUES (?, ?, ?, ?, ?, ?, ?, FALSE)`,
        [companyId, parentId, code, accountName, parent.account_type, parent.category, parent.normal_balance]
      );
      return result.insertId;
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY" && attempt < 4) continue;
      throw err;
    }
  }
  throw new AccountingError("Could not allocate a Chart of Accounts code for this account");
}

/**
 * Resolves the Chart-of-Accounts row backing an existing Bank & Cash
 * `accounts` row, so callers never have to hard-code a Chart of Accounts
 * id. Uses the stored `accounts.chart_account_id` link when present
 * (backfilled by schema.sql's migration for every account that existed at
 * the time); otherwise resolves one on first use and heals the link in
 * place so this only runs once per account:
 *   - the FIRST Bank & Cash account of a given type (Cash/Bank) for a
 *     company reuses that company's generic seeded system node ("1110
 *     Cash"/"1120 Bank") directly - matching the historical 1:1 mapping
 *     schema.sql's own migration already assumed for every account that
 *     existed before this function could create anything else.
 *   - any ADDITIONAL account of the same type gets its own dedicated leaf
 *     (via createDedicatedBankCashChartAccount) instead of also being
 *     pointed at that same shared node. Two real bank accounts sharing one
 *     Chart of Accounts node would merge their balances and ledgers
 *     together the moment either one posted anything - a real bug, not a
 *     theoretical one, caught during Phase B's own verification the moment
 *     a second Bank account was created for a company that already had one.
 * Returns undefined if the account doesn't exist or the company has no
 * seeded system node for this type at all - callers must treat that as
 * "cannot post a journal for this account", never guess one.
 *
 * Accepts an optional `conn` so a caller already inside a transaction (e.g.
 * accounts.ts's POST route, which creates the `accounts` row and posts its
 * opening-balance journal in the same transaction) can resolve an account
 * that hasn't been committed yet - querying via the bare `pool` here would
 * open a second connection that can't see the other connection's
 * uncommitted insert and would wrongly report the account as not found.
 */
export async function resolveBankCashChartAccountId(
  accountId: number,
  conn?: PoolConnection
): Promise<number | undefined> {
  const runner = conn ?? pool;
  const [rows] = await runner.query<any[]>(
    "SELECT id, company_id, name, account_type, chart_account_id FROM accounts WHERE id = ? LIMIT 1",
    [accountId]
  );
  const account = rows[0];
  if (!account) return undefined;
  if (account.chart_account_id) return account.chart_account_id as number;

  const category = account.account_type === "cash" ? "Cash" : "Bank";
  const systemAccountId = await getSystemAccountByCategory(account.company_id, category);
  if (!systemAccountId) return undefined;

  const [claimedRows] = await runner.query<any[]>(
    "SELECT id FROM accounts WHERE company_id = ? AND chart_account_id = ? AND id != ? LIMIT 1",
    [account.company_id, systemAccountId, accountId]
  );
  const coaId = claimedRows[0]
    ? await createDedicatedBankCashChartAccount(runner, account.company_id, systemAccountId, account.name)
    : systemAccountId;

  await runner.query("UPDATE accounts SET chart_account_id = ? WHERE id = ? AND chart_account_id IS NULL", [
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
  // Phase E: a journal line that's been matched to a bank statement
  // (journal_lines.reconciled_at set, via a completed Bank Reconciliation)
  // can never be reversed out from under that reconciliation - this is the
  // one central choke point every reversal path in the app goes through
  // (reverseJournal/reverseJournalTx, which every Receipt/Vendor
  // Payment/Bank & Cash Entry/Transfer/Credit Note/Debit Note/manual
  // Journal Entry edit-or-delete flow calls), so the guard only needs to
  // live here once. The fix is to reopen the reconciliation
  // (POST /bank-reconciliations/:id/reopen) and explicitly un-clear the
  // specific line first - see schema.sql's comment on bank_reconciliations.
  const [reconciledRows] = await conn.query<any[]>(
    "SELECT COUNT(*) as c FROM journal_lines WHERE journal_id = ? AND reconciled_at IS NOT NULL",
    [journalId]
  );
  if (Number(reconciledRows[0].c) > 0) {
    throw new AccountingError(
      "This entry has already been matched in a bank reconciliation and can't be reversed. Reopen the reconciliation first."
    );
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
  const bankChartAccountId = await resolveBankCashChartAccountId(input.accountId, conn);
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
  const bankChartAccountId = await resolveBankCashChartAccountId(input.accountId, conn);
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

export interface PostSaleCogsJournalInput {
  companyId: number;
  invoiceId: number;
  invoiceNo: string;
  issueDate: string;
  /** Sum of qty * unit_cost across every 'sale_issue' stock_transactions
   * row this invoice actually posted (read directly from
   * postDocumentStockMovementTx's own returned rows, never recomputed
   * independently) - GST-exclusive by construction, since Phase 12C's
   * unit_cost is always GST-exclusive. Callers must only invoke this when
   * cogsAmount > 0 (createJournalTx/validateJournalLines reject an
   * all-zero journal, same as postPurchaseBillJournalTx's own
   * skip-the-zero-bucket behavior). */
  cogsAmount: number;
  createdBy: number | null;
}

/**
 * Phase 12E: Dr Cost of Goods Sold (5100), Cr Inventory (1140) - the
 * inventory-cost counterpart to postTaxInvoiceJournalTx's revenue/GST
 * journal, posted as its OWN separate journal (see the Phase 12E audit's
 * "Option B" decision) linked to the same invoice via a distinct
 * source_type ("tax_invoice_cogs", not "tax_invoice") so
 * getJournalBySource/reverseJournalTx work unmodified for both journals
 * independently - reversing one never touches the other. This function
 * has zero knowledge of selling price, GST, or which lines were
 * tracked/skipped; it only ever receives the already-resolved cogsAmount,
 * so "stock issue value = COGS value" holds by construction, not by
 * parallel calculation - see the caller in salesDocuments.ts. Must run on
 * a `conn` already inside the caller's transaction.
 */
export async function postSaleCogsJournalTx(conn: PoolConnection, input: PostSaleCogsJournalInput): Promise<Journal> {
  const cogsAccountId = await getSystemAccountByCategory(input.companyId, "Cost of Goods Sold");
  if (!cogsAccountId) {
    throw new AccountingError("Cost of Goods Sold system account not found for this company");
  }
  const inventoryAccountId = await getSystemAccountByCategory(input.companyId, "Inventory");
  if (!inventoryAccountId) {
    throw new AccountingError("Inventory system account not found for this company");
  }

  const description = `COGS for Tax Invoice ${input.invoiceNo}`;
  return createJournalTx(conn, {
    company_id: input.companyId,
    journal_date: input.issueDate,
    reference: input.invoiceNo,
    source_type: "tax_invoice_cogs",
    source_id: input.invoiceId,
    description,
    created_by: input.createdBy,
    lines: [
      { account_id: cogsAccountId, debit: input.cogsAmount, credit: 0, description },
      { account_id: inventoryAccountId, debit: 0, credit: input.cogsAmount, description },
    ],
  });
}

export interface PostOpeningStockJournalInput {
  companyId: number;
  /** The opening `stock_transactions` row's own id - used as this
   * journal's source_id (source_type "opening_stock") so it is
   * independently discoverable via getJournalBySource, the same way every
   * other posting function's journal is, even though no reversal endpoint
   * currently calls it back (see postOpeningStockTx's own doc comment on
   * why there is no "reverse opening stock" endpoint in this phase). */
  stockTxnId: number;
  txnDate: string;
  /** qty * unitCost, already computed by the caller. Callers must only
   * invoke this when amount > 0 - the caller's own responsibility is to
   * skip this call entirely when the opening entry has no cost basis
   * (unitCost null/undefined), never to call this with a fabricated 0. */
  amount: number;
  createdBy: number | null;
}

/**
 * Phase 12G: Dr Inventory (1140), Cr Capital (3100) - opening stock's own
 * asset value has to be represented somewhere on the books alongside the
 * quantity (Phase 12/12C only ever recorded stock_transactions - no
 * journal, no GL effect), and Capital is the approved offset (an
 * explicit design decision - never Retained Earnings 3200, which
 * getBalanceSheet treats as a purely computed row with no real postings
 * of its own; posting here would double-count against that computation).
 * Only ever called when the opening entry actually has a resolvable
 * cost - see postOpeningStockTx's caller-side `if (unitCost)` guard.
 * Must run on a `conn` already inside the caller's transaction, so the
 * stock row and its journal commit or roll back together atomically.
 */
export async function postOpeningStockJournalTx(conn: PoolConnection, input: PostOpeningStockJournalInput): Promise<Journal> {
  const inventoryAccountId = await getSystemAccountByCategory(input.companyId, "Inventory");
  if (!inventoryAccountId) {
    throw new AccountingError("Inventory system account not found for this company");
  }
  const capitalAccountId = await getSystemAccountByCategory(input.companyId, "Capital");
  if (!capitalAccountId) {
    throw new AccountingError("Capital system account not found for this company");
  }

  const description = `Opening stock valuation (stock txn #${input.stockTxnId})`;
  return createJournalTx(conn, {
    company_id: input.companyId,
    journal_date: input.txnDate,
    reference: null,
    source_type: "opening_stock",
    source_id: input.stockTxnId,
    description,
    created_by: input.createdBy,
    lines: [
      { account_id: inventoryAccountId, debit: input.amount, credit: 0, description },
      { account_id: capitalAccountId, debit: 0, credit: input.amount, description },
    ],
  });
}

export interface PostStockAdjustmentJournalInput {
  companyId: number;
  /** The adjustment `stock_transactions` row's own id - this journal's
   * source_id (source_type "stock_adjustment", distinct from the stock
   * row's own source_type "adjustment" - the same tax_invoice /
   * tax_invoice_cogs split Phase 12E already established for exactly this
   * reason: one business event, two independently-reversible postings,
   * disambiguated by source_type, sharing the same source_id). */
  stockTxnId: number;
  txnDate: string;
  txnType: "adjustment_in" | "adjustment_out";
  /** qty * the WAC-resolved unit cost (see resolveSaleCost - the SAME
   * function sale_issue already uses, reused here rather than a second
   * costing algorithm). Callers must only invoke this when amount > 0 -
   * the zero-cost-fallback case (isFallback true) posts no journal at
   * all, mirroring postSaleCogsJournalTx's own "only call when > 0" rule. */
  amount: number;
  createdBy: number | null;
}

/**
 * Phase 12G (corrected): values a manual stock adjustment at the current
 * weighted-average cost and posts it to the ledger - adjustment_in (found
 * stock, stocktake increase) is Dr Inventory / Cr Other Income (4300), a
 * genuine gain; adjustment_out (loss, damage, shrinkage) is Dr Other
 * Expenses (5900) / Cr Inventory, a genuine expense. Two different
 * existing accounts on purpose - a gain has no business sitting on an
 * expense account just because both happen to be "the adjustment
 * account". Both are pre-seeded system accounts (chart_of_accounts
 * category 'Other Income' / 'Other Expenses' respectively), resolved via
 * getSystemAccountByCategory like every other account in this file -
 * never hardcoded, and no new account or migration needed since neither a
 * dedicated "Inventory Adjustment" gain/loss pair nor a plain
 * "Inventory Shrinkage" category is seeded, but both Other Income and
 * Other Expenses already are. Must run on a `conn` already inside the
 * caller's transaction.
 */
export async function postStockAdjustmentJournalTx(conn: PoolConnection, input: PostStockAdjustmentJournalInput): Promise<Journal> {
  const inventoryAccountId = await getSystemAccountByCategory(input.companyId, "Inventory");
  if (!inventoryAccountId) {
    throw new AccountingError("Inventory system account not found for this company");
  }

  const description = `Stock adjustment (${input.txnType === "adjustment_in" ? "increase" : "decrease"}) - stock txn #${input.stockTxnId}`;
  let lines: JournalLineInput[];
  if (input.txnType === "adjustment_in") {
    const otherIncomeAccountId = await getSystemAccountByCategory(input.companyId, "Other Income");
    if (!otherIncomeAccountId) {
      throw new AccountingError("Other Income system account not found for this company");
    }
    lines = [
      { account_id: inventoryAccountId, debit: input.amount, credit: 0, description },
      { account_id: otherIncomeAccountId, debit: 0, credit: input.amount, description },
    ];
  } else {
    const otherExpensesAccountId = await getSystemAccountByCategory(input.companyId, "Other Expenses");
    if (!otherExpensesAccountId) {
      throw new AccountingError("Other Expenses system account not found for this company");
    }
    lines = [
      { account_id: otherExpensesAccountId, debit: input.amount, credit: 0, description },
      { account_id: inventoryAccountId, debit: 0, credit: input.amount, description },
    ];
  }

  return createJournalTx(conn, {
    company_id: input.companyId,
    journal_date: input.txnDate,
    reference: null,
    source_type: "stock_adjustment",
    source_id: input.stockTxnId,
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

/** Safe universal fallback expense account when a category has no mapping
 * of its own (or the expense has no category at all) - a real, sensible
 * bucket ("unclassified expense"), never a random/guessed account. */
const DEFAULT_EXPENSE_ACCOUNT_CATEGORY = "Other Expenses";

/**
 * Resolves which company account an expense's amount should debit, via
 * expense_categories.default_account_category (Phase 6) - a
 * company-agnostic chart_of_accounts.category string, resolved per-company
 * through getSystemAccountByCategory exactly like every other account
 * lookup in this file. Falls back to 'Other Expenses' when the category
 * has no mapping, or the expense has no category at all.
 */
export async function resolveExpenseAccountId(companyId: number, categoryId: number | null): Promise<number | undefined> {
  let accountCategory = DEFAULT_EXPENSE_ACCOUNT_CATEGORY;
  if (categoryId) {
    const [rows] = await pool.query<any[]>(
      "SELECT default_account_category FROM expense_categories WHERE id = ?",
      [categoryId]
    );
    if (rows[0]?.default_account_category) {
      accountCategory = rows[0].default_account_category;
    }
  }
  return getSystemAccountByCategory(companyId, accountCategory);
}

export interface PostExpenseJournalInput {
  companyId: number;
  expenseId: number;
  expenseNo: string;
  expenseDate: string;
  /** Pre-tax expense amount. */
  amount: number;
  /** Combined tax_amount as already stored on the expense - never
   * recomputed here (the schema has no CGST/SGST/IGST split to preserve,
   * see Input GST's own doc comment). */
  taxAmount: number;
  categoryId: number | null;
  createdBy: number | null;
}

/**
 * Dr Expense Account (+ Dr Input GST if the expense has tax), Cr Accounts
 * Payable - for the expense's full total_amount. This is NOT "Cr Bank"
 * directly: expenses (audited in Phase 6) have no payment-account field at
 * all - payment is always a separate vendor_payments row, which already
 * posts Dr Accounts Payable / Cr Bank/Cash (Phase 3) whenever one is
 * recorded against this expense, same-day or later. The two postings
 * share the same Accounts Payable account and net correctly regardless of
 * timing - a same-day full payment nets to exactly Dr Expense / Cr Bank,
 * and a genuinely unpaid expense correctly stands as a real Accounts
 * Payable balance. Must run on a `conn` already inside the caller's
 * transaction (see createJournalTx).
 */
export async function postExpenseJournalTx(conn: PoolConnection, input: PostExpenseJournalInput): Promise<Journal> {
  const expenseAccountId = await resolveExpenseAccountId(input.companyId, input.categoryId);
  if (!expenseAccountId) {
    throw new AccountingError(
      `No '${DEFAULT_EXPENSE_ACCOUNT_CATEGORY}' (or category-specific) expense account found for this company`
    );
  }
  const apAccountId = await getSystemAccountByCategory(input.companyId, "Accounts Payable");
  if (!apAccountId) {
    throw new AccountingError("Accounts Payable system account not found for this company");
  }

  const description = `Expense ${input.expenseNo}`;
  const lines: JournalLineInput[] = [{ account_id: expenseAccountId, debit: input.amount, credit: 0, description }];

  if (input.taxAmount > 0) {
    const inputGstAccountId = await getSystemAccountByCategory(input.companyId, "Input GST");
    if (!inputGstAccountId) {
      throw new AccountingError("Input GST system account not found for this company");
    }
    lines.push({ account_id: inputGstAccountId, debit: input.taxAmount, credit: 0, description });
  }

  const total = round2(input.amount + input.taxAmount);
  lines.push({ account_id: apAccountId, debit: 0, credit: total, description });

  return createJournalTx(conn, {
    company_id: input.companyId,
    journal_date: input.expenseDate,
    reference: input.expenseNo,
    source_type: "expense",
    source_id: input.expenseId,
    description,
    created_by: input.createdBy,
    lines,
  });
}

/** One Purchase Bill line, already computed (taxable value / tax), plus the
 * ONE fact this function needs from the caller to classify it - whether the
 * referenced item is currently inventory-tracked. Resolving `track_inventory`
 * is deliberately the CALLER's job (purchaseBills.ts, which already imports
 * services/inventory.ts for stock posting) - accounting.ts stays exactly as
 * decoupled from inventory.ts as it always has been (see inventory.ts's own
 * header comment), receiving only a plain boolean per line, never an item id
 * it would have to look up itself. */
export interface PurchaseBillJournalLine {
  isInventoryTracked: boolean;
  /** Pre-tax (GST-exclusive) amount for this line. */
  taxableValue: number;
  /** This line's share of the bill's tax - GST never enters Inventory or
   * Purchases; it is always posted to Input GST separately (see Phase 12D's
   * approved model's own worked example). */
  taxAmount: number;
}

export interface PostPurchaseBillJournalInput {
  companyId: number;
  billId: number;
  billNo: string;
  billDate: string;
  /** Phase 12D: replaces the old flat subtotal/taxAmount - each line is
   * classified by the caller so this function can split Dr Inventory vs
   * Dr Purchases correctly. A bill with only non-tracked lines behaves
   * identically to before 12D (100% Dr Purchases); a bill with only
   * tracked lines is 100% Dr Inventory; a mixed bill splits accordingly -
   * never merged into one account. */
  lines: PurchaseBillJournalLine[];
  createdBy: number | null;
}

/**
 * Phase 12D: Dr Inventory (1140) for the inventory-tracked portion of the
 * bill, Dr Purchases (5200) for the non-tracked portion (freight, services,
 * items with track_inventory=false - exactly what every Purchase Bill did
 * before this phase), Dr Input GST for the bill's combined tax (still one
 * combined figure - no CGST/SGST/IGST split on the purchase side, unchanged
 * since Phase 6), Cr Accounts Payable for the gross total - the SAME
 * company-specific AP account Expenses (Phase 6) and Vendor Payments
 * (Phase 3) already use, so a Purchase Bill followed by a Vendor Payment
 * nets correctly through that one shared account, exactly like Expenses do.
 * GST is never capitalized into Inventory or Purchases - it is always its
 * own line, computed from the SAME combined tax total as before, split only
 * by which asset/expense account it rides alongside.
 *
 * Either the inventory or the non-tracked bucket may be zero (a bill that's
 * 100% one or the other) - that bucket's line, and its system-account
 * lookup, is simply skipped, so a company that has never needed one of
 * these two accounts isn't forced to have both configured. Must run on a
 * `conn` already inside the caller's transaction (see createJournalTx).
 */
export async function postPurchaseBillJournalTx(conn: PoolConnection, input: PostPurchaseBillJournalInput): Promise<Journal> {
  let inventorySubtotal = 0;
  let nonInventorySubtotal = 0;
  let totalTax = 0;
  for (const line of input.lines) {
    if (line.isInventoryTracked) {
      inventorySubtotal += line.taxableValue;
    } else {
      nonInventorySubtotal += line.taxableValue;
    }
    totalTax += line.taxAmount;
  }
  inventorySubtotal = round2(inventorySubtotal);
  nonInventorySubtotal = round2(nonInventorySubtotal);
  totalTax = round2(totalTax);

  const apAccountId = await getSystemAccountByCategory(input.companyId, "Accounts Payable");
  if (!apAccountId) {
    throw new AccountingError("Accounts Payable system account not found for this company");
  }

  const description = `Purchase Bill ${input.billNo}`;
  const lines: JournalLineInput[] = [];

  if (inventorySubtotal > 0) {
    const inventoryAccountId = await getSystemAccountByCategory(input.companyId, "Inventory");
    if (!inventoryAccountId) {
      throw new AccountingError("Inventory system account not found for this company");
    }
    lines.push({ account_id: inventoryAccountId, debit: inventorySubtotal, credit: 0, description });
  }

  if (nonInventorySubtotal > 0) {
    const purchasesAccountId = await getSystemAccountByCategory(input.companyId, "Purchases");
    if (!purchasesAccountId) {
      throw new AccountingError("Purchases system account not found for this company");
    }
    lines.push({ account_id: purchasesAccountId, debit: nonInventorySubtotal, credit: 0, description });
  }

  if (totalTax > 0) {
    const inputGstAccountId = await getSystemAccountByCategory(input.companyId, "Input GST");
    if (!inputGstAccountId) {
      throw new AccountingError("Input GST system account not found for this company");
    }
    lines.push({ account_id: inputGstAccountId, debit: totalTax, credit: 0, description });
  }

  const total = round2(inventorySubtotal + nonInventorySubtotal + totalTax);
  lines.push({ account_id: apAccountId, debit: 0, credit: total, description });

  return createJournalTx(conn, {
    company_id: input.companyId,
    journal_date: input.billDate,
    reference: input.billNo,
    source_type: "purchase_bill",
    source_id: input.billId,
    description,
    created_by: input.createdBy,
    lines,
  });
}

// ----------------------------------------------------------------------------
// Double-entry rollout, Phase D: Credit Notes (customer-side) and Debit
// Notes (vendor-side) - each is the exact accounting REVERSE of the
// document it corrects (postTaxInvoiceJournalTx / postPurchaseBillJournalTx
// above), for whatever portion of that document's lines the note actually
// covers. Neither knows anything about the "physical goods returning to
// stock" side - that is a second, independent journal
// (postCreditNoteStockReversalJournalTx / postDebitNoteStockReversalJournalTx
// below), posted only for lines actually flagged to restock, exactly
// mirroring how postSaleCogsJournalTx is already its own journal separate
// from postTaxInvoiceJournalTx.
// ----------------------------------------------------------------------------

export interface PostCreditNoteJournalInput {
  companyId: number;
  creditNoteId: number;
  creditNoteNo: string;
  issueDate: string;
  grandTotal: number;
  taxTotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  createdBy: number | null;
}

/**
 * Dr Sales Revenue, Dr Output CGST/SGST/IGST, Cr Accounts Receivable - the
 * exact reverse of postTaxInvoiceJournalTx, for the credited amount only
 * (never the original invoice's full total unless the whole thing is being
 * credited). Only the GST lines actually nonzero are included, same rule
 * postTaxInvoiceJournalTx itself uses.
 */
export async function postCreditNoteJournalTx(conn: PoolConnection, input: PostCreditNoteJournalInput): Promise<Journal> {
  const arAccountId = await getSystemAccountByCategory(input.companyId, "Accounts Receivable");
  if (!arAccountId) {
    throw new AccountingError("Accounts Receivable system account not found for this company");
  }
  const revenueAccountId = await getSystemAccountByCategory(input.companyId, "Sales");
  if (!revenueAccountId) {
    throw new AccountingError("Sales Revenue system account not found for this company");
  }

  const description = `Credit Note ${input.creditNoteNo}`;
  const revenueAmount = round2(input.grandTotal - input.taxTotal);
  const lines: JournalLineInput[] = [{ account_id: arAccountId, debit: 0, credit: input.grandTotal, description }];
  if (revenueAmount > 0) {
    lines.push({ account_id: revenueAccountId, debit: revenueAmount, credit: 0, description });
  }

  if (input.igstTotal > 0) {
    const igstAccountId = await getSystemAccountByCategory(input.companyId, "Output IGST");
    if (!igstAccountId) {
      throw new AccountingError("Output IGST system account not found for this company");
    }
    lines.push({ account_id: igstAccountId, debit: input.igstTotal, credit: 0, description });
  } else {
    if (input.cgstTotal > 0) {
      const cgstAccountId = await getSystemAccountByCategory(input.companyId, "Output CGST");
      if (!cgstAccountId) {
        throw new AccountingError("Output CGST system account not found for this company");
      }
      lines.push({ account_id: cgstAccountId, debit: input.cgstTotal, credit: 0, description });
    }
    if (input.sgstTotal > 0) {
      const sgstAccountId = await getSystemAccountByCategory(input.companyId, "Output SGST");
      if (!sgstAccountId) {
        throw new AccountingError("Output SGST system account not found for this company");
      }
      lines.push({ account_id: sgstAccountId, debit: input.sgstTotal, credit: 0, description });
    }
  }

  return createJournalTx(conn, {
    company_id: input.companyId,
    journal_date: input.issueDate,
    reference: input.creditNoteNo,
    source_type: "credit_note",
    source_id: input.creditNoteId,
    description,
    created_by: input.createdBy,
    lines,
  });
}

export interface PostCreditNoteStockReversalJournalInput {
  companyId: number;
  creditNoteId: number;
  creditNoteNo: string;
  issueDate: string;
  /** Sum of qty * unit_cost across every 'adjustment_in' stock_transactions
   * row this credit note actually posted (read directly from
   * postDocumentStockMovementTx's own returned rows, never recomputed
   * independently - same contract as postSaleCogsJournalTx's cogsAmount).
   * Callers must only invoke this when restockAmount > 0. */
  restockAmount: number;
  createdBy: number | null;
}

/**
 * Dr Inventory, Cr Cost of Goods Sold - the reverse of postSaleCogsJournalTx,
 * for whichever lines were actually flagged to restock (see
 * credit_note_items.restock) at whatever unit_cost the ORIGINAL Tax
 * Invoice's own sale_issue stock_transactions recorded for that item - never
 * today's average - so this exactly undoes the COGS that specific unit
 * contributed, not an approximation of it (see
 * src/routes/creditNotes.ts's resolveOriginalUnitCosts).
 */
export async function postCreditNoteStockReversalJournalTx(
  conn: PoolConnection,
  input: PostCreditNoteStockReversalJournalInput
): Promise<Journal> {
  const cogsAccountId = await getSystemAccountByCategory(input.companyId, "Cost of Goods Sold");
  if (!cogsAccountId) {
    throw new AccountingError("Cost of Goods Sold system account not found for this company");
  }
  const inventoryAccountId = await getSystemAccountByCategory(input.companyId, "Inventory");
  if (!inventoryAccountId) {
    throw new AccountingError("Inventory system account not found for this company");
  }

  const description = `Stock return for Credit Note ${input.creditNoteNo}`;
  return createJournalTx(conn, {
    company_id: input.companyId,
    journal_date: input.issueDate,
    reference: input.creditNoteNo,
    source_type: "credit_note_stock",
    source_id: input.creditNoteId,
    description,
    created_by: input.createdBy,
    lines: [
      { account_id: inventoryAccountId, debit: input.restockAmount, credit: 0, description },
      { account_id: cogsAccountId, debit: 0, credit: input.restockAmount, description },
    ],
  });
}

export interface PostDebitNoteJournalInput {
  companyId: number;
  debitNoteId: number;
  debitNoteNo: string;
  issueDate: string;
  /** Same per-line classification shape postPurchaseBillJournalTx takes -
   * whichever account category the original Purchase Bill line posted to
   * (Inventory vs Purchases) is exactly what this must credit back, so the
   * reversal lands on the same account the original charge did. */
  lines: PurchaseBillJournalLine[];
  createdBy: number | null;
}

/**
 * Dr Accounts Payable, Cr Inventory/Purchases (split per line exactly like
 * postPurchaseBillJournalTx's own Dr side), Cr Input GST - the exact reverse
 * of postPurchaseBillJournalTx, for the debited amount only.
 */
export async function postDebitNoteJournalTx(conn: PoolConnection, input: PostDebitNoteJournalInput): Promise<Journal> {
  let inventorySubtotal = 0;
  let nonInventorySubtotal = 0;
  let totalTax = 0;
  for (const line of input.lines) {
    if (line.isInventoryTracked) {
      inventorySubtotal += line.taxableValue;
    } else {
      nonInventorySubtotal += line.taxableValue;
    }
    totalTax += line.taxAmount;
  }
  inventorySubtotal = round2(inventorySubtotal);
  nonInventorySubtotal = round2(nonInventorySubtotal);
  totalTax = round2(totalTax);

  const apAccountId = await getSystemAccountByCategory(input.companyId, "Accounts Payable");
  if (!apAccountId) {
    throw new AccountingError("Accounts Payable system account not found for this company");
  }

  const description = `Debit Note ${input.debitNoteNo}`;
  const total = round2(inventorySubtotal + nonInventorySubtotal + totalTax);
  const lines: JournalLineInput[] = [{ account_id: apAccountId, debit: total, credit: 0, description }];

  if (inventorySubtotal > 0) {
    const inventoryAccountId = await getSystemAccountByCategory(input.companyId, "Inventory");
    if (!inventoryAccountId) {
      throw new AccountingError("Inventory system account not found for this company");
    }
    lines.push({ account_id: inventoryAccountId, debit: 0, credit: inventorySubtotal, description });
  }

  if (nonInventorySubtotal > 0) {
    const purchasesAccountId = await getSystemAccountByCategory(input.companyId, "Purchases");
    if (!purchasesAccountId) {
      throw new AccountingError("Purchases system account not found for this company");
    }
    lines.push({ account_id: purchasesAccountId, debit: 0, credit: nonInventorySubtotal, description });
  }

  if (totalTax > 0) {
    const inputGstAccountId = await getSystemAccountByCategory(input.companyId, "Input GST");
    if (!inputGstAccountId) {
      throw new AccountingError("Input GST system account not found for this company");
    }
    lines.push({ account_id: inputGstAccountId, debit: 0, credit: totalTax, description });
  }

  return createJournalTx(conn, {
    company_id: input.companyId,
    journal_date: input.issueDate,
    reference: input.debitNoteNo,
    source_type: "debit_note",
    source_id: input.debitNoteId,
    description,
    created_by: input.createdBy,
    lines,
  });
}

// Note: a Debit Note's stock-tracked lines deliberately get NO second
// "stock reversal" journal the way a Credit Note's do. postPurchaseBillJournalTx
// never split "record the sale" from "record its cost" the way
// postTaxInvoiceJournalTx/postSaleCogsJournalTx do - it debits
// Inventory/Purchases directly, in one step, at cost. postDebitNoteJournalTx
// above already reverses that exact entry (Cr Inventory/Purchases), so a
// second Dr Cost of Goods Sold / Cr Inventory journal here would double-count
// the same inventory decrease. The stock QUANTITY ledger (stock_transactions)
// still needs its own 'adjustment_out' row so on-hand quantity/valuation
// stay correct - see src/routes/debitNotes.ts - but that is a quantity
// movement, not a second dollar-value journal.

// ----------------------------------------------------------------------------
// Phase B (Bank & Cash): the three postings below are what replace the old
// `journal_entries` table's create/transfer/opening-balance flows. All three
// exist for exactly the same reason postReceiptJournalTx/
// postVendorPaymentJournalTx do further up this file - a Bank & Cash
// `accounts` row is never itself a Chart of Accounts leaf, so every one of
// these resolves the real posting target via resolveBankCashChartAccountId
// first and throws AccountingError (rolling back the caller's transaction)
// if that account has no linked node.
// ----------------------------------------------------------------------------

export interface PostAccountOpeningBalanceJournalInput {
  companyId: number;
  accountId: number;
  amount: number;
  openingDate: string;
  createdBy: number | null;
}

/**
 * Dr Bank/Cash, Cr Capital - a Bank & Cash account's opening balance is
 * owner's capital brought into the business, the same contra account
 * postOpeningStockJournalTx uses for opening stock. `amount` may be
 * negative (an account that opened overdrawn) - the sign flows through to
 * which side gets the balancing figure via the same debit/credit split
 * every other posting function here uses; validateJournalLines still
 * rejects a zero amount (nothing to post) via its "lines must move
 * something" rule, so callers should skip calling this entirely when the
 * opening balance is 0, same as they already skip a $0 receipt account.
 */
export async function postAccountOpeningBalanceJournalTx(
  conn: PoolConnection,
  input: PostAccountOpeningBalanceJournalInput
): Promise<Journal> {
  const bankChartAccountId = await resolveBankCashChartAccountId(input.accountId, conn);
  if (!bankChartAccountId) {
    throw new AccountingError("Selected account has no linked Chart of Accounts Bank/Cash account");
  }
  const capitalAccountId = await getSystemAccountByCategory(input.companyId, "Capital");
  if (!capitalAccountId) {
    throw new AccountingError("Capital system account not found for this company");
  }

  const amount = round2(Math.abs(input.amount));
  const description = "Opening balance";
  const debitFirst = input.amount >= 0;
  return createJournalTx(conn, {
    company_id: input.companyId,
    journal_date: input.openingDate,
    reference: null,
    source_type: "account_opening_balance",
    source_id: input.accountId,
    description,
    created_by: input.createdBy,
    lines: [
      { account_id: bankChartAccountId, debit: debitFirst ? amount : 0, credit: debitFirst ? 0 : amount, description },
      { account_id: capitalAccountId, debit: debitFirst ? 0 : amount, credit: debitFirst ? amount : 0, description },
    ],
  });
}

export interface PostBankCashEntryJournalInput {
  companyId: number;
  accountId: number;
  /** The other side of this entry - whatever the money actually moved
   * against (Bank Charges, Interest Income, Owner's Capital, ...). A plain
   * Bank & Cash entry always needs one, unlike Receipts/Vendor Payments
   * which have a fixed contra (Accounts Receivable/Payable). */
  contraAccountId: number;
  direction: "in" | "out";
  amount: number;
  entryDate: string;
  particulars: string;
  notes?: string | null;
  createdBy: number | null;
}

/** journals.description is VARCHAR(255) - folds an optional free-text note
 * onto the end of a base description, truncating rather than erroring if
 * the combination would overflow the column. */
function withNotes(base: string, notes?: string | null): string {
  const combined = notes ? `${base} (${notes})` : base;
  return combined.length > 255 ? combined.slice(0, 255) : combined;
}

/**
 * direction 'in': Dr Bank/Cash, Cr contra account.
 * direction 'out': Dr contra account, Cr Bank/Cash.
 * source_id is left null - unlike Receipts/Vendor Payments there is no
 * separate business record this posting belongs to any more (the old
 * journal_entries row is gone); the journal itself IS the record.
 */
export async function postBankCashEntryJournalTx(
  conn: PoolConnection,
  input: PostBankCashEntryJournalInput
): Promise<Journal> {
  const bankChartAccountId = await resolveBankCashChartAccountId(input.accountId, conn);
  if (!bankChartAccountId) {
    throw new AccountingError("Selected account has no linked Chart of Accounts Bank/Cash account");
  }

  const amount = round2(input.amount);
  const description = withNotes(input.particulars, input.notes);
  const inDirection = input.direction === "in";
  return createJournalTx(conn, {
    company_id: input.companyId,
    journal_date: input.entryDate,
    reference: null,
    source_type: "bank_cash_entry",
    source_id: null,
    description,
    created_by: input.createdBy,
    lines: [
      { account_id: bankChartAccountId, debit: inDirection ? amount : 0, credit: inDirection ? 0 : amount, description },
      { account_id: input.contraAccountId, debit: inDirection ? 0 : amount, credit: inDirection ? amount : 0, description },
    ],
  });
}

export interface PostAccountTransferJournalInput {
  companyId: number;
  fromAccountId: number;
  toAccountId: number;
  amount: number;
  entryDate: string;
  fromAccountName: string;
  toAccountName: string;
  notes?: string | null;
  createdBy: number | null;
}

/**
 * Dr destination Bank/Cash, Cr source Bank/Cash - a transfer between two of
 * a company's own accounts is a single balanced journal now, replacing the
 * old two-linked-journal_entries-rows-sharing-a-transfer_group hack. Both
 * accounts must belong to `companyId` - createJournalTx's own company-match
 * check (via insertJournalRows) already enforces this, so a cross-company
 * transfer is rejected the same way a cross-company manual journal would be.
 */
export async function postAccountTransferJournalTx(
  conn: PoolConnection,
  input: PostAccountTransferJournalInput
): Promise<Journal> {
  const fromChartAccountId = await resolveBankCashChartAccountId(input.fromAccountId, conn);
  if (!fromChartAccountId) {
    throw new AccountingError("Source account has no linked Chart of Accounts Bank/Cash account");
  }
  const toChartAccountId = await resolveBankCashChartAccountId(input.toAccountId, conn);
  if (!toChartAccountId) {
    throw new AccountingError("Destination account has no linked Chart of Accounts Bank/Cash account");
  }

  const amount = round2(input.amount);
  const description = withNotes(`Transfer: ${input.fromAccountName} to ${input.toAccountName}`, input.notes);
  return createJournalTx(conn, {
    company_id: input.companyId,
    journal_date: input.entryDate,
    reference: null,
    source_type: "account_transfer",
    source_id: null,
    description,
    created_by: input.createdBy,
    lines: [
      { account_id: toChartAccountId, debit: amount, credit: 0, description },
      { account_id: fromChartAccountId, debit: 0, credit: amount, description },
    ],
  });
}

// ---- Double-entry rollout, Phase F: Fixed Assets + Depreciation. Three
// posting functions for the three journals a fixed asset ever generates
// over its lifetime - acquisition (once), depreciation (repeatedly, one per
// period run), and disposal (once, terminal). See schema.sql's comment on
// fixed_assets for the full design. ----

export interface PostFixedAssetAcquisitionJournalInput {
  companyId: number;
  fixedAssetId: number;
  cost: number;
  contraAccountId: number;
  purchaseDate: string;
  assetName: string;
  createdBy: number | null;
}

/**
 * Dr Fixed Assets (the one shared "1200" leaf every asset's cost posts
 * against - same convention Inventory/Accounts Receivable already use, not
 * a dedicated leaf per asset), Cr whatever Chart of Accounts leaf the user
 * says the money actually came from/went to (Bank, Cash, Accounts Payable,
 * Capital...) - the same "pick any true-leaf contra account" pattern
 * postBankCashEntryJournalTx already established.
 */
export async function postFixedAssetAcquisitionJournalTx(
  conn: PoolConnection,
  input: PostFixedAssetAcquisitionJournalInput
): Promise<Journal> {
  const fixedAssetChartId = await getSystemAccountByCategory(input.companyId, "Fixed Assets");
  if (!fixedAssetChartId) throw new AccountingError("This company has no Fixed Assets account configured");

  const amount = round2(input.cost);
  const description = `Fixed Asset acquired: ${input.assetName}`;
  return createJournalTx(conn, {
    company_id: input.companyId,
    journal_date: input.purchaseDate,
    reference: null,
    source_type: "fixed_asset",
    source_id: input.fixedAssetId,
    description,
    created_by: input.createdBy,
    lines: [
      { account_id: fixedAssetChartId, debit: amount, credit: 0, description },
      { account_id: input.contraAccountId, debit: 0, credit: amount, description },
    ],
  });
}

export interface PostFixedAssetDepreciationJournalInput {
  companyId: number;
  depreciationEntryId: number;
  amount: number;
  periodEndDate: string;
  assetName: string;
  createdBy: number | null;
}

/**
 * Dr Depreciation (expense), Cr Accumulated Depreciation (the contra-asset
 * sibling of Fixed Assets - see schema.sql's comment on chart_of_accounts
 * '1210' for why a credit balance there correctly reduces Total Assets with
 * no other code changes needed). source_id is the
 * fixed_asset_depreciation_entries row's own id, not the asset's id - an
 * asset generates MANY of these journals over its life (one per period
 * run), so "the latest journal for this source" (getJournalBySource's
 * assumption everywhere else in this app) would be meaningless here; each
 * period's entry needs its own independently-reversible journal.
 */
export async function postFixedAssetDepreciationJournalTx(
  conn: PoolConnection,
  input: PostFixedAssetDepreciationJournalInput
): Promise<Journal> {
  const depreciationChartId = await getSystemAccountByCategory(input.companyId, "Depreciation");
  const accumulatedChartId = await getSystemAccountByCategory(input.companyId, "Accumulated Depreciation");
  if (!depreciationChartId || !accumulatedChartId) {
    throw new AccountingError("This company has no Depreciation/Accumulated Depreciation account configured");
  }

  const amount = round2(input.amount);
  const description = `Depreciation: ${input.assetName} (period ending ${input.periodEndDate})`;
  return createJournalTx(conn, {
    company_id: input.companyId,
    journal_date: input.periodEndDate,
    reference: null,
    source_type: "fixed_asset_depreciation",
    source_id: input.depreciationEntryId,
    description,
    created_by: input.createdBy,
    lines: [
      { account_id: depreciationChartId, debit: amount, credit: 0, description },
      { account_id: accumulatedChartId, debit: 0, credit: amount, description },
    ],
  });
}

export interface PostFixedAssetDisposalJournalInput {
  companyId: number;
  fixedAssetId: number;
  cost: number;
  accumulatedDepreciation: number;
  disposalAmount: number;
  contraAccountId: number | null;
  disposalDate: string;
  assetName: string;
  createdBy: number | null;
}

/**
 * Removes an asset from the books entirely: Cr Fixed Assets (its full
 * original cost), Dr Accumulated Depreciation (everything accrued against
 * it to date - zeroing out just this asset's share of that shared contra
 * leaf), Dr the contra account for any disposal proceeds received, and a
 * balancing Gain/Loss on Disposal line for whatever's left over so the
 * journal still balances:
 *   bookValue = cost - accumulatedDepreciation
 *   gainOrLoss = disposalAmount - bookValue
 * A positive gainOrLoss (sold above book value) credits Other Income; a
 * negative one (sold below book value, including a full write-off at
 * disposalAmount = 0) debits Other Expenses. Proven to balance for every
 * sign combination - see this function's own tests/comment in
 * fixedAssets.ts's dispose route for the worked algebra.
 */
export async function postFixedAssetDisposalJournalTx(
  conn: PoolConnection,
  input: PostFixedAssetDisposalJournalInput
): Promise<Journal> {
  const fixedAssetChartId = await getSystemAccountByCategory(input.companyId, "Fixed Assets");
  const accumulatedChartId = await getSystemAccountByCategory(input.companyId, "Accumulated Depreciation");
  if (!fixedAssetChartId || !accumulatedChartId) {
    throw new AccountingError("This company has no Fixed Assets/Accumulated Depreciation account configured");
  }

  const cost = round2(input.cost);
  const accumulated = round2(input.accumulatedDepreciation);
  const disposalAmount = round2(input.disposalAmount);
  const bookValue = round2(cost - accumulated);
  const gainOrLoss = round2(disposalAmount - bookValue);
  const description = `Disposal of Fixed Asset: ${input.assetName}`;

  const lines: JournalLineInput[] = [{ account_id: fixedAssetChartId, debit: 0, credit: cost, description }];
  if (accumulated > 0) {
    lines.push({ account_id: accumulatedChartId, debit: accumulated, credit: 0, description });
  }
  if (disposalAmount > 0) {
    if (!input.contraAccountId) throw new AccountingError("A receiving account is required when disposal proceeds are greater than zero");
    lines.push({ account_id: input.contraAccountId, debit: disposalAmount, credit: 0, description });
  }
  if (gainOrLoss > 0) {
    const gainChartId = await getSystemAccountByCategory(input.companyId, "Other Income");
    if (!gainChartId) throw new AccountingError("This company has no Other Income account configured");
    lines.push({ account_id: gainChartId, debit: 0, credit: gainOrLoss, description: `${description} (gain)` });
  } else if (gainOrLoss < 0) {
    const lossChartId = await getSystemAccountByCategory(input.companyId, "Other Expenses");
    if (!lossChartId) throw new AccountingError("This company has no Other Expenses account configured");
    lines.push({ account_id: lossChartId, debit: -gainOrLoss, credit: 0, description: `${description} (loss)` });
  }

  return createJournalTx(conn, {
    company_id: input.companyId,
    journal_date: input.disposalDate,
    reference: null,
    source_type: "fixed_asset_disposal",
    source_id: input.fixedAssetId,
    description,
    created_by: input.createdBy,
    lines,
  });
}

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
 *
 * The date filter lives in the pre-aggregating subquery's own WHERE
 * clause, not as a secondary LEFT JOIN's ON condition against the
 * unconditionally-joined journal_lines rows above it - a bug discovered
 * during Phase 10 (and shared by getProfitAndLoss/getBalanceSheet, fixed
 * identically in both): joining journal_lines to chart_of_accounts with no
 * date restriction, then only filtering journals' own columns via a LEFT
 * JOIN ON clause, does NOT remove the journal_lines row from the result
 * set or its SUM - it only nulls out journals' columns for that row. A
 * journal_line dated after asOfDate would silently still contribute to
 * the sum. Pre-aggregating in a subquery with the date filter in a real
 * WHERE clause (the same safe shape getAccountBalance/
 * getAccountOpeningBalance already use) closes this off correctly.
 */
export async function getTrialBalance(companyId: number, asOfDate: string): Promise<TrialBalanceResult> {
  const [rows] = await pool.query<any[]>(
    `SELECT coa.id as account_id, coa.account_code, coa.name, coa.account_type, coa.category, coa.normal_balance,
            COALESCE(agg.total_debit, 0) - COALESCE(agg.total_credit, 0) as net
     FROM chart_of_accounts coa
     LEFT JOIN (
       SELECT jl.account_id, SUM(jl.debit) as total_debit, SUM(jl.credit) as total_credit
       FROM journal_lines jl
       JOIN journals j ON j.id = jl.journal_id
       WHERE j.journal_date <= ?
       GROUP BY jl.account_id
     ) agg ON agg.account_id = coa.id
     WHERE coa.company_id = ? AND coa.is_active = 1
       AND (COALESCE(agg.total_debit, 0) <> 0 OR COALESCE(agg.total_credit, 0) <> 0)
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

export interface ProfitAndLossRow {
  account_id: number;
  account_code: string;
  name: string;
  category: string | null;
  amount: number;
}

export interface ProfitAndLossResult {
  from: string;
  to: string;
  income: ProfitAndLossRow[];
  expenses: ProfitAndLossRow[];
  totalIncome: number;
  totalExpenses: number;
  netProfit: number;
}

/**
 * Built entirely from journals + journal_lines + chart_of_accounts (never
 * documents/expenses/purchase_bills/receipts/vendor_payments, and never the
 * legacy reports.ts queries) - for one company's active revenue/expense
 * accounts, over a date range (Phase 8, Step 18). Balance-sheet accounts
 * (asset/liability/equity - Cash, Bank, Accounts Receivable/Payable, Input
 * GST, Output CGST/SGST/IGST, GST Payable, ...) are excluded by construction
 * via the `account_type IN ('revenue','expense')` filter, never by naming or
 * category matching, so no future liability/asset account can leak in.
 *
 * Sums every journal line in range regardless of `status` - same reasoning
 * as getTrialBalance: a reversed original and its posted reversal must both
 * be summed for an edited/cancelled transaction's net contribution to come
 * out correct (zero if fully reversed, or exactly the corrected figure if
 * reversed-then-reposted). Filtering to `status = 'posted'` only would
 * silently drop the original half of that cancelling pair.
 *
 * Income = Credit - Debit (revenue accounts normally carry a credit
 * balance); Expense = Debit - Credit (expense accounts normally carry a
 * debit balance) - the exact formula requested, applied in JS after the
 * single aggregate query, mirroring getTrialBalance's net-then-sign shape.
 * Net Profit = Total Income - Total Expenses, never forced to reconcile to
 * anything - unlike a Trial Balance, a P&L has no reason to balance to zero.
 * An account with zero net activity in range (including one whose activity
 * was fully offset by a reversal) is omitted, same convention as
 * getTrialBalance.
 *
 * The date range filter lives in the pre-aggregating subquery's own WHERE
 * clause - a bug discovered during Phase 10 (shared by getTrialBalance/
 * getBalanceSheet, fixed identically in both): joining journal_lines to
 * chart_of_accounts with no date restriction, then only filtering
 * journals' own columns via a secondary LEFT JOIN's ON clause, does NOT
 * remove the journal_lines row from the result set or its SUM - a
 * journal_line dated outside [from, to] would silently still contribute.
 * Pre-aggregating in a subquery with the range filter in a real WHERE
 * clause (the same safe shape getAccountBalance/getAccountOpeningBalance
 * already use) closes this off correctly.
 */
export async function getProfitAndLoss(companyId: number, from: string, to: string): Promise<ProfitAndLossResult> {
  const [rows] = await pool.query<any[]>(
    `SELECT coa.id as account_id, coa.account_code, coa.name, coa.account_type, coa.category,
            COALESCE(agg.total_debit, 0) as total_debit, COALESCE(agg.total_credit, 0) as total_credit
     FROM chart_of_accounts coa
     LEFT JOIN (
       SELECT jl.account_id, SUM(jl.debit) as total_debit, SUM(jl.credit) as total_credit
       FROM journal_lines jl
       JOIN journals j ON j.id = jl.journal_id
       WHERE j.journal_date BETWEEN ? AND ?
       GROUP BY jl.account_id
     ) agg ON agg.account_id = coa.id
     WHERE coa.company_id = ? AND coa.is_active = 1 AND coa.account_type IN ('revenue', 'expense')
       AND (COALESCE(agg.total_debit, 0) <> 0 OR COALESCE(agg.total_credit, 0) <> 0)
     ORDER BY coa.account_code ASC`,
    [from, to, companyId]
  );

  const income: ProfitAndLossRow[] = [];
  const expenses: ProfitAndLossRow[] = [];
  for (const r of rows) {
    const debit = Number(r.total_debit);
    const credit = Number(r.total_credit);
    const row: ProfitAndLossRow = {
      account_id: r.account_id,
      account_code: r.account_code,
      name: r.name,
      category: r.category,
      amount: r.account_type === "revenue" ? round2(credit - debit) : round2(debit - credit),
    };
    if (r.account_type === "revenue") income.push(row);
    else expenses.push(row);
  }

  const totalIncome = round2(income.reduce((s, r) => s + r.amount, 0));
  const totalExpenses = round2(expenses.reduce((s, r) => s + r.amount, 0));

  return {
    from,
    to,
    income,
    expenses,
    totalIncome,
    totalExpenses,
    netProfit: round2(totalIncome - totalExpenses),
  };
}

export interface BalanceSheetRow {
  /** Null only for the synthesized "Retained Earnings (Current)" row - see
   * getBalanceSheet's doc comment. Every real chart_of_accounts row has one. */
  account_id: number | null;
  account_code: string | null;
  name: string;
  category: string | null;
  amount: number;
}

export interface BalanceSheetResult {
  asOfDate: string;
  assets: BalanceSheetRow[];
  liabilities: BalanceSheetRow[];
  /** Includes the synthesized "Retained Earnings (Current)" row alongside
   * the real (today: always zero) stored Capital/Retained Earnings/Drawings
   * balances - see doc comment below for why that row exists. */
  equity: BalanceSheetRow[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  /** True when totalAssets === totalLiabilities + totalEquity - a defensive
   * integrity check, surfaced honestly, never silently corrected, same as
   * getTrialBalance's isBalanced. */
  isBalanced: boolean;
}

/**
 * Built entirely from journals + journal_lines + chart_of_accounts (never
 * accounts.opening_balance or the old journal_entries table - those are a
 * completely separate, ledger-invisible balance system for the pre-existing
 * Bank & Cash module; see Phase 9's audit for the full explanation of why
 * this report's Cash/Bank figures may not match that module's own displayed
 * balance whenever either is nonzero for a given company). For one
 * company's active asset/liability/equity accounts, as of `asOfDate`
 * (inclusive) - a Balance Sheet is a point-in-time snapshot, not a range,
 * so this takes a single date the same way getTrialBalance does.
 *
 * Sums every journal line up to asOfDate regardless of `status` - same
 * reasoning as getTrialBalance/getProfitAndLoss: a reversed original and
 * its posted reversal must both be summed for an edited/deleted
 * transaction's net contribution to come out correct (zero if fully
 * reversed), never silently wrong by double the reversed amount. There is
 * absolutely no `status = 'posted'` filter anywhere in this function's
 * arithmetic.
 *
 * Revenue/expense accounts are never queried directly here - but their
 * *effect* still has to appear somewhere on the Equity side, because this
 * app has no year-end closing mechanism (nothing ever sweeps Sales/
 * Expenses balances into Retained Earnings - confirmed by Phase 9's audit:
 * Retained Earnings is a seeded account with zero postings, ever). Without
 * accounting for that activity, `Assets = Liabilities + Equity` could never
 * hold, since a balanced double-entry ledger only guarantees
 * `Assets + Expenses = Liabilities + Equity + Revenue` across ALL FIVE
 * account types together - rearranged, `Assets = Liabilities + Equity +
 * (Revenue - Expenses)`. So the missing `(Revenue - Expenses)` term - every
 * revenue/expense journal line ever posted, from the beginning of time
 * through asOfDate - is computed via getProfitAndLoss and injected as one
 * extra, clearly-marked equity row: "Retained Earnings (Current)". This
 * row is NEVER a chart_of_accounts record and NEVER backed by a journal
 * entry - it is a pure display computation, re-derived on every call, and
 * is what makes the identity hold for a system with no formal period close.
 * The real, separately-seeded `3200 Retained Earnings` account is left
 * completely alone alongside it (today: always zero, since nothing posts
 * to it) - the two are never merged into one figure.
 *
 * An account with zero net activity as of asOfDate is omitted, same
 * convention as getTrialBalance. Company isolation is structural
 * (`coa.company_id = ?` in the query itself) - there is no separate
 * account_id parameter for a cross-company mismatch to even be possible.
 * isBalanced is a defensive, honest check - this function never forces
 * totalAssets to equal totalLiabilities + totalEquity; if a manually-posted
 * journal or a real accounting-integrity problem breaks the identity, that
 * is surfaced as `isBalanced: false`, exactly like getTrialBalance already
 * does for its own totals.
 *
 * The date filter lives in the pre-aggregating subquery's own WHERE
 * clause - a bug discovered during Phase 10 (shared by getTrialBalance/
 * getProfitAndLoss, fixed identically in both): joining journal_lines to
 * chart_of_accounts with no date restriction, then only filtering
 * journals' own columns via a secondary LEFT JOIN's ON clause, does NOT
 * remove the journal_lines row from the result set or its SUM - a
 * journal_line dated after asOfDate would silently still contribute.
 * Pre-aggregating in a subquery with the date filter in a real WHERE
 * clause (the same safe shape getAccountBalance/getAccountOpeningBalance
 * already use) closes this off correctly.
 */
export async function getBalanceSheet(companyId: number, asOfDate: string): Promise<BalanceSheetResult> {
  const [rows] = await pool.query<any[]>(
    `SELECT coa.id as account_id, coa.account_code, coa.name, coa.account_type, coa.category,
            COALESCE(agg.total_debit, 0) - COALESCE(agg.total_credit, 0) as net
     FROM chart_of_accounts coa
     LEFT JOIN (
       SELECT jl.account_id, SUM(jl.debit) as total_debit, SUM(jl.credit) as total_credit
       FROM journal_lines jl
       JOIN journals j ON j.id = jl.journal_id
       WHERE j.journal_date <= ?
       GROUP BY jl.account_id
     ) agg ON agg.account_id = coa.id
     WHERE coa.company_id = ? AND coa.is_active = 1 AND coa.account_type IN ('asset', 'liability', 'equity')
       AND (COALESCE(agg.total_debit, 0) <> 0 OR COALESCE(agg.total_credit, 0) <> 0)
     ORDER BY coa.account_code ASC`,
    [asOfDate, companyId]
  );

  const assets: BalanceSheetRow[] = [];
  const liabilities: BalanceSheetRow[] = [];
  const equity: BalanceSheetRow[] = [];
  for (const r of rows) {
    const net = round2(Number(r.net));
    const row: BalanceSheetRow = {
      account_id: r.account_id,
      account_code: r.account_code,
      name: r.name,
      category: r.category,
      // Assets are debit-normal (positive net -> a real balance); liabilities
      // and equity are credit-normal (negative net -> a real balance) - same
      // sign convention getTrialBalance already uses, just split by section
      // instead of into a single debit/credit pair of columns.
      amount: r.account_type === "asset" ? net : -net,
    };
    if (r.account_type === "asset") assets.push(row);
    else if (r.account_type === "liability") liabilities.push(row);
    else equity.push(row);
  }

  const { netProfit } = await getProfitAndLoss(companyId, "1900-01-01", asOfDate);
  equity.push({
    account_id: null,
    account_code: null,
    name: "Retained Earnings (Current)",
    category: "Computed",
    amount: netProfit,
  });

  const totalAssets = round2(assets.reduce((s, r) => s + r.amount, 0));
  const totalLiabilities = round2(liabilities.reduce((s, r) => s + r.amount, 0));
  const totalEquity = round2(equity.reduce((s, r) => s + r.amount, 0));

  return {
    asOfDate,
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    isBalanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
  };
}

export interface CashFlowAdjustment {
  category: string;
  amount: number;
}

export interface CashFlowSection {
  adjustments: CashFlowAdjustment[];
  total: number;
}

export interface CashFlowResult {
  from: string;
  to: string;
  netProfit: number;
  operatingActivities: CashFlowSection;
  investingActivities: CashFlowSection;
  financingActivities: CashFlowSection;
  netChangeInCash: number;
  openingCashBalance: number;
  closingCashBalance: number;
  /** Independently computed Cash+Bank balance as of `to`, via
   * getAccountBalance directly - compared against closingCashBalance
   * (openingCashBalance + netChangeInCash) to produce `reconciles` below. */
  actualClosingCashBalance: number;
  /** True when closingCashBalance matches actualClosingCashBalance - a
   * defensive integrity check, surfaced honestly, never silently corrected,
   * same spirit as getTrialBalance's isBalanced and getBalanceSheet's
   * isBalanced. */
  reconciles: boolean;
}

// Operating-activity working-capital accounts: an increase in a current
// asset consumes cash (sign -1), an increase in a current liability frees
// cash (sign +1). Cash/Bank themselves are deliberately excluded here -
// they are the thing being measured, not an adjustment to it. Every
// category below is one already established by Phase 2/4/6's chart_of_accounts
// seed (see schema.sql) - nothing invented for this phase.
const OPERATING_DELTA_CATEGORIES: { category: string; label: string; sign: 1 | -1 }[] = [
  { category: "Accounts Receivable", label: "Accounts Receivable", sign: -1 },
  { category: "Inventory", label: "Inventory", sign: -1 },
  { category: "Other Current Assets", label: "Other Current Assets", sign: -1 },
  { category: "Input GST", label: "Input GST", sign: -1 },
  { category: "Accounts Payable", label: "Accounts Payable", sign: 1 },
  { category: "GST/Tax Payable", label: "GST Payable", sign: 1 },
  { category: "Output CGST", label: "Output CGST", sign: 1 },
  { category: "Output SGST", label: "Output SGST", sign: 1 },
  { category: "Output IGST", label: "Output IGST", sign: 1 },
  { category: "Other Current Liabilities", label: "Other Current Liabilities", sign: 1 },
];

// Investing: an increase in Fixed Assets is a cash outflow (sign -1).
const INVESTING_DELTA_CATEGORIES: { category: string; label: string; sign: 1 | -1 }[] = [
  { category: "Fixed Assets", label: "Fixed Assets", sign: -1 },
];

// Financing: an increase in Capital/Loans is a cash inflow (sign +1); an
// increase in Drawings (debit-normal, reduces equity) is a cash outflow
// (sign -1). The real, separately-seeded 3200 Retained Earnings account is
// deliberately excluded from every section here - it has zero postings
// today, is not a working-capital account, and its Profit & Loss
// contribution is already fully captured via netProfit above (see Phase 10's
// audit for the full reasoning).
const FINANCING_DELTA_CATEGORIES: { category: string; label: string; sign: 1 | -1 }[] = [
  { category: "Capital", label: "Capital", sign: 1 },
  { category: "Loans", label: "Loans", sign: 1 },
  { category: "Drawings", label: "Drawings", sign: -1 },
];

/**
 * Period delta for one company account category: getAccountBalance(to) -
 * getAccountOpeningBalance(from) - reusing both primitives exactly as-is
 * (Phase 5), so reversal-safety (both sum every journal line regardless of
 * status) and journal_date semantics come for free rather than being
 * re-derived a fourth time. Returns 0 (not an error) when the company has
 * no seeded account for this category - a read-only report should never
 * fail just because one category happens to be unused, the same way
 * getProfitAndLoss/getBalanceSheet already omit unused accounts rather
 * than erroring.
 */
async function categoryDelta(companyId: number, category: string, from: string, to: string): Promise<number> {
  const accountId = await getSystemAccountByCategory(companyId, category);
  if (!accountId) return 0;
  const closing = await getAccountBalance(accountId, to);
  const opening = await getAccountOpeningBalance(accountId, from);
  return round2(closing - opening);
}

async function buildSection(
  companyId: number,
  entries: { category: string; label: string; sign: 1 | -1 }[],
  from: string,
  to: string
): Promise<CashFlowSection> {
  const adjustments: CashFlowAdjustment[] = [];
  for (const entry of entries) {
    const delta = await categoryDelta(companyId, entry.category, from, to);
    const amount = round2(delta * entry.sign);
    if (amount !== 0) adjustments.push({ category: entry.label, amount });
  }
  const total = round2(adjustments.reduce((s, a) => s + a.amount, 0));
  return { adjustments, total };
}

/**
 * Indirect-method Cash Flow Statement, built entirely from journals +
 * journal_lines + chart_of_accounts (never accounts.opening_balance or the
 * old journal_entries table - same standing exclusion as getBalanceSheet;
 * both are currently empty for every company, per Phase 10's audit, but
 * remain architecturally independent regardless).
 *
 * Net Cash from Operating = netProfit (getProfitAndLoss over the period)
 * plus the period's change in every live operating working-capital
 * account (AR/Inventory/Other Current Assets/Input GST consume cash on
 * increase; AP/GST liabilities free cash on increase). Net Cash from
 * Investing/Financing are the corresponding Fixed Assets / Capital+Loans-
 * Drawings deltas - always Rs. 0 for every company today, since nothing
 * has ever posted to those accounts (Phase 9's finding, unchanged).
 *
 * `reconciles` is a genuine, non-tautological integrity check: the
 * indirect-method total (netProfit + working-capital deltas) is derived
 * from an entirely different set of numbers than the *actual* Cash+Bank
 * balance change over the same period, computed independently via
 * getAccountBalance/getAccountOpeningBalance on the Cash/Bank accounts
 * directly - by the fundamental double-entry identity these are
 * guaranteed to be equal, so any mismatch is a real accounting-integrity
 * signal, never silently forced to close (same spirit as getTrialBalance's
 * and getBalanceSheet's own isBalanced checks).
 */
export async function getCashFlowStatement(companyId: number, from: string, to: string): Promise<CashFlowResult> {
  const { netProfit } = await getProfitAndLoss(companyId, from, to);

  const operatingDeltas = await buildSection(companyId, OPERATING_DELTA_CATEGORIES, from, to);
  const operatingActivities: CashFlowSection = {
    adjustments: operatingDeltas.adjustments,
    total: round2(netProfit + operatingDeltas.total),
  };
  const investingActivities = await buildSection(companyId, INVESTING_DELTA_CATEGORIES, from, to);
  const financingActivities = await buildSection(companyId, FINANCING_DELTA_CATEGORIES, from, to);

  const netChangeInCash = round2(operatingActivities.total + investingActivities.total + financingActivities.total);

  const cashId = await getSystemAccountByCategory(companyId, "Cash");
  const bankId = await getSystemAccountByCategory(companyId, "Bank");
  const openingCash = round2(
    (cashId ? await getAccountOpeningBalance(cashId, from) : 0) + (bankId ? await getAccountOpeningBalance(bankId, from) : 0)
  );
  const actualClosingCashBalance = round2(
    (cashId ? await getAccountBalance(cashId, to) : 0) + (bankId ? await getAccountBalance(bankId, to) : 0)
  );
  const closingCashBalance = round2(openingCash + netChangeInCash);

  return {
    from,
    to,
    netProfit,
    operatingActivities,
    investingActivities,
    financingActivities,
    netChangeInCash,
    openingCashBalance: openingCash,
    closingCashBalance,
    actualClosingCashBalance,
    reconciles: Math.abs(closingCashBalance - actualClosingCashBalance) < 0.01,
  };
}

export interface GstSummaryResult {
  from: string;
  to: string;
  inputGst: number;
  outputCgst: number;
  outputSgst: number;
  outputIgst: number;
  totalOutputGst: number;
  /** Total Output GST - Input GST for this period. Positive = payable,
   * negative = refundable. Always the computed figure below - never
   * replaced by gstPayableAccountBalance. */
  netGst: number;
  /** The real 2120 GST Payable account's own cumulative balance as of `to`
   * - shown for transparency only. Confirmed by Phase 11's audit that
   * nothing in this codebase currently posts to this account, so it is
   * expected to be 0 today; if it is ever nonzero (e.g. a future manual
   * settlement journal), that fact is surfaced here rather than silently
   * substituted for netGst above. */
  gstPayableAccountBalance: number;
}

/**
 * The period activity of one GST account: getAccountBalance(to) -
 * getAccountOpeningBalance(from) - the same categoryDelta pattern
 * getCashFlowStatement already uses for working-capital deltas. Since
 * balance(to) sums every journal line with journal_date <= to and
 * openingBalance(from) sums every line with journal_date < from, the
 * difference is exactly the sum of journal lines with journal_date in
 * [from, to] - using journals.journal_date, never created_at, and with no
 * `status` filter anywhere (both primitives are already status-agnostic,
 * so an original + its reversal net to exactly zero, and an edited
 * transaction's old/new journals net to exactly the corrected figure).
 * Returns 0 (not an error) when the company has no seeded account for this
 * category, same defensive convention as getCashFlowStatement.
 */
async function gstAccountPeriodActivity(companyId: number, category: string, from: string, to: string): Promise<number> {
  const accountId = await getSystemAccountByCategory(companyId, category);
  if (!accountId) return 0;
  const closing = await getAccountBalance(accountId, to);
  const opening = await getAccountOpeningBalance(accountId, from);
  return round2(closing - opening);
}

/**
 * Ledger-based GST Summary (Phase 11A) - built entirely from journals +
 * journal_lines + chart_of_accounts, replacing the legacy documents/
 * expenses-based /api/reports/gst-summary query. Resolves every account by
 * category via getSystemAccountByCategory (never a hardcoded id), so it is
 * company-isolated the same structural way every other Phase 8-10 report
 * is - there is no cross-company parameter for a mismatch to even be
 * possible.
 *
 * Input GST here naturally includes BOTH Purchase Bills and Expenses,
 * fixing the gap the audit found in the legacy report (which only ever
 * summed expenses.tax_amount) - because both already post to the same
 * 1151 Input GST account, a ledger read of that one account picks up
 * everything by construction, with no source-table-specific logic needed.
 *
 * Output CGST/SGST/IGST are summed the same way from their own accounts
 * (2121/2122/2123) - correctly reflecting only currently-active postings,
 * so the Phase 11A cancellation fix (Tax Invoice/Purchase Bill cancel now
 * reverses rather than leaving a stale posting) is what makes a cancelled
 * document's GST correctly disappear from this report, not anything
 * GST-Summary-specific.
 *
 * totalOutputGst and netGst are always the computed figures - the real,
 * separately-seeded 2120 GST Payable account is surfaced only as
 * gstPayableAccountBalance, a transparency figure, never substituted for
 * netGst (Phase 11A's explicit requirement - see the audit's finding that
 * nothing posts to 2120 today).
 */
export async function getGstSummary(companyId: number, from: string, to: string): Promise<GstSummaryResult> {
  const inputGst = await gstAccountPeriodActivity(companyId, "Input GST", from, to);
  const outputCgst = await gstAccountPeriodActivity(companyId, "Output CGST", from, to);
  const outputSgst = await gstAccountPeriodActivity(companyId, "Output SGST", from, to);
  const outputIgst = await gstAccountPeriodActivity(companyId, "Output IGST", from, to);
  const totalOutputGst = round2(outputCgst + outputSgst + outputIgst);
  const netGst = round2(totalOutputGst - inputGst);

  const gstPayableAccountId = await getSystemAccountByCategory(companyId, "GST/Tax Payable");
  const gstPayableAccountBalance = gstPayableAccountId ? await getAccountBalance(gstPayableAccountId, to) : 0;

  return {
    from,
    to,
    inputGst,
    outputCgst,
    outputSgst,
    outputIgst,
    totalOutputGst,
    netGst,
    gstPayableAccountBalance,
  };
}
