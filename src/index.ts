import path from "path";
import express, { ErrorRequestHandler } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { healthRouter } from "./routes/health";
import { authRouter } from "./routes/auth";
import { usersRouter } from "./routes/users";
import { companiesRouter } from "./routes/companies";
import { customersRouter } from "./routes/customers";
import { leadsRouter } from "./routes/leads";
import { itemsRouter } from "./routes/items";
import { quotationsRouter } from "./routes/quotations";
import { proformaInvoicesRouter } from "./routes/proformaInvoices";
import { deliveryChallansRouter } from "./routes/deliveryChallans";
import { taxInvoicesRouter } from "./routes/taxInvoices";
import { receiptsRouter } from "./routes/receipts";
import { vendorsRouter } from "./routes/vendors";
import { expenseCategoriesRouter } from "./routes/expenseCategories";
import { expensesRouter } from "./routes/expenses";
import { vendorPaymentsRouter } from "./routes/vendorPayments";
import { purchaseOrdersRouter } from "./routes/purchaseOrders";
import { purchaseBillsRouter } from "./routes/purchaseBills";
import { creditNotesRouter } from "./routes/creditNotes";
import { debitNotesRouter } from "./routes/debitNotes";
import { accountsRouter } from "./routes/accounts";
import { bankCashEntriesRouter, accountTransfersRouter } from "./routes/bankCashEntries";
import { chartOfAccountsRouter } from "./routes/chartOfAccounts";
import { journalsRouter } from "./routes/journals";
import { accountingReportsRouter } from "./routes/accountingReports";
import { gstReturnsRouter } from "./routes/gstReturns";
import { inventoryRouter } from "./routes/inventory";
import { reportsRouter } from "./routes/reports";
import { taxRatesRouter } from "./routes/taxRates";
import { paymentTermsRouter } from "./routes/paymentTerms";
import { termsTemplatesRouter } from "./routes/termsTemplates";
import { docCountersRouter } from "./routes/docCounters";
import { dashboardRouter } from "./routes/dashboard";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const clientDistPath = path.join(__dirname, "../public");

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.use("/api", healthRouter);
app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/companies", companiesRouter);
app.use("/api/customers", customersRouter);
app.use("/api/leads", leadsRouter);
app.use("/api/items", itemsRouter);
app.use("/api/quotations", quotationsRouter);
app.use("/api/proforma-invoices", proformaInvoicesRouter);
app.use("/api/delivery-challans", deliveryChallansRouter);
app.use("/api/tax-invoices", taxInvoicesRouter);
app.use("/api/receipts", receiptsRouter);
app.use("/api/vendors", vendorsRouter);
app.use("/api/expense-categories", expenseCategoriesRouter);
app.use("/api/expenses", expensesRouter);
app.use("/api/vendor-payments", vendorPaymentsRouter);
app.use("/api/purchase-orders", purchaseOrdersRouter);
app.use("/api/purchase-bills", purchaseBillsRouter);
app.use("/api/credit-notes", creditNotesRouter);
app.use("/api/debit-notes", debitNotesRouter);
app.use("/api/accounts", accountsRouter);
app.use("/api/bank-cash-entries", bankCashEntriesRouter);
app.use("/api/account-transfers", accountTransfersRouter);
app.use("/api/chart-of-accounts", chartOfAccountsRouter);
app.use("/api/journals", journalsRouter);
app.use("/api/accounting", accountingReportsRouter);
app.use("/api/accounting/gst-returns", gstReturnsRouter);
app.use("/api/inventory", inventoryRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/tax-rates", taxRatesRouter);
app.use("/api/payment-terms", paymentTermsRouter);
app.use("/api/terms-templates", termsTemplatesRouter);
app.use("/api/doc-counters", docCountersRouter);
app.use("/api/dashboard", dashboardRouter);

app.use(express.static(clientDistPath));

app.get(/^\/(?!api).*/, (_req, res) => {
  res.sendFile(path.join(clientDistPath, "index.html"));
});

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: "Internal server error" });
};
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
