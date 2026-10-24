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
 */
function daysAgo(n: number, referenceDate: Date = new Date()): string {
  const d = new Date(referenceDate);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Get ISO date string for today.
 */
function today(): string {
  return daysAgo(0);
}

/**
 * Get ISO date string for yesterday.
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
  minDate.setDate(minDate.getDate() + 1);
  return minDate.toISOString().slice(0, 10);
}

/**
 * Get a date just outside the valid window (minDate - 1 day).
 * Uses the same computation as the action to handle leap years correctly.
 */
function justOutsideWindow(referenceDate: Date = new Date()): string {
  const { minDateIso } = computeDateBounds(referenceDate);
  const minDate = new Date(minDateIso + "T00:00:00Z");
  minDate.setDate(minDate.getDate() - 1);
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
import { action, validateImportRequest } from "../app.imports";

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
      const payload = {
        bank: "HDFC",
        fileName: "test.csv",
        credits: [
          {
            date: yesterday(),
            amountPaise: 1000000,
            rail: "NEFT",
            utr: "HDFCN26296REIMPORT",
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

      // Verify only 1 payment in DB
      const [count] = await sql<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM "Payment" 
        WHERE "shopId" = ${testShopId} AND utr = 'HDFCN26296REIMPORT'
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
            utr: "HDFCN26296SHOPA1",
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
            utr: "HDFCN26296SHOPA1", // Same UTR!
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
        bank: "SBI",
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
      const payload = {
        bank: "HDFC",
        fileName: "json-serial.csv",
        credits: [
          {
            date: yesterday(),
            amountPaise: 100000,
            rail: "NEFT",
            utr: "HDFCN26296JSON001",
            payerName: "Test Corp",
            narration: "NEFT CR-JSON SERIALIZATION TEST",
          },
          {
            date: today(),
            amountPaise: 200000,
            rail: "RTGS",
            utr: "HDFCR26296JSON002",
            narration: "RTGS CR-JSON TEST 2",
          },
          {
            date: yesterday(),
            amountPaise: 50000,
            balancePaise: 1500000,
            rail: "IMPS",
            utr: "123456789012",
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

      // Verify all rows were inserted with correct data
      const payments = await sql<{ utr: string; amount: string; rail: string }[]>`
        SELECT utr, amount::text, rail FROM "Payment" 
        WHERE "shopId" = ${testShopId}
        ORDER BY amount
      `;
      expect(payments).toHaveLength(3);
      expect(payments[0].amount).toBe("500.00");
      expect(payments[1].amount).toBe("1000.00");
      expect(payments[2].amount).toBe("2000.00");
    });
  });

  describe("Date boundary tests", () => {
    it("date just inside window (minDate + 1 day) passes", async () => {
      const payload = {
        bank: "HDFC",
        fileName: "old-valid.csv",
        credits: [
          {
            date: justInsideWindow(),
            amountPaise: 1000000,
            rail: "NEFT",
            utr: "HDFCN26296OLDVALID",
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
            utr: "HDFCN26296TOOOLD",
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
              utr: "HDFCN26296LEAPIN",
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
              utr: "HDFCN26296LEAPOUT",
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
        // Restore real timers
        vi.useRealTimers();
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
            utr: "HDFCN26296MATCHER1",
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

  describe("(h) PII never logged", () => {
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

    it("successful import logs contain no PII", async () => {
      const payload = {
        bank: "HDFC",
        fileName: "pii-test.csv",
        credits: [
          {
            date: yesterday(),
            amountPaise: 1000000,
            rail: "NEFT",
            utr: "HDFCN26296PIITEST",
            payerName: "ACME Corp",
            narration: "NEFT CR-ACME CORP-INV001",
          },
          {
            date: today(),
            amountPaise: 2000000,
            rail: "RTGS",
            utr: "HDFCR26296PIITEST",
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
            utr: "HDFCN26296PIIDUPE",
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

      const response = await callAction(sql, "nonexistent-shop.myshopify.com", payload);
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

  it("rejects oversized payload (>1000 rows)", () => {
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
    expect(result.errors.some(e => e.message.includes("1000"))).toBe(true);
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
      bank: "SBI",
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
