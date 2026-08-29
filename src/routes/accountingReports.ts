import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import {
  AccountingError,
  getBalanceSheet,
  getCashFlowStatement,
  getGeneralLedger,
  getGstSummary,
  getProfitAndLoss,
  getTrialBalance,
} from "../services/accounting";

// General Ledger / Trial Balance - built entirely from the double-entry
// ledger (journals + journal_lines + chart_of_accounts), never the old
// ad-hoc source-table queries reports.ts uses. Gated by the existing
// "reports.reports" permission - same reporting-permission architecture as
// every other report, not a new/duplicate permission system (Phase 5,
// Step 9). Account/journal *management* stays behind
// accounting.chart_of_accounts / accounting.journals, unrelated to reading
// these reports.
export const accountingReportsRouter = Router();
accountingReportsRouter.use(requireAuth, requireModuleAccess("reports.reports", "view"));

function dateRange(query: any): { from: string; to: string } {
  const to = typeof query.to === "string" && query.to ? query.to : new Date().toISOString().slice(0, 10);
  const from = typeof query.from === "string" && query.from ? query.from : "1900-01-01";
  return { from, to };
}

accountingReportsRouter.get(
  "/general-ledger",
  asyncHandler(async (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    const accountId = req.query.account_id ? Number(req.query.account_id) : null;
    if (!companyId) return res.status(400).json({ message: "company_id is required" });
    if (!accountId) return res.status(400).json({ message: "account_id is required" });
    const { from, to } = dateRange(req.query);
    const sourceType = typeof req.query.source_type === "string" ? req.query.source_type : undefined;
    const reference = typeof req.query.reference === "string" ? req.query.reference : undefined;

    try {
      // getGeneralLedger itself verifies the account actually belongs to
      // company_id - a mismatched pair is rejected here, not just
      // filtered out of the results (Phase 5, Step 10: company isolation
      // enforced server-side, never assumed from what the frontend sent).
      const result = await getGeneralLedger({ companyId, accountId, from, to, sourceType, reference });
      res.json(result);
    } catch (err) {
      if (err instanceof AccountingError) {
        const status = err.message.includes("not found") ? 404 : 403;
        return res.status(status).json({ message: err.message });
      }
      throw err;
    }
  })
);

accountingReportsRouter.get(
  "/trial-balance",
  asyncHandler(async (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    if (!companyId) return res.status(400).json({ message: "company_id is required" });
    const asOfDate =
      typeof req.query.as_of === "string" && req.query.as_of ? req.query.as_of : new Date().toISOString().slice(0, 10);

    // getTrialBalance is already scoped to companyId's own chart_of_accounts
    // rows by construction (its query's WHERE clause) - there's no
    // account_id parameter here for a mismatch to even be possible.
    const result = await getTrialBalance(companyId, asOfDate);
    res.json(result);
  })
);

// Profit & Loss (Phase 8) - built entirely from journals + journal_lines +
// chart_of_accounts (see getProfitAndLoss's doc comment), never from
// documents/expenses directly. Same company-scoping-by-construction as
// trial-balance above - the only scoping input is company_id itself, used
// directly in the query's WHERE clause, so there's no account_id parameter
// for a cross-company mismatch to even be possible.
accountingReportsRouter.get(
  "/profit-loss",
  asyncHandler(async (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    if (!companyId) return res.status(400).json({ message: "company_id is required" });
    const { from, to } = dateRange(req.query);

    const result = await getProfitAndLoss(companyId, from, to);
    res.json(result);
  })
);

// Balance Sheet (Phase 9) - built entirely from journals + journal_lines +
// chart_of_accounts (see getBalanceSheet's doc comment), never from
// accounts.opening_balance or the old journal_entries table. Same
// company-scoping-by-construction as trial-balance/profit-loss above.
accountingReportsRouter.get(
  "/balance-sheet",
  asyncHandler(async (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    if (!companyId) return res.status(400).json({ message: "company_id is required" });
    const asOfDate =
      typeof req.query.as_of === "string" && req.query.as_of ? req.query.as_of : new Date().toISOString().slice(0, 10);

    const result = await getBalanceSheet(companyId, asOfDate);
    res.json(result);
  })
);

// Cash Flow Statement (Phase 10, indirect method) - built entirely from
// journals + journal_lines + chart_of_accounts (see getCashFlowStatement's
// doc comment), never from accounts.opening_balance or the old
// journal_entries table. Same company-scoping-by-construction as
// trial-balance/profit-loss/balance-sheet above.
accountingReportsRouter.get(
  "/cash-flow",
  asyncHandler(async (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    if (!companyId) return res.status(400).json({ message: "company_id is required" });
    const { from, to } = dateRange(req.query);

    const result = await getCashFlowStatement(companyId, from, to);
    res.json(result);
  })
);

// GST Summary (Phase 11A) - built entirely from journals + journal_lines +
// chart_of_accounts (see getGstSummary's doc comment), replacing the
// legacy documents/expenses-based /api/reports/gst-summary query. Same
// company-scoping-by-construction as trial-balance/profit-loss/balance-
// sheet/cash-flow above.
accountingReportsRouter.get(
  "/gst-summary",
  asyncHandler(async (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    if (!companyId) return res.status(400).json({ message: "company_id is required" });
    const { from, to } = dateRange(req.query);

    const result = await getGstSummary(companyId, from, to);
    res.json(result);
  })
);
