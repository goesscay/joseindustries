import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import {
  InsufficientStockError,
  InventoryError,
  getStockLedger,
  getStockLevels,
  postAdjustmentTx,
  postOpeningStockTx,
} from "../services/inventory";

// Phase 12: Inventory & Stock Management - quantity-only. Gated by its own
// new "inventory.stock" permission module (not reused from items.items or
// reports.reports - stock movement is its own concern, distinct from
// editing the item catalog or reading financial reports). Purchase Bill /
// Tax Invoice stock posting itself lives inline in their own routers
// (purchaseBills.ts / salesDocuments.ts) - this router only covers the
// manual entry points (opening stock, adjustments) and the two read-only
// reports (stock levels, stock ledger).
export const inventoryRouter = Router();
inventoryRouter.use(requireAuth, requireModuleAccess("inventory.stock", "view"));

function dateRange(query: any): { from: string; to: string } {
  const to = typeof query.to === "string" && query.to ? query.to : new Date().toISOString().slice(0, 10);
  const from = typeof query.from === "string" && query.from ? query.from : "1900-01-01";
  return { from, to };
}

inventoryRouter.get(
  "/stock-levels",
  asyncHandler(async (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    if (!companyId) return res.status(400).json({ message: "company_id is required" });
    const rows = await getStockLevels(companyId);
    res.json({ data: rows });
  })
);

inventoryRouter.get(
  "/ledger",
  asyncHandler(async (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const itemId = req.query.item_id ? Number(req.query.item_id) : null;
    if (!companyId) return res.status(400).json({ message: "company_id is required" });
    if (!itemId) return res.status(400).json({ message: "item_id is required" });
    const { from, to } = dateRange(req.query);
    const result = await getStockLedger(companyId, itemId, from, to);
    res.json({ from, to, ...result });
  })
);

inventoryRouter.post(
  "/opening-stock",
  requireModuleAccess("inventory.stock", "create"),
  asyncHandler(async (req, res) => {
    const { company_id, item_id, txn_date, qty, unit_cost, notes } = req.body ?? {};
    if (!company_id || !item_id || !txn_date || qty === undefined) {
      return res.status(400).json({ message: "company_id, item_id, txn_date and qty are required" });
    }
    try {
      const txn = await postOpeningStockTx({
        companyId: Number(company_id),
        itemId: Number(item_id),
        txnDate: txn_date,
        qty: Number(qty),
        unitCost: unit_cost !== undefined && unit_cost !== null && unit_cost !== "" ? Number(unit_cost) : null,
        notes: notes || null,
        createdBy: req.user!.sub,
      });
      res.status(201).json({ transaction: txn });
    } catch (err) {
      if (err instanceof InventoryError) {
        return res.status(err.status).json({ message: err.message });
      }
      throw err;
    }
  })
);

inventoryRouter.post(
  "/adjustments",
  requireModuleAccess("inventory.stock", "create"),
  asyncHandler(async (req, res) => {
    const { company_id, item_id, txn_date, txn_type, qty, notes, confirm_negative_stock } = req.body ?? {};
    if (!company_id || !item_id || !txn_date || qty === undefined || !txn_type) {
      return res.status(400).json({ message: "company_id, item_id, txn_date, txn_type and qty are required" });
    }
    if (txn_type !== "adjustment_in" && txn_type !== "adjustment_out") {
      return res.status(400).json({ message: "txn_type must be 'adjustment_in' or 'adjustment_out'" });
    }
    try {
      const txn = await postAdjustmentTx({
        companyId: Number(company_id),
        itemId: Number(item_id),
        txnDate: txn_date,
        txnType: txn_type,
        qty: Number(qty),
        notes,
        createdBy: req.user!.sub,
        confirmNegativeStock: Boolean(confirm_negative_stock),
      });
      res.status(201).json({ transaction: txn });
    } catch (err) {
      if (err instanceof InsufficientStockError) {
        return res.status(err.status).json({ message: err.message, code: "INSUFFICIENT_STOCK", items: err.items });
      }
      if (err instanceof InventoryError) {
        return res.status(err.status).json({ message: err.message });
      }
      throw err;
    }
  })
);
