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
import { accountsRouter } from "./routes/accounts";
import { journalEntriesRouter, accountTransfersRouter } from "./routes/journalEntries";

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
app.use("/api/accounts", accountsRouter);
app.use("/api/journal-entries", journalEntriesRouter);
app.use("/api/account-transfers", accountTransfersRouter);

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
