import { Pool, PoolConnection } from "mysql2/promise";
import { pool } from "../config/db";
import { Item, Journal, StockTransaction, StockTxnType } from "../types";
import {
  AccountingError,
  getJournalBySource,
  postOpeningStockJournalTx,
  postStockAdjustmentJournalTx,
  reverseJournalTx,
} from "./accounting";

// Phase 12: Inventory & Stock Management - quantity-only stock ledger.
//
// Deliberately its own service file, mirroring src/services/accounting.ts's
// journal/reversal shape as closely as possible (see stock_transactions'
// own schema.sql comment): immutable rows, correction-by-reversal, a
// company-scoped ledger summed by SIGN-BY-TYPE rather than a signed qty
// column. Through Phase 12F this file had NO relationship to accounting.ts
// for its own manual entry points (Purchase Bill/Tax Invoice postings in
// 12D/12E live in their own routers, calling both services side by side -
// this file itself stayed decoupled). Phase 12G wires opening stock and
// manual adjustments to the ledger too (see postOpeningStockTx/
// postAdjustmentTx below) - the last two of the four stock-movement entry
// points to gain GL representation, using the exact same WAC/reversal
// primitives already established here, never a second costing algorithm.

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
  /** Phase 12C: per-unit cost, GST-EXCLUSIVE, for an 'in' (purchase_receipt)
   * movement - per the approved model, unit_cost = the bill line's own
   * `rate` (already pre-tax; GST stays in Input GST, never inventory cost).
   * For a plain Tax Invoice 'out' movement this is left unset and the cost
   * is always computed internally from the current weighted average at post
   * time instead (see resolveSaleCost) - a sale can never have its cost set
   * directly. Phase D's Debit Note is the one 'out' case that DOES supply
   * this explicitly: the exact per-unit cost that was recorded when those
   * units came in (the original Purchase Bill line's own rate), so the
   * stock/COGS effect this reverses is proportionally exact rather than
   * priced at whatever today's average happens to be. `undefined`/`null`
   * (rather than a number, including 0) means "no cost known" - a real
   * receipt at zero cost (e.g. free goods) is qty:X, unitCost:0, which is
   * NOT the same as an unknown cost; see getStockValuation's costedQty. */
  unitCost?: number | null;
}

export interface StockPostResult {
  posted: StockTransaction[];
  /** Lines that were deliberately NOT posted, with why - never silent. */
  skipped: { item_id: number | null; reason: "no_item" | "item_not_found" | "not_tracked" | "unit_mismatch"; detail: string }[];
  /** Phase 12C: 'out' movements whose cost had no basis to compute from (no
   * costed quantity ever recorded for this item) and so fell back to 0 -
   * surfaced here, never silent, so a caller can warn the user rather than
   * have COGS quietly understate itself in a later phase. */
  costFallbacks: { itemId: number; itemName: string }[];
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

export interface StockValuation {
  /** Every unit currently on hand, cost-known or not - identical to
   * getStockBalance's own number, computed independently here as a
   * cross-check rather than trusted to always match `costedQty`. */
  totalQty: number;
  /** The subset of on-hand qty that is backed by a recorded `unit_cost`
   * (real receipts/opening entries that had a cost, net of any reversals -
   * which correctly carry the SAME unit_cost as what they reverse, so a
   * reversed receipt's cost contribution cancels out exactly, mirroring how
   * its quantity already cancels out). Can be LESS than totalQty when some
   * on-hand quantity came from a cost-less source (e.g. a manual
   * adjustment_in entered with no cost, or a pre-Phase-12C receipt). */
  costedQty: number;
  /** Signed sum of qty * unit_cost across every row that has a unit_cost -
   * the total book value of the costedQty portion of on-hand stock. */
  totalValue: number;
  /** totalValue / costedQty, or null when costedQty is zero (or negative) -
   * there is genuinely no cost basis to average, and this is never silently
   * reported as 0 (see resolveSaleCost for where a 0 fallback is actually
   * applied, and only there, explicitly flagged). */
  averageCost: number | null;
  /** True when totalQty and costedQty disagree (beyond rounding) - some
   * on-hand quantity has no recorded cost. Surfaced so a future valuation
   * report (Phase 12G) can show this honestly rather than imply full
   * costing where none exists. */
  hasCostGap: boolean;
}

/**
 * Weighted-average cost valuation for one (company, item), optionally as of
 * a given date (inclusive) - the value-side counterpart to getStockBalance,
 * built the exact same way: sum EVERY stock_transactions row regardless of
 * `status`, signed by txn_type. This works correctly for weighted average
 * specifically because every 'out' movement (sale_issue/adjustment_out) is
 * given, at the moment it's posted, the CURRENT average cost as its own
 * unit_cost (see resolveSaleCost + postDocumentStockMovementTx) - so a flat
 * signed sum of qty*unit_cost across all rows, in any order, already equals
 * the correct running book value, without needing to replay history
 * chronologically here. A reversal carries over the exact unit_cost of the
 * row it reverses (see reverseOneStockTransactionTx), so reversing a
 * purchase or a sale nets its value contribution to zero, exactly like its
 * quantity already does.
 *
 * Company + item isolated by construction (both are mandatory WHERE
 * clauses) - the same isolation guarantee getStockBalance already has.
 */
export async function getStockValuation(
  executor: Executor,
  companyId: number,
  itemId: number,
  asOfDate?: string
): Promise<StockValuation> {
  const dateClause = asOfDate ? "AND txn_date <= ?" : "";
  const params = asOfDate ? [companyId, itemId, asOfDate] : [companyId, itemId];
  const [rows] = await executor.query<any[]>(
    `SELECT txn_type,
            SUM(qty) as total_qty,
            SUM(CASE WHEN unit_cost IS NOT NULL THEN qty ELSE 0 END) as costed_qty,
            SUM(CASE WHEN unit_cost IS NOT NULL THEN qty * unit_cost ELSE 0 END) as costed_value
     FROM stock_transactions
     WHERE company_id = ? AND item_id = ? ${dateClause}
     GROUP BY txn_type`,
    params
  );
  let totalQty = 0;
  let costedQty = 0;
  let totalValue = 0;
  for (const r of rows) {
    const sign = signFor(r.txn_type as StockTxnType);
    totalQty += sign * Number(r.total_qty);
    costedQty += sign * Number(r.costed_qty);
    totalValue += sign * Number(r.costed_value);
  }
  totalQty = round2(totalQty);
  costedQty = round2(costedQty);
  totalValue = round2(totalValue);
  const averageCost = costedQty > 0.001 ? round2(totalValue / costedQty) : null;
  return {
    totalQty,
    costedQty,
    totalValue,
    averageCost,
    hasCostGap: Math.abs(totalQty - costedQty) > 0.001,
  };
}

export interface ResolvedSaleCost {
  unitCost: number;
  /** True when there was no cost basis at all to average from (costedQty
   * <= 0) and unitCost was set to 0 as the explicit, visible fallback -
   * never a fabricated nonzero guess. A future COGS phase (12E) must
   * surface this, not silently post a 0-cost COGS line as if it were a
   * real, known figure. */
  isFallback: boolean;
}

/**
 * The cost to assign to the NEXT unit(s) leaving stock for this
 * (company, item), evaluated against everything posted so far (must be
 * called - and its result inserted - BEFORE the new 'out' row exists, so it
 * reflects the balance as it stood immediately prior to this movement).
 * This is the one and only place a sale's unit_cost is decided; callers
 * never pass a cost for an 'out' movement themselves (see StockableLine).
 *
 * Never fabricates a plausible-looking number when no cost basis exists -
 * falls back to exactly 0, with `isFallback: true` so it can be surfaced
 * rather than silently treated as a real zero cost.
 */
export async function resolveSaleCost(
  executor: Executor,
  companyId: number,
  itemId: number
): Promise<ResolvedSaleCost> {
  const valuation = await getStockValuation(executor, companyId, itemId);
  if (valuation.averageCost !== null) {
    return { unitCost: valuation.averageCost, isFallback: false };
  }
  return { unitCost: 0, isFallback: true };
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
  /** GST-exclusive per-unit cost, when known - undefined/null means "no
   * cost basis recorded for this row" (see StockableLine's own note on why
   * that's different from a real cost of 0). */
  unitCost?: number | null;
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
       (company_id, item_id, txn_date, txn_type, qty, unit_cost, source_type, source_id, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.companyId,
      input.itemId,
      input.txnDate,
      input.txnType,
      input.qty,
      input.unitCost === undefined || input.unitCost === null ? null : input.unitCost,
      input.sourceType || null,
      input.sourceId || null,
      input.notes || null,
      input.createdBy,
    ]
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
 *
 * Phase 12C: the reversal carries over the EXACT SAME unit_cost as the row
 * it reverses (never recomputed against today's average) - this is what
 * makes getStockValuation's flat signed sum correct: a reversed receipt's
 * value contribution cancels to exactly zero, and a reversed sale's COGS
 * value is added back at the SAME cost it was removed at, not at whatever
 * the average happens to be now (which may have shifted from later
 * purchases) - the value-side equivalent of a journal reversal swapping
 * debit/credit for the SAME amount, never a recalculated one.
 *
 * Phase 12G: exported (previously private, used only by
 * reverseStockForSourceTx below) so reverseAdjustmentTx can reuse this
 * exact same primitive for a single stock_transactions row addressed
 * directly by id, rather than by source_type/source_id - no reversal
 * logic is duplicated for that new caller.
 */
export async function reverseOneStockTransactionTx(
  conn: PoolConnection,
  txn: StockTransaction,
  userId: number | null
): Promise<StockTransaction> {
  const reversalType = reversalTypeFor(txn.txn_type);
  const [result] = await conn.query<any>(
    `INSERT INTO stock_transactions
       (company_id, item_id, txn_date, txn_type, qty, unit_cost, source_type, source_id, reverses_txn_id, notes, created_by)
     VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      txn.company_id,
      txn.item_id,
      reversalType,
      txn.qty,
      txn.unit_cost,
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

/**
 * Phase 12D: which of the given item ids currently have track_inventory =
 * true - a plain, unlocked read (this is a classification lookup, not a
 * stock mutation; the actual per-item FOR UPDATE lock still happens inside
 * postDocumentStockMovementTx when stock is actually posted). Exists so a
 * caller that needs to classify document lines for a purpose OTHER than
 * moving stock itself - e.g. Purchase Bill accounting choosing Inventory
 * (1140) vs Purchases (5200) per line - can reuse the exact same
 * "is this item tracked" definition the stock layer itself uses, rather
 * than re-deriving it. Accounting.ts stays fully decoupled from this file
 * (it only ever receives a plain boolean per line, resolved by the caller,
 * never an item id it would look up itself).
 */
export async function getTrackedItemIds(executor: Executor, itemIds: number[]): Promise<Set<number>> {
  if (itemIds.length === 0) return new Set();
  const [rows] = await executor.query<any[]>("SELECT id FROM items WHERE id IN (?) AND track_inventory = 1", [itemIds]);
  return new Set(rows.map((r) => r.id as number));
}

export interface PostDocumentStockMovementInput {
  companyId: number;
  sourceType: "purchase_bill" | "tax_invoice" | "credit_note" | "debit_note";
  sourceId: number;
  txnDate: string;
  /** 'in' for a Purchase Bill's receipt or a Credit Note's return-to-stock,
   * 'out' for a Tax Invoice's issue or a Debit Note's return-to-vendor. */
  direction: "in" | "out";
  lines: StockableLine[];
  createdBy: number | null;
  /** Required to proceed past a negative-stock warning on an 'out'
   * movement - never defaults to true. Ignored for 'in' movements (adding
   * stock can never go negative). */
  confirmNegativeStock?: boolean;
  /** Overrides the txn_type this movement posts as - defaults to
   * 'purchase_receipt'/'sale_issue' by direction (the original Phase 12D/E
   * behavior, unchanged for Purchase Bill/Tax Invoice callers). Phase D's
   * Credit/Debit Notes pass 'adjustment_in'/'adjustment_out' instead - a
   * correction is not itself a new purchase or sale, and this schema
   * deliberately has no dedicated "return" txn_type (see reversalTypeFor's
   * own comment on why reversals/corrections reuse the adjustment types
   * rather than growing the txn_type enum further).
   */
  txnType?: StockTxnType;
}

/**
 * Posts one stock transaction per stock-eligible line of a Purchase Bill
 * (direction 'in', txn_type 'purchase_receipt'), Tax Invoice (direction
 * 'out', txn_type 'sale_issue'), or a Phase D Credit/Debit Note (direction
 * 'in'/'out' respectively, txn_type 'adjustment_in'/'adjustment_out' via the
 * `txnType` override). A line is stock-eligible only when ALL of:
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
  const costFallbacks: StockPostResult["costFallbacks"] = [];
  const txnType: StockTxnType = input.txnType ?? (input.direction === "in" ? "purchase_receipt" : "sale_issue");
  for (const { line, item } of eligible) {
    // Phase 12C: 'in' carries the caller-supplied cost through as-is (the
    // Purchase Bill line's own rate, per the approved model - see
    // StockableLine.unitCost). A plain Tax Invoice 'out' never supplies a
    // cost, so it falls through to being resolved here from the current
    // weighted average, immediately before insertion (against the balance
    // as it stands right now, including any earlier line of this same
    // document already posted in this same loop, since resolveSaleCost
    // reads through the same `conn`). Phase D's Debit Note is the one 'out'
    // caller that DOES supply a cost (the original Purchase Bill line's own
    // rate) - when present, it's used as-is, exactly like an 'in' movement,
    // and resolveSaleCost is never even called.
    let unitCost: number | null | undefined = line.unitCost;
    if (input.direction === "out" && unitCost === undefined) {
      const resolved = await resolveSaleCost(conn, input.companyId, item.id);
      unitCost = resolved.unitCost;
      if (resolved.isFallback) {
        costFallbacks.push({ itemId: item.id, itemName: item.name });
      }
    }
    posted.push(
      await postStockTransactionTx(conn, {
        companyId: input.companyId,
        itemId: item.id,
        txnDate: input.txnDate,
        txnType,
        qty: line.qty,
        unitCost,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        createdBy: input.createdBy,
      })
    );
  }

  return { posted, skipped, costFallbacks };
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
  /** Phase 12C: optional GST-exclusive per-unit cost - when provided, seeds
   * the weighted-average calculation with qty * unitCost. When omitted, the
   * quantity is still recorded (unchanged behavior) but contributes nothing
   * to getStockValuation's costedQty/totalValue - never fabricated. */
  unitCost?: number | null;
  notes?: string | null;
  createdBy: number | null;
}

export interface PostOpeningStockResult {
  stockTxn: StockTransaction;
  /** The Dr Inventory / Cr Capital journal (Phase 12G), or null when no
   * cost basis was given - never fabricated, exactly mirroring how a
   * cost-less opening entry already contributes nothing to
   * getStockValuation's costedQty/totalValue. */
  journal: Journal | null;
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
 *
 * Phase 12G: when a valid (positive) unitCost is given, also posts Dr
 * Inventory (1140) / Cr Capital (3100) for qty * unitCost, atomically in
 * the same transaction as the stock row - the opening entry's asset value
 * now actually appears on the books, not just in valuation reports. A
 * cost-less opening entry posts no journal at all (same "never fabricate"
 * rule as everywhere else in this file) - the stock quantity is still
 * recorded exactly as before this phase. There is still no reversal
 * endpoint for this journal (matching the stock row's own established
 * policy above), so no duplicate/orphaned-entry risk exists: nothing in
 * this codebase ever calls this function a second time for the same
 * (company, item) while the first opening entry is still active - the
 * duplicate-check above throws before a second journal could ever be
 * posted.
 */
export async function postOpeningStockTx(input: OpeningStockInput): Promise<PostOpeningStockResult> {
  if (input.qty <= 0) {
    throw new InventoryError("Opening stock quantity must be greater than zero");
  }
  if (input.unitCost !== undefined && input.unitCost !== null && input.unitCost < 0) {
    throw new InventoryError("Opening stock unit cost cannot be negative");
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
      unitCost: input.unitCost,
      sourceType: "opening",
      sourceId: null,
      notes: input.notes,
      createdBy: input.createdBy,
    });

    let journal: Journal | null = null;
    if (input.unitCost !== undefined && input.unitCost !== null && input.unitCost > 0) {
      const amount = round2(input.qty * input.unitCost);
      if (amount > 0) {
        journal = await postOpeningStockJournalTx(conn, {
          companyId: input.companyId,
          stockTxnId: txn.id,
          txnDate: input.txnDate,
          amount,
          createdBy: input.createdBy,
        });
      }
    }

    await conn.commit();
    return { stockTxn: txn, journal };
  } catch (err) {
    await conn.rollback();
    if (err instanceof AccountingError) {
      throw new InventoryError(`Opening stock could not be recorded: ${err.message}`);
    }
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

export interface PostAdjustmentResult {
  stockTxn: StockTransaction;
  /** The Dr/Cr Inventory journal (Phase 12G), or null when the resolved
   * cost fell back to 0 (no cost basis existed for this item at all) -
   * mirrors postSaleCogsJournalTx's own "skip the zero bucket" rule. */
  journal: Journal | null;
  /** True when unitCost had no real cost basis to resolve from and fell
   * back to 0 (see resolveSaleCost) - surfaced explicitly, never silent,
   * same contract as StockPostResult.costFallbacks elsewhere in this file. */
  costFallback: boolean;
}

/**
 * Posts a manual stock adjustment (stocktake correction, damage, loss,
 * found stock, ...). An adjustment_out is subject to the exact same
 * negative-stock soft-block/confirm policy as a Tax Invoice's sale_issue -
 * there is nothing special about a sale that makes negative stock riskier
 * than a manual reduction; both get the same protection.
 *
 * Phase 12G: values the adjustment at the CURRENT weighted-average cost -
 * resolved via resolveSaleCost (the exact same function sale_issue already
 * uses; no second costing algorithm), evaluated before this row exists so
 * it reflects the balance as it stood immediately prior, same timing rule
 * as postDocumentStockMovementTx's own 'out' branch. Both adjustment_in and
 * adjustment_out get a cost this way - an 'in' priced at today's average
 * doesn't skew that average (old total value + qty*oldAvg, divided by old
 * qty + qty, is still oldAvg), and an 'out' priced this way is exactly
 * what a sale would use for the same quantity right now. When there is no
 * cost basis at all, resolveSaleCost's own 0-with-isFallback contract
 * applies unchanged - the row still records unit_cost = 0 (a real,
 * recorded value, never left unset) and no journal is posted at all
 * (skip-the-zero-bucket, matching postSaleCogsJournalTx). Journal posts
 * Dr Inventory (1140) / Cr Other Expenses (5900) for an increase, or the
 * reverse for a decrease - see postStockAdjustmentJournalTx.
 */
export async function postAdjustmentTx(input: AdjustmentInput): Promise<PostAdjustmentResult> {
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

    const resolved = await resolveSaleCost(conn, input.companyId, input.itemId);

    const txn = await postStockTransactionTx(conn, {
      companyId: input.companyId,
      itemId: input.itemId,
      txnDate: input.txnDate,
      txnType: input.txnType,
      qty: input.qty,
      unitCost: resolved.unitCost,
      sourceType: "adjustment",
      sourceId: null,
      notes: input.notes,
      createdBy: input.createdBy,
    });

    let journal: Journal | null = null;
    if (!resolved.isFallback) {
      const amount = round2(input.qty * resolved.unitCost);
      if (amount > 0) {
        journal = await postStockAdjustmentJournalTx(conn, {
          companyId: input.companyId,
          stockTxnId: txn.id,
          txnDate: input.txnDate,
          txnType: input.txnType,
          amount,
          createdBy: input.createdBy,
        });
      }
    }

    await conn.commit();
    return { stockTxn: txn, journal, costFallback: resolved.isFallback };
  } catch (err) {
    await conn.rollback();
    if (err instanceof AccountingError) {
      throw new InventoryError(`Stock adjustment could not be recorded: ${err.message}`);
    }
    throw err;
  } finally {
    conn.release();
  }
}

export interface ReverseAdjustmentResult {
  stockTxn: StockTransaction;
  /** The reversal journal, or null when the original adjustment never
   * posted one (a zero-cost-fallback adjustment - nothing to reverse on
   * the accounting side, only on the stock side). */
  journal: Journal | null;
}

/**
 * Reverses one active manual stock adjustment by its own stock_transactions
 * id - addressed directly, unlike reverseStockForSourceTx (which reverses
 * every active row for a source_type/source_id pair; adjustments have no
 * natural "parent document" id to group by, so this targets exactly one
 * row instead). Reuses reverseOneStockTransactionTx unchanged - the
 * reversal automatically carries over the EXACT SAME unit_cost as the
 * original (Phase 12C's own established guarantee), dated CURDATE() (the
 * same reversal-date convention as everywhere else, untouched). The
 * accompanying journal (if the original adjustment posted one - see
 * postAdjustmentTx's own "skip the zero bucket" rule) is reversed too, via
 * the existing getJournalBySource/reverseJournalTx primitives, keyed off
 * source_type "stock_adjustment" + this same stock_transactions id - no
 * new journal is posted, only a reversal, matching the "cancel, don't
 * repost" semantics every other reversal in this codebase already follows.
 * Company-scoped by construction (the row lookup below is filtered by
 * company_id, so a request for another company's transaction id is
 * rejected as not-found, never silently reversing the wrong company's
 * stock).
 */
export async function reverseAdjustmentTx(
  companyId: number,
  stockTxnId: number,
  userId: number | null
): Promise<ReverseAdjustmentResult> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query<any[]>(
      "SELECT * FROM stock_transactions WHERE id = ? AND company_id = ? FOR UPDATE",
      [stockTxnId, companyId]
    );
    const txn = rows[0] as StockTransaction | undefined;
    if (!txn) throw new InventoryError("Stock adjustment not found");
    if (txn.txn_type !== "adjustment_in" && txn.txn_type !== "adjustment_out") {
      throw new InventoryError("Only stock adjustments can be reversed through this endpoint");
    }
    if (txn.status !== "posted") {
      throw new InventoryError("This adjustment has already been reversed");
    }

    const reversedStockTxn = await reverseOneStockTransactionTx(conn, txn, userId);

    let reversalJournal: Journal | null = null;
    const priorJournal = await getJournalBySource("stock_adjustment", stockTxnId);
    if (priorJournal) {
      reversalJournal = await reverseJournalTx(conn, priorJournal.id, userId);
    }

    await conn.commit();
    return { stockTxn: reversedStockTxn, journal: reversalJournal };
  } catch (err) {
    await conn.rollback();
    if (err instanceof AccountingError) {
      throw new InventoryError(`Stock adjustment reversal failed: ${err.message}`);
    }
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
  /** Phase 12F: the valuation fields below are read STRAIGHT from
   * getStockValuation - the single Phase 12C source of truth for weighted-
   * average cost - never recomputed here. See that function's own doc
   * comment for exactly what each field means (in particular:
   * averageCost is null, never fabricated as 0, when costedQty is zero;
   * hasCostGap flags when currentOnHand and costedQty disagree). */
  costedQty: number;
  averageCost: number | null;
  inventoryValue: number;
  hasCostGap: boolean;
}

/**
 * One row per stock-tracked item in the company - the four movement
 * columns are a partition of EVERY stock_transactions row by its own
 * txn_type (raw, regardless of status - see getStockBalance's own
 * reasoning for why), so openingQty + stockIn - stockOut + adjustments
 * always reconciles exactly to currentOnHand (computed the same way
 * getStockBalance does, independently, as a defensive cross-check rather
 * than trusting the four-bucket arithmetic alone).
 *
 * Phase 12F: also calls getStockValuation (current, no asOfDate - a Stock
 * Levels view is always "as of now") once per item, in parallel, so the
 * valuation columns are exactly what getStockValuation itself would report
 * for that item - no second weighted-average algorithm is introduced here
 * or anywhere else in this phase.
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

  const valuations = await Promise.all(items.map((item) => getStockValuation(pool, companyId, item.id)));

  return items.map((item, i) => {
    const bucket = byItem.get(item.id) || {};
    const openingQty = round2(bucket["opening"] || 0);
    const stockIn = round2(bucket["purchase_receipt"] || 0);
    const stockOut = round2(bucket["sale_issue"] || 0);
    const adjustments = round2((bucket["adjustment_in"] || 0) - (bucket["adjustment_out"] || 0));
    const valuation = valuations[i];
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
      costedQty: valuation.costedQty,
      averageCost: valuation.averageCost,
      inventoryValue: valuation.totalValue,
      hasCostGap: valuation.hasCostGap,
    };
  });
}

export interface InventoryValuationRow {
  itemId: number;
  itemName: string;
  hsnCode: string | null;
  unit: string;
  /** On-hand quantity as of the requested date - identical to
   * getStockValuation's own totalQty for this (company, item, asOfDate). */
  qty: number;
  costedQty: number;
  averageCost: number | null;
  inventoryValue: number;
  hasCostGap: boolean;
}

export interface InventoryValuationResult {
  asOfDate: string;
  rows: InventoryValuationRow[];
  totalQty: number;
  totalCostedQty: number;
  totalValue: number;
  /** True when at least one row has hasCostGap - a company-wide summary
   * flag, never hiding which individual rows are affected (still visible
   * per-row via InventoryValuationRow.hasCostGap). */
  hasAnyCostGap: boolean;
}

/**
 * Point-in-time inventory valuation for every stock-tracked item in a
 * company, as of a given date (inclusive) - the dedicated valuation report
 * distinct from getStockLevels (a movement/reconciliation view that is
 * always "as of now"). This is a thin wrapper: it calls getStockValuation
 * (Phase 12C) once per item with the requested asOfDate, exactly the same
 * function getStockLevels itself calls, so both reports can never disagree
 * about what a given item's valuation is on a given date - there is no
 * second weighted-average calculation anywhere in this function.
 *
 * Every stock-tracked item is included regardless of quantity - a zero-
 * quantity or zero-value item still gets a row (0.00, not omitted), since
 * "no stock as of this date" is itself meaningful information, not an
 * error. averageCost is null (never fabricated as 0) whenever costedQty is
 * zero; the row's inventoryValue is then also correctly 0 (totalValue from
 * getStockValuation), not left undefined.
 */
export async function getInventoryValuation(companyId: number, asOfDate: string): Promise<InventoryValuationResult> {
  // items has no company_id column (a single shared catalog across
  // companies, same as getStockLevels' own query above) - company scoping
  // for valuation happens entirely inside getStockValuation, which filters
  // stock_transactions by company_id. An item with zero activity for THIS
  // company still gets a row here (qty 0, averageCost null), correctly
  // reflecting "not stocked by this company", not omitted.
  const [items] = await pool.query<any[]>(
    "SELECT id, name, unit, hsn_code FROM items WHERE track_inventory = 1 ORDER BY name ASC"
  );

  const valuations = await Promise.all(items.map((item) => getStockValuation(pool, companyId, item.id, asOfDate)));

  const rows: InventoryValuationRow[] = items.map((item, i) => {
    const v = valuations[i];
    return {
      itemId: item.id,
      itemName: item.name,
      hsnCode: item.hsn_code,
      unit: item.unit,
      qty: v.totalQty,
      costedQty: v.costedQty,
      averageCost: v.averageCost,
      inventoryValue: v.totalValue,
      hasCostGap: v.hasCostGap,
    };
  });

  return {
    asOfDate,
    rows,
    totalQty: round2(rows.reduce((s, r) => s + r.qty, 0)),
    totalCostedQty: round2(rows.reduce((s, r) => s + r.costedQty, 0)),
    totalValue: round2(rows.reduce((s, r) => s + r.inventoryValue, 0)),
    hasAnyCostGap: rows.some((r) => r.hasCostGap),
  };
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
  /** Phase 12F: the row's own stored unit_cost - null when this specific
   * transaction was never given a cost (e.g. a purchase_receipt entered
   * with no rate, or a pre-Phase-12C row). NEVER recomputed from today's
   * weighted average - a reversal row already carries over the EXACT SAME
   * unit_cost as the row it reverses (see reverseOneStockTransactionTx),
   * so this column is correct for historical rows without any extra work
   * here. */
  unitCost: number | null;
  /** signedQty * unitCost, or null when unitCost is null - never a
   * fabricated 0. This is the row's own value contribution, not a running
   * total (see StockLevelRow.inventoryValue / getStockValuation for the
   * running book value). */
  valueImpact: number | null;
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
    const unitCost = r.unit_cost === null || r.unit_cost === undefined ? null : Number(r.unit_cost);
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
      unitCost,
      valueImpact: unitCost === null ? null : round2(signedQty * unitCost),
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
