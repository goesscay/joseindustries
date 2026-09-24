import { useState } from "react";
import { Input, message } from "antd";
import { api } from "../api/client";
import { Customer } from "../types";

export interface GstinLookupResult {
  customer: Customer;
  /** "database" = already one of our customers; "gstin_api" = just fetched from the GST portal and saved as a new customer. */
  source: "database" | "gstin_api";
  /** GST portal registration status (only when freshly fetched), e.g. "Active" / "Cancelled". */
  gstStatus?: string | null;
}

interface GstinLookupProps {
  onResult: (result: GstinLookupResult) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/**
 * "Find a customer by GSTIN": a customer we already have is returned straight
 * from our own database; a GSTIN we have never seen is fetched from the GST
 * portal (via the server) and saved as a new customer, so the next lookup is a
 * plain database hit. Either way the caller gets the customer record back.
 */
export function GstinLookup({ onResult, placeholder = "Enter GSTIN to find or add a customer", autoFocus }: GstinLookupProps) {
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);

  async function search(raw: string) {
    const gstin = raw.replace(/\s+/g, "").toUpperCase();
    if (!gstin) return;
    if (!GSTIN_PATTERN.test(gstin)) {
      message.warning("That is not a valid 15-character GSTIN");
      return;
    }
    setLoading(true);
    try {
      const res = await api.get<GstinLookupResult>(`/customers/lookup-gstin/${gstin}`);
      if (res.source === "database") {
        message.success(`Found existing customer: ${res.customer.name}`);
      } else {
        message.success(`Fetched from GST portal and added: ${res.customer.name}`);
        if (res.gstStatus && res.gstStatus.toLowerCase() !== "active") {
          message.warning(`Note: this GSTIN is ${res.gstStatus} on the GST portal`);
        }
      }
      setValue("");
      onResult(res);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "GSTIN lookup failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Input.Search
      value={value}
      onChange={(e) => setValue(e.target.value.toUpperCase())}
      onSearch={search}
      enterButton="Find"
      loading={loading}
      maxLength={15}
      placeholder={placeholder}
      autoFocus={autoFocus}
      allowClear
    />
  );
}
