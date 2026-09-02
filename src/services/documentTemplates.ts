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
  };
}
