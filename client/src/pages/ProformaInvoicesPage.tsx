import { SalesDocumentPage } from "../components/SalesDocumentPage";

export function ProformaInvoicesPage() {
  return (
    <SalesDocumentPage
      apiPath="/proforma-invoices"
      title="Proforma Invoice"
      pluralTitle="Proforma Invoices"
      convertTargets={[{ apiPath: "/delivery-challans", routePath: "/delivery-challans", title: "Delivery Challan" }]}
    />
  );
}
