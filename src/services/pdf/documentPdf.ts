import path from "path";
import PDFDocument from "pdfkit";
import { Response } from "express";
import { Company, Customer, DocumentItem, DocumentRecord } from "../../types";
import { amountInWords } from "../../utils/numberToWords";
import { EffectiveDocumentTemplate } from "../documentTemplates";

const PAGE_MARGIN = 40;
const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const CONTENT_LEFT = PAGE_MARGIN;
const CONTENT_RIGHT = PAGE_WIDTH - PAGE_MARGIN;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;
const BOTTOM_LIMIT = PAGE_HEIGHT - PAGE_MARGIN - 16; // leave room for the small per-page footer note

const LOGO_PATH = path.join(__dirname, "../../../client/src/assets/logo-black.png");
const LOGO_NATURAL_WIDTH = 493;
const LOGO_NATURAL_HEIGHT = 125;
const LOGO_ICON_FRACTION = 0.4; // approx. share of the artwork occupied by the icon mark, left of the wordmark

// This file's own built-in look, used whenever a (company, doc_type) has no
// Document Templates row (the overwhelmingly common case) - see
// getEffectiveDocumentTemplate's own doc comment. Only the accent green is
// themeable; DARK/GRAY/MUTED/BORDER/LIGHT_BG are neutral ink/paper shades,
// not part of the accent, and stay fixed regardless of template settings.
const DEFAULT_ACCENT = "#1B7A4D";
const DARK = "#181818";
const GRAY = "#4b4b4b";
const MUTED = "#8a8a8a";
const BORDER = "#dfe3e0";
const LIGHT_BG = "#f4f6f5";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

function formatMoney(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatRupees(n: number): string {
  return `Rs. ${formatMoney(n)}`;
}

/** A ~18% darker shade of a hex color, for the table header background -
 * derived from whatever accent color is in effect (custom or built-in)
 * rather than being its own separate configurable field, so a customized
 * accent always gets a consistent, automatically-matching darker tone. */
function darkenHex(hex: string, amount = 0.18): string {
  const n = parseInt(hex.slice(1), 16);
  const clamp = (c: number) => Math.max(0, Math.min(255, Math.round(c * (1 - amount))));
  const r = clamp((n >> 16) & 255);
  const g = clamp((n >> 8) & 255);
  const b = clamp(n & 255);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

const TABLE_COLS = (() => {
  const widths = {
    sno: 22,
    desc: 135,
    hsn: 40,
    qty: 30,
    unit: 35,
    rate: 55,
    disc: 32,
    taxable: 62,
    gst: 30,
    amount: 74,
  };
  let x = CONTENT_LEFT;
  const cols: Record<string, { x: number; width: number }> = {};
  for (const key of Object.keys(widths) as (keyof typeof widths)[]) {
    cols[key] = { x, width: widths[key] };
    x += widths[key];
  }
  return cols as Record<keyof typeof widths, { x: number; width: number }>;
})();

/**
 * Renders any sales document (Quotation, Proforma Invoice, Delivery Challan,
 * Tax Invoice) onto a multi-page-aware PDF matching the company's printed Tax
 * Invoice template: a header with brandmark + document title, a light-gray
 * meta bar, Bill To / Ship To cards, an item table, a flat totals block,
 * amount-in-words, payment/terms columns, and an acknowledgement + signature
 * footer. The company header repeats on every page (full on page 1, condensed
 * on continuation pages), the table header repeats, and the closing block is
 * measured up front and pushed onto a fresh page as a whole if it wouldn't
 * otherwise fit - so neither ever splits across a page boundary.
 */
export function streamDocumentPdf(
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
  const titleLower = title.toLowerCase();
  const titleUpper = title.toUpperCase();
  const GREEN = template.accentColor;
  const DARK_GREEN = darkenHex(GREEN);

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

  function drawBrandmark(x: number, y: number, height: number): number {
    const scale = height / LOGO_NATURAL_HEIGHT;
    // show_logo=false hides only the icon graphic, not the company name
    // text next to it - dropping the company's own name off its printed
    // documents entirely is never a sensible default, so this reserves no
    // icon width at all rather than leaving a blank gap.
    const iconWidth = template.showLogo ? LOGO_ICON_FRACTION * LOGO_NATURAL_WIDTH * scale : 0;
    if (template.showLogo) {
      try {
        doc.save();
        doc.rect(x, y, iconWidth, height).clip();
        doc.image(LOGO_PATH, x, y, { height });
        doc.restore();
      } catch {
        // Logo missing - skip silently rather than fail PDF generation.
      }
    }

    const words = company.name.trim().split(/\s+/);
    const line1 = words[0] || company.name;
    const line2 = words.slice(1).join(" ");
    const textX = x + iconWidth + 8;
    doc.fillColor(DARK).font("Helvetica-Bold").fontSize(height * 0.34);
    doc.text(line1.toUpperCase(), textX, y - 2);
    if (line2) {
      doc.fontSize(height * 0.24).text(line2.toUpperCase(), textX, doc.y - 2);
    }
    doc.font("Helvetica");
    return Math.max(iconWidth + 8 + doc.widthOfString(line1.toUpperCase()), iconWidth);
  }

  function drawMainHeader() {
    const brandHeight = 44;
    drawBrandmark(CONTENT_LEFT, state.y, brandHeight);
    let y = state.y + brandHeight + 6;

    doc.fontSize(8.5).fillColor(GRAY).font("Helvetica");
    if (company.tagline) {
      doc.text(company.tagline, CONTENT_LEFT, y, { width: 340 });
      y = doc.y;
    }
    const line2 = [company.address, company.phone ? `Ph: ${company.phone}` : null].filter(Boolean).join("  |  ");
    if (line2) {
      doc.fillColor(MUTED).text(line2, CONTENT_LEFT, y, { width: 340 });
      y = doc.y;
    }

    const rightWidth = 260;
    const rightX = CONTENT_RIGHT - rightWidth;
    doc.font("Times-Bold").fontSize(20).fillColor(DARK).text(titleUpper, rightX, PAGE_MARGIN, { width: rightWidth, align: "right" });
    if (template.headerLabel) {
      doc.font("Helvetica-Oblique").fontSize(8.5).fillColor(MUTED);
      doc.text(template.headerLabel, rightX, doc.y + 2, { width: rightWidth, align: "right" });
    }
    doc.font("Helvetica");

    state.y = Math.max(y, doc.y) + 10;
    doc.moveTo(CONTENT_LEFT, state.y).lineTo(CONTENT_RIGHT, state.y).lineWidth(1.5).strokeColor(GREEN).stroke();
    state.y += 14;
  }

  function drawContinuationHeader() {
    drawBrandmark(CONTENT_LEFT, state.y, 20);
    doc.fontSize(8.5).fillColor(GRAY);
    doc.text(
      `${title} No: ${document.doc_number}   |   Date: ${formatDate(document.issue_date)}   (Continued)`,
      CONTENT_LEFT,
      state.y + 24
    );
    state.y = Math.max(doc.y, state.y + 20) + 8;
    doc.moveTo(CONTENT_LEFT, state.y).lineTo(CONTENT_RIGHT, state.y).strokeColor(BORDER).stroke();
    state.y += 10;
  }

  function metaRow(label: string, value: string, x: number, y: number, width: number): number {
    if (!value) return y;
    doc.fontSize(8).fillColor(MUTED).font("Helvetica").text(label, x, y, { continued: true, width });
    doc.fillColor(DARK).font("Helvetica-Bold").text(` ${value}`, { width });
    doc.font("Helvetica");
    return doc.y;
  }

  function drawMetaBar() {
    const boxY = state.y;
    const pad = 10;
    const rowStep = 13;
    const boxHeight = rowStep * 3 + 16;

    // Each conceptual group is filtered to only its populated rows, and any
    // group left with nothing to show is dropped entirely - an empty group
    // used to still draw its bordered column, rendering as an obviously
    // blank box (e.g. a document with no PO reference at all) rather than
    // adapting. The remaining groups then split the full width evenly.
    const section1: [string, string][] = (
      [
        [`${title} No.:`, document.doc_number],
        [`${title} Date:`, formatDate(document.issue_date)],
        ["Due Date:", formatDate(document.due_date)],
      ] as [string, string][]
    ).filter(([, v]) => v);
    const section2: [string, string][] = (
      [
        ["Reference / PO No.:", document.buyers_order_no || ""],
        ["PO Date:", formatDate(document.buyers_order_date)],
        ["Delivery Challan No.:", document.dispatch_doc_no || ""],
      ] as [string, string][]
    ).filter(([, v]) => v);
    const section3: [string, string][] = (
      [
        ["Place of Supply:", document.place_of_supply || ""],
        ["Reverse Charge:", Boolean(document.reverse_charge) ? "Yes" : "No"],
        ["GSTIN:", company.gstin || ""],
      ] as [string, string][]
    ).filter(([, v]) => v);

    const sections = [section1, section2, section3].filter((s) => s.length > 0);
    const colCount = Math.max(sections.length, 1);
    const colWidth = CONTENT_WIDTH / colCount;

    doc.rect(CONTENT_LEFT, boxY, CONTENT_WIDTH, boxHeight).fillColor(LIGHT_BG).fill();
    doc.rect(CONTENT_LEFT, boxY, CONTENT_WIDTH, boxHeight).strokeColor(BORDER).stroke();
    for (let i = 1; i < colCount; i++) {
      const x = CONTENT_LEFT + colWidth * i;
      doc.moveTo(x, boxY).lineTo(x, boxY + boxHeight).strokeColor(BORDER).stroke();
    }

    sections.forEach((section, i) => {
      const x = CONTENT_LEFT + colWidth * i + pad;
      let y = boxY + 8;
      section.forEach(([label, value]) => {
        y = metaRow(label, value, x, y, colWidth - pad * 2) + 2;
      });
    });

    state.y = boxY + boxHeight + 14;
  }

  function drawBuyerConsignee() {
    const colWidth = CONTENT_WIDTH / 2 - 8;
    const startY = state.y;
    const pad = 10;

    function card(headerText: string, x: number, name: string, lines: string[]): number {
      doc.fontSize(8).fillColor(GREEN).font("Helvetica-Bold").text(headerText, x + pad, startY + 8, {
        width: colWidth - pad * 2,
        characterSpacing: 1.2,
      });
      doc.fontSize(9.5).fillColor(DARK).text(name, x + pad, doc.y + 3, { width: colWidth - pad * 2 });
      doc.fontSize(8.3).fillColor(GRAY).font("Helvetica");
      for (const line of lines) {
        if (line) doc.text(line, x + pad, doc.y + 1, { width: colWidth - pad * 2 });
      }
      return doc.y;
    }

    const rightX = CONTENT_LEFT + CONTENT_WIDTH / 2 + 8;

    const billLines = [
      customer.billing_address || "",
      [customer.gstin ? `GSTIN: ${customer.gstin}` : null, customer.state ? `State: ${customer.state}` : null]
        .filter(Boolean)
        .join("  |  "),
      customer.phone ? `Phone: ${customer.phone}` : "",
    ];
    const leftBottom = card("BILL TO", CONTENT_LEFT, customer.name, billLines);

    const hasConsignee = !!document.consignee_name;
    const shipName = hasConsignee ? document.consignee_name! : customer.name;
    const shipAddress = hasConsignee ? document.consignee_address || "" : customer.shipping_address || customer.billing_address || "";
    const shipGstin = hasConsignee ? document.consignee_gstin : customer.gstin;
    const shipState = hasConsignee ? document.consignee_state : customer.state;
    const shipLines = [
      shipAddress,
      [shipGstin ? `GSTIN: ${shipGstin}` : null, shipState ? `State: ${shipState}` : null].filter(Boolean).join("  |  "),
    ];
    const rightBottom = card("SHIP TO", rightX, shipName, shipLines);

    const boxHeight = Math.max(leftBottom, rightBottom) - startY + 8;
    doc.rect(CONTENT_LEFT, startY, colWidth + pad * 2, boxHeight).strokeColor(BORDER).stroke();
    doc.rect(rightX, startY, colWidth + pad * 2, boxHeight).strokeColor(BORDER).stroke();

    state.y = startY + boxHeight + 14;
  }

  function drawTableHeader() {
    const headerHeight = 26;
    doc.rect(CONTENT_LEFT, state.y, CONTENT_WIDTH, headerHeight).fill(DARK_GREEN);
    doc.fillColor("#ffffff").fontSize(7.5).font("Helvetica-Bold");
    const midY = state.y + 4;
    doc.text("S.No", TABLE_COLS.sno.x + 3, midY, { width: TABLE_COLS.sno.width });
    doc.text("Description of Goods", TABLE_COLS.desc.x + 3, midY, { width: TABLE_COLS.desc.width - 6 });
    doc.text("HSN", TABLE_COLS.hsn.x, midY, { width: TABLE_COLS.hsn.width, align: "right" });
    doc.text("Qty", TABLE_COLS.qty.x, midY, { width: TABLE_COLS.qty.width, align: "right" });
    doc.text("Unit", TABLE_COLS.unit.x, midY, { width: TABLE_COLS.unit.width, align: "right" });
    doc.text("Rate (Rs.)", TABLE_COLS.rate.x, midY, { width: TABLE_COLS.rate.width, align: "right" });
    doc.text("Disc.", TABLE_COLS.disc.x, midY, { width: TABLE_COLS.disc.width, align: "right" });
    doc.text("Taxable Value (Rs.)", TABLE_COLS.taxable.x, midY, { width: TABLE_COLS.taxable.width, align: "right" });
    doc.text("GST %", TABLE_COLS.gst.x, midY, { width: TABLE_COLS.gst.width, align: "right" });
    doc.text("Amount (Rs.)", TABLE_COLS.amount.x - 4, midY, { width: TABLE_COLS.amount.width, align: "right" });
    doc.font("Helvetica");
    state.y += headerHeight + 2;
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
  drawMetaBar();
  drawBuyerConsignee();
  drawTableHeader();

  // ---- Line items ----
  items.forEach((item, idx) => {
    const baseAmount = item.qty * item.rate;
    const discountAmt = (baseAmount * (item.discount_percent || 0)) / 100;
    const taxableValue = baseAmount - discountAmt;

    const descHeight = doc.fontSize(8.3).heightOfString(item.description, { width: TABLE_COLS.desc.width - 6 });
    const rowHeight = Math.max(20, descHeight + 8);
    ensureSpace(rowHeight);
    const y = state.y + 4;
    doc.fillColor(DARK).fontSize(8.3);
    doc.text(String(idx + 1), TABLE_COLS.sno.x + 3, y, { width: TABLE_COLS.sno.width });
    doc.text(item.description, TABLE_COLS.desc.x + 3, y, { width: TABLE_COLS.desc.width - 6 });
    doc.text(item.hsn_code || "-", TABLE_COLS.hsn.x, y, { width: TABLE_COLS.hsn.width, align: "right" });
    doc.text(String(item.qty), TABLE_COLS.qty.x, y, { width: TABLE_COLS.qty.width, align: "right" });
    doc.text(item.unit, TABLE_COLS.unit.x, y, { width: TABLE_COLS.unit.width, align: "right" });
    doc.text(formatMoney(item.rate), TABLE_COLS.rate.x, y, { width: TABLE_COLS.rate.width, align: "right" });
    doc.text(
      item.discount_percent ? `${Number(item.discount_percent)}%` : "0%",
      TABLE_COLS.disc.x,
      y,
      { width: TABLE_COLS.disc.width, align: "right" }
    );
    doc.text(formatMoney(taxableValue), TABLE_COLS.taxable.x, y, { width: TABLE_COLS.taxable.width, align: "right" });
    doc.text(`${Number(item.tax_rate)}%`, TABLE_COLS.gst.x, y, { width: TABLE_COLS.gst.width, align: "right" });
    doc.text(formatMoney(item.line_total), TABLE_COLS.amount.x - 4, y, { width: TABLE_COLS.amount.width, align: "right" });
    state.y += rowHeight;
  });

  doc.moveTo(CONTENT_LEFT, state.y).lineTo(CONTENT_RIGHT, state.y).strokeColor(BORDER).stroke();
  state.y += 10;

  // ---- Footer block (kept together - moves to a new page as a whole if it won't fit) ----
  const taxLabel = isInterState ? [["IGST", igstTotal]] : [
    ["CGST", cgstTotal],
    ["SGST", sgstTotal],
  ];
  // Per-document text wins first (picked from a template and/or hand-edited
  // on this document), then the company-wide default (Settings > Terms &
  // Conditions), then the built-in wording below - one line per bullet,
  // blank lines ignored.
  const termsAndConditions = (document.terms_and_conditions || company.terms_and_conditions)
    ? (document.terms_and_conditions || company.terms_and_conditions)!.split("\n").map((line) => line.trim()).filter(Boolean)
    : [
        `Goods once sold will not be taken back unless otherwise agreed in writing.`,
        `Payment shall be made according to the agreed payment terms.`,
        `Any shortage or damage should be reported immediately upon receipt of goods.`,
        `Warranty, where applicable, is governed by the agreed quotation / order terms.`,
        `Transportation and installation charges are applicable as agreed.`,
        `All disputes are subject to Chennai jurisdiction.`,
        `This ${titleLower} is subject to applicable GST laws and regulations.`,
      ];

  // The closing block below must never split across a page, so its full
  // height is measured up front - using pdfkit's own text-measurement calls
  // at the exact font/width each piece will render with, not a rough guess
  // - and pushed onto a fresh page as a whole if it wouldn't fit. An
  // inaccurate estimate here either wastes most of a page (false positive,
  // e.g. guessing 8 payment rows when only 5 are populated) or splits
  // content mid-block (false negative) - both look unprofessional.

  // Totals always render the same 8 rows (subtotal, discount, freight,
  // installation, and all three of IGST/CGST/SGST - the non-applicable
  // split always prints as zero rather than being omitted - plus round
  // off), so this block's height never varies with the data.
  const totalsBlockHeight = 8 * 15 + 4 + 6 + 18;

  const wordsText = amountInWords(grandTotal);
  const wordsLabel = "Amount in Words: ";
  const wordsLabelWidth = doc.font("Helvetica-Bold").fontSize(9).widthOfString(wordsLabel) + 4;
  const wordsValueWidth = CONTENT_WIDTH - wordsLabelWidth - 20;
  const wordsHeight = Math.max(20, doc.font("Helvetica").fontSize(9).heightOfString(wordsText, { width: wordsValueWidth }) + 16);

  const footerColWidth = CONTENT_WIDTH / 2 - 10;
  const paymentLabelWidth = footerColWidth * 0.4;
  const paymentValueWidth = footerColWidth * 0.6;
  const paymentRows: [string, string][] = template.showBankDetails
    ? ((
        [
          ["Account Name", company.name],
          ["Bank Name", company.bank_name],
          ["Account No.", company.bank_account_no],
          ["IFSC Code", company.bank_ifsc],
          ["Payment Terms", document.mode_terms_of_payment],
          ["Credit Period", document.credit_period],
        ] as [string, string | null][]
      ).filter(([, value]) => value) as [string, string][])
    : [];

  let paymentSectionHeight = 16; // header line + gap, matches the render pass below
  for (const [label, value] of paymentRows) {
    const labelHeight = doc.fontSize(8.3).font("Helvetica").heightOfString(label, { width: paymentLabelWidth });
    const valueHeight = doc.fontSize(8.3).font("Helvetica-Bold").heightOfString(value, { width: paymentValueWidth });
    paymentSectionHeight += Math.max(labelHeight, valueHeight) + 4;
  }

  let termsSectionHeight = 16; // header line + gap
  doc.fontSize(7.8).font("Helvetica");
  termsAndConditions.forEach((term, i) => {
    termsSectionHeight += doc.heightOfString(`${i + 1}. ${term}`, { width: footerColWidth }) + 3;
  });
  doc.font("Helvetica");

  const ackSectionHeight = template.showSignatureBlock ? 62 : 0;

  const estimatedFooterHeight =
    totalsBlockHeight + 12 + wordsHeight + 14 + Math.max(paymentSectionHeight, termsSectionHeight) + 16 + ackSectionHeight;

  if (state.y + estimatedFooterHeight > BOTTOM_LIMIT) {
    newPage(true);
  }

  // ---- Totals ----
  const summaryLabelWidth = 170;
  const summaryValueWidth = 110;
  const summaryX = CONTENT_RIGHT - summaryLabelWidth - summaryValueWidth;

  function totalsRow(label: string, value: number, bold = false) {
    doc.fontSize(bold ? 10.5 : 9).fillColor(bold ? DARK : GRAY).font(bold ? "Helvetica-Bold" : "Helvetica");
    doc.text(label, summaryX, state.y, { width: summaryLabelWidth, align: "right" });
    doc.text(formatRupees(value), summaryX + summaryLabelWidth, state.y, { width: summaryValueWidth, align: "right" });
    state.y += bold ? 18 : 15;
  }

  totalsRow("Subtotal / Taxable Value", subtotal);
  totalsRow("Discount", discountAmount);
  totalsRow("Freight / Transportation", freightCharges);
  totalsRow("Installation / Other Charges", installationCharges);
  for (const [label, value] of taxLabel as [string, number][]) {
    totalsRow(label, value);
  }
  if (!isInterState) {
    totalsRow("IGST", 0);
  } else {
    totalsRow("CGST", 0);
    totalsRow("SGST", 0);
  }
  totalsRow("Round Off", roundOff);
  state.y += 4;
  doc.moveTo(summaryX, state.y).lineTo(CONTENT_RIGHT, state.y).strokeColor(BORDER).stroke();
  state.y += 6;
  totalsRow("Grand Total", grandTotal, true);
  doc.font("Helvetica");
  state.y += 12;

  // ---- Amount in words ----
  // (wordsText/wordsLabelWidth/wordsValueWidth/wordsHeight already computed
  // above, for the footer-height measurement pass - reused here as-is so
  // the render can never drift from what was measured.)
  doc.rect(CONTENT_LEFT, state.y, CONTENT_WIDTH, wordsHeight).fillColor(LIGHT_BG).fill();
  doc.fillColor(DARK).font("Helvetica-Bold").fontSize(9).text(wordsLabel, CONTENT_LEFT + 10, state.y + 8, {
    width: wordsLabelWidth,
    lineBreak: false,
  });
  doc.fillColor(DARK).font("Helvetica").text(wordsText, CONTENT_LEFT + 10 + wordsLabelWidth, state.y + 8, {
    width: wordsValueWidth,
  });
  state.y += wordsHeight + 14;

  // ---- Payment/Bank details + Terms & Conditions ----
  // (footerColWidth/paymentLabelWidth/paymentValueWidth/paymentRows already
  // computed above, for the footer-height measurement pass.)
  const sectionTop = state.y;
  const paymentValueX = CONTENT_LEFT + paymentLabelWidth;

  let paymentBottom = sectionTop;
  if (template.showBankDetails) {
    doc.fontSize(8.5).fillColor(GREEN).font("Helvetica-Bold").text("PAYMENT / BANK DETAILS", CONTENT_LEFT, sectionTop, {
      characterSpacing: 1.2,
    });
    let py = doc.y + 6;
    for (const [label, value] of paymentRows) {
      doc.fontSize(8.3).fillColor(MUTED).font("Helvetica").text(label, CONTENT_LEFT, py, { width: paymentLabelWidth });
      const labelBottom = doc.y;
      doc.fontSize(8.3).fillColor(DARK).font("Helvetica-Bold").text(value, paymentValueX, py, {
        width: paymentValueWidth,
        align: "right",
      });
      py = Math.max(labelBottom, doc.y) + 4;
    }
    paymentBottom = py;
  }

  const rightX = CONTENT_LEFT + CONTENT_WIDTH / 2 + 10;
  doc.fontSize(8.5).fillColor(GREEN).font("Helvetica-Bold").text("TERMS & CONDITIONS", rightX, sectionTop, {
    characterSpacing: 1.2,
  });
  let ty = doc.y + 6;
  doc.fontSize(7.8).fillColor(GRAY).font("Helvetica");
  termsAndConditions.forEach((term, i) => {
    doc.text(`${i + 1}. ${term}`, rightX, ty, { width: footerColWidth });
    ty = doc.y + 3;
  });
  const termsBottom = ty;

  state.y = Math.max(paymentBottom, termsBottom) + 16;

  // ---- Acknowledgement + signature ----
  if (template.showSignatureBlock) {
    doc.font("Helvetica");
    const ackY = state.y;
    doc.fontSize(8.5).fillColor(DARK).font("Helvetica-Bold").text("Customer Acknowledgement", CONTENT_LEFT, ackY);
    doc.fontSize(8).fillColor(GRAY).font("Helvetica").text("Received the above goods in good condition.", CONTENT_LEFT, doc.y + 2);
    doc.text("Name: ______________________     Date: ____________", CONTENT_LEFT, doc.y + 20);

    const sigX = CONTENT_LEFT + CONTENT_WIDTH / 2 + 10;
    const sigColWidth = CONTENT_WIDTH / 2 - 10;
    doc.fontSize(8.5).fillColor(DARK).font("Helvetica-Bold").text(`For ${company.name}`, sigX, ackY, {
      width: sigColWidth,
      align: "right",
    });
    doc.fontSize(8).fillColor(GRAY).font("Helvetica").text("Authorised Signatory (Seal / Signature)", sigX, ackY + 44, {
      width: sigColWidth,
      align: "right",
    });

    state.y = Math.max(doc.y, ackY + 60) + 4;
  }

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
    const footerY = PAGE_HEIGHT - PAGE_MARGIN;
    doc.moveTo(CONTENT_LEFT, footerY - 6).lineTo(CONTENT_RIGHT, footerY - 6).strokeColor(BORDER).stroke();
    doc.fontSize(7).fillColor(MUTED).font("Helvetica");
    doc.text(
      `${company.name} · ${company.state || ""} · GSTIN: ${company.gstin || ""}`,
      CONTENT_LEFT,
      footerY,
      { width: CONTENT_WIDTH / 2 }
    );
    doc.text(`${template.footerNote}   Page ${i + 1} of ${pageRange.count}`, CONTENT_LEFT + CONTENT_WIDTH / 2, footerY, {
      width: CONTENT_WIDTH / 2,
      align: "right",
    });
    doc.page.margins.bottom = originalBottomMargin;
  }

  doc.end();
}
