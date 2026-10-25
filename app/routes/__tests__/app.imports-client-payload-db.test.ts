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
});
