import PDFDocument from "pdfkit";
import { Response } from "express";
import { Company, Customer, DocumentItem, DocumentRecord } from "../../types";
import { amountInWords } from "../../utils/numberToWords";
import { EffectiveDocumentTemplate } from "../documentTemplates";

// "classic_gst" style - a Tally-style Indian GST Tax Invoice format, built to
// match a customer-supplied sample (068 Unilink.pdf/.xlsx) field-for-field:
// company block + a 7-row reference grid + a single Buyer box (no separate
// Consignee/Ship-To box - the sample has none), an item table with the
// GST/discount/freight rows folded into it rather than a separate totals
// block, amount-in-words + E.&O.E, a distinct HSN-wise GST breakdown table,
// and a Declaration/Bank Details row followed by a Signature row. Entirely
// monochrome (no accent color) and never shows a logo image, matching the
// sample exactly - see documentTemplates.ts's TEMPLATE_STYLES doc comment.
// Parameterized by `title` the same way streamDocumentPdf is, so one file
// covers Quotation/Proforma Invoice/Delivery Challan/Tax Invoice.

const PAGE_MARGIN = 34;
const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const CONTENT_LEFT = PAGE_MARGIN;
const CONTENT_RIGHT = PAGE_WIDTH - PAGE_MARGIN;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;
const BOTTOM_LIMIT = PAGE_HEIGHT - PAGE_MARGIN - 18;

const INK = "#000000";
const MUTED = "#444444";

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
  const titleUpper = title.toUpperCase();

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
  const totalQty = items.reduce((sum, i) => sum + Number(i.qty), 0);

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

  // ---- Section A: company / reference grid / buyer ----
  function drawHeaderSection() {
    const leftW = Math.round(CONTENT_WIDTH * 0.56);
    const rightW = CONTENT_WIDTH - leftW;
    const rightX = CONTENT_LEFT + leftW;
    const pad = 6;
    const boxTop = state.y;

    // -- Right grid: 7 label/value rows, measured first since row 7 (Terms
    // of Delivery) can wrap and grow taller than the rest.
    type Row = [string, string, string, string] | [string, string]; // [l1,v1,l2,v2] or [l1,v1] (full width)
    const rows: Row[] = [
      ["Invoice No.", document.doc_number, "Dated", formatDate(document.issue_date)],
      ["Delivery Note", document.delivery_note || "", "Mode/Terms of Payment", document.mode_terms_of_payment || ""],
      ["Supplier's Reference", document.supplier_reference || "", "Other Reference", document.other_reference || ""],
      ["Buyer's Order No.", document.buyers_order_no || "", "Dated", formatDate(document.buyers_order_date)],
      ["Dispatch Doc No.", document.dispatch_doc_no || "", "Delivery Note Date", formatDate(document.delivery_note_date)],
      ["Dispatched through", document.dispatched_through || "", "Destination", document.destination || ""],
      ["Terms of Delivery", document.terms_of_delivery || ""],
    ];
    const rowH = 20;
    const lastRowValueH = doc.font("Helvetica").fontSize(8).heightOfString(rows[6][1] || " ", { width: rightW - pad * 2 });
    const lastRowH = Math.max(rowH, lastRowValueH + 14);
    const rightGridH = rowH * 6 + lastRowH;

    // -- Left column content: measured by actually laying it out with
    // pdfkit's own text calls at y=0 first is overkill here; instead grow
    // the box to whichever side needs more room and let the shorter side's
    // content simply sit at the top with blank space below it.
    const addrLines = [company.address, company.gstin ? `GSTIN/UIN: ${company.gstin}` : null].filter(Boolean) as string[];
    const stateLine = [company.state ? `State Name: ${company.state}` : null, company.state_code ? `Code: ${company.state_code}` : null]
      .filter(Boolean)
      .join(", ");
    const buyerAddrLines = [
      customer.billing_address || "",
      customer.gstin ? `GSTIN/UIN: ${customer.gstin}` : "",
      customer.state ? `State Name: ${customer.state}` : "",
      document.place_of_supply ? `Place of Supply: ${document.place_of_supply}` : "",
    ].filter(Boolean);

    let leftH = 6 + 14; // company name line
    doc.font("Helvetica").fontSize(7.5);
    for (const line of addrLines) leftH += doc.heightOfString(line, { width: leftW - pad * 2 }) + 2;
    if (stateLine) leftH += doc.heightOfString(stateLine, { width: leftW - pad * 2 }) + 2;
    leftH += 10; // gap before Buyer sub-box
    leftH += 12; // "Buyer" label
    leftH += 13; // customer name (bold)
    for (const line of buyerAddrLines) leftH += doc.heightOfString(line, { width: leftW - pad * 2 }) + 2;
    leftH += 6;

    const boxH = Math.max(leftH, rightGridH);
    ensureSpace(boxH + 4);
    const boxY = state.y;

    rect(CONTENT_LEFT, boxY, leftW, boxH);
    rect(rightX, boxY, rightW, boxH);
    vLine(rightX, boxY, boxY + boxH);

    // -- Left column render --
    let ly = boxY + pad;
    text(company.name, CONTENT_LEFT + pad, ly, { bold: true, size: 11, width: leftW - pad * 2 });
    ly = doc.y + 2;
    doc.font("Helvetica").fontSize(7.5).fillColor(MUTED);
    for (const line of addrLines) {
      doc.text(line, CONTENT_LEFT + pad, ly, { width: leftW - pad * 2 });
      ly = doc.y + 2;
    }
    if (stateLine) {
      doc.text(stateLine, CONTENT_LEFT + pad, ly, { width: leftW - pad * 2 });
      ly = doc.y + 2;
    }
    ly += 8;
    hLine(CONTENT_LEFT, rightX, ly);
    ly += 6;
    text("Buyer (Bill to)", CONTENT_LEFT + pad, ly, { bold: true, size: 8, color: MUTED, width: leftW - pad * 2 });
    ly = doc.y + 2;
    text(customer.name, CONTENT_LEFT + pad, ly, { bold: true, size: 9.5, width: leftW - pad * 2 });
    ly = doc.y + 2;
    doc.font("Helvetica").fontSize(7.5).fillColor(MUTED);
    for (const line of buyerAddrLines) {
      doc.text(line, CONTENT_LEFT + pad, ly, { width: leftW - pad * 2 });
      ly = doc.y + 2;
    }

    // -- Right grid render --
    let ry = boxY;
    const halfW = rightW / 2;
    rows.forEach((row, idx) => {
      const isLast = idx === rows.length - 1;
      const h = isLast ? lastRowH : rowH;
      if (idx > 0) hLine(rightX, rightX + rightW, ry);
      if (row.length === 4) {
        const [l1, v1, l2, v2] = row;
        text(l1, rightX + pad, ry + 3, { size: 7, color: MUTED, width: halfW - pad * 2 });
        text(v1, rightX + pad, ry + 12, { size: 8, width: halfW - pad * 2 });
        vLine(rightX + halfW, ry, ry + h);
        text(l2, rightX + halfW + pad, ry + 3, { size: 7, color: MUTED, width: halfW - pad * 2 });
        text(v2, rightX + halfW + pad, ry + 12, { size: 8, width: halfW - pad * 2 });
      } else {
        const [l1, v1] = row;
        text(l1, rightX + pad, ry + 3, { size: 7, color: MUTED, width: rightW - pad * 2 });
        text(v1, rightX + pad, ry + 12, { size: 8, width: rightW - pad * 2 });
      }
      ry += h;
    });

    state.y = boxY + boxH;
  }

  // ---- Section B: item table (with GST/discount/freight rows folded in) ----
  const COLS = (() => {
    const widths = { sno: 26, desc: 168, hsn: 55, gst: 38, qty: 45, rate: 62, per: 34, amount: 87 };
    let x = CONTENT_LEFT;
    const cols: Record<string, { x: number; width: number }> = {};
    for (const key of Object.keys(widths) as (keyof typeof widths)[]) {
      cols[key] = { x, width: widths[key] };
      x += widths[key];
    }
    return cols as Record<keyof typeof widths, { x: number; width: number }>;
  })();
  const TABLE_RIGHT = COLS.amount.x + COLS.amount.width;

  function drawTableHeader() {
    const h = 22;
    rect(CONTENT_LEFT, state.y, TABLE_RIGHT - CONTENT_LEFT, h);
    (Object.keys(COLS) as (keyof typeof COLS)[]).forEach((key) => {
      if (COLS[key].x > CONTENT_LEFT) vLine(COLS[key].x, state.y, state.y + h);
    });
    const midY = state.y + 6;
    text("Sl No.", COLS.sno.x, midY, { width: COLS.sno.width, align: "center", bold: true, size: 7.5 });
    text("Description of Goods", COLS.desc.x + 4, midY, { width: COLS.desc.width - 8, bold: true, size: 7.5 });
    text("HSN/SAC", COLS.hsn.x, midY, { width: COLS.hsn.width, align: "center", bold: true, size: 7.5 });
    text("GST Rate", COLS.gst.x, midY, { width: COLS.gst.width, align: "center", bold: true, size: 7.5 });
    text("Quantity", COLS.qty.x, midY, { width: COLS.qty.width, align: "center", bold: true, size: 7.5 });
    text("Rate", COLS.rate.x, midY, { width: COLS.rate.width - 4, align: "right", bold: true, size: 7.5 });
    text("per", COLS.per.x, midY, { width: COLS.per.width, align: "center", bold: true, size: 7.5 });
    text("Amount", COLS.amount.x, midY, { width: COLS.amount.width - 4, align: "right", bold: true, size: 7.5 });
    state.y += h;
  }

  function tableSummaryRow(label: string, value: number | null, bold = false) {
    const h = 16;
    ensureSpace(h);
    rect(CONTENT_LEFT, state.y, TABLE_RIGHT - CONTENT_LEFT, h);
    vLine(COLS.amount.x, state.y, state.y + h);
    text(label, COLS.hsn.x, state.y + 4, { width: COLS.amount.x - COLS.hsn.x - 6, align: "right", bold });
    if (value !== null) {
      text(formatMoney(value), COLS.amount.x, state.y + 4, { width: COLS.amount.width - 4, align: "right", bold });
    }
    state.y += h;
  }

  drawHeaderSection();
  drawTableHeader();

  items.forEach((item, idx) => {
    const descHeight = doc.fontSize(8).heightOfString(item.description, { width: COLS.desc.width - 8 });
    const rowHeight = Math.max(18, descHeight + 8);
    if (ensureSpace(rowHeight)) drawTableHeader();
    const y = state.y;
    rect(CONTENT_LEFT, y, TABLE_RIGHT - CONTENT_LEFT, rowHeight);
    (Object.keys(COLS) as (keyof typeof COLS)[]).forEach((key) => {
      if (COLS[key].x > CONTENT_LEFT) vLine(COLS[key].x, y, y + rowHeight);
    });
    const ty = y + 4;
    text(String(idx + 1), COLS.sno.x, ty, { width: COLS.sno.width, align: "center" });
    text(item.description, COLS.desc.x + 4, ty, { width: COLS.desc.width - 8 });
    text(item.hsn_code || "-", COLS.hsn.x, ty, { width: COLS.hsn.width, align: "center" });
    text(`${Number(item.tax_rate)}%`, COLS.gst.x, ty, { width: COLS.gst.width, align: "center" });
    text(`${item.qty} ${item.unit}`, COLS.qty.x, ty, { width: COLS.qty.width, align: "center" });
    text(formatMoney(item.rate), COLS.rate.x, ty, { width: COLS.rate.width - 4, align: "right" });
    text(item.unit, COLS.per.x, ty, { width: COLS.per.width, align: "center" });
    text(formatMoney(item.line_total), COLS.amount.x, ty, { width: COLS.amount.width - 4, align: "right" });
    state.y += rowHeight;
  });

  // Total-quantity row, folded into the table itself (Tally shows this as
  // the last row of the item table, not a separate block).
  {
    const h = 16;
    ensureSpace(h);
    rect(CONTENT_LEFT, state.y, TABLE_RIGHT - CONTENT_LEFT, h);
    vLine(COLS.qty.x, state.y, state.y + h);
    vLine(COLS.amount.x, state.y, state.y + h);
    text("Total", COLS.hsn.x, state.y + 4, { width: COLS.qty.x - COLS.hsn.x - 6, align: "right", bold: true });
    text(`${totalQty}`, COLS.qty.x, state.y + 4, { width: COLS.qty.width, align: "center", bold: true });
    text(formatMoney(subtotal), COLS.amount.x, state.y + 4, { width: COLS.amount.width - 4, align: "right", bold: true });
    state.y += h;
  }

  if (discountAmount) tableSummaryRow("Less: Discount", -discountAmount);
  if (freightCharges) tableSummaryRow("Add: Freight / Transportation", freightCharges);
  if (installationCharges) tableSummaryRow("Add: Installation / Other Charges", installationCharges);
  if (isInterState) {
    if (igstTotal) tableSummaryRow("Add: IGST", igstTotal);
  } else {
    if (cgstTotal) tableSummaryRow("Add: CGST", cgstTotal);
    if (sgstTotal) tableSummaryRow("Add: SGST", sgstTotal);
  }
  if (roundOff) tableSummaryRow("Round Off", roundOff);
  tableSummaryRow("Grand Total", grandTotal, true);
  state.y += 8;

  // ---- Section C: amount in words + E.&O.E ----
  {
    // amountInWords() already returns "Rupees ... Only" - no separate "INR"/"Only" wrapping needed.
    const wordsText = `Amount Chargeable (in words): ${amountInWords(grandTotal)}`;
    const h = Math.max(22, doc.font("Helvetica-Bold").fontSize(8.5).heightOfString(wordsText, { width: CONTENT_WIDTH - 90 }) + 12);
    ensureSpace(h);
    rect(CONTENT_LEFT, state.y, CONTENT_WIDTH, h);
    text(wordsText, CONTENT_LEFT + 6, state.y + 6, { bold: true, size: 8.5, width: CONTENT_WIDTH - 90 });
    text("E. & O.E", CONTENT_RIGHT - 80, state.y + 6, { width: 74, align: "right", color: MUTED, size: 8 });
    state.y += h;
  }

  // ---- Section D: HSN-wise GST breakdown ----
  {
    const groups = groupByHsn(items, isInterState);
    const HCOLS = isInterState
      ? { hsn: 90, taxable: 130, igstRate: 90, igstAmt: 100 }
      : { hsn: 90, taxable: 105, cgstRate: 60, cgstAmt: 90, sgstRate: 60, sgstAmt: 90 };
    const keys = Object.keys(HCOLS) as (keyof typeof HCOLS)[];
    let x = CONTENT_LEFT;
    const positions: Record<string, { x: number; width: number }> = {};
    for (const k of keys) {
      positions[k] = { x, width: (HCOLS as any)[k] };
      x += (HCOLS as any)[k];
    }
    const tableRight = x;
    const headerH = 24;

    ensureSpace(headerH + 16 * (groups.length + 1));
    const topY = state.y;
    rect(CONTENT_LEFT, topY, tableRight - CONTENT_LEFT, headerH);
    keys.forEach((k) => {
      if (positions[k].x > CONTENT_LEFT) vLine(positions[k].x, topY, topY + headerH);
    });
    text("HSN/SAC", positions.hsn.x, topY + 8, { width: positions.hsn.width, align: "center", bold: true, size: 7.5 });
    text("Taxable Value", positions.taxable.x, topY + 8, { width: positions.taxable.width, align: "center", bold: true, size: 7.5 });
    if (isInterState) {
      text("Integrated Tax", positions.igstRate.x, topY + 2, { width: positions.igstRate.width + (HCOLS as any).igstAmt, align: "center", bold: true, size: 7.5 });
      hLine(positions.igstRate.x, positions.igstRate.x + positions.igstRate.width + (HCOLS as any).igstAmt, topY + 12);
      text("Rate", positions.igstRate.x, topY + 14, { width: positions.igstRate.width, align: "center", size: 7 });
      text("Amount", positions.igstAmt.x, topY + 14, { width: positions.igstAmt.width, align: "center", size: 7 });
    } else {
      text("Central Tax", positions.cgstRate.x, topY + 2, { width: positions.cgstRate.width + (HCOLS as any).cgstAmt, align: "center", bold: true, size: 7.5 });
      hLine(positions.cgstRate.x, positions.cgstRate.x + positions.cgstRate.width + (HCOLS as any).cgstAmt, topY + 12);
      text("Rate", positions.cgstRate.x, topY + 14, { width: positions.cgstRate.width, align: "center", size: 7 });
      text("Amount", positions.cgstAmt.x, topY + 14, { width: positions.cgstAmt.width, align: "center", size: 7 });
      text("State Tax", positions.sgstRate.x, topY + 2, { width: positions.sgstRate.width + (HCOLS as any).sgstAmt, align: "center", bold: true, size: 7.5 });
      hLine(positions.sgstRate.x, positions.sgstRate.x + positions.sgstRate.width + (HCOLS as any).sgstAmt, topY + 12);
      text("Rate", positions.sgstRate.x, topY + 14, { width: positions.sgstRate.width, align: "center", size: 7 });
      text("Amount", positions.sgstAmt.x, topY + 14, { width: positions.sgstAmt.width, align: "center", size: 7 });
    }
    state.y = topY + headerH;

    let totalTaxable = 0;
    let totalA = 0;
    let totalB = 0;
    const rowH = 16;
    groups.forEach((g) => {
      rect(CONTENT_LEFT, state.y, tableRight - CONTENT_LEFT, rowH);
      keys.forEach((k) => {
        if (positions[k].x > CONTENT_LEFT) vLine(positions[k].x, state.y, state.y + rowH);
      });
      text(g.hsn, positions.hsn.x, state.y + 4, { width: positions.hsn.width, align: "center", size: 7.8 });
      text(formatMoney(g.taxableValue), positions.taxable.x, state.y + 4, { width: positions.taxable.width - 6, align: "right", size: 7.8 });
      totalTaxable += g.taxableValue;
      if (isInterState) {
        text(`${g.taxRate}%`, positions.igstRate.x, state.y + 4, { width: positions.igstRate.width, align: "center", size: 7.8 });
        text(formatMoney(g.igst), positions.igstAmt.x, state.y + 4, { width: positions.igstAmt.width - 6, align: "right", size: 7.8 });
        totalA += g.igst;
      } else {
        text(`${g.taxRate / 2}%`, positions.cgstRate.x, state.y + 4, { width: positions.cgstRate.width, align: "center", size: 7.8 });
        text(formatMoney(g.cgst), positions.cgstAmt.x, state.y + 4, { width: positions.cgstAmt.width - 6, align: "right", size: 7.8 });
        text(`${g.taxRate / 2}%`, positions.sgstRate.x, state.y + 4, { width: positions.sgstRate.width, align: "center", size: 7.8 });
        text(formatMoney(g.sgst), positions.sgstAmt.x, state.y + 4, { width: positions.sgstAmt.width - 6, align: "right", size: 7.8 });
        totalA += g.cgst;
        totalB += g.sgst;
      }
      state.y += rowH;
    });

    rect(CONTENT_LEFT, state.y, tableRight - CONTENT_LEFT, rowH);
    keys.forEach((k) => {
      if (positions[k].x > CONTENT_LEFT) vLine(positions[k].x, state.y, state.y + rowH);
    });
    text("Total", positions.hsn.x, state.y + 4, { width: positions.hsn.width, align: "center", bold: true, size: 7.8 });
    text(formatMoney(totalTaxable), positions.taxable.x, state.y + 4, { width: positions.taxable.width - 6, align: "right", bold: true, size: 7.8 });
    if (isInterState) {
      text(formatMoney(totalA), positions.igstAmt.x, state.y + 4, { width: positions.igstAmt.width - 6, align: "right", bold: true, size: 7.8 });
    } else {
      text(formatMoney(totalA), positions.cgstAmt.x, state.y + 4, { width: positions.cgstAmt.width - 6, align: "right", bold: true, size: 7.8 });
      text(formatMoney(totalB), positions.sgstAmt.x, state.y + 4, { width: positions.sgstAmt.width - 6, align: "right", bold: true, size: 7.8 });
    }
    state.y += rowH + 8;
  }

  // ---- Section E: Declaration + Bank Details ----
  {
    const declarationText = (document.terms_and_conditions || company.terms_and_conditions) ||
      "We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.";
    const halfW = CONTENT_WIDTH / 2;
    const declH = doc.font("Helvetica").fontSize(7.8).heightOfString(declarationText, { width: halfW - 16 });
    const bankRows: [string, string][] = template.showBankDetails
      ? ((
          [
            ["Bank Name", company.bank_name],
            ["Account No.", company.bank_account_no],
            ["Branch & IFSC", company.bank_ifsc],
          ] as [string, string | null][]
        ).filter(([, v]) => v) as [string, string][])
      : [];
    const bankH = 14 + bankRows.length * 13;
    const h = Math.max(declH + 30, bankH + 14, 60);

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

  // ---- Section F: Signature ----
  if (template.showSignatureBlock) {
    const h = 56;
    ensureSpace(h);
    const topY = state.y;
    const halfW = CONTENT_WIDTH / 2;
    rect(CONTENT_LEFT, topY, CONTENT_WIDTH, h);
    vLine(CONTENT_LEFT + halfW, topY, topY + h);
    text("Customer's Seal and Signature", CONTENT_LEFT + 8, topY + h - 16, { size: 8, width: halfW - 16 });
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
