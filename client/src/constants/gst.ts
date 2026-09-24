import type { GstType } from "../types";

/** "With GST" / "Without GST" - the two separately-tracked books. */
export const GST_TYPE_OPTIONS: { value: GstType; label: string }[] = [
  { value: "gst", label: "With GST" },
  { value: "non_gst", label: "Without GST" },
];

/** Same options plus an "everything" entry, for report filters. */
export const GST_REPORT_OPTIONS: { value: GstType | "all"; label: string }[] = [
  { value: "all", label: "All transactions" },
  { value: "gst", label: "With GST transactions" },
  { value: "non_gst", label: "Without GST transactions" },
];
