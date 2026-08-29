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

-- ============================================================================
-- Phase 2: Accounting foundation - Chart of Accounts + double-entry Journals.
--
-- Added ALONGSIDE the existing accounts / journal_entries tables above,
-- which are left completely untouched and keep working exactly as before
-- (Bank & Cash balances, the manual journal/transfer UI, Day Book, Party
-- Ledger, Profit & Loss, GST Summary, Outstanding - none of that reads from
-- or depends on anything below). Nothing in this block is wired into
-- receipts/vendor_payments/expenses/sales documents yet - see
-- src/services/accounting.ts for the posting rules this lays the ground for
-- and why that wiring is deliberately a separate, later step.
-- ============================================================================

-- One full Chart of Accounts per company (Jose Enterprises and Jose
-- Industries keep entirely separate books, same as the existing `accounts`
-- Bank/Cash table). `category` is a free-text sub-classification (Cash,
-- Bank, Accounts Receivable, Cost of Goods Sold, ...) rather than an ENUM,
-- so new categories never need a schema migration - only `account_type` is
-- constrained, since that drives which financial statement an account rolls
-- up into. `parent_id` gives the code/name hierarchy (1000 Assets -> 1100
-- Current Assets -> 1110 Cash) without hard-coding it anywhere in the app;
-- every account is independently postable regardless of whether it has
-- children (no separate "group vs leaf" flag - keeps this first pass simple).
CREATE TABLE IF NOT EXISTS chart_of_accounts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  parent_id INT UNSIGNED NULL,
  account_code VARCHAR(20) NOT NULL,
  name VARCHAR(150) NOT NULL,
  account_type ENUM('asset', 'liability', 'equity', 'revenue', 'expense') NOT NULL,
  category VARCHAR(100) NULL,
  normal_balance ENUM('debit', 'credit') NOT NULL,
  description TEXT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  -- System/default accounts (seeded below) can't be deleted by users - only
  -- deactivated - since journals may already reference them and the
  -- standard financial-statement rollups assume they exist.
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_coa_code (company_id, account_code),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (parent_id) REFERENCES chart_of_accounts(id)
);

-- Journal header. Every accounting transaction - however it was triggered -
-- is one row here plus >=2 balanced lines in journal_lines below.
-- source_type/source_id optionally point back at whatever business
-- transaction caused this posting (e.g. 'receipt' + receipts.id) once that
-- wiring exists; both stay NULL for manually-entered journals. A journal is
-- created already `posted` (this app has no draft/approval workflow for
-- money movements anywhere today - receipts/vendor_payments/expenses are
-- all immediate, final rows too) and is never edited in place - correcting
-- one means posting an offsetting reversal, tracked via
-- reverses_journal_id, which is how "posted journals aren't casually
-- edited" is enforced (there's deliberately no update route at all).
CREATE TABLE IF NOT EXISTS journals (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  journal_date DATE NOT NULL,
  reference VARCHAR(100) NULL,
  source_type VARCHAR(30) NULL,
  source_id INT UNSIGNED NULL,
  description VARCHAR(255) NULL,
  status ENUM('posted', 'reversed') NOT NULL DEFAULT 'posted',
  reverses_journal_id INT UNSIGNED NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (reverses_journal_id) REFERENCES journals(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Journal lines - the actual debit/credit postings. A journal only balances
-- (Step 4's "Total Debits = Total Credits") when every one of its lines'
-- amounts are summed, which src/services/accounting.ts enforces in a
-- transaction before commit - not something a single-row CHECK constraint
-- can express. The two CHECKs here are the part that *can* be enforced at
-- the database layer as defense-in-depth: an amount is never negative, and
-- a single line is never both a debit and a credit at once.
CREATE TABLE IF NOT EXISTS journal_lines (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  journal_id INT UNSIGNED NOT NULL,
  account_id INT UNSIGNED NOT NULL,
  debit DECIMAL(12, 2) NOT NULL DEFAULT 0,
  credit DECIMAL(12, 2) NOT NULL DEFAULT 0,
  description VARCHAR(255) NULL,
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  CHECK (debit >= 0 AND credit >= 0),
  CHECK (debit = 0 OR credit = 0),
  FOREIGN KEY (journal_id) REFERENCES journals(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES chart_of_accounts(id)
);

-- Standard starter Chart of Accounts, seeded per company (idempotent - the
-- uniq_coa_code key makes this INSERT IGNORE safe to re-run on every
-- migrate, same pattern as the accounts/tax_rates/payment_terms seeds
-- above). Codes leave room to insert siblings later (1110, 1120, 1130... ->
-- could add 1115 without renumbering anything) and match the structure
-- given in the Phase 2 spec exactly, extended with the remaining named
-- categories (Inventory, Fixed Assets, Loans, Capital, Retained Earnings,
-- Drawings, Service Revenue, Other Income, and the Expense subcategories).
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '1000', 'Assets', 'asset', NULL, 'debit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '1100', 'Current Assets', 'asset', NULL, 'debit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '1110', 'Cash', 'asset', 'Cash', 'debit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '1120', 'Bank', 'asset', 'Bank', 'debit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '1130', 'Accounts Receivable', 'asset', 'Accounts Receivable', 'debit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '1140', 'Inventory', 'asset', 'Inventory', 'debit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '1150', 'Other Current Assets', 'asset', 'Other Current Assets', 'debit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '1200', 'Fixed Assets', 'asset', 'Fixed Assets', 'debit', TRUE FROM companies;

INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '2000', 'Liabilities', 'liability', NULL, 'credit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '2100', 'Current Liabilities', 'liability', NULL, 'credit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '2110', 'Accounts Payable', 'liability', 'Accounts Payable', 'credit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '2120', 'GST Payable', 'liability', 'GST/Tax Payable', 'credit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '2130', 'Other Current Liabilities', 'liability', 'Other Current Liabilities', 'credit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '2200', 'Loans', 'liability', 'Loans', 'credit', TRUE FROM companies;

INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '3000', 'Equity', 'equity', NULL, 'credit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '3100', 'Capital', 'equity', 'Capital', 'credit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '3200', 'Retained Earnings', 'equity', 'Retained Earnings', 'credit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '3300', 'Drawings', 'equity', 'Drawings', 'debit', TRUE FROM companies;

INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '4000', 'Revenue', 'revenue', NULL, 'credit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '4100', 'Sales', 'revenue', 'Sales', 'credit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '4200', 'Service Revenue', 'revenue', 'Service Revenue', 'credit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '4300', 'Other Income', 'revenue', 'Other Income', 'credit', TRUE FROM companies;

INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '5000', 'Expenses', 'expense', NULL, 'debit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '5100', 'Cost of Goods Sold', 'expense', 'Cost of Goods Sold', 'debit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '5200', 'Purchases', 'expense', 'Purchases', 'debit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '5300', 'Salaries', 'expense', 'Salaries', 'debit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '5400', 'Rent', 'expense', 'Rent', 'debit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '5500', 'Utilities', 'expense', 'Utilities', 'debit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '5600', 'Travel', 'expense', 'Travel', 'debit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '5700', 'Office Expenses', 'expense', 'Office Expenses', 'debit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '5800', 'Bank Charges', 'expense', 'Bank Charges', 'debit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '5900', 'Other Expenses', 'expense', 'Other Expenses', 'debit', TRUE FROM companies;

-- Wire up the parent/child hierarchy now that every row above exists (can't
-- self-reference a sibling's id in the same INSERT). Safe to re-run - it's
-- just re-pointing the same rows at the same parents every time.
UPDATE chart_of_accounts child
JOIN chart_of_accounts parent
  ON parent.company_id = child.company_id AND parent.account_code = '1000'
SET child.parent_id = parent.id
WHERE child.account_code = '1100';

UPDATE chart_of_accounts child
JOIN chart_of_accounts parent
  ON parent.company_id = child.company_id AND parent.account_code = '1100'
SET child.parent_id = parent.id
WHERE child.account_code IN ('1110', '1120', '1130', '1140', '1150');

UPDATE chart_of_accounts child
JOIN chart_of_accounts parent
  ON parent.company_id = child.company_id AND parent.account_code = '1000'
SET child.parent_id = parent.id
WHERE child.account_code = '1200';

UPDATE chart_of_accounts child
JOIN chart_of_accounts parent
  ON parent.company_id = child.company_id AND parent.account_code = '2000'
SET child.parent_id = parent.id
WHERE child.account_code = '2100';

UPDATE chart_of_accounts child
JOIN chart_of_accounts parent
  ON parent.company_id = child.company_id AND parent.account_code = '2100'
SET child.parent_id = parent.id
WHERE child.account_code IN ('2110', '2120', '2130');

UPDATE chart_of_accounts child
JOIN chart_of_accounts parent
  ON parent.company_id = child.company_id AND parent.account_code = '2000'
SET child.parent_id = parent.id
WHERE child.account_code = '2200';

UPDATE chart_of_accounts child
JOIN chart_of_accounts parent
  ON parent.company_id = child.company_id AND parent.account_code = '3000'
SET child.parent_id = parent.id
WHERE child.account_code IN ('3100', '3200', '3300');

UPDATE chart_of_accounts child
JOIN chart_of_accounts parent
  ON parent.company_id = child.company_id AND parent.account_code = '4000'
SET child.parent_id = parent.id
WHERE child.account_code IN ('4100', '4200', '4300');

UPDATE chart_of_accounts child
JOIN chart_of_accounts parent
  ON parent.company_id = child.company_id AND parent.account_code = '5000'
SET child.parent_id = parent.id
WHERE child.account_code IN ('5100', '5200', '5300', '5400', '5500', '5600', '5700', '5800', '5900');

-- Optional link from an existing Bank & Cash account (accounts.ts) to the
-- Chart-of-Accounts leaf it corresponds to, for when journal-posting is
-- wired in later - nullable, no FK constraint added via ALTER (MariaDB's
-- IF NOT EXISTS support doesn't extend to ADD CONSTRAINT, same reasoning as
-- receipts.account_id/vendor_payments.account_id above). Backfilled
-- deterministically by account_type (every 'cash' row -> the company's
-- "1110 Cash" leaf, every 'bank' row -> "1120 Bank") since that mapping is
-- unambiguous and safe; only fills blanks, so a manually-changed link is
-- never overwritten on a later migrate.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS chart_account_id INT UNSIGNED NULL;

UPDATE accounts a
JOIN chart_of_accounts coa
  ON coa.company_id = a.company_id AND coa.account_code = '1110'
SET a.chart_account_id = coa.id
WHERE a.account_type = 'cash' AND a.chart_account_id IS NULL;

UPDATE accounts a
JOIN chart_of_accounts coa
  ON coa.company_id = a.company_id AND coa.account_code = '1120'
SET a.chart_account_id = coa.id
WHERE a.account_type = 'bank' AND a.chart_account_id IS NULL;

-- Phase 4: Tax Invoice accounting needs to distinguish Output CGST / Output
-- SGST / Output IGST separately (a Tax Invoice's GST fields are already
-- split this way - see documents.cgst_total/sgst_total/igst_total). The
-- existing '2120' 'GST Payable' node predates this and is left completely
-- untouched (still available for manual/GST-return entries that want one
-- combined account) - these are new siblings under Current Liabilities,
-- never renumbering anything above. Idempotent via uniq_coa_code, same as
-- every other chart_of_accounts seed row.
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '2121', 'Output CGST', 'liability', 'Output CGST', 'credit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '2122', 'Output SGST', 'liability', 'Output SGST', 'credit', TRUE FROM companies;
INSERT IGNORE INTO chart_of_accounts (company_id, account_code, name, account_type, category, normal_balance, is_system)
SELECT id, '2123', 'Output IGST', 'liability', 'Output IGST', 'credit', TRUE FROM companies;

UPDATE chart_of_accounts child
JOIN chart_of_accounts parent
  ON parent.company_id = child.company_id AND parent.account_code = '2100'
SET child.parent_id = parent.id
WHERE child.account_code IN ('2121', '2122', '2123');

-- Phase 5: General Ledger / Trial Balance filter and join heavily on
-- (company_id, journal_date, status) and (source_type, source_id) - neither
-- had a dedicated index before (journal_lines.account_id already has one
-- via its FK constraint, which is what these two reports' account-scoped
-- queries lean on). Additive and idempotent, like every other schema
-- change in this file.
ALTER TABLE journals ADD INDEX IF NOT EXISTS idx_journals_company_date (company_id, journal_date);
ALTER TABLE journals ADD INDEX IF NOT EXISTS idx_journals_source (source_type, source_id);
