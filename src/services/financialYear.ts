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
