import PDFDocument from "pdfkit";
import { Response } from "express";
import { DocumentRecord, DocumentItem, Customer } from "../../types";

function formatCurrency(amount: number): string {
  return `Rs. ${amount.toFixed(2)}`;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatDate(date: Date): string {
  return `${String(date.getDate()).padStart(2, "0")} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

const PAGE_MARGIN = 40;
const PAGE_RIGHT = 555;

export function streamQuotationPdf(
  res: Response,
  document: DocumentRecord,
  items: DocumentItem[],
  customer: Customer
) {
  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${document.doc_number.replace(/\//g, "-")}.pdf"`
  );
  doc.pipe(res);

  const companyName = process.env.COMPANY_NAME || "Jose Industries";
  const companyAddress = process.env.COMPANY_ADDRESS || "";
  const companyGstin = process.env.COMPANY_GSTIN || "";
  const companyPhone = process.env.COMPANY_PHONE || "";
  const companyEmail = process.env.COMPANY_EMAIL || "";

  doc.fontSize(18).fillColor("#16A34A").text(companyName);
  doc.fontSize(9).fillColor("#444444");
  if (companyAddress) doc.text(companyAddress);
  const contactLine = [companyPhone, companyEmail].filter(Boolean).join("   |   ");
  if (contactLine) doc.text(contactLine);
  if (companyGstin) doc.text(`GSTIN: ${companyGstin}`);

  doc.moveDown();
  doc.fontSize(14).fillColor("#111111").text("QUOTATION", { align: "right" });
  doc.fontSize(10).fillColor("#444444");
  doc.text(`No: ${document.doc_number}`, { align: "right" });
  doc.text(`Date: ${formatDate(new Date(document.issue_date))}`, { align: "right" });

  doc.moveDown();
  doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_RIGHT, doc.y).strokeColor("#e5e7eb").stroke();
  doc.moveDown();

  doc.fontSize(10).fillColor("#111111").text("Quotation For:");
  doc.fontSize(10).fillColor("#333333").text(customer.name);
  if (customer.billing_address) doc.text(customer.billing_address);
  if (customer.phone) doc.text(`Phone: ${customer.phone}`);
  if (customer.gstin) doc.text(`GSTIN: ${customer.gstin}`);

  doc.moveDown();

  const columns = {
    no: { x: 40, width: 25 },
    desc: { x: 65, width: 215 },
    qty: { x: 280, width: 40 },
    rate: { x: 325, width: 60 },
    tax: { x: 390, width: 45 },
    amount: { x: 440, width: 75 },
  };

  const tableTop = doc.y;
  doc.rect(PAGE_MARGIN, tableTop, PAGE_RIGHT - PAGE_MARGIN, 20).fill("#16A34A");
  doc.fillColor("#ffffff").fontSize(9);
  doc.text("#", columns.no.x, tableTop + 6, { width: columns.no.width });
  doc.text("Description", columns.desc.x, tableTop + 6, { width: columns.desc.width });
  doc.text("Qty", columns.qty.x, tableTop + 6, { width: columns.qty.width, align: "right" });
  doc.text("Rate", columns.rate.x, tableTop + 6, { width: columns.rate.width, align: "right" });
  doc.text("Tax %", columns.tax.x, tableTop + 6, { width: columns.tax.width, align: "right" });
  doc.text("Amount", columns.amount.x, tableTop + 6, { width: columns.amount.width, align: "right" });

  let y = tableTop + 26;
  doc.fillColor("#333333").fontSize(9);
  items.forEach((item, idx) => {
    const rowHeight = 18;
    doc.text(String(idx + 1), columns.no.x, y, { width: columns.no.width });
    doc.text(item.description, columns.desc.x, y, { width: columns.desc.width });
    doc.text(String(item.qty), columns.qty.x, y, { width: columns.qty.width, align: "right" });
    doc.text(item.rate.toFixed(2), columns.rate.x, y, { width: columns.rate.width, align: "right" });
    doc.text(`${item.tax_rate}%`, columns.tax.x, y, { width: columns.tax.width, align: "right" });
    doc.text(item.line_total.toFixed(2), columns.amount.x, y, { width: columns.amount.width, align: "right" });
    y += rowHeight;
  });

  doc.moveTo(PAGE_MARGIN, y).lineTo(PAGE_RIGHT, y).strokeColor("#e5e7eb").stroke();
  y += 12;

  const subtotal = Number(document.subtotal);
  const taxTotal = Number(document.tax_total);
  const grandTotal = Number(document.grand_total);

  const totalLabelX = 300;
  const totalLabelWidth = 135;

  doc.fontSize(9).fillColor("#333333");
  doc.text("Subtotal:", totalLabelX, y, { width: totalLabelWidth, align: "right" });
  doc.text(formatCurrency(subtotal), columns.amount.x, y, { width: columns.amount.width, align: "right" });
  y += 16;
  doc.text("Tax:", totalLabelX, y, { width: totalLabelWidth, align: "right" });
  doc.text(formatCurrency(taxTotal), columns.amount.x, y, { width: columns.amount.width, align: "right" });
  y += 18;
  doc.fontSize(11).fillColor("#111111");
  doc.text("Grand Total:", totalLabelX, y, { width: totalLabelWidth, align: "right" });
  doc.text(formatCurrency(grandTotal), columns.amount.x, y, { width: columns.amount.width, align: "right" });

  if (document.notes) {
    doc.moveDown(3);
    doc.fontSize(9).fillColor("#666666").text(`Notes: ${document.notes}`);
  }

  doc.moveDown(3);
  doc
    .fontSize(8)
    .fillColor("#999999")
    .text("This is a computer-generated quotation and does not require a signature.", {
      align: "center",
    });

  doc.end();
}
