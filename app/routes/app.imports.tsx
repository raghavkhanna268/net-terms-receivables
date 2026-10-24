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
import {
  checkImportLimit,
  isGatingEnforced,
} from "~/services/gating.server";

/**
 * Maximum rows per import request.
 * Keeps request size reasonable and processing within Workers CPU budget.
 */
const MAX_IMPORT_ROWS = 1000;

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
    errors.push({ path: "credits", message: `Maximum ${MAX_IMPORT_ROWS} rows per import` });
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
  const { session } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;

  const [shop] = await sql<{ id: string; currency: string }[]>`
    SELECT id, currency FROM "Shop" WHERE domain = ${shopDomain}
  `;

  // Get import limit info for UI
  const gatingEnforced = isGatingEnforced();
  let importLimit: { current: number; limit: number; allowed: boolean } = {
    current: 0,
    limit: -1,
    allowed: true,
  };

  if (shop) {
    const limitCheck = await checkImportLimit(sql, shop.id);
    importLimit = {
      current: limitCheck.currentUsage,
      limit: limitCheck.limit,
      allowed: limitCheck.allowed,
    };
  }

  const storeHandle = shopDomain.replace(".myshopify.com", "");
  const upgradeUrl = `https://admin.shopify.com/store/${storeHandle}/charges/${process.env.APP_HANDLE ?? "net-terms-receivables"}/pricing_plans`;

  return {
    shopDomain,
    shopCurrency: shop?.currency ?? "INR",
    gatingEnforced,
    importLimit,
    upgradeUrl,
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

  // Check import limit (plan feature, enforced when PLAN_GATING_ENFORCED is on)
  const importLimit = await checkImportLimit(sql, shop.id);
  if (!importLimit.allowed) {
    return Response.json(
      {
        success: false,
        error: "Import limit reached",
        upgradeRequired: true,
        reason: importLimit.reason,
        usage: {
          current: importLimit.currentUsage,
          limit: importLimit.limit,
        },
      },
      { status: 403 }
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
      console.log(
        `[import] Starting import: shop=${shopDomain} importId=${importId} rows=${importData.credits.length}`
      );

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
      console.log(
        `[import] Completed: importId=${importId} inserted=${inserted} duplicates=${duplicates}`
      );

      return { importId, inserted, duplicates };
    });

    // Trigger matcher for newly imported payments
    let matcherResult = null;
    if (result.inserted > 0) {
      try {
        matcherResult = await runMatcher(sql, shopId, { limit: MAX_PAYMENTS_PER_REQUEST });
        console.log(
          `[import] Matcher run: shopId=${shopId} processed=${matcherResult.paymentsProcessed} matches=${matcherResult.matchesCreated}`
        );
      } catch (err) {
        // Log error without message content (may contain data)
        const errCode = err instanceof Error && "code" in err ? (err as { code: string }).code : undefined;
        console.error(
          `[import] Matcher failed: shopId=${shopId} errorName=${err instanceof Error ? err.name : "unknown"} code=${errCode ?? "none"}`
        );
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
    // Log error without message content (may contain row data)
    const errCode = err instanceof Error && "code" in err ? (err as { code: string }).code : undefined;
    console.error(
      `[import] Import failed: shop=${shopDomain} errorName=${err instanceof Error ? err.name : "unknown"} code=${errCode ?? "none"}`
    );
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
  errors: { row: number; message: string }[];
}

interface ImportResult {
  success: boolean;
  importId?: string;
  error?: string;
  details?: string[];
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

function RailBadge({ rail }: { rail: string }) {
  if (rail === "NEFT") return <s-badge tone="info">{rail}</s-badge>;
  if (rail === "RTGS") return <s-badge tone="success">{rail}</s-badge>;
  if (rail === "IMPS") return <s-badge tone="warning">{rail}</s-badge>;
  if (rail === "UPI") return <s-badge tone="info">{rail}</s-badge>;
  return <s-badge>{rail}</s-badge>;
}

export default function ImportsPage() {
  const { shopCurrency, gatingEnforced, importLimit, upgradeUrl } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ImportResult>();
  const isAtLimit = !importLimit.allowed;

  const [status, setStatus] = useState<ParseStatus>("idle");
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<ParseResultSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
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
        console.error("[app.imports] Parse error:", err);
        setErrorMessage(
          err instanceof Error ? err.message : "Failed to parse bank statement"
        );
        setStatus("error");
      }
    },
    []
  );

  const handleImport = useCallback(() => {
    if (!result || result.credits.length === 0) return;

    // Prepare import payload (only normalised credit data)
    // Include balancePaise for dedupe, omit undefined values for JSON compatibility
    const payload = {
      bank: result.bank,
      fileName: fileName ?? "statement.csv",
      credits: result.credits.map((c) => {
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
      }),
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
    setResetKey((k) => k + 1);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  return (
    <s-page heading="Import Bank Statement" key={resetKey}>
      {/* Import limit banner */}
      {isAtLimit && gatingEnforced && (
        <s-section>
          <s-banner tone="warning" heading="Import Limit Reached">
            <s-stack>
              <s-text>
                You&apos;ve reached your monthly import limit ({importLimit.current}/{importLimit.limit}).
                Upgrade your plan to import more bank statements.
              </s-text>
              <s-button href={upgradeUrl} target="_top">
                Upgrade Plan
              </s-button>
            </s-stack>
          </s-banner>
        </s-section>
      )}

      {/* Import usage info (when not at limit but has limit) */}
      {!isAtLimit && gatingEnforced && importLimit.limit !== -1 && (
        <s-section>
          <s-banner tone="info" heading="Import Usage">
            <s-text>
              Imports this month: {importLimit.current}/{importLimit.limit}
            </s-text>
          </s-banner>
        </s-section>
      )}

      {/* File upload section */}
      <s-section heading="Upload Statement">
        <s-stack>
          <s-paragraph>
            Upload an HDFC or ICICI bank statement (CSV, XLS, or XLSX). The file
            is parsed entirely in your browser — no raw data is sent to our
            servers.
          </s-paragraph>

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xls,.xlsx"
            onChange={handleFileSelect}
            disabled={status === "loading" || isAtLimit}
            style={{ marginBottom: "1rem" }}
          />

          {status === "loading" && (
            <s-paragraph>
              <s-text>Parsing {fileName}...</s-text>
            </s-paragraph>
          )}

          {status === "error" && (
            <s-banner tone="critical" heading="Parse Error">
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
                <s-banner tone="warning" heading="Unknown Bank Format">
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

              {result.errors.length > 0 && (
                <s-banner tone="warning" heading="Parse Warnings">
                  {result.errors.length} row(s) could not be parsed. First
                  error: Row {result.errors[0].row}: {result.errors[0].message}
                </s-banner>
              )}

              {/* Import result banner */}
              {importResult && (
                importResult.success ? (
                  <s-banner tone="success" heading="Import Complete">
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
                  <s-banner tone="critical" heading="Import Failed">
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
                {result.bank !== "UNKNOWN" && result.creditCount > 0 && !importResult?.success && (
                  <s-button 
                    variant="primary" 
                    onClick={handleImport}
                    disabled={isImporting || isAtLimit}
                  >
                    {isImporting ? "Importing..." : isAtLimit ? "Import Limit Reached" : `Import ${result.creditCount} Credits`}
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
                  <s-table-header>Date</s-table-header>
                  <s-table-header format="currency">Amount</s-table-header>
                  <s-table-header>Rail</s-table-header>
                  <s-table-header>UTR/RRN</s-table-header>
                  <s-table-header>Payer</s-table-header>
                  <s-table-header>Narration</s-table-header>
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
        <s-banner tone="info" heading="Privacy-First Import">
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
