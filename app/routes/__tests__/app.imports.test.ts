/**
 * Tests for bank statement import endpoint (S14/S15/S16).
 *
 * Tests verify by calling the REAL exported action:
 * 1. Inserted count matches credits sent
 * 2. Re-importing same rows yields all duplicates
 * 3. Two same-day credits with different balancePaise both insert
 * 4. CHEQUE/ACH non-UTR refs get SYNTH- keys
 * 5. Cross-shop isolation: shop B's session can't see or affect shop A's rows
 * 6. Oversized and invalid payloads are rejected
 * 7. runMatcher is invoked after successful import with inserts
 * 8. PII (remitter names, narrations) is NEVER logged
 * 9. Date boundary tests: just inside window passes, just outside rejected
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

// ============================================================================
// Date helpers - use shared computeDateBounds from action for consistency
// ============================================================================

import { computeDateBounds } from "../app.imports";

/**
 * Get ISO date string for N days ago (or in the future if negative).
 * Uses UTC date manipulation to match toISOString() output.
 */
function daysAgo(n: number, referenceDate: Date = new Date()): string {
  const d = new Date(referenceDate);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Get ISO date string for today (UTC).
 */
function today(): string {
  return daysAgo(0);
}

/**
 * Get ISO date string for yesterday (UTC).
 */
function yesterday(): string {
  return daysAgo(1);
}

/**
 * Get a date just inside the valid window (minDate + 1 day).
 * Uses the same computation as the action to handle leap years correctly.
 */
function justInsideWindow(referenceDate: Date = new Date()): string {
  const { minDateIso } = computeDateBounds(referenceDate);
  const minDate = new Date(minDateIso + "T00:00:00Z");
  minDate.setUTCDate(minDate.getUTCDate() + 1);
  return minDate.toISOString().slice(0, 10);
}

/**
 * Get a date just outside the valid window (minDate - 1 day).
 * Uses the same computation as the action to handle leap years correctly.
 */
function justOutsideWindow(referenceDate: Date = new Date()): string {
  const { minDateIso } = computeDateBounds(referenceDate);
  const minDate = new Date(minDateIso + "T00:00:00Z");
  minDate.setUTCDate(minDate.getUTCDate() - 1);
  return minDate.toISOString().slice(0, 10);
}

// ============================================================================
// Test helpers
// ============================================================================

interface ImportActionResult {
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

/**
 * Create a mock request with JSON body.
 */
function createMockRequest(body: unknown, method = "POST"): Request {
  return new Request("http://localhost/app/imports", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Create mock Shopify context with authenticated session.
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
 * Parse response JSON with type.
 */
async function parseResponse(response: Response): Promise<ImportActionResult> {
  return response.json() as Promise<ImportActionResult>;
}

// ============================================================================
// Mocked matcher for vi.mock hoisting
// ============================================================================

// Track matcher calls across all tests
const matcherCalls: Array<{ shopId: string }> = [];

// Use vi.mock with hoisting - this is applied before any imports
vi.mock("~/services/matcher.server", () => ({
  runMatcher: vi.fn(async (_sql: unknown, shopId: string) => {
    matcherCalls.push({ shopId });
    return {
      paymentsProcessed: 1,
      matchesCreated: 0,
      highConfidenceMatches: 0,
      hasMore: false,
    };
  }),
  MAX_PAYMENTS_PER_REQUEST: 100,
}));

// Now import after mock is set up
import { requestContext } from "~/lib/request-context.server";
import { action, validateImportRequest, MAX_IMPORT_ROWS } from "../app.imports";

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

describeWithDb("Bank Import Action Integration Tests", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let testShop2Id: string;
  let TEST_SHOP_DOMAIN: string;
  let TEST_SHOP2_DOMAIN: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    const suffix = Date.now().toString(36);
    TEST_SHOP_DOMAIN = `import-test-${suffix}.myshopify.com`;
    TEST_SHOP2_DOMAIN = `import-test-other-${suffix}.myshopify.com`;

    // Create test shops
    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    const [shop2] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP2_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShop2Id = shop2.id;
  });

  afterAll(async () => {
    if (sql) {
      // Clean up test data
      await sql`DELETE FROM "Payment" WHERE "shopId" IN (${testShopId}, ${testShop2Id})`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" IN (${testShopId}, ${testShop2Id})`;
      await sql`DELETE FROM "Shop" WHERE id IN (${testShopId}, ${testShop2Id})`;
      await sql.end();
    }
  });

  beforeEach(async () => {
    // Clean payments and imports before each test
    await sql`DELETE FROM "Payment" WHERE "shopId" IN (${testShopId}, ${testShop2Id})`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" IN (${testShopId}, ${testShop2Id})`;
    
    // Clear matcher call tracking
    matcherCalls.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Payment insertion via real action", () => {
    it("(a) inserts correct count of credits", async () => {
      const payload = {
        bank: "HDFC",
        fileName: "test.csv",
        credits: [
          {
            date: yesterday(),
            amountPaise: 1000000,
            rail: "NEFT",
            utr: "HDFCN26296000001",
            payerName: "ACME Corp",
            narration: "NEFT CR-ACME CORP-INV001",
          },
          {
            date: today(),
            amountPaise: 2000000,
            rail: "RTGS",
            utr: "HDFCR26296000002",
            payerName: "Beta Inc",
            narration: "RTGS CR-BETA INC-INV002",
          },
        ],
      };

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response.status).toBe(200);

      const data = await parseResponse(response);
      expect(data.success).toBe(true);
      expect(data.counts?.inserted).toBe(2);
      expect(data.counts?.duplicates).toBe(0);
      expect(data.counts?.total).toBe(2);

      // Verify DB state
      const [count] = await sql<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM "Payment" WHERE "shopId" = ${testShopId}
      `;
      expect(parseInt(count.c, 10)).toBe(2);
    });

    it("(b) re-import yields all duplicates", async () => {
      // Use valid NEFT UTR format: 4 letters + N + 11-17 digits
      const validNeftUtr = "HDFCN26296123456";
      const payload = {
        bank: "HDFC",
        fileName: "test.csv",
        credits: [
          {
            date: yesterday(),
            amountPaise: 1000000,
            rail: "NEFT",
            utr: validNeftUtr,
            narration: "NEFT CR-REIMPORT TEST",
          },
        ],
      };

      // First import
      const response1 = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response1.status).toBe(200);
      const data1 = await parseResponse(response1);
      expect(data1.counts?.inserted).toBe(1);
      expect(data1.counts?.duplicates).toBe(0);

      // Re-import same data
      const response2 = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response2.status).toBe(200);
      const data2 = await parseResponse(response2);
      expect(data2.counts?.inserted).toBe(0);
      expect(data2.counts?.duplicates).toBe(1);

      // Verify only 1 payment in DB with the exact UTR (valid UTRs keep their value)
      const [count] = await sql<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM "Payment" 
        WHERE "shopId" = ${testShopId} AND utr = ${validNeftUtr}
      `;
      expect(parseInt(count.c, 10)).toBe(1);
    });

    it("(c) two same-day credits with different balancePaise both insert", async () => {
      const testDate = yesterday();
      const payload = {
        bank: "HDFC",
        fileName: "same-day.csv",
        credits: [
          {
            date: testDate,
            amountPaise: 500000,
            balancePaise: 10000000,
            rail: "CHEQUE",
            narration: "CHEQUE DEPOSIT",
          },
          {
            date: testDate,
            amountPaise: 500000,
            balancePaise: 10500000, // Different balance = different hash
            rail: "CHEQUE",
            narration: "CHEQUE DEPOSIT",
          },
        ],
      };

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response.status).toBe(200);

      const data = await parseResponse(response);
      expect(data.counts?.inserted).toBe(2);
      expect(data.counts?.duplicates).toBe(0);

      // Verify both inserted with SYNTH- prefix (cheques don't have valid UTRs)
      const payments = await sql<{ utr: string }[]>`
        SELECT utr FROM "Payment" 
        WHERE "shopId" = ${testShopId} AND rail = 'CHEQUE'
      `;
      expect(payments).toHaveLength(2);
      expect(payments.every(p => p.utr.startsWith("SYNTH-"))).toBe(true);
    });

    it("(d) CHEQUE/ACH non-UTR refs get SYNTH- keys", async () => {
      const payload = {
        bank: "HDFC",
        fileName: "cheques.csv",
        credits: [
          {
            date: yesterday(),
            amountPaise: 500000,
            rail: "CHEQUE",
            utr: "000123", // Invalid UTR for cheque
            narration: "CHEQUE 000123 FROM BUYER A",
          },
          {
            date: yesterday(),
            amountPaise: 600000,
            rail: "ACH",
            utr: "ACH-REF-456", // Invalid UTR for ACH
            narration: "ACH CREDIT FROM BUYER B",
          },
        ],
      };

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response.status).toBe(200);

      const data = await parseResponse(response);
      expect(data.counts?.inserted).toBe(2);

      // Verify all have SYNTH- prefix (no valid UTRs)
      const payments = await sql<{ utr: string; rail: string }[]>`
        SELECT utr, rail FROM "Payment" 
        WHERE "shopId" = ${testShopId} AND rail IN ('CHEQUE', 'ACH')
      `;
      expect(payments).toHaveLength(2);
      expect(payments.every(p => p.utr.startsWith("SYNTH-"))).toBe(true);
    });

    it("(e) cross-shop isolation: shop B's session can't see or affect shop A's rows", async () => {
      // Import to shop A
      const payloadA = {
        bank: "HDFC",
        fileName: "shopA.csv",
        credits: [
          {
            date: yesterday(),
            amountPaise: 1000000,
            rail: "NEFT",
            utr: "HDFCN26296100001",
            narration: "NEFT CR-SHOP A",
          },
        ],
      };

      const responseA = await callAction(sql, TEST_SHOP_DOMAIN, payloadA);
      expect(responseA.status).toBe(200);
      const dataA = await parseResponse(responseA);
      expect(dataA.counts?.inserted).toBe(1);

      // Import same UTR to shop B (should succeed - different shop)
      const payloadB = {
        bank: "HDFC",
        fileName: "shopB.csv",
        credits: [
          {
            date: yesterday(),
            amountPaise: 1000000,
            rail: "NEFT",
            utr: "HDFCN26296100001", // Same UTR!
            narration: "NEFT CR-SHOP B",
          },
        ],
      };

      const responseB = await callAction(sql, TEST_SHOP2_DOMAIN, payloadB);
      expect(responseB.status).toBe(200);
      const dataB = await parseResponse(responseB);
      expect(dataB.counts?.inserted).toBe(1);
      expect(dataB.counts?.duplicates).toBe(0);

      // Verify each shop has exactly 1 payment
      const [countA] = await sql<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM "Payment" WHERE "shopId" = ${testShopId}
      `;
      const [countB] = await sql<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM "Payment" WHERE "shopId" = ${testShop2Id}
      `;
      expect(parseInt(countA.c, 10)).toBe(1);
      expect(parseInt(countB.c, 10)).toBe(1);
    });

    it("(f.1) rejects oversized payload (>1000 rows)", async () => {
      const credits = Array.from({ length: 1001 }, (_, i) => ({
        date: yesterday(),
        amountPaise: 1000,
        rail: "NEFT",
        narration: `Payment ${i}`,
      }));

      const payload = {
        bank: "HDFC",
        fileName: "large.csv",
        credits,
      };

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response.status).toBe(400);

      const data = await parseResponse(response);
      expect(data.success).toBe(false);
      expect(data.error).toContain("Validation failed");
    });

    it("(f.2) rejects invalid payload (negative amount)", async () => {
      const payload = {
        bank: "HDFC",
        fileName: "invalid.csv",
        credits: [
          {
            date: yesterday(),
            amountPaise: -1000,
            rail: "NEFT",
            narration: "Negative",
          },
        ],
      };

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response.status).toBe(400);

      const data = await parseResponse(response);
      expect(data.success).toBe(false);
    });

    it("(f.3) rejects invalid bank type", async () => {
      const payload = {
        bank: "KOTAK",
        fileName: "invalid.csv",
        credits: [
          {
            date: yesterday(),
            amountPaise: 1000,
            rail: "NEFT",
            narration: "Test",
          },
        ],
      };

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response.status).toBe(400);
    });

    it("(f.4) batched insert via jsonb_to_recordset handles JSON serialization correctly", async () => {
      // This test verifies the tx.json() serialization works correctly.
      // Previously JSON.stringify(rows) caused postgres.js to double-encode,
      // sending a JSON string scalar instead of array, causing PostgresError 22023.
      
      // Use valid UTR formats: 4 letters + N/R + 11-17 digits (no letters after prefix)
      const neftUtr = "HDFCN26296900001";  // Valid NEFT UTR
      const rtgsUtr = "HDFCR26296900002";  // Valid RTGS UTR
      const impsUtr = "999988887777";       // Valid 12-digit IMPS RRN
      
      const payload = {
        bank: "HDFC",
        fileName: "json-serial.csv",
        credits: [
          {
            date: yesterday(),
            amountPaise: 100000,  // 1000.00
            rail: "NEFT",
            utr: neftUtr,
            payerName: "Test Corp",
            narration: "NEFT CR-JSON SERIALIZATION TEST",
          },
          {
            date: today(),
            amountPaise: 200000,  // 2000.00
            rail: "RTGS",
            utr: rtgsUtr,
            narration: "RTGS CR-JSON TEST 2",
          },
          {
            date: yesterday(),
            amountPaise: 50000,   // 500.00
            balancePaise: 1500000,
            rail: "IMPS",
            utr: impsUtr,
            payerName: "Payer With Special Chars: \"quotes\" & <brackets>",
            narration: "IMPS with special chars: éàü",
          },
        ],
      };

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      
      // Should NOT get 500 (PostgresError 22023 from jsonb_to_recordset)
      expect(response.status).toBe(200);

      const data = await parseResponse(response);
      expect(data.success).toBe(true);
      expect(data.counts?.inserted).toBe(3);
      expect(data.counts?.total).toBe(3);

      // Query specifically for this test's UTRs to ensure isolation
      // Use IN ${sql(array)} instead of ANY() - postgres.js with fetch_types:false
      // needs explicit array handling (see db-light.server.ts comments)
      const testUtrs = [neftUtr, rtgsUtr, impsUtr];
      const payments = await sql<{ utr: string; amount: string; rail: string }[]>`
        SELECT utr, amount::text, rail FROM "Payment" 
        WHERE "shopId" = ${testShopId} AND utr IN ${sql(testUtrs)}
        ORDER BY amount::numeric
      `;
      expect(payments).toHaveLength(3);
      
      // Verify amounts sorted numerically: 500.00, 1000.00, 2000.00
      expect(payments[0].amount).toBe("500.00");
      expect(payments[0].utr).toBe(impsUtr);
      expect(payments[1].amount).toBe("1000.00");
      expect(payments[1].utr).toBe(neftUtr);
      expect(payments[2].amount).toBe("2000.00");
      expect(payments[2].utr).toBe(rtgsUtr);
    });
  });

  describe("Date boundary tests", () => {
    // Pin the clock for deterministic date calculations.
    // This avoids issues where local date and UTC date differ (e.g., at midnight IST).
    // Scoped to this describe block to avoid affecting plan-limit tests that use DB NOW().
    const PINNED_DATE = new Date("2026-10-15T12:00:00Z");
    beforeAll(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(PINNED_DATE);
    });
    afterAll(() => {
      vi.useRealTimers();
    });

    it("date just inside window (minDate + 1 day) passes", async () => {
      const payload = {
        bank: "HDFC",
        fileName: "old-valid.csv",
        credits: [
          {
            date: justInsideWindow(),
            amountPaise: 1000000,
            rail: "NEFT",
            utr: "HDFCN26296200001",
            narration: "NEFT CR-OLD BUT VALID",
          },
        ],
      };

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response.status).toBe(200);

      const data = await parseResponse(response);
      expect(data.success).toBe(true);
      expect(data.counts?.inserted).toBe(1);
    });

    it("date just outside window (minDate - 1 day) is rejected", async () => {
      const payload = {
        bank: "HDFC",
        fileName: "too-old.csv",
        credits: [
          {
            date: justOutsideWindow(),
            amountPaise: 1000000,
            rail: "NEFT",
            utr: "HDFCN26296200002",
            narration: "NEFT CR-TOO OLD",
          },
        ],
      };

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response.status).toBe(400);

      const data = await parseResponse(response);
      expect(data.success).toBe(false);
      expect(data.error).toContain("dates outside valid range");
    });

    it("date boundaries hold across leap year (faked clock at 2028-06-01)", async () => {
      // Fake system time to 2028-06-01 (after Feb 29, 2028 leap day)
      const fakeNow = new Date("2028-06-01T12:00:00Z");
      vi.setSystemTime(fakeNow);

      try {
        // Compute boundaries using the faked time
        const insideDate = justInsideWindow(fakeNow);
        const outsideDate = justOutsideWindow(fakeNow);

        // Inside date should pass
        const insidePayload = {
          bank: "HDFC",
          fileName: "leap-inside.csv",
          credits: [
            {
              date: insideDate,
              amountPaise: 1000000,
              rail: "NEFT",
              utr: "HDFCN26296300001",
              narration: "NEFT CR-LEAP INSIDE",
            },
          ],
        };

        const insideResponse = await callAction(sql, TEST_SHOP_DOMAIN, insidePayload);
        expect(insideResponse.status).toBe(200);
        const insideData = await parseResponse(insideResponse);
        expect(insideData.success).toBe(true);

        // Outside date should be rejected
        const outsidePayload = {
          bank: "HDFC",
          fileName: "leap-outside.csv",
          credits: [
            {
              date: outsideDate,
              amountPaise: 1000000,
              rail: "NEFT",
              utr: "HDFCN26296300002",
              narration: "NEFT CR-LEAP OUTSIDE",
            },
          ],
        };

        const outsideResponse = await callAction(sql, TEST_SHOP_DOMAIN, outsidePayload);
        expect(outsideResponse.status).toBe(400);
        const outsideData = await parseResponse(outsideResponse);
        expect(outsideData.success).toBe(false);
        expect(outsideData.error).toContain("dates outside valid range");
      } finally {
        // Restore pinned time for other tests
        vi.setSystemTime(PINNED_DATE);
      }
    });
  });

  describe("runMatcher integration", () => {
    it("(g) runMatcher is invoked after successful import with inserts", async () => {
      // Clear call tracking
      matcherCalls.length = 0;

      const payload = {
        bank: "HDFC",
        fileName: "matcher-test.csv",
        credits: [
          {
            date: yesterday(),
            amountPaise: 1000000,
            rail: "NEFT",
            utr: "HDFCN26296400001",
            narration: "NEFT CR-MATCHER TEST",
          },
        ],
      };

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response.status).toBe(200);
      
      const data = await parseResponse(response);
      expect(data.counts?.inserted).toBe(1);

      // Verify matcher was called
      expect(matcherCalls.length).toBe(1);
      expect(matcherCalls[0].shopId).toBe(testShopId);
    });
  });

  describe("(h) PII never logged (M6 - no domain in logs)", () => {
    let consoleLogs: string[] = [];
    let consoleErrors: string[] = [];
    let logSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleLogs = [];
      consoleErrors = [];
      logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
        consoleLogs.push(args.map(String).join(" "));
      });
      errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
        consoleErrors.push(args.map(String).join(" "));
      });
    });

    afterEach(() => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    const PII_VALUES = [
      "ACME Corp",
      "Secret Buyer",
      "NEFT CR-ACME CORP-INV001",
      "Payment for invoice 12345",
      "payer@example.com",
      "9876543210",
    ];

    it("M6: logs use safeLog JSON with shopId, not domain (per #174)", async () => {
      const payload = {
        bank: "HDFC",
        fileName: "m6-test.csv",
        credits: [
          {
            date: yesterday(),
            amountPaise: 1000000,
            rail: "NEFT",
            utr: "HDFCN26296500010",
            narration: "NEFT CR-M6 LOG TEST",
          },
        ],
      };

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response.status).toBe(200);

      // Check that logs use safeLog JSON format with "shopId" but NOT .myshopify.com
      const allLogs = [...consoleLogs, ...consoleErrors].join("\n");
      expect(allLogs).toContain('"shopId":');
      expect(allLogs).toContain('"event":"import.');
      expect(allLogs).not.toContain(".myshopify.com");
    });

    it("successful import logs contain no PII", async () => {
      const payload = {
        bank: "HDFC",
        fileName: "pii-test.csv",
        credits: [
          {
            date: yesterday(),
            amountPaise: 1000000,
            rail: "NEFT",
            utr: "HDFCN26296500001",
            payerName: "ACME Corp",
            narration: "NEFT CR-ACME CORP-INV001",
          },
          {
            date: today(),
            amountPaise: 2000000,
            rail: "RTGS",
            utr: "HDFCR26296500002",
            payerName: "Secret Buyer",
            narration: "Payment for invoice 12345",
          },
        ],
      };

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response.status).toBe(200);

      // Check no PII in any log
      for (const log of [...consoleLogs, ...consoleErrors]) {
        for (const pii of PII_VALUES) {
          expect(log).not.toContain(pii);
        }
        // Also check field names aren't being logged with values
        expect(log).not.toMatch(/payerName=\w/);
        expect(log).not.toMatch(/payerText=\w/);
        expect(log).not.toMatch(/narration=\w/);
      }
    });

    it("duplicate import logs contain no PII", async () => {
      const payload = {
        bank: "HDFC",
        fileName: "pii-dupe.csv",
        credits: [
          {
            date: yesterday(),
            amountPaise: 1000000,
            rail: "NEFT",
            utr: "HDFCN26296500003",
            payerName: "ACME Corp",
            narration: "NEFT CR-ACME CORP-INV001",
          },
        ],
      };

      // First import
      await callAction(sql, TEST_SHOP_DOMAIN, payload);
      consoleLogs = [];
      consoleErrors = [];

      // Re-import (duplicate)
      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response.status).toBe(200);

      for (const log of [...consoleLogs, ...consoleErrors]) {
        for (const pii of PII_VALUES) {
          expect(log).not.toContain(pii);
        }
      }
    });

    it("error path logs contain no PII", async () => {
      // Force a DB error by using invalid shop domain (no shop found)
      const payload = {
        bank: "HDFC",
        fileName: "error-test.csv",
        credits: [
          {
            date: yesterday(),
            amountPaise: 1000000,
            rail: "NEFT",
            payerName: "ACME Corp",
            narration: "NEFT CR-ACME CORP-INV001",
          },
        ],
      };

      const response = await callAction(sql, "test-nonexistent-shop.myshopify.com", payload);
      expect(response.status).toBe(404);

      // Verify no PII even in error scenario
      for (const log of [...consoleLogs, ...consoleErrors]) {
        for (const pii of PII_VALUES) {
          expect(log).not.toContain(pii);
        }
      }
    });
  });
});

describe("Import validation (unit tests)", () => {
  const VALID_RAILS = ["NEFT", "RTGS", "IMPS", "UPI", "ACH", "CHEQUE", "OTHER"];

  it("accepts valid import payload", () => {
    const payload = {
      bank: "HDFC",
      fileName: "statement.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: 1000050,
          rail: "NEFT",
          utr: "HDFCN26296000001",
          payerName: "Test Corp",
          narration: "NEFT CR-TEST CORP-INV001",
        },
      ],
    };

    const result = validateImportRequest(payload);
    expect(result.valid).not.toBeNull();
    expect(result.errors).toHaveLength(0);
  });

  it("validates ALL rows (not just first 10)", () => {
    const credits = Array.from({ length: 15 }, (_, i) => ({
      date: yesterday(),
      amountPaise: i === 11 ? -100 : 1000,
      rail: "NEFT",
      narration: `Payment ${i}`,
    }));

    const payload = {
      bank: "HDFC",
      fileName: "statement.csv",
      credits,
    };

    const result = validateImportRequest(payload);
    expect(result.valid).toBeNull();
    expect(result.errors.some(e => e.path.includes("credits.11"))).toBe(true);
  });

  it("caps errors returned at 10 but validates all", () => {
    const credits = Array.from({ length: 20 }, () => ({
      date: "invalid-date",
      amountPaise: -1,
      rail: "INVALID",
      narration: "",
    }));

    const payload = {
      bank: "HDFC",
      fileName: "statement.csv",
      credits,
    };

    const result = validateImportRequest(payload);
    expect(result.valid).toBeNull();
    expect(result.errors.length).toBeLessThanOrEqual(12);
  });

  it("rejects empty credits array", () => {
    const payload = {
      bank: "HDFC",
      fileName: "statement.csv",
      credits: [],
    };

    const result = validateImportRequest(payload);
    expect(result.valid).toBeNull();
  });

  it("rejects oversized payload (>1000 rows) with user-readable error", () => {
    const credits = Array.from({ length: 1001 }, (_, i) => ({
      date: yesterday(),
      amountPaise: 1000,
      rail: "NEFT",
      narration: `Payment ${i}`,
    }));

    const payload = {
      bank: "HDFC",
      fileName: "large-statement.csv",
      credits,
    };

    const result = validateImportRequest(payload);
    expect(result.valid).toBeNull();
    // Check for user-readable error message with row count and limit
    const overLimitError = result.errors.find(e => e.path === "credits" && e.message.includes("1,001"));
    expect(overLimitError).toBeDefined();
    expect(overLimitError?.message).toContain("1,000 rows");
    expect(overLimitError?.message).toContain("Please split your statement");
  });

  it("rejects negative amountPaise", () => {
    const payload = {
      bank: "HDFC",
      fileName: "statement.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: -1000,
          rail: "NEFT",
          narration: "Negative amount",
        },
      ],
    };

    const result = validateImportRequest(payload);
    expect(result.valid).toBeNull();
  });

  it("rejects zero amountPaise", () => {
    const payload = {
      bank: "HDFC",
      fileName: "statement.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: 0,
          rail: "NEFT",
          narration: "Zero amount",
        },
      ],
    };

    const result = validateImportRequest(payload);
    expect(result.valid).toBeNull();
  });

  it("rejects invalid date format", () => {
    const payload = {
      bank: "HDFC",
      fileName: "statement.csv",
      credits: [
        {
          date: "15-01-2025",
          amountPaise: 1000,
          rail: "NEFT",
          narration: "Invalid date",
        },
      ],
    };

    const result = validateImportRequest(payload);
    expect(result.valid).toBeNull();
  });

  it("rejects invalid rail type", () => {
    const payload = {
      bank: "HDFC",
      fileName: "statement.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: 1000,
          rail: "SWIFT",
          narration: "Invalid rail",
        },
      ],
    };

    const result = validateImportRequest(payload);
    expect(result.valid).toBeNull();
  });

  it("rejects invalid bank type", () => {
    const payload = {
      bank: "KOTAK",
      fileName: "statement.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: 1000,
          rail: "NEFT",
          narration: "Test",
        },
      ],
    };

    const result = validateImportRequest(payload);
    expect(result.valid).toBeNull();
  });

  it("rejects missing required fields", () => {
    const payload = {
      bank: "HDFC",
      fileName: "statement.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: 1000,
        },
      ],
    };

    const result = validateImportRequest(payload);
    expect(result.valid).toBeNull();
  });

  it("accepts all valid rail types", () => {
    for (const rail of VALID_RAILS) {
      const payload = {
        bank: "HDFC",
        fileName: "statement.csv",
        credits: [
          {
            date: yesterday(),
            amountPaise: 1000,
            rail,
            narration: `Test ${rail}`,
          },
        ],
      };

      const result = validateImportRequest(payload);
      expect(result.valid).not.toBeNull();
      expect(result.errors).toHaveLength(0);
    }
  });

  it("accepts balancePaise field", () => {
    const payload = {
      bank: "HDFC",
      fileName: "statement.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: 1000,
          balancePaise: 50000,
          rail: "NEFT",
          narration: "Test with balance",
        },
      ],
    };

    const result = validateImportRequest(payload);
    expect(result.valid).not.toBeNull();
    expect(result.valid?.credits[0].balancePaise).toBe(50000);
  });

  it("does not require dedupeKey (server computes it)", () => {
    const payload = {
      bank: "HDFC",
      fileName: "statement.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: 1000,
          rail: "NEFT",
          narration: "No dedupe key",
        },
      ],
    };

    const result = validateImportRequest(payload);
    expect(result.valid).not.toBeNull();
  });
});

describe("MAX_IMPORT_ROWS constant", () => {
  it("is exported and equals 1000", () => {
    expect(MAX_IMPORT_ROWS).toBe(1000);
  });

  it("is used consistently in validation", () => {
    // Test that validation accepts exactly MAX_IMPORT_ROWS
    const exactLimitPayload = {
      bank: "HDFC",
      fileName: "statement.csv",
      credits: Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => ({
        date: yesterday(),
        amountPaise: 1000,
        rail: "NEFT",
        narration: `Payment ${i}`,
      })),
    };

    const exactResult = validateImportRequest(exactLimitPayload);
    expect(exactResult.valid).not.toBeNull();
    expect(exactResult.errors).toHaveLength(0);

    // Test that validation rejects MAX_IMPORT_ROWS + 1
    const overLimitPayload = {
      bank: "HDFC",
      fileName: "statement.csv",
      credits: Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => ({
        date: yesterday(),
        amountPaise: 1000,
        rail: "NEFT",
        narration: `Payment ${i}`,
      })),
    };

    const overResult = validateImportRequest(overLimitPayload);
    expect(overResult.valid).toBeNull();
  });
});

describeWithDb("Bank imports unlimited (T5 - no import limits)", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let TEST_SHOP_DOMAIN: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    const suffix = Date.now().toString(36) + "unlim";
    TEST_SHOP_DOMAIN = `test-import-unlimited-${suffix}.myshopify.com`;

    // Create test shop with free plan
    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, plan_key, plan_cached_at, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'free', NOW(), NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;
      await sql.end();
    }
  });

  beforeEach(async () => {
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
    matcherCalls.length = 0;
  });

  it("imports allowed with PLAN_GATING_ENFORCED=true and many prior imports on free plan", async () => {
    vi.stubEnv("PLAN_GATING_ENFORCED", "true");

    try {
      // Create many BankImport records (far exceeding old free plan limit of 1)
      await sql`
        INSERT INTO "BankImport" ("shopId", bank, "fileName", "rowCount", "createdAt")
        VALUES 
          (${testShopId}, 'hdfc', 'import1.csv', 10, NOW()),
          (${testShopId}, 'hdfc', 'import2.csv', 10, NOW()),
          (${testShopId}, 'hdfc', 'import3.csv', 10, NOW()),
          (${testShopId}, 'hdfc', 'import4.csv', 10, NOW()),
          (${testShopId}, 'hdfc', 'import5.csv', 10, NOW())
      `;

      const payload = {
        bank: "HDFC",
        fileName: "unlimited-import.csv",
        credits: [
          {
            date: yesterday(),
            amountPaise: 1000000,
            rail: "NEFT",
            utr: "HDFCN26296700001",
            narration: "NEFT CR-UNLIMITED IMPORT TEST",
          },
        ],
      };

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response.status).toBe(200);

      const data = await parseResponse(response);
      expect(data.success).toBe(true);
      expect(data.counts?.inserted).toBe(1);

      // Verify total imports is now 6
      const [count] = await sql<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM "BankImport" WHERE "shopId" = ${testShopId}
      `;
      expect(parseInt(count.c, 10)).toBe(6);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("imports allowed with PLAN_GATING_ENFORCED=false on free plan", async () => {
    vi.stubEnv("PLAN_GATING_ENFORCED", "false");

    try {
      // Create prior imports
      await sql`
        INSERT INTO "BankImport" ("shopId", bank, "fileName", "rowCount", "createdAt")
        VALUES 
          (${testShopId}, 'hdfc', 'import1.csv', 10, NOW()),
          (${testShopId}, 'hdfc', 'import2.csv', 10, NOW())
      `;

      const payload = {
        bank: "HDFC",
        fileName: "gating-off-import.csv",
        credits: [
          {
            date: yesterday(),
            amountPaise: 2000000,
            rail: "NEFT",
            utr: "HDFCN26296700002",
            narration: "NEFT CR-GATING OFF TEST",
          },
        ],
      };

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response.status).toBe(200);

      const data = await parseResponse(response);
      expect(data.success).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
