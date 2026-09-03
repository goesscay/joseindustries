import { Router } from "express";
import { pool } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { requireModuleAccess } from "../utils/permissions";
import { asyncHandler } from "../utils/asyncHandler";
import { TEMPLATE_DOC_TYPES, TEMPLATE_DOC_TYPES_WITH_PDF, TEMPLATE_STYLES, TemplateDocType, TemplateStyle } from "../services/documentTemplates";
import { DocumentTemplate } from "../types";

export const documentTemplatesRouter = Router();
const MODULE = "settings.document_templates";
documentTemplatesRouter.use(requireAuth);

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function isTemplateDocType(v: unknown): v is TemplateDocType {
  return typeof v === "string" && (TEMPLATE_DOC_TYPES as readonly string[]).includes(v);
}

function isTemplateStyle(v: unknown): v is TemplateStyle {
  return typeof v === "string" && (TEMPLATE_STYLES as readonly string[]).includes(v);
}

// One row per (company, doc_type) that currently has customized settings -
// a company/doc_type with none uses the built-in look untouched (see
// getEffectiveDocumentTemplate). Listed as every company x every doc type
// combination regardless, each merged with the built-in defaults
// (show_* = true, everything else null) when no row exists yet, so the
// settings page always has a complete, editable grid to show - never a
// gap the user has to somehow first "create".
documentTemplatesRouter.get(
  "/",
  requireModuleAccess(MODULE, "view"),
  asyncHandler(async (_req, res) => {
    const [companies] = await pool.query<any[]>("SELECT id, name, code FROM companies ORDER BY code ASC");
    const [rows] = await pool.query<any[]>("SELECT * FROM document_templates");
    const byKey = new Map<string, any>(rows.map((r) => [`${r.company_id}:${r.doc_type}`, r]));

    const data: DocumentTemplate[] = [];
    for (const company of companies) {
      for (const docType of TEMPLATE_DOC_TYPES) {
        const existing = byKey.get(`${company.id}:${docType}`);
        data.push({
          id: existing?.id ?? null,
          company_id: company.id,
          company_name: company.name,
          company_code: company.code,
          doc_type: docType,
          show_logo: existing ? Boolean(existing.show_logo) : true,
          show_bank_details: existing ? Boolean(existing.show_bank_details) : true,
          show_signature_block: existing ? Boolean(existing.show_signature_block) : true,
          accent_color: existing?.accent_color ?? null,
          header_label: existing?.header_label ?? null,
          footer_note: existing?.footer_note ?? null,
          template_style: existing?.template_style ?? null,
          updated_by: existing?.updated_by ?? null,
          created_at: existing?.created_at ?? null,
          updated_at: existing?.updated_at ?? null,
          has_pdf: (TEMPLATE_DOC_TYPES_WITH_PDF as readonly string[]).includes(docType),
        } as DocumentTemplate);
      }
    }
    res.json({ data });
  })
);

// Upserts one (company, doc_type)'s customization in one shot - there's
// nothing to "create" separately from "edit" here, the settings page always
// shows every combination already (see the list route above), so every
// save is conceptually the same "set these fields" action regardless of
// whether a row existed yet.
documentTemplatesRouter.put(
  "/:companyId/:docType",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const companyId = Number(req.params.companyId);
    const docType = req.params.docType;
    if (!isTemplateDocType(docType)) return res.status(400).json({ message: "Invalid document type" });

    const [companyRows] = await pool.query<any[]>("SELECT id FROM companies WHERE id = ?", [companyId]);
    if (!companyRows[0]) return res.status(404).json({ message: "Company not found" });

    const { show_logo, show_bank_details, show_signature_block, accent_color, header_label, footer_note, template_style } =
      req.body ?? {};
    if (accent_color && !HEX_COLOR.test(accent_color)) {
      return res.status(400).json({ message: "accent_color must be a hex color like #1B7A4D" });
    }
    if (header_label && String(header_label).length > 100) {
      return res.status(400).json({ message: "header_label must be 100 characters or fewer" });
    }
    if (footer_note && String(footer_note).length > 255) {
      return res.status(400).json({ message: "footer_note must be 255 characters or fewer" });
    }
    if (template_style && !isTemplateStyle(template_style)) {
      return res.status(400).json({ message: `template_style must be one of: ${TEMPLATE_STYLES.join(", ")}` });
    }

    await pool.query(
      `INSERT INTO document_templates
         (company_id, doc_type, show_logo, show_bank_details, show_signature_block, accent_color, header_label, footer_note, template_style, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         show_logo = VALUES(show_logo), show_bank_details = VALUES(show_bank_details),
         show_signature_block = VALUES(show_signature_block), accent_color = VALUES(accent_color),
         header_label = VALUES(header_label), footer_note = VALUES(footer_note),
         template_style = VALUES(template_style), updated_by = VALUES(updated_by)`,
      [
        companyId,
        docType,
        show_logo === undefined ? true : Boolean(show_logo),
        show_bank_details === undefined ? true : Boolean(show_bank_details),
        show_signature_block === undefined ? true : Boolean(show_signature_block),
        accent_color || null,
        header_label || null,
        footer_note || null,
        template_style || null,
        req.user!.sub,
      ]
    );

    const [rows] = await pool.query<any[]>(
      "SELECT * FROM document_templates WHERE company_id = ? AND doc_type = ?",
      [companyId, docType]
    );
    res.json({ template: rows[0] as DocumentTemplate });
  })
);

// Reverts one (company, doc_type) back to the built-in look - removes the
// row entirely rather than resetting its columns to defaults in place, so
// getEffectiveDocumentTemplate's "no row = untouched" path is exactly what
// runs afterward, not a row that merely happens to match the defaults.
documentTemplatesRouter.post(
  "/:companyId/:docType/reset",
  requireModuleAccess(MODULE, "edit"),
  asyncHandler(async (req, res) => {
    const companyId = Number(req.params.companyId);
    const docType = req.params.docType;
    if (!isTemplateDocType(docType)) return res.status(400).json({ message: "Invalid document type" });

    await pool.query("DELETE FROM document_templates WHERE company_id = ? AND doc_type = ?", [companyId, docType]);
    res.json({ message: "Reverted to default" });
  })
);
