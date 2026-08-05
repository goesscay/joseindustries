export interface LineInput {
  qty: number;
  rate: number;
  discount_percent: number;
  tax_rate: number;
}

export interface LineComputed {
  baseAmount: number; // qty * rate, before discount
  discountAmount: number; // baseAmount * discount_percent / 100
  taxableValue: number; // baseAmount - discountAmount - what GST is computed on
  taxAmount: number; // taxableValue * tax_rate / 100
  lineTotal: number; // taxableValue + taxAmount - the tax-inclusive "Amount" column
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeLine(line: LineInput): LineComputed {
  const baseAmount = round2(line.qty * line.rate);
  const discountAmount = round2((baseAmount * (line.discount_percent || 0)) / 100);
  const taxableValue = round2(baseAmount - discountAmount);
  const taxAmount = round2((taxableValue * (line.tax_rate || 0)) / 100);
  const lineTotal = round2(taxableValue + taxAmount);
  return { baseAmount, discountAmount, taxableValue, taxAmount, lineTotal };
}

/** Backward-compatible helper - the tax-inclusive amount for one line. */
export function computeLineTotal(line: LineInput): number {
  return computeLine(line).lineTotal;
}

export interface DocumentCharges {
  freightCharges?: number;
  installationCharges?: number;
}

export interface DocumentTotals {
  subtotal: number; // sum of post-discount taxable values (the GST base)
  discountAmount: number; // sum of per-line discounts, informational
  taxTotal: number;
  freightCharges: number;
  installationCharges: number;
  roundOff: number;
  grandTotal: number;
}

/**
 * Discount reduces the taxable value GST is computed on; freight and
 * installation are non-taxable charges added after tax. Grand total is
 * rounded to the nearest rupee, with the adjustment recorded as roundOff -
 * standard Indian invoicing practice.
 */
export function computeTotals(lines: LineInput[], charges: DocumentCharges = {}): DocumentTotals {
  let subtotal = 0;
  let discountAmount = 0;
  let taxTotal = 0;

  for (const line of lines) {
    const computed = computeLine(line);
    subtotal += computed.taxableValue;
    discountAmount += computed.discountAmount;
    taxTotal += computed.taxAmount;
  }

  subtotal = round2(subtotal);
  discountAmount = round2(discountAmount);
  taxTotal = round2(taxTotal);

  const freightCharges = round2(charges.freightCharges || 0);
  const installationCharges = round2(charges.installationCharges || 0);

  const rawTotal = subtotal + taxTotal + freightCharges + installationCharges;
  const grandTotal = Math.round(rawTotal);
  const roundOff = round2(grandTotal - rawTotal);

  return { subtotal, discountAmount, taxTotal, freightCharges, installationCharges, roundOff, grandTotal };
}
