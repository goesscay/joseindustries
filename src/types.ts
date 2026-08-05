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
  is_active: boolean;
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
  amount: string;
  payment_mode: PaymentMode;
  reference_no: string | null;
  paid_date: string;
  notes: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}
