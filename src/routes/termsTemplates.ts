import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { TermsTemplate, TermsTemplateDocType } from "../types";

export const termsTemplatesRouter = Router();
const MODULE = "settings.terms_conditions";
termsTemplatesRouter.use(requireAuth);

const DOC_TYPES: TermsTemplateDocType[] = ["all", "quotation", "proforma_invoice", "delivery_challan", "tax_invoice"];

async function findById(id: number): Promise<TermsTemplate | undefined> {
  const [rows] = await pool.query<any[]>("SELECT * FROM terms_and_conditions_templates WHERE id = ? LIMIT 1", [id]);
  return rows[0] as TermsTemplate | undefined;
}

termsTemplatesRouter.get(
  "/",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (req, res) => {
    const docType = typeof req.query.docType === "string" ? req.query.docType : undefined;
    if (docType && !DOC_TYPES.includes(docType as TermsTemplateDocType)) {
      return res.status(400).json({ message: "Invalid docType" });
    }
    const [rows] = docType
      ? await pool.query<any[]>(
          "SELECT * FROM terms_and_conditions_templates WHERE doc_type = 'all' OR doc_type = ? ORDER BY title ASC",
          [docType]
        )
      : await pool.query<any[]>("SELECT * FROM terms_and_conditions_templates ORDER BY title ASC");
    res.json({ data: rows as TermsTemplate[] });
  })
);

termsTemplatesRouter.post(
  "/",
  requireModuleAccess(MODULE, "create"),
  asyncHandler(async (req, res) => {
    const { title, doc_type, content, is_default } = req.body ?? {};
    if (!title) return res.status(400).json({ message: "Title is required" });
    if (!content) return res.status(400).json({ message: "Content is required" });
    const docType: TermsTemplateDocType = DOC_TYPES.includes(doc_type) ? doc_type : "all";

    const [result] = await pool.query<any>(
      "INSERT INTO terms_and_conditions_templates (title, doc_type, content, is_default) VALUES (?, ?, ?, ?)",
      [title, docType, content, is_default ? 1 : 0]
    );
    const created = await findById(result.insertId);
    res.status(201).json({ template: created });
  })
);

termsTemplatesRouter.put(
  "/:id",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findById(id);
    if (!existing) return res.status(404).json({ message: "Template not found" });

    const { title, doc_type, content, is_default } = req.body ?? {};
    if (!title) return res.status(400).json({ message: "Title is required" });
    if (!content) return res.status(400).json({ message: "Content is required" });
    const docType: TermsTemplateDocType = DOC_TYPES.includes(doc_type) ? doc_type : "all";

    await pool.query(
      "UPDATE terms_and_conditions_templates SET title = ?, doc_type = ?, content = ?, is_default = ? WHERE id = ?",
      [title, docType, content, is_default ? 1 : 0, id]
    );
    const updated = await findById(id);
    res.json({ template: updated });
  })
);

termsTemplatesRouter.delete(
  "/:id",
  requireModuleAccess(MODULE, "delete"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await findById(id);
    if (!existing) return res.status(404).json({ message: "Template not found" });

    await pool.query("DELETE FROM terms_and_conditions_templates WHERE id = ?", [id]);
    res.json({ message: "Template deleted" });
  })
);
