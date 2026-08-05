import path from "path";
import PDFDocument from "pdfkit";
import { Response } from "express";
import { Company, Customer, Receipt, DocumentRecord, PaymentMode } from "../../types";
import { amountInWords } from "../../utils/numberToWords";

const PAGE_MARGIN = 40;
const PAGE_WIDTH = 595.28; // A4
const CONTENT_LEFT = PAGE_MARGIN;
const CONTENT_RIGHT = PAGE_WIDTH - PAGE_MARGIN;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;

const LOGO_PATH = path.join(__dirname, "../../../client/src/assets/logo-black.png");

const GREEN = "#16A34A";
const DARK = "#111111";
const GRAY = "#444444";
const MUTED = "#888888";
const BORDER = "#e2e8f0";

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

const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  cash: "Cash",
  cheque: "Cheque",
  bank_transfer: "Bank Transfer",
  upi: "UPI",
  card: "Card",
  other: "Other",
};

export function streamReceiptPdf(
  res: Response,
  receipt: Receipt,
  customer: Customer,
  company: Company,
  invoice: DocumentRecord | null
) {
  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${receipt.receipt_no.replace(/\//g, "-")}.pdf"`);
  doc.pipe(res);

  const logoSize = 44;
  try {
    doc.image(LOGO_PATH, CONTENT_LEFT, PAGE_MARGIN, { fit: [logoSize, logoSize] });
  } catch {
    // Logo missing - skip silently.
  }

  const textX = CONTENT_LEFT + logoSize + 10;
  const textWidth = 260;
  doc.fontSize(15).fillColor(GREEN).text(company.name.toUpperCase(), textX, PAGE_MARGIN, { width: textWidth });
  doc.fontSize(8).fillColor(GRAY);
  if (company.tagline) doc.text(company.tagline, textX, doc.y, { width: textWidth });
  if (company.address) doc.text(company.address, textX, doc.y, { width: textWidth });
  const contactLine = [company.phone, company.email].filter(Boolean).join("  |  ");
  if (contactLine) doc.text(contactLine, textX, doc.y, { width: textWidth });
  if (company.gstin) doc.text(`GSTIN: ${company.gstin}`, textX, doc.y, { width: textWidth });

  const rightX = CONTENT_LEFT + 320;
  const rightWidth = CONTENT_RIGHT - rightX;
  doc.fontSize(16).fillColor(DARK).text("RECEIPT", rightX, PAGE_MARGIN, { width: rightWidth, align: "right" });
  doc.fontSize(9).fillColor(GRAY);
  doc.text(`No: ${receipt.receipt_no}`, rightX, doc.y + 4, { width: rightWidth, align: "right" });
  doc.text(`Date: ${formatDate(receipt.received_date)}`, rightX, doc.y, { width: rightWidth, align: "right" });

  let y = Math.max(doc.y, PAGE_MARGIN + logoSize) + 12;
  doc.moveTo(CONTENT_LEFT, y).lineTo(CONTENT_RIGHT, y).strokeColor(BORDER).stroke();
  y += 16;

  doc.fontSize(8).fillColor(MUTED).text("RECEIVED FROM", CONTENT_LEFT, y);
  doc.fontSize(10.5).fillColor(DARK).text(customer.name, CONTENT_LEFT, doc.y + 2);
  doc.fontSize(9).fillColor(GRAY);
  if (customer.billing_address) doc.text(customer.billing_address, CONTENT_LEFT, doc.y, { width: CONTENT_WIDTH });
  if (customer.gstin) doc.text(`GSTIN: ${customer.gstin}`, CONTENT_LEFT, doc.y);
  y = doc.y + 20;

  // Amount box
  doc.rect(CONTENT_LEFT, y, CONTENT_WIDTH, 50).fillAndStroke("#f1f9f4", BORDER);
  doc.fontSize(9).fillColor(MUTED).text("Amount Received", CONTENT_LEFT + 12, y + 8);
  doc.fontSize(18).fillColor(GREEN).font("Helvetica-Bold").text(`Rs. ${formatMoney(Number(receipt.amount))}`, CONTENT_LEFT + 12, y + 20);
  doc.font("Helvetica");
  y += 62;

  doc.fontSize(9).fillColor(DARK).text("In words: ", CONTENT_LEFT, y, { continued: true });
  doc.font("Helvetica-Bold").text(amountInWords(Number(receipt.amount)), { width: CONTENT_WIDTH - 60 });
  doc.font("Helvetica");
  y = doc.y + 14;

  const colWidth = CONTENT_WIDTH / 2 - 8;
  doc.fontSize(9).fillColor(MUTED).text("Payment Mode: ", CONTENT_LEFT, y, { continued: true, width: colWidth });
  doc.fillColor(DARK).text(PAYMENT_MODE_LABELS[receipt.payment_mode], { width: colWidth });
  if (receipt.reference_no) {
    doc.fillColor(MUTED).text("Reference No: ", CONTENT_LEFT + colWidth + 16, y, { continued: true, width: colWidth });
    doc.fillColor(DARK).text(receipt.reference_no, { width: colWidth });
  }
  y = Math.max(doc.y, y + 14) + 4;

  if (invoice) {
    doc.fontSize(9).fillColor(MUTED).text("Against Invoice: ", CONTENT_LEFT, y, { continued: true, width: colWidth });
    doc.fillColor(DARK).text(`${invoice.doc_number} (${formatDate(invoice.issue_date)})`, { width: colWidth });
    y = doc.y + 14;
  }

  if (receipt.notes) {
    doc.fontSize(9).fillColor(MUTED).text("Notes: ", CONTENT_LEFT, y, { continued: true, width: CONTENT_WIDTH });
    doc.fillColor(DARK).text(receipt.notes);
    y = doc.y + 14;
  }

  y += 40;
  const sigColWidth = CONTENT_WIDTH / 2 - 8;
  const sigX = CONTENT_LEFT + CONTENT_WIDTH / 2 + 8;
  doc.fontSize(8).fillColor(GRAY).text(`For ${company.name}`, sigX, y, { width: sigColWidth, align: "center" });
  doc.text(" ", sigX, y + 30);
  doc.fontSize(8).fillColor(GRAY).text("Authorised Signatory", sigX, doc.y, { width: sigColWidth, align: "center" });

  doc
    .fontSize(7)
    .fillColor(MUTED)
    .text("This is a computer-generated receipt.", CONTENT_LEFT, y + 60, { width: CONTENT_WIDTH, align: "center" });

  doc.end();
}
