/**
 * Indian financial year runs April 1 - March 31, formatted as e.g. "25-26"
 * for the year starting April 2025.
 */
export function getFinancialYear(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed; 3 = April
  const startYear = month >= 3 ? year : year - 1;
  const endYear = startYear + 1;

  const two = (y: number) => String(y % 100).padStart(2, "0");
  return `${two(startYear)}-${two(endYear)}`;
}

// ---- Double-entry rollout, Phase G: Year-End Closing / Period Lock. Every
// FY string this app ever produces/consumes is a 2-digit-year pair like
// "25-26" (see getFinancialYear above) - these three helpers all assume
// that exact shape and a 2000s century, matching this app's entire
// operating window (same assumption getFinancialYear itself already makes
// by only storing 2-digit years). ----

/** "25-26" -> { startDate: "2025-04-01", endDate: "2026-03-31" }. */
export function getFinancialYearBounds(financialYear: string): { startDate: string; endDate: string } {
  const [startTwo, endTwo] = financialYear.split("-").map(Number);
  return {
    startDate: `${2000 + startTwo}-04-01`,
    endDate: `${2000 + endTwo}-03-31`,
  };
}

/** "25-26" -> "26-27" - the financial year immediately following. */
export function getNextFinancialYear(financialYear: string): string {
  const [startTwo, endTwo] = financialYear.split("-").map(Number);
  const next = (n: number) => String((n + 1) % 100).padStart(2, "0");
  return `${next(startTwo)}-${next(endTwo)}`;
}

/** "25-26" -> "24-25" - the financial year immediately before. */
export function getPreviousFinancialYear(financialYear: string): string {
  const [startTwo, endTwo] = financialYear.split("-").map(Number);
  const prev = (n: number) => String((n + 99) % 100).padStart(2, "0");
  return `${prev(startTwo)}-${prev(endTwo)}`;
}
