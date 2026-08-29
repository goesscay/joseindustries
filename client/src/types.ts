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
  assigned_to_name?: string;
  next_follow_up_date: string | null;
  notes: string | null;
  converted_customer_id: number | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
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
  default_account_category: string | null;
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

// ---- Phase 7A: Purchase Bills ----

export type PurchaseBillStatus = "draft" | "received" | "cancelled";

export interface PurchaseBill {
  id: number;
  bill_no: string;
  financial_year: string;
  company_id: number;
  company_name?: string;
  company_code?: string;
  vendor_id: number;
  vendor_name?: string;
  purchase_order_id: number | null;
  status: PurchaseBillStatus;
  bill_date: string;
  due_date: string | null;
  reference_no: string | null;
  notes: string | null;
  subtotal: string;
  tax_amount: string;
  total_amount: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  /** Only present on the list/detail endpoints - the originating Purchase
   * Order's number, when purchase_order_id is set (Phase 7B). */
  source_po_no?: string | null;
}

export interface PurchaseBillItem {
  id?: number;
  purchase_bill_id?: number;
  item_id: number | null;
  description: string;
  hsn_code: string | null;
  qty: number;
  unit: string;
  rate: number;
  tax_rate: number;
  taxable_amount: number;
  tax_amount: number;
  line_total: number;
  sort_order?: number;
}

// ---- Phase 7B: Purchase Orders ----

export type PurchaseOrderStatus = "draft" | "confirmed" | "cancelled";

export interface PurchaseOrder {
  id: number;
  po_no: string;
  financial_year: string;
  company_id: number;
  company_name?: string;
  company_code?: string;
  vendor_id: number;
  vendor_name?: string;
  status: PurchaseOrderStatus;
  po_date: string;
  expected_date: string | null;
  reference_no: string | null;
  notes: string | null;
  subtotal: string;
  tax_amount: string;
  total_amount: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  /** Only present on the list/detail endpoints - the Purchase Bill this PO
   * was converted to, if any (a query-derived fact, never a cached column). */
  billed_bill_no?: string | null;
  billed_bill_id?: number | null;
}

export interface PurchaseOrderItem {
  id?: number;
  purchase_order_id?: number;
  item_id: number | null;
  description: string;
  hsn_code: string | null;
  qty: number;
  unit: string;
  rate: number;
  tax_rate: number;
  taxable_amount: number;
  tax_amount: number;
  line_total: number;
  sort_order?: number;
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

// ---- Phase 5: Chart of Accounts / General Ledger / Trial Balance -
// mirrors src/types.ts's ChartOfAccount/Journal shapes on the server, same
// hand-kept-in-sync convention as every other client/server-shared type
// in this file. ----

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

export interface GeneralLedgerEntry {
  journal_id: number;
  journal_date: string;
  reference: string | null;
  source_type: string | null;
  source_id: number | null;
  description: string | null;
  status: "posted" | "reversed";
  debit: number;
  credit: number;
  running_balance: number;
}

export interface GeneralLedgerResult {
  account: ChartOfAccount;
  from: string;
  to: string;
  openingBalance: number;
  entries: GeneralLedgerEntry[];
  closingBalance: number;
}

export interface TrialBalanceRow {
  account_id: number;
  account_code: string;
  name: string;
  account_type: LedgerAccountType;
  category: string | null;
  normal_balance: NormalBalance;
  debit: number;
  credit: number;
}

export interface TrialBalanceResult {
  asOfDate: string;
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  isBalanced: boolean;
}

export interface ProfitAndLossRow {
  account_id: number;
  account_code: string;
  name: string;
  category: string | null;
  amount: number;
}

export interface ProfitAndLossResult {
  from: string;
  to: string;
  income: ProfitAndLossRow[];
  expenses: ProfitAndLossRow[];
  totalIncome: number;
  totalExpenses: number;
  netProfit: number;
}

export interface BalanceSheetRow {
  /** Null only for the synthesized "Retained Earnings (Current)" row. */
  account_id: number | null;
  account_code: string | null;
  name: string;
  category: string | null;
  amount: number;
}

export interface BalanceSheetResult {
  asOfDate: string;
  assets: BalanceSheetRow[];
  liabilities: BalanceSheetRow[];
  equity: BalanceSheetRow[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  isBalanced: boolean;
}

export interface CashFlowAdjustment {
  category: string;
  amount: number;
}

export interface CashFlowSection {
  adjustments: CashFlowAdjustment[];
  total: number;
}

export interface CashFlowResult {
  from: string;
  to: string;
  netProfit: number;
  operatingActivities: CashFlowSection;
  investingActivities: CashFlowSection;
  financingActivities: CashFlowSection;
  netChangeInCash: number;
  openingCashBalance: number;
  closingCashBalance: number;
  actualClosingCashBalance: number;
  reconciles: boolean;
}

export interface GstSummaryResult {
  from: string;
  to: string;
  inputGst: number;
  outputCgst: number;
  outputSgst: number;
  outputIgst: number;
  totalOutputGst: number;
  netGst: number;
  gstPayableAccountBalance: number;
}
