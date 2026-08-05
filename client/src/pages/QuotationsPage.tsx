import { SalesDocumentPage } from "../components/SalesDocumentPage";

export function QuotationsPage() {
  return (
    <SalesDocumentPage
      apiPath="/quotations"
      title="Quotation"
      pluralTitle="Quotations"
      convertTargets={[
        { apiPath: "/proforma-invoices", routePath: "/proforma-invoices", title: "Proforma Invoice" },
        { apiPath: "/delivery-challans", routePath: "/delivery-challans", title: "Delivery Challan" },
      ]}
    />
  );
}
