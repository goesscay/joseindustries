import { createSalesDocumentRouter } from "./salesDocuments";

// Only Admin/Super Admin may create or finalize a Tax Invoice - the legally
// binding GST document - per earlier decision; Staff can still view/PDF it.
export const taxInvoicesRouter = createSalesDocumentRouter("tax_invoice", "Tax Invoice", {
  createRoles: ["super_admin", "admin"],
  includePaymentSummary: true,
});
