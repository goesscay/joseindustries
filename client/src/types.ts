export type Role = "super_admin" | "admin" | "staff";
export type Status = "active" | "inactive";

export interface ModuleAccess {
  can_view: boolean;
  can_create: boolean;
  can_edit: boolean;
  can_delete: boolean;
}

export interface UserPermissions {
  /** false = unrestricted (full access to every module) - see utils/permissions.ts on the server for the fallback contract. */
  restricted: boolean;
  modules: Record<string, ModuleAccess>;
}

export interface UserAccountAccess {
  /** false = unrestricted (sees/uses every Bank & Cash account). */
  restricted: boolean;
  accountIds: number[];
}

export interface AppUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  status: Status;
  created_at: string;
  updated_at: string;
  /** Only present on the currently-authenticated user's own payload (/auth/login, /auth/me) - not on GET /users list rows. */
  permissions?: UserPermissions;
  accountAccess?: UserAccountAccess;
  /** Only present on GET /users list rows - a cheap "has any restriction rows" flag, in place of the full permissions/accountAccess payload above. */
  accessRestricted?: boolean;
}

export interface Company {
  id: number;
  code: string;
  name: string;
  tagline: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  state: string | null;
  state_code: string | null;
  bank_name: string | null;
  bank_account_no: string | null;
  bank_ifsc: string | null;
  terms_and_conditions: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface TaxRate {
  id: number;
  label: string;
  rate: string;
  is_default: boolean | number;
  created_at: string;
}

export interface PaymentTerm {
  id: number;
  label: string;
  created_at: string;
}

export type TermsTemplateDocType = "all" | "quotation" | "proforma_invoice" | "delivery_challan" | "tax_invoice";

export interface TermsTemplate {
  id: number;
  title: string;
  doc_type: TermsTemplateDocType;
  content: string;
  is_default: boolean | number;
  created_at: string;
  updated_at: string;
}

export interface DocCounter {
  doc_type: string;
  company_code: string;
  company_name: string | null;
  financial_year: string;
  last_number: number;
}

export interface Customer {
  id: number;
  name: string;
  gstin: string | null;
  phone: string | null;
  email: string | null;
  billing_address: string | null;
  shipping_address: string | null;
  state: string | null;
  created_at: string;
  updated_at: string;
}

export interface Item {
  id: number;
  name: string;
  hsn_code: string | null;
  unit: string;
  default_rate: string;
  tax_rate: string;
  created_at: string;
  updated_at: string;
}

export type DocStatus = "draft" | "sent" | "accepted" | "rejected" | "cancelled";

export interface DocumentLineItem {
  id?: number;
  item_id: number | null;
  description: string;
  hsn_code: string | null;
  qty: number;
  unit: string;
  rate: number;
  discount_percent: number;
  tax_rate: number;
  line_total?: number;
}

export type DocType = "quotation" | "proforma_invoice" | "delivery_challan" | "tax_invoice" | "receipt";

export interface SalesDocument {
  id: number;
  doc_type: DocType;
  doc_number: string;
  financial_year: string;
  company_id: number;
  company_name?: string;
  company_code?: string;
  customer_id: number;
  customer_name?: string;
  status: DocStatus;
  converted_from_id: number | null;
  issue_date: string;
  notes: string | null;

  consignee_name: string | null;
  consignee_address: string | null;
  consignee_gstin: string | null;
  consignee_state: string | null;

  transport_mode: string | null;
  vehicle_number: string | null;
  date_of_supply: string | null;
  place_of_supply: string | null;
  buyers_order_no: string | null;
  buyers_order_date: string | null;
  dispatch_doc_no: string | null;
  dispatched_through: string | null;
  destination: string | null;
  terms_of_delivery: string | null;
  delivery_note: string | null;
  delivery_note_date: string | null;
  mode_terms_of_payment: string | null;
  other_reference: string | null;
  supplier_reference: string | null;
  terms_and_conditions: string | null;

  due_date: string | null;
  credit_period: string | null;
  reverse_charge: boolean | number;

  subtotal: string;
  discount_amount: string;
  freight_charges: string;
  installation_charges: string;
  cgst_total: string;
  sgst_total: string;
  igst_total: string;
  tax_total: string;
  round_off: string;
  grand_total: string;
  created_at: string;
  updated_at: string;

  /** Only present when the list/detail endpoint includes a payment summary (Tax Invoices). */
  paid_amount?: string;
}

export type PaymentMode = "cash" | "cheque" | "bank_transfer" | "upi" | "card" | "other";

export interface Receipt {
  id: number;
  receipt_no: string;
  financial_year: string;
  company_id: number;
  company_name?: string;
  company_code?: string;
  customer_id: number;
  customer_name?: string;
  tax_invoice_id: number | null;
  invoice_number?: string;
  account_id: number | null;
  account_name?: string;
  amount: string;
  payment_mode: PaymentMode;
  reference_no: string | null;
  received_date: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Vendor {
  id: number;
  name: string;
  gstin: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  state: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExpenseCategory {
  id: number;
  name: string;
  created_at: string;
}

export interface Expense {
  id: number;
  expense_no: string;
  financial_year: string;
  company_id: number;
  company_name?: string;
  company_code?: string;
  vendor_id: number | null;
  vendor_name?: string;
  category_id: number | null;
  category_name?: string;
  expense_date: string;
  description: string | null;
  amount: string;
  tax_amount: string;
  total_amount: string;
  reference_no: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  /** Only present on the list/detail endpoints - sum of vendor payments against this expense. */
  paid_amount?: string;
}

export interface VendorPayment {
  id: number;
  payment_no: string;
  financial_year: string;
  company_id: number;
  company_name?: string;
  company_code?: string;
  vendor_id: number;
  vendor_name?: string;
  expense_id: number | null;
  expense_number?: string;
  account_id: number | null;
  account_name?: string;
  amount: string;
  payment_mode: PaymentMode;
  reference_no: string | null;
  paid_date: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type AccountType = "cash" | "bank";

export interface Account {
  id: number;
  company_id: number;
  company_name?: string;
  company_code?: string;
  name: string;
  account_type: AccountType;
  bank_name: string | null;
  account_number: string | null;
  ifsc: string | null;
  opening_balance: string;
  is_active: boolean | number;
  created_at: string;
  updated_at: string;
  /** Only present on the list/detail endpoints - opening_balance plus every posted movement. */
  balance?: number;
}

export type JournalDirection = "in" | "out";

export interface JournalEntry {
  id: number;
  account_id: number;
  account_name?: string;
  entry_date: string;
  direction: JournalDirection;
  amount: string;
  particulars: string;
  notes: string | null;
  transfer_group: string | null;
  created_at: string;
}

export interface LedgerEntry {
  id: number;
  source_type: "receipt" | "vendor_payment" | "journal_entry";
  source_id: number;
  entry_date: string;
  direction: JournalDirection;
  amount: number;
  particulars: string;
  running_balance: number;
}
