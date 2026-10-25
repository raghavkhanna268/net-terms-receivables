/**
 * S14 Done-when: Server-side rejection with no DB writes.
 *
 * Tests that invalid payloads are rejected and write nothing to the DB.
 * Must run in Sequential DB project due to database interaction.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

// Mock matcher to avoid side effects
vi.mock("~/services/matcher.server", () => ({
  runMatcher: vi.fn(async () => ({
    paymentsProcessed: 0,
    matchesCreated: 0,
    highConfidenceMatches: 0,
    hasMore: false,
  })),
  MAX_PAYMENTS_PER_REQUEST: 100,
}));

import { requestContext } from "~/lib/request-context.server";
import { action } from "../app.imports";

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

describeWithDb("Server-side rejection with no DB writes", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let TEST_SHOP_DOMAIN: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    const suffix = Date.now().toString(36) + "cpl";
    TEST_SHOP_DOMAIN = `test-client-payload-${suffix}.myshopify.com`;

    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
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
  });

  it("invalid payload (empty credits) writes nothing to DB", async () => {
    const payload = {
      bank: "HDFC",
      fileName: "empty.csv",
      credits: [],
    };

    const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
    expect(response.status).toBe(400);

    const [paymentCount] = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM "Payment" WHERE "shopId" = ${testShopId}
    `;
    const [importCount] = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM "BankImport" WHERE "shopId" = ${testShopId}
    `;

    expect(parseInt(paymentCount.c, 10)).toBe(0);
    expect(parseInt(importCount.c, 10)).toBe(0);
  });

  it("invalid payload (oversized) writes nothing to DB", async () => {
    const credits = Array.from({ length: 1001 }, (_, i) => ({
      date: yesterday(),
      amountPaise: 1000,
      rail: "NEFT",
      narration: `Payment ${i}`,
    }));

    const payload = {
      bank: "HDFC",
      fileName: "oversized.csv",
      credits,
    };

    const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
    expect(response.status).toBe(400);

    const [paymentCount] = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM "Payment" WHERE "shopId" = ${testShopId}
    `;
    const [importCount] = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM "BankImport" WHERE "shopId" = ${testShopId}
    `;

    expect(parseInt(paymentCount.c, 10)).toBe(0);
    expect(parseInt(importCount.c, 10)).toBe(0);
  });

  it("invalid payload (negative amount) writes nothing to DB", async () => {
    const payload = {
      bank: "HDFC",
      fileName: "negative.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: -50000,
          rail: "NEFT",
          narration: "NEFT negative test",
        },
      ],
    };

    const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
    expect(response.status).toBe(400);

    const [paymentCount] = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM "Payment" WHERE "shopId" = ${testShopId}
    `;
    expect(parseInt(paymentCount.c, 10)).toBe(0);
  });

  it("invalid payload (wrong rail type) writes nothing to DB", async () => {
    const payload = {
      bank: "HDFC",
      fileName: "wrongrail.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: 50000,
          rail: "SWIFT",
          narration: "SWIFT transfer",
        },
      ],
    };

    const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
    expect(response.status).toBe(400);

    const [paymentCount] = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM "Payment" WHERE "shopId" = ${testShopId}
    `;
    expect(parseInt(paymentCount.c, 10)).toBe(0);
  });

  it("invalid payload (missing narration) writes nothing to DB", async () => {
    const payload = {
      bank: "HDFC",
      fileName: "nonarration.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: 50000,
          rail: "NEFT",
          // Missing narration
        },
      ],
    };

    const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
    expect(response.status).toBe(400);

    const [paymentCount] = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM "Payment" WHERE "shopId" = ${testShopId}
    `;
    expect(parseInt(paymentCount.c, 10)).toBe(0);
  });

  it("extra per-credit keys (direction, rawRow, secretData) are NOT stored in Payment", async () => {
    // This tests that unknown fields passed in credits are not stored in the DB.
    // The validator passes them through (via `as CreditRow[]` cast), but the
    // DB insert only uses known columns.
    const payload = {
      bank: "HDFC",
      fileName: "extra-fields.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: 75000,
          rail: "NEFT",
          narration: "NEFT CR-EXTRA-FIELDS-TEST-MARKER",
          utr: "HDFCN" + Date.now(),
          // Extra fields that should NOT be stored:
          direction: "DR",
          rawRow: [1, 2, 3, 4, "sensitive"],
          secretData: "SHOULD_NOT_BE_STORED",
          fileData: { bytes: [0, 1, 2] },
        },
      ],
    };

    const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
    
    // Import succeeds (extra fields are ignored, not rejected)
    expect(response.status).toBe(200);

    // Verify Payment was created
    const [paymentCount] = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM "Payment" WHERE "shopId" = ${testShopId}
    `;
    expect(parseInt(paymentCount.c, 10)).toBe(1);

    // Verify BankImport was created
    const [importCount] = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM "BankImport" WHERE "shopId" = ${testShopId}
    `;
    expect(parseInt(importCount.c, 10)).toBe(1);

    // Get the stored Payment row and verify no extra fields
    const payments = await sql<Array<Record<string, unknown>>>`
      SELECT * FROM "Payment" WHERE "shopId" = ${testShopId}
    `;
    expect(payments.length).toBe(1);
    const payment = payments[0];

    // Known fields should be present (DB uses 'amount' Decimal, not 'amountPaise')
    // 75000 paise = 750.00 rupees
    expect(Number(payment.amount)).toBe(750);
    expect(payment.rail).toBe("NEFT");
    expect(payment.narration).toBe("NEFT CR-EXTRA-FIELDS-TEST-MARKER");

    // Extra fields should NOT be stored (they're not Payment columns)
    expect(payment).not.toHaveProperty("direction");
    expect(payment).not.toHaveProperty("rawRow");
    expect(payment).not.toHaveProperty("secretData");
    expect(payment).not.toHaveProperty("fileData");

    // Double-check by serializing and searching for the marker string
    const serialized = JSON.stringify(payment);
    expect(serialized).not.toContain("SHOULD_NOT_BE_STORED");
    expect(serialized).not.toContain("sensitive");
  });

  it("top-level extra fields (file, fileData) are NOT stored in BankImport", async () => {
    const payload = {
      bank: "HDFC",
      fileName: "toplevel-extra.csv",
      // Extra top-level fields that should NOT be stored:
      file: "SGVsbG8gV29ybGQ=", // base64 data
      fileData: { byteLength: 1000, data: [0, 1, 2, 3] },
      secretField: "TOP_LEVEL_SECRET",
      credits: [
        {
          date: yesterday(),
          amountPaise: 50000,
          rail: "IMPS",
          narration: "IMPS CR-TOPLEVEL-EXTRA-TEST",
          utr: "IMPS" + Date.now(),
        },
      ],
    };

    const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
    expect(response.status).toBe(200);

    // Get the stored BankImport row
    const imports = await sql<Array<Record<string, unknown>>>`
      SELECT * FROM "BankImport" WHERE "shopId" = ${testShopId}
    `;
    expect(imports.length).toBe(1);
    const bankImport = imports[0];

    // Known fields should be present (bank is stored lowercase)
    expect(bankImport.bank).toBe("hdfc");
    expect(bankImport.fileName).toBe("toplevel-extra.csv");

    // Extra top-level fields should NOT be stored
    expect(bankImport).not.toHaveProperty("file");
    expect(bankImport).not.toHaveProperty("fileData");
    expect(bankImport).not.toHaveProperty("secretField");

    // Verify by serializing
    const serialized = JSON.stringify(bankImport);
    expect(serialized).not.toContain("SGVsbG8gV29ybGQ"); // base64 data
    expect(serialized).not.toContain("TOP_LEVEL_SECRET");
  });
});

describeWithDb("CMS rail upload (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let TEST_SHOP_DOMAIN: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    const suffix = Date.now().toString(36) + "cms";
    TEST_SHOP_DOMAIN = `test-cms-upload-${suffix}.myshopify.com`;

    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
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
  });

  it("CMS rail upload returns 200 and stores rail = 'CMS'", async () => {
    const payload = {
      bank: "ICICI",
      fileName: "cms-test-statement.xls",
      credits: [
        {
          date: yesterday(),
          amountPaise: 2500000,
          rail: "CMS",
          narration: "CMS/ SYNT12345/SYNTHETIC TEST TRADERS",
          payerName: "SYNTHETIC TEST TRADERS",
        },
      ],
    };

    const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
    expect(response.status).toBe(200);

    const data = (await response.json()) as { 
      success: boolean; 
      counts: { inserted: number; duplicates: number; total: number } 
    };
    expect(data.success).toBe(true);
    expect(data.counts.inserted).toBe(1);

    const payments = await sql<Array<{ rail: string; narration: string }>>`
      SELECT rail, narration FROM "Payment" WHERE "shopId" = ${testShopId}
    `;
    expect(payments.length).toBe(1);
    expect(payments[0].rail).toBe("CMS");
    expect(payments[0].narration).toBe("CMS/ SYNT12345/SYNTHETIC TEST TRADERS");
  });
});
