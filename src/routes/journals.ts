import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { AccountingError, createJournal, getJournalById, getJournalLines, reverseJournal } from "../services/accounting";
import { Journal } from "../types";

export const journalsRouter = Router();
const MODULE = "accounting.journals";
journalsRouter.use(requireAuth);

journalsRouter.get(
  "/",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const companyId = req.query.company_id ? Number(req.query.company_id) : null;
    if (!companyId) return res.status(400).json({ message: "company_id is required" });

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 25));
    const offset = (page - 1) * pageSize;

    const clauses = ["company_id = ?"];
    const params: unknown[] = [companyId];
    if (req.query.source_type) {
      clauses.push("source_type = ?");
      params.push(req.query.source_type);
    }
    if (req.query.from) {
      clauses.push("journal_date >= ?");
      params.push(req.query.from);
    }
    if (req.query.to) {
      clauses.push("journal_date <= ?");
      params.push(req.query.to);
    }
    const where = clauses.join(" AND ");

    const [[{ total }]] = await pool.query<any[]>(`SELECT COUNT(*) as total FROM journals WHERE ${where}`, params);
    const [rows] = await pool.query<any[]>(
      `SELECT * FROM journals WHERE ${where} ORDER BY journal_date DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    res.json({ data: rows as Journal[], total: Number(total), page, pageSize });
  })
);

journalsRouter.get(
  "/:id",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const journal = await getJournalById(id);
    if (!journal) return res.status(404).json({ message: "Journal not found" });
    const lines = await getJournalLines(id);
    res.json({ journal, lines });
  })
);

// Posting is the only way rows land in journals/journal_lines - all
// validation (balance, per-line shape, cross-company accounts) lives in
// src/services/accounting.ts so it can't drift between this and any future
// caller (e.g. receipts/vendor payments posting their own journals later).
journalsRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const { company_id, journal_date, reference, source_type, source_id, description, lines } = req.body ?? {};
    if (!company_id || !journal_date) {
      return res.status(400).json({ message: "company_id and journal_date are required" });
    }
    try {
      const journal = await createJournal({
        company_id,
        journal_date,
        reference: reference ?? null,
        source_type: source_type ?? null,
        source_id: source_id ?? null,
        description: description ?? null,
        created_by: req.user!.sub,
        lines: Array.isArray(lines) ? lines : [],
      });
      const journalLines = await getJournalLines(journal.id);
      res.status(201).json({ journal, lines: journalLines });
    } catch (err) {
      if (err instanceof AccountingError) return res.status(400).json({ message: err.message });
      throw err;
    }
  })
);

// There is deliberately no PUT/edit route here - a posted journal is never
// edited in place. A mistake is corrected by reversing it (below), which
// posts an offsetting journal and keeps the original for the audit trail.
journalsRouter.post(
  "/:id/reverse",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    try {
      const reversal = await reverseJournal(id, req.user!.sub);
      const lines = await getJournalLines(reversal.id);
      res.status(201).json({ journal: reversal, lines });
    } catch (err) {
      if (err instanceof AccountingError) return res.status(400).json({ message: err.message });
      throw err;
    }
  })
);
