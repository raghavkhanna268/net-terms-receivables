/**
 * Narration parser for Indian bank statements.
 * Extracts payment rail, UTR/RRN, payer name, and bank/IFSC.
 *
 * Part of S14/S15: Net Terms Receivables bank statement parsing.
 *
 * Narration formats vary by bank and payment rail:
 *
 * NEFT:
 * - HDFC: "NEFT CR-ACME TECHNOLOGIES PVT LTD-SALARY SEP"
 * - HDFC: "NEFT-N123456789012345-ACME CORP-HDFC0001234"
 * - ICICI: "NEFT/123456789012/SENDER NAME/REF"
 *
 * RTGS:
 * - "RTGS CR-COMPANY NAME-REF"
 * - "RTGS-R123456789012345-COMPANY-BANK"
 *
 * IMPS:
 * - "IMPS-123456789012-SENDER NAME-HDFC-REF"
 * - "IMPS/P2A/123456789012/SENDER/REF"
 *
 * UPI:
 * - HDFC: "UPI-SWIGGY-SWIGGY@ICICI-ICIC0DC0099-123456789012-UPI"
 * - HDFC: "UPI/CR/123456789012/sender@bank/SENDER NAME"
 * - ICICI: "UPI/123456789012/sender@okaxis/SENDER NAME"
 */

import type { ParsedNarration, PaymentRail, BankId } from "./types.js";

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

  // Extract UPI ID (VPA) - pattern: word@word, but must be a standalone segment
  // VPA format: alphanumeric/dot/underscore @ alphanumeric (no hyphens in VPA itself)
  const vpaMatch = text.match(/\b([a-zA-Z0-9._]+@[a-zA-Z0-9]+)\b/);
  if (vpaMatch) {
    result.upiId = vpaMatch[1].toLowerCase();
    // Extract bank from VPA
    const vpaParts = result.upiId.split("@");
    if (vpaParts.length === 2) {
      result.payerBank = vpaParts[1].toUpperCase();
    }
  }

  // Extract RRN (12 digits typically)
  const rrnMatch = textUpper.match(/(?:^|[/-])(\d{12})(?:[/-]|$)/);
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
 * - "NEFT-N123456789012345-ACME CORP-HDFC0001234"
 * - "NEFT/N123456789012345/SENDER NAME/REF"
 */
function parseNeft(text: string, textUpper: string, _bank?: BankId): ParsedNarration {
  const result: ParsedNarration = { rail: "NEFT" };

  // Extract UTR (starts with N or similar, 16-22 chars alphanumeric)
  // NEFT UTR format: BANKYYYYMMDDNNNNNN (e.g., HDFC20261015123456)
  const utrMatch = textUpper.match(/\b([A-Z]{4}\d{12,16}|N\d{15,20})\b/);
  if (utrMatch) {
    result.utr = utrMatch[1];
    // Extract bank from UTR prefix
    const bankCode = utrMatch[1].slice(0, 4);
    if (bankCode.match(/^[A-Z]{4}$/)) {
      result.payerBank = bankCode;
    }
  }

  // Extract IFSC (4 letters + 0 + 6 alphanumeric)
  const ifscMatch = textUpper.match(/\b([A-Z]{4}0[A-Z0-9]{6})\b/);
  if (ifscMatch) {
    // IFSC is more specific than bank code from UTR
    result.payerBank = ifscMatch[1];
  }

  // Extract payer name - collect all name-like parts
  // Format: NEFT CR-COMPANY NAME-REFERENCE or NEFT/UTR/COMPANY/REF
  const parts = text.split(/[/-]/);
  const nameParts: string[] = [];

  for (const part of parts) {
    const p = part.trim();
    // Skip empty, NEFT prefix, UTRs, IFSCs, pure numbers
    if (!p) continue;
    if (p.toUpperCase().match(/^NEFT|^CR$|^DR$/)) continue;
    if (p.match(/^[A-Z]{4}\d{12,16}$|^N\d{15,20}$/i)) continue;
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

  // RTGS UTR format: similar to NEFT but may start with R
  const utrMatch = textUpper.match(/\b([A-Z]{4}\d{12,16}|R\d{15,20})\b/);
  if (utrMatch) {
    result.utr = utrMatch[1];
    const bankCode = utrMatch[1].slice(0, 4);
    if (bankCode.match(/^[A-Z]{4}$/)) {
      result.payerBank = bankCode;
    }
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
    if (p.match(/^[A-Z]{4}\d{12,16}$|^R\d{15,20}$/i)) continue;
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

  // IMPS RRN is 12 digits
  const rrnMatch = textUpper.match(/(?:^|[/-])(\d{12})(?:[/-]|$)/);
  if (rrnMatch) {
    result.utr = rrnMatch[1];
  }

  // Also look for longer UTR formats
  const utrMatch = textUpper.match(/\b([A-Z]{4}\d{12,16})\b/);
  if (utrMatch && !result.utr) {
    result.utr = utrMatch[1];
    result.payerBank = utrMatch[1].slice(0, 4);
  }

  // Extract IFSC
  const ifscMatch = textUpper.match(/\b([A-Z]{4}0[A-Z0-9]{6})\b/);
  if (ifscMatch && !result.payerBank) {
    result.payerBank = ifscMatch[1];
  }

  // Extract payer name
  const parts = text.split(/[/-]/);
  for (const part of parts) {
    const p = part.trim();
    if (
      !p ||
      p.toUpperCase().startsWith("IMPS") ||
      p.match(/^\d+$/) ||
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
 */
function parseAch(text: string, _textUpper: string, _bank?: BankId): ParsedNarration {
  const result: ParsedNarration = { rail: "ACH" };

  // ACH often has the company name after ACH D- or ACH C-
  const achMatch = text.match(/ACH\s*[DC]-\s*(?:TP ACH\s*)?([^-]+)/i);
  if (achMatch) {
    result.payerName = cleanPayerName(achMatch[1]);
  }

  // Look for reference number
  const refMatch = text.match(/-(\d{6,12})$/);
  if (refMatch) {
    result.utr = refMatch[1];
  }

  return result;
}

/**
 * Parse cheque narration.
 */
function parseCheque(text: string, _textUpper: string, _bank?: BankId): ParsedNarration {
  const result: ParsedNarration = { rail: "CHEQUE" };

  // Cheque number is usually 6 digits
  const chqMatch = text.match(/(?:CHQ|CHEQUE|CLG)[^\d]*(\d{6})/i);
  if (chqMatch) {
    result.utr = chqMatch[1];
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
 * Returns the most reliable unique identifier.
 */
export function extractUtrForDedupe(narration: string, refNo?: string): string | null {
  const textUpper = narration.toUpperCase();

  // Check ref number first (often contains UTR)
  if (refNo) {
    const ref = refNo.trim();
    // 12-digit RRN (UPI/IMPS)
    if (ref.match(/^\d{12}$/)) {
      return ref;
    }
    // NEFT/RTGS style UTR
    if (ref.match(/^[A-Z]{4}\d{12,16}$/)) {
      return ref;
    }
    // UTR with prefix
    if (ref.match(/^[NR]\d{15,20}$/)) {
      return ref;
    }
  }

  // Extract from narration
  // Priority: NEFT/RTGS UTR > IMPS RRN > UPI RRN

  // NEFT/RTGS UTR: BANK + 12-16 digits
  const bankUtrMatch = textUpper.match(/\b([A-Z]{4}\d{12,16})\b/);
  if (bankUtrMatch) {
    return bankUtrMatch[1];
  }

  // N/R prefix UTR
  const prefixUtrMatch = textUpper.match(/\b([NR]\d{15,20})\b/);
  if (prefixUtrMatch) {
    return prefixUtrMatch[1];
  }

  // 12-digit RRN
  const rrnMatch = textUpper.match(/(?:^|[/-])(\d{12})(?:[/-]|$)/);
  if (rrnMatch) {
    return rrnMatch[1];
  }

  return null;
}
