import { Pool, PoolConnection } from "mysql2/promise";
import { pool } from "../config/db";
import { Item, StockTransaction, StockTxnType } from "../types";

// Phase 12: Inventory & Stock Management - quantity-only stock ledger.
//
// Deliberately its own service file, mirroring src/services/accounting.ts's
// journal/reversal shape as closely as possible (see stock_transactions'
// own schema.sql comment): immutable rows, correction-by-reversal, a
// company-scoped ledger summed by SIGN-BY-TYPE rather than a signed qty
// column. This file has NO relationship to accounting.ts - no journal, no
// journal_lines, no COGS/Inventory GL posting - by design, per the Phase
// 12A audit's recommended smallest production-safe scope. A future
// valuation phase may wire the two together; this one does not.

/** Thrown for any inventory-rule violation. Routes catch this and respond
 * 400 with `.message`, mirroring AccountingError's contract exactly. */
export class InventoryError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "InventoryError";
  }
}

export interface InsufficientStockItem {
  itemId: number;
  itemName: string;
  requestedQty: number;
  availableQty: number;
}

/** Thrown when a stock-out (sale or adjustment-out) would drive one or more
 * items' on-hand quantity negative and the caller has not passed
 * `confirmNegativeStock: true`. Routes catch this and respond 409 with a
 * structured `.items` payload so the frontend can show a confirmation
 * dialog and resubmit with the flag set - never silently created, never a
 * generic 500. */
export class InsufficientStockError extends Error {
  status = 409;
  items: InsufficientStockItem[];
  constructor(items: InsufficientStockItem[]) {
    super(
      `Insufficient stock for ${items.length} item(s): ${items
        .map((i) => `${i.itemName} (available ${i.availableQty}, requested ${i.requestedQty})`)
        .join(", ")}`
    );
    this.name = "InsufficientStockError";
    this.items = items;
  }
}

/** A line as it comes from a document (Purchase Bill / Tax Invoice) - only
 * the fields stock-posting actually needs, so callers in salesDocuments.ts/
 * purchaseBills.ts can pass their own line shape through unchanged. */
export interface StockableLine {
  item_id: number | null;
  qty: number;
  unit: string;
}

export interface StockPostResult {
  posted: StockTransaction[];
  /** Lines that were deliberately NOT posted, with why - never silent. */
  skipped: { item_id: number | null; reason: "no_item" | "item_not_found" | "not_tracked" | "unit_mismatch"; detail: string }[];
}

type Executor = Pool | PoolConnection;

// IN types add to on-hand; OUT types subtract. qty is always stored
// positive (CHECK constraint) - direction is entirely implied by txn_type,
// exactly so a reversal is "post the opposite type", never a sign flip on
// the same type (mirrors journals swapping debit/credit on reversal rather
// than negating a single signed amount).
const IN_TYPES: StockTxnType[] = ["opening", "purchase_receipt", "adjustment_in"];
const OUT_TYPES: StockTxnType[] = ["sale_issue", "adjustment_out"];

function signFor(txnType: StockTxnType): 1 | -1 {
  return IN_TYPES.includes(txnType) ? 1 : -1;
}

/** The type a reversal of `txnType` should carry, so the arithmetic nets to
 * exactly zero automatically via the same sign-by-type summing every other
 * stock query uses - the stock-ledger equivalent of a journal reversal
 * swapping debit/credit. There is deliberately no dedicated "reversal" enum
 * value (the schema's txn_type list is exactly the 5 named in the Phase 12
 * approval) - full traceability comes from `reverses_txn_id` + `notes`, the
 * same way a reversed journal is only distinguishable via
 * `reverses_journal_id`, not a special journal status of its own. */
function reversalTypeFor(txnType: StockTxnType): StockTxnType {
  return IN_TYPES.includes(txnType) ? "adjustment_out" : "adjustment_in";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Net on-hand quantity for one (company, item), optionally as of a given
 * date (inclusive) - sums EVERY stock_transactions row regardless of
 * `status`, exactly like getAccountBalance sums every journal_line
 * regardless of status. A reversed row's original amount and its
 * reversal's opposite-signed amount must both be counted for the
 * arithmetic to net to zero (or to the corrected repost's own figure) -
 * filtering to status='posted' only would silently drop the original while
 * keeping the reversal, getting the balance wrong by exactly double the
 * reversed amount (see accounting.ts's own note on this exact reasoning).
 */
export async function getStockBalance(
  executor: Executor,
  companyId: number,
  itemId: number,
  asOfDate?: string
): Promise<number> {
  const dateClause = asOfDate ? "AND txn_date <= ?" : "";
  const params = asOfDate ? [companyId, itemId, asOfDate] : [companyId, itemId];
  const [rows] = await executor.query<any[]>(
    `SELECT txn_type, SUM(qty) as total_qty
     FROM stock_transactions
     WHERE company_id = ? AND item_id = ? ${dateClause}
     GROUP BY txn_type`,
    params
  );
  let balance = 0;
  for (const r of rows) {
    balance += signFor(r.txn_type as StockTxnType) * Number(r.total_qty);
  }
  return round2(balance);
}

/**
 * The currently-active (posted, not-itself-a-reversal) stock transactions
 * for a given source document, locked FOR UPDATE so a concurrent edit/
 * cancel of the same document can't reverse the same row twice - the exact
 * stock-ledger analogue of getJournalBySource's `reverses_journal_id IS
 * NULL` contract. There can be MULTIPLE active rows per source (one per
 * stock-eligible line), unlike a journal's single header row, since a
 * document can have several item lines each producing its own
 * stock_transactions row.
 */
export async function getActiveStockTransactionsForSource(
  conn: PoolConnection,
  sourceType: string,
  sourceId: number
): Promise<StockTransaction[]> {
  const [rows] = await conn.query<any[]>(
    `SELECT * FROM stock_transactions
     WHERE source_type = ? AND source_id = ? AND status = 'posted' AND reverses_txn_id IS NULL
     FOR UPDATE`,
    [sourceType, sourceId]
  );
  return rows as StockTransaction[];
}

export interface PostStockTransactionInput {
  companyId: number;
  itemId: number;
  txnDate: string;
  txnType: StockTxnType;
  qty: number;
  sourceType?: string | null;
  sourceId?: number | null;
  notes?: string | null;
  createdBy: number | null;
}

/** Raw single-row insert - the stock-ledger analogue of inserting one
 * journal line, except a stock transaction is its own complete row (there
 * is no multi-line "header" the way a journal has). Must run on a `conn`
 * already inside the caller's transaction. */
export async function postStockTransactionTx(
  conn: PoolConnection,
  input: PostStockTransactionInput
): Promise<StockTransaction> {
  if (input.qty <= 0) {
    throw new InventoryError("Stock transaction quantity must be greater than zero");
  }
  const [result] = await conn.query<any>(
    `INSERT INTO stock_transactions
       (company_id, item_id, txn_date, txn_type, qty, source_type, source_id, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.companyId, input.itemId, input.txnDate, input.txnType, input.qty, input.sourceType || null, input.sourceId || null, input.notes || null, input.createdBy]
  );
  const [rows] = await conn.query<any[]>("SELECT * FROM stock_transactions WHERE id = ?", [result.insertId]);
  return rows[0] as StockTransaction;
}

/**
 * Reverses one active stock transaction: posts its opposite-type
 * counterpart (see reversalTypeFor) dated today (CURDATE(), matching
 * reverseJournalTx's own documented convention of dating a reversal "today"
 * rather than the original's date) and marks the original 'reversed'. The
 * original row is never edited or deleted - full audit trail, same as
 * journals.
 */
async function reverseOneStockTransactionTx(
  conn: PoolConnection,
  txn: StockTransaction,
  userId: number | null
): Promise<StockTransaction> {
  const reversalType = reversalTypeFor(txn.txn_type);
  const [result] = await conn.query<any>(
    `INSERT INTO stock_transactions
       (company_id, item_id, txn_date, txn_type, qty, source_type, source_id, reverses_txn_id, notes, created_by)
     VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, ?)`,
    [
      txn.company_id,
      txn.item_id,
      reversalType,
      txn.qty,
      txn.source_type,
      txn.source_id,
      txn.id,
      `Reversal of stock transaction #${txn.id} (${txn.txn_type})`,
      userId,
    ]
  );
  await conn.query("UPDATE stock_transactions SET status = 'reversed' WHERE id = ?", [txn.id]);
  const [rows] = await conn.query<any[]>("SELECT * FROM stock_transactions WHERE id = ?", [result.insertId]);
  return rows[0] as StockTransaction;
}

/**
 * Reverses every currently-active stock transaction for a source document
 * (all of them - one per stock-eligible line) and posts no replacement.
 * Used both for "cancel, don't repost" (Purchase Bill/Tax Invoice
 * cancellation) and as the first half of "reverse, then repost" (an edit) -
 * callers doing the latter call this, then call postDocumentStockMovementTx
 * again for the corrected lines, in the same transaction.
 */
export async function reverseStockForSourceTx(
  conn: PoolConnection,
  sourceType: string,
  sourceId: number,
  userId: number | null
): Promise<StockTransaction[]> {
  const active = await getActiveStockTransactionsForSource(conn, sourceType, sourceId);
  const reversals: StockTransaction[] = [];
  for (const txn of active) {
    reversals.push(await reverseOneStockTransactionTx(conn, txn, userId));
  }
  return reversals;
}

async function lockItemRow(conn: PoolConnection, itemId: number): Promise<Item | undefined> {
  const [rows] = await conn.query<any[]>("SELECT * FROM items WHERE id = ? FOR UPDATE", [itemId]);
  return rows[0] as Item | undefined;
}

export interface PostDocumentStockMovementInput {
  companyId: number;
  sourceType: "purchase_bill" | "tax_invoice";
  sourceId: number;
  txnDate: string;
  /** 'in' for a Purchase Bill's receipt, 'out' for a Tax Invoice's issue. */
  direction: "in" | "out";
  lines: StockableLine[];
  createdBy: number | null;
  /** Required to proceed past a negative-stock warning on an 'out'
   * movement - never defaults to true. Ignored for 'in' movements (adding
   * stock can never go negative). */
  confirmNegativeStock?: boolean;
}

/**
 * Posts one stock transaction per stock-eligible line of a Purchase Bill
 * (direction 'in', txn_type 'purchase_receipt') or Tax Invoice (direction
 * 'out', txn_type 'sale_issue'). A line is stock-eligible only when ALL of:
 *   - item_id is not null (a free-text line can never move stock - there is
 *     nothing to track it against)
 *   - the referenced item has track_inventory = true
 *   - the line's unit matches the item's own unit EXACTLY (no conversion is
 *     ever attempted or guessed - a mismatch is skipped, not converted)
 * Every line that fails one of these is recorded in the returned `skipped`
 * array with why, never silently dropped.
 *
 * For an 'out' movement, every stock-eligible line's projected balance
 * (current on-hand minus this line's qty) is checked FIRST, in one pass,
 * against every OTHER stock-eligible line's own item lock - collecting
 * every item that would go negative into a single InsufficientStockError
 * (not just the first one hit) so the confirmation dialog can show the
 * complete picture in one round trip. Only once that whole pass has no
 * newly-discovered shortfall (or the caller already passed
 * confirmNegativeStock) does the second pass actually insert the rows.
 * Must run on a `conn` already inside the caller's transaction, and the
 * item rows this locks stay locked for the rest of that transaction,
 * serializing any concurrent stock movement against the same item(s).
 */
export async function postDocumentStockMovementTx(
  conn: PoolConnection,
  input: PostDocumentStockMovementInput
): Promise<StockPostResult> {
  const skipped: StockPostResult["skipped"] = [];
  const eligible: { line: StockableLine; item: Item }[] = [];

  for (const line of input.lines) {
    if (!line.item_id) {
      skipped.push({ item_id: null, reason: "no_item", detail: "Line has no linked catalog item" });
      continue;
    }
    const item = await lockItemRow(conn, line.item_id);
    if (!item) {
      skipped.push({ item_id: line.item_id, reason: "item_not_found", detail: `Item ${line.item_id} not found` });
      continue;
    }
    if (!item.track_inventory) {
      skipped.push({ item_id: line.item_id, reason: "not_tracked", detail: `${item.name} is not stock-tracked` });
      continue;
    }
    if ((line.unit || "").trim() !== (item.unit || "").trim()) {
      skipped.push({
        item_id: line.item_id,
        reason: "unit_mismatch",
        detail: `${item.name}: line unit "${line.unit}" does not match item unit "${item.unit}" - stock not posted for this line`,
      });
      continue;
    }
    eligible.push({ line, item });
  }

  if (input.direction === "out" && !input.confirmNegativeStock) {
    const shortfalls: InsufficientStockItem[] = [];
    for (const { line, item } of eligible) {
      const balance = await getStockBalance(conn, input.companyId, item.id);
      const projected = round2(balance - line.qty);
      if (projected < 0) {
        shortfalls.push({ itemId: item.id, itemName: item.name, requestedQty: line.qty, availableQty: balance });
      }
    }
    if (shortfalls.length > 0) {
      throw new InsufficientStockError(shortfalls);
    }
  }

  const posted: StockTransaction[] = [];
  const txnType: StockTxnType = input.direction === "in" ? "purchase_receipt" : "sale_issue";
  for (const { line, item } of eligible) {
    posted.push(
      await postStockTransactionTx(conn, {
        companyId: input.companyId,
        itemId: item.id,
        txnDate: input.txnDate,
        txnType,
        qty: line.qty,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        createdBy: input.createdBy,
      })
    );
  }

  return { posted, skipped };
}

// ---- Manual entry points (opening stock / adjustments) - both are
// self-contained transactions (there is no other write to share one with),
// mirroring reverseJournal (vs reverseJournalTx)'s "self-contained" variant
// pattern in accounting.ts. ----

export interface OpeningStockInput {
  companyId: number;
  itemId: number;
  txnDate: string;
  qty: number;
  notes?: string | null;
  createdBy: number | null;
}

/**
 * Posts a company/item's opening stock balance - manual, one-time, NEVER
 * inferred from historical documents (the Phase 12A audit confirmed there
 * is no historical data to infer from). Rejects a second opening entry for
 * the same (company, item) while an earlier one is still active
 * ('posted') - per the approved duplicate-opening-stock policy, a
 * correction must explicitly reverse the original first (via a
 * compensating adjustment - see the route/module doc comment for why there
 * is no dedicated "reverse opening stock" endpoint in this phase).
 */
export async function postOpeningStockTx(input: OpeningStockInput): Promise<StockTransaction> {
  if (input.qty <= 0) {
    throw new InventoryError("Opening stock quantity must be greater than zero");
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const item = await lockItemRow(conn, input.itemId);
    if (!item) throw new InventoryError("Item not found");

    const [existingRows] = await conn.query<any[]>(
      `SELECT id FROM stock_transactions
       WHERE company_id = ? AND item_id = ? AND txn_type = 'opening' AND status = 'posted'
       FOR UPDATE`,
      [input.companyId, input.itemId]
    );
    if (existingRows.length > 0) {
      throw new InventoryError(
        `Opening stock has already been recorded for ${item.name} in this company. Reverse the existing entry (via a compensating adjustment) before recording a new one.`
      );
    }

    const txn = await postStockTransactionTx(conn, {
      companyId: input.companyId,
      itemId: input.itemId,
      txnDate: input.txnDate,
      txnType: "opening",
      qty: input.qty,
      sourceType: "opening",
      sourceId: null,
      notes: input.notes,
      createdBy: input.createdBy,
    });
    await conn.commit();
    return txn;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export interface AdjustmentInput {
  companyId: number;
  itemId: number;
  txnDate: string;
  txnType: "adjustment_in" | "adjustment_out";
  qty: number;
  notes: string;
  createdBy: number | null;
  confirmNegativeStock?: boolean;
}

/**
 * Posts a manual stock adjustment (stocktake correction, damage, loss,
 * found stock, ...). An adjustment_out is subject to the exact same
 * negative-stock soft-block/confirm policy as a Tax Invoice's sale_issue -
 * there is nothing special about a sale that makes negative stock riskier
 * than a manual reduction; both get the same protection.
 */
export async function postAdjustmentTx(input: AdjustmentInput): Promise<StockTransaction> {
  if (input.qty <= 0) {
    throw new InventoryError("Adjustment quantity must be greater than zero");
  }
  if (!input.notes || !input.notes.trim()) {
    throw new InventoryError("A reason/notes is required for a stock adjustment");
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const item = await lockItemRow(conn, input.itemId);
    if (!item) throw new InventoryError("Item not found");
    if (!item.track_inventory) {
      throw new InventoryError(`${item.name} is not stock-tracked - enable tracking on the item before adjusting its stock`);
    }

    if (input.txnType === "adjustment_out" && !input.confirmNegativeStock) {
      const balance = await getStockBalance(conn, input.companyId, input.itemId);
      const projected = round2(balance - input.qty);
      if (projected < 0) {
        throw new InsufficientStockError([
          { itemId: item.id, itemName: item.name, requestedQty: input.qty, availableQty: balance },
        ]);
      }
    }

    const txn = await postStockTransactionTx(conn, {
      companyId: input.companyId,
      itemId: input.itemId,
      txnDate: input.txnDate,
      txnType: input.txnType,
      qty: input.qty,
      sourceType: "adjustment",
      sourceId: null,
      notes: input.notes,
      createdBy: input.createdBy,
    });
    await conn.commit();
    return txn;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ---- Reports (Stock Levels / Stock Ledger) ----

export interface StockLevelRow {
  itemId: number;
  itemName: string;
  unit: string;
  hsnCode: string | null;
  trackInventory: boolean;
  openingQty: number;
  stockIn: number;
  stockOut: number;
  adjustments: number;
  currentOnHand: number;
}

/**
 * One row per stock-tracked item in the company - the four movement
 * columns are a partition of EVERY stock_transactions row by its own
 * txn_type (raw, regardless of status - see getStockBalance's own
 * reasoning for why), so openingQty + stockIn - stockOut + adjustments
 * always reconciles exactly to currentOnHand (computed the same way
 * getStockBalance does, independently, as a defensive cross-check rather
 * than trusting the four-bucket arithmetic alone).
 */
export async function getStockLevels(companyId: number): Promise<StockLevelRow[]> {
  const [items] = await pool.query<any[]>(
    "SELECT id, name, unit, hsn_code, track_inventory FROM items WHERE track_inventory = 1 ORDER BY name ASC"
  );
  const [txnRows] = await pool.query<any[]>(
    `SELECT item_id, txn_type, SUM(qty) as total_qty
     FROM stock_transactions
     WHERE company_id = ?
     GROUP BY item_id, txn_type`,
    [companyId]
  );

  const byItem = new Map<number, Record<string, number>>();
  for (const r of txnRows) {
    const bucket = byItem.get(r.item_id) || {};
    bucket[r.txn_type] = Number(r.total_qty);
    byItem.set(r.item_id, bucket);
  }

  return items.map((item) => {
    const bucket = byItem.get(item.id) || {};
    const openingQty = round2(bucket["opening"] || 0);
    const stockIn = round2(bucket["purchase_receipt"] || 0);
    const stockOut = round2(bucket["sale_issue"] || 0);
    const adjustments = round2((bucket["adjustment_in"] || 0) - (bucket["adjustment_out"] || 0));
    return {
      itemId: item.id,
      itemName: item.name,
      unit: item.unit,
      hsnCode: item.hsn_code,
      trackInventory: true,
      openingQty,
      stockIn,
      stockOut,
      adjustments,
      currentOnHand: round2(openingQty + stockIn - stockOut + adjustments),
    };
  });
}

export interface StockLedgerRow {
  id: number;
  txnDate: string;
  txnType: StockTxnType;
  qty: number;
  signedQty: number;
  status: "posted" | "reversed";
  sourceType: string | null;
  sourceId: number | null;
  reversesTxnId: number | null;
  notes: string | null;
  runningBalance: number;
}

/**
 * Chronological transaction history for one (company, item), with a
 * running balance - the stock-ledger analogue of getGeneralLedger. Rows
 * dated before `from` are folded into the opening running balance shown on
 * the first in-range row, exactly like getGeneralLedger's own opening-
 * balance convention. A reversed row is still shown as its own line (same
 * "status is a display concern, not a summing concern" rule as journals)
 * so the full history stays visible, not hidden.
 */
export async function getStockLedger(
  companyId: number,
  itemId: number,
  from: string,
  to: string
): Promise<{ openingBalance: number; rows: StockLedgerRow[]; closingBalance: number }> {
  const openingBalance = await getStockBalanceBefore(companyId, itemId, from);

  const [rows] = await pool.query<any[]>(
    `SELECT * FROM stock_transactions
     WHERE company_id = ? AND item_id = ? AND txn_date BETWEEN ? AND ?
     ORDER BY txn_date ASC, id ASC`,
    [companyId, itemId, from, to]
  );

  let running = openingBalance;
  const ledgerRows: StockLedgerRow[] = rows.map((r) => {
    const signedQty = signFor(r.txn_type as StockTxnType) * Number(r.qty);
    running = round2(running + signedQty);
    return {
      id: r.id,
      txnDate: r.txn_date,
      txnType: r.txn_type,
      qty: Number(r.qty),
      signedQty: round2(signedQty),
      status: r.status,
      sourceType: r.source_type,
      sourceId: r.source_id,
      reversesTxnId: r.reverses_txn_id,
      notes: r.notes,
      runningBalance: running,
    };
  });

  return { openingBalance, rows: ledgerRows, closingBalance: running };
}

async function getStockBalanceBefore(companyId: number, itemId: number, beforeDate: string): Promise<number> {
  const [rows] = await pool.query<any[]>(
    `SELECT txn_type, SUM(qty) as total_qty
     FROM stock_transactions
     WHERE company_id = ? AND item_id = ? AND txn_date < ?
     GROUP BY txn_type`,
    [companyId, itemId, beforeDate]
  );
  let balance = 0;
  for (const r of rows) {
    balance += signFor(r.txn_type as StockTxnType) * Number(r.total_qty);
  }
  return round2(balance);
}
