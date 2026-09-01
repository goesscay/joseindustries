import { Routes, Route, Navigate } from "react-router-dom";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { ModuleGate } from "./components/ModuleGate";
import { AppLayout } from "./layouts/AppLayout";
import { LoginPage } from "./pages/LoginPage";
import { HomePage } from "./pages/HomePage";
import { UsersPage } from "./pages/UsersPage";
import { LeadsPage } from "./pages/LeadsPage";
import { CustomersPage } from "./pages/CustomersPage";
import { ItemsPage } from "./pages/ItemsPage";
import { CompaniesPage } from "./pages/CompaniesPage";
import { QuotationsPage } from "./pages/QuotationsPage";
import { ProformaInvoicesPage } from "./pages/ProformaInvoicesPage";
import { DeliveryChallansPage } from "./pages/DeliveryChallansPage";
import { TaxInvoicesPage } from "./pages/TaxInvoicesPage";
import { ReceiptsPage } from "./pages/ReceiptsPage";
import { VendorsPage } from "./pages/VendorsPage";
import { ExpenseCategoriesPage } from "./pages/ExpenseCategoriesPage";
import { ExpensesPage } from "./pages/ExpensesPage";
import { VendorPaymentsPage } from "./pages/VendorPaymentsPage";
import { PurchaseOrdersPage } from "./pages/PurchaseOrdersPage";
import { PurchaseBillsPage } from "./pages/PurchaseBillsPage";
import { CreditNotesPage } from "./pages/CreditNotesPage";
import { DebitNotesPage } from "./pages/DebitNotesPage";
import { AccountsPage } from "./pages/AccountsPage";
import { BankReconciliationPage } from "./pages/BankReconciliationPage";
import { ChartOfAccountsPage } from "./pages/ChartOfAccountsPage";
import { JournalEntriesPage } from "./pages/JournalEntriesPage";
import { FixedAssetsPage } from "./pages/FixedAssetsPage";
import { YearEndClosingPage } from "./pages/YearEndClosingPage";
import { ReportsPage } from "./pages/ReportsPage";
import { GstReturnsPage } from "./pages/GstReturnsPage";
import { StockLevelsPage, StockLedgerPage, OpeningStockPage, StockAdjustmentsPage, InventoryValuationPage } from "./pages/InventoryPage";
import { TaxRatesPage } from "./pages/TaxRatesPage";
import { PaymentTermsPage } from "./pages/PaymentTermsPage";
import { DocumentNumberingPage } from "./pages/DocumentNumberingPage";
import { TermsConditionsPage } from "./pages/TermsConditionsPage";

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<ModuleGate module="dashboard"><HomePage /></ModuleGate>} />
          <Route path="/leads" element={<ModuleGate module="sales.leads"><LeadsPage /></ModuleGate>} />
          <Route path="/quotations" element={<ModuleGate module="sales.quotations"><QuotationsPage /></ModuleGate>} />
          <Route
            path="/proforma-invoices"
            element={
              <ModuleGate module="sales.proforma_invoices">
                <ProformaInvoicesPage />
              </ModuleGate>
            }
          />
          <Route
            path="/delivery-challans"
            element={
              <ModuleGate module="sales.delivery_challans">
                <DeliveryChallansPage />
              </ModuleGate>
            }
          />
          <Route path="/tax-invoices" element={<ModuleGate module="sales.tax_invoices"><TaxInvoicesPage /></ModuleGate>} />
          <Route
            path="/sales/credit-notes"
            element={
              <ModuleGate module="sales.credit_notes">
                <CreditNotesPage />
              </ModuleGate>
            }
          />
          <Route path="/receipts" element={<ModuleGate module="sales.receipts"><ReceiptsPage /></ModuleGate>} />
          <Route path="/customers" element={<ModuleGate module="contacts.customers"><CustomersPage /></ModuleGate>} />
          <Route path="/items" element={<ModuleGate module="items.items"><ItemsPage /></ModuleGate>} />
          <Route path="/inventory/stock-levels" element={<ModuleGate module="inventory.stock"><StockLevelsPage /></ModuleGate>} />
          <Route path="/inventory/stock-ledger" element={<ModuleGate module="inventory.stock"><StockLedgerPage /></ModuleGate>} />
          <Route path="/inventory/opening-stock" element={<ModuleGate module="inventory.stock"><OpeningStockPage /></ModuleGate>} />
          <Route path="/inventory/adjustments" element={<ModuleGate module="inventory.stock"><StockAdjustmentsPage /></ModuleGate>} />
          <Route path="/companies" element={<ModuleGate module="settings.company_profile"><CompaniesPage /></ModuleGate>} />
          <Route path="/vendors" element={<ModuleGate module="contacts.vendors"><VendorsPage /></ModuleGate>} />
          <Route path="/expenses" element={<ModuleGate module="expenses.expenses"><ExpensesPage /></ModuleGate>} />
          <Route
            path="/vendor-payments"
            element={
              <ModuleGate module="expenses.vendor_payments">
                <VendorPaymentsPage />
              </ModuleGate>
            }
          />
          <Route
            path="/purchases/orders"
            element={
              <ModuleGate module="purchases.orders">
                <PurchaseOrdersPage />
              </ModuleGate>
            }
          />
          <Route
            path="/purchases/bills"
            element={
              <ModuleGate module="purchases.bills">
                <PurchaseBillsPage />
              </ModuleGate>
            }
          />
          <Route
            path="/purchases/debit-notes"
            element={
              <ModuleGate module="purchases.debit_notes">
                <DebitNotesPage />
              </ModuleGate>
            }
          />
          <Route
            path="/expense-categories"
            element={
              <ModuleGate module="expenses.expense_categories">
                <ExpenseCategoriesPage />
              </ModuleGate>
            }
          />
          <Route path="/accounts" element={<ModuleGate module="banking.accounts"><AccountsPage /></ModuleGate>} />
          <Route
            path="/banking/reconciliation"
            element={
              <ModuleGate module="banking.reconciliation">
                <BankReconciliationPage />
              </ModuleGate>
            }
          />
          <Route
            path="/accounting/chart-of-accounts"
            element={
              <ModuleGate module="accounting.chart_of_accounts">
                <ChartOfAccountsPage />
              </ModuleGate>
            }
          />
          <Route
            path="/accounting/journals"
            element={
              <ModuleGate module="accounting.journals">
                <JournalEntriesPage />
              </ModuleGate>
            }
          />
          <Route
            path="/accounting/fixed-assets"
            element={
              <ModuleGate module="accounting.fixed_assets">
                <FixedAssetsPage />
              </ModuleGate>
            }
          />
          <Route
            path="/accounting/year-end-closing"
            element={
              <ModuleGate module="accounting.year_end_closing">
                <YearEndClosingPage />
              </ModuleGate>
            }
          />
          <Route path="/reports" element={<ModuleGate module="reports.reports"><ReportsPage /></ModuleGate>} />
          <Route path="/reports/gst-returns" element={<ModuleGate module="reports.reports"><GstReturnsPage /></ModuleGate>} />
          <Route path="/reports/inventory" element={<ModuleGate module="inventory.stock"><InventoryValuationPage /></ModuleGate>} />
          <Route path="/settings/tax-rates" element={<ModuleGate module="settings.tax_gst"><TaxRatesPage /></ModuleGate>} />
          <Route
            path="/settings/payment-terms"
            element={
              <ModuleGate module="settings.payment_terms">
                <PaymentTermsPage />
              </ModuleGate>
            }
          />
          <Route
            path="/settings/document-numbering"
            element={
              <ModuleGate module="settings.document_numbering">
                <DocumentNumberingPage />
              </ModuleGate>
            }
          />
          <Route
            path="/settings/terms-conditions"
            element={
              <ModuleGate module="settings.terms_conditions">
                <TermsConditionsPage />
              </ModuleGate>
            }
          />
          <Route element={<ProtectedRoute allowedRoles={["super_admin", "admin"]} />}>
            <Route path="/users" element={<UsersPage />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
