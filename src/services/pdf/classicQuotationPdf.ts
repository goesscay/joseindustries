import path from "path";
import PDFDocument from "pdfkit";
import { Response } from "express";
import { Company, Customer, DocumentItem, DocumentRecord } from "../../types";
import { EffectiveDocumentTemplate } from "../documentTemplates";

// "classic_quotation" style - the client's own Quotation sheet
// (QuotationTemplate.xlsx), reproduced section for section: Buyer block with
// Date / Quotation Number / Other Reference on the right, a
// SN.No | DESCRIPTION | Qty | Rate | Amount item table, a Total / Transport /
// Handling / Grand Total block under it, a "Terms & Condition" table
// (Offer Valid, Payment Terms, Delivery Period, GST, Packing and
// forwarding), Declaration next to Company's Bank Details, and a signature
// row. Column proportions, row heights and the left/right split all come
// from measuring that sheet rendered to PDF. The one deliberate departure is
// the header: the sheet's own header is clipped and overlaps its logo, so it
// is redrawn as a proper letterhead (logo + company name + address/contact
// lines + a QUOTATION title band) - everything below it follows the sheet.
//
// The items area is a tall FLEXIBLE box: it fills whatever page height is
// left after the fixed-size sections, so a one-line quotation still fills the
// A4 page the way the sheet does, and many lines paginate (with the column
// header repeated) instead of overflowing.

const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const PAGE_MARGIN = 38;
const CONTENT_LEFT = PAGE_MARGIN;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const CONTENT_RIGHT = CONTENT_LEFT + CONTENT_WIDTH;
const BOTTOM_LIMIT = PAGE_HEIGHT - PAGE_MARGIN - 8;

const LOGO_PATH = path.join(__dirname, "../../../client/src/assets/logo-black.png");
const LOGO_NATURAL_WIDTH = 493;
const LOGO_NATURAL_HEIGHT = 125;
const LOGO_ICON_FRACTION = 0.4; // share of the artwork that is the icon mark, left of the wordmark

const INK = "#000000";
const MUTED = "#444444";

// Column proportions measured off the sheet (541pt wide there), rescaled to
// this page's content width.
const SHEET_W = 541;
const COL_SHEET = { sno: 45.5, desc: 254.2, qty: 92.7, rate: 73.7, amount: 74.9 };
const COLS = (() => {
  let x = CONTENT_LEFT;
  const out = {} as Record<keyof typeof COL_SHEET, { x: number; width: number }>;
  const keys = Object.keys(COL_SHEET) as (keyof typeof COL_SHEET)[];
  keys.forEach((k, i) => {
    const width = i === keys.length - 1 ? CONTENT_RIGHT - x : (COL_SHEET[k] * CONTENT_WIDTH) / SHEET_W;
    out[k] = { x, width };
    x += width;
  });
  return out;
})();
const SPLIT_X = COLS.qty.x; // left | right divider of the Buyer/Declaration/Signature blocks
const TERMS_LABEL_W = (104.5 * CONTENT_WIDTH) / SHEET_W;

// Section heights measured off the sheet.
const TITLE_H = 26;
const INFO_MIN_H = 82.7;
const ITEMS_HEADER_H = 26.6;
const TOTAL_ROW_H = 15;
const TERMS_TITLE_H = 18;
const TERM_ROW_MIN_H = 20;
const DECL_BANK_MIN_H = 66;
const SIGNATURE_H = 84;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getDate()).padStart(2, "0")}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

function formatMoney(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Rows of the Terms & Condition table. `label` null = a free-text line that
 * spans the whole row. Order and labels follow the sheet; a row is only
 * printed when there is something to say (GST always is). */
function buildTermsRows(document: DocumentRecord, company: Company, items: DocumentItem[]): { label: string | null; value: string }[] {
  const text = (document.terms_and_conditions || company.terms_and_conditions || "").trim();
  const parsed = text
    .split("\n")
    .map((l) => l.trim().replace(/^(\d+[.)]|[-•*])\s*/, ""))
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^([^:]{2,40}):\s*(.+)$/);
      return { label: m ? m[1].trim() : null, value: m ? m[2].trim() : line, used: false };
    });

  // A labelled line in the saved terms text ("Offer Valid: 10 days ...") fills
  // the matching sheet row when the document has no dedicated field for it.
  const fromText = (re: RegExp): string => {
    const hit = parsed.find((p) => !p.used && p.label && re.test(p.label));
    if (!hit) return "";
    hit.used = true;
    return hit.value;
  };

  const rates = Array.from(new Set(items.map((i) => Number(i.tax_rate)).filter((r) => r > 0))).sort((a, b) => a - b);
  const gst = rates.length ? `${rates.join("% / ")}% GST Extra` : "Not applicable";

  const rows: { label: string | null; value: string }[] = [
    { label: "Offer Valid", value: fromText(/valid/i) },
    { label: "Payment Terms :", value: document.mode_terms_of_payment || document.credit_period || fromText(/payment/i) },
    { label: "Delivery Period:", value: document.terms_of_delivery || fromText(/deliver/i) },
    { label: "GST:", value: gst },
    { label: "Packing and forwarding:", value: fromText(/packing|forward/i) },
  ].filter((r) => r.value);

  for (const p of parsed) if (!p.used) rows.push({ label: p.label, value: p.value });
  return rows;
}

export function streamClassicQuotationPdf(
  res: Response,
  title: string,
  document: DocumentRecord,
  items: DocumentItem[],
  customer: Customer,
  company: Company,
  template: EffectiveDocumentTemplate
) {
  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${document.doc_number.replace(/\//g, "-")}.pdf"`);
  doc.pipe(res);

  const ACCENT = template.accentColor;
  const state = { y: PAGE_MARGIN };

  const subtotal = Number(document.subtotal);
  const discountAmount = Number(document.discount_amount);
  const freightCharges = Number(document.freight_charges);
  const installationCharges = Number(document.installation_charges);
  const cgstTotal = Number(document.cgst_total);
  const sgstTotal = Number(document.sgst_total);
  const igstTotal = Number(document.igst_total);
  const roundOff = Number(document.round_off);
  const grandTotal = Number(document.grand_total);
  const isInterState = igstTotal > 0;

  // ---- drawing helpers (always pass an explicit width to text(): without one
  // pdfkit doesn't advance its own cursor, and nothing here relies on doc.y) ----
  function rect(x: number, y: number, w: number, h: number) {
    doc.lineWidth(0.9).strokeColor(INK).rect(x, y, w, h).stroke();
  }
  function hLine(x1: number, x2: number, y: number) {
    doc.lineWidth(0.9).strokeColor(INK).moveTo(x1, y).lineTo(x2, y).stroke();
  }
  function vLine(x: number, y1: number, y2: number) {
    doc.lineWidth(0.9).strokeColor(INK).moveTo(x, y1).lineTo(x, y2).stroke();
  }
  function text(
    str: string,
    x: number,
    y: number,
    width: number,
    opts: { align?: "left" | "right" | "center"; bold?: boolean; size?: number; color?: string; italic?: boolean } = {}
  ) {
    doc
      .font(opts.bold ? "Helvetica-Bold" : opts.italic ? "Helvetica-Oblique" : "Helvetica")
      .fontSize(opts.size ?? 9.5)
      .fillColor(opts.color ?? INK)
      .text(str, x, y, { width, align: opts.align ?? "left" });
  }
  function measure(str: string, width: number, size: number, bold = false): number {
    return doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).heightOfString(str, { width });
  }
  /** Single line of text vertically centred in a cell of height h. */
  function cellText(str: string, x: number, top: number, w: number, h: number, opts: Parameters<typeof text>[4] = {}) {
    text(str, x, top + (h - (opts.size ?? 9.5)) / 2, w, opts);
  }

  function newPage() {
    doc.addPage();
    state.y = PAGE_MARGIN;
  }

  // ============================================================
  // Letterhead + title band (redesigned - see file header)
  // ============================================================
  function drawHeader() {
    const top = state.y;
    const innerW = CONTENT_WIDTH - 40;
    const name = company.name.toUpperCase();

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
    const startX = CONTENT_LEFT + (CONTENT_WIDTH - groupW) / 2;
    const rowTop = top + 12;

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
    text(name, startX + (iconW ? iconW + 12 : 0), rowTop + (iconH - nameSize) / 2 - 1, nameW + 4, { bold: true, size: nameSize, color: ACCENT });

    let cy = rowTop + iconH + 8;
    const centered = (str: string, size: number, opts: { italic?: boolean; bold?: boolean } = {}) => {
      const h = measure(str, innerW, size, opts.bold);
      text(str, CONTENT_LEFT + 20, cy, innerW, { align: "center", size, color: MUTED, ...opts });
      cy += h + 3;
    };
    if (company.tagline) centered(company.tagline, 9, { italic: true });
    if (company.address) centered(company.address, 9.5);
    const contact = [company.phone ? `Phone : ${company.phone}` : "", company.email ? `Email : ${company.email}` : ""].filter(Boolean).join("     |     ");
    if (contact) centered(contact, 9.5);
    const ids = [company.gstin ? `GSTIN : ${company.gstin}` : "", company.state ? `State : ${company.state}` : ""].filter(Boolean).join("     |     ");
    if (ids) centered(ids, 9.5, { bold: true });

    const headerH = Math.max(112, cy - top + 8);
    rect(CONTENT_LEFT, top, CONTENT_WIDTH, headerH);

    // Title band
    const bandTop = top + headerH;
    rect(CONTENT_LEFT, bandTop, CONTENT_WIDTH, TITLE_H);
    cellText(title.toUpperCase(), CONTENT_LEFT, bandTop, CONTENT_WIDTH, TITLE_H, { align: "center", bold: true, size: 14, color: ACCENT });
    if (template.headerLabel) {
      cellText(template.headerLabel, CONTENT_LEFT, bandTop, CONTENT_WIDTH - 10, TITLE_H, { align: "right", italic: true, size: 8.5, color: MUTED });
    }
    state.y = bandTop + TITLE_H;
  }

  // ============================================================
  // Buyer block (left) + Date / Number / Reference (right)
  // ============================================================
  function drawInfo() {
    const top = state.y;
    const leftW = SPLIT_X - CONTENT_LEFT;
    const pad = 7;
    const innerW = leftW - pad * 2;

    let ly = top + 6;
    text("Buyer :", CONTENT_LEFT + pad, ly, innerW, { bold: true, size: 14 });
    ly += 21;
    text(customer.name, CONTENT_LEFT + pad, ly, innerW, { bold: true, size: 11.5 });
    ly += measure(customer.name, innerW, 11.5, true) + 4;
    for (const line of [customer.billing_address, customer.state ? `State : ${customer.state}` : ""].filter(Boolean) as string[]) {
      text(line, CONTENT_LEFT + pad, ly, innerW, { size: 9.5, color: MUTED });
      ly += measure(line, innerW, 9.5) + 3;
    }
    const h = Math.max(INFO_MIN_H, ly - top + 26);
    rect(CONTENT_LEFT, top, CONTENT_WIDTH, h);
    vLine(SPLIT_X, top, top + h);
    text(`GSTIN : ${customer.gstin || ""}`, CONTENT_LEFT + pad, top + h - 20, innerW, { size: 9.5 });

    // Right block: label | value, three equal rows.
    const valueX = COLS.rate.x;
    vLine(valueX, top, top + h);
    const rows: [string, string][] = [
      ["Date:", formatDate(document.issue_date)],
      [`${title} No.:`, document.doc_number],
      ["Other Reference:", document.other_reference || ""],
    ];
    const rowH = h / rows.length;
    rows.forEach(([label, value], i) => {
      const y = top + i * rowH;
      if (i > 0) hLine(SPLIT_X, CONTENT_RIGHT, y);
      cellText(label, SPLIT_X + 7, y, COLS.qty.width - 10, rowH, { bold: true, size: 9.5 });
      cellText(value, valueX, y, CONTENT_RIGHT - valueX, rowH, { align: "center", bold: i === 0, size: 10 });
    });
    state.y = top + h;
  }

  // ============================================================
  // Items table
  // ============================================================
  function drawItemsHeader() {
    const top = state.y;
    rect(CONTENT_LEFT, top, CONTENT_WIDTH, ITEMS_HEADER_H);
    (["desc", "qty", "rate", "amount"] as const).forEach((k) => vLine(COLS[k].x, top, top + ITEMS_HEADER_H));
    const opts = { align: "center" as const, bold: true, size: 10 };
    cellText("SN.No", COLS.sno.x, top, COLS.sno.width, ITEMS_HEADER_H, { ...opts, size: 8.5 });
    cellText("DESCRIPTION", COLS.desc.x, top, COLS.desc.width, ITEMS_HEADER_H, opts);
    cellText("Qty", COLS.qty.x, top, COLS.qty.width, ITEMS_HEADER_H, opts);
    cellText("Rate", COLS.rate.x, top, COLS.rate.width, ITEMS_HEADER_H, opts);
    cellText("Amount", COLS.amount.x, top, COLS.amount.width, ITEMS_HEADER_H, opts);
    state.y = top + ITEMS_HEADER_H;
  }

  const descW = COLS.desc.width - 14;
  const rowHeights = items.map((it) => Math.max(22, measure(it.description, descW, 9.5) + 14));

  function drawItemRows(from: number, to: number, top: number) {
    let y = top;
    for (let i = from; i < to; i++) {
      const it = items[i];
      const base = it.qty * it.rate;
      const lineTaxable = base - (base * (it.discount_percent || 0)) / 100;
      const ty = y + 7;
      text(`${i + 1}.`, COLS.sno.x, ty, COLS.sno.width, { align: "center" });
      text(it.description, COLS.desc.x + 7, ty, descW);
      text(`${it.qty} ${it.unit}`, COLS.qty.x, ty, COLS.qty.width, { align: "center" });
      text(formatMoney(it.rate), COLS.rate.x, ty, COLS.rate.width - 6, { align: "right" });
      text(formatMoney(lineTaxable), COLS.amount.x, ty, COLS.amount.width - 6, { align: "right" });
      y += rowHeights[i];
    }
  }

  // ---- everything that follows the item rows on the last page ----
  type TotalLine = { label: string; value: string; bold?: boolean };
  const totalLines: TotalLine[] = [{ label: "Total", value: formatMoney(subtotal) }];
  if (discountAmount) totalLines.push({ label: "Discount", value: `-${formatMoney(discountAmount)}` });
  totalLines.push({ label: "Transport", value: freightCharges ? formatMoney(freightCharges) : "" });
  totalLines.push({ label: "Installation", value: installationCharges ? formatMoney(installationCharges) : "" });
  if (isInterState) {
    if (igstTotal) totalLines.push({ label: "IGST", value: formatMoney(igstTotal) });
  } else {
    if (cgstTotal) totalLines.push({ label: "CGST", value: formatMoney(cgstTotal) });
    if (sgstTotal) totalLines.push({ label: "SGST", value: formatMoney(sgstTotal) });
  }
  if (roundOff) totalLines.push({ label: "Round Off", value: formatMoney(roundOff) });
  totalLines.push({ label: "Grand Total", value: formatMoney(grandTotal), bold: true });
  const totalsH = totalLines.length * TOTAL_ROW_H;

  const termsRows = buildTermsRows(document, company, items);
  const termValueW = CONTENT_WIDTH - TERMS_LABEL_W - 16;
  const termRowHeights = termsRows.map((r) =>
    Math.max(
      TERM_ROW_MIN_H,
      measure(r.value, r.label ? termValueW : CONTENT_WIDTH - 16, 9.5) + 10,
      // A long label wraps inside its narrow column and needs the room too.
      r.label ? measure(r.label, TERMS_LABEL_W - 8, 9.5, true) + 10 : 0
    )
  );
  const termsH = TERMS_TITLE_H + termRowHeights.reduce((a, b) => a + b, 0);

  const declaration = `We declare that this ${title.toLowerCase()} shows the actual price of the goods described and that all particulars are true and correct.`;
  const bankRows: [string, string][] = template.showBankDetails
    ? ((
        [
          ["Bank Name :", company.bank_name],
          ["Account Number:", company.bank_account_no],
          ["IFSC Code:", company.bank_ifsc],
        ] as [string, string | null][]
      ).filter(([, v]) => v) as [string, string][])
    : [];
  const declW = template.showBankDetails ? SPLIT_X - CONTENT_LEFT : CONTENT_WIDTH;
  const declBankH = Math.max(DECL_BANK_MIN_H, 22 + measure(declaration, declW - 16, 9.5) + 10, 22 + bankRows.length * 16 + 8);
  const signatureH = template.showSignatureBlock ? SIGNATURE_H : 0;
  const footerH = totalsH + termsH + declBankH + signatureH;

  function drawFooter(top: number) {
    let y = top;

    // Totals: label under the Rate column, value under Amount; the wide blank
    // area to their left keeps just the outer border, like the sheet.
    vLine(CONTENT_LEFT, y, y + totalsH);
    totalLines.forEach((line) => {
      rect(COLS.rate.x, y, CONTENT_RIGHT - COLS.rate.x, TOTAL_ROW_H);
      vLine(COLS.amount.x, y, y + TOTAL_ROW_H);
      cellText(line.label, COLS.rate.x, y, COLS.rate.width, TOTAL_ROW_H, { align: "center", bold: line.bold, size: 9 });
      cellText(line.value, COLS.amount.x, y, COLS.amount.width - 6, TOTAL_ROW_H, { align: "right", bold: line.bold, size: 9 });
      y += TOTAL_ROW_H;
    });
    hLine(CONTENT_LEFT, COLS.rate.x, y);

    // Terms & Condition
    rect(CONTENT_LEFT, y, CONTENT_WIDTH, TERMS_TITLE_H);
    vLine(CONTENT_LEFT + TERMS_LABEL_W, y, y + TERMS_TITLE_H);
    cellText("Terms & Condition", CONTENT_LEFT, y, TERMS_LABEL_W, TERMS_TITLE_H, { align: "center", bold: true, size: 9.5 });
    y += TERMS_TITLE_H;
    termsRows.forEach((r, i) => {
      const h = termRowHeights[i];
      rect(CONTENT_LEFT, y, CONTENT_WIDTH, h);
      if (r.label) {
        vLine(CONTENT_LEFT + TERMS_LABEL_W, y, y + h);
        text(r.label, CONTENT_LEFT + 4, y + (h - measure(r.label, TERMS_LABEL_W - 8, 9.5, true)) / 2, TERMS_LABEL_W - 8, {
          align: "center",
          bold: true,
        });
        text(r.value, CONTENT_LEFT + TERMS_LABEL_W + 8, y + (h - measure(r.value, termValueW, 9.5)) / 2, termValueW);
      } else {
        text(r.value, CONTENT_LEFT + 8, y + (h - measure(r.value, CONTENT_WIDTH - 16, 9.5)) / 2, CONTENT_WIDTH - 16);
      }
      y += h;
    });

    // Declaration | Company's Bank Details
    rect(CONTENT_LEFT, y, CONTENT_WIDTH, declBankH);
    if (template.showBankDetails) vLine(SPLIT_X, y, y + declBankH);
    text("Declaration:", CONTENT_LEFT, y + 6, declW, { align: "center", bold: true });
    text(declaration, CONTENT_LEFT + 8, y + 24, declW - 16, { align: "center" });
    if (template.showBankDetails) {
      const bw = CONTENT_RIGHT - SPLIT_X;
      text("Company's Bank Details", SPLIT_X, y + 6, bw, { align: "center", bold: true });
      hLine(SPLIT_X, CONTENT_RIGHT, y + 21);
      let by = y + 27;
      const valueX = SPLIT_X + 100;
      for (const [label, value] of bankRows) {
        text(label, SPLIT_X + 8, by, 92, { color: MUTED });
        text(value, valueX, by, CONTENT_RIGHT - valueX - 6, { bold: true });
        by += 16;
      }
    }
    y += declBankH;

    // Signature row
    if (template.showSignatureBlock) {
      rect(CONTENT_LEFT, y, CONTENT_WIDTH, SIGNATURE_H);
      vLine(SPLIT_X, y, y + SIGNATURE_H);
      text("Customer's Seal and Signature", CONTENT_LEFT + 7, y + 6, SPLIT_X - CONTENT_LEFT - 14, { bold: true });
      hLine(CONTENT_LEFT, SPLIT_X, y + 21);
      text("Authorized Signatory", SPLIT_X, y + 6, CONTENT_RIGHT - SPLIT_X, { align: "center", bold: true });
      y += SIGNATURE_H;
    }
    return y;
  }

  // ============================================================
  // Layout: header, info, then the items table paginated so the last page
  // always ends with the footer sections flush to the bottom.
  // ============================================================
  drawHeader();
  drawInfo();
  drawItemsHeader();

  const MIN_GAP = 8;
  let idx = 0;
  let avail = BOTTOM_LIMIT - state.y;
  for (;;) {
    const remaining = rowHeights.slice(idx).reduce((a, b) => a + b, 0);
    if (remaining + MIN_GAP <= avail - footerH) {
      // Last page: the items box stretches so the footer ends at the bottom edge.
      const bodyH = avail - footerH;
      rect(CONTENT_LEFT, state.y, CONTENT_WIDTH, bodyH);
      (["desc", "qty", "rate", "amount"] as const).forEach((k) => vLine(COLS[k].x, state.y, state.y + bodyH));
      drawItemRows(idx, items.length, state.y);
      drawFooter(state.y + bodyH);
      break;
    }
    // Not the last page: take rows while they fit, extend the box to the page bottom.
    let take = 0;
    let sum = 0;
    while (idx + take < items.length && sum + rowHeights[idx + take] <= avail) {
      sum += rowHeights[idx + take];
      take++;
    }
    if (idx + take >= items.length) take = Math.max(take - 1, 0); // never leave the footer alone on a page
    if (take === 0 && idx < items.length) take = 1; // a single over-tall row still has to go somewhere
    const bodyH = avail;
    rect(CONTENT_LEFT, state.y, CONTENT_WIDTH, bodyH);
    (["desc", "qty", "rate", "amount"] as const).forEach((k) => vLine(COLS[k].x, state.y, state.y + bodyH));
    drawItemRows(idx, idx + take, state.y);
    idx += take;
    newPage();
    drawItemsHeader();
    avail = BOTTOM_LIMIT - state.y;
  }

  // ---- Per-page footer note + page numbers ----
  const pageRange = doc.bufferedPageRange();
  for (let i = 0; i < pageRange.count; i++) {
    doc.switchToPage(pageRange.start + i);
    const originalBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const footerY = PAGE_HEIGHT - PAGE_MARGIN + 4;
    text(template.footerNote, CONTENT_LEFT, footerY, CONTENT_WIDTH / 2, { size: 7, color: MUTED });
    text(`Page ${i + 1} of ${pageRange.count}`, CONTENT_LEFT + CONTENT_WIDTH / 2, footerY, CONTENT_WIDTH / 2, {
      align: "right",
      size: 7,
      color: MUTED,
    });
    doc.page.margins.bottom = originalBottomMargin;
  }

  doc.end();
}
