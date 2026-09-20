import path from "path";
import { Company } from "../../types";
import { EffectiveDocumentTemplate } from "../documentTemplates";

// The letterhead shared by the "classic" invoice/quotation templates: logo
// icon + company name, then tagline / address / phone + email / GSTIN lines,
// centred inside a bordered box, followed by a bordered title band naming the
// document (QUOTATION, TAX INVOICE, ...). It replaces the plain text company
// block those templates used to carry, so every classic template opens the
// same way. Honors the template's logo toggle, accent colour and header label.

const LOGO_PATH = path.join(__dirname, "../../../client/src/assets/logo-black.png");
const LOGO_NATURAL_WIDTH = 493;
const LOGO_NATURAL_HEIGHT = 125;
const LOGO_ICON_FRACTION = 0.4; // share of the artwork that is the icon mark, left of the wordmark

const INK = "#000000";
const MUTED = "#444444";

export interface LetterheadOptions {
  company: Company;
  template: EffectiveDocumentTemplate;
  /** Text of the title band, e.g. "Tax Invoice" (drawn upper-case). */
  title: string;
  left: number;
  width: number;
  top: number;
  /** Minimum height of the letterhead box (the title band is extra). */
  minHeight?: number;
  titleBandHeight?: number;
}

/** Draws the letterhead + title band and returns the y just below the band. */
export function drawLetterhead(doc: PDFKit.PDFDocument, o: LetterheadOptions): number {
  const { company, template, left, width, top } = o;
  const accent = template.accentColor;
  const bandH = o.titleBandHeight ?? 26;
  const innerW = width - 40;
  const name = company.name.toUpperCase();

  const line = (str: string, x: number, y: number, w: number, opts: { size: number; bold?: boolean; italic?: boolean; color?: string; align?: "left" | "center" | "right" }) => {
    doc
      .font(opts.bold ? "Helvetica-Bold" : opts.italic ? "Helvetica-Oblique" : "Helvetica")
      .fontSize(opts.size)
      .fillColor(opts.color ?? INK)
      .text(str, x, y, { width: w, align: opts.align ?? "left" });
  };
  const box = (x: number, y: number, w: number, h: number) => {
    doc.lineWidth(0.9).strokeColor(INK).rect(x, y, w, h).stroke();
  };

  const iconH = 40;
  const iconW = template.showLogo ? LOGO_ICON_FRACTION * LOGO_NATURAL_WIDTH * (iconH / LOGO_NATURAL_HEIGHT) : 0;
  let nameSize = 26;
  doc.font("Helvetica-Bold").fontSize(nameSize);
  while (doc.widthOfString(name) + iconW + 12 > innerW && nameSize > 14) {
    nameSize -= 1;
    doc.fontSize(nameSize);
  }
  const nameW = doc.widthOfString(name);
  const groupW = nameW + (iconW ? iconW + 12 : 0);
  const startX = left + (width - groupW) / 2;
  const rowTop = top + 11;

  if (iconW) {
    try {
      doc.save();
      doc.rect(startX, rowTop, iconW, iconH).clip();
      doc.image(LOGO_PATH, startX, rowTop, { height: iconH });
      doc.restore();
    } catch {
      // Logo file missing - skip silently rather than fail PDF generation.
    }
  }
  line(name, startX + (iconW ? iconW + 12 : 0), rowTop + (iconH - nameSize) / 2 - 1, nameW + 4, { size: nameSize, bold: true, color: accent });

  let cy = rowTop + iconH + 7;
  const centered = (str: string, size: number, opts: { italic?: boolean; bold?: boolean } = {}) => {
    doc.font(opts.bold ? "Helvetica-Bold" : opts.italic ? "Helvetica-Oblique" : "Helvetica").fontSize(size);
    const h = doc.heightOfString(str, { width: innerW });
    line(str, left + 20, cy, innerW, { size, color: MUTED, align: "center", ...opts });
    cy += h + 2.5;
  };
  if (company.tagline) centered(company.tagline, 9, { italic: true });
  if (company.address) centered(company.address, 9.5);
  const contact = [company.phone ? `Phone : ${company.phone}` : "", company.email ? `Email : ${company.email}` : ""]
    .filter(Boolean)
    .join("     |     ");
  if (contact) centered(contact, 9.5);
  if (company.gstin) centered(`GSTIN : ${company.gstin}`, 9.5, { bold: true });

  const headerH = Math.max(o.minHeight ?? 100, cy - top + 6);
  box(left, top, width, headerH);

  const bandTop = top + headerH;
  box(left, bandTop, width, bandH);
  line(o.title.toUpperCase(), left, bandTop + (bandH - 14) / 2, width, { size: 14, bold: true, color: accent, align: "center" });
  if (template.headerLabel) {
    line(template.headerLabel, left, bandTop + (bandH - 8.5) / 2, width - 10, { size: 8.5, italic: true, color: MUTED, align: "right" });
  }
  return bandTop + bandH;
}
