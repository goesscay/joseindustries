import { pool } from "../config/db";

// Document Templates - see schema.sql's comment on document_templates for
// the full design. This list is deliberately wider than documents.doc_type's
// own ENUM (same reasoning as numbering.ts's SeriesType) - half these types
// live in their own dedicated tables (purchase_bills, credit_notes,
// debit_notes, receipts), not `documents`.
export const TEMPLATE_DOC_TYPES = [
  "quotation",
  "proforma_invoice",
  "delivery_challan",
  "tax_invoice",
  "purchase_order",
  "purchase_bill",
  "credit_note",
  "debit_note",
  "receipt",
] as const;

export type TemplateDocType = (typeof TEMPLATE_DOC_TYPES)[number];

/**
 * Selectable PDF layouts, independent of the show_logo/accent_color/etc.
 * overrides above - a style is a different *renderer* entirely, not a
 * variation on one renderer's output. "modern" is this app's original
 * look (documentPdf.ts/receiptPdf.ts); "classic_gst" is a Tally-style
 * Indian GST Tax Invoice format matching a customer-supplied sample
 * (classicGstDocumentPdf.ts), added as the new default for the 4 sales
 * doc types that have PDF export. New styles register here and in the one
 * `switch` each PDF route uses to pick a renderer - nothing else needs to
 * change to add one.
 */
export const TEMPLATE_STYLES = ["classic_gst", "modern"] as const;
export type TemplateStyle = (typeof TEMPLATE_STYLES)[number];

/** Which of these doc types actually have a PDF export today that reads
 * this settings row - the rest are still fully configurable (ready for
 * whenever their own PDF export is built), just not consumed by anything
 * yet. Purely informational for the client (shown as a note), never
 * enforced server-side. */
export const TEMPLATE_DOC_TYPES_WITH_PDF: readonly TemplateDocType[] = [
  "quotation",
  "proforma_invoice",
  "delivery_challan",
  "tax_invoice",
  "receipt",
];

export interface DocumentTemplateDefaults {
  accentColor: string;
  /** null = this doc type shows no header label line by default (e.g.
   * every type except Tax Invoice's built-in "Original for Recipient"). */
  headerLabel: string | null;
  footerNote: string;
  /** The style a route falls back to when no row exists. Receipts (which
   * have no classic_gst renderer) must pass "modern" here - never rely on
   * the column's own DB default, which is "classic_gst" for the sales doc
   * types. */
  templateStyle: TemplateStyle;
}

export interface EffectiveDocumentTemplate {
  showLogo: boolean;
  showBankDetails: boolean;
  showSignatureBlock: boolean;
  accentColor: string;
  headerLabel: string | null;
  footerNote: string;
  templateStyle: TemplateStyle;
}

/**
 * Resolves the settings one PDF renderer should actually use for one
 * (company, doc_type) - every field is an override on top of that
 * renderer's own built-in defaults, never a replacement scheme, so a
 * company/doc_type with no row here (the overwhelmingly common case)
 * renders byte-for-byte identical to how it always has. Booleans always
 * have a real value once a row exists (the columns default to TRUE), so
 * "no row" and "row with every box left checked" are visually identical by
 * construction.
 */
export async function getEffectiveDocumentTemplate(
  companyId: number,
  docType: TemplateDocType,
  defaults: DocumentTemplateDefaults
): Promise<EffectiveDocumentTemplate> {
  const [rows] = await pool.query<any[]>(
    "SELECT * FROM document_templates WHERE company_id = ? AND doc_type = ? LIMIT 1",
    [companyId, docType]
  );
  const row = rows[0];
  return {
    showLogo: row ? Boolean(row.show_logo) : true,
    showBankDetails: row ? Boolean(row.show_bank_details) : true,
    showSignatureBlock: row ? Boolean(row.show_signature_block) : true,
    accentColor: row?.accent_color || defaults.accentColor,
    headerLabel: row && row.header_label !== null ? row.header_label : defaults.headerLabel,
    footerNote: row && row.footer_note !== null ? row.footer_note : defaults.footerNote,
    templateStyle: row && isTemplateStyle(row.template_style) ? row.template_style : defaults.templateStyle,
  };
}

function isTemplateStyle(v: unknown): v is TemplateStyle {
  return typeof v === "string" && (TEMPLATE_STYLES as readonly string[]).includes(v);
}
