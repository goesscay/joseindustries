import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { getGstr1, getGstr3b } from "../services/gstReturns";

// GST Returns preparation (Phase 11B) - GSTR-1/GSTR-3B preparation data
// only. This is an internal preparation/reporting tool, never a filing or
// submission mechanism - there is no GST portal API integration anywhere
// in this codebase. Gated by the existing "reports.reports" permission,
// same as every report since Phase 8 - no new permission introduced.
export const gstReturnsRouter = Router();
gstReturnsRouter.use(requireAuth, requireModuleAccess("reports.reports", "view"));

function dateRange(query: any): { from: string; to: string } {
  const to = typeof query.to === "string" && query.to ? query.to : new Date().toISOString().slice(0, 10);
  const from = typeof query.from === "string" && query.from ? query.from : "1900-01-01";
  return { from, to };
}

// GSTR-1 - source-document-derived (documents + document_items), never the
// ledger - see getGstr1's own doc comment for the full reasoning.
gstReturnsRouter.get(
  "/gstr1",
  asyncHandler(async (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    if (!companyId) return res.status(400).json({ message: "company_id is required" });
    const { from, to } = dateRange(req.query);

    const result = await getGstr1(companyId, from, to);
    res.json(result);
  })
);

// GSTR-3B - a reshaping of getGstSummary/getProfitAndLoss's existing,
// unmodified ledger figures - see getGstr3b's own doc comment.
gstReturnsRouter.get(
  "/gstr3b",
  asyncHandler(async (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    if (!companyId) return res.status(400).json({ message: "company_id is required" });
    const { from, to } = dateRange(req.query);

    const result = await getGstr3b(companyId, from, to);
    res.json(result);
  })
);
