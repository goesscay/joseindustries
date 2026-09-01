// Mirrors src/constants/permissions.ts on the server - kept in sync by hand,
// same pattern already used for the Role/DocType enums shared across the
// client/server boundary. "settings.users_roles" is deliberately absent:
// who can manage users/permissions is a hard security boundary, never
// staff-grantable, so it's not part of this system at all.

export interface ModuleDef {
  key: string;
  label: string;
  group: string;
}

export const PERMISSION_MODULES: ModuleDef[] = [
  { key: "dashboard", label: "Dashboard", group: "Dashboard" },

  { key: "sales.leads", label: "Leads", group: "Sales" },
  { key: "sales.quotations", label: "Quotations", group: "Sales" },
  { key: "sales.proforma_invoices", label: "Proforma Invoices", group: "Sales" },
  { key: "sales.delivery_challans", label: "Delivery Challans", group: "Sales" },
  { key: "sales.tax_invoices", label: "Tax Invoices", group: "Sales" },
  { key: "sales.credit_notes", label: "Credit Notes", group: "Sales" },
  { key: "sales.receipts", label: "Receipts", group: "Sales" },

  { key: "expenses.expenses", label: "Expenses", group: "Expenses" },
  { key: "expenses.vendor_payments", label: "Vendor Payments", group: "Expenses" },
  { key: "expenses.expense_categories", label: "Expense Categories", group: "Expenses" },

  { key: "purchases.orders", label: "Purchase Orders", group: "Purchases" },
  { key: "purchases.bills", label: "Purchase Bills", group: "Purchases" },
  { key: "purchases.debit_notes", label: "Debit Notes", group: "Purchases" },

  { key: "banking.accounts", label: "Bank & Cash", group: "Banking" },
  { key: "banking.reconciliation", label: "Bank Reconciliation", group: "Banking" },

  // Phase 2 accounting foundation - no frontend page consumes this yet
  // (backend-only for now), but the module key exists so its routes are
  // gated the same way as every other module and the Users & Roles grid
  // is ready for it once a Chart of Accounts screen is built.
  { key: "accounting.chart_of_accounts", label: "Chart of Accounts", group: "Accounting" },
  { key: "accounting.journals", label: "Journals", group: "Accounting" },
  { key: "accounting.fixed_assets", label: "Fixed Assets", group: "Accounting" },
  { key: "accounting.year_end_closing", label: "Year-End Closing", group: "Accounting" },

  { key: "contacts.customers", label: "Customers", group: "Contacts" },
  { key: "contacts.vendors", label: "Vendors", group: "Contacts" },

  { key: "items.items", label: "Items", group: "Items" },

  { key: "inventory.stock", label: "Stock", group: "Inventory" },

  { key: "reports.reports", label: "Reports", group: "Reports" },

  { key: "settings.company_profile", label: "Company Profile", group: "Settings" },
  { key: "settings.tax_gst", label: "Tax & GST", group: "Settings" },
  { key: "settings.document_numbering", label: "Document Numbering", group: "Settings" },
  { key: "settings.payment_terms", label: "Payment Terms", group: "Settings" },
  { key: "settings.terms_conditions", label: "Terms & Conditions", group: "Settings" },
];

export const MODULE_KEYS = PERMISSION_MODULES.map((m) => m.key);

export type PermissionAction = "view" | "create" | "edit" | "delete";
