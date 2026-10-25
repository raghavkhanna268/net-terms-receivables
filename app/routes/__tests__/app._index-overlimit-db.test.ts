import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

/**
 * DB-backed tests for app._index over-limit queries.
 *
 * These tests verify that over-limit account queries work correctly
 * against the real database. They are in a separate file to avoid
 * the vi.mock on aging-queries.server in app._index.test.ts.
 *
 * Tests verify:
 * - getOverLimitCount returns correct count of gated accounts with invoices
 * - getOverLimitBuyerLedger returns only gated accounts
 * - getBuyerLedger includes all accounts (gated and non-gated)
 * - Aging totals include all accounts (totals include every account)
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("app._index over-limit queries (DB integration)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-idx-ol";
  const TEST_SHOP_ID = `shop-idx-ol-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-idx-ol-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, timezone, currency, "createdAt", "updatedAt", onboarding_dismissed_at)
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'Asia/Kolkata', 'INR', NOW(), NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, gated_at, "createdAt", "updatedAt")
      VALUES
        (${"acc-active-1-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'COMPANY', ${"co-1-" + TEST_SUFFIX}, ${"loc-1-" + TEST_SUFFIX}, 'Active Account 1', NULL, NOW(), NOW()),
        (${"acc-active-2-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'COMPANY', ${"co-2-" + TEST_SUFFIX}, ${"loc-2-" + TEST_SUFFIX}, 'Active Account 2', NULL, NOW(), NOW()),
        (${"acc-gated-1-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'COMPANY', ${"co-3-" + TEST_SUFFIX}, ${"loc-3-" + TEST_SUFFIX}, 'Gated Account 1', NOW(), NOW(), NOW()),
        (${"acc-gated-2-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'COMPANY', ${"co-4-" + TEST_SUFFIX}, ${"loc-4-" + TEST_SUFFIX}, 'Gated Account 2', NOW(), NOW(), NOW())
    `;

    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, "issuedAt", status, "createdAt", "updatedAt")
      VALUES
        (${"inv-active-1-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, ${"acc-active-1-" + TEST_SUFFIX}, ${"gid://shopify/Order/active1-" + TEST_SUFFIX}, 'INV-001', 1000.00, 1000.00, NOW(), 'open', NOW(), NOW()),
        (${"inv-active-2-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, ${"acc-active-2-" + TEST_SUFFIX}, ${"gid://shopify/Order/active2-" + TEST_SUFFIX}, 'INV-002', 2000.00, 2000.00, NOW(), 'open', NOW(), NOW()),
        (${"inv-gated-1-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, ${"acc-gated-1-" + TEST_SUFFIX}, ${"gid://shopify/Order/gated1-" + TEST_SUFFIX}, 'INV-003', 3000.00, 3000.00, NOW(), 'open', NOW(), NOW()),
        (${"inv-gated-2-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, ${"acc-gated-2-" + TEST_SUFFIX}, ${"gid://shopify/Order/gated2-" + TEST_SUFFIX}, 'INV-004', 4000.00, 4000.00, NOW(), 'open', NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  it("getOverLimitCount returns correct count of gated accounts", async () => {
    const { getOverLimitCount } = await import("../app._index");
    const count = await getOverLimitCount(sql, TEST_SHOP_ID);
    expect(count).toBe(2);
  });

  it("getOverLimitBuyerLedger returns only gated accounts with invoices", async () => {
    const { getOverLimitBuyerLedger } = await import("../app._index");

    const result = await getOverLimitBuyerLedger(sql, TEST_SHOP_ID, new Date(), {
      limit: 20,
      offset: 0,
      sortBy: "outstanding",
      sortOrder: "desc",
    });

    expect(result.rows.length).toBe(2);
    expect(result.totalCount).toBe(2);
    expect(result.rows.every(r => r.is_gated)).toBe(true);
    expect(result.rows.every(r => r.buyer_name.includes("Gated"))).toBe(true);

    const amounts = result.rows.map(r => parseInt(r.outstanding_paise, 10));
    expect(amounts).toContain(300000);
    expect(amounts).toContain(400000);
  });

  it("getOverLimitBuyerLedger respects sort order", async () => {
    const { getOverLimitBuyerLedger } = await import("../app._index");

    const descResult = await getOverLimitBuyerLedger(sql, TEST_SHOP_ID, new Date(), {
      limit: 20,
      offset: 0,
      sortBy: "outstanding",
      sortOrder: "desc",
    });
    expect(descResult.rows[0].outstanding_paise).toBe("400000");

    const ascResult = await getOverLimitBuyerLedger(sql, TEST_SHOP_ID, new Date(), {
      limit: 20,
      offset: 0,
      sortBy: "outstanding",
      sortOrder: "asc",
    });
    expect(ascResult.rows[0].outstanding_paise).toBe("300000");
  });

  it("getOverLimitBuyerLedger respects pagination", async () => {
    const { getOverLimitBuyerLedger } = await import("../app._index");

    const page1 = await getOverLimitBuyerLedger(sql, TEST_SHOP_ID, new Date(), {
      limit: 1,
      offset: 0,
      sortBy: "outstanding",
      sortOrder: "desc",
    });
    expect(page1.rows.length).toBe(1);
    expect(page1.totalCount).toBe(2);

    const page2 = await getOverLimitBuyerLedger(sql, TEST_SHOP_ID, new Date(), {
      limit: 1,
      offset: 1,
      sortBy: "outstanding",
      sortOrder: "desc",
    });
    expect(page2.rows.length).toBe(1);
    expect(page2.totalCount).toBe(2);
    expect(page1.rows[0].buyer_account_id).not.toBe(page2.rows[0].buyer_account_id);
  });

  it("gated account with no open invoice is excluded from both count and list", async () => {
    const { getOverLimitCount, getOverLimitBuyerLedger } = await import("../app._index");

    const GATED_NO_INVOICE_ID = `acc-gated-noinv-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, gated_at, "createdAt", "updatedAt")
      VALUES (${GATED_NO_INVOICE_ID}, ${TEST_SHOP_ID}, 'COMPANY', ${"co-noinv-" + TEST_SUFFIX}, ${"loc-noinv-" + TEST_SUFFIX}, 'Gated Account No Invoice', NOW(), NOW(), NOW())
    `;

    try {
      const count = await getOverLimitCount(sql, TEST_SHOP_ID);
      expect(count).toBe(2);

      const result = await getOverLimitBuyerLedger(sql, TEST_SHOP_ID, new Date(), {
        limit: 20,
        offset: 0,
        sortBy: "outstanding",
        sortOrder: "desc",
      });
      expect(result.rows.length).toBe(2);
      expect(result.totalCount).toBe(2);

      const noInvoiceRow = result.rows.find(r => r.buyer_account_id === GATED_NO_INVOICE_ID);
      expect(noInvoiceRow).toBeUndefined();
    } finally {
      await sql`DELETE FROM "BuyerAccount" WHERE id = ${GATED_NO_INVOICE_ID}`;
    }
  });

  it("aging totals include gated accounts (totals include all accounts)", async () => {
    const { getOverLimitBuyerLedger } = await import("../app._index");
    const { getBuyerLedger } = await import("~/lib/aging-queries.server");

    const allAccounts = await getBuyerLedger(sql, TEST_SHOP_ID, new Date(), {
      limit: 100,
      offset: 0,
      sortBy: "outstanding",
      sortOrder: "desc",
    });

    const gatedAccounts = await getOverLimitBuyerLedger(sql, TEST_SHOP_ID, new Date(), {
      limit: 100,
      offset: 0,
      sortBy: "outstanding",
      sortOrder: "desc",
    });

    expect(allAccounts.totalCount).toBe(4);
    expect(gatedAccounts.totalCount).toBe(2);

    const allTotal = allAccounts.rows.reduce(
      (sum, r) => sum + BigInt(r.outstanding_paise), 0n
    );
    const gatedTotal = gatedAccounts.rows.reduce(
      (sum, r) => sum + BigInt(r.outstanding_paise), 0n
    );

    expect(allTotal).toBeGreaterThan(gatedTotal);
    expect(gatedTotal).toBe(700000n);
    expect(allTotal).toBe(1000000n);
  });
});
