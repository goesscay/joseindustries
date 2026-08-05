import { Routes, Route, Navigate } from "react-router-dom";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { AppLayout } from "./layouts/AppLayout";
import { LoginPage } from "./pages/LoginPage";
import { HomePage } from "./pages/HomePage";
import { UsersPage } from "./pages/UsersPage";
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
import { AccountsPage } from "./pages/AccountsPage";
import { ReportsPage } from "./pages/ReportsPage";
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
          <Route path="/" element={<HomePage />} />
          <Route path="/quotations" element={<QuotationsPage />} />
          <Route path="/proforma-invoices" element={<ProformaInvoicesPage />} />
          <Route path="/delivery-challans" element={<DeliveryChallansPage />} />
          <Route path="/tax-invoices" element={<TaxInvoicesPage />} />
          <Route path="/receipts" element={<ReceiptsPage />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/items" element={<ItemsPage />} />
          <Route path="/companies" element={<CompaniesPage />} />
          <Route path="/vendors" element={<VendorsPage />} />
          <Route path="/expenses" element={<ExpensesPage />} />
          <Route path="/vendor-payments" element={<VendorPaymentsPage />} />
          <Route path="/expense-categories" element={<ExpenseCategoriesPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/settings/tax-rates" element={<TaxRatesPage />} />
          <Route path="/settings/payment-terms" element={<PaymentTermsPage />} />
          <Route path="/settings/document-numbering" element={<DocumentNumberingPage />} />
          <Route path="/settings/terms-conditions" element={<TermsConditionsPage />} />
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
