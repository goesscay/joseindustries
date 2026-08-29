export type Role = "super_admin" | "admin" | "staff";
export type Status = "active" | "inactive";

export interface User {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  role: Role;
  status: Status;
  created_at: string;
  updated_at: string;
}

export interface JwtPayload {
  sub: number;
  role: Role;
}

export type DocType = "quotation" | "proforma_invoice" | "delivery_challan" | "tax_invoice" | "receipt";
export type DocStatus = "draft" | "sent" | "accepted" | "rejected" | "cancelled";

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
  financial_year: string;
  last_number: number;
}

export type LeadSource =
  | "website"
  | "referral"
  | "cold_call"
  | "walk_in"
  | "advertisement"
  | "social_media"
  | "trade_show"
  | "existing_customer"
  | "other";
export type LeadStatus = "new" | "contacted" | "qualified" | "proposal" | "negotiation" | "won" | "lost";

export interface Lead {
  id: number;
  name: string;
  contact_person: string | null;
  designation: string | null;
  phone: string | null;
  email: string | null;
  source: LeadSource;
  status: LeadStatus;
  industry: string | null;
  estimated_value: string;
  expected_close_date: string | null;
  lost_reason: string | null;
  gstin: string | null;
  state: string | null;
  address: string | null;
  assigned_to: number | null;
  next_follow_up_date: string | null;
  notes: string | null;
  converted_customer_id: number | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
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

export interface DocumentItem {
  id?: number;
  document_id?: number;
  item_id: number | null;
  description: string;
  hsn_code: string | null;
  qty: number;
  unit: string;
  rate: number;
  discount_percent: number;
  tax_rate: number;
  line_total: number;
}

export interface DocumentRecord {
  id: number;
  doc_type: DocType;
  doc_number: string;
  financial_year: string;
  company_id: number;
  customer_id: number;
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

  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export type PaymentMode = "cash" | "cheque" | "bank_transfer" | "upi" | "card" | "other";

export interface Receipt {
  id: number;
  receipt_no: string;
  financial_year: string;
  company_id: number;
  customer_id: number;
  tax_invoice_id: number | null;
  account_id: number | null;
  amount: string;
  payment_mode: PaymentMode;
  reference_no: string | null;
  received_date: string;
  notes: string | null;
  created_by: number | null;
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
  vendor_id: number | null;
  category_id: number | null;
  expense_date: string;
  description: string | null;
  amount: string;
  tax_amount: string;
  total_amount: string;
  reference_no: string | null;
  notes: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  /** Only present on the list/detail endpoints - sum of vendor_payments against this expense. */
  paid_amount?: string;
}

export interface VendorPayment {
  id: number;
  payment_no: string;
  financial_year: string;
  company_id: number;
  vendor_id: number;
  expense_id: number | null;
  account_id: number | null;
  amount: string;
  payment_mode: PaymentMode;
  reference_no: string | null;
  paid_date: string;
  notes: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export type AccountType = "cash" | "bank";

export interface Account {
  id: number;
  company_id: number;
  name: string;
  account_type: AccountType;
  bank_name: string | null;
  account_number: string | null;
  ifsc: string | null;
  opening_balance: string;
  is_active: boolean | number;
  created_at: string;
  updated_at: string;
  /** Only present on the list endpoint - opening_balance plus every posted movement. */
  balance?: number;
}

export type JournalDirection = "in" | "out";

export interface JournalEntry {
  id: number;
  account_id: number;
  entry_date: string;
  direction: JournalDirection;
  amount: string;
  particulars: string;
  notes: string | null;
  transfer_group: string | null;
  created_by: number | null;
  created_at: string;
}

/** One row in an account's ledger view - a Receipt, Vendor Payment, or
 * Journal Entry normalized to a common shape, with a running balance. */
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

// ---- Phase 2: Accounting foundation (Chart of Accounts + double-entry
// journals). Additive - sits alongside JournalEntry/LedgerEntry above,
// which stay exactly as they are for the existing Bank & Cash module. ----

export type LedgerAccountType = "asset" | "liability" | "equity" | "revenue" | "expense";
export type NormalBalance = "debit" | "credit";

export interface ChartOfAccount {
  id: number;
  company_id: number;
  parent_id: number | null;
  account_code: string;
  name: string;
  account_type: LedgerAccountType;
  category: string | null;
  normal_balance: NormalBalance;
  description: string | null;
  is_active: boolean | number;
  is_system: boolean | number;
  created_at: string;
  updated_at: string;
}

export type JournalStatus = "posted" | "reversed";

export interface Journal {
  id: number;
  company_id: number;
  journal_date: string;
  reference: string | null;
  source_type: string | null;
  source_id: number | null;
  description: string | null;
  status: JournalStatus;
  reverses_journal_id: number | null;
  created_by: number | null;
  created_at: string;
}

export interface JournalLine {
  id: number;
  journal_id: number;
  account_id: number;
  debit: string;
  credit: string;
  description: string | null;
  sort_order: number;
}

/** Input shape for one line when posting a new journal - amounts are plain
 * numbers here (not yet the DB's string-decimal form) since nothing has
 * been inserted yet. */
export interface JournalLineInput {
  account_id: number;
  debit: number;
  credit: number;
  description?: string | null;
}

export interface CreateJournalInput {
  company_id: number;
  journal_date: string;
  reference?: string | null;
  source_type?: string | null;
  source_id?: number | null;
  description?: string | null;
  created_by?: number | null;
  lines: JournalLineInput[];
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}
