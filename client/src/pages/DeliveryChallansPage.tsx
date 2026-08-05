import { SalesDocumentPage } from "../components/SalesDocumentPage";

export function DeliveryChallansPage() {
  return (
    <SalesDocumentPage
      apiPath="/delivery-challans"
      title="Delivery Challan"
      pluralTitle="Delivery Challans"
      statusLabels={{ sent: "Dispatched", accepted: "Delivered", rejected: "Returned" }}
      convertTargets={[
        {
          apiPath: "/tax-invoices",
          routePath: "/tax-invoices",
          title: "Tax Invoice",
          allowedRoles: ["super_admin", "admin"],
        },
      ]}
    />
  );
}
