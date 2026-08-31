import path from "path";
import PDFDocument from "pdfkit";
import { Response } from "express";
import { PartyLedgerReport } from "../partyLedger";

const PAGE_MARGIN = 40;
const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const CONTENT_LEFT = PAGE_MARGIN;
const CONTENT_RIGHT = PAGE_WIDTH - PAGE_MARGIN;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;
const BOTTOM_LIMIT = PAGE_HEIGHT - PAGE_MARGIN - 20;

const LOGO_PATH = path.join(__dirname, "../../../client/src/assets/logo-black.png");

const DARK_GREEN = "#155D3C";
const DARK = "#181818";
const GRAY = "#4b4b4b";
const MUTED = "#8a8a8a";
const BORDER = "#dfe3e0";

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

const COLS = {
  date: { x: CONTENT_LEFT, width: 62 },
  no: { x: CONTENT_LEFT + 62, width: 110 },
  desc: { x: CONTENT_LEFT + 62 + 110, width: 108 },
  debit: { x: CONTENT_LEFT + 62 + 110 + 108, width: 70 },
  credit: { x: CONTENT_LEFT + 62 + 110 + 108 + 70, width: 70 },
  balance: { x: CONTENT_LEFT + 62 + 110 + 108 + 70 + 70, width: CONTENT_WIDTH - (62 + 110 + 108 + 70 + 70) },
};

/**
 * Renders a Party Ledger (customer or vendor statement) as a downloadable/
 * printable PDF - opened via `window.open` in a new tab from the client,
 * exactly like the existing Tax Invoice/Quotation/Receipt PDF buttons, so
 * "Print" and "Download PDF" are both just the browser's own PDF viewer
 * acting on this one file. Multi-page aware: the table header repeats on
 * every page, and a row is never split across a page boundary.
 */
export function streamPartyLedgerPdf(res: Response, report: PartyLedgerReport, from: string, to: string) {
  const { party, partyType, openingBalance, entries, closingBalance } = report;
  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN });
  const safeName = party.name.replace(/[^a-z0-9]+/gi, "-");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="party-ledger-${safeName}.pdf"`);
  doc.pipe(res);

  let page = 1;
  let y = PAGE_MARGIN;

  function drawHeader(isFirstPage: boolean) {
    y = PAGE_MARGIN;
    const logoSize = 40;
    try {
      doc.image(LOGO_PATH, CONTENT_LEFT, y, { fit: [logoSize, logoSize] });
    } catch {
      // Logo missing - skip silently.
    }
    doc.fontSize(15).fillColor(DARK).font("Helvetica-Bold").text("PARTY LEDGER", CONTENT_LEFT + logoSize + 10, y, { width: 260 });
    doc.font("Helvetica").fontSize(8).fillColor(MUTED).text("Statement of account", CONTENT_LEFT + logoSize + 10, doc.y);

    doc.fontSize(8).fillColor(MUTED).text(`Page ${page}`, CONTENT_RIGHT - 100, PAGE_MARGIN, { width: 100, align: "right" });
    doc
      .fontSize(8)
      .fillColor(MUTED)
      .text(`Generated ${formatDate(new Date().toISOString())}`, CONTENT_RIGHT - 160, PAGE_MARGIN + 12, { width: 160, align: "right" });

    y = Math.max(doc.y, PAGE_MARGIN + logoSize) + 14;
    doc.moveTo(CONTENT_LEFT, y).lineTo(CONTENT_RIGHT, y).strokeColor(BORDER).stroke();
    y += 14;

    if (isFirstPage) {
      const billing = (party as any).billing_address ?? (party as any).address ?? null;
      doc.fontSize(8).fillColor(MUTED).text(partyType === "customer" ? "CUSTOMER" : "VENDOR", CONTENT_LEFT, y);
      doc.fontSize(11).fillColor(DARK).font("Helvetica-Bold").text(party.name, CONTENT_LEFT, doc.y + 2);
      doc.font("Helvetica").fontSize(8.5).fillColor(GRAY);
      if (billing) doc.text(billing, CONTENT_LEFT, doc.y, { width: 320 });
      const metaLine = [party.gstin ? `GSTIN: ${party.gstin}` : null, party.state ? `State: ${party.state}` : null]
        .filter(Boolean)
        .join("   |   ");
      if (metaLine) doc.text(metaLine, CONTENT_LEFT, doc.y, { width: 320 });

      doc.fontSize(8).fillColor(MUTED).text("PERIOD", 340, y, { width: CONTENT_RIGHT - 340, align: "right" });
      doc
        .fontSize(9.5)
        .fillColor(DARK)
        .text(`${formatDate(from)} - ${formatDate(to)}`, 340, doc.y, { width: CONTENT_RIGHT - 340, align: "right" });

      y = doc.y + 16;
      doc.moveTo(CONTENT_LEFT, y).lineTo(CONTENT_RIGHT, y).strokeColor(BORDER).stroke();
      y += 12;

      doc.fontSize(9).fillColor(GRAY).text("Opening Balance", CONTENT_LEFT, y, { continued: true, width: 200 });
      doc.font("Helvetica-Bold").fillColor(DARK).text(`  Rs. ${formatMoney(openingBalance)}`);
      doc.font("Helvetica");
      y = doc.y + 10;
    }
  }

  function drawTableHeader() {
    const headerHeight = 22;
    doc.rect(CONTENT_LEFT, y, CONTENT_WIDTH, headerHeight).fill(DARK_GREEN);
    doc.fillColor("#ffffff").fontSize(8).font("Helvetica-Bold");
    const midY = y + 6;
    doc.text("Date", COLS.date.x + 4, midY, { width: COLS.date.width });
    doc.text("No.", COLS.no.x, midY, { width: COLS.no.width });
    doc.text("Description", COLS.desc.x, midY, { width: COLS.desc.width });
    doc.text("Debit", COLS.debit.x, midY, { width: COLS.debit.width - 4, align: "right" });
    doc.text("Credit", COLS.credit.x, midY, { width: COLS.credit.width - 4, align: "right" });
    doc.text("Balance", COLS.balance.x, midY, { width: COLS.balance.width - 4, align: "right" });
    doc.font("Helvetica");
    y += headerHeight + 2;
  }

  function newPage() {
    doc.addPage();
    page += 1;
    drawHeader(false);
    drawTableHeader();
  }

  function ensureSpace(rowHeight: number) {
    if (y + rowHeight > BOTTOM_LIMIT) newPage();
  }

  drawHeader(true);
  drawTableHeader();

  const rowHeight = 20;
  entries.forEach((entry, idx) => {
    ensureSpace(rowHeight);
    if (idx % 2 === 1) {
      doc.rect(CONTENT_LEFT, y, CONTENT_WIDTH, rowHeight).fill("#f7f9f8");
    }
    doc.fillColor(DARK).fontSize(8.3).font("Helvetica");
    const midY = y + 5;
    doc.text(formatDate(entry.entry_date), COLS.date.x + 4, midY, { width: COLS.date.width });
    doc.text(entry.doc_number ?? "", COLS.no.x, midY, { width: COLS.no.width });
    doc.text(entry.description, COLS.desc.x, midY, { width: COLS.desc.width });
    doc.text(entry.debit ? formatMoney(entry.debit) : "", COLS.debit.x, midY, { width: COLS.debit.width - 4, align: "right" });
    doc.text(entry.credit ? formatMoney(entry.credit) : "", COLS.credit.x, midY, { width: COLS.credit.width - 4, align: "right" });
    doc.text(formatMoney(entry.balance), COLS.balance.x, midY, { width: COLS.balance.width - 4, align: "right" });
    y += rowHeight;
    doc.moveTo(CONTENT_LEFT, y).lineTo(CONTENT_RIGHT, y).strokeColor(BORDER).lineWidth(0.5).stroke();
  });

  if (entries.length === 0) {
    ensureSpace(24);
    doc.fontSize(9).fillColor(MUTED).text("No transactions in this period.", CONTENT_LEFT, y + 6, { width: CONTENT_WIDTH, align: "center" });
    y += 24;
  }

  // Closing balance summary - never split across a page boundary from the
  // table above it.
  ensureSpace(50);
  y += 8;
  doc.moveTo(CONTENT_LEFT, y).lineTo(CONTENT_RIGHT, y).strokeColor(BORDER).stroke();
  y += 12;
  const balanceLabel = closingBalance > 0.01 ? (partyType === "customer" ? " (Receivable)" : " (Payable)") : "";
  doc.fontSize(10.5).fillColor(GRAY).text("Closing Balance", CONTENT_LEFT, y, { continued: true, width: 300 });
  doc
    .font("Helvetica-Bold")
    .fillColor(closingBalance > 0.01 ? DARK_GREEN : DARK)
    .text(`  Rs. ${formatMoney(closingBalance)}${balanceLabel}`);
  doc.font("Helvetica");
  y = doc.y + 24;

  doc
    .fontSize(7)
    .fillColor(MUTED)
    .text("This is a computer-generated statement.", CONTENT_LEFT, Math.min(y, BOTTOM_LIMIT + 6), { width: CONTENT_WIDTH, align: "center" });

  doc.end();
}
