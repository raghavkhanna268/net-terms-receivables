/**
 * Narration parser for Indian bank statements.
 * Extracts payment rail, UTR/RRN, payer name, and bank/IFSC.
 *
 * Part of S14/S15: Net Terms Receivables bank statement parsing.
 *
 * UTR/RRN formats:
 * - NEFT: [A-Z]{4}N\d{11,17} (bank code + N + digits, e.g., HDFCN26296123456)
 * - RTGS: [A-Z]{4}R\d{11,17} (bank code + R + digits, e.g., HDFCR26296123456)
 * - IMPS/UPI: 12 digits (RRN)
 *
 * Cheque, ACH, and NACH numbers are NOT extracted as UTR.
 */

import type { ParsedNarration, PaymentRail, BankId } from "./types.js";

/** NEFT UTR pattern: 4-letter bank code + N + 11-17 digits */
const NEFT_UTR_PATTERN = /\b([A-Z]{4}N\d{11,17})\b/;

/** RTGS UTR pattern: 4-letter bank code + R + 11-17 digits */
const RTGS_UTR_PATTERN = /\b([A-Z]{4}R\d{11,17})\b/;

/** IMPS/UPI RRN pattern: exactly 12 digits, typically between separators */
const RRN_PATTERN = /(?:^|[/-])(\d{12})(?:[/-]|$)/;

/**
 * Parse narration text to extract structured payment information.
 *
 * @param narration Raw narration text from bank statement
 * @param bank Optional bank ID for bank-specific parsing
 * @returns Parsed narration details
 */
export function parseNarration(narration: string, bank?: BankId): ParsedNarration {
  const text = narration.trim();
  const textUpper = text.toUpperCase();

  // Detect payment rail
  const rail = detectRail(textUpper);

  // Extract details based on rail
  switch (rail) {
    case "UPI":
      return parseUpi(text, textUpper, bank);
    case "NEFT":
      return parseNeft(text, textUpper, bank);
    case "RTGS":
      return parseRtgs(text, textUpper, bank);
    case "IMPS":
      return parseImps(text, textUpper, bank);
    case "ACH":
      return parseAch(text, textUpper, bank);
    case "CHEQUE":
      return parseCheque(text, textUpper, bank);
    default:
      return { rail: "OTHER" };
  }
}

/**
 * Detect payment rail from narration text.
 */
function detectRail(textUpper: string): PaymentRail {
  // Check in order of specificity
  if (textUpper.startsWith("UPI") || textUpper.includes("/UPI/") || textUpper.includes("UPI-")) {
    return "UPI";
  }
  if (textUpper.startsWith("NEFT") || textUpper.includes("/NEFT/") || textUpper.includes("NEFT-")) {
    return "NEFT";
  }
  if (textUpper.startsWith("RTGS") || textUpper.includes("/RTGS/") || textUpper.includes("RTGS-")) {
    return "RTGS";
  }
  if (textUpper.startsWith("IMPS") || textUpper.includes("/IMPS/") || textUpper.includes("IMPS-")) {
    return "IMPS";
  }
  if (
    textUpper.startsWith("ACH") ||
    textUpper.includes("ACH D-") ||
    textUpper.includes("ACH C-") ||
    textUpper.includes("NACH")
  ) {
    return "ACH";
  }
  if (
    textUpper.includes("CHQ") ||
    textUpper.includes("CHEQUE") ||
    textUpper.includes("CHQUE") ||
    textUpper.startsWith("CLG")
  ) {
    return "CHEQUE";
  }
  return "OTHER";
}

/**
 * Parse UPI narration.
 * Formats:
 * - "UPI-SWIGGY-SWIGGY@ICICI-ICIC0DC0099-123456789012-UPI"
 * - "UPI/CR/123456789012/sender@bank/SENDER NAME"
 * - "UPI/123456789012/sender@okaxis/SENDER NAME"
 */
function parseUpi(text: string, textUpper: string, _bank?: BankId): ParsedNarration {
  const result: ParsedNarration = { rail: "UPI" };

  // Extract UPI ID (VPA) - pattern: word@word, must be standalone
  const vpaMatch = text.match(/\b([a-zA-Z0-9._]+@[a-zA-Z0-9]+)\b/);
  if (vpaMatch) {
    result.upiId = vpaMatch[1].toLowerCase();
    // Extract bank from VPA
    const vpaParts = result.upiId.split("@");
    if (vpaParts.length === 2) {
      result.payerBank = vpaParts[1].toUpperCase();
    }
  }

  // Extract RRN (exactly 12 digits)
  const rrnMatch = textUpper.match(RRN_PATTERN);
  if (rrnMatch) {
    result.utr = rrnMatch[1];
  }

  // Extract payer name - typically after VPA or between separators
  // HDFC format: UPI-SWIGGY-vpa@bank-IFSC-RRN-UPI
  const hdfcMatch = text.match(/^UPI-([^-]+)-/);
  if (hdfcMatch && !hdfcMatch[1].includes("@")) {
    result.payerName = cleanPayerName(hdfcMatch[1]);
  }

  // Generic format: after RRN and VPA
  if (!result.payerName) {
    const parts = text.split(/[/-]/);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim();
      // Skip common non-name parts
      if (
        !part ||
        part.match(/^\d+$/) ||
        part.match(/@/) ||
        ["UPI", "CR", "DR", "P2A", "P2M"].includes(part.toUpperCase())
      ) {
        continue;
      }
      // Skip IFSC codes
      if (part.match(/^[A-Z]{4}0[A-Z0-9]{6}$/)) {
        result.payerBank = part;
        continue;
      }
      // This might be the name
      if (part.length > 2 && !result.payerName) {
        result.payerName = cleanPayerName(part);
      }
    }
  }

  return result;
}

/**
 * Parse NEFT narration.
 * Formats:
 * - "NEFT CR-ACME TECHNOLOGIES PVT LTD-SALARY SEP"
 * - "NEFT-HDFCN26296123456-ACME CORP-HDFC0001234"
 * - "NEFT/HDFCN26296123456/SENDER NAME/REF"
 */
function parseNeft(text: string, textUpper: string, _bank?: BankId): ParsedNarration {
  const result: ParsedNarration = { rail: "NEFT" };

  // Extract NEFT UTR: bank code + N + 11-17 digits (e.g., HDFCN26296123456)
  const utrMatch = textUpper.match(NEFT_UTR_PATTERN);
  if (utrMatch) {
    result.utr = utrMatch[1];
    // Extract bank from UTR prefix
    result.payerBank = utrMatch[1].slice(0, 4);
  }

  // Extract IFSC (4 letters + 0 + 6 alphanumeric) - more specific than bank code
  const ifscMatch = textUpper.match(/\b([A-Z]{4}0[A-Z0-9]{6})\b/);
  if (ifscMatch) {
    result.payerBank = ifscMatch[1];
  }

  // Extract payer name - collect all name-like parts
  const parts = text.split(/[/-]/);
  const nameParts: string[] = [];

  for (const part of parts) {
    const p = part.trim();
    // Skip empty, NEFT prefix, UTRs, IFSCs, pure numbers
    if (!p) continue;
    if (p.toUpperCase().match(/^NEFT|^CR$|^DR$/)) continue;
    if (p.toUpperCase().match(NEFT_UTR_PATTERN)) continue;
    if (p.match(/^[A-Z]{4}0[A-Z0-9]{6}$/)) continue;
    if (p.match(/^\d+$/)) continue;

    // This looks like a name or reference part
    if (p.length > 2) {
      nameParts.push(p);
    }
  }

  if (nameParts.length > 0) {
    result.payerName = cleanPayerName(nameParts.join(" "));
  }

  return result;
}

/**
 * Parse RTGS narration.
 * Similar to NEFT but with R prefix for UTR.
 */
function parseRtgs(text: string, textUpper: string, _bank?: BankId): ParsedNarration {
  const result: ParsedNarration = { rail: "RTGS" };

  // Extract RTGS UTR: bank code + R + 11-17 digits (e.g., HDFCR26296123456)
  const utrMatch = textUpper.match(RTGS_UTR_PATTERN);
  if (utrMatch) {
    result.utr = utrMatch[1];
    result.payerBank = utrMatch[1].slice(0, 4);
  }

  // Extract IFSC (4 letters + 0 + 6 alphanumeric)
  const ifscMatch = textUpper.match(/\b([A-Z]{4}0[A-Z0-9]{6})\b/);
  if (ifscMatch) {
    result.payerBank = ifscMatch[1];
  }

  // Extract payer name - collect all name-like parts
  const parts = text.split(/[/-]/);
  const nameParts: string[] = [];

  for (const part of parts) {
    const p = part.trim();
    if (!p) continue;
    if (p.toUpperCase().match(/^RTGS|^CR$|^DR$/)) continue;
    if (p.toUpperCase().match(RTGS_UTR_PATTERN)) continue;
    if (p.match(/^[A-Z]{4}0[A-Z0-9]{6}$/)) continue;
    if (p.match(/^\d+$/)) continue;

    if (p.length > 2) {
      nameParts.push(p);
    }
  }

  if (nameParts.length > 0) {
    result.payerName = cleanPayerName(nameParts.join(" "));
  }

  return result;
}

/**
 * Parse IMPS narration.
 * Format: "IMPS-123456789012-SENDER NAME-HDFC-REF"
 */
function parseImps(text: string, textUpper: string, _bank?: BankId): ParsedNarration {
  const result: ParsedNarration = { rail: "IMPS" };

  // IMPS RRN is exactly 12 digits
  const rrnMatch = textUpper.match(RRN_PATTERN);
  if (rrnMatch) {
    result.utr = rrnMatch[1];
  }

  // Extract IFSC
  const ifscMatch = textUpper.match(/\b([A-Z]{4}0[A-Z0-9]{6})\b/);
  if (ifscMatch) {
    result.payerBank = ifscMatch[1];
  }

  // Extract payer name
  const parts = text.split(/[/-]/);
  for (const part of parts) {
    const p = part.trim();
    if (
      !p ||
      p.toUpperCase().startsWith("IMPS") ||
      p.match(/^\d{12}$/) ||
      p.match(/^[A-Z]{4}0/) ||
      ["P2A", "P2M", "P2P"].includes(p.toUpperCase())
    ) {
      continue;
    }
    if (p.length > 3) {
      result.payerName = cleanPayerName(p);
      break;
    }
  }

  return result;
}

/**
 * Parse ACH/NACH narration.
 * Format: "ACH D- TP ACH ICICIPRULIFE-123456"
 *
 * NOTE: ACH/NACH reference numbers are NOT UTRs. They go in refNo, not parsed.utr.
 */
function parseAch(text: string, _textUpper: string, _bank?: BankId): ParsedNarration {
  const result: ParsedNarration = { rail: "ACH" };
  // Note: We do NOT extract ACH reference as UTR - it's not globally unique

  // ACH often has the company name after ACH D- or ACH C-
  const achMatch = text.match(/ACH\s*[DC]-\s*(?:TP ACH\s*)?([^-]+)/i);
  if (achMatch) {
    result.payerName = cleanPayerName(achMatch[1]);
  }

  // Reference number is kept in refNo field, NOT in parsed.utr
  // The caller should use the row's refNo column for this

  return result;
}

/**
 * Parse cheque narration.
 *
 * NOTE: Cheque numbers are NOT UTRs. They go in refNo, not parsed.utr.
 */
function parseCheque(text: string, _textUpper: string, _bank?: BankId): ParsedNarration {
  const result: ParsedNarration = { rail: "CHEQUE" };
  // Note: We do NOT extract cheque number as UTR - it's not a UTR

  // Try to extract payee/drawer name if present
  const nameMatch = text.match(/(?:CHQ|CHEQUE|CLG)[^\d]*\d*[^\d]+([A-Za-z\s]+)/i);
  if (nameMatch && nameMatch[1].trim().length > 2) {
    result.payerName = cleanPayerName(nameMatch[1]);
  }

  return result;
}

/**
 * Clean up payer name - remove common suffixes and trim.
 */
function cleanPayerName(name: string): string {
  return name
    .replace(/\s*(PVT|PRIVATE|LTD|LIMITED|LLC|INC|CORP)\.?\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract UTR from narration for deduplication purposes.
 * Returns the reference ONLY if it matches a valid UTR format for the rail.
 *
 * @param narration Narration text
 * @param rail Payment rail
 * @param refNo Reference number from statement column
 * @returns Valid UTR/RRN or null
 */
export function extractUtrForDedupe(
  narration: string,
  rail: PaymentRail,
  refNo?: string
): string | null {
  const textUpper = narration.toUpperCase();

  // Only extract UTR for valid rails
  if (!["NEFT", "RTGS", "IMPS", "UPI"].includes(rail)) {
    return null;
  }

  // Check ref number first - it often contains the UTR
  if (refNo) {
    const ref = refNo.toUpperCase().trim();

    if (rail === "NEFT" && NEFT_UTR_PATTERN.test(ref)) {
      return ref;
    }
    if (rail === "RTGS" && RTGS_UTR_PATTERN.test(ref)) {
      return ref;
    }
    if ((rail === "IMPS" || rail === "UPI") && /^\d{12}$/.test(ref)) {
      return ref;
    }
  }

  // Extract from narration based on rail
  if (rail === "NEFT") {
    const match = textUpper.match(NEFT_UTR_PATTERN);
    return match ? match[1] : null;
  }

  if (rail === "RTGS") {
    const match = textUpper.match(RTGS_UTR_PATTERN);
    return match ? match[1] : null;
  }

  if (rail === "IMPS" || rail === "UPI") {
    const match = textUpper.match(RRN_PATTERN);
    return match ? match[1] : null;
  }

  return null;
}
