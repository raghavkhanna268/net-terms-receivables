/**
 * DB-backed integration tests for credit-status persistence.
 * Uses the CI pgmq Postgres service.
 *
 * This file is separate from credit-status.test.ts to avoid vitest
 * mock hoisting issues - these tests need the real implementation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sqlOptions, type Sql } from "~/lib/db-light.server";
import { getCreditStatusDisplay, getCompanyTotals } from "../credit-status.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("credit-status DB integration", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-credit-db";
  const TEST_SHOP_ID = `shop-credit-db-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `credit-db-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-credit-db-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${"loc-" + TEST_SUFFIX},
        'Test Credit Account', 100000.00, 'OK', false, NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  it("getCreditStatusDisplay returns correct data from DB", async () => {
    const status = await getCreditStatusDisplay(sql as unknown as Sql, TEST_ACCOUNT_ID);

    expect(status).not.toBeNull();
    expect(status?.creditLimitAmount).toBe(100000);
    expect(status?.currency).toBe("INR");
    expect(status?.holdState).toBe("OK");
    expect(status?.isOnHold).toBe(false);
  });

  it("exposure calculation includes open invoices", async () => {
    const invoiceId = `inv-db-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", name, total, outstanding,
        status, "issuedAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID},
        '#TEST-DB-1', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW()
      )
    `;

    try {
      const status = await getCreditStatusDisplay(sql as unknown as Sql, TEST_ACCOUNT_ID);

      expect(status).not.toBeNull();
      expect(status?.exposurePaise.toString()).toBe("5000000");
      expect(status?.utilizationPercent).toBe(50);
    } finally {
      await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
    }
  });

  it("available credit is limit minus exposure", async () => {
    const invoiceId = `inv-avail-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", name, total, outstanding,
        status, "issuedAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID},
        '#TEST-AVAIL-1', 30000.00, 30000.00, 'open', NOW(), NOW(), NOW()
      )
    `;

    try {
      const status = await getCreditStatusDisplay(sql as unknown as Sql, TEST_ACCOUNT_ID);

      expect(status).not.toBeNull();
      // Limit: 100000.00 = 10000000 paise
      // Exposure: 30000.00 = 3000000 paise
      // Available: 7000000 paise
      expect(status?.availableCreditPaise?.toString()).toBe("7000000");
    } finally {
      await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
    }
  });

  it("detects over-limit condition", async () => {
    const invoiceId = `inv-over-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", name, total, outstanding,
        status, "issuedAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID},
        '#TEST-OVER-1', 150000.00, 150000.00, 'open', NOW(), NOW(), NOW()
      )
    `;

    try {
      const status = await getCreditStatusDisplay(sql as unknown as Sql, TEST_ACCOUNT_ID);

      expect(status).not.toBeNull();
      expect(status?.isOverLimit).toBe(true);
      expect(status?.isOnHold).toBe(true);
    } finally {
      await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
    }
  });

  it("detects overdue invoices", async () => {
    const invoiceId = `inv-due-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID},
        '#TEST-DUE-1', 1000.00, 1000.00, 'open', 
        NOW() - INTERVAL '30 days',
        NOW() - INTERVAL '10 days',
        NOW(), NOW()
      )
    `;

    try {
      const status = await getCreditStatusDisplay(sql as unknown as Sql, TEST_ACCOUNT_ID);

      expect(status).not.toBeNull();
      expect(status?.isOverdue).toBe(true);
      expect(status?.isOnHold).toBe(true);
    } finally {
      await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
    }
  });

  it("excludes paid invoices from exposure (status semantics per #88)", async () => {
    const openInvoiceId = `inv-open-${TEST_SUFFIX}`;
    const paidInvoiceId = `inv-paid-${TEST_SUFFIX}`;
    const cancelledInvoiceId = `inv-cancel-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", name, total, outstanding,
        status, "issuedAt", "createdAt", "updatedAt"
      )
      VALUES 
        (${openInvoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID},
         '#OPEN-1', 10000.00, 10000.00, 'open', NOW(), NOW(), NOW()),
        (${paidInvoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID},
         '#PAID-1', 20000.00, 0.00, 'paid', NOW(), NOW(), NOW()),
        (${cancelledInvoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID},
         '#CANCEL-1', 30000.00, 30000.00, 'cancelled', NOW(), NOW(), NOW())
    `;

    try {
      const status = await getCreditStatusDisplay(sql as unknown as Sql, TEST_ACCOUNT_ID);

      expect(status).not.toBeNull();
      // Only the open invoice with outstanding > 0 should count
      // 10000.00 = 1000000 paise
      expect(status?.exposurePaise.toString()).toBe("1000000");
    } finally {
      await sql`DELETE FROM "Invoice" WHERE id IN (${openInvoiceId}, ${paidInvoiceId}, ${cancelledInvoiceId})`;
    }
  });
});

describeWithDb("company totals rollup", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-company";
  const TEST_SHOP_ID = `shop-company-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `company-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_COMPANY_ID = `co-${TEST_SUFFIX}`;
  const TEST_LOCATION_1_ID = `acc-loc1-${TEST_SUFFIX}`;
  const TEST_LOCATION_2_ID = `acc-loc2-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    // Location 1: 100k limit, OK status
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_LOCATION_1_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${TEST_COMPANY_ID}, ${"gid://shopify/CompanyLocation/1-" + TEST_SUFFIX},
        'Location 1', 100000.00, 'OK', false, NOW(), NOW()
      )
    `;

    // Location 2: 50k limit, on HOLD
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_LOCATION_2_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${TEST_COMPANY_ID}, ${"gid://shopify/CompanyLocation/2-" + TEST_SUFFIX},
        'Location 2', 50000.00, 'HELD', false, NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  it("rolls up totals from two locations with one on hold", async () => {
    // Add invoices to each location
    const inv1 = `inv-loc1-${TEST_SUFFIX}`;
    const inv2 = `inv-loc2-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", name, total, outstanding,
        status, "issuedAt", "createdAt", "updatedAt"
      )
      VALUES 
        (${inv1}, ${TEST_SHOP_ID}, ${TEST_LOCATION_1_ID},
         '#LOC1-1', 30000.00, 30000.00, 'open', NOW(), NOW(), NOW()),
        (${inv2}, ${TEST_SHOP_ID}, ${TEST_LOCATION_2_ID},
         '#LOC2-1', 20000.00, 20000.00, 'open', NOW(), NOW(), NOW())
    `;

    try {
      const totals = await getCompanyTotals(
        sql as unknown as Sql,
        TEST_COMPANY_ID,
        TEST_SHOP_ID
      );

      expect(totals).not.toBeNull();
      expect(totals?.locationCount).toBe(2);
      expect(totals?.locationsOnHold).toBe(1);
      // Total limit: 100k + 50k = 150k = 15000000 paise
      expect(totals?.totalLimitPaise?.toString()).toBe("15000000");
      // Total exposure: 30k + 20k = 50k = 5000000 paise
      expect(totals?.totalExposurePaise.toString()).toBe("5000000");
      // Total available: 15M - 5M = 10M paise
      expect(totals?.totalAvailablePaise?.toString()).toBe("10000000");
      expect(totals?.currency).toBe("INR");
      expect(totals?.hasMixedCurrencies).toBe(false);
    } finally {
      await sql`DELETE FROM "Invoice" WHERE id IN (${inv1}, ${inv2})`;
    }
  });

  it("returns null totalLimitPaise when any location has no limit", async () => {
    // Add a third location with no limit
    const noLimitLocationId = `acc-nolimit-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "createdAt", "updatedAt"
      )
      VALUES (
        ${noLimitLocationId}, ${TEST_SHOP_ID}, 'COMPANY',
        ${TEST_COMPANY_ID}, ${"gid://shopify/CompanyLocation/3-" + TEST_SUFFIX},
        'Location No Limit', NULL, 'OK', false, NOW(), NOW()
      )
    `;

    try {
      const totals = await getCompanyTotals(
        sql as unknown as Sql,
        TEST_COMPANY_ID,
        TEST_SHOP_ID
      );

      expect(totals).not.toBeNull();
      expect(totals?.locationCount).toBe(3);
      // When any location has no limit, total limit is null
      expect(totals?.totalLimitPaise).toBeNull();
      expect(totals?.totalAvailablePaise).toBeNull();
    } finally {
      await sql`DELETE FROM "BuyerAccount" WHERE id = ${noLimitLocationId}`;
    }
  });
});
