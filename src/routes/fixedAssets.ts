import { Router } from "express";
import { PoolConnection } from "mysql2/promise";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { getNextDocNumber } from "../services/numbering";
import {
  AccountingError,
  getJournalBySource,
  postFixedAssetAcquisitionJournalTx,
  postFixedAssetDepreciationJournalTx,
  postFixedAssetDisposalJournalTx,
  reverseJournalTx,
} from "../services/accounting";
import { FixedAsset, FixedAssetDepreciationEntry } from "../types";

// Double-entry rollout, Phase F: Fixed Assets + Depreciation - see
// schema.sql's comment on fixed_assets for the full design (own dedicated
// tables, not wired into Purchase Bills; straight-line only, no day-level
// proration; a shared "1200"/"1210" leaf per company rather than one per
// asset).
export const fixedAssetsRouter = Router();
const MODULE = "accounting.fixed_assets";
fixedAssetsRouter.use(requireAuth);

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function findById(id: number): Promise<FixedAsset | undefined> {
  const [rows] = await pool.query<any[]>(
    `SELECT fa.*, co.name as company_name, co.code as company_code
     FROM fixed_assets fa
     JOIN companies co ON co.id = fa.company_id
     WHERE fa.id = ? LIMIT 1`,
    [id]
  );
  return rows[0] as FixedAsset | undefined;
}

async function findDepreciationEntries(fixedAssetId: number): Promise<FixedAssetDepreciationEntry[]> {
  const [rows] = await pool.query<any[]>(
    "SELECT * FROM fixed_asset_depreciation_entries WHERE fixed_asset_id = ? ORDER BY period_end_date ASC, id ASC",
    [fixedAssetId]
  );
  return rows as FixedAssetDepreciationEntry[];
}

async function getAccumulatedDepreciation(runner: PoolConnection | typeof pool, fixedAssetId: number): Promise<number> {
  const [rows] = await runner.query<any[]>(
    "SELECT COALESCE(SUM(amount), 0) as total FROM fixed_asset_depreciation_entries WHERE fixed_asset_id = ?",
    [fixedAssetId]
  );
  return round2(Number(rows[0].total));
}

fixedAssetsRouter.get(
  "/",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const perPage = Math.min(Math.max(Number(req.query.perPage) || 10, 1), 100);
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const offset = (page - 1) * perPage;

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (search) {
      clauses.push("(fa.asset_no LIKE ? OR fa.asset_name LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }
    if (companyId) {
      clauses.push("fa.company_id = ?");
      params.push(companyId);
    }
    if (status) {
      clauses.push("fa.status = ?");
      params.push(status);
    }
    const whereClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const [rows] = await pool.query<any[]>(
      `SELECT fa.*, co.name as company_name, co.code as company_code,
              COALESCE((SELECT SUM(d.amount) FROM fixed_asset_depreciation_entries d WHERE d.fixed_asset_id = fa.id), 0) as accumulated_depreciation
       FROM fixed_assets fa
       JOIN companies co ON co.id = fa.company_id
       ${whereClause}
       ORDER BY fa.purchase_date DESC, fa.id DESC
       LIMIT ? OFFSET ?`,
      [...params, perPage, offset]
    );
    const [countRows] = await pool.query<any[]>(
      `SELECT COUNT(*) as total FROM fixed_assets fa ${whereClause}`,
      params
    );

    const data = rows.map((r) => ({
      ...r,
      accumulated_depreciation: String(r.accumulated_depreciation),
      book_value: round2(Number(r.cost) - Number(r.accumulated_depreciation)),
    }));
    res.json({ data, meta: { page, perPage, total: countRows[0].total as number } });
  })
);

fixedAssetsRouter.get(
  "/:id",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const asset = await findById(Number(req.params.id));
    if (!asset) return res.status(404).json({ message: "Fixed asset not found" });
    const entries = await findDepreciationEntries(asset.id);
    const accumulatedDepreciation = await getAccumulatedDepreciation(pool, asset.id);
    const bookValue = round2(Number(asset.cost) - accumulatedDepreciation);
    res.json({ asset, entries, accumulatedDepreciation, bookValue });
  })
);

fixedAssetsRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const { company_id, asset_name, category, purchase_date, cost, salvage_value, useful_life_months, contra_account_id, notes } =
      req.body ?? {};
    if (!company_id || !asset_name || !purchase_date || !cost || !useful_life_months || !contra_account_id) {
      return res.status(400).json({
        message: "company_id, asset_name, purchase_date, cost, useful_life_months and contra_account_id are required",
      });
    }
    const costNum = Number(cost);
    const salvageNum = Number(salvage_value) || 0;
    const usefulLifeMonths = Number(useful_life_months);
    if (!Number.isFinite(costNum) || costNum <= 0) return res.status(400).json({ message: "cost must be a positive number" });
    if (!Number.isFinite(salvageNum) || salvageNum < 0 || salvageNum >= costNum) {
      return res.status(400).json({ message: "salvage_value must be 0 or more, and less than cost" });
    }
    if (!Number.isInteger(usefulLifeMonths) || usefulLifeMonths < 1) {
      return res.status(400).json({ message: "useful_life_months must be a whole number of at least 1" });
    }

    const [companyRows] = await pool.query<any[]>("SELECT * FROM companies WHERE id = ?", [company_id]);
    const company = companyRows[0];
    if (!company) return res.status(404).json({ message: "Company not found" });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const { docNumber, financialYear } = await getNextDocNumber("fixed_asset", company.code, new Date(purchase_date));
      const [result] = await conn.query<any>(
        `INSERT INTO fixed_assets
           (asset_no, financial_year, company_id, asset_name, category, purchase_date, cost, salvage_value,
            useful_life_months, depreciation_method, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'straight_line', ?, ?)`,
        [docNumber, financialYear, company_id, asset_name, category || null, purchase_date, costNum, salvageNum, usefulLifeMonths, notes || null, req.user!.sub]
      );
      const assetId = result.insertId;

      const journal = await postFixedAssetAcquisitionJournalTx(conn, {
        companyId: Number(company_id),
        fixedAssetId: assetId,
        cost: costNum,
        contraAccountId: Number(contra_account_id),
        purchaseDate: purchase_date,
        assetName: asset_name,
        createdBy: req.user!.sub,
      });

      await conn.commit();
      const created = await findById(assetId);
      res.status(201).json({ asset: created, journal });
    } catch (err: any) {
      await conn.rollback();
      if (err instanceof AccountingError) return res.status(400).json({ message: `Fixed asset could not be recorded: ${err.message}` });
      throw err;
    } finally {
      conn.release();
    }
  })
);

// Draft-equivalent delete: only while nothing has been built on top of this
// asset yet (no depreciation ever run against it) - same "can only delete
// if untouched" discipline as every other document type in this app. There
// is no PUT anywhere on this router: cost/purchase_date/useful_life/salvage
// are immutable once set, because depreciation math and (once any has
// posted) accumulated depreciation are derived from them - changing them in
// place after the fact would silently invalidate every depreciation entry
// already posted. A genuine data-entry mistake is fixed by deleting (while
// still delete-eligible) and re-creating, never by editing.
fixedAssetsRouter.delete(
  "/:id",
  requireModuleAccess(MODULE, "delete"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const asset = await findById(id);
    if (!asset) return res.status(404).json({ message: "Fixed asset not found" });
    if (asset.status !== "active") {
      return res.status(400).json({ message: "A disposed asset can't be deleted" });
    }
    const entries = await findDepreciationEntries(id);
    if (entries.length > 0) {
      return res.status(400).json({ message: "This asset already has depreciation posted against it and can't be deleted" });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const journal = await getJournalBySource("fixed_asset", id);
      if (journal) await reverseJournalTx(conn, journal.id, req.user!.sub);
      await conn.query("DELETE FROM fixed_assets WHERE id = ?", [id]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError) return res.status(400).json({ message: err.message });
      throw err;
    } finally {
      conn.release();
    }
    res.json({ message: "Fixed asset deleted" });
  })
);

// Disposal is terminal: removes the asset from the books at whatever it's
// worth today (cost minus accumulated depreciation) against whatever
// proceeds were actually received, booking the difference as a gain/loss -
// see postFixedAssetDisposalJournalTx's own comment for the worked algebra
// proving this always balances regardless of sign. Once disposed, the asset
// drops out of every future depreciation run (status != 'active').
fixedAssetsRouter.post(
  "/:id/dispose",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const asset = await findById(id);
    if (!asset) return res.status(404).json({ message: "Fixed asset not found" });
    if (asset.status !== "active") {
      return res.status(400).json({ message: "This asset has already been disposed" });
    }
    const { disposal_date, disposal_amount, contra_account_id } = req.body ?? {};
    if (!disposal_date) return res.status(400).json({ message: "disposal_date is required" });
    const disposalAmount = Number(disposal_amount) || 0;
    if (disposalAmount < 0) return res.status(400).json({ message: "disposal_amount can't be negative" });
    if (disposalAmount > 0 && !contra_account_id) {
      return res.status(400).json({ message: "A receiving account is required when disposal proceeds are greater than zero" });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const accumulatedDepreciation = await getAccumulatedDepreciation(conn, id);
      const journal = await postFixedAssetDisposalJournalTx(conn, {
        companyId: asset.company_id,
        fixedAssetId: id,
        cost: Number(asset.cost),
        accumulatedDepreciation,
        disposalAmount,
        contraAccountId: contra_account_id ? Number(contra_account_id) : null,
        disposalDate: disposal_date,
        assetName: asset.asset_name,
        createdBy: req.user!.sub,
      });
      await conn.query(
        "UPDATE fixed_assets SET status = 'disposed', disposal_date = ?, disposal_amount = ? WHERE id = ?",
        [disposal_date, disposalAmount, id]
      );
      await conn.commit();
      const updated = await findById(id);
      res.json({ asset: updated, journal });
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError) return res.status(400).json({ message: `Disposal could not be recorded: ${err.message}` });
      throw err;
    } finally {
      conn.release();
    }
  })
);

// Runs one period's straight-line depreciation across every active asset
// for a company in a single transaction (all-or-nothing - a mistake partway
// through never leaves half a batch posted). Each eligible asset gets its
// own independent journal; skips are reported, never silently dropped, so
// the caller can see exactly why an asset didn't get an entry this run.
fixedAssetsRouter.post(
  "/depreciation/run",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const { company_id, period_end_date } = req.body ?? {};
    if (!company_id || !period_end_date) {
      return res.status(400).json({ message: "company_id and period_end_date are required" });
    }

    const [assets] = await pool.query<any[]>(
      "SELECT * FROM fixed_assets WHERE company_id = ? AND status = 'active' AND purchase_date <= ? ORDER BY id ASC",
      [company_id, period_end_date]
    );

    const posted: { assetId: number; assetName: string; amount: number; journalId: number }[] = [];
    const skipped: { assetId: number; assetName: string; reason: string }[] = [];

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      for (const asset of assets) {
        const [existingRows] = await conn.query<any[]>(
          "SELECT id FROM fixed_asset_depreciation_entries WHERE fixed_asset_id = ? AND period_end_date = ? LIMIT 1",
          [asset.id, period_end_date]
        );
        if (existingRows[0]) {
          skipped.push({ assetId: asset.id, assetName: asset.asset_name, reason: "Already depreciated for this period" });
          continue;
        }
        const [latestRows] = await conn.query<any[]>(
          "SELECT period_end_date FROM fixed_asset_depreciation_entries WHERE fixed_asset_id = ? ORDER BY period_end_date DESC LIMIT 1",
          [asset.id]
        );
        if (latestRows[0] && new Date(period_end_date) <= new Date(latestRows[0].period_end_date)) {
          skipped.push({ assetId: asset.id, assetName: asset.asset_name, reason: "This period is not after the asset's latest depreciation entry" });
          continue;
        }

        const accumulated = await getAccumulatedDepreciation(conn, asset.id);
        const depreciableBase = round2(Number(asset.cost) - Number(asset.salvage_value));
        const remaining = round2(depreciableBase - accumulated);
        if (remaining <= 0.01) {
          skipped.push({ assetId: asset.id, assetName: asset.asset_name, reason: "Already fully depreciated" });
          continue;
        }
        const monthlyAmount = round2(depreciableBase / asset.useful_life_months);
        const amount = Math.min(monthlyAmount, remaining);

        const [entryResult] = await conn.query<any>(
          `INSERT INTO fixed_asset_depreciation_entries (fixed_asset_id, period_end_date, amount, created_by)
           VALUES (?, ?, ?, ?)`,
          [asset.id, period_end_date, amount, req.user!.sub]
        );
        const entryId = entryResult.insertId;

        const journal = await postFixedAssetDepreciationJournalTx(conn, {
          companyId: asset.company_id,
          depreciationEntryId: entryId,
          amount,
          periodEndDate: period_end_date,
          assetName: asset.asset_name,
          createdBy: req.user!.sub,
        });
        posted.push({ assetId: asset.id, assetName: asset.asset_name, amount, journalId: journal.id });
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError) return res.status(400).json({ message: `Depreciation run failed: ${err.message}` });
      throw err;
    } finally {
      conn.release();
    }

    res.json({ posted, skipped });
  })
);

// Only the single latest entry for an asset may be deleted (reverses its
// journal) - deleting an older one while later ones exist would leave a
// gap in an otherwise-contiguous schedule. See schema.sql's comment on
// fixed_asset_depreciation_entries.
fixedAssetsRouter.delete(
  "/depreciation-entries/:id",
  requireModuleAccess(MODULE, "delete"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const [rows] = await pool.query<any[]>("SELECT * FROM fixed_asset_depreciation_entries WHERE id = ?", [id]);
    const entry = rows[0];
    if (!entry) return res.status(404).json({ message: "Depreciation entry not found" });

    const [latestRows] = await pool.query<any[]>(
      "SELECT id FROM fixed_asset_depreciation_entries WHERE fixed_asset_id = ? ORDER BY period_end_date DESC, id DESC LIMIT 1",
      [entry.fixed_asset_id]
    );
    if (!latestRows[0] || latestRows[0].id !== entry.id) {
      return res.status(400).json({ message: "Only the most recent depreciation entry for this asset can be deleted" });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const journal = await getJournalBySource("fixed_asset_depreciation", id);
      if (journal) await reverseJournalTx(conn, journal.id, req.user!.sub);
      await conn.query("DELETE FROM fixed_asset_depreciation_entries WHERE id = ?", [id]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      if (err instanceof AccountingError) return res.status(400).json({ message: err.message });
      throw err;
    } finally {
      conn.release();
    }
    res.json({ message: "Depreciation entry deleted" });
  })
);
