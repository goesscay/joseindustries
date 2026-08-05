export interface GstLine {
  qty: number;
  rate: number;
  discount_percent: number;
  tax_rate: number;
}

export interface GstSplit {
  isInterState: boolean;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * GST is split into CGST+SGST for intra-state supply, or IGST alone for
 * inter-state supply - determined by comparing the issuing company's state to
 * the customer's state. Never a manual choice; getting this wrong is a common
 * source of GST-filing errors. Computed on the discount-reduced taxable value,
 * not the raw line amount.
 */
/** Lowercases and strips all whitespace so "Tamil Nadu" and "Tamilnadu" - both
 * seen in real records depending on who typed them - compare as the same state. */
function normalizeState(state: string): string {
  return state.replace(/\s+/g, "").toLowerCase();
}

export function computeGstSplit(
  lines: GstLine[],
  companyState: string | null,
  customerState: string | null
): GstSplit {
  const isInterState =
    !!companyState && !!customerState && normalizeState(companyState) !== normalizeState(customerState);

  let taxTotal = 0;
  for (const line of lines) {
    const baseAmount = line.qty * line.rate;
    const taxableValue = baseAmount - (baseAmount * (line.discount_percent || 0)) / 100;
    taxTotal += (taxableValue * line.tax_rate) / 100;
  }
  taxTotal = round2(taxTotal);

  if (isInterState) {
    return { isInterState, cgstTotal: 0, sgstTotal: 0, igstTotal: taxTotal };
  }

  const cgstTotal = round2(taxTotal / 2);
  const sgstTotal = round2(taxTotal - cgstTotal);
  return { isInterState, cgstTotal, sgstTotal, igstTotal: 0 };
}
