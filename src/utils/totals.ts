export interface LineInput {
  qty: number;
  rate: number;
  tax_rate: number;
}

export function computeLineTotal(line: LineInput): number {
  return Math.round(line.qty * line.rate * 100) / 100;
}

export function computeTotals(lines: LineInput[]) {
  let subtotal = 0;
  let taxTotal = 0;

  for (const line of lines) {
    const base = line.qty * line.rate;
    subtotal += base;
    taxTotal += (base * line.tax_rate) / 100;
  }

  subtotal = Math.round(subtotal * 100) / 100;
  taxTotal = Math.round(taxTotal * 100) / 100;
  const grandTotal = Math.round((subtotal + taxTotal) * 100) / 100;

  return { subtotal, taxTotal, grandTotal };
}
