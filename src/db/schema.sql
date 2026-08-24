CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('super_admin', 'admin', 'staff') NOT NULL DEFAULT 'staff',
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Sales documents module (Phase 1: companies, customers, items, quotations)

-- The two GST-registered entities documents are raised under (Jose Enterprises,
-- Jose Industries). Each has its own GSTIN, bank account, and invoice series.
CREATE TABLE IF NOT EXISTS companies (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(10) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  tagline VARCHAR(255) NULL,
  address TEXT NULL,
  phone VARCHAR(100) NULL,
  email VARCHAR(255) NULL,
  gstin VARCHAR(15) NULL,
  state VARCHAR(100) NULL,
  state_code VARCHAR(5) NULL,
  bank_name VARCHAR(100) NULL,
  bank_account_no VARCHAR(50) NULL,
  bank_ifsc VARCHAR(20) NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customers (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  gstin VARCHAR(15) NULL,
  phone VARCHAR(20) NULL,
  email VARCHAR(255) NULL,
  billing_address TEXT NULL,
  shipping_address TEXT NULL,
  state VARCHAR(100) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS items (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  hsn_code VARCHAR(20) NULL,
  unit VARCHAR(50) NOT NULL DEFAULT 'pcs',
  default_rate DECIMAL(12, 2) NOT NULL DEFAULT 0,
  tax_rate DECIMAL(5, 2) NOT NULL DEFAULT 18.00,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- One atomic counter per (document type, company, financial year) - each company
-- has its own independent invoice series. Incremented with the
-- LAST_INSERT_ID(expr) trick so concurrent requests never see the same number.
CREATE TABLE IF NOT EXISTS doc_counters (
  doc_type VARCHAR(30) NOT NULL,
  company_code VARCHAR(10) NOT NULL,
  financial_year VARCHAR(10) NOT NULL,
  last_number INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (doc_type, company_code, financial_year)
);

-- Shared table for all document types (quotation, proforma_invoice,
-- delivery_challan, tax_invoice, receipt) added phase by phase. Field set
-- matches the company's existing Tally-style Tax Invoice template so later
-- phases (Proforma/Challan/Tax Invoice) need no further schema changes.
CREATE TABLE IF NOT EXISTS documents (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  doc_type ENUM('quotation', 'proforma_invoice', 'delivery_challan', 'tax_invoice', 'receipt') NOT NULL,
  doc_number VARCHAR(40) NOT NULL,
  financial_year VARCHAR(10) NOT NULL,
  company_id INT UNSIGNED NOT NULL,
  customer_id INT UNSIGNED NOT NULL,
  status ENUM('draft', 'sent', 'accepted', 'rejected', 'cancelled') NOT NULL DEFAULT 'draft',
  converted_from_id INT UNSIGNED NULL,
  issue_date DATE NOT NULL,
  notes TEXT NULL,

  -- Consignee / "Shipped To" - only needed when different from the buyer
  consignee_name VARCHAR(255) NULL,
  consignee_address TEXT NULL,
  consignee_gstin VARCHAR(15) NULL,
  consignee_state VARCHAR(100) NULL,

  -- Transport / dispatch (Tally-style reference fields)
  transport_mode VARCHAR(100) NULL,
  vehicle_number VARCHAR(50) NULL,
  date_of_supply DATE NULL,
  place_of_supply VARCHAR(100) NULL,
  buyers_order_no VARCHAR(100) NULL,
  buyers_order_date DATE NULL,
  dispatch_doc_no VARCHAR(100) NULL,
  dispatched_through VARCHAR(100) NULL,
  destination VARCHAR(100) NULL,
  terms_of_delivery VARCHAR(255) NULL,
  delivery_note VARCHAR(100) NULL,
  delivery_note_date DATE NULL,
  mode_terms_of_payment VARCHAR(255) NULL,
  other_reference VARCHAR(255) NULL,
  supplier_reference VARCHAR(255) NULL,

  -- Invoice-style fields matching the company's printed Tax Invoice template
  due_date DATE NULL,
  credit_period VARCHAR(50) NULL,
  reverse_charge BOOLEAN NOT NULL DEFAULT FALSE,

  subtotal DECIMAL(12, 2) NOT NULL DEFAULT 0,
  discount_amount DECIMAL(12, 2) NOT NULL DEFAULT 0,
  freight_charges DECIMAL(12, 2) NOT NULL DEFAULT 0,
  installation_charges DECIMAL(12, 2) NOT NULL DEFAULT 0,
  cgst_total DECIMAL(12, 2) NOT NULL DEFAULT 0,
  sgst_total DECIMAL(12, 2) NOT NULL DEFAULT 0,
  igst_total DECIMAL(12, 2) NOT NULL DEFAULT 0,
  tax_total DECIMAL(12, 2) NOT NULL DEFAULT 0,
  round_off DECIMAL(12, 2) NOT NULL DEFAULT 0,
  grand_total DECIMAL(12, 2) NOT NULL DEFAULT 0,

  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_doc_number (doc_type, doc_number),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (converted_from_id) REFERENCES documents(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS document_items (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  document_id INT UNSIGNED NOT NULL,
  item_id INT UNSIGNED NULL,
  description VARCHAR(255) NOT NULL,
  hsn_code VARCHAR(20) NULL,
  qty DECIMAL(10, 2) NOT NULL DEFAULT 1,
  unit VARCHAR(50) NOT NULL DEFAULT 'pcs',
  rate DECIMAL(12, 2) NOT NULL DEFAULT 0,
  discount_percent DECIMAL(5, 2) NOT NULL DEFAULT 0,
  tax_rate DECIMAL(5, 2) NOT NULL DEFAULT 0,
  line_total DECIMAL(12, 2) NOT NULL DEFAULT 0,
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES items(id)
);

-- Idempotent for existing databases (fresh installs already get these columns
-- from the CREATE TABLE statements above; MariaDB/MySQL 8+ support IF NOT EXISTS
-- on ADD COLUMN, so this block is safe to re-run on every migrate).
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS due_date DATE NULL,
  ADD COLUMN IF NOT EXISTS credit_period VARCHAR(50) NULL,
  ADD COLUMN IF NOT EXISTS reverse_charge BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS discount_amount DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS freight_charges DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS installation_charges DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS round_off DECIMAL(12, 2) NOT NULL DEFAULT 0;

ALTER TABLE document_items
  ADD COLUMN IF NOT EXISTS discount_percent DECIMAL(5, 2) NOT NULL DEFAULT 0;

-- Accounts module (simple cash-basis tracker): the "purchases" mirror of the
-- Sales module above. Vendors mirror customers; expenses mirror documents but
-- are deliberately their own table (no line items, no GST split logic needed
-- for a first pass); vendor_payments mirrors receipts.

CREATE TABLE IF NOT EXISTS vendors (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  gstin VARCHAR(15) NULL,
  phone VARCHAR(20) NULL,
  email VARCHAR(255) NULL,
  address TEXT NULL,
  state VARCHAR(100) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Small editable lookup list (Raw Material, Salaries, Rent, ...), seeded below.
CREATE TABLE IF NOT EXISTS expense_categories (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT IGNORE INTO expense_categories (name) VALUES
  ('Raw Material'), ('Salaries & Wages'), ('Rent'), ('Electricity'),
  ('Transport & Freight'), ('Office Supplies'), ('Repairs & Maintenance'), ('Miscellaneous');

-- One row per purchase bill/expense. company/vendor scoped and auto-numbered
-- (EXP/<company>/<FY>/<seq>) via the same doc_counters series the Sales
-- module uses, so numbering stays collision-free across both directions of
-- money movement.
CREATE TABLE IF NOT EXISTS expenses (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  expense_no VARCHAR(40) NOT NULL,
  financial_year VARCHAR(10) NOT NULL,
  company_id INT UNSIGNED NOT NULL,
  vendor_id INT UNSIGNED NULL,
  category_id INT UNSIGNED NULL,
  expense_date DATE NOT NULL,
  description VARCHAR(255) NULL,
  amount DECIMAL(12, 2) NOT NULL,
  tax_amount DECIMAL(12, 2) NOT NULL DEFAULT 0,
  total_amount DECIMAL(12, 2) NOT NULL,
  reference_no VARCHAR(100) NULL,
  notes TEXT NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_expense_no (expense_no),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (vendor_id) REFERENCES vendors(id),
  FOREIGN KEY (category_id) REFERENCES expense_categories(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Money paid out - against a specific expense/bill, or on-account to a vendor
-- (expense_id NULL). Mirrors receipts.
CREATE TABLE IF NOT EXISTS vendor_payments (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  payment_no VARCHAR(40) NOT NULL,
  financial_year VARCHAR(10) NOT NULL,
  company_id INT UNSIGNED NOT NULL,
  vendor_id INT UNSIGNED NOT NULL,
  expense_id INT UNSIGNED NULL,
  amount DECIMAL(12, 2) NOT NULL,
  payment_mode ENUM('cash', 'cheque', 'bank_transfer', 'upi', 'card', 'other') NOT NULL DEFAULT 'cash',
  reference_no VARCHAR(100) NULL,
  paid_date DATE NOT NULL,
  notes TEXT NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_payment_no (payment_no),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (vendor_id) REFERENCES vendors(id),
  FOREIGN KEY (expense_id) REFERENCES expenses(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Phase 3: payments received against a Tax Invoice. Kept as its own table
-- (rather than another `documents` row) since a receipt's shape - one payment,
-- one payment mode, one linked invoice - doesn't fit the line-items model the
-- other document types share. Still uses the same doc_counters series
-- (doc_type = 'receipt') for its RCT/<company>/<FY>/<seq> numbering.
CREATE TABLE IF NOT EXISTS receipts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  receipt_no VARCHAR(40) NOT NULL,
  financial_year VARCHAR(10) NOT NULL,
  company_id INT UNSIGNED NOT NULL,
  customer_id INT UNSIGNED NOT NULL,
  tax_invoice_id INT UNSIGNED NULL,
  amount DECIMAL(12, 2) NOT NULL,
  payment_mode ENUM('cash', 'cheque', 'bank_transfer', 'upi', 'card', 'other') NOT NULL DEFAULT 'cash',
  reference_no VARCHAR(100) NULL,
  received_date DATE NOT NULL,
  notes TEXT NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_receipt_no (receipt_no),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (tax_invoice_id) REFERENCES documents(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Accounts Phase B: Cash & Bank ledgers. Every money movement (a Receipt in,
-- a Vendor Payment out, or a manual Journal Entry) posts against one of
-- these, giving each a running balance. Company-scoped since Jose
-- Enterprises and Jose Industries keep separate books.
CREATE TABLE IF NOT EXISTS accounts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  name VARCHAR(100) NOT NULL,
  account_type ENUM('cash', 'bank') NOT NULL DEFAULT 'bank',
  bank_name VARCHAR(100) NULL,
  account_number VARCHAR(50) NULL,
  ifsc VARCHAR(20) NULL,
  opening_balance DECIMAL(12, 2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_account_name (company_id, name),
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

-- Manual entries for anything that isn't a Receipt or Vendor Payment -
-- opening balances, bank charges/interest, owner's capital, petty cash
-- drawdowns. A transfer between two accounts is recorded as a linked pair
-- (same transfer_group) so it can be shown/deleted together.
CREATE TABLE IF NOT EXISTS journal_entries (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id INT UNSIGNED NOT NULL,
  entry_date DATE NOT NULL,
  direction ENUM('in', 'out') NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  particulars VARCHAR(255) NOT NULL,
  notes TEXT NULL,
  transfer_group CHAR(36) NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Every money movement now posts against a ledger account. Column only (no
-- FK constraint added via ALTER - MariaDB's IF NOT EXISTS support doesn't
-- extend to ADD CONSTRAINT); the app enforces the reference on write, same
-- as other nullable lookups added via ALTER elsewhere in this file.
ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS account_id INT UNSIGNED NULL;

ALTER TABLE vendor_payments
  ADD COLUMN IF NOT EXISTS account_id INT UNSIGNED NULL;

-- One-time seed: turn each existing company's printed bank details into a
-- first-class Bank account, plus a Cash account, so Phase B ships with
-- ledgers ready to use instead of an empty list. Safe to re-run (unique key
-- on company_id+name makes this idempotent).
INSERT IGNORE INTO accounts (company_id, name, account_type, bank_name, account_number, ifsc, opening_balance)
SELECT id, 'Cash', 'cash', NULL, NULL, NULL, 0 FROM companies;

INSERT IGNORE INTO accounts (company_id, name, account_type, bank_name, account_number, ifsc, opening_balance)
SELECT id, COALESCE(bank_name, 'Bank'), 'bank', bank_name, bank_account_no, bank_ifsc, 0
FROM companies WHERE bank_name IS NOT NULL;

-- Settings: reusable master lists that back dropdowns elsewhere in the app,
-- plus a couple of small per-company configuration fields. All simple
-- lookup tables - no relation columns needed, since documents/items still
-- store the chosen rate/term as a plain value (matches how the app already
-- treats HSN/tax_rate as freeform per-line values, not foreign keys).
CREATE TABLE IF NOT EXISTS tax_rates (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  label VARCHAR(50) NOT NULL,
  rate DECIMAL(5, 2) NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_tax_rate (rate)
);

INSERT IGNORE INTO tax_rates (label, rate, is_default) VALUES
  ('GST 0%', 0, FALSE),
  ('GST 5%', 5, FALSE),
  ('GST 12%', 12, FALSE),
  ('GST 18%', 18, TRUE),
  ('GST 28%', 28, FALSE);

CREATE TABLE IF NOT EXISTS payment_terms (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  label VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_payment_term (label)
);

INSERT IGNORE INTO payment_terms (label) VALUES
  ('100% Advance'),
  ('50% Advance, Balance in 15 Days'),
  ('Net 15'),
  ('Net 30'),
  ('Cash on Delivery');

-- Terms & Conditions text printed on generated PDFs, editable per company.
-- Null/empty means "use the built-in default wording" (documentPdf.ts).
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS terms_and_conditions TEXT NULL;

-- Reusable, editable Terms & Conditions wording a user can pick when creating
-- a Quotation/Proforma Invoice/Delivery Challan/Tax Invoice, tagged to which
-- document type(s) it's meant for ('all' shows up as an option everywhere).
-- Picking one only pre-fills the document's own terms_and_conditions text
-- below - the document always stores its own (possibly then hand-edited)
-- copy, so editing or deleting a template later never changes documents
-- that already used it.
CREATE TABLE IF NOT EXISTS terms_and_conditions_templates (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  doc_type ENUM('all', 'quotation', 'proforma_invoice', 'delivery_challan', 'tax_invoice') NOT NULL DEFAULT 'all',
  content TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

INSERT IGNORE INTO terms_and_conditions_templates (id, title, doc_type, content, is_default) VALUES
  (1, 'Standard Terms', 'all',
   'Goods once sold will not be taken back unless otherwise agreed in writing.\nPayment shall be made according to the agreed payment terms.\nAny shortage or damage should be reported immediately upon receipt of goods.\nWarranty, where applicable, is governed by the agreed quotation / order terms.\nTransportation and installation charges are applicable as agreed.\nAll disputes are subject to Chennai jurisdiction.\nThis document is subject to applicable GST laws and regulations.',
   TRUE);

-- Per-document override of the printed Terms & Conditions text - populated
-- (and then freely editable) from a terms_and_conditions_templates row, but
-- stored as plain text on the document itself so it survives template edits.
-- Falls back to companies.terms_and_conditions, then the built-in default,
-- when left blank - same fallback chain as before this table existed.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS terms_and_conditions TEXT NULL;

-- Fine-grained module/action permissions, layered on top of the existing
-- role system rather than replacing it. super_admin and admin ALWAYS have
-- full access to every module and account (see src/utils/permissions.ts) -
-- these tables only ever get consulted for 'staff'.
--
-- Fallback contract (important for not breaking anyone on deploy): a staff
-- user with ZERO rows in user_permissions has full, unrestricted access to
-- every module - identical to today's behaviour before this table existed.
-- The moment an admin saves ANY row for that user, the user flips into
-- "allowlist mode": any module without a row (or with a false flag) is
-- denied for that action. This means existing staff accounts are completely
-- unaffected until an admin deliberately opens the new Access tab and
-- configures them.
CREATE TABLE IF NOT EXISTS user_permissions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  module_key VARCHAR(60) NOT NULL,
  can_view BOOLEAN NOT NULL DEFAULT FALSE,
  can_create BOOLEAN NOT NULL DEFAULT FALSE,
  can_edit BOOLEAN NOT NULL DEFAULT FALSE,
  can_delete BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_user_module (user_id, module_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Same fallback contract as above, scoped to individual Bank & Cash
-- accounts: zero rows for a user = unrestricted (sees/uses every account,
-- today's behaviour); any row present = allowlist of exactly those
-- accounts. Lets an admin hand a staff member (e.g. a cashier) access to
-- just the one till/account they handle, without touching every other
-- account in the books.
CREATE TABLE IF NOT EXISTS user_account_access (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  account_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_user_account (user_id, account_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- Sales pipeline entry point, upstream of Customers/Quotations: a prospect
-- gets tracked here (source, pipeline stage, estimated value, follow-up)
-- before there's a real deal worth turning into a Customer record. Fields
-- match the standard CRM lead-capture set (contact details, qualification,
-- ownership, address/tax so a converted Customer needs no re-entry).
CREATE TABLE IF NOT EXISTS leads (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  contact_person VARCHAR(255) NULL,
  designation VARCHAR(100) NULL,
  phone VARCHAR(20) NULL,
  email VARCHAR(255) NULL,

  source ENUM('website', 'referral', 'cold_call', 'walk_in', 'advertisement', 'social_media', 'trade_show', 'existing_customer', 'other')
    NOT NULL DEFAULT 'other',
  status ENUM('new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost') NOT NULL DEFAULT 'new',
  industry VARCHAR(100) NULL,
  estimated_value DECIMAL(12, 2) NOT NULL DEFAULT 0,
  expected_close_date DATE NULL,
  lost_reason VARCHAR(255) NULL,

  gstin VARCHAR(15) NULL,
  state VARCHAR(100) NULL,
  address TEXT NULL,

  assigned_to INT UNSIGNED NULL,
  next_follow_up_date DATE NULL,
  notes TEXT NULL,

  -- Set once this lead becomes a real Customer (see POST /leads/:id/convert)
  -- - kept even if the lead is later edited, as the paper trail of where
  -- that Customer came from.
  converted_customer_id INT UNSIGNED NULL,

  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (converted_customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
