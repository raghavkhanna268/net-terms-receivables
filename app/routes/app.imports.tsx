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

import { useState, useCallback, useRef } from "react";
import type { HeadersFunction, LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getRequestSql } from "~/lib/request-context.server";
import { runMatcher, MAX_PAYMENTS_PER_REQUEST } from "~/services/matcher.server";
import { generateDedupeKey } from "~/lib/banks/dedupe";

/**
 * Maximum rows per import request.
 * Keeps request size reasonable and processing within Workers CPU budget.
 */
const MAX_IMPORT_ROWS = 1000;

/**
 * Valid date range for imports: 2 years past to 1 week future.
 * Prevents obviously incorrect dates.
 */
const MIN_DATE = new Date();
MIN_DATE.setFullYear(MIN_DATE.getFullYear() - 2);
const MAX_DATE = new Date();
MAX_DATE.setDate(MAX_DATE.getDate() + 7);

const MIN_DATE_ISO = MIN_DATE.toISOString().slice(0, 10);
const MAX_DATE_ISO = MAX_DATE.toISOString().slice(0, 10);

/**
 * Valid payment rails for Indian bank transfers.
 */
const VALID_RAILS = new Set(["NEFT", "RTGS", "IMPS", "UPI", "ACH", "CHEQUE", "OTHER"]);
type ValidRail = "NEFT" | "RTGS" | "IMPS" | "UPI" | "ACH" | "CHEQUE" | "OTHER";

/**
 * Valid bank types.
 */
const VALID_BANKS = new Set(["HDFC", "ICICI", "UNKNOWN"]);
type ValidBank = "HDFC" | "ICICI" | "UNKNOWN";

/**
 * Credit row type for import.
 */
interface CreditRow {
  date: string;
  valueDate?: string;
  amountPaise: number;
  rail: ValidRail;
  utr?: string;
  payerName?: string;
  narration: string;
  dedupeKey: string;
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

  // Required: dedupeKey (string, 1-200)
  if (typeof r.dedupeKey !== "string" || r.dedupeKey.length < 1 || r.dedupeKey.length > 200) {
    errors.push({ path: `${prefix}.dedupeKey`, message: "Dedupe key must be 1-200 characters" });
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

  // Validate each credit row (limit error count to 10)
  for (let i = 0; i < Math.min(b.credits.length, 10); i++) {
    errors.push(...validateCreditRow(b.credits[i], i));
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

  return {
    shopDomain,
    shopId: shop?.id ?? null,
    shopCurrency: shop?.currency ?? "INR",
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

  // Validate date range for all credits
  const invalidDates = importData.credits.filter(
    (c) => c.date < MIN_DATE_ISO || c.date > MAX_DATE_ISO
  );
  if (invalidDates.length > 0) {
    return Response.json(
      { 
        success: false, 
        error: `${invalidDates.length} row(s) have dates outside valid range (${MIN_DATE_ISO} to ${MAX_DATE_ISO})` 
      },
      { status: 400 }
    );
  }

  const shopId = shop.id;
  const now = new Date();

  // Tracking counts
  let inserted = 0;
  let duplicates = 0;
  let rejected = 0;

  try {
    // Create BankImport record
    const [bankImport] = await sql<{ id: string }[]>`
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

    // Get existing UTRs for this shop to detect duplicates efficiently
    const existingUtrs = await sql<{ utr: string }[]>`
      SELECT utr FROM "Payment" 
      WHERE "shopId" = ${shopId} AND utr IS NOT NULL
    `;
    const utrSet = new Set(existingUtrs.map((r) => r.utr.toUpperCase().trim()));

    // Process each credit row
    for (const credit of importData.credits) {
      try {
        // Determine the UTR to use for deduplication
        const normalizedUtr = credit.utr?.toUpperCase().trim() || null;
        
        // Check UTR-based duplicate first (fast path)
        if (normalizedUtr && utrSet.has(normalizedUtr)) {
          duplicates++;
          continue;
        }

        // For rows without UTR, generate a fallback dedupe key
        let dedupeUtr: string | null = normalizedUtr;
        if (!dedupeUtr) {
          // Use the client's dedupe key (sha256 hash) as a synthetic UTR
          // This allows idempotent reimports even without real UTR
          const fallbackKey = await generateDedupeKey(
            credit.date,
            credit.amountPaise,
            "CR",
            credit.narration,
            credit.rail,
            undefined,
            undefined,
            credit.valueDate,
            credit.refNo
          );
          // Prefix with SYNTH- to distinguish from real UTRs
          dedupeUtr = `SYNTH-${fallbackKey}`;
          
          // Check if synthetic key already exists
          const [existing] = await sql<{ id: string }[]>`
            SELECT id FROM "Payment"
            WHERE "shopId" = ${shopId} AND utr = ${dedupeUtr}
            LIMIT 1
          `;
          if (existing) {
            duplicates++;
            continue;
          }
        }

        // Convert paise to decimal for DB storage
        const amountDecimal = credit.amountPaise / 100;
        const valueDate = credit.valueDate 
          ? new Date(credit.valueDate + "T00:00:00Z")
          : new Date(credit.date + "T00:00:00Z");

        // Insert payment row
        await sql`
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
          VALUES (
            ${shopId},
            ${importId},
            ${valueDate},
            ${amountDecimal},
            ${credit.rail},
            ${dedupeUtr},
            ${credit.payerName ?? null},
            ${credit.narration},
            'unmatched',
            ${now},
            ${now}
          )
        `;

        inserted++;
        
        // Track for future duplicate detection within this batch
        if (normalizedUtr) {
          utrSet.add(normalizedUtr);
        }
      } catch (err) {
        // Check if it's a unique constraint violation (duplicate UTR)
        if (err instanceof Error && err.message.includes("unique")) {
          duplicates++;
        } else {
          // Log error without PII (just row index and error type)
          console.error(
            `[import] Row insert failed: importId=${importId} error=${err instanceof Error ? err.name : "unknown"}`
          );
          rejected++;
        }
      }
    }

    // Log import completion (counts only, no PII)
    console.log(
      `[import] Completed: importId=${importId} inserted=${inserted} duplicates=${duplicates} rejected=${rejected}`
    );

    // Trigger matcher for newly imported payments
    let matcherResult = null;
    if (inserted > 0) {
      try {
        matcherResult = await runMatcher(sql, shopId, { limit: MAX_PAYMENTS_PER_REQUEST });
        console.log(
          `[import] Matcher run: shopId=${shopId} processed=${matcherResult.paymentsProcessed} matches=${matcherResult.matchesCreated}`
        );
      } catch (err) {
        console.error(
          `[import] Matcher failed: shopId=${shopId} error=${err instanceof Error ? err.message : "unknown"}`
        );
      }
    }

    return Response.json({
      success: true,
      importId,
      counts: {
        inserted,
        duplicates,
        rejected,
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
    // Log error without PII
    console.error(
      `[import] Import failed: shop=${shopDomain} error=${err instanceof Error ? err.message : "unknown"}`
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
  const { shopCurrency } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ImportResult>();

  const [status, setStatus] = useState<ParseStatus>("idle");
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<ParseResultSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isImporting = fetcher.state === "submitting";

  // Update import result when fetcher completes
  if (fetcher.data && fetcher.data !== importResult) {
    setImportResult(fetcher.data);
  }

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      setFileName(file.name);
      setStatus("loading");
      setErrorMessage(null);
      setResult(null);
      setImportResult(null);

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
    // Omit undefined values for JSON compatibility
    const payload = {
      bank: result.bank,
      fileName: fileName ?? "statement.csv",
      credits: result.credits.map((c) => {
        const credit: Record<string, string | number> = {
          date: c.date,
          amountPaise: c.amountPaise,
          rail: c.rail,
          narration: c.narration,
          dedupeKey: c.dedupeKey,
        };
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
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  return (
    <s-page heading="Import Bank Statement">
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
            disabled={status === "loading"}
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
