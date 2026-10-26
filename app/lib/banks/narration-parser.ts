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
    case "CMS":
      return parseCms(text, textUpper, bank);
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
  // CMS (Cash Management Service) - corporate collection credits
  // ICICI format: "CMS/ <ref tokens>/<PAYER COMPANY NAME>"
  if (textUpper.startsWith("CMS/") || textUpper.startsWith("CMS ")) {
    return "CMS";
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
 * - ICICI: VPA may be without '@' (alphanumeric/dotted id of 10+ chars)
 * - HDFC: VPA may have hyphenated local part (e.g., 9000000000-1@okaxis)
 */
function parseUpi(text: string, textUpper: string, bank?: BankId): ParsedNarration {
  const result: ParsedNarration = { rail: "UPI" };

  // VPA extraction is segment-aware per bank format
  // HDFC: `-` separated, format: UPI-<name>-<vpa parts>-<ifsc>-<rrn>-<note>
  // ICICI: `/` separated, format: UPI/CR/<rrn>/<vpa>/<name>/<bank>/...

  const isHdfcDashFormat = textUpper.startsWith("UPI-");
  const isIciciSlashFormat = textUpper.startsWith("UPI/");
  const hasSlash = text.includes("/");

  if (isHdfcDashFormat && !isIciciSlashFormat) {
    // HDFC dash format: UPI-NAME-vpa@handle-IFSC-RRN-note
    // OR for phone VPAs: UPI-9000000000-1@handle-NAME-IFSC-RRN-note
    const dashParts = text.split("-");
    if (dashParts.length >= 3) {
      // Find the segment containing @ (VPA end)
      let atSegmentIdx = -1;
      for (let i = 1; i < dashParts.length; i++) {
        if (dashParts[i].includes("@")) {
          atSegmentIdx = i;
          break;
        }
      }
      if (atSegmentIdx >= 1) {
        // Determine VPA start: work backwards from @ segment
        // to find where VPA starts (after the name, which contains uppercase letters)
        // Do NOT extend across all-digit segments (they may be reference numbers)
        // Exception: phone format (10 digits + 1-3 digit suffix)
        let vpaStartIdx = atSegmentIdx;
        const atSegmentPart = dashParts[atSegmentIdx].split("@")[0];
        for (let i = atSegmentIdx - 1; i >= 1; i--) {
          const seg = dashParts[i];
          // If segment has ANY uppercase letter, it's likely a name (UPPERCASE or Title-case)
          // VPA parts are typically all lowercase or all digits
          if (/[A-Z]/.test(seg)) {
            break;
          }
          // All-digit segments are NOT part of VPA unless it's phone format
          // Phone format: preceding segment is 10 digits AND at-segment part is 1-3 digits
          if (/^\d+$/.test(seg)) {
            // Only extend for phone format
            if (/^\d{10}$/.test(seg) && /^\d{1,3}$/.test(atSegmentPart)) {
              vpaStartIdx = i;
            }
            break;
          }
          // If segment is all lowercase alphanumeric (not all digits), could be VPA part
          if (/^[a-z0-9._]+$/.test(seg)) {
            vpaStartIdx = i;
          } else {
            break;
          }
        }
        // Join segments from vpaStartIdx to atSegmentIdx (inclusive) to form VPA
        const vpaParts = dashParts.slice(vpaStartIdx, atSegmentIdx + 1);
        const vpaCandidate = vpaParts.join("-");
        // Validate it looks like a VPA
        if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9]+$/.test(vpaCandidate)) {
          result.upiId = vpaCandidate.toLowerCase();
        }
      }
    }
  }

  // Slash-separated format (ICICI and generic): find segment containing @
  if (!result.upiId && hasSlash) {
    const slashParts = text.split("/");
    for (const part of slashParts) {
      const trimmed = part.trim();
      if (trimmed.includes("@")) {
        // Check if it's a valid VPA (may have hyphens in local part)
        const vpaMatch = trimmed.match(/^([a-zA-Z0-9._-]+@[a-zA-Z0-9]+)$/);
        if (vpaMatch) {
          result.upiId = vpaMatch[1].toLowerCase();
          break;
        }
      }
    }
  }

  // Fallback: regex-based VPA extraction for non-standard formats
  // Handles cases like "PAYMENT UPI-SYNT-9000000000-1@oksynt-DONE" where the
  // narration contains UPI but doesn't start with UPI- or UPI/
  //
  // Extension rules for hyphenated VPAs:
  // - Always take the segment directly before @ (the "at-segment")
  // - Extend backwards across '-' only when safe:
  //   1. Phone format: at-segment is 1-3 digits AND preceding is exactly 10 digits (9000000000-1@)
  //   2. Mixed-case text AND earlier segment is lowercase alphanumeric/dots/underscores: extend
  // - Do NOT extend across arbitrary digit sequences (they may be reference numbers)
  // Ambiguity: in all-caps text, "SYNT-VENDOR@OKSYNT" extracts as "vendor@oksynt" because
  // we can't distinguish a hyphenated VPA from a name-VPA boundary.
  if (!result.upiId) {
    const atIdx = text.indexOf("@");
    if (atIdx > 0) {
      const afterAt = text.slice(atIdx + 1);
      // Handle must end at '-', '/', whitespace, or end of string
      const handleMatch = afterAt.match(/^([a-zA-Z0-9]+)(?:[-/\s]|$)/);
      if (handleMatch) {
        const handle = handleMatch[1].toLowerCase();
        const beforeAt = text.slice(0, atIdx);

        // Find hard boundary: last slash or whitespace before @
        const boundaryMatch = beforeAt.match(/.*[\s/]/);
        const boundaryIdx = boundaryMatch ? boundaryMatch[0].length : 0;
        const localPartRaw = beforeAt.slice(boundaryIdx);

        // Split by '-' and process segments
        const segments = localPartRaw.split("-");
        const atSegment = segments[segments.length - 1];

        // Validate at-segment: must be alphanumeric with dots/underscores
        if (atSegment && /^[a-zA-Z0-9._]+$/.test(atSegment)) {
          const localParts: string[] = [atSegment];

          // Check if narration is all-uppercase (affects extension rules)
          const isAllCaps = text === text.toUpperCase();

          // Phone format extension: at-segment is 1-3 digits, preceding is exactly 10 digits
          // This is the only case where we extend across digit segments
          if (segments.length >= 2) {
            const prevSeg = segments[segments.length - 2];
            if (
              /^\d{1,3}$/.test(atSegment) &&
              prevSeg &&
              /^\d{10}$/.test(prevSeg)
            ) {
              localParts.unshift(prevSeg);
            }
          }

          // For mixed-case text, extend backwards across lowercase segments
          // (only if we haven't already extended for phone format)
          // Do NOT extend across all-digit segments (they may be reference numbers)
          if (!isAllCaps && localParts.length === 1) {
            for (let i = segments.length - 2; i >= 0; i--) {
              const seg = segments[i];
              if (!seg) break;
              // Must be lowercase alphanumeric/dots/underscores, but NOT all digits
              if (/^[a-z0-9._]+$/.test(seg) && !/^\d+$/.test(seg)) {
                localParts.unshift(seg);
              } else {
                break;
              }
            }
          }

          const localPart = localParts.join("-").toLowerCase();
          result.upiId = `${localPart}@${handle}`;
        }
      }
    }
  }

  // Split by separators for further analysis
  const parts = text.split(/[/-]/);

  // ICICI: VPA may be without '@' - check segment index 2 only
  // Format: UPI/CR/vpa-id/SENDER NAME/BANK NAME (index 2 = VPA ID, index 4 = bank)
  if (!result.upiId && bank === "ICICI" && parts.length > 2) {
    const candidate = parts[2].trim();
    // Must be 10+ chars, alphanumeric with optional dots, not a pure number,
    // and not a code-shaped ref (3-6 letters + digits like SYNT000001)
    if (
      candidate.length >= 10 &&
      /^[a-zA-Z0-9.]+$/.test(candidate) &&
      !/^\d+$/.test(candidate) &&
      !/^[A-Z]{3,6}\d+$/i.test(candidate) &&
      !candidate.includes("@")
    ) {
      result.upiId = candidate.toLowerCase();
    }
  }

  // Extract RRN (exactly 12 digits)
  const rrnMatch = textUpper.match(RRN_PATTERN);
  if (rrnMatch) {
    result.utr = rrnMatch[1];
  }

  // Extract payer bank from IFSC segment first (takes precedence over VPA handle)
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.match(/^[A-Z]{4}0[A-Z0-9]{6}$/)) {
      result.payerBank = trimmed;
      break;
    }
  }
  
  // If no IFSC found, get bank from VPA handle
  if (!result.payerBank && result.upiId) {
    const vpaParts = result.upiId.split("@");
    if (vpaParts.length === 2) {
      result.payerBank = vpaParts[1].toUpperCase();
    }
  }

  // For ICICI, try to extract payer bank from narration (bank name segment)
  // Only if we don't already have a bank from IFSC
  // Prefer segment index 4 (typical ICICI format: UPI/CR/RRN/VPA/BANK NAME)
  if (bank === "ICICI" && !result.payerBank) {
    // Check index 4 first
    if (parts.length > 4) {
      const candidate = parts[4].trim().toUpperCase();
      if (candidate.includes("BANK") && candidate !== "UPI") {
        result.payerBank = candidate;
      }
    }
    // Fallback to any segment with "BANK"
    if (!result.payerBank) {
      for (const part of parts) {
        const trimmed = part.trim().toUpperCase();
        if (trimmed.includes("BANK") && trimmed !== "UPI") {
          result.payerBank = trimmed;
          break;
        }
      }
    }
  }

  // Extract payer name - typically after VPA or between separators
  // HDFC format: UPI-SWIGGY-vpa@bank-IFSC-RRN-UPI
  const hdfcMatch = text.match(/^UPI-([^-]+)-/);
  if (hdfcMatch && !hdfcMatch[1].includes("@")) {
    result.payerName = cleanPayerName(hdfcMatch[1]);
  }

  // Generic format: after RRN and VPA
  if (!result.payerName) {
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
        continue;
      }
      // Skip VPA-like strings without @
      if (result.upiId && part.toLowerCase() === result.upiId) {
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
 * Parse CMS (Cash Management Service) narration.
 * ICICI format: "CMS/ <ref tokens with digits>/<PAYER COMPANY NAME words>"
 * e.g., "CMS/ SYNT123 45/<SYNT TEST TRADERS>"
 *
 * CMS credits are corporate collection payments (receivables).
 * NOTE: CMS reference numbers are NOT UTRs - they are internal refs.
 * We do NOT store them in result.utr; leave utr empty.
 */
function parseCms(text: string, _textUpper: string, _bank?: BankId): ParsedNarration {
  const result: ParsedNarration = { rail: "CMS" };

  // Split by '/' to extract segments
  const parts = text.split("/");
  if (parts.length < 2) {
    return result;
  }

  // First segment is "CMS" or "CMS " - skip it
  // Second segment (and possibly more) may contain reference tokens
  // Last non-empty segment is typically the payer name
  const nonEmptyParts = parts.slice(1).filter((p) => p.trim().length > 0);

  if (nonEmptyParts.length === 0) {
    return result;
  }

  // NOTE: CMS refs are internal, NOT UTRs. Do not store in result.utr.
  const refPart = nonEmptyParts[0].trim();

  // The payer name is typically the last segment
  if (nonEmptyParts.length > 1) {
    const payerPart = nonEmptyParts[nonEmptyParts.length - 1].trim();
    if (payerPart && payerPart.length > 2 && !/^\d+$/.test(payerPart)) {
      result.payerName = cleanPayerName(payerPart);
    }
  } else if (nonEmptyParts.length === 1 && !/^\d+$/.test(refPart)) {
    // Single segment after CMS/ could be the payer name if it's not purely numeric
    const words = refPart.split(/\s+/);
    const alphaWords = words.filter((w) => /[A-Za-z]{2,}/.test(w));
    if (alphaWords.length > 0) {
      result.payerName = cleanPayerName(alphaWords.join(" "));
    }
  }

  return result;
}

/**
 * Parse cheque narration.
 *
 * NOTE: Cheque numbers are NOT UTRs. They go in refNo, not parsed.utr.
 *
 * Common formats:
 * - "CHQ 000123 ACME CORP" -> payerName: "ACME CORP"
 * - "CLG-000123-VENDOR NAME" -> payerName: "VENDOR NAME"
 * - "CHEQUE DEP-CUSTOMER PVT LTD" -> payerName: "CUSTOMER"
 */
function parseCheque(text: string, _textUpper: string, _bank?: BankId): ParsedNarration {
  const result: ParsedNarration = { rail: "CHEQUE" };

  // Split by common separators and look for name-like parts
  const parts = text.split(/[-/\s]+/);
  const candidateNames: string[] = [];

  for (const part of parts) {
    const p = part.trim();
    // Skip empty, keywords, and numeric parts
    if (!p) continue;
    if (/^(CHQ|CHEQUE|CLG|DEP|DEPOSIT|RETN|RETURN|PAID|TRF|REF|CR|DR)$/i.test(p)) continue;
    if (/^\d+$/.test(p)) continue;
    // Skip parts that are mostly digits (like cheque numbers with letters)
    if (/^\d+[A-Za-z]?$/.test(p) || /^[A-Za-z]?\d+$/.test(p)) continue;

    // Accept parts with at least 3 letters
    if (/[A-Za-z]{3,}/.test(p)) {
      candidateNames.push(p);
    }
  }

  if (candidateNames.length > 0) {
    result.payerName = cleanPayerName(candidateNames.join(" "));
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
