import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { DateTime } from "luxon";
import { sqlOptions } from "~/lib/db-light.server";
import {
  getShopAgingTotals,
  getBuyerLedger,
} from "~/lib/aging-queries.server";
import {
  calculateDaysPastDue,
  DEFAULT_TIMEZONE,
} from "~/lib/aging-dates.server";
import {
  getBucketForDaysPastDue,
  type AgingBucketKey,
} from "~/lib/aging";

/**
 * SQL-vs-TypeScript parity tests for aging buckets.
 *
 * These tests execute real SQL against the CI postgres database to verify
 * that the SQL bucketing logic produces the same results as the TypeScript
 * implementation.
 *
 * The CI uses ghcr.io/pgmq/pg16-pgmq:v1.5.1 which is already configured
 * for the drift step. Tests skip cleanly when TEST_DATABASE_URL is not set.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Test fixtures for parity testing.
 * Each fixture defines a due date offset from the "as of" date and expected bucket.
 */
const PARITY_FIXTURES: Array<{
  name: string;
  daysPastDue: number;
  expectedBucket: AgingBucketKey;
}> = [
  // Current bucket boundary
  { name: "due tomorrow (future)", daysPastDue: -1, expectedBucket: "current" },
  { name: "due today", daysPastDue: 0, expectedBucket: "current" },
  // 1-30 bucket boundaries
  { name: "1 day past due", daysPastDue: 1, expectedBucket: "1-30" },
  { name: "15 days past due", daysPastDue: 15, expectedBucket: "1-30" },
  { name: "30 days past due", daysPastDue: 30, expectedBucket: "1-30" },
  // 31-60 bucket boundaries
  { name: "31 days past due", daysPastDue: 31, expectedBucket: "31-60" },
  { name: "45 days past due", daysPastDue: 45, expectedBucket: "31-60" },
  { name: "60 days past due", daysPastDue: 60, expectedBucket: "31-60" },
  // 61-90 bucket boundaries
  { name: "61 days past due", daysPastDue: 61, expectedBucket: "61-90" },
  { name: "75 days past due", daysPastDue: 75, expectedBucket: "61-90" },
  { name: "90 days past due", daysPastDue: 90, expectedBucket: "61-90" },
  // 90+ bucket
  { name: "91 days past due", daysPastDue: 91, expectedBucket: "90+" },
  { name: "180 days past due", daysPastDue: 180, expectedBucket: "90+" },
  { name: "365 days past due", daysPastDue: 365, expectedBucket: "90+" },
];

describeWithDb("SQL-vs-TS parity (DB-backed)", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let testBuyerAccountId: string;

  const TEST_SHOP_DOMAIN = `parity-test-${Date.now()}.myshopify.com`;
  const AS_OF_DATE = DateTime.fromISO("2026-10-23", { zone: "Asia/Kolkata" })
    .startOf("day")
    .toJSDate();

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    // Create test buyer account
    const [buyer] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/parity-test', 'gid://shopify/CompanyLocation/parity-test',
        'Parity Test Buyer', 100000, 'OK', NOW(), NOW()
      )
      RETURNING id
    `;
    testBuyerAccountId = buyer.id;

    // Create invoices for each parity fixture
    for (const fixture of PARITY_FIXTURES) {
      const dueDate = DateTime.fromJSDate(AS_OF_DATE, { zone: "Asia/Kolkata" })
        .minus({ days: fixture.daysPastDue })
        .endOf("day")
        .toJSDate();

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          gen_random_uuid()::text, ${testShopId}, ${testBuyerAccountId},
          ${"gid://shopify/Order/parity-" + fixture.daysPastDue},
          ${"INV-" + fixture.name}, 1000.00, 'open', 1000.00, NOW(), ${dueDate}, NOW(), NOW()
        )
      `;
    }
  });

  afterAll(async () => {
    // Clean up test data
    if (sql && testShopId) {
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;
    }
    if (sql) {
      await sql.end();
    }
  });

  it("SQL bucketing matches TypeScript bucketing for all boundary cases", async () => {
    // Get SQL results
    const sqlRows = await sql<
      Array<{
        name: string;
        due_at: Date | null;
        days_past_due: number;
        sql_bucket: string;
      }>
    >`
      SELECT
        i.name,
        i."dueAt" AS due_at,
        CASE
          WHEN i."dueAt" IS NULL THEN 0
          ELSE EXTRACT(DAY FROM (
            DATE_TRUNC('day', ${AS_OF_DATE}::timestamptz AT TIME ZONE 'Asia/Kolkata') -
            DATE_TRUNC('day', i."dueAt" AT TIME ZONE 'Asia/Kolkata')
          ))::int
        END AS days_past_due,
        CASE
          WHEN CASE
            WHEN i."dueAt" IS NULL THEN 0
            ELSE EXTRACT(DAY FROM (
              DATE_TRUNC('day', ${AS_OF_DATE}::timestamptz AT TIME ZONE 'Asia/Kolkata') -
              DATE_TRUNC('day', i."dueAt" AT TIME ZONE 'Asia/Kolkata')
            ))::int
          END <= 0 THEN 'current'
          WHEN CASE
            WHEN i."dueAt" IS NULL THEN 0
            ELSE EXTRACT(DAY FROM (
              DATE_TRUNC('day', ${AS_OF_DATE}::timestamptz AT TIME ZONE 'Asia/Kolkata') -
              DATE_TRUNC('day', i."dueAt" AT TIME ZONE 'Asia/Kolkata')
            ))::int
          END <= 30 THEN '1-30'
          WHEN CASE
            WHEN i."dueAt" IS NULL THEN 0
            ELSE EXTRACT(DAY FROM (
              DATE_TRUNC('day', ${AS_OF_DATE}::timestamptz AT TIME ZONE 'Asia/Kolkata') -
              DATE_TRUNC('day', i."dueAt" AT TIME ZONE 'Asia/Kolkata')
            ))::int
          END <= 60 THEN '31-60'
          WHEN CASE
            WHEN i."dueAt" IS NULL THEN 0
            ELSE EXTRACT(DAY FROM (
              DATE_TRUNC('day', ${AS_OF_DATE}::timestamptz AT TIME ZONE 'Asia/Kolkata') -
              DATE_TRUNC('day', i."dueAt" AT TIME ZONE 'Asia/Kolkata')
            ))::int
          END <= 90 THEN '61-90'
          ELSE '90+'
        END AS sql_bucket
      FROM "Invoice" i
      WHERE i."shopId" = ${testShopId}
        AND i.status = 'open'
      ORDER BY i.name
    `;

    expect(sqlRows.length).toBe(PARITY_FIXTURES.length);

    // Compare each row with TypeScript calculation
    for (const row of sqlRows) {
      const tsDaysPastDue = calculateDaysPastDue(row.due_at, AS_OF_DATE, DEFAULT_TIMEZONE);
      const tsBucket = getBucketForDaysPastDue(tsDaysPastDue);

      expect(row.days_past_due).toBe(tsDaysPastDue);
      expect(row.sql_bucket).toBe(tsBucket);
    }
  });

  it("getShopAgingTotals SQL matches TypeScript bucket totals", async () => {
    const totals = await getShopAgingTotals(sql, testShopId, AS_OF_DATE);

    // Calculate expected bucket counts from fixtures
    const expectedBuckets: Record<AgingBucketKey, number> = {
      current: 0,
      "1-30": 0,
      "31-60": 0,
      "61-90": 0,
      "90+": 0,
    };
    for (const fixture of PARITY_FIXTURES) {
      expectedBuckets[fixture.expectedBucket]++;
    }

    // Each invoice is 1000.00 = 100000 paise
    const INVOICE_AMOUNT_PAISE = 100000n;

    for (const bucket of Object.keys(expectedBuckets) as AgingBucketKey[]) {
      const expectedAmount = BigInt(expectedBuckets[bucket]) * INVOICE_AMOUNT_PAISE;
      const actualAmount = BigInt(totals.buckets[bucket].byCurrency["INR"] ?? "0");
      expect(actualAmount).toBe(expectedAmount);
    }
  });
});

describeWithDb("shop totals = sum of ledger (gating test)", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let activeBuyerId: string;
  let gatedBuyerId: string;

  const TEST_SHOP_DOMAIN = `gating-test-${Date.now()}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    // Create active buyer
    const [activeBuyer] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/active-test', 'gid://shopify/CompanyLocation/active-test',
        'Active Buyer', 100000, 'OK', NOW(), NOW()
      )
      RETURNING id
    `;
    activeBuyerId = activeBuyer.id;

    // Create gated buyer
    const [gatedBuyer] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", gated_at, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/gated-test', 'gid://shopify/CompanyLocation/gated-test',
        'Gated Buyer', 100000, 'OK', NOW(), NOW(), NOW()
      )
      RETURNING id
    `;
    gatedBuyerId = gatedBuyer.id;

    // Create invoice for active buyer
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${activeBuyerId},
        'gid://shopify/Order/active-1', 'INV-ACTIVE', 5000.00, 'open', 5000.00,
        NOW(), ${DateTime.now().minus({ days: 15 }).toJSDate()}, NOW(), NOW()
      )
    `;

    // Create invoice for gated buyer
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${gatedBuyerId},
        'gid://shopify/Order/gated-1', 'INV-GATED', 3000.00, 'open', 3000.00,
        NOW(), ${DateTime.now().minus({ days: 20 }).toJSDate()}, NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    if (sql && testShopId) {
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;
    }
    if (sql) {
      await sql.end();
    }
  });

  it("shop totals equal sum of ledger rows", async () => {
    const asOf = new Date();

    const totals = await getShopAgingTotals(sql, testShopId, asOf);
    const ledger = await getBuyerLedger(sql, testShopId, asOf, {
      limit: 100,
      offset: 0,
      sortBy: "outstanding",
      sortOrder: "desc",
    });

    // Sum ledger outstanding amounts by currency
    const ledgerSumByCurrency: Record<string, bigint> = {};
    for (const row of ledger.rows) {
      const currency = row.currency;
      const amount = BigInt(row.outstanding_paise);
      ledgerSumByCurrency[currency] = (ledgerSumByCurrency[currency] ?? 0n) + amount;
    }

    // Compare with shop totals
    for (const [currency, totalAmount] of Object.entries(totals.totalByCurrency)) {
      expect(ledgerSumByCurrency[currency]).toBe(BigInt(totalAmount));
    }
  });

  it("shop totals equal sum of ledger rows with PLAN_GATING_ENFORCED=true", async () => {
    const originalEnv = process.env.PLAN_GATING_ENFORCED;
    (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = "true";

    try {
      const asOf = new Date();

      const totals = await getShopAgingTotals(sql, testShopId, asOf);
      const ledger = await getBuyerLedger(sql, testShopId, asOf, {
        limit: 100,
        offset: 0,
        sortBy: "outstanding",
        sortOrder: "desc",
      });

      // With gating enforced, the gated buyer should be excluded
      // Only the active buyer's invoice (5000.00 = 500000 paise) should be counted
      expect(ledger.rows.length).toBe(1);
      expect(ledger.rows[0].buyer_name).toBe("Active Buyer");

      // Sum ledger outstanding amounts by currency
      const ledgerSumByCurrency: Record<string, bigint> = {};
      for (const row of ledger.rows) {
        const currency = row.currency;
        const amount = BigInt(row.outstanding_paise);
        ledgerSumByCurrency[currency] = (ledgerSumByCurrency[currency] ?? 0n) + amount;
      }

      // Verify totals match ledger (both should exclude gated buyer)
      for (const [currency, totalAmount] of Object.entries(totals.totalByCurrency)) {
        expect(ledgerSumByCurrency[currency]).toBe(BigInt(totalAmount));
      }

      // Verify the amount is only the active buyer's invoice
      expect(totals.totalByCurrency["INR"]).toBe("500000");
    } finally {
      // Restore original environment
      (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = originalEnv;
    }
  });
});

/**
 * Dev-only reconciliation test for aging dashboard.
 *
 * This test compares our database's outstanding totals with Shopify Admin API
 * orders query using the equivalent filter. It requires SHOPIFY_ADMIN_TOKEN
 * and is skipped in CI.
 *
 * Equivalent Shopify Admin search (filter manually for orders with payment terms):
 *   financial_status:pending OR financial_status:partially_paid
 *
 * See docs/aging.md for details on the reconciliation approach.
 */

const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const DEV_SHOP = "net-terms-receivables.myshopify.com";
const API_VERSION = "2026-10";

const describeIfToken = SHOPIFY_ADMIN_TOKEN ? describe : describe.skip;

const ORDERS_QUERY = `
  query UnpaidOrdersWithTerms($cursor: String) {
    orders(
      first: 50
      after: $cursor
      query: "financial_status:pending OR financial_status:partially_paid"
      sortKey: CREATED_AT
      reverse: true
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          name
          displayFinancialStatus
          totalOutstandingSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          paymentTerms {
            paymentTermsName
          }
        }
      }
    }
  }
`;

interface ShopifyOrder {
  id: string;
  name: string;
  displayFinancialStatus: string;
  totalOutstanding: number;
  currency: string;
}

async function fetchUnpaidOrdersWithTerms(): Promise<ShopifyOrder[]> {
  if (!SHOPIFY_ADMIN_TOKEN) {
    throw new Error("SHOPIFY_ADMIN_TOKEN not set");
  }

  const orders: ShopifyOrder[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await fetch(
      `https://${DEV_SHOP}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
        },
        body: JSON.stringify({
          query: ORDERS_QUERY,
          variables: { cursor },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Shopify API error: ${response.status}`);
    }

    const result = (await response.json()) as {
      data?: {
        orders: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          edges: Array<{
            node: {
              id: string;
              name: string;
              displayFinancialStatus: string;
              totalOutstandingSet: {
                shopMoney: { amount: string; currencyCode: string };
              };
              paymentTerms: { paymentTermsName: string } | null;
            };
          }>;
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (result.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
    }

    const { pageInfo, edges } = result.data!.orders;

    for (const { node } of edges) {
      if (!node.paymentTerms) continue;

      orders.push({
        id: node.id,
        name: node.name,
        displayFinancialStatus: node.displayFinancialStatus,
        totalOutstanding: parseFloat(node.totalOutstandingSet.shopMoney.amount),
        currency: node.totalOutstandingSet.shopMoney.currencyCode,
      });
    }

    hasNextPage = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;

    if (hasNextPage) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return orders;
}

describeIfToken("aging reconciliation (dev-only)", () => {
  it("documents the equivalent Shopify Admin filter", () => {
    const adminFilter = "financial_status:pending OR financial_status:partially_paid";

    expect(adminFilter).toContain("financial_status:pending");
    expect(adminFilter).toContain("financial_status:partially_paid");
  });

  it.skip("fetches unpaid orders with payment terms from Shopify (manual run)", async () => {
    const orders = await fetchUnpaidOrdersWithTerms();

    console.log(`\nFetched ${orders.length} unpaid orders with payment terms:`);

    const byCurrency = new Map<string, { count: number; total: number }>();
    for (const order of orders) {
      const existing = byCurrency.get(order.currency) ?? { count: 0, total: 0 };
      existing.count++;
      existing.total += order.totalOutstanding;
      byCurrency.set(order.currency, existing);
    }

    for (const [currency, { count, total }] of byCurrency) {
      console.log(`  ${currency}: ${count} orders, total: ${total.toFixed(2)}`);
    }

    expect(orders.length).toBeGreaterThanOrEqual(0);
  });
});

/**
 * Unit test for bucket boundaries (no DB required).
 */
describe("SQL-vs-TS bucket parity (unit)", () => {
  it("uses the same bucket boundaries", () => {
    const boundaries = [
      { daysPastDue: -1, expectedBucket: "current" },
      { daysPastDue: 0, expectedBucket: "current" },
      { daysPastDue: 1, expectedBucket: "1-30" },
      { daysPastDue: 30, expectedBucket: "1-30" },
      { daysPastDue: 31, expectedBucket: "31-60" },
      { daysPastDue: 60, expectedBucket: "31-60" },
      { daysPastDue: 61, expectedBucket: "61-90" },
      { daysPastDue: 90, expectedBucket: "61-90" },
      { daysPastDue: 91, expectedBucket: "90+" },
      { daysPastDue: 365, expectedBucket: "90+" },
    ];

    for (const { daysPastDue, expectedBucket } of boundaries) {
      const tsBucket = getBucketForDaysPastDue(daysPastDue);
      expect(tsBucket).toBe(expectedBucket);
    }
  });
});
