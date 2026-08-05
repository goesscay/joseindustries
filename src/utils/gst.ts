export interface GstLine {
  qty: number;
  rate: number;
  tax_rate: number;
}

export interface GstSplit {
  isInterState: boolean;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
}

/**
 * GST is split into CGST+SGST for intra-state supply, or IGST alone for
 * inter-state supply - determined by comparing the issuing company's state to
 * the customer's state. Never a manual choice; getting this wrong is a common
 * source of GST-filing errors.
 */
export function computeGstSplit(
  lines: GstLine[],
  companyState: string | null,
  customerState: string | null
): GstSplit {
  const isInterState =
    !!companyState && !!customerState && companyState.trim().toLowerCase() !== customerState.trim().toLowerCase();

  let taxTotal = 0;
  for (const line of lines) {
    taxTotal += (line.qty * line.rate * line.tax_rate) / 100;
  }
  taxTotal = Math.round(taxTotal * 100) / 100;

  if (isInterState) {
    return { isInterState, cgstTotal: 0, sgstTotal: 0, igstTotal: taxTotal };
  }

  const cgstTotal = Math.round((taxTotal / 2) * 100) / 100;
  const sgstTotal = Math.round((taxTotal - cgstTotal) * 100) / 100;
  return { isInterState, cgstTotal, sgstTotal, igstTotal: 0 };
}

/** Groups line items by (HSN code, tax rate) for the tax breakup table. */
export interface HsnGroup {
  hsnCode: string;
  taxRate: number;
  taxableValue: number;
}

export function groupByHsn(
  lines: (GstLine & { hsn_code: string | null })[]
): HsnGroup[] {
  const groups = new Map<string, HsnGroup>();
  for (const line of lines) {
    const hsnCode = line.hsn_code || "-";
    const key = `${hsnCode}|${line.tax_rate}`;
    const taxableValue = line.qty * line.rate;
    const existing = groups.get(key);
    if (existing) {
      existing.taxableValue += taxableValue;
    } else {
      groups.set(key, { hsnCode, taxRate: line.tax_rate, taxableValue });
    }
  }
  return Array.from(groups.values());
}
