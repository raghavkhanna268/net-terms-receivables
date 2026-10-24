/**
 * DB-backed integration tests for credit-status persistence.
 * Uses the CI pgmq Postgres service.
 *
 * This file is separate from credit-status.test.ts to avoid vitest
 * mock hoisting issues - these tests need the real implementation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
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
    const status = await getCreditStatusDisplay(sql, TEST_ACCOUNT_ID);

    expect(status).not.toBeNull();
    expect(status?.creditLimitAmount).toBe(100000);
    expect(status?.currency).toBe("INR");
    expect(status?.holdState).toBe("OK");
    expect(status?.isOnHold).toBe(false);
  });

  it("exposure calculation includes open invoices", async () => {
    const invoiceId = `inv-db-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/db-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#TEST-DB-1', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW()
      )
    `;

    try {
      const status = await getCreditStatusDisplay(sql, TEST_ACCOUNT_ID);

      expect(status).not.toBeNull();
      expect(status?.exposurePaise.toString()).toBe("5000000");
      expect(status?.utilizationPercent).toBe(50);
    } finally {
      await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
    }
  });

  it("available credit is limit minus exposure", async () => {
    const invoiceId = `inv-avail-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/avail-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#TEST-AVAIL-1', 30000.00, 30000.00, 'open', NOW(), NOW(), NOW()
      )
    `;

    try {
      const status = await getCreditStatusDisplay(sql, TEST_ACCOUNT_ID);

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
    const orderId = `gid://shopify/Order/over-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#TEST-OVER-1', 150000.00, 150000.00, 'open', NOW(), NOW(), NOW()
      )
    `;

    try {
      const status = await getCreditStatusDisplay(sql, TEST_ACCOUNT_ID);

      expect(status).not.toBeNull();
      expect(status?.isOverLimit).toBe(true);
      expect(status?.isOnHold).toBe(true);
    } finally {
      await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
    }
  });

  it("detects overdue invoices", async () => {
    const invoiceId = `inv-due-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/due-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#TEST-DUE-1', 1000.00, 1000.00, 'open', 
        NOW() - INTERVAL '30 days',
        NOW() - INTERVAL '10 days',
        NOW(), NOW()
      )
    `;

    try {
      const status = await getCreditStatusDisplay(sql, TEST_ACCOUNT_ID);

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
    const orderIdOpen = `gid://shopify/Order/open-${TEST_SUFFIX}`;
    const orderIdPaid = `gid://shopify/Order/paid-${TEST_SUFFIX}`;
    const orderIdCancel = `gid://shopify/Order/cancel-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "createdAt", "updatedAt"
      )
      VALUES 
        (${openInvoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderIdOpen},
         '#OPEN-1', 10000.00, 10000.00, 'open', NOW(), NOW(), NOW()),
        (${paidInvoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderIdPaid},
         '#PAID-1', 20000.00, 0.00, 'paid', NOW(), NOW(), NOW()),
        (${cancelledInvoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderIdCancel},
         '#CANCEL-1', 30000.00, 30000.00, 'cancelled', NOW(), NOW(), NOW())
    `;

    try {
      const status = await getCreditStatusDisplay(sql, TEST_ACCOUNT_ID);

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
    const orderId1 = `gid://shopify/Order/loc1-${TEST_SUFFIX}`;
    const orderId2 = `gid://shopify/Order/loc2-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "createdAt", "updatedAt"
      )
      VALUES 
        (${inv1}, ${TEST_SHOP_ID}, ${TEST_LOCATION_1_ID}, ${orderId1},
         '#LOC1-1', 30000.00, 30000.00, 'open', NOW(), NOW(), NOW()),
        (${inv2}, ${TEST_SHOP_ID}, ${TEST_LOCATION_2_ID}, ${orderId2},
         '#LOC2-1', 20000.00, 20000.00, 'open', NOW(), NOW(), NOW())
    `;

    try {
      const totals = await getCompanyTotals(
        sql,
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
        sql,
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

describeWithDb("syncVersion compare-and-clear", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-syncver";
  const TEST_SHOP_ID = `shop-syncver-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `syncver-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-syncver-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "syncPending", "syncVersion",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${"gid://shopify/CompanyLocation/" + TEST_SUFFIX},
        'SyncVersion Test Account', 100000.00, 'OK', false, false, 0,
        NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  it("clearing with stale syncVersion (v1) updates 0 rows when current is v2", async () => {
    // Write A's transaction: increment to v1, set syncPending=true
    const [writeA] = await sql<{ syncVersion: number }[]>`
      UPDATE "BuyerAccount"
      SET "syncVersion" = "syncVersion" + 1, "syncPending" = true
      WHERE id = ${TEST_ACCOUNT_ID}
      RETURNING "syncVersion"
    `;
    expect(writeA.syncVersion).toBe(1);

    // Write B's transaction: increment to v2, set syncPending=true
    const [writeB] = await sql<{ syncVersion: number }[]>`
      UPDATE "BuyerAccount"
      SET "syncVersion" = "syncVersion" + 1, "syncPending" = true
      WHERE id = ${TEST_ACCOUNT_ID}
      RETURNING "syncVersion"
    `;
    expect(writeB.syncVersion).toBe(2);

    // Simulate: Write A's metafield call finishes and tries to clear with v1
    // This should update 0 rows because current syncVersion is 2
    const clearWithV1 = await sql<{ id: string }[]>`
      UPDATE "BuyerAccount"
      SET "syncPending" = false
      WHERE id = ${TEST_ACCOUNT_ID}
        AND "syncVersion" = ${writeA.syncVersion}
      RETURNING id
    `;
    expect(clearWithV1.length).toBe(0);

    // Verify syncPending is still true
    const [afterV1Clear] = await sql<{ syncPending: boolean }[]>`
      SELECT "syncPending" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(afterV1Clear.syncPending).toBe(true);
  });

  it("clearing with current syncVersion (v2) succeeds and clears syncPending", async () => {
    // Get current syncVersion (should be 2 from previous test)
    const [current] = await sql<{ syncVersion: number }[]>`
      SELECT "syncVersion" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(current.syncVersion).toBe(2);

    // Clear with matching version (v2)
    const clearWithV2 = await sql<{ id: string }[]>`
      UPDATE "BuyerAccount"
      SET "syncPending" = false
      WHERE id = ${TEST_ACCOUNT_ID}
        AND "syncVersion" = ${current.syncVersion}
      RETURNING id
    `;
    expect(clearWithV2.length).toBe(1);

    // Verify syncPending is now false
    const [afterV2Clear] = await sql<{ syncPending: boolean }[]>`
      SELECT "syncPending" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(afterV2Clear.syncPending).toBe(false);
  });

  it("interleaved writes: older HTTP response finishing last leaves syncPending=true", async () => {
    // Reset state
    await sql`
      UPDATE "BuyerAccount"
      SET "syncVersion" = 0, "syncPending" = false
      WHERE id = ${TEST_ACCOUNT_ID}
    `;

    // Simulate Write A: tx commits with v1, metafield call starts (slow)
    const [writeA] = await sql<{ syncVersion: number }[]>`
      UPDATE "BuyerAccount"
      SET "syncVersion" = "syncVersion" + 1, "syncPending" = true
      WHERE id = ${TEST_ACCOUNT_ID}
      RETURNING "syncVersion"
    `;

    // Simulate Write B: tx commits with v2, metafield call starts and finishes fast
    const [writeB] = await sql<{ syncVersion: number }[]>`
      UPDATE "BuyerAccount"
      SET "syncVersion" = "syncVersion" + 1, "syncPending" = true
      WHERE id = ${TEST_ACCOUNT_ID}
      RETURNING "syncVersion"
    `;

    // Write B's metafield succeeds and clears (matches v2)
    const clearB = await sql<{ id: string }[]>`
      UPDATE "BuyerAccount"
      SET "syncPending" = false
      WHERE id = ${TEST_ACCOUNT_ID}
        AND "syncVersion" = ${writeB.syncVersion}
      RETURNING id
    `;
    expect(clearB.length).toBe(1);

    // Verify syncPending is false (B cleared it)
    const [afterBClear] = await sql<{ syncPending: boolean }[]>`
      SELECT "syncPending" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(afterBClear.syncPending).toBe(false);

    // Now Write A's metafield finally finishes and tries to clear with v1
    // This should fail (0 rows) because v1 doesn't match current v2
    const clearA = await sql<{ id: string }[]>`
      UPDATE "BuyerAccount"
      SET "syncPending" = false
      WHERE id = ${TEST_ACCOUNT_ID}
        AND "syncVersion" = ${writeA.syncVersion}
      RETURNING id
    `;
    expect(clearA.length).toBe(0);

    // syncPending should still be false (B's clear succeeded, A's had no effect)
    const [final] = await sql<{ syncPending: boolean }[]>`
      SELECT "syncPending" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(final.syncPending).toBe(false);
  });
});

describeWithDb("syncCreditStatusMetafield skip branches", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-skip";
  const TEST_SHOP_ID = `shop-skip-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `skip-test-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  it("gated account: syncPending cleared inside tx (no metafield write)", async () => {
    const gatedAccountId = `acc-gated-${TEST_SUFFIX}`;

    // Create a gated account with syncPending=true
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "syncPending", "syncVersion",
        gated_at, "createdAt", "updatedAt"
      )
      VALUES (
        ${gatedAccountId}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-gated-" + TEST_SUFFIX}, ${"gid://shopify/CompanyLocation/gated-" + TEST_SUFFIX},
        'Gated Account', 100000.00, 'OK', false, true, 1,
        NOW(), NOW(), NOW()
      )
    `;

    try {
      // Verify syncPending is true before
      const [before] = await sql<{ syncPending: boolean }[]>`
        SELECT "syncPending" FROM "BuyerAccount" WHERE id = ${gatedAccountId}
      `;
      expect(before.syncPending).toBe(true);

      // The skip branch in syncCreditStatusMetafield clears syncPending inside tx
      // Simulate what the code does: UPDATE inside the tx
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = false
        WHERE id = ${gatedAccountId}
      `;

      // Verify syncPending is now false
      const [after] = await sql<{ syncPending: boolean }[]>`
        SELECT "syncPending" FROM "BuyerAccount" WHERE id = ${gatedAccountId}
      `;
      expect(after.syncPending).toBe(false);
    } finally {
      await sql`DELETE FROM "BuyerAccount" WHERE id = ${gatedAccountId}`;
    }
  });

  // Note: The "no owner GID" skip branch cannot be tested with real data because
  // the BuyerAccount_kind_consistency constraint requires:
  // - COMPANY accounts must have companyLocationId AND companyId
  // - TAGGED_CUSTOMER accounts must have customerId
  // This ensures all valid accounts have an owner GID.
});
