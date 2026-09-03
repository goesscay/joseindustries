import PDFDocument from "pdfkit";
import { Response } from "express";
import { Company, Customer, DocumentItem, DocumentRecord } from "../../types";
import { amountInWords } from "../../utils/numberToWords";
import { EffectiveDocumentTemplate } from "../documentTemplates";

// "classic_gst" style - a Tally-style Indian GST Tax Invoice format, built to
// reproduce a customer-supplied sample (068 Unilink.pdf/.xlsx) EXACTLY - not
// just its field set, but its geometry: every major section below uses a
// FIXED height/row-count measured directly off that sample (via pdfplumber
// word/rect extraction), the same way the sample itself does as an
// Excel-to-PDF export. This is deliberate and load-bearing: the sample's
// item table stays a tall, mostly-blank box even for a single line item,
// with CGST/SGST/Total bottom-anchored near its bottom edge - it is NOT
// sized to its content. An earlier version of this file auto-sized every
// section to its actual content, which collapsed the whole invoice into the
// top third of the page for a typical 1-2 item document - visually nothing
// like the sample. Do not reintroduce content-based auto-sizing for these
// fixed sections; grow only as a last-resort safety net when real content
// (many items, a very long address) would otherwise overflow.
//
// Entirely monochrome (no accent color) and never shows a logo image,
// matching the sample exactly - see documentTemplates.ts's TEMPLATE_STYLES
// doc comment. Parameterized by `title` the same way streamDocumentPdf is,
// so one file covers Quotation/Proforma Invoice/Delivery Challan/Tax
// Invoice.

const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
// The sample's own outer border sits at x:38.2-554.7 (a 516.5pt-wide content
// area) on a 595.28pt-wide page - reproduced verbatim so every column width
// below (lifted straight from the sample's measured rects) lines up exactly
// without needing to rescale anything.
const CONTENT_LEFT = 38;
const CONTENT_WIDTH = 516.5;
const CONTENT_RIGHT = CONTENT_LEFT + CONTENT_WIDTH;
const PAGE_MARGIN = CONTENT_LEFT;
// The sample's own content runs to y=793.3 out of an 841.89pt-tall page (a
// ~48.6pt bottom margin, mostly consumed by its footer) - reproduced with
// the same intent: leave only enough room below BOTTOM_LIMIT for this
// renderer's own small one-line footer, not a full margin's worth of
// buffer, or the fixed-height sections above (which sum to just under a
// full page by design) spill onto an unwanted second page.
const BOTTOM_LIMIT = PAGE_HEIGHT - PAGE_MARGIN - 8;

const INK = "#000000";
const MUTED = "#444444";

// A recurring ~15.2pt base line unit runs through the whole sample (visible
// in both the header columns' line spacing and every table row height) -
// the natural result of an Excel row-height export. Reused here wherever
// the sample doesn't call for a taller reserved row.
const LINE_H = 15.2;

function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(d.getDate()).padStart(2, "0")}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

function formatMoney(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface HsnGroup {
  hsn: string;
  taxRate: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
}

/** Groups line items by (HSN code, tax rate) and sums each group's
 * discount-reduced taxable value and tax split - the sample's "HSN-wise GST
 * breakdown" table is a genuinely different computation from the flat
 * totals block the "modern" style uses, not just a different layout. */
function groupByHsn(items: DocumentItem[], isInterState: boolean): HsnGroup[] {
  const groups = new Map<string, HsnGroup>();
  for (const item of items) {
    const key = `${item.hsn_code || "-"}::${item.tax_rate}`;
    const baseAmount = item.qty * item.rate;
    const taxableValue = baseAmount - (baseAmount * (item.discount_percent || 0)) / 100;
    const taxAmount = (taxableValue * item.tax_rate) / 100;
    const existing = groups.get(key);
    if (existing) {
      existing.taxableValue += taxableValue;
      if (isInterState) existing.igst += taxAmount;
      else {
        existing.cgst += taxAmount / 2;
        existing.sgst += taxAmount / 2;
      }
    } else {
      groups.set(key, {
        hsn: item.hsn_code || "-",
        taxRate: item.tax_rate,
        taxableValue,
        cgst: isInterState ? 0 : taxAmount / 2,
        sgst: isInterState ? 0 : taxAmount / 2,
        igst: isInterState ? taxAmount : 0,
      });
    }
  }
  return Array.from(groups.values());
}

export function streamClassicGstDocumentPdf(
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

  const state = { y: PAGE_MARGIN, page: 1 };

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

  function rect(x: number, y: number, w: number, h: number) {
    doc.lineWidth(0.75).strokeColor(INK).rect(x, y, w, h).stroke();
  }
  function hLine(x1: number, x2: number, y: number) {
    doc.lineWidth(0.75).strokeColor(INK).moveTo(x1, y).lineTo(x2, y).stroke();
  }
  function vLine(x: number, y1: number, y2: number) {
    doc.lineWidth(0.75).strokeColor(INK).moveTo(x, y1).lineTo(x, y2).stroke();
  }
  function text(
    str: string,
    x: number,
    y: number,
    opts: { width?: number; align?: "left" | "right" | "center"; bold?: boolean; size?: number; color?: string } = {}
  ) {
    doc
      .font(opts.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(opts.size ?? 8)
      .fillColor(opts.color ?? INK)
      .text(str, x, y, { width: opts.width, align: opts.align, lineBreak: opts.width !== undefined });
  }

  function newPage() {
    doc.addPage();
    state.page += 1;
    state.y = PAGE_MARGIN;
  }

  /** Returns true if a new page was started, so callers that need to
   * re-draw a repeating header (the item table's column header) know to. */
  function ensureSpace(height: number): boolean {
    if (state.y + height > BOTTOM_LIMIT) {
      newPage();
      return true;
    }
    return false;
  }

  // ============================================================
  // Section A: company / buyer / reference grid - one bordered box,
  // FIXED total height 225.4 (measured off the sample), split into a left
  // column (company block 116.1 + buyer block 109.3) and a right 7-row
  // reference grid (325.4 wide). All measurements below are the sample's
  // own, not derived from this document's content.
  // ============================================================
  const HEADER_H = 225.4;
  const HEADER_LEFT_W = 191.1;
  const HEADER_RIGHT_X = CONTENT_LEFT + HEADER_LEFT_W;
  const HEADER_RIGHT_W = CONTENT_WIDTH - HEADER_LEFT_W;
  const HEADER_RIGHT_COL_A_W = 158.8;
  const COMPANY_BLOCK_H = 116.1;
  const BUYER_BLOCK_H = 109.3;
  const GRID_ROW_H = [29.9, 30.4, 30.4, 25.4, 30.4, 37.7, 41.2]; // sums to 225.4

  function drawHeaderSection() {
    const pad = 6;
    ensureSpace(HEADER_H);
    const boxY = state.y;

    rect(CONTENT_LEFT, boxY, HEADER_LEFT_W, HEADER_H);
    rect(HEADER_RIGHT_X, boxY, HEADER_RIGHT_W, HEADER_H);
    hLine(CONTENT_LEFT, HEADER_RIGHT_X, boxY + COMPANY_BLOCK_H); // company/buyer divider

    // -- Left column: company block (fixed 116.1), then buyer block (109.3).
    // Text top-aligns within each fixed box at the sample's own LINE_H -
    // leftover space at the bottom is expected, not a bug (the sample does
    // the same for a short address).
    const addrLines = [company.address, company.gstin ? `GSTIN/UIN: ${company.gstin}` : null].filter(Boolean) as string[];
    const stateLine = [company.state ? `State: ${company.state}` : null, company.state_code ? `Code: ${company.state_code}` : null]
      .filter(Boolean)
      .join("   ");

    const innerW = HEADER_LEFT_W - pad * 2;
    let ly = boxY + 3;
    text(company.name, CONTENT_LEFT + pad, ly, { bold: true, size: 11, width: innerW });
    ly += LINE_H;
    doc.font("Helvetica").fontSize(7.8).fillColor(MUTED);
    for (const line of addrLines) {
      doc.text(line, CONTENT_LEFT + pad, ly, { width: innerW });
      // A wrapped line (a long address) needs more than one LINE_H of
      // room, or the next line crowds right into its second row.
      ly += Math.max(LINE_H, doc.heightOfString(line, { width: innerW }) + 3);
    }
    if (stateLine) {
      doc.text(stateLine, CONTENT_LEFT + pad, ly, { width: innerW });
      ly += LINE_H;
    }

    const buyerAddrLines = [
      customer.billing_address || "",
      customer.gstin ? `GSTIN/UIN: ${customer.gstin}` : "",
      customer.state ? `State: ${customer.state}` : "",
      document.place_of_supply ? `Place of Supply: ${document.place_of_supply}` : "",
    ].filter(Boolean);

    let by = boxY + COMPANY_BLOCK_H + 3;
    text("Buyer (Bill to)", CONTENT_LEFT + pad, by, { bold: true, size: 8, color: MUTED, width: HEADER_LEFT_W - pad * 2 });
    by += LINE_H;
    text(customer.name, CONTENT_LEFT + pad, by, { bold: true, size: 9.5, width: HEADER_LEFT_W - pad * 2 });
    by += LINE_H;
    doc.font("Helvetica").fontSize(7.8).fillColor(MUTED);
    for (const line of buyerAddrLines) {
      doc.text(line, CONTENT_LEFT + pad, by, { width: innerW });
      by += Math.max(LINE_H, doc.heightOfString(line, { width: innerW }) + 3);
    }

    // -- Right grid: 7 fixed-height rows, most split into two label/value
    // sub-columns; the last (Terms of Delivery) spans the full width.
    type Row = [string, string, string, string] | [string, string];
    const rows: Row[] = [
      ["Invoice No.", document.doc_number, "Dated", formatDate(document.issue_date)],
      ["Delivery Note", document.delivery_note || "", "Mode/Terms of Payment", document.mode_terms_of_payment || ""],
      ["Supplier's Reference", document.supplier_reference || "", "Other Reference", document.other_reference || ""],
      ["Buyer's Order No.", document.buyers_order_no || "", "Dated", formatDate(document.buyers_order_date)],
      ["Dispatch Doc No.", document.dispatch_doc_no || "", "Delivery Note Date", formatDate(document.delivery_note_date)],
      ["Dispatched through", document.dispatched_through || "", "Destination", document.destination || ""],
      ["Terms of Delivery", document.terms_of_delivery || ""],
    ];

    let ry = boxY;
    rows.forEach((row, idx) => {
      const h = GRID_ROW_H[idx];
      if (idx > 0) hLine(HEADER_RIGHT_X, HEADER_RIGHT_X + HEADER_RIGHT_W, ry);
      if (row.length === 4) {
        const [l1, v1, l2, v2] = row;
        text(l1, HEADER_RIGHT_X + pad, ry + 3, { size: 7, color: MUTED, width: HEADER_RIGHT_COL_A_W - pad * 2 });
        text(v1, HEADER_RIGHT_X + pad, ry + 12, { size: 8, width: HEADER_RIGHT_COL_A_W - pad * 2 });
        vLine(HEADER_RIGHT_X + HEADER_RIGHT_COL_A_W, ry, ry + h);
        const bx = HEADER_RIGHT_X + HEADER_RIGHT_COL_A_W;
        const bw = HEADER_RIGHT_W - HEADER_RIGHT_COL_A_W;
        text(l2, bx + pad, ry + 3, { size: 7, color: MUTED, width: bw - pad * 2 });
        text(v2, bx + pad, ry + 12, { size: 8, width: bw - pad * 2 });
      } else {
        const [l1, v1] = row;
        text(l1, HEADER_RIGHT_X + pad, ry + 3, { size: 7, color: MUTED, width: HEADER_RIGHT_W - pad * 2 });
        text(v1, HEADER_RIGHT_X + pad, ry + 12, { size: 8, width: HEADER_RIGHT_W - pad * 2 });
      }
      ry += h;
    });

    state.y = boxY + HEADER_H;
  }

  // ============================================================
  // Section B: the main item table. Column widths and the header-row
  // height are fixed exactly as measured; the body is a FIXED-MINIMUM
  // height (232.2, the sample's own) that only grows if real item rows
  // need more room than that - it is never shrunk to fit fewer items.
  // Sl No./Description/HSN/GST Rate/Qty/Rate/Amount, matching the sample
  // (no separate "per" column).
  // ============================================================
  const ITEM_HEADER_H = 21.1;
  const ITEM_BODY_MIN_H = 232.2;
  const ITEM_TOTAL_ROW_H = 15.2;
  // Bottom-anchored summary lines (subtotal + tax) inside the body sit at
  // these fixed offsets above the body's bottom edge in the sample -
  // 15.2pt apart, ending 26.2pt above the bottom for the last line.
  const SUMMARY_LINE_H = 15.2;
  const SUMMARY_BOTTOM_GAP = 26.2;

  const COLS = (() => {
    const widths = { sno: 22.6, desc: 168.5, hsn: 52.0, gst: 46.0, qty: 60.8, rate: 104.8, amount: 61.8 };
    let x = CONTENT_LEFT;
    const cols: Record<string, { x: number; width: number }> = {};
    for (const key of Object.keys(widths) as (keyof typeof widths)[]) {
      cols[key] = { x, width: widths[key] };
      x += widths[key];
    }
    return cols as Record<keyof typeof widths, { x: number; width: number }>;
  })();
  const TABLE_RIGHT = CONTENT_RIGHT;

  function drawColumnDividers(y1: number, y2: number, keys: (keyof typeof COLS)[] = Object.keys(COLS) as (keyof typeof COLS)[]) {
    keys.forEach((key) => {
      if (COLS[key].x > CONTENT_LEFT) vLine(COLS[key].x, y1, y2);
    });
  }

  function drawTableHeader() {
    const h = ITEM_HEADER_H;
    rect(CONTENT_LEFT, state.y, TABLE_RIGHT - CONTENT_LEFT, h);
    drawColumnDividers(state.y, state.y + h);
    const midY = state.y + (h - 8) / 2;
    text("Sl No.", COLS.sno.x, midY, { width: COLS.sno.width, align: "center", bold: true, size: 7.5 });
    text("Description of Goods", COLS.desc.x + 4, midY, { width: COLS.desc.width - 8, bold: true, size: 7.5 });
    text("HSN/SAC", COLS.hsn.x, midY, { width: COLS.hsn.width, align: "center", bold: true, size: 7.5 });
    text("GST Rate", COLS.gst.x, midY, { width: COLS.gst.width, align: "center", bold: true, size: 7.5 });
    text("Qty", COLS.qty.x, midY, { width: COLS.qty.width, align: "center", bold: true, size: 7.5 });
    text("Rate", COLS.rate.x, midY, { width: COLS.rate.width - 4, align: "right", bold: true, size: 7.5 });
    text("Amount", COLS.amount.x, midY, { width: COLS.amount.width - 4, align: "right", bold: true, size: 7.5 });
    state.y += h;
  }

  drawHeaderSection();
  drawTableHeader();

  // Bottom summary lines: discount/freight/installation (only if nonzero,
  // labeled), then the pre-tax subtotal (unlabeled, matching the sample),
  // then CGST+SGST or IGST, then round-off (only if nonzero). These are
  // bottom-anchored inside the body box below, in this order top-to-bottom.
  type SummaryLine = { label: string | null; value: number; bold?: boolean };
  const summaryLines: SummaryLine[] = [];
  if (discountAmount) summaryLines.push({ label: "Less: Discount", value: -discountAmount });
  if (freightCharges) summaryLines.push({ label: "Add: Freight / Transportation", value: freightCharges });
  if (installationCharges) summaryLines.push({ label: "Add: Installation / Other Charges", value: installationCharges });
  const taxableBase = subtotal - discountAmount + freightCharges + installationCharges;
  summaryLines.push({ label: null, value: taxableBase });
  if (isInterState) {
    if (igstTotal) summaryLines.push({ label: "IGST", value: igstTotal });
  } else {
    summaryLines.push({ label: "CGST", value: cgstTotal });
    summaryLines.push({ label: "SGST", value: sgstTotal });
  }
  if (roundOff) summaryLines.push({ label: "Round Off", value: roundOff });
  const summaryBlockH = summaryLines.length * SUMMARY_LINE_H + SUMMARY_BOTTOM_GAP - SUMMARY_LINE_H;

  // Measure the item rows' natural height up front so the body can grow
  // past its fixed minimum if there are enough items to need it - never
  // shrunk below the minimum, never allowed to clip content.
  const itemRowHeights = items.map((item) => {
    const descHeight = doc.fontSize(8).heightOfString(item.description, { width: COLS.desc.width - 8 });
    return Math.max(LINE_H, descHeight + 8);
  });
  const itemsNaturalH = itemRowHeights.reduce((a, b) => a + b, 0);
  const bodyH = Math.max(ITEM_BODY_MIN_H, itemsNaturalH + summaryBlockH + 20);

  if (ensureSpace(bodyH + ITEM_TOTAL_ROW_H)) {
    drawTableHeader();
  }
  const bodyTop = state.y;
  rect(CONTENT_LEFT, bodyTop, TABLE_RIGHT - CONTENT_LEFT, bodyH);
  drawColumnDividers(bodyTop, bodyTop + bodyH);

  // Item rows drawn top-down from the body's top edge - the sample's own
  // item row starts almost immediately below the header, leaving the
  // blank space below it, not above it.
  let iy = bodyTop;
  items.forEach((item, idx) => {
    const rowHeight = itemRowHeights[idx];
    const ty = iy + 4;
    text(String(idx + 1), COLS.sno.x, ty, { width: COLS.sno.width, align: "center" });
    text(item.description, COLS.desc.x + 4, ty, { width: COLS.desc.width - 8 });
    text(item.hsn_code || "-", COLS.hsn.x, ty, { width: COLS.hsn.width, align: "center" });
    text(`${Number(item.tax_rate)}%`, COLS.gst.x, ty, { width: COLS.gst.width, align: "center" });
    text(`${item.qty} ${item.unit}`, COLS.qty.x, ty, { width: COLS.qty.width, align: "center" });
    text(formatMoney(item.rate), COLS.rate.x, ty, { width: COLS.rate.width - 4, align: "right" });
    // The sample's single "Amount" column is the line's pre-tax taxable
    // value (qty*rate less this line's own discount) - NOT item.line_total,
    // which this app's data model defines as tax-inclusive. GST is added
    // back as its own CGST/SGST/IGST line(s) further down this same table,
    // exactly like the sample - showing a tax-inclusive figure here would
    // double-count it.
    const baseAmount = item.qty * item.rate;
    const lineTaxableValue = baseAmount - (baseAmount * (item.discount_percent || 0)) / 100;
    text(formatMoney(lineTaxableValue), COLS.amount.x, ty, { width: COLS.amount.width - 4, align: "right" });
    iy += rowHeight;
  });

  // Summary lines, bottom-anchored inside the same body box.
  const summaryLabelRight = COLS.rate.x + COLS.rate.width; // matches the sample's "Total" label ending before the Rate/per column
  let sy = bodyTop + bodyH - SUMMARY_BOTTOM_GAP - (summaryLines.length - 1) * SUMMARY_LINE_H;
  for (const line of summaryLines) {
    if (line.label) {
      text(line.label, COLS.hsn.x, sy, { width: summaryLabelRight - COLS.hsn.x - 6, align: "right", bold: !!line.bold });
    }
    text(formatMoney(line.value), COLS.amount.x, sy, { width: COLS.amount.width - 4, align: "right", bold: !!line.bold });
    sy += SUMMARY_LINE_H;
  }

  state.y = bodyTop + bodyH;

  // Separate Total row (grand total), below the body, its own bordered row.
  {
    const h = ITEM_TOTAL_ROW_H;
    rect(CONTENT_LEFT, state.y, TABLE_RIGHT - CONTENT_LEFT, h);
    vLine(COLS.rate.x, state.y, state.y + h);
    vLine(COLS.amount.x, state.y, state.y + h);
    text("Total", CONTENT_LEFT, state.y + 4, { width: COLS.rate.x - CONTENT_LEFT - 6, align: "right", bold: true });
    text(formatMoney(grandTotal), COLS.amount.x, state.y + 4, { width: COLS.amount.width - 4, align: "right", bold: true });
    state.y += h;
  }

  // ============================================================
  // Section C: amount in words + E.&O.E - fixed height 30.4, immediately
  // below the item table (no gap), matching the sample exactly.
  // ============================================================
  const WORDS_H = 30.4;
  {
    // amountInWords() already returns "Rupees ... Only" - no separate
    // "INR"/"Only" wrapping needed.
    const wordsText = `Amount Chargeable (in words): ${amountInWords(grandTotal)}`;
    const naturalH = doc.font("Helvetica-Bold").fontSize(8.5).heightOfString(wordsText, { width: CONTENT_WIDTH - 90 }) + 12;
    const h = Math.max(WORDS_H, naturalH);
    ensureSpace(h);
    rect(CONTENT_LEFT, state.y, CONTENT_WIDTH, h);
    text(wordsText, CONTENT_LEFT + 6, state.y + 6, { bold: true, size: 8.5, width: CONTENT_WIDTH - 90 });
    text("E. & O.E", CONTENT_RIGHT - 80, state.y + 6, { width: 74, align: "right", color: MUTED, size: 8 });
    state.y += h;
  }

  // ============================================================
  // Section D: HSN-wise GST breakdown - fixed column widths and row
  // heights matching the sample. Critically, the sample ALWAYS shows all
  // three tax-type groups (Central Tax, State Tax, Interstate Tax) side
  // by side, with "-" in whichever component doesn't apply to a given
  // transaction - it never drops a group's columns entirely the way an
  // earlier version of this file did (that shrank the table's width and
  // no longer matched the sample's own measured column layout). Also
  // always shows at least 2 body-row slots before the Total row (padding
  // with a blank row when there's only one HSN/tax-rate group), the same
  // fixed-row-count convention the sample itself uses.
  // ============================================================
  const HSN_GROUP_HEADER_H = 14.7;
  const HSN_SUBHEADER_H = 15.2;
  const HSN_ROW_H = 15.2;
  {
    const groups = groupByHsn(items, isInterState);
    // Column widths lifted directly from the sample's own measured HSN
    // table (which sums to exactly CONTENT_WIDTH): HSN/SAC, Taxable
    // Value, then Central/State/Interstate Tax, each split into
    // Rate|Amount.
    const COLW = { hsn: 76.0, taxable: 77.9, cgstRate: 44.6, cgstAmt: 44.6, sgstRate: 46.0, sgstAmt: 60.8, igstRate: 104.8, igstAmt: 61.8 };
    const keys = Object.keys(COLW) as (keyof typeof COLW)[];
    let x = CONTENT_LEFT;
    const positions = {} as Record<keyof typeof COLW, { x: number; width: number }>;
    for (const k of keys) {
      positions[k] = { x, width: COLW[k] };
      x += COLW[k];
    }
    const tableRight = x;
    const bodyRowCount = Math.max(2, groups.length); // at least 2 slots, matching the sample's reserved blank row

    function hsnColumnDividers(y1: number, y2: number) {
      keys.forEach((k) => {
        if (positions[k].x > CONTENT_LEFT) vLine(positions[k].x, y1, y2);
      });
    }

    ensureSpace(HSN_GROUP_HEADER_H + HSN_SUBHEADER_H + HSN_ROW_H * (bodyRowCount + 1));
    const topY = state.y;
    const headerH = HSN_GROUP_HEADER_H + HSN_SUBHEADER_H;
    rect(CONTENT_LEFT, topY, tableRight - CONTENT_LEFT, headerH);
    hsnColumnDividers(topY, topY + headerH);
    text("HSN/SAC", positions.hsn.x, topY + 10, { width: positions.hsn.width, align: "center", bold: true, size: 7.5 });
    text("Taxable Value", positions.taxable.x, topY + 10, { width: positions.taxable.width, align: "center", bold: true, size: 7.5 });
    const groupHeaders: [string, keyof typeof COLW, keyof typeof COLW][] = [
      ["Central Tax", "cgstRate", "cgstAmt"],
      ["State Tax", "sgstRate", "sgstAmt"],
      ["Interstate Tax", "igstRate", "igstAmt"],
    ];
    for (const [label, rateKey, amtKey] of groupHeaders) {
      const grpW = positions[rateKey].width + positions[amtKey].width;
      text(label, positions[rateKey].x, topY + 2, { width: grpW, align: "center", bold: true, size: 7.5 });
      hLine(positions[rateKey].x, positions[rateKey].x + grpW, topY + HSN_GROUP_HEADER_H);
      text("Rate", positions[rateKey].x, topY + HSN_GROUP_HEADER_H + 2, { width: positions[rateKey].width, align: "center", size: 7 });
      text("Amount", positions[amtKey].x, topY + HSN_GROUP_HEADER_H + 2, { width: positions[amtKey].width, align: "center", size: 7 });
    }
    state.y = topY + headerH;

    let totalTaxable = 0;
    let totalCgst = 0;
    let totalSgst = 0;
    let totalIgst = 0;
    for (let i = 0; i < bodyRowCount; i++) {
      rect(CONTENT_LEFT, state.y, tableRight - CONTENT_LEFT, HSN_ROW_H);
      hsnColumnDividers(state.y, state.y + HSN_ROW_H);
      const g = groups[i];
      if (g) {
        text(g.hsn, positions.hsn.x, state.y + 4, { width: positions.hsn.width, align: "center", size: 7.8 });
        text(formatMoney(g.taxableValue), positions.taxable.x, state.y + 4, { width: positions.taxable.width - 6, align: "right", size: 7.8 });
        totalTaxable += g.taxableValue;
        text(`${g.taxRate / 2}%`, positions.cgstRate.x, state.y + 4, { width: positions.cgstRate.width, align: "center", size: 7.8 });
        text(isInterState ? "-" : formatMoney(g.cgst), positions.cgstAmt.x, state.y + 4, { width: positions.cgstAmt.width - 6, align: "right", size: 7.8 });
        text(`${g.taxRate / 2}%`, positions.sgstRate.x, state.y + 4, { width: positions.sgstRate.width, align: "center", size: 7.8 });
        text(isInterState ? "-" : formatMoney(g.sgst), positions.sgstAmt.x, state.y + 4, { width: positions.sgstAmt.width - 6, align: "right", size: 7.8 });
        text(`${g.taxRate}%`, positions.igstRate.x, state.y + 4, { width: positions.igstRate.width, align: "center", size: 7.8 });
        text(isInterState ? formatMoney(g.igst) : "-", positions.igstAmt.x, state.y + 4, { width: positions.igstAmt.width - 6, align: "right", size: 7.8 });
        totalCgst += g.cgst;
        totalSgst += g.sgst;
        totalIgst += g.igst;
      } else {
        text("-", positions.hsn.x, state.y + 4, { width: positions.hsn.width, align: "center", size: 7.8, color: MUTED });
      }
      state.y += HSN_ROW_H;
    }

    rect(CONTENT_LEFT, state.y, tableRight - CONTENT_LEFT, HSN_ROW_H);
    hsnColumnDividers(state.y, state.y + HSN_ROW_H);
    text("Total", positions.hsn.x, state.y + 4, { width: positions.hsn.width, align: "center", bold: true, size: 7.8 });
    text(formatMoney(totalTaxable), positions.taxable.x, state.y + 4, { width: positions.taxable.width - 6, align: "right", bold: true, size: 7.8 });
    text(formatMoney(totalCgst), positions.cgstAmt.x, state.y + 4, { width: positions.cgstAmt.width - 6, align: "right", bold: true, size: 7.8 });
    text(formatMoney(totalSgst), positions.sgstAmt.x, state.y + 4, { width: positions.sgstAmt.width - 6, align: "right", bold: true, size: 7.8 });
    text(formatMoney(totalIgst), positions.igstAmt.x, state.y + 4, { width: positions.igstAmt.width - 6, align: "right", bold: true, size: 7.8 });
    state.y += HSN_ROW_H;
  }

  // ============================================================
  // Section E: Declaration + Bank Details - fixed height 56.8.
  // ============================================================
  const DECL_BANK_H = 56.8;
  {
    const declarationText = (document.terms_and_conditions || company.terms_and_conditions) ||
      "We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.";
    const halfW = CONTENT_WIDTH / 2;
    const bankRows: [string, string][] = template.showBankDetails
      ? ((
          [
            ["Bank Name", company.bank_name],
            ["Account No.", company.bank_account_no],
            ["Branch & IFSC", company.bank_ifsc],
          ] as [string, string | null][]
        ).filter(([, v]) => v) as [string, string][])
      : [];
    // "Natural" heights only kick in as a safety net for content the fixed
    // 56.8 (the sample's own) genuinely can't fit - e.g. an unusually long
    // declaration paragraph or bank details with more than 3 rows. They
    // must NOT exceed 56.8 for the sample's own data shape (a short
    // 2-line declaration, 3 bank rows), or every invoice would silently
    // grow past the fixed height and risk pushing Signature onto a second
    // page - this box sits right before it with little margin to spare.
    const declNaturalH = doc.font("Helvetica").fontSize(7.8).heightOfString(declarationText, { width: halfW - 16 }) + 24;
    const bankNaturalH = 15 + bankRows.length * 13;
    const h = Math.max(DECL_BANK_H, declNaturalH, bankNaturalH);

    ensureSpace(h);
    const topY = state.y;
    rect(CONTENT_LEFT, topY, CONTENT_WIDTH, h);
    vLine(CONTENT_LEFT + halfW, topY, topY + h);

    // Every label below passes an explicit `width` (even though none of
    // these short strings actually wrap) - without one, the `text()`
    // helper sets lineBreak:false, which leaves pdfkit's own `doc.y`
    // cursor stale, so the very next call's `doc.y`-relative position
    // would land back on top of this label instead of below it.
    text("Declaration:", CONTENT_LEFT + 8, topY + 6, { bold: true, size: 8, width: halfW - 16 });
    text(declarationText, CONTENT_LEFT + 8, doc.y + 3, { size: 7.8, width: halfW - 16, color: MUTED });

    if (template.showBankDetails) {
      const bx = CONTENT_LEFT + halfW + 8;
      text(`Company's Bank Details`, bx, topY + 6, { bold: true, size: 8, width: halfW - 16 });
      let by = doc.y + 3;
      for (const [label, value] of bankRows) {
        text(`${label}:`, bx, by, { size: 7.8, color: MUTED, width: 90 });
        text(value, bx + 90, by, { size: 7.8, width: halfW - 16 - 90 });
        by += 13;
      }
    }

    state.y = topY + h;
  }

  // ============================================================
  // Section F: Signature - fixed height 91.1, the large signature area
  // the sample reserves at the very bottom of the page.
  // ============================================================
  const SIGNATURE_H = 91.1;
  if (template.showSignatureBlock) {
    const h = SIGNATURE_H;
    ensureSpace(h);
    const topY = state.y;
    const halfW = CONTENT_WIDTH / 2;
    rect(CONTENT_LEFT, topY, CONTENT_WIDTH, h);
    vLine(CONTENT_LEFT + halfW, topY, topY + h);
    text("Customer's Seal and Signature", CONTENT_LEFT + 8, topY + 8, { size: 8, width: halfW - 16 });
    const bx = CONTENT_LEFT + halfW + 8;
    text(`For ${company.name}`, bx, topY + 8, { bold: true, size: 8.5, width: halfW - 16, align: "right" });
    text("Authorised Signatory", bx, topY + h - 16, { size: 8, width: halfW - 16, align: "right" });
    state.y = topY + h;
  }

  // ---- Per-page footer note + page numbers ----
  const pageRange = doc.bufferedPageRange();
  for (let i = 0; i < pageRange.count; i++) {
    doc.switchToPage(pageRange.start + i);
    const originalBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const footerY = PAGE_HEIGHT - PAGE_MARGIN + 4;
    text(template.footerNote, CONTENT_LEFT, footerY, { width: CONTENT_WIDTH / 2, size: 7, color: MUTED });
    text(`Page ${i + 1} of ${pageRange.count}`, CONTENT_LEFT + CONTENT_WIDTH / 2, footerY, {
      width: CONTENT_WIDTH / 2,
      align: "right",
      size: 7,
      color: MUTED,
    });
    doc.page.margins.bottom = originalBottomMargin;
  }

  doc.end();
}
