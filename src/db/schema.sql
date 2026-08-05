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

  subtotal DECIMAL(12, 2) NOT NULL DEFAULT 0,
  cgst_total DECIMAL(12, 2) NOT NULL DEFAULT 0,
  sgst_total DECIMAL(12, 2) NOT NULL DEFAULT 0,
  igst_total DECIMAL(12, 2) NOT NULL DEFAULT 0,
  tax_total DECIMAL(12, 2) NOT NULL DEFAULT 0,
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
  tax_rate DECIMAL(5, 2) NOT NULL DEFAULT 0,
  line_total DECIMAL(12, 2) NOT NULL DEFAULT 0,
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES items(id)
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
