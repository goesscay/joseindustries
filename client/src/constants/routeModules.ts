import { PermissionAction } from "./permissions";

// Route path -> permission module key. Single source of truth shared by
// AppLayout (nav filtering) and ModuleGate (route-level view gating +
// picking a safe landing page for a restricted staff member). Not every
// route needs an entry: "/users" stays hardcoded to non-staff, since who
// can manage users/permissions is a security boundary outside this system.
//
// Order matters here: it's also the priority order used to pick a fallback
// route when a user lands somewhere they can't view (e.g. "/" itself, if
// they've been denied the Dashboard module) - the first entry they *can*
// view wins.
export const ROUTE_MODULE: Record<string, string> = {
  "/": "dashboard",
  "/leads": "sales.leads",
  "/quotations": "sales.quotations",
  "/proforma-invoices": "sales.proforma_invoices",
  "/delivery-challans": "sales.delivery_challans",
  "/tax-invoices": "sales.tax_invoices",
  "/sales/credit-notes": "sales.credit_notes",
  "/receipts": "sales.receipts",
  "/expenses": "expenses.expenses",
  "/vendor-payments": "expenses.vendor_payments",
  "/purchases/orders": "purchases.orders",
  "/purchases/bills": "purchases.bills",
  "/purchases/debit-notes": "purchases.debit_notes",
  "/expense-categories": "expenses.expense_categories",
  "/accounts": "banking.accounts",
  "/banking/reconciliation": "banking.reconciliation",
  "/accounting/chart-of-accounts": "accounting.chart_of_accounts",
  "/accounting/journals": "accounting.journals",
  "/accounting/fixed-assets": "accounting.fixed_assets",
  "/customers": "contacts.customers",
  "/vendors": "contacts.vendors",
  "/items": "items.items",
  "/inventory/stock-levels": "inventory.stock",
  "/inventory/stock-ledger": "inventory.stock",
  "/inventory/opening-stock": "inventory.stock",
  "/inventory/adjustments": "inventory.stock",
  "/reports": "reports.reports",
  "/reports/gst-returns": "reports.reports",
  "/companies": "settings.company_profile",
  "/settings/bank-accounts": "banking.accounts",
  "/settings/tax-rates": "settings.tax_gst",
  "/settings/document-numbering": "settings.document_numbering",
  "/settings/payment-terms": "settings.payment_terms",
  "/settings/terms-conditions": "settings.terms_conditions",
};

/**
 * First route (in ROUTE_MODULE's declared order) the given `can` predicate
 * grants "view" on, excluding `exclude`. Used by ModuleGate to send a
 * restricted user somewhere they can actually land instead of bouncing them
 * back to a route they were just denied (which would loop forever for "/").
 * Returns null if the user can't view anything at all.
 */
export function firstAccessibleRoute(
  can: (moduleKey: string, action: PermissionAction) => boolean,
  exclude?: string
): string | null {
  for (const [path, moduleKey] of Object.entries(ROUTE_MODULE)) {
    if (path === exclude) continue;
    if (can(moduleKey, "view")) return path;
  }
  return null;
}
