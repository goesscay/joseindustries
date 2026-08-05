import { SalesDocumentPage } from "../components/SalesDocumentPage";

export function TaxInvoicesPage() {
  return (
    <SalesDocumentPage
      apiPath="/tax-invoices"
      title="Tax Invoice"
      pluralTitle="Tax Invoices"
      restrictedToRoles={["super_admin", "admin"]}
      showPaymentStatus
    />
  );
}
