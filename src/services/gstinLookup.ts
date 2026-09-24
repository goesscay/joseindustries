// Looks a GSTIN up on the external GSTIN API (https://www.gstinapi.in) and maps
// the result onto this app's customer fields. Every external lookup consumes a
// paid credit, so callers must check our own customers table first and only
// come here for a GSTIN we don't already have.

const API_BASE = "https://www.gstinapi.in/v1/gstin";

// 2 digits state code + 5 letters + 4 digits + 1 letter + 1 alphanumeric entity
// number + 'Z' + 1 alphanumeric checksum.
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

// GST state / UT codes -> names, spelled the way customers' `state` is entered
// elsewhere in the app (state comparison for CGST+SGST vs IGST ignores case and
// spacing, so "Tamil Nadu" and "Tamilnadu" both work).
const STATE_NAMES: Record<string, string> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
};

export class GstinLookupError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface GstinDetails {
  gstin: string;
  name: string;
  billing_address: string | null;
  state: string | null;
  /** Registration status on the GST portal, e.g. "Active" / "Cancelled". */
  gstStatus: string | null;
}

export function normalizeGstin(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

export async function fetchGstinDetails(gstin: string): Promise<GstinDetails> {
  const apiKey = process.env.GSTIN_API_KEY;
  if (!apiKey) {
    throw new GstinLookupError("GSTIN lookup is not configured (GSTIN_API_KEY is missing on the server)", 503);
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/${encodeURIComponent(gstin)}`, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new GstinLookupError("Could not reach the GSTIN lookup service - try again in a moment", 502);
  }

  const body: any = await res.json().catch(() => null);
  if (res.status === 404 || (body && body.success === false && res.status < 500 && res.status !== 401 && res.status !== 402 && res.status !== 429)) {
    throw new GstinLookupError(`GSTIN ${gstin} was not found on the GST portal`, 404);
  }
  if (res.status === 401 || res.status === 403) {
    throw new GstinLookupError("The GSTIN lookup API key was rejected - check GSTIN_API_KEY", 502);
  }
  if (res.status === 402) {
    throw new GstinLookupError("The GSTIN lookup service is out of credits", 502);
  }
  if (res.status === 429) {
    throw new GstinLookupError("Too many GSTIN lookups just now - wait a minute and try again", 429);
  }
  if (!res.ok || !body?.success || !body.data) {
    throw new GstinLookupError("The GSTIN lookup service returned an unexpected response", 502);
  }

  const d = body.data;
  const name = String(d.trade_name || d.legal_name || "").trim();
  if (!name) throw new GstinLookupError("The GST portal returned no name for this GSTIN", 502);

  const address = [d.address, d.pincode ? `- ${d.pincode}` : null].filter(Boolean).join(" ").trim();
  const stateCode = String(d.state_code || gstin.slice(0, 2));

  return {
    gstin,
    name,
    billing_address: address || null,
    state: STATE_NAMES[stateCode] ?? null,
    gstStatus: d.status ?? null,
  };
}
