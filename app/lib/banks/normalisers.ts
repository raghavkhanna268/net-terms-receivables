/**
 * Normalisers for Indian bank statement data.
 * Handles Indian date formats and amount formatting.
 *
 * Part of S14/S15: Net Terms Receivables bank statement parsing.
 */

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86400000;
const EXCEL_SERIAL_MIN = 32874;
const EXCEL_SERIAL_MAX = 73415;
const EXCEL_SERIAL_STRING_PATTERN = /^\d{5}(\.\d+)?$/;

/**
 * Check if a number is a valid Excel serial date in the plausible range.
 * Range: 1990-01-01 (32874) to 2100-12-31 (73415).
 */
function isValidExcelSerial(n: number): boolean {
  if (!Number.isFinite(n)) return false;
  const intPart = Math.floor(n);
  return intPart >= EXCEL_SERIAL_MIN && intPart <= EXCEL_SERIAL_MAX;
}

/**
 * Check if a string looks like a 5-digit Excel serial date in the plausible range.
 * Pattern: exactly 5 digits, optionally followed by decimal fraction.
 * This does NOT collide with dd/mm/yy (6 digits) or dd/mm/yyyy (8 digits).
 * Used by parsers to allow serial strings through the "date looks valid" check.
 */
export function looksLikeExcelSerialString(s: string): boolean {
  if (!EXCEL_SERIAL_STRING_PATTERN.test(s)) return false;
  const intPart = Math.floor(parseFloat(s));
  return intPart >= EXCEL_SERIAL_MIN && intPart <= EXCEL_SERIAL_MAX;
}

/**
 * Check if a raw date value was a serial (number or 5-digit string) that main couldn't parse.
 * Used for dedupe hash stability: on main, serial values failed to parse and weren't
 * included in the hash. We need to preserve that behavior even though we now parse them.
 */
export function wasUnparseableOnMain(raw: string | Date | number | null | undefined): boolean {
  if (raw === null || raw === undefined) return false;
  if (raw instanceof Date) return false;
  if (typeof raw === "number") return true;
  return looksLikeExcelSerialString(String(raw).trim());
}

/**
 * Convert Excel serial date to ISO 8601 date string (YYYY-MM-DD).
 * Uses 1899-12-30 epoch with no +1 adjustment.
 * Drops fractional time part.
 */
function excelSerialToIsoDate(serial: number): string {
  const days = Math.floor(serial);
  const ms = EXCEL_EPOCH_MS + days * MS_PER_DAY;
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return formatIsoDate(year, month, day);
}

/** Options for parseIndianDate */
export interface ParseDateOptions {
  /** Allow Excel serial dates (numbers and 5-digit strings). Default: false (main's behavior). */
  allowExcelSerial?: boolean;
}

/**
 * Parse Indian date formats to ISO 8601 (YYYY-MM-DD).
 *
 * Supported formats:
 * - dd/mm/yy (HDFC: 15/03/26)
 * - dd/mm/yyyy (HDFC: 15/03/2026)
 * - dd-mm-yyyy (ICICI: 15-03-2026)
 * - dd.mm.yyyy (ICICI retail: 15.03.2026)
 * - dd-MMM-yyyy (ICICI corporate: 15-Mar-2026)
 * - dd-MMM-yy (15-Mar-26)
 * - Date objects from Excel (converted using UTC to avoid timezone shifts)
 * - Numeric Excel serial dates (ONLY when allowExcelSerial: true, range 1990-2100)
 *
 * @param input Date string, Date object, or numeric Excel serial
 * @param options Optional parsing options
 * @returns ISO 8601 date string (YYYY-MM-DD) or null if unparseable/invalid
 */
export function parseIndianDate(
  input: string | Date | number | null | undefined,
  options?: ParseDateOptions
): string | null {
  if (input === null || input === undefined) {
    return null;
  }

  const allowExcelSerial = options?.allowExcelSerial ?? false;

  // Handle Date objects (from Excel parser) - use UTC getters to avoid timezone shifts
  if (input instanceof Date) {
    if (isNaN(input.getTime())) {
      return null;
    }
    // Use UTC getters to avoid timezone-related date shifts
    const year = input.getUTCFullYear();
    const month = input.getUTCMonth() + 1;
    const day = input.getUTCDate();

    if (!isValidDate(year, month, day)) {
      return null;
    }
    return formatIsoDate(year, month, day);
  }

  // Handle numeric Excel serial dates (raw numbers in date columns)
  // Only when explicitly enabled - this is OPT-IN to preserve main's behavior
  if (typeof input === "number") {
    if (!allowExcelSerial) {
      return null; // main's behavior: numbers not parseable as dates
    }
    if (!isValidExcelSerial(input)) {
      return null;
    }
    return excelSerialToIsoDate(input);
  }

  const str = String(input).trim();
  if (!str) {
    return null;
  }

  // Try each format

  // dd/mm/yy or dd/mm/yyyy
  const slashMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashMatch) {
    const [, dayStr, monthStr, yearStr] = slashMatch;
    return parseComponents(dayStr, monthStr, yearStr);
  }

  // dd-mm-yyyy or dd-mm-yy
  const dashNumericMatch = str.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
  if (dashNumericMatch) {
    const [, dayStr, monthStr, yearStr] = dashNumericMatch;
    return parseComponents(dayStr, monthStr, yearStr);
  }

  // dd.mm.yyyy
  const dotMatch = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (dotMatch) {
    const [, dayStr, monthStr, yearStr] = dotMatch;
    return parseComponents(dayStr, monthStr, yearStr);
  }

  // dd-MMM-yyyy or dd-MMM-yy (e.g., 15-Mar-2026)
  const monthNameMatch = str.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (monthNameMatch) {
    const [, dayStr, monthName, yearStr] = monthNameMatch;
    const month = parseMonthName(monthName);
    if (month !== null) {
      return parseComponents(dayStr, String(month), yearStr);
    }
  }

  // Handle HDFC timestamp format: 13/07/2026 11:13:50
  const timestampMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+\d{1,2}:\d{2}:\d{2}$/);
  if (timestampMatch) {
    const [, dayStr, monthStr, yearStr] = timestampMatch;
    return parseComponents(dayStr, monthStr, yearStr);
  }

  // Handle string representation of Excel serial date (5-digit number, optionally fractional)
  // This handles XLSX cells with General format where raw:false returns the number as a string
  // Only when explicitly enabled - this is OPT-IN to preserve main's behavior
  if (allowExcelSerial && looksLikeExcelSerialString(str)) {
    const serial = parseFloat(str);
    return excelSerialToIsoDate(serial);
  }

  return null;
}

/**
 * Parse month name abbreviation to month number (1-12).
 */
function parseMonthName(name: string): number | null {
  const months: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  return months[name.toLowerCase()] ?? null;
}

/**
 * Parse day, month, year string components to ISO date.
 * Validates the date is real (e.g., rejects 31/02).
 */
function parseComponents(dayStr: string, monthStr: string, yearStr: string): string | null {
  const day = parseInt(dayStr, 10);
  const month = parseInt(monthStr, 10);
  let year = parseInt(yearStr, 10);

  // Handle 2-digit year: 00-49 → 2000-2049, 50-99 → 1950-1999
  if (year < 100) {
    year = year < 50 ? 2000 + year : 1900 + year;
  }

  // Validate ranges and actual date validity
  if (!isValidDate(year, month, day)) {
    return null;
  }

  return formatIsoDate(year, month, day);
}

/**
 * Validate if a date is real (handles month lengths and leap years).
 */
function isValidDate(year: number, month: number, day: number): boolean {
  // Basic range checks
  if (isNaN(year) || isNaN(month) || isNaN(day)) {
    return false;
  }
  if (year < 1900 || year > 2100) {
    return false;
  }
  if (month < 1 || month > 12) {
    return false;
  }
  if (day < 1) {
    return false;
  }

  // Days in each month (0-indexed by month-1)
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  // Adjust February for leap years
  if (isLeapYear(year)) {
    daysInMonth[1] = 29;
  }

  if (day > daysInMonth[month - 1]) {
    return false;
  }

  return true;
}

/**
 * Check if a year is a leap year.
 */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Format as ISO 8601 date string.
 */
function formatIsoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Parse Indian amount formatting to paise (integer).
 *
 * Handles:
 * - Indian digit grouping: 1,23,456.78 (lakhs/crores style)
 * - Western grouping: 123,456.78
 * - Decimal amounts: 1234.56
 * - No decimal: 1234
 * - Negative with minus: -1,234.56
 * - Dr/Cr suffixes: 1,234.56 Dr, 1,234.56 Cr
 * - Blank/empty -> 0
 * - "0.00" or "0" -> 0
 *
 * @param input Amount string
 * @returns Amount in paise (integer, always non-negative), or null if unparseable
 */
export function parseIndianAmount(
  input: string | number | null | undefined
): { paise: number; isDebit: boolean } | null {
  if (input === null || input === undefined) {
    return { paise: 0, isDebit: false };
  }

  // Handle numbers directly
  if (typeof input === "number") {
    if (isNaN(input)) {
      return null;
    }
    const paise = Math.round(Math.abs(input) * 100);
    return { paise, isDebit: input < 0 };
  }

  let str = String(input).trim();
  if (!str || str === "-" || str === "NA") {
    return { paise: 0, isDebit: false };
  }

  // Check for Dr/Cr suffix
  let isDebit = false;
  const drMatch = str.match(/\s*(Dr|DR)\.?\s*$/i);
  const crMatch = str.match(/\s*(Cr|CR)\.?\s*$/i);
  if (drMatch) {
    isDebit = true;
    str = str.slice(0, -drMatch[0].length).trim();
  } else if (crMatch) {
    isDebit = false;
    str = str.slice(0, -crMatch[0].length).trim();
  }

  // Check for leading minus
  if (str.startsWith("-")) {
    isDebit = true;
    str = str.slice(1).trim();
  }
  if (str.startsWith("(") && str.endsWith(")")) {
    isDebit = true;
    str = str.slice(1, -1).trim();
  }

  // Remove all commas (both Indian and Western grouping)
  str = str.replace(/,/g, "");

  // Remove any currency symbols
  str = str.replace(/^[₹$€£]/g, "").trim();
  str = str.replace(/^(INR|Rs\.?)\s*/gi, "").trim();

  // Parse the number
  const num = parseFloat(str);
  if (isNaN(num)) {
    return null;
  }

  // Convert to paise (integer)
  const paise = Math.round(Math.abs(num) * 100);
  return { paise, isDebit };
}

/**
 * Check if an amount string represents a zero or blank value.
 */
export function isBlankOrZero(input: string | number | null | undefined): boolean {
  if (input === null || input === undefined) {
    return true;
  }
  if (typeof input === "number") {
    return input === 0;
  }
  const str = String(input).trim();
  if (!str || str === "-" || str === "NA") {
    return true;
  }
  // Remove formatting and check if zero
  const cleaned = str.replace(/[,₹$€£\s]/g, "").replace(/^(INR|Rs\.?)/gi, "");
  const num = parseFloat(cleaned);
  return isNaN(num) || num === 0;
}

/**
 * Format paise amount to display string with Indian grouping.
 * For display purposes only.
 *
 * @param paise Amount in paise
 * @returns Formatted string like "₹1,23,456.78"
 */
export function formatPaiseToDisplay(paise: number): string {
  const rupees = paise / 100;
  const [whole, decimal] = rupees.toFixed(2).split(".");

  // Indian grouping: first 3 digits from right, then groups of 2
  const reversed = whole.split("").reverse();
  const groups: string[] = [];
  for (let i = 0; i < reversed.length; i++) {
    if (i === 3 || (i > 3 && (i - 3) % 2 === 0)) {
      groups.push(",");
    }
    groups.push(reversed[i]);
  }

  return `₹${groups.reverse().join("")}.${decimal}`;
}

/**
 * Normalize ICICI reference number.
 * Trims whitespace only; does not uppercase since refNo feeds the dedupe hash.
 * 
 * @param refNo Raw reference number from ICICI statement
 * @returns Trimmed reference or undefined if empty
 */
export function normalizeIciciRef(refNo: string | undefined): string | undefined {
  if (!refNo) return undefined;
  const trimmed = refNo.trim();
  return trimmed || undefined;
}
