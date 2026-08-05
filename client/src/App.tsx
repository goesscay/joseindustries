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
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/items" element={<ItemsPage />} />
          <Route path="/companies" element={<CompaniesPage />} />
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
