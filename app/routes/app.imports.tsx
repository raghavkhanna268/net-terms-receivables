/**
 * Bank Statement Import Route (S14/S15).
 *
 * Parses HDFC and ICICI bank statement exports entirely in the browser:
 * - CSV and XLS/XLSX formats supported
 * - SheetJS is lazy-loaded (dynamic import) only when parsing
 * - Raw file never leaves the browser
 * - Only parsed credit rows would be sent to the import endpoint (when implemented)
 *
 * IMPORTANT: No import endpoint exists yet. This route implements parsing
 * and UI up to that point. When the endpoint is added, wire it to send only
 * NormalisedTxn[] (not File/Blob/ArrayBuffer).
 *
 * NOTE: Uses ~/lib/banks/parse.client.ts to keep SheetJS (~1MB) out of
 * the Cloudflare Worker bundle. The .client.ts extension ensures the module
 * is never included in SSR builds.
 */

import { useState, useCallback, useRef } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getRequestSql } from "~/lib/request-context.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { shopify } = context;
  const { session } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;

  const [shop] = await sql<{ currency: string }[]>`
    SELECT currency FROM "Shop" WHERE domain = ${shopDomain}
  `;

  return {
    shopDomain,
    shopCurrency: shop?.currency ?? "INR",
  };
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

  const [status, setStatus] = useState<ParseStatus>("idle");
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<ParseResultSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      setFileName(file.name);
      setStatus("loading");
      setErrorMessage(null);
      setResult(null);

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

  const handleReset = useCallback(() => {
    setStatus("idle");
    setFileName(null);
    setResult(null);
    setErrorMessage(null);
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
            accept=".csv,.xls,.xlsx,.txt"
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

              <s-stack direction="inline">
                <s-button variant="secondary" onClick={handleReset}>
                  Upload Another File
                </s-button>
                {result.bank !== "UNKNOWN" && result.creditCount > 0 && (
                  <s-button variant="primary" disabled>
                    Import {result.creditCount} Credits (Coming Soon)
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
        <s-banner tone="info" heading="Browser-Only Parsing">
          Your bank statement file is parsed entirely in your browser. The raw
          file data (CSV/XLS/XLSX) never leaves your device. Import functionality
          is coming soon — currently you can only preview parsed transactions.
        </s-banner>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
