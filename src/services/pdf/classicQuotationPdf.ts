import PDFDocument from "pdfkit";
import { Response } from "express";
import { Company, Customer, DocumentItem, DocumentRecord } from "../../types";
import { EffectiveDocumentTemplate } from "../documentTemplates";
import { drawLetterhead } from "./letterhead";

// Two of the client's own Excel sheets share this one renderer, because they
// are the same sheet apart from the item table:
//
//  * "quotation" (QuotationTemplate.xlsx): SN.No | DESCRIPTION | Qty | Rate |
//    Amount, item rows drawn without inner grid lines.
//  * "measured" (InvoiceTemplate.xlsx, used for invoices billed by area):
//    SN.No | DESCRIPTION | Height | Length | QTY | SqFt/Area | Rate | Amount,
//    every row gridded, group headings (a numbered row with no amounts, tinted)
//    with un-numbered sub-lines under them.
//
// Both then continue identically: a Total / (Transport, GST) / Grand Total
// block under the Rate and Amount columns, a "Terms & Condition" table,
// Declaration beside Company's Bank Details, and a signature row. Proportions
// come from measuring the sheets rendered to PDF. The header is the shared
// letterhead (see letterhead.ts) instead of the sheets' own clipped one.
//
// The items area is a tall FLEXIBLE box that fills whatever page height is
// left after the fixed-size sections, so a short document still fills the A4
// page the way the sheets do, and long ones paginate (column header repeated)
// with the footer sections flush to the bottom of the last page.

export type SheetVariant = "quotation" | "measured";

const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const PAGE_MARGIN = 38;
const CONTENT_LEFT = PAGE_MARGIN;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const CONTENT_RIGHT = CONTENT_LEFT + CONTENT_WIDTH;
const BOTTOM_LIMIT = PAGE_HEIGHT - PAGE_MARGIN - 8;

const INK = "#000000";
const MUTED = "#444444";
const HEADING_TINT = "#FFF3B0"; // the measured sheet highlights group headings yellow

// Column proportions measured off each sheet (in the sheet's own units),
// rescaled to this page's content width.
const SHEET_COLS: Record<SheetVariant, Record<string, number>> = {
  quotation: { sno: 45.5, desc: 254.2, qty: 92.7, rate: 73.7, amount: 74.9 },
  measured: { sno: 35.2, desc: 289.4, height: 59.3, length: 57, pieces: 53.8, area: 101.5, rate: 66.2, amount: 84 },
};

type Col = { x: number; width: number };

function buildCols(variant: SheetVariant): Record<string, Col> {
  const src = SHEET_COLS[variant];
  const total = Object.values(src).reduce((a, b) => a + b, 0);
  const keys = Object.keys(src);
  const out: Record<string, Col> = {};
  let x = CONTENT_LEFT;
  keys.forEach((k, i) => {
    const width = i === keys.length - 1 ? CONTENT_RIGHT - x : (src[k] * CONTENT_WIDTH) / total;
    out[k] = { x, width };
    x += width;
  });
  return out;
}

// Section heights measured off the sheets.
const INFO_MIN_H = 82.7;
const ITEMS_HEADER_H = 26.6;
const TOTAL_ROW_H = 15;
const TERMS_TITLE_H = 18;
const TERM_ROW_MIN_H = 20;
const DECL_BANK_MIN_H = 66;
const SIGNATURE_H = 84;
const TERMS_LABEL_W = (104.5 * CONTENT_WIDTH) / 541;

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

/** A dimension/area figure: up to `max` decimals, trailing zeros trimmed
 * (26.125 stays 26.125, 33.64 stays 33.64, 10.50 becomes 10.5). */
function trimNumber(n: number, max = 3): string {
  return String(Number(n.toFixed(max)));
}

function hasValue(v: unknown): boolean {
  return v !== null && v !== undefined && Number(v) > 0;
}

/** Rows of the Terms & Condition table. `label` null = a free-text line that
 * spans the whole row. Order and labels follow the sheets; a row is only
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

  const rates = Array.from(new Set(items.filter((i) => i.line_kind !== "heading").map((i) => Number(i.tax_rate)).filter((r) => r > 0))).sort((a, b) => a - b);
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

function streamSheetPdf(
  variant: SheetVariant,
  res: Response,
  title: string,
  document: DocumentRecord,
  items: DocumentItem[],
  customer: Customer,
  company: Company,
  template: EffectiveDocumentTemplate
) {
  const measured = variant === "measured";
  const COLS = buildCols(variant);
  // The left | right divider of the Buyer / Declaration / Signature blocks, and
  // where the right-hand block's value column starts.
  const SPLIT_X = measured ? COLS.pieces.x : COLS.qty.x;
  const INFO_VALUE_X = COLS.rate.x;
  // Where the totals block's label cell starts: the measured sheet's Rate column
  // is too narrow for "Grand Total", so its labels span SqFt/Area + Rate.
  const TOTALS_LABEL_X = measured ? COLS.area.x : COLS.rate.x;
  const dividerKeys = Object.keys(COLS).slice(1); // every column edge except the table's left edge

  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${document.doc_number.replace(/\//g, "-")}.pdf"`);
  doc.pipe(res);

  const state = { y: PAGE_MARGIN };

  const subtotal = Number(document.subtotal);
  const discountAmount = Number(document.discount_amount);
  const freightCharges = Number(document.freight_charges);
  const installationCharges = Number(document.installation_charges);
  const cgstTotal = Number(document.cgst_total);
  const sgstTotal = Number(document.sgst_total);
  const igstTotal = Number(document.igst_total);
  const taxTotal = Number(document.tax_total);
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
  function fillRect(x: number, y: number, w: number, h: number, color: string) {
    doc.save().rect(x, y, w, h).fill(color).restore();
  }

  function newPage() {
    doc.addPage();
    state.y = PAGE_MARGIN;
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
    vLine(INFO_VALUE_X, top, top + h);
    const rows: [string, string][] = [
      ["Date:", formatDate(document.issue_date)],
      [`${title} No.:`, document.doc_number],
      ["Other Reference:", document.other_reference || ""],
    ];
    const rowH = h / rows.length;
    rows.forEach(([label, value], i) => {
      const y = top + i * rowH;
      if (i > 0) hLine(SPLIT_X, CONTENT_RIGHT, y);
      cellText(label, SPLIT_X + 7, y, INFO_VALUE_X - SPLIT_X - 10, rowH, { bold: true, size: 9.5 });
      cellText(value, INFO_VALUE_X, y, CONTENT_RIGHT - INFO_VALUE_X, rowH, { align: "center", bold: i === 0, size: 10 });
    });
    state.y = top + h;
  }

  // ============================================================
  // Items table
  // ============================================================
  function drawItemsHeader() {
    const top = state.y;
    rect(CONTENT_LEFT, top, CONTENT_WIDTH, ITEMS_HEADER_H);
    dividerKeys.forEach((k) => vLine(COLS[k].x, top, top + ITEMS_HEADER_H));
    const opts = { align: "center" as const, bold: true, size: measured ? 9 : 10 };
    const labels: Record<string, string> = measured
      ? { sno: "S.No", desc: "DESCRIPTION", height: "Height", length: "Length", pieces: "QTY", area: "SqFt/Area", rate: "Rate", amount: "Amount" }
      : { sno: "SN.No", desc: "DESCRIPTION", qty: "Qty", rate: "Rate", amount: "Amount" };
    Object.keys(COLS).forEach((k) => {
      cellText(labels[k], COLS[k].x, top, COLS[k].width, ITEMS_HEADER_H, k === "sno" ? { ...opts, size: measured ? 7.5 : 8.5 } : opts);
    });
    state.y = top + ITEMS_HEADER_H;
  }

  const descPad = 7;
  const descW = COLS.desc.width - descPad * 2;
  const rowHeights = items.map((it) => {
    const size = measured ? 9 : 9.5;
    const extra = measured ? 8 : 14;
    const h = measure(it.description, descW - (it.line_kind === "sub" ? 8 : 0), size, it.line_kind === "heading") + extra;
    return Math.max(measured ? 19 : 22, h);
  });

  // Serial numbers: numbered rows ("item" and "heading") count up; "sub" lines
  // under a heading stay un-numbered. The quotation sheet numbers everything.
  const serials: (string | null)[] = [];
  {
    let n = 0;
    for (const it of items) {
      if (measured && it.line_kind === "sub") serials.push(null);
      else serials.push(measured ? `${String(++n).padStart(2, "0")}.` : `${++n}.`);
    }
  }

  function drawItemRows(from: number, to: number, top: number) {
    let y = top;
    for (let i = from; i < to; i++) {
      const it = items[i];
      const h = rowHeights[i];
      const isHeading = it.line_kind === "heading";
      const base = it.qty * it.rate;
      const lineTaxable = base - (base * (it.discount_percent || 0)) / 100;

      if (measured) {
        if (isHeading) fillRect(COLS.desc.x, y, CONTENT_RIGHT - COLS.desc.x, h, HEADING_TINT);
        // Every row of the measured sheet is gridded.
        rect(CONTENT_LEFT, y, CONTENT_WIDTH, h);
        dividerKeys.forEach((k) => vLine(COLS[k].x, y, y + h));
      }
      const ty = y + (measured ? 5 : 7);
      const size = measured ? 9 : 9.5;
      if (serials[i]) text(serials[i]!, COLS.sno.x, ty, COLS.sno.width, { align: "center", size });
      const sub = it.line_kind === "sub";
      text(it.description, COLS.desc.x + descPad + (sub ? 8 : 0), ty, descW - (sub ? 8 : 0), { size, bold: isHeading });

      if (!isHeading) {
        if (measured) {
          const hasDims = hasValue(it.height) && hasValue(it.length);
          if (hasDims) {
            text(Number(it.height).toFixed(2), COLS.height.x, ty, COLS.height.width, { align: "center", size });
            text(Number(it.length).toFixed(2), COLS.length.x, ty, COLS.length.width, { align: "center", size });
            text(trimNumber(Number(it.pieces) || 1, 2), COLS.pieces.x, ty, COLS.pieces.width, { align: "center", size });
            text(trimNumber(it.qty), COLS.area.x, ty, COLS.area.width, { align: "center", size });
          } else {
            // A plain quantity line on a measured invoice: no dimensions to show.
            text(`${trimNumber(it.qty, 2)} ${it.unit}`, COLS.pieces.x - 12, ty, COLS.pieces.width + 24, { align: "center", size: 8.5 });
          }
          text(formatMoney(it.rate), COLS.rate.x, ty, COLS.rate.width - 6, { align: "center", size });
          text(formatMoney(lineTaxable), COLS.amount.x, ty, COLS.amount.width - 5, { align: "right", size });
        } else {
          text(`${trimNumber(it.qty, 2)} ${it.unit}`, COLS.qty.x, ty, COLS.qty.width, { align: "center", size });
          text(formatMoney(it.rate), COLS.rate.x, ty, COLS.rate.width - 6, { align: "right", size });
          text(formatMoney(lineTaxable), COLS.amount.x, ty, COLS.amount.width - 6, { align: "right", size });
        }
      }
      y += h;
    }
  }

  // ---- everything that follows the item rows on the last page ----
  type TotalLine = { label: string; value: string; bold?: boolean };
  const gstRates = Array.from(new Set(items.filter((i) => i.line_kind !== "heading").map((i) => Number(i.tax_rate)).filter((r) => r > 0)));
  const totalLines: TotalLine[] = [{ label: "Total", value: formatMoney(subtotal) }];
  if (discountAmount) totalLines.push({ label: "Discount", value: `-${formatMoney(discountAmount)}` });
  if (measured) {
    // The invoice sheet shows a single GST row; the CGST/SGST/IGST split is
    // implied by the state details above.
    if (taxTotal) totalLines.push({ label: gstRates.length === 1 ? `GST ${gstRates[0]}%` : "GST", value: formatMoney(taxTotal) });
    totalLines.push({ label: "Transport", value: freightCharges ? formatMoney(freightCharges) : "" });
    if (installationCharges) totalLines.push({ label: "Installation", value: formatMoney(installationCharges) });
  } else {
    totalLines.push({ label: "Transport", value: freightCharges ? formatMoney(freightCharges) : "" });
    totalLines.push({ label: "Installation", value: installationCharges ? formatMoney(installationCharges) : "" });
    if (isInterState) {
      if (igstTotal) totalLines.push({ label: "IGST", value: formatMoney(igstTotal) });
    } else {
      if (cgstTotal) totalLines.push({ label: "CGST", value: formatMoney(cgstTotal) });
      if (sgstTotal) totalLines.push({ label: "SGST", value: formatMoney(sgstTotal) });
    }
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
    // area to their left keeps just the outer border, like the sheets.
    vLine(CONTENT_LEFT, y, y + totalsH);
    totalLines.forEach((line) => {
      rect(TOTALS_LABEL_X, y, CONTENT_RIGHT - TOTALS_LABEL_X, TOTAL_ROW_H);
      vLine(COLS.amount.x, y, y + TOTAL_ROW_H);
      cellText(line.label, TOTALS_LABEL_X, y, COLS.amount.x - TOTALS_LABEL_X, TOTAL_ROW_H, { align: "center", bold: line.bold, size: 9 });
      cellText(line.value, COLS.amount.x, y, COLS.amount.width - 5, TOTAL_ROW_H, { align: "right", bold: line.bold, size: 9 });
      y += TOTAL_ROW_H;
    });
    hLine(CONTENT_LEFT, TOTALS_LABEL_X, y);

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
  // Layout: letterhead, info, then the items table paginated so the last page
  // always ends with the footer sections flush to the bottom.
  // ============================================================
  state.y = drawLetterhead(doc, { company, template, title, left: CONTENT_LEFT, width: CONTENT_WIDTH, top: state.y, minHeight: 112 });
  drawInfo();
  drawItemsHeader();

  const drawBodyBox = (top: number, h: number) => {
    rect(CONTENT_LEFT, top, CONTENT_WIDTH, h);
    dividerKeys.forEach((k) => vLine(COLS[k].x, top, top + h));
  };

  const MIN_GAP = 8;
  let idx = 0;
  let avail = BOTTOM_LIMIT - state.y;
  for (;;) {
    const remaining = rowHeights.slice(idx).reduce((a, b) => a + b, 0);
    if (remaining + MIN_GAP <= avail - footerH) {
      // Last page: the items box stretches so the footer ends at the bottom edge.
      const bodyH = avail - footerH;
      drawBodyBox(state.y, bodyH);
      drawItemRows(idx, items.length, state.y);
      drawFooter(state.y + bodyH);
      break;
    }
    // All rows fit on this page but the footer sections do not: keep the rows
    // together here and start the footer on the next page, rather than
    // dragging one lonely row over to a page that is otherwise empty.
    if (remaining <= avail) {
      drawBodyBox(state.y, avail);
      drawItemRows(idx, items.length, state.y);
      newPage();
      drawFooter(state.y);
      break;
    }
    // Not the last page: take rows while they fit, extend the box to the page bottom.
    let take = 0;
    let sum = 0;
    while (idx + take < items.length && sum + rowHeights[idx + take] <= avail) {
      sum += rowHeights[idx + take];
      take++;
    }
    if (take === 0 && idx < items.length) take = 1; // a single over-tall row still has to go somewhere
    drawBodyBox(state.y, avail);
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

export function streamClassicQuotationPdf(
  res: Response,
  title: string,
  document: DocumentRecord,
  items: DocumentItem[],
  customer: Customer,
  company: Company,
  template: EffectiveDocumentTemplate
) {
  streamSheetPdf("quotation", res, title, document, items, customer, company, template);
}

export function streamClassicMeasuredPdf(
  res: Response,
  title: string,
  document: DocumentRecord,
  items: DocumentItem[],
  customer: Customer,
  company: Company,
  template: EffectiveDocumentTemplate
) {
  streamSheetPdf("measured", res, title, document, items, customer, company, template);
}
