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
 * (classicGstDocumentPdf.ts); "classic_quotation" is the client's own
 * Quotation sheet (classicQuotationPdf.ts); "classic_measured" is the client's measured-area
 * invoice sheet (same file). New styles register here, in
 * TEMPLATE_STYLE_DOC_TYPES below, and in the one branch each PDF route
 * uses to pick a renderer.
 */
export const TEMPLATE_STYLES = ["classic_gst", "modern", "classic_quotation", "classic_measured"] as const;
export type TemplateStyle = (typeof TEMPLATE_STYLES)[number];

/** Which document types each style can actually draw - a style is only
 * offered (and only honored) for these. "classic_quotation" is a
 * quotation-only layout; "classic_gst" is an invoice layout that also
 * carries the other sales documents. */
export const TEMPLATE_STYLE_DOC_TYPES: Record<TemplateStyle, readonly TemplateDocType[]> = {
  classic_gst: ["quotation", "proforma_invoice", "delivery_challan", "tax_invoice"],
  modern: TEMPLATE_DOC_TYPES,
  classic_quotation: ["quotation"],
  // The client's measured (Height x Length = Sq.Ft) invoice sheet - offered
  // on the two invoice types.
  classic_measured: ["proforma_invoice", "tax_invoice"],
};

export function stylesForDocType(docType: TemplateDocType): TemplateStyle[] {
  return TEMPLATE_STYLES.filter((s) => TEMPLATE_STYLE_DOC_TYPES[s].includes(docType));
}

/** What a (company, doc_type) renders as when nothing is customized -
 * and what a *new* document snapshots at creation (see
 * resolveTemplateStyle). Receipts have only "modern"; Quotations default
 * to the client's own quotation sheet; the other sales documents to the
 * Tally-style invoice. */
export function defaultTemplateStyle(docType: TemplateDocType): TemplateStyle {
  if (docType === "quotation") return "classic_quotation";
  if (docType === "proforma_invoice" || docType === "delivery_challan" || docType === "tax_invoice") return "classic_gst";
  return "modern";
}

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
    templateStyle: pickStyle(row?.template_style, docType),
  };
}

export function isTemplateStyle(v: unknown): v is TemplateStyle {
  return typeof v === "string" && (TEMPLATE_STYLES as readonly string[]).includes(v);
}

/** A stored/snapshotted style only counts if it's a known style that this
 * doc type can actually draw - anything stale, unknown, or from a doc
 * type that no longer supports it falls back to that doc type's default. */
export function pickStyle(v: unknown, docType: TemplateDocType): TemplateStyle {
  return isTemplateStyle(v) && TEMPLATE_STYLE_DOC_TYPES[v].includes(docType) ? v : defaultTemplateStyle(docType);
}

/** The style a document being created *right now* should be stamped with:
 * whatever Settings > Document Templates currently selects for its
 * (company, doc_type). Stored on the document itself so later settings
 * changes never restyle documents that already exist. */
export async function resolveTemplateStyle(companyId: number, docType: TemplateDocType): Promise<TemplateStyle> {
  const [rows] = await pool.query<any[]>(
    "SELECT template_style FROM document_templates WHERE company_id = ? AND doc_type = ? LIMIT 1",
    [companyId, docType]
  );
  return pickStyle(rows[0]?.template_style, docType);
}
