/**
 * Bank Statement Import Route (S14/S15).
 *
 * Parses HDFC and ICICI bank statement exports entirely in the browser:
 * - CSV and XLS/XLSX formats supported
 * - SheetJS is lazy-loaded (dynamic import) only when parsing
 * - Raw file never leaves the browser
 * - Only parsed credit rows are sent to the import endpoint
 *
 * Privacy: The raw bank statement file NEVER leaves the browser.
 * Only normalised credit rows (date, amount, rail, UTR, remitter name, narration)
 * are submitted to the server. Remitter names and narrations are stored but
 * NEVER logged or sent to error tracking services.
 *
 * NOTE: Uses ~/lib/banks/parse.client.ts to keep SheetJS (~1MB) out of
 * the Cloudflare Worker bundle. The .client.ts extension ensures the module
 * is never included in SSR builds.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import type { HeadersFunction, LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getRequestSql } from "~/lib/request-context.server";
import { runMatcher, MAX_PAYMENTS_PER_REQUEST } from "~/services/matcher.server";
import { generateDedupeKey, isValidUtrForRail } from "~/lib/banks/dedupe";
import type { PaymentRail } from "~/lib/banks/types";
import { checkImportLimit, enforceImportLimit, UpgradeRequiredError } from "~/services/gating.server";
import { safeLog, toErrorCode } from "~/lib/log.server";
import { recordAccess, getActorFromSessionToken } from "~/services/access-log.server";

/**
 * Maximum rows per import request.
 * Keeps request size reasonable and processing within Workers CPU budget.
 * Exported for tests and client-side validation to reference the same constant.
 */
export const MAX_IMPORT_ROWS = 1000;

/**
 * Maximum validation errors to return (avoid huge response).
 */
const MAX_VALIDATION_ERRORS = 10;

/**
 * Compute the valid date range for imports.
 * Exported for testing to ensure tests use the same logic.
 * 
 * @param now - The reference date (defaults to current time)
 * @returns Object with minDate, maxDate as ISO strings (YYYY-MM-DD)
 */
export function computeDateBounds(now: Date = new Date()): { minDateIso: string; maxDateIso: string } {
  const minDate = new Date(now);
  minDate.setFullYear(minDate.getFullYear() - 2);
  const maxDate = new Date(now);
  maxDate.setDate(maxDate.getDate() + 7);
  return {
    minDateIso: minDate.toISOString().slice(0, 10),
    maxDateIso: maxDate.toISOString().slice(0, 10),
  };
}

/**
 * Valid payment rails for Indian bank transfers.
 */
const VALID_RAILS = new Set(["NEFT", "RTGS", "IMPS", "UPI", "ACH", "CHEQUE", "OTHER"]);
type ValidRail = "NEFT" | "RTGS" | "IMPS" | "UPI" | "ACH" | "CHEQUE" | "OTHER";

/**
 * Valid bank types.
 */
const VALID_BANKS = new Set(["HDFC", "ICICI", "SBI", "AXIS", "UNKNOWN"]);
type ValidBank = "HDFC" | "ICICI" | "SBI" | "AXIS" | "UNKNOWN";

/**
 * Credit row type for import.
 */
interface CreditRow {
  date: string;
  valueDate?: string;
  amountPaise: number;
  balancePaise?: number;
  rail: ValidRail;
  utr?: string;
  payerName?: string;
  narration: string;
  refNo?: string;
}

/**
 * Import request type.
 */
interface ImportRequest {
  bank: ValidBank;
  fileName: string;
  credits: CreditRow[];
}

/**
 * Validation error type.
 */
interface ValidationError {
  path: string;
  message: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate a single credit row.
 * Returns array of validation errors (empty if valid).
 */
function validateCreditRow(row: unknown, index: number): ValidationError[] {
  const errors: ValidationError[] = [];
  const prefix = `credits.${index}`;

  if (typeof row !== "object" || row === null) {
    errors.push({ path: prefix, message: "Must be an object" });
    return errors;
  }

  const r = row as Record<string, unknown>;

  // Required: date (YYYY-MM-DD format)
  if (typeof r.date !== "string" || !DATE_PATTERN.test(r.date)) {
    errors.push({ path: `${prefix}.date`, message: "Date must be YYYY-MM-DD" });
  }

  // Optional: valueDate (YYYY-MM-DD format)
  if (r.valueDate !== undefined && (typeof r.valueDate !== "string" || !DATE_PATTERN.test(r.valueDate))) {
    errors.push({ path: `${prefix}.valueDate`, message: "Value date must be YYYY-MM-DD" });
  }

  // Required: amountPaise (positive integer)
  if (typeof r.amountPaise !== "number" || !Number.isInteger(r.amountPaise) || r.amountPaise <= 0) {
    errors.push({ path: `${prefix}.amountPaise`, message: "Amount must be a positive integer" });
  }

  // Optional: balancePaise (integer)
  if (r.balancePaise !== undefined && (typeof r.balancePaise !== "number" || !Number.isInteger(r.balancePaise))) {
    errors.push({ path: `${prefix}.balancePaise`, message: "Balance must be an integer" });
  }

  // Required: rail (valid rail type)
  if (typeof r.rail !== "string" || !VALID_RAILS.has(r.rail)) {
    errors.push({ path: `${prefix}.rail`, message: `Rail must be one of: ${[...VALID_RAILS].join(", ")}` });
  }

  // Optional: utr (string)
  if (r.utr !== undefined && typeof r.utr !== "string") {
    errors.push({ path: `${prefix}.utr`, message: "UTR must be a string" });
  }

  // Optional: payerName (string, max 500)
  if (r.payerName !== undefined && (typeof r.payerName !== "string" || r.payerName.length > 500)) {
    errors.push({ path: `${prefix}.payerName`, message: "Payer name must be a string (max 500 chars)" });
  }

  // Required: narration (string, 1-2000)
  if (typeof r.narration !== "string" || r.narration.length < 1 || r.narration.length > 2000) {
    errors.push({ path: `${prefix}.narration`, message: "Narration must be 1-2000 characters" });
  }

  // Optional: refNo (string, max 100)
  if (r.refNo !== undefined && (typeof r.refNo !== "string" || r.refNo.length > 100)) {
    errors.push({ path: `${prefix}.refNo`, message: "Ref number must be a string (max 100 chars)" });
  }

  return errors;
}

/**
 * Validate import request body.
 * Returns tuple of [validRequest, errors].
 * Validates ALL rows but caps returned errors to MAX_VALIDATION_ERRORS.
 * Exported for testing.
 */
export function validateImportRequest(body: unknown): { valid: ImportRequest | null; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (typeof body !== "object" || body === null) {
    errors.push({ path: "", message: "Request body must be an object" });
    return { valid: null, errors };
  }

  const b = body as Record<string, unknown>;

  // Required: bank
  if (typeof b.bank !== "string" || !VALID_BANKS.has(b.bank)) {
    errors.push({ path: "bank", message: `Bank must be one of: ${[...VALID_BANKS].join(", ")}` });
  }

  // Required: fileName (1-255)
  if (typeof b.fileName !== "string" || b.fileName.length < 1 || b.fileName.length > 255) {
    errors.push({ path: "fileName", message: "File name must be 1-255 characters" });
  }

  // Required: credits (array, 1-MAX_IMPORT_ROWS)
  if (!Array.isArray(b.credits)) {
    errors.push({ path: "credits", message: "Credits must be an array" });
    return { valid: null, errors };
  }

  if (b.credits.length === 0) {
    errors.push({ path: "credits", message: "At least one credit row is required" });
  }

  if (b.credits.length > MAX_IMPORT_ROWS) {
    errors.push({ 
      path: "credits", 
      message: `This import contains ${b.credits.length.toLocaleString()} rows, which exceeds the per-import limit of ${MAX_IMPORT_ROWS.toLocaleString()} rows. Please split your statement into smaller files.`
    });
  }

  // Validate ALL credit rows, but cap errors returned
  let totalRowErrors = 0;
  for (let i = 0; i < b.credits.length; i++) {
    const rowErrors = validateCreditRow(b.credits[i], i);
    if (rowErrors.length > 0) {
      totalRowErrors++;
      if (errors.length < MAX_VALIDATION_ERRORS) {
        errors.push(...rowErrors.slice(0, MAX_VALIDATION_ERRORS - errors.length));
      }
    }
  }

  // Add summary if errors were capped
  if (totalRowErrors > MAX_VALIDATION_ERRORS) {
    errors.push({ path: "credits", message: `...and ${totalRowErrors - MAX_VALIDATION_ERRORS} more rows with errors` });
  }

  if (errors.length > 0) {
    return { valid: null, errors };
  }

  return {
    valid: {
      bank: b.bank as ValidBank,
      fileName: b.fileName as string,
      credits: b.credits as CreditRow[],
    },
    errors: [],
  };
}

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { shopify } = context;
  const { session, sessionToken } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;

  const [shop] = await sql<{ id: string; currency: string }[]>`
    SELECT id, currency FROM "Shop" WHERE domain = ${shopDomain}
  `;

  if (!shop) {
    return {
      shopDomain,
      shopCurrency: "INR",
      maxImportRows: MAX_IMPORT_ROWS,
      importsThisMonth: { current: 0, limit: -1, allowed: true },
    };
  }

  // Get import usage for the current month (IST calendar month)
  const importCheck = await checkImportLimit(sql, shop.id);

  recordAccess(sql, {
    shopId: shop.id,
    actor: getActorFromSessionToken(sessionToken, session),
    action: "imports",
    recordType: "BankImport",
    count: 0,
  });

  return {
    shopDomain,
    shopCurrency: shop.currency ?? "INR",
    maxImportRows: MAX_IMPORT_ROWS,
    importsThisMonth: {
      current: importCheck.currentUsage,
      limit: importCheck.limit,
      allowed: importCheck.allowed,
    },
  };
};

/**
 * Action handler for importing normalised credit rows.
 * 
 * Security:
 * - Authenticated via admin session (shop-scoped)
 * - Validates all input with strict type checks
 * - Dedupes on (shop, UTR) or fallback hash
 * - NEVER logs remitter names or narrations (PII)
 */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shopify } = context;
  const { session } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;

  // Compute date range per request (not at module load)
  const now = new Date();
  const { minDateIso, maxDateIso } = computeDateBounds(now);

  // Get shop ID and currency
  const [shop] = await sql<{ id: string; currency: string }[]>`
    SELECT id, currency FROM "Shop" WHERE domain = ${shopDomain}
  `;

  if (!shop) {
    return Response.json(
      { success: false, error: "Shop not found" },
      { status: 404 }
    );
  }

  // INR only for now (Indian bank statements)
  if (shop.currency !== "INR") {
    return Response.json(
      { success: false, error: "Only INR currency is supported for bank imports" },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  // Validate request body
  const { valid: importData, errors: validationErrors } = validateImportRequest(body);
  if (!importData) {
    const issues = validationErrors.map((e) => `${e.path || "body"}: ${e.message}`);
    return Response.json(
      { success: false, error: "Validation failed", details: issues },
      { status: 400 }
    );
  }

  // Validate date range for all credits (both date and valueDate)
  const invalidDates = importData.credits.filter(
    (c) => c.date < minDateIso || c.date > maxDateIso ||
           (c.valueDate && (c.valueDate < minDateIso || c.valueDate > maxDateIso))
  );
  if (invalidDates.length > 0) {
    return Response.json(
      { 
        success: false, 
        error: `${invalidDates.length} row(s) have dates outside valid range (${minDateIso} to ${maxDateIso})` 
      },
      { status: 400 }
    );
  }

  const shopId = shop.id;

  // Enforce monthly import allowance before creating any records
  try {
    await enforceImportLimit(sql, shopId);
  } catch (err) {
    if (err instanceof UpgradeRequiredError) {
      return Response.json(
        {
          success: false,
          error: `Monthly import limit reached. You have used ${err.currentUsage} of ${err.limit} imports this month. Upgrade your plan for unlimited imports.`,
          limitReached: true,
        },
        { status: 403 }
      );
    }
    throw err;
  }

  try {
    // Compute dedupe keys server-side for all credits
    // Use isValidUtrForRail to validate UTRs - fall back to hash for invalid/untrusted rails
    const creditsWithKeys: Array<CreditRow & { dedupeKey: string }> = [];
    for (const credit of importData.credits) {
      let dedupeKey: string;
      
      // Only trust UTR if it's valid for the rail
      const hasValidUtr = credit.utr && isValidUtrForRail(credit.utr, credit.rail as PaymentRail);
      
      if (hasValidUtr) {
        // Use UTR-based key
        dedupeKey = await generateDedupeKey(
          credit.date,
          credit.amountPaise,
          "CR",
          credit.narration,
          credit.rail as PaymentRail,
          credit.utr,
          credit.balancePaise,
          credit.valueDate,
          credit.refNo
        );
      } else {
        // Generate hash-based key (includes balancePaise for identical same-day distinction)
        dedupeKey = await generateDedupeKey(
          credit.date,
          credit.amountPaise,
          "CR",
          credit.narration,
          credit.rail as PaymentRail,
          undefined, // Don't pass untrusted UTR
          credit.balancePaise,
          credit.valueDate,
          credit.refNo
        );
      }
      
      creditsWithKeys.push({ ...credit, dedupeKey });
    }

    // Normalize dedupe keys for DB storage
    // UTR-based keys stay as-is, hash-based get SYNTH- prefix
    const normalizeForDb = (key: string): string => {
      if (key.startsWith("utr:")) {
        // Extract the actual UTR value from utr:RAIL:DIR:VALUE format
        const parts = key.split(":");
        return parts[3] || key;
      }
      return `SYNTH-${key}`;
    };

    // Use batched INSERT ... ON CONFLICT DO NOTHING in a transaction
    const result = await sql.begin(async (tx) => {
      // Create BankImport record
      const [bankImport] = await tx<{ id: string }[]>`
        INSERT INTO "BankImport" (
          "shopId", bank, "fileName", "rowCount", "createdAt"
        )
        VALUES (
          ${shopId},
          ${importData.bank.toLowerCase()},
          ${importData.fileName},
          ${importData.credits.length},
          ${now}
        )
        RETURNING id
      `;

      const importId = bankImport.id;

      // Log import start (counts only, no PII)
      safeLog("info", "import.start", {
        shopId,
        importId,
        count: importData.credits.length,
      });

      // Prepare all rows for batch insert
      const rows = creditsWithKeys.map((credit) => {
        const dbUtr = normalizeForDb(credit.dedupeKey);
        // Convert to ISO string for JSON serialization (tx.json() needs string, not Date)
        const valueDate = credit.valueDate 
          ? new Date(credit.valueDate + "T00:00:00Z").toISOString()
          : new Date(credit.date + "T00:00:00Z").toISOString();
        // Use exact decimal string to avoid float precision issues
        const amountString = (credit.amountPaise / 100).toFixed(2);
        
        return {
          shopId,
          importId,
          valueDate,
          amount: amountString,
          rail: credit.rail,
          utr: dbUtr,
          payerText: credit.payerName ?? null,
          narration: credit.narration,
        };
      });

      // Batch insert with ON CONFLICT DO NOTHING
      // Returns only the inserted rows (not duplicates)
      // Use tx.json() for proper JSON serialization - JSON.stringify() causes
      // postgres.js to double-encode, sending a JSON string scalar instead of array
      const insertedRows = await tx<{ id: string }[]>`
        INSERT INTO "Payment" (
          "shopId",
          "importId",
          "valueDate",
          amount,
          rail,
          utr,
          "payerText",
          narration,
          status,
          "createdAt",
          "updatedAt"
        )
        SELECT
          r."shopId",
          r."importId",
          r."valueDate"::timestamptz,
          r.amount::decimal(14,2),
          r.rail,
          r.utr,
          r."payerText",
          r.narration,
          'unmatched',
          ${now},
          ${now}
        FROM jsonb_to_recordset(${tx.json(rows)}) AS r(
          "shopId" text,
          "importId" text,
          "valueDate" text,
          amount text,
          rail text,
          utr text,
          "payerText" text,
          narration text
        )
        ON CONFLICT ("shopId", utr) DO NOTHING
        RETURNING id
      `;

      const inserted = insertedRows.length;
      const duplicates = rows.length - inserted;

      // Log import completion (counts only, no PII)
      safeLog("info", "import.complete", {
        importId,
        insertedCount: inserted,
        duplicateCount: duplicates,
      });

      return { importId, inserted, duplicates };
    });

    // Trigger matcher for newly imported payments
    let matcherResult = null;
    if (result.inserted > 0) {
      try {
        matcherResult = await runMatcher(sql, shopId, { limit: MAX_PAYMENTS_PER_REQUEST });
        safeLog("info", "import.matcher_run", {
          shopId,
          processedCount: matcherResult.paymentsProcessed,
          matchCount: matcherResult.matchesCreated,
        });
      } catch (err) {
        // Log error code only (M6)
        safeLog("error", "import.matcher_failed", {
          shopId,
          err: toErrorCode(err),
        });
      }
    }

    return Response.json({
      success: true,
      importId: result.importId,
      counts: {
        inserted: result.inserted,
        duplicates: result.duplicates,
        rejected: 0,
        total: importData.credits.length,
      },
      matcher: matcherResult ? {
        paymentsProcessed: matcherResult.paymentsProcessed,
        matchesCreated: matcherResult.matchesCreated,
        highConfidenceMatches: matcherResult.highConfidenceMatches,
        hasMore: matcherResult.hasMore,
      } : null,
    });
  } catch (err) {
    // Log error code only (M6)
    safeLog("error", "import.failed", {
      shopId,
      err: toErrorCode(err),
    });
    return Response.json(
      { success: false, error: "Import failed" },
      { status: 500 }
    );
  }
};

type ParseStatus = "idle" | "loading" | "parsed" | "error";

interface ParsedTransaction {
  date: string;
  amountPaise: number;
  direction: "CR" | "DR";
  narration: string;
  refNo?: string;
  balancePaise?: number;
  rail: string;
  utr?: string;
  payerName?: string;
  dedupeKey: string;
  sourceRow: number;
}

interface ParseResultSummary {
  bank: string;
  confidence: number;
  totalRows: number;
  skippedRows: number;
  creditCount: number;
  debitCount: number;
  credits: ParsedTransaction[];
  errors: { row: number; code: string; message: string }[];
}

interface ImportResult {
  success: boolean;
  importId?: string;
  error?: string;
  details?: string[];
  limitReached?: boolean;
  counts?: {
    inserted: number;
    duplicates: number;
    rejected: number;
    total: number;
  };
  matcher?: {
    paymentsProcessed: number;
    matchesCreated: number;
    highConfidenceMatches: number;
    hasMore: boolean;
  } | null;
}

function formatPaiseDisplay(paise: number, currency: string): string {
  const rupees = paise / 100;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: currency,
    minimumFractionDigits: 2,
  }).format(rupees);
}

/**
 * Parse error with row number, code, and message.
 */
export interface ParseErrorRow {
  row: number;
  code: string;
  message: string;
}

/**
 * Badge tone for error codes.
 */
export type ErrorBadgeTone = "warning" | "critical";

/**
 * Get badge tone for error code.
 * NORMALIZE_FAILED gets warning (recoverable), others get critical.
 * Exported for testing.
 */
export function getErrorBadgeTone(code: string): ErrorBadgeTone {
  return code === "NORMALIZE_FAILED" ? "warning" : "critical";
}

/**
 * Fixed error messages for each error code.
 * Raw parser messages are NOT shown to merchants.
 * Exported for testing.
 */
export const ERROR_CODE_MESSAGES: Record<string, string> = {
  ROW_PARSE_FAILED: "Could not parse this row",
  NORMALIZE_FAILED: "Could not normalize transaction data",
  NO_HEADER_ROW: "Could not find header row in file",
  COLUMN_MAP_FAILED: "Could not map columns to expected format",
  UNKNOWN_BANK_FORMAT: "Unrecognized bank statement format",
};

/**
 * Get fixed display message for an error code.
 * Never returns raw parser error messages.
 * Exported for testing.
 */
export function getErrorDisplayMessage(code: string): string {
  return ERROR_CODE_MESSAGES[code] ?? "Unknown error";
}

/**
 * Format row label for display.
 * Row 0 indicates a file-level error, not a specific row.
 * Exported for testing.
 */
export function formatErrorRowLabel(row: number): string {
  return row === 0 ? "File-level" : `Row ${row}`;
}

/**
 * Summarized parse errors for UI display.
 */
export interface SummarizedErrors {
  /** Errors to show initially (up to initialLimit) */
  initialErrors: ParseErrorRow[];
  /** Remaining errors to show when expanded */
  overflowErrors: ParseErrorRow[];
  /** Total error count */
  totalCount: number;
  /** Count of errors not shown initially */
  overflowCount: number;
  /** Whether there are overflow errors */
  hasOverflow: boolean;
}

/**
 * Summarize parse errors for UI display.
 * Shows first `initialLimit` errors initially, rest available for expansion.
 * Exported for testing.
 *
 * @param errors - Array of parse errors
 * @param initialLimit - Number of errors to show initially (default 10)
 * @returns Summarized errors with initial/overflow split
 */
export function summarizeParseErrors(
  errors: ParseErrorRow[],
  initialLimit: number = 10
): SummarizedErrors {
  const initialErrors = errors.slice(0, initialLimit);
  const overflowErrors = errors.slice(initialLimit);
  return {
    initialErrors,
    overflowErrors,
    totalCount: errors.length,
    overflowCount: overflowErrors.length,
    hasOverflow: overflowErrors.length > 0,
  };
}

/**
 * Credit row from parser for mapping to import payload.
 */
interface ParsedCreditRow {
  date: string;
  amountPaise: number;
  balancePaise?: number;
  rail: string;
  utr?: string;
  payerName?: string;
  narration: string;
  refNo?: string;
}

/**
 * Map parsed credit rows to import payload format.
 * Only includes fields needed for server-side processing.
 * Raw file content (direction, dedupeKey, sourceRow) is NOT included.
 * Exported for testing to ensure tests use the exact same mapping as the UI.
 *
 * @param credits - Parsed credit transactions
 * @returns Array of credit objects for import payload
 */
export function mapCreditsForImport(
  credits: ParsedCreditRow[]
): Array<Record<string, string | number>> {
  return credits.map((c) => {
    const credit: Record<string, string | number> = {
      date: c.date,
      amountPaise: c.amountPaise,
      rail: c.rail,
      narration: c.narration,
    };
    if (c.balancePaise !== undefined) credit.balancePaise = c.balancePaise;
    if (c.utr) credit.utr = c.utr;
    if (c.payerName) credit.payerName = c.payerName;
    if (c.refNo) credit.refNo = c.refNo;
    return credit;
  });
}

function RailBadge({ rail }: { rail: string }) {
  if (rail === "NEFT") return <s-badge tone="info">{rail}</s-badge>;
  if (rail === "RTGS") return <s-badge tone="success">{rail}</s-badge>;
  if (rail === "IMPS") return <s-badge tone="warning">{rail}</s-badge>;
  if (rail === "UPI") return <s-badge tone="info">{rail}</s-badge>;
  return <s-badge>{rail}</s-badge>;
}

export default function ImportsPage() {
  const { shopCurrency, maxImportRows, importsThisMonth } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ImportResult>();

  const [status, setStatus] = useState<ParseStatus>("idle");
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<ParseResultSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [overLimitError, setOverLimitError] = useState<{ rowCount: number; limit: number } | null>(null);
  // Track whether error list is expanded to show all errors
  const [errorsExpanded, setErrorsExpanded] = useState(false);
  // Track a reset key to properly clear importResult when user resets
  const [resetKey, setResetKey] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isImporting = fetcher.state === "submitting";

  // Update import result when fetcher completes (transitions from non-idle to idle)
  // Using effect to avoid re-setting on every render
  const prevFetcherState = useRef(fetcher.state);
  useEffect(() => {
    if (prevFetcherState.current !== "idle" && fetcher.state === "idle" && fetcher.data) {
      setImportResult(fetcher.data);
    }
    prevFetcherState.current = fetcher.state;
  }, [fetcher.state, fetcher.data]);

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      setFileName(file.name);
      setStatus("loading");
      setErrorMessage(null);
      setResult(null);
      setImportResult(null);
      setOverLimitError(null);
      setResetKey((k) => k + 1);

      try {
        // Dynamic import from .client.ts module keeps xlsx out of server bundle
        const { parseBankStatement } = await import("~/lib/banks/parse.client.js");

        const parseResult = await parseBankStatement(file);

        const credits = parseResult.transactions
          .filter((t) => t.direction === "CR")
          .map((t) => ({
            date: t.date,
            amountPaise: t.amountPaise,
            direction: t.direction,
            narration: t.narration,
            refNo: t.refNo,
            balancePaise: t.balancePaise,
            rail: t.parsed.rail,
            utr: t.parsed.utr,
            payerName: t.parsed.payerName,
            dedupeKey: t.dedupeKey,
            sourceRow: t.sourceRow,
          }));

        const debits = parseResult.transactions.filter((t) => t.direction === "DR");

        // Check if credit count exceeds the per-import row limit
        if (credits.length > maxImportRows) {
          setOverLimitError({ rowCount: credits.length, limit: maxImportRows });
        }

        setResult({
          bank: parseResult.detection.bank,
          confidence: parseResult.detection.confidence,
          totalRows: parseResult.totalRows,
          skippedRows: parseResult.skippedRows,
          creditCount: credits.length,
          debitCount: debits.length,
          credits,
          errors: parseResult.errors,
        });
        setStatus("parsed");
      } catch (err) {
        // Log error class only - client-side, no raw error details (M8)
        const errName = err instanceof Error ? err.name : "unknown";
        console.error(`[app.imports] Parse error: ${errName}`);
        // Never render raw error messages - use fixed user-friendly message
        setErrorMessage("Failed to parse bank statement. Please ensure the file is a valid CSV, XLS, or XLSX export from a supported bank.");
        setStatus("error");
      }
    },
    [maxImportRows]
  );

  const handleImport = useCallback(() => {
    if (!result || result.credits.length === 0) return;

    // Prepare import payload using shared mapping function
    // Only normalised credit data - raw file content never sent
    const payload = {
      bank: result.bank,
      fileName: fileName ?? "statement.csv",
      credits: mapCreditsForImport(result.credits),
    };

    fetcher.submit(payload, {
      method: "POST",
      encType: "application/json",
    });
  }, [result, fileName, fetcher]);

  const handleReset = useCallback(() => {
    setStatus("idle");
    setFileName(null);
    setResult(null);
    setErrorMessage(null);
    setImportResult(null);
    setOverLimitError(null);
    setErrorsExpanded(false);
    setResetKey((k) => k + 1);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  return (
    <s-page heading="Import Bank Statement" key={resetKey}>
      {/* File upload section */}
      <s-section heading="Upload Statement">
        <s-stack>
          <s-paragraph>
            Upload an HDFC or ICICI bank statement (CSV, XLS, or XLSX). The file
            is parsed entirely in your browser — no raw data is sent to our
            servers.
          </s-paragraph>

          {/* Monthly import usage */}
          {importsThisMonth.limit !== -1 && (
            <s-banner 
              tone={importsThisMonth.allowed ? "info" : "warning"} 
              heading="Monthly import allowance"
            >
              {importsThisMonth.allowed ? (
                <>
                  You have used <s-text type="strong">{importsThisMonth.current}</s-text> of{" "}
                  <s-text type="strong">{importsThisMonth.limit}</s-text> imports this month.
                </>
              ) : (
                <>
                  You have reached your monthly import limit ({importsThisMonth.current}/{importsThisMonth.limit}).{" "}
                  <s-link href="/app/plan">Upgrade your plan</s-link> for unlimited imports.
                </>
              )}
            </s-banner>
          )}

          <s-banner tone="info" heading="Per-import limit">
            Each import can include up to <s-text type="strong">{maxImportRows.toLocaleString()}</s-text> credit rows.
            For larger statements, split them into multiple files.
          </s-banner>

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xls,.xlsx"
            onChange={handleFileSelect}
            disabled={status === "loading" || !importsThisMonth.allowed}
            style={{ marginBottom: "1rem" }}
          />

          {status === "loading" && (
            <s-paragraph>
              <s-text>Parsing {fileName}...</s-text>
            </s-paragraph>
          )}

          {status === "error" && (
            <s-banner tone="critical" heading="Parse error">
              {errorMessage}
            </s-banner>
          )}
        </s-stack>
      </s-section>

      {/* Parse results */}
      {status === "parsed" && result && (
        <>
          <s-section heading="Parse Results">
            <s-stack>
              {result.bank === "UNKNOWN" ? (
                <s-banner tone="warning" heading="Unknown bank format">
                  Could not detect HDFC or ICICI format. Please ensure you are
                  uploading a standard bank statement export.
                </s-banner>
              ) : (
                <>
                  <s-paragraph>
                    <s-text type="strong">Bank: </s-text>
                    <s-badge tone="success">{result.bank}</s-badge>
                    <s-text>
                      {" "}
                      (confidence: {Math.round(result.confidence * 100)}%)
                    </s-text>
                  </s-paragraph>
                  <s-paragraph>
                    <s-text type="strong">Total Rows: </s-text>
                    <s-text>{result.totalRows}</s-text>
                    <s-text> (skipped: {result.skippedRows})</s-text>
                  </s-paragraph>
                  <s-paragraph>
                    <s-text type="strong">Credits Found: </s-text>
                    <s-text tone="success">{result.creditCount}</s-text>
                    <s-text> (debits: {result.debitCount}, not imported)</s-text>
                  </s-paragraph>
                </>
              )}

              {result.errors.length > 0 && (() => {
                const summary = summarizeParseErrors(result.errors);
                return (
                  <s-banner tone="warning" heading={`${summary.totalCount} row(s) could not be parsed`}>
                    <s-unordered-list>
                      {summary.initialErrors.map((err, idx) => (
                        <s-list-item key={idx}>
                          <s-text type="strong">{formatErrorRowLabel(err.row)}</s-text>
                          {" "}
                          <s-badge tone={getErrorBadgeTone(err.code)}>
                            {err.code}
                          </s-badge>
                          {" "}{getErrorDisplayMessage(err.code)}
                        </s-list-item>
                      ))}
                    </s-unordered-list>
                    {summary.hasOverflow && !errorsExpanded && (
                      <s-button variant="tertiary" onClick={() => setErrorsExpanded(true)}>
                        Show all {summary.totalCount} errors ({summary.overflowCount} more)
                      </s-button>
                    )}
                    {summary.hasOverflow && errorsExpanded && (
                      <>
                        <s-unordered-list>
                          {summary.overflowErrors.map((err, idx) => (
                            <s-list-item key={`overflow-${idx}`}>
                              <s-text type="strong">{formatErrorRowLabel(err.row)}</s-text>
                              {" "}
                              <s-badge tone={getErrorBadgeTone(err.code)}>
                                {err.code}
                              </s-badge>
                              {" "}{getErrorDisplayMessage(err.code)}
                            </s-list-item>
                          ))}
                        </s-unordered-list>
                        <s-button variant="tertiary" onClick={() => setErrorsExpanded(false)}>
                          Show fewer
                        </s-button>
                      </>
                    )}
                  </s-banner>
                );
              })()}

              {/* Over-limit error banner - blocks submit */}
              {overLimitError && (
                <s-banner tone="critical" heading="Too many rows">
                  This file contains <s-text type="strong">{overLimitError.rowCount.toLocaleString()}</s-text> credit rows,
                  which exceeds the per-import limit of <s-text type="strong">{overLimitError.limit.toLocaleString()}</s-text> rows.
                  Please split your statement into smaller files before importing.
                </s-banner>
              )}

              {/* Import result banner */}
              {importResult && (
                importResult.success ? (
                  <s-banner tone="success" heading="Import complete">
                    <s-paragraph>
                      <s-text type="strong">{importResult.counts?.inserted}</s-text> credits imported,{" "}
                      <s-text type="strong">{importResult.counts?.duplicates}</s-text> duplicates skipped
                      {importResult.counts?.rejected ? (
                        <>, <s-text tone="critical">{importResult.counts.rejected}</s-text> rejected</>
                      ) : null}
                    </s-paragraph>
                    {importResult.matcher && (
                      <s-paragraph>
                        Matcher found <s-text type="strong">{importResult.matcher.matchesCreated}</s-text> potential matches
                        {importResult.matcher.highConfidenceMatches > 0 && (
                          <> (<s-text tone="success">{importResult.matcher.highConfidenceMatches}</s-text> high confidence)</>
                        )}
                        {importResult.matcher.hasMore && (
                          <> — more payments await matching</>
                        )}
                      </s-paragraph>
                    )}
                    <s-paragraph>
                      <s-link href="/app/reconcile">Review matches in Reconciliation</s-link>
                    </s-paragraph>
                  </s-banner>
                ) : (
                  <s-banner tone="critical" heading={importResult.limitReached ? "Monthly import limit reached" : "Import failed"}>
                    {importResult.error}
                    {importResult.details && importResult.details.length > 0 && (
                      <s-unordered-list>
                        {importResult.details.slice(0, 5).map((detail, idx) => (
                          <s-list-item key={idx}>{detail}</s-list-item>
                        ))}
                        {importResult.details.length > 5 && (
                          <s-list-item>...and {importResult.details.length - 5} more errors</s-list-item>
                        )}
                      </s-unordered-list>
                    )}
                  </s-banner>
                )
              )}

              <s-stack direction="inline">
                <s-button variant="secondary" onClick={handleReset}>
                  Upload Another File
                </s-button>
                {result.bank !== "UNKNOWN" && result.creditCount > 0 && !importResult?.success && !overLimitError && importsThisMonth.allowed && (
                  <s-button 
                    variant="primary" 
                    onClick={handleImport}
                    disabled={isImporting}
                  >
                    {isImporting ? "Importing..." : `Import ${result.creditCount} Credits`}
                  </s-button>
                )}
              </s-stack>
            </s-stack>
          </s-section>

          {/* Credits table */}
          {result.credits.length > 0 && (
            <s-section heading={`Credit Transactions (${result.credits.length})`}>
              <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="labeled">Date</s-table-header>
                  <s-table-header listSlot="labeled" format="currency">Amount</s-table-header>
                  <s-table-header listSlot="inline">Rail</s-table-header>
                  <s-table-header listSlot="primary">UTR/RRN</s-table-header>
                  <s-table-header listSlot="labeled">Payer</s-table-header>
                  <s-table-header listSlot="secondary">Narration</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {result.credits.slice(0, 50).map((txn, idx) => (
                    <s-table-row key={txn.dedupeKey || idx}>
                      <s-table-cell>
                        {new Date(txn.date).toLocaleDateString("en-IN")}
                      </s-table-cell>
                      <s-table-cell>
                        {formatPaiseDisplay(txn.amountPaise, shopCurrency)}
                      </s-table-cell>
                      <s-table-cell>
                        <RailBadge rail={txn.rail} />
                      </s-table-cell>
                      <s-table-cell>{txn.utr ?? "—"}</s-table-cell>
                      <s-table-cell>
                        {txn.payerName
                          ? txn.payerName.slice(0, 25) +
                            (txn.payerName.length > 25 ? "…" : "")
                          : "—"}
                      </s-table-cell>
                      <s-table-cell>
                        {txn.narration.slice(0, 40) +
                          (txn.narration.length > 40 ? "…" : "")}
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
              {result.credits.length > 50 && (
                <s-paragraph>
                  <s-text>
                    Showing first 50 of {result.credits.length} credits.
                  </s-text>
                </s-paragraph>
              )}
            </s-section>
          )}
        </>
      )}

      {/* Sidebar info */}
      <s-section slot="aside" heading="Supported Banks">
        <s-unordered-list>
          <s-list-item>
            <s-text type="strong">HDFC Bank</s-text> — Retail and corporate
            statement exports
          </s-list-item>
          <s-list-item>
            <s-text type="strong">ICICI Bank</s-text> — Retail and corporate
            statement exports
          </s-list-item>
          <s-list-item>
            <s-text type="strong">SBI (State Bank of India)</s-text> — Retail
            statement exports
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Axis Bank</s-text> — Retail and corporate
            statement exports
          </s-list-item>
        </s-unordered-list>
        <s-paragraph>
          Export your statement as CSV, XLS, or XLSX from your bank&apos;s
          netbanking portal.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Payment Rails">
        <s-paragraph>We detect and parse:</s-paragraph>
        <s-unordered-list>
          <s-list-item>
            <s-text type="strong">NEFT</s-text> — UTR format: BANKN + digits
          </s-list-item>
          <s-list-item>
            <s-text type="strong">RTGS</s-text> — UTR format: BANKR + digits
          </s-list-item>
          <s-list-item>
            <s-text type="strong">IMPS</s-text> — 12-digit RRN
          </s-list-item>
          <s-list-item>
            <s-text type="strong">UPI</s-text> — 12-digit RRN
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="Privacy">
        <s-banner tone="info" heading="Privacy-first import">
          Your bank statement file is parsed entirely in your browser. The raw
          file (CSV/XLS/XLSX) <s-text type="strong">never</s-text> leaves your device.
        </s-banner>
        <s-paragraph>
          When you import, only the normalised credit rows are sent to our server:
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>Transaction date and amount</s-list-item>
          <s-list-item>Payment rail (NEFT/RTGS/IMPS/UPI)</s-list-item>
          <s-list-item>UTR or reference number</s-list-item>
          <s-list-item>Remitter name and narration (for matching)</s-list-item>
        </s-unordered-list>
        <s-paragraph>
          Remitter names and narrations are stored for payment matching but are{" "}
          <s-text type="strong">never logged</s-text> or sent to error tracking services.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
