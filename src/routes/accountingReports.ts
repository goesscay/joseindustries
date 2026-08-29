import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { AccountingError, getGeneralLedger, getTrialBalance } from "../services/accounting";

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
