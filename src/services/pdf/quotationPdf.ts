import path from "path";
import PDFDocument from "pdfkit";
import { Response } from "express";
import { Company, Customer, DocumentItem, DocumentRecord } from "../../types";
import { computeGstSplit, groupByHsn } from "../../utils/gst";
import { amountInWords } from "../../utils/numberToWords";

const PAGE_MARGIN = 40;
const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const CONTENT_LEFT = PAGE_MARGIN;
const CONTENT_RIGHT = PAGE_WIDTH - PAGE_MARGIN;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;
const BOTTOM_LIMIT = PAGE_HEIGHT - PAGE_MARGIN - 16; // leave room for the small per-page footer note

const LOGO_PATH = path.join(__dirname, "../../../client/src/assets/logo-black.png");

const GREEN = "#16A34A";
const DARK = "#111111";
const GRAY = "#444444";
const MUTED = "#888888";
const BORDER = "#e2e8f0";
const HEADER_BG = "#16A34A";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function formatMoney(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const TABLE_COLS = {
  sno: { x: CONTENT_LEFT, width: 28 },
  desc: { x: CONTENT_LEFT + 28, width: 165 },
  hsn: { x: CONTENT_LEFT + 193, width: 55 },
  gst: { x: CONTENT_LEFT + 248, width: 35 },
  qty: { x: CONTENT_LEFT + 283, width: 40 },
  rate: { x: CONTENT_LEFT + 323, width: 65 },
  amount: { x: CONTENT_LEFT + 388, width: CONTENT_RIGHT - (CONTENT_LEFT + 388) },
};

export function streamQuotationPdf(
  res: Response,
  document: DocumentRecord,
  items: DocumentItem[],
  customer: Customer,
  company: Company
) {
  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${document.doc_number.replace(/\//g, "-")}.pdf"`
  );
  doc.pipe(res);

  const state = { y: PAGE_MARGIN, page: 1 };

  const subtotal = Number(document.subtotal);
  const cgstTotal = Number(document.cgst_total);
  const sgstTotal = Number(document.sgst_total);
  const igstTotal = Number(document.igst_total);
  const grandTotal = Number(document.grand_total);
  const isInterState = igstTotal > 0;

  function drawLogo(x: number, y: number, size: number) {
    try {
      doc.image(LOGO_PATH, x, y, { fit: [size, size] });
    } catch {
      // Logo missing - skip silently rather than fail PDF generation.
    }
  }

  function drawMainHeader() {
    const logoSize = 44;
    drawLogo(CONTENT_LEFT, state.y, logoSize);

    const textX = CONTENT_LEFT + logoSize + 10;
    const textWidth = 260;
    doc.fontSize(15).fillColor(GREEN).text(company.name.toUpperCase(), textX, state.y, { width: textWidth });
    doc.fontSize(8).fillColor(GRAY);
    if (company.tagline) doc.text(company.tagline, textX, doc.y, { width: textWidth });
    if (company.address) doc.text(company.address, textX, doc.y, { width: textWidth });
    const contactLine = [company.phone, company.email].filter(Boolean).join("  |  ");
    if (contactLine) doc.text(contactLine, textX, doc.y, { width: textWidth });
    const gstLine = [
      company.gstin ? `GSTIN: ${company.gstin}` : null,
      company.state ? `State: ${company.state}${company.state_code ? ` (${company.state_code})` : ""}` : null,
    ]
      .filter(Boolean)
      .join("   ");
    if (gstLine) doc.text(gstLine, textX, doc.y, { width: textWidth });

    const rightX = CONTENT_LEFT + 320;
    const rightWidth = CONTENT_RIGHT - rightX;
    doc.fontSize(16).fillColor(DARK).text("QUOTATION", rightX, PAGE_MARGIN, { width: rightWidth, align: "right" });
    doc.fontSize(9).fillColor(GRAY);
    doc.text(`No: ${document.doc_number}`, rightX, doc.y + 4, { width: rightWidth, align: "right" });
    doc.text(`Date: ${formatDate(document.issue_date)}`, rightX, doc.y, { width: rightWidth, align: "right" });
    if (document.place_of_supply) {
      doc.text(`Place of Supply: ${document.place_of_supply}`, rightX, doc.y, { width: rightWidth, align: "right" });
    }

    state.y = Math.max(doc.y, state.y + logoSize) + 8;
    doc.moveTo(CONTENT_LEFT, state.y).lineTo(CONTENT_RIGHT, state.y).strokeColor(BORDER).stroke();
    state.y += 10;
  }

  function drawContinuationHeader() {
    drawLogo(CONTENT_LEFT, state.y, 22);
    doc.fontSize(10).fillColor(GREEN).text(company.name, CONTENT_LEFT + 30, state.y + 4);
    doc.fontSize(9).fillColor(GRAY);
    doc.text(`Quotation No: ${document.doc_number}   |   Date: ${formatDate(document.issue_date)}   (Continued)`, CONTENT_LEFT + 30, doc.y);
    state.y = Math.max(doc.y, state.y + 22) + 8;
    doc.moveTo(CONTENT_LEFT, state.y).lineTo(CONTENT_RIGHT, state.y).strokeColor(BORDER).stroke();
    state.y += 10;
  }

  function drawBuyerConsignee() {
    const hasConsignee = !!document.consignee_name;
    const colWidth = hasConsignee ? CONTENT_WIDTH / 2 - 8 : CONTENT_WIDTH;
    const startY = state.y;

    doc.fontSize(8).fillColor(MUTED).text("BILL TO", CONTENT_LEFT, state.y);
    doc.fontSize(9.5).fillColor(DARK).text(customer.name, CONTENT_LEFT, doc.y + 2, { width: colWidth });
    doc.fontSize(8.5).fillColor(GRAY);
    if (customer.billing_address) doc.text(customer.billing_address, CONTENT_LEFT, doc.y, { width: colWidth });
    if (customer.gstin) doc.text(`GSTIN: ${customer.gstin}`, CONTENT_LEFT, doc.y, { width: colWidth });
    if (customer.state) doc.text(`State: ${customer.state}`, CONTENT_LEFT, doc.y, { width: colWidth });
    if (customer.phone) doc.text(`Phone: ${customer.phone}`, CONTENT_LEFT, doc.y, { width: colWidth });
    const leftBottom = doc.y;

    if (hasConsignee) {
      const rightX = CONTENT_LEFT + CONTENT_WIDTH / 2 + 8;
      doc.fontSize(8).fillColor(MUTED).text("SHIP TO", rightX, startY);
      doc.fontSize(9.5).fillColor(DARK).text(document.consignee_name || "", rightX, doc.y + 2, { width: colWidth });
      doc.fontSize(8.5).fillColor(GRAY);
      if (document.consignee_address) doc.text(document.consignee_address, rightX, doc.y, { width: colWidth });
      if (document.consignee_gstin) doc.text(`GSTIN: ${document.consignee_gstin}`, rightX, doc.y, { width: colWidth });
      if (document.consignee_state) doc.text(`State: ${document.consignee_state}`, rightX, doc.y, { width: colWidth });
      state.y = Math.max(leftBottom, doc.y) + 10;
    } else {
      state.y = leftBottom + 10;
    }
  }

  function drawReferenceGrid() {
    const fields = (
      [
        ["Delivery Note", document.delivery_note || ""],
        ["Delivery Note Date", formatDate(document.delivery_note_date)],
        ["Mode/Terms of Payment", document.mode_terms_of_payment || ""],
        ["Supplier's Reference", document.supplier_reference || ""],
        ["Other Reference", document.other_reference || ""],
        ["Buyer's Order No", document.buyers_order_no || ""],
        ["Buyer's Order Date", formatDate(document.buyers_order_date)],
        ["Dispatch Doc No", document.dispatch_doc_no || ""],
        ["Dispatched Through", document.dispatched_through || ""],
        ["Destination", document.destination || ""],
        ["Terms of Delivery", document.terms_of_delivery || ""],
        ["Transport Mode", document.transport_mode || ""],
        ["Vehicle Number", document.vehicle_number || ""],
        ["Date of Supply", formatDate(document.date_of_supply)],
      ] as [string, string][]
    ).filter(([, v]) => v);

    if (fields.length === 0) return;

    const colWidth = CONTENT_WIDTH / 2 - 8;
    doc.fontSize(8);
    for (let i = 0; i < fields.length; i += 2) {
      const rowY = state.y;
      let maxH = 0;
      for (let c = 0; c < 2; c++) {
        const field = fields[i + c];
        if (!field) continue;
        const x = CONTENT_LEFT + c * (colWidth + 16);
        doc.fillColor(MUTED).text(`${field[0]}: `, x, rowY, { continued: true, width: colWidth });
        doc.fillColor(DARK).text(field[1], { width: colWidth });
        maxH = Math.max(maxH, doc.y - rowY);
      }
      state.y = rowY + Math.max(maxH, 12);
    }
    state.y += 6;
    doc.moveTo(CONTENT_LEFT, state.y).lineTo(CONTENT_RIGHT, state.y).strokeColor(BORDER).stroke();
    state.y += 10;
  }

  function drawTableHeader() {
    doc.rect(CONTENT_LEFT, state.y, CONTENT_WIDTH, 20).fill(HEADER_BG);
    doc.fillColor("#ffffff").fontSize(8.5);
    doc.text("#", TABLE_COLS.sno.x + 4, state.y + 6, { width: TABLE_COLS.sno.width });
    doc.text("Particulars", TABLE_COLS.desc.x, state.y + 6, { width: TABLE_COLS.desc.width });
    doc.text("HSN/SAC", TABLE_COLS.hsn.x, state.y + 6, { width: TABLE_COLS.hsn.width, align: "right" });
    doc.text("GST%", TABLE_COLS.gst.x, state.y + 6, { width: TABLE_COLS.gst.width, align: "right" });
    doc.text("Qty", TABLE_COLS.qty.x, state.y + 6, { width: TABLE_COLS.qty.width, align: "right" });
    doc.text("Rate", TABLE_COLS.rate.x, state.y + 6, { width: TABLE_COLS.rate.width, align: "right" });
    doc.text("Amount", TABLE_COLS.amount.x, state.y + 6, { width: TABLE_COLS.amount.width, align: "right" });
    state.y += 24;
  }

  function newPage(continuationHeader: boolean) {
    doc.addPage();
    state.page += 1;
    state.y = PAGE_MARGIN;
    if (continuationHeader) drawContinuationHeader();
  }

  function ensureSpace(height: number) {
    if (state.y + height > BOTTOM_LIMIT) {
      newPage(true);
      drawTableHeader();
    }
  }

  // ---- Page 1 header ----
  drawMainHeader();
  drawBuyerConsignee();
  drawReferenceGrid();
  drawTableHeader();

  // ---- Line items ----
  doc.fontSize(8.5).fillColor(DARK);
  items.forEach((item, idx) => {
    const descHeight = doc.heightOfString(item.description, { width: TABLE_COLS.desc.width });
    const rowHeight = Math.max(18, descHeight + 6);
    ensureSpace(rowHeight);
    const y = state.y;
    doc.fillColor(DARK);
    doc.text(String(idx + 1), TABLE_COLS.sno.x + 4, y, { width: TABLE_COLS.sno.width });
    doc.text(item.description, TABLE_COLS.desc.x, y, { width: TABLE_COLS.desc.width });
    doc.text(item.hsn_code || "-", TABLE_COLS.hsn.x, y, { width: TABLE_COLS.hsn.width, align: "right" });
    doc.text(`${item.tax_rate}%`, TABLE_COLS.gst.x, y, { width: TABLE_COLS.gst.width, align: "right" });
    doc.text(String(item.qty), TABLE_COLS.qty.x, y, { width: TABLE_COLS.qty.width, align: "right" });
    doc.text(formatMoney(item.rate), TABLE_COLS.rate.x, y, { width: TABLE_COLS.rate.width, align: "right" });
    doc.text(formatMoney(item.line_total), TABLE_COLS.amount.x, y, { width: TABLE_COLS.amount.width, align: "right" });
    state.y += rowHeight;
  });

  doc.moveTo(CONTENT_LEFT, state.y).lineTo(CONTENT_RIGHT, state.y).strokeColor(BORDER).stroke();
  state.y += 6;

  // ---- Totals row ----
  doc.fontSize(9).fillColor(DARK);
  doc.text("Total", TABLE_COLS.desc.x, state.y, { width: TABLE_COLS.hsn.x - TABLE_COLS.desc.x });
  doc.text(
    String(items.reduce((sum, i) => sum + i.qty, 0)),
    TABLE_COLS.qty.x,
    state.y,
    { width: TABLE_COLS.qty.width, align: "right" }
  );
  doc.font("Helvetica-Bold").text(formatMoney(subtotal), TABLE_COLS.amount.x, state.y, {
    width: TABLE_COLS.amount.width,
    align: "right",
  });
  doc.font("Helvetica");
  state.y += 22;

  // ---- Footer block (kept together - moves to a new page as a whole if it won't fit) ----
  const hsnGroups = groupByHsn(items);
  const footerHeight = 150 + hsnGroups.length * 14;
  if (state.y + footerHeight > BOTTOM_LIMIT) {
    newPage(true);
  }

  doc.fontSize(9).fillColor(DARK).text("Amount Chargeable (in words):", CONTENT_LEFT, state.y);
  doc.font("Helvetica-Bold").text(amountInWords(grandTotal), CONTENT_LEFT, doc.y + 2, { width: CONTENT_WIDTH });
  doc.font("Helvetica");
  state.y = doc.y + 10;

  // Tax breakup table
  const taxCols = {
    hsn: { x: CONTENT_LEFT, width: 90 },
    taxable: { x: CONTENT_LEFT + 90, width: 85 },
    central: { x: CONTENT_LEFT + 175, width: 110 },
    state_: { x: CONTENT_LEFT + 285, width: 110 },
    inter: { x: CONTENT_LEFT + 395, width: CONTENT_RIGHT - (CONTENT_LEFT + 395) },
  };
  doc.rect(CONTENT_LEFT, state.y, CONTENT_WIDTH, 16).fill("#f1f5f4");
  doc.fillColor(GRAY).fontSize(7.5);
  doc.text("HSN/SAC", taxCols.hsn.x + 4, state.y + 4, { width: taxCols.hsn.width });
  doc.text("Taxable Value", taxCols.taxable.x, state.y + 4, { width: taxCols.taxable.width, align: "right" });
  doc.text("Central Tax", taxCols.central.x, state.y + 4, { width: taxCols.central.width, align: "right" });
  doc.text("State Tax", taxCols.state_.x, state.y + 4, { width: taxCols.state_.width, align: "right" });
  doc.text("Interstate Tax", taxCols.inter.x, state.y + 4, { width: taxCols.inter.width, align: "right" });
  state.y += 18;

  doc.fontSize(8).fillColor(DARK);
  hsnGroups.forEach((group) => {
    const split = computeGstSplit([{ qty: 1, rate: group.taxableValue, tax_rate: group.taxRate }], company.state, customer.state);
    const y = state.y;
    doc.text(group.hsnCode, taxCols.hsn.x + 4, y, { width: taxCols.hsn.width });
    doc.text(formatMoney(group.taxableValue), taxCols.taxable.x, y, { width: taxCols.taxable.width, align: "right" });
    const centralText = split.cgstTotal > 0 ? `${(group.taxRate / 2).toFixed(1)}%  ${formatMoney(split.cgstTotal)}` : "-";
    const stateText = split.sgstTotal > 0 ? `${(group.taxRate / 2).toFixed(1)}%  ${formatMoney(split.sgstTotal)}` : "-";
    const interText = split.igstTotal > 0 ? `${group.taxRate}%  ${formatMoney(split.igstTotal)}` : "-";
    doc.text(centralText, taxCols.central.x, y, { width: taxCols.central.width, align: "right" });
    doc.text(stateText, taxCols.state_.x, y, { width: taxCols.state_.width, align: "right" });
    doc.text(interText, taxCols.inter.x, y, { width: taxCols.inter.width, align: "right" });
    state.y += 14;
  });

  doc.moveTo(CONTENT_LEFT, state.y).lineTo(CONTENT_RIGHT, state.y).strokeColor(BORDER).stroke();
  state.y += 4;
  doc.font("Helvetica-Bold").fontSize(8);
  doc.text("Total", taxCols.hsn.x + 4, state.y, { width: taxCols.hsn.width });
  doc.text(formatMoney(subtotal), taxCols.taxable.x, state.y, { width: taxCols.taxable.width, align: "right" });
  doc.text(cgstTotal > 0 ? formatMoney(cgstTotal) : "-", taxCols.central.x, state.y, { width: taxCols.central.width, align: "right" });
  doc.text(sgstTotal > 0 ? formatMoney(sgstTotal) : "-", taxCols.state_.x, state.y, { width: taxCols.state_.width, align: "right" });
  doc.text(igstTotal > 0 ? formatMoney(igstTotal) : "-", taxCols.inter.x, state.y, { width: taxCols.inter.width, align: "right" });
  doc.font("Helvetica");
  state.y += 20;

  // Grand total summary (right-aligned box)
  const summaryX = CONTENT_RIGHT - 220;
  doc.fontSize(9).fillColor(GRAY);
  doc.text("Subtotal:", summaryX, state.y, { width: 130, align: "right" });
  doc.text(formatMoney(subtotal), summaryX + 130, state.y, { width: 90, align: "right" });
  state.y += 14;
  if (isInterState) {
    doc.text("IGST:", summaryX, state.y, { width: 130, align: "right" });
    doc.text(formatMoney(igstTotal), summaryX + 130, state.y, { width: 90, align: "right" });
    state.y += 14;
  } else {
    doc.text("CGST:", summaryX, state.y, { width: 130, align: "right" });
    doc.text(formatMoney(cgstTotal), summaryX + 130, state.y, { width: 90, align: "right" });
    state.y += 14;
    doc.text("SGST:", summaryX, state.y, { width: 130, align: "right" });
    doc.text(formatMoney(sgstTotal), summaryX + 130, state.y, { width: 90, align: "right" });
    state.y += 14;
  }
  doc.fontSize(11).fillColor(DARK).font("Helvetica-Bold");
  doc.text("Grand Total:", summaryX, state.y, { width: 130, align: "right" });
  doc.text(`Rs. ${formatMoney(grandTotal)}`, summaryX + 130, state.y, { width: 90, align: "right" });
  doc.font("Helvetica");
  state.y += 26;

  // Declaration + Bank details + signatures
  doc.fontSize(7.5).fillColor(MUTED);
  doc.text(
    "Declaration: We declare that this quotation shows the actual price of the goods described and that all particulars are true and correct.",
    CONTENT_LEFT,
    state.y,
    { width: CONTENT_WIDTH }
  );
  state.y = doc.y + 12;

  const bankColWidth = CONTENT_WIDTH / 2 - 8;
  const bankY = state.y;
  if (company.bank_name || company.bank_account_no || company.bank_ifsc) {
    doc.fontSize(8).fillColor(MUTED).text("BANK DETAILS", CONTENT_LEFT, bankY);
    doc.fontSize(8).fillColor(GRAY);
    if (company.bank_name) doc.text(`Bank: ${company.bank_name}`, CONTENT_LEFT, doc.y + 2, { width: bankColWidth });
    if (company.bank_account_no) doc.text(`A/c No: ${company.bank_account_no}`, CONTENT_LEFT, doc.y, { width: bankColWidth });
    if (company.bank_ifsc) doc.text(`IFSC: ${company.bank_ifsc}`, CONTENT_LEFT, doc.y, { width: bankColWidth });
  }

  const sigX = CONTENT_LEFT + CONTENT_WIDTH / 2 + 8;
  doc.fontSize(8).fillColor(GRAY).text(`For ${company.name}`, sigX, bankY, { width: bankColWidth, align: "center" });
  doc.text(" ", sigX, doc.y + 24);
  doc.fontSize(8).fillColor(GRAY).text("Authorised Signatory", sigX, doc.y, { width: bankColWidth, align: "center" });

  state.y = Math.max(doc.y, bankY + 60) + 4;

  // ---- Per-page footer note + page numbers ----
  // Writing this close to the bottom edge sits right on pdfkit's own margin
  // boundary, which would otherwise auto-insert a blank page to "fit" it -
  // temporarily zero the bottom margin so this reserved strip doesn't trigger
  // pdfkit's own pagination on top of ours.
  const pageRange = doc.bufferedPageRange();
  for (let i = 0; i < pageRange.count; i++) {
    doc.switchToPage(pageRange.start + i);
    const originalBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .fontSize(7)
      .fillColor(MUTED)
      .text(
        `This is a computer-generated quotation and does not require a signature.   Page ${i + 1} of ${pageRange.count}`,
        CONTENT_LEFT,
        PAGE_HEIGHT - PAGE_MARGIN,
        { width: CONTENT_WIDTH, align: "center" }
      );
    doc.page.margins.bottom = originalBottomMargin;
  }

  doc.end();
}
