/**
 * S14 Done-when: "Assert that no narration or remitter text reaches log.server or Sentry on the import path."
 *
 * Uses the REAL log.server module (no mocking).
 * Uses the REAL matcher.server module (with synthetic buyers/invoices to produce suggestions).
 *
 * Captures at the sink: spies on console.log/info/warn/error/debug underneath it,
 * and on the Sentry capture functions.
 *
 * Runs the real import action with synthetic rows that carry distinctive marker
 * narration and remitter strings, and asserts those markers (plus the raw amounts
 * formatted in rupees) never appear in any captured output.
 *
 * Also asserts that something was captured or the path executed, so the test
 * can't pass vacuously.
 *
 * ## Sentry Mock Notes (QA Item 5)
 *
 * Sentry is partially mocked at the @sentry/cloudflare level:
 * - `withSentry` is mocked to pass through the handler directly (no Sentry wrapping)
 * - `captureException` and `captureMessage` are mocked to capture all calls for inspection
 *
 * Why mock Sentry:
 * 1. The Sentry SDK requires runtime DSN configuration not available in tests
 * 2. Without a DSN, the real functions would no-op, making verification impossible
 * 3. We need to inspect what WOULD be sent to Sentry to verify no PII passes through
 * 4. The real Sentry functions would attempt network calls in test environment
 *
 * What's NOT mocked:
 * - log.server module (safeLog, toErrorCode, redactString) - uses real implementation
 * - matcher.server module - uses real implementation with synthetic DB data
 * - All DB operations - uses real Postgres with test database
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

// Track Sentry capture calls
const sentryCaptureExceptionCalls: Array<{ error: unknown; scope?: unknown }> = [];
const sentryCaptureMessageCalls: Array<{ message: string; level?: string }> = [];

// Mock Sentry at the @sentry/cloudflare level
// See "Sentry Mock Notes" in file header for why this is necessary
vi.mock("@sentry/cloudflare", () => ({
  withSentry: vi.fn((_configFn, handler) => handler),
  captureException: vi.fn((error: unknown, scope?: unknown) => {
    sentryCaptureExceptionCalls.push({ error, scope });
  }),
  captureMessage: vi.fn((message: string, level?: string) => {
    sentryCaptureMessageCalls.push({ message, level });
  }),
}));

// NO matcher mock - use the REAL matcher to verify it doesn't log PII

import { requestContext } from "~/lib/request-context.server";
import { action } from "../app.imports";

// Distinctive marker strings that would stand out in logs
const PII_MARKERS = {
  narration1: "NEFT-CR-MARKER_SECRET_NARRATION_ABC123_CONFIDENTIAL",
  narration2: "RTGS-PAYMENT-MARKER_PRIVATE_INFO_XYZ789_SENSITIVE",
  remitter1: "MARKER_REMITTER_ACME_CORP_PRIVATE",
  remitter2: "MARKER_PAYER_BETA_INC_CONFIDENTIAL",
  // Buyer name containing PII marker (for matcher fuzzy match)
  buyerName: "MARKER_BUYER_SECRET_COMPANY_PVT_LTD",
  // Amounts in paise that would be ₹12,345.67 and ₹98,765.43
  amount1: 1234567,
  amount2: 9876543,
};

// Rupee formatted versions of the amounts
const RUPEE_AMOUNTS = [
  "₹12,345.67",
  "12,345.67",
  "12345.67",
  "₹98,765.43",
  "98,765.43",
  "98765.43",
  // Also check paise amounts
  "1234567",
  "9876543",
];

/**
 * Create a mock request with JSON body.
 */
function createMockRequest(body: unknown): Request {
  return new Request("http://localhost/app/imports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Create mock Shopify context.
 */
function createMockContext(shopDomain: string) {
  return {
    shopify: {
      authenticate: {
        admin: vi.fn().mockResolvedValue({
          session: { shop: shopDomain },
        }),
      },
    },
  };
}

/**
 * Call the real action inside request context.
 */
async function callAction(
  sql: ReturnType<typeof postgres>,
  shopDomain: string,
  body: unknown
): Promise<Response> {
  const request = createMockRequest(body);
  const context = createMockContext(shopDomain);
  const url = new URL(request.url);
  
  return requestContext.run({ getSql: () => sql }, async () => {
    return action({
      request,
      context: context as never,
      params: {},
      url,
      pattern: "/app/imports",
    });
  });
}

/**
 * Get ISO date string for yesterday (UTC).
 */
function yesterday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Get ISO date string for today (UTC).
 */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

describeWithDb("PII never logged to console or Sentry on import path (with REAL matcher)", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let testBuyerAccountId: string;
  let testInvoiceId: string;
  let TEST_SHOP_DOMAIN: string;
  
  // Console capture
  let consoleLogs: string[] = [];
  let consoleInfos: string[] = [];
  let consoleWarns: string[] = [];
  let consoleErrors: string[] = [];
  let consoleDebugs: string[] = [];
  
  // Spies
  let logSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    const suffix = Date.now().toString(36) + "pii";
    TEST_SHOP_DOMAIN = `test-pii-logging-${suffix}.myshopify.com`;

    // Create test shop
    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    // Create a BuyerAccount with PII marker in name (for matcher to fuzzy match)
    // Use TAGGED_CUSTOMER kind which requires customerId per BuyerAccount_kind_consistency constraint
    const testCustomerId = `gid://shopify/Customer/pii-test-${Date.now()}`;
    const [buyer] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        "shopId", kind, "customerId", name, "holdState", "createdAt", "updatedAt"
      ) VALUES (
        ${testShopId}, 
        'TAGGED_CUSTOMER',
        ${testCustomerId},
        ${PII_MARKERS.buyerName},
        'OK',
        NOW(), 
        NOW()
      )
      RETURNING id
    `;
    testBuyerAccountId = buyer.id;

    // Create an Invoice for the buyer (amount in range for matching)
    // Amount is ~₹12,345 (1234500 paise) - close to PII_MARKERS.amount1
    const [invoice] = await sql<{ id: string }[]>`
      INSERT INTO "Invoice" (
        "shopId", "buyerAccountId", name, total, outstanding, "issuedAt", "createdAt", "updatedAt"
      ) VALUES (
        ${testShopId},
        ${testBuyerAccountId},
        '#TEST-PII-001',
        12345.67,
        12345.67,
        NOW(),
        NOW(),
        NOW()
      )
      RETURNING id
    `;
    testInvoiceId = invoice.id;
  });

  afterAll(async () => {
    if (sql) {
      // Clean up in order (respect foreign keys)
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;
      await sql.end();
    }
  });

  beforeEach(async () => {
    // Clean payments and matches, but keep buyer and invoice for matching
    await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
    
    // Reset invoice outstanding to original amount
    await sql`UPDATE "Invoice" SET outstanding = 12345.67 WHERE id = ${testInvoiceId}`;
    
    // Clear all captures
    consoleLogs = [];
    consoleInfos = [];
    consoleWarns = [];
    consoleErrors = [];
    consoleDebugs = [];
    sentryCaptureExceptionCalls.length = 0;
    sentryCaptureMessageCalls.length = 0;
    
    // Spy on all console methods
    logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      consoleLogs.push(args.map(String).join(" "));
    });
    infoSpy = vi.spyOn(console, "info").mockImplementation((...args) => {
      consoleInfos.push(args.map(String).join(" "));
    });
    warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
      consoleWarns.push(args.map(String).join(" "));
    });
    errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      consoleErrors.push(args.map(String).join(" "));
    });
    debugSpy = vi.spyOn(console, "debug").mockImplementation((...args) => {
      consoleDebugs.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    debugSpy.mockRestore();
    vi.clearAllMocks();
  });

  /**
   * Get all captured output combined.
   */
  function getAllCapturedOutput(): string {
    return [
      ...consoleLogs,
      ...consoleInfos,
      ...consoleWarns,
      ...consoleErrors,
      ...consoleDebugs,
    ].join("\n");
  }

  /**
   * Get all Sentry captured data as string.
   */
  function getSentryCapturedOutput(): string {
    const parts: string[] = [];
    
    for (const call of sentryCaptureExceptionCalls) {
      parts.push(JSON.stringify(call));
    }
    for (const call of sentryCaptureMessageCalls) {
      parts.push(JSON.stringify(call));
    }
    
    return parts.join("\n");
  }

  /**
   * Assert that no PII markers appear in the given output.
   */
  function assertNoPiiInOutput(output: string, context: string): void {
    // Check marker narrations
    expect(output, `${context}: Found narration1 marker`).not.toContain(PII_MARKERS.narration1);
    expect(output, `${context}: Found narration2 marker`).not.toContain(PII_MARKERS.narration2);
    
    // Check marker remitters
    expect(output, `${context}: Found remitter1 marker`).not.toContain(PII_MARKERS.remitter1);
    expect(output, `${context}: Found remitter2 marker`).not.toContain(PII_MARKERS.remitter2);
    
    // Check buyer name marker
    expect(output, `${context}: Found buyerName marker`).not.toContain(PII_MARKERS.buyerName);
    
    // Check rupee-formatted amounts
    for (const amount of RUPEE_AMOUNTS) {
      expect(output, `${context}: Found amount ${amount} in output`).not.toContain(amount);
    }
  }

  it("import with matcher producing suggestions: no PII in console logs", async () => {
    // Import a payment that matches the invoice amount and buyer name
    // The payer name contains PII marker that the matcher might try to fuzzy match
    const payload = {
      bank: "HDFC",
      fileName: "pii-matcher-test.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: PII_MARKERS.amount1, // ~₹12,345.67 - matches invoice
          rail: "NEFT",
          utr: "HDFCN26296MTR001",
          payerName: PII_MARKERS.remitter1,
          narration: PII_MARKERS.narration1,
        },
      ],
    };

    const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
    expect(response.status).toBe(200);
    
    const data = await response.json() as {
      success: boolean;
      counts?: { inserted: number };
      matcher?: { matchesCreated: number; paymentsProcessed: number } | null;
    };
    expect(data.success).toBe(true);
    expect(data.counts?.inserted).toBe(1);
    
    // Verify the matcher ran (not skipped)
    // The matcher should have processed the payment
    expect(data.matcher).not.toBeNull();
    expect(data.matcher?.paymentsProcessed).toBeGreaterThanOrEqual(0);
    
    // Verify logs were captured (path was executed)
    const allOutput = getAllCapturedOutput();
    expect(allOutput.length).toBeGreaterThan(0);
    expect(allOutput).toContain('"event":"import.');
    
    // Assert no PII in console output
    assertNoPiiInOutput(allOutput, "console logs with matcher");
    
    // Assert no PII in Sentry captures
    assertNoPiiInOutput(getSentryCapturedOutput(), "Sentry captures with matcher");
  });

  it("successful import: marker narrations and remitters never appear in console logs", async () => {
    const payload = {
      bank: "HDFC",
      fileName: "pii-test.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: PII_MARKERS.amount1,
          rail: "NEFT",
          utr: "HDFCN26296PII001",
          payerName: PII_MARKERS.remitter1,
          narration: PII_MARKERS.narration1,
        },
        {
          date: today(),
          amountPaise: PII_MARKERS.amount2,
          rail: "RTGS",
          utr: "HDFCR26296PII002",
          payerName: PII_MARKERS.remitter2,
          narration: PII_MARKERS.narration2,
        },
      ],
    };

    const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
    expect(response.status).toBe(200);
    
    const data = await response.json();
    expect((data as { success: boolean }).success).toBe(true);
    expect((data as { counts?: { inserted: number } }).counts?.inserted).toBe(2);
    
    // Verify the path was executed (logs were captured)
    const allOutput = getAllCapturedOutput();
    expect(allOutput.length).toBeGreaterThan(0);
    expect(allOutput).toContain('"event":"import.');
    
    // Assert no PII in console output
    assertNoPiiInOutput(allOutput, "console logs");
    
    // Assert no PII in Sentry captures
    assertNoPiiInOutput(getSentryCapturedOutput(), "Sentry captures");
  });

  it("duplicate import: marker narrations and remitters never appear in console logs", async () => {
    // First import
    const payload = {
      bank: "HDFC",
      fileName: "pii-dupe.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: PII_MARKERS.amount1,
          rail: "NEFT",
          utr: "HDFCN26296DUP001",
          payerName: PII_MARKERS.remitter1,
          narration: PII_MARKERS.narration1,
        },
      ],
    };

    await callAction(sql, TEST_SHOP_DOMAIN, payload);
    
    // Clear captures after first import
    consoleLogs = [];
    consoleInfos = [];
    consoleWarns = [];
    consoleErrors = [];
    consoleDebugs = [];
    sentryCaptureExceptionCalls.length = 0;
    sentryCaptureMessageCalls.length = 0;
    
    // Re-import (duplicate)
    const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
    expect(response.status).toBe(200);
    
    const data = await response.json();
    expect((data as { counts?: { duplicates: number } }).counts?.duplicates).toBe(1);
    
    // Verify path was executed
    const allOutput = getAllCapturedOutput();
    expect(allOutput.length).toBeGreaterThan(0);
    
    // Assert no PII
    assertNoPiiInOutput(allOutput, "console logs (duplicate)");
    assertNoPiiInOutput(getSentryCapturedOutput(), "Sentry captures (duplicate)");
  });

  it("import with mixed results: no PII in any log level", async () => {
    // First create one payment
    const firstPayload = {
      bank: "ICICI",
      fileName: "mixed1.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: PII_MARKERS.amount1,
          rail: "IMPS",
          utr: "123456789012",
          payerName: PII_MARKERS.remitter1,
          narration: PII_MARKERS.narration1,
        },
      ],
    };
    await callAction(sql, TEST_SHOP_DOMAIN, firstPayload);
    
    // Clear captures
    consoleLogs = [];
    consoleInfos = [];
    consoleWarns = [];
    consoleErrors = [];
    consoleDebugs = [];
    
    // Import mix of new and duplicate
    const mixedPayload = {
      bank: "ICICI",
      fileName: "mixed2.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: PII_MARKERS.amount1,
          rail: "IMPS",
          utr: "123456789012", // Duplicate
          payerName: PII_MARKERS.remitter1,
          narration: PII_MARKERS.narration1,
        },
        {
          date: today(),
          amountPaise: PII_MARKERS.amount2,
          rail: "UPI",
          utr: "987654321098", // New
          payerName: PII_MARKERS.remitter2,
          narration: PII_MARKERS.narration2,
        },
      ],
    };
    
    const response = await callAction(sql, TEST_SHOP_DOMAIN, mixedPayload);
    expect(response.status).toBe(200);
    
    const data = await response.json();
    expect((data as { counts?: { inserted: number; duplicates: number } }).counts?.inserted).toBe(1);
    expect((data as { counts?: { inserted: number; duplicates: number } }).counts?.duplicates).toBe(1);
    
    const allOutput = getAllCapturedOutput();
    expect(allOutput.length).toBeGreaterThan(0);
    
    // Check each log level individually
    for (const logs of [consoleLogs, consoleInfos, consoleWarns, consoleErrors, consoleDebugs]) {
      for (const log of logs) {
        assertNoPiiInOutput(log, `individual log entry`);
      }
    }
  });

  it("error path: marker PII never appears in error logs", async () => {
    // Force error by using non-existent shop
    const payload = {
      bank: "HDFC",
      fileName: "error.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: PII_MARKERS.amount1,
          rail: "NEFT",
          payerName: PII_MARKERS.remitter1,
          narration: PII_MARKERS.narration1,
        },
      ],
    };

    const response = await callAction(sql, "test-nonexistent-shop.myshopify.com", payload);
    expect(response.status).toBe(404);
    
    const allOutput = getAllCapturedOutput();
    
    // Even in error path, no PII
    assertNoPiiInOutput(allOutput, "error logs");
    assertNoPiiInOutput(getSentryCapturedOutput(), "Sentry error captures");
  });

  it("logs contain only allowed fields: shopId, importId, counts", async () => {
    const payload = {
      bank: "HDFC",
      fileName: "fields-test.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: PII_MARKERS.amount1,
          rail: "NEFT",
          utr: "HDFCN26296FLD001",
          payerName: PII_MARKERS.remitter1,
          narration: PII_MARKERS.narration1,
        },
      ],
    };

    const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
    expect(response.status).toBe(200);
    
    const allOutput = getAllCapturedOutput();
    
    // Should contain allowed fields
    expect(allOutput).toContain('"shopId"');
    expect(allOutput).toContain('"importId"');
    expect(allOutput).toMatch(/"count":|"insertedCount":|"duplicateCount":/);
    
    // Should NOT contain PII field names with values
    expect(allOutput).not.toMatch(/"payerName"\s*:\s*"/);
    expect(allOutput).not.toMatch(/"payerText"\s*:\s*"/);
    expect(allOutput).not.toMatch(/"narration"\s*:\s*"/);
    expect(allOutput).not.toMatch(/"remitter"\s*:\s*"/);
  });

  it("shop domain is never logged (only shopId)", async () => {
    const payload = {
      bank: "HDFC",
      fileName: "domain-test.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: 100000,
          rail: "NEFT",
          utr: "HDFCN26296DOM001",
          narration: "NEFT CR-DOMAIN TEST",
        },
      ],
    };

    const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
    expect(response.status).toBe(200);
    
    const allOutput = getAllCapturedOutput();
    
    // Should have shopId
    expect(allOutput).toContain('"shopId"');
    
    // Should NOT have the domain
    expect(allOutput).not.toContain(".myshopify.com");
    expect(allOutput).not.toContain(TEST_SHOP_DOMAIN);
  });

  it("safeLog JSON structure is used consistently", async () => {
    const payload = {
      bank: "HDFC",
      fileName: "structure-test.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: 100000,
          rail: "NEFT",
          utr: "HDFCN26296STR001",
          narration: "NEFT CR-STRUCTURE TEST",
        },
      ],
    };

    const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
    expect(response.status).toBe(200);
    
    // Each log line should be valid JSON with "event" field
    for (const log of consoleLogs) {
      if (log.startsWith("{")) {
        const parsed = JSON.parse(log);
        expect(parsed).toHaveProperty("event");
        expect(typeof parsed.event).toBe("string");
        expect(parsed.event).toMatch(/^import\./);
      }
    }
  });

  it("path executed assertion: test cannot pass vacuously", async () => {
    const payload = {
      bank: "HDFC",
      fileName: "vacuous-test.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: PII_MARKERS.amount1,
          rail: "NEFT",
          utr: "HDFCN26296VAC001",
          payerName: PII_MARKERS.remitter1,
          narration: PII_MARKERS.narration1,
        },
      ],
    };

    const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
    expect(response.status).toBe(200);
    
    const allOutput = getAllCapturedOutput();
    
    // Must have captured something (not vacuously passing)
    expect(allOutput.length).toBeGreaterThan(0);
    expect(allOutput).toContain("import.start");
    expect(allOutput).toContain("import.complete");
    
    // And verify the data was actually inserted
    const [count] = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM "Payment" WHERE "shopId" = ${testShopId}
    `;
    expect(parseInt(count.c, 10)).toBeGreaterThan(0);
  });

  it("matcher logs no PII when processing payments", async () => {
    // Import a payment that should trigger matcher processing
    const payload = {
      bank: "HDFC",
      fileName: "matcher-pii-test.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: PII_MARKERS.amount1,
          rail: "NEFT",
          utr: "HDFCN26296MTRPII",
          payerName: PII_MARKERS.remitter1,
          narration: PII_MARKERS.narration1,
        },
      ],
    };

    const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
    expect(response.status).toBe(200);
    
    const data = await response.json() as {
      success: boolean;
      matcher?: { paymentsProcessed: number } | null;
    };
    
    expect(data.success).toBe(true);
    // Matcher should have been invoked (even if no matches found)
    expect(data.matcher).not.toBeNull();
    
    const allOutput = getAllCapturedOutput();
    
    // Matcher logs should be present (import.matcher_run event)
    expect(allOutput).toContain("import.matcher_run");
    
    // No PII in any output
    assertNoPiiInOutput(allOutput, "matcher processing logs");
    assertNoPiiInOutput(getSentryCapturedOutput(), "Sentry captures during matcher");
  });
});
