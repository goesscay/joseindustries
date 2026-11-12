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

/** A GSTIN's first two characters are the GST state code it was registered
 * under - fixed at registration, never mistyped or left blank the way a
 * free-text `state` field can be. */
function stateCodeFromGstin(gstin: string | null | undefined): string | null {
  const code = gstin?.trim().slice(0, 2);
  return code && /^\d{2}$/.test(code) ? code : null;
}

/** Inter-state (IGST) or intra-state (CGST+SGST)? GSTIN state codes decide it
 * when both parties have one; otherwise the free-text state names are compared. */
export function isInterStateSupply(
  companyState: string | null,
  partyState: string | null,
  companyGstin?: string | null,
  partyGstin?: string | null
): boolean {
  const companyCode = stateCodeFromGstin(companyGstin);
  const partyCode = stateCodeFromGstin(partyGstin);
  return companyCode && partyCode
    ? companyCode !== partyCode
    : !!companyState && !!partyState && normalizeState(companyState) !== normalizeState(partyState);
}

export function computeGstSplit(
  lines: GstLine[],
  companyState: string | null,
  customerState: string | null,
  companyGstin?: string | null,
  customerGstin?: string | null
): GstSplit {
  // Both parties are always meant to be on the same footing here: every
  // company this app issues documents for is GST-registered, so it always
  // has a GSTIN. A B2B customer usually does too. When both GSTINs are on
  // record, their state codes settle inter-state vs intra-state outright -
  // this is what actually decides GST, and it can never be blank or
  // misspelled the way the free-text `state` field can. Only an
  // unregistered/consumer customer (no GSTIN) falls back to comparing the
  // free-text state names.
  const isInterState = isInterStateSupply(companyState, customerState, companyGstin, customerGstin);

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
