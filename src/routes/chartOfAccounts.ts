import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { AccountingError, getAccountBalance, getLedger } from "../services/accounting";
import { ChartOfAccount, LedgerAccountType, NormalBalance } from "../types";

export const chartOfAccountsRouter = Router();
const MODULE = "accounting.chart_of_accounts";
chartOfAccountsRouter.use(requireAuth);

const ACCOUNT_TYPES: LedgerAccountType[] = ["asset", "liability", "equity", "revenue", "expense"];
const NORMAL_BALANCES: NormalBalance[] = ["debit", "credit"];

async function findById(id: number): Promise<ChartOfAccount | undefined> {
  const [rows] = await pool.query<any[]>("SELECT * FROM chart_of_accounts WHERE id = ? LIMIT 1", [id]);
  return rows[0] as ChartOfAccount | undefined;
}

chartOfAccountsRouter.get(
  "/",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    if (!companyId) return res.status(400).json({ message: "company_id is required" });
    const [rows] = await pool.query<any[]>(
      "SELECT * FROM chart_of_accounts WHERE company_id = ? ORDER BY account_code ASC",
      [companyId]
    );
    res.json({ data: rows as ChartOfAccount[] });
  })
);

chartOfAccountsRouter.get(
  "/:id",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const account = await findById(Number(req.params.id));
    if (!account) return res.status(404).json({ message: "Account not found" });
    res.json({ account });
  })
);

// Per-account ledger / running balance - thin wrappers over the shared
// accounting service (see src/services/accounting.ts) so this route file
// never duplicates the balance/ledger math itself.
chartOfAccountsRouter.get(
  "/:id/ledger",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    try {
      const result = await getLedger(id, from, to);
      res.json(result);
    } catch (err) {
      if (err instanceof AccountingError) return res.status(404).json({ message: err.message });
      throw err;
    }
  })
);

chartOfAccountsRouter.get(
  "/:id/balance",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const asOf = typeof req.query.as_of === "string" ? req.query.as_of : undefined;
    try {
      const balance = await getAccountBalance(id, asOf);
      res.json({ balance });
    } catch (err) {
      if (err instanceof AccountingError) return res.status(404).json({ message: err.message });
      throw err;
    }
  })
);

chartOfAccountsRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const { company_id, parent_id, account_code, name, account_type, category, normal_balance, description } =
      req.body ?? {};
    if (!company_id || !account_code || !name || !account_type || !normal_balance) {
      return res
        .status(400)
        .json({ message: "company_id, account_code, name, account_type and normal_balance are required" });
    }
    if (!ACCOUNT_TYPES.includes(account_type)) {
      return res.status(400).json({ message: `account_type must be one of: ${ACCOUNT_TYPES.join(", ")}` });
    }
    if (!NORMAL_BALANCES.includes(normal_balance)) {
      return res.status(400).json({ message: "normal_balance must be 'debit' or 'credit'" });
    }
    if (parent_id) {
      const parent = await findById(Number(parent_id));
      if (!parent || Number(parent.company_id) !== Number(company_id)) {
        return res.status(400).json({ message: "parent_id must be an existing account in the same company" });
      }
    }

    try {
      const [result] = await pool.query<any>(
        `INSERT INTO chart_of_accounts
           (company_id, parent_id, account_code, name, account_type, category, normal_balance, description, is_system)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          company_id,
          parent_id || null,
          account_code,
          name,
          account_type,
          category || null,
          normal_balance,
          description || null,
        ]
      );
      const created = await findById(result.insertId);
      res.status(201).json({ account: created });
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY") {
        return res.status(400).json({ message: "An account with this code already exists for this company" });
      }
      throw err;
    }
  })
);

chartOfAccountsRouter.put(
  "/:id",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findById(id);
    if (!existing) return res.status(404).json({ message: "Account not found" });

    // Seeded defaults (is_system) keep their code/type/normal_balance fixed -
    // everything downstream (seed UPDATEs, balance-sign logic) assumes those
    // never move. Name/category/description/active/parent are still editable.
    if (existing.is_system && (req.body?.account_code || req.body?.account_type || req.body?.normal_balance)) {
      return res
        .status(400)
        .json({ message: "The code, type and normal balance of a system account cannot be changed" });
    }

    const { name, category, description, is_active, parent_id } = req.body ?? {};
    if (!name) return res.status(400).json({ message: "Name is required" });
    if (parent_id) {
      if (Number(parent_id) === id) {
        return res.status(400).json({ message: "An account cannot be its own parent" });
      }
      const parent = await findById(Number(parent_id));
      if (!parent || Number(parent.company_id) !== Number(existing.company_id)) {
        return res.status(400).json({ message: "parent_id must be an existing account in the same company" });
      }
    }

    await pool.query(
      `UPDATE chart_of_accounts SET name = ?, category = ?, description = ?, is_active = ?, parent_id = ? WHERE id = ?`,
      [
        name,
        category ?? existing.category,
        description ?? existing.description,
        is_active === undefined ? existing.is_active : Boolean(is_active),
        parent_id === undefined ? existing.parent_id : parent_id || null,
        id,
      ]
    );
    const updated = await findById(id);
    res.json({ account: updated });
  })
);

chartOfAccountsRouter.delete(
  "/:id",
  requireModuleAccess(MODULE, "delete"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findById(id);
    if (!existing) return res.status(404).json({ message: "Account not found" });
    if (existing.is_system) {
      return res.status(400).json({ message: "System accounts cannot be deleted" });
    }

    const [[lineCount], [childCount]] = await Promise.all([
      pool.query<any[]>("SELECT COUNT(*) as c FROM journal_lines WHERE account_id = ?", [id]),
      pool.query<any[]>("SELECT COUNT(*) as c FROM chart_of_accounts WHERE parent_id = ?", [id]),
    ]);
    if (lineCount[0].c > 0) {
      return res.status(400).json({ message: "This account has journal entries posted to it and can't be deleted" });
    }
    if (childCount[0].c > 0) {
      return res.status(400).json({ message: "This account has sub-accounts and can't be deleted" });
    }

    await pool.query("DELETE FROM chart_of_accounts WHERE id = ?", [id]);
    res.json({ message: "Account deleted" });
  })
);
