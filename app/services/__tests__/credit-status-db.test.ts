/**
 * DB-backed integration tests for credit-status persistence.
 * Uses the CI pgmq Postgres service.
 *
 * This file tests the real DB operations while mocking only the HTTP layer
 * (shopifyGraphQLRequest) for syncVersion race condition tests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

// Mock the HTTP layer only - the rest uses real DB
const mockShopifyGraphQLRequest = vi.fn();
vi.mock("../shopify-client.server", () => ({
  shopifyGraphQLRequest: (...args: unknown[]) => mockShopifyGraphQLRequest(...args),
}));

// Import after mock setup
import { 
  getCreditStatusDisplay, 
  getCompanyTotals,
  updateCreditStatus,
  syncCreditStatusMetafield,
} from "../credit-status.server";

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

describeWithDb("syncVersion race condition (real functions)", () => {
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

  beforeEach(async () => {
    // Reset fixture state before each test
    await sql`
      UPDATE "BuyerAccount"
      SET "syncVersion" = 0, "syncPending" = false, "creditLimit" = 100000.00,
          "holdState" = 'OK', "manualHold" = false, "holdReasonCode" = NULL
      WHERE id = ${TEST_ACCOUNT_ID}
    `;
    mockShopifyGraphQLRequest.mockReset();
  });

  afterAll(async () => {
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  it("race: A deferred, B succeeds → syncPending=false, A resolves → stays false at B's version", async () => {
    // Deferred promise for call A
    let resolveA: (value: unknown) => void;
    const deferredA = new Promise((resolve) => { resolveA = resolve; });

    let callCount = 0;
    mockShopifyGraphQLRequest.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Call A - deferred
        return deferredA;
      }
      // Call B - immediate success
      return Promise.resolve({
        success: true,
        data: { metafieldsSet: { metafields: [{ id: "mf-b" }], userErrors: [] } },
      });
    });

    // Start call A (will wait on deferred promise)
    const promiseA = updateCreditStatus(sql, TEST_ACCOUNT_ID, {
      creditLimitAmount: 90000,
      manualHold: false,
    });

    // Wait a tick for A's transaction to complete
    await new Promise(r => setTimeout(r, 50));

    // Get A's syncVersion
    const [afterA] = await sql<{ syncVersion: number }[]>`
      SELECT "syncVersion" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    const versionA = afterA.syncVersion;
    expect(versionA).toBe(1);

    // Call B runs fully and succeeds
    const resultB = await updateCreditStatus(sql, TEST_ACCOUNT_ID, {
      creditLimitAmount: 80000,
      manualHold: false,
    });
    expect(resultB.success).toBe(true);
    expect(resultB.metafieldSyncPending).toBe(false);

    // Verify B's state: syncPending=false, syncVersion=2
    const [afterB] = await sql<{ syncVersion: number; syncPending: boolean }[]>`
      SELECT "syncVersion", "syncPending" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(afterB.syncVersion).toBe(2);
    expect(afterB.syncPending).toBe(false);

    // Now resolve A successfully
    resolveA!({
      success: true,
      data: { metafieldsSet: { metafields: [{ id: "mf-a" }], userErrors: [] } },
    });
    const resultA = await promiseA;

    // A succeeds but its stale version (1) can't clear B's state
    expect(resultA.success).toBe(true);
    // A's clear returned 0 rows, so metafieldSyncPending=true for A's perspective
    expect(resultA.metafieldSyncPending).toBe(true);

    // Final state: syncPending still false (B owns it), syncVersion still 2
    const [final] = await sql<{ syncVersion: number; syncPending: boolean }[]>`
      SELECT "syncVersion", "syncPending" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(final.syncVersion).toBe(2);
    expect(final.syncPending).toBe(false);
  });

  it("race: A deferred, B fails → syncPending=true, A resolves → still true (stale can't clear)", async () => {
    // Deferred promise for call A
    let resolveA: (value: unknown) => void;
    const deferredA = new Promise((resolve) => { resolveA = resolve; });

    let callCount = 0;
    mockShopifyGraphQLRequest.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Call A - deferred
        return deferredA;
      }
      // Call B - fails
      return Promise.resolve({
        success: false,
        error: "Network timeout",
      });
    });

    // Start call A (will wait on deferred promise)
    const promiseA = updateCreditStatus(sql, TEST_ACCOUNT_ID, {
      creditLimitAmount: 90000,
      manualHold: false,
    });

    // Wait for A's transaction
    await new Promise(r => setTimeout(r, 50));

    // Call B runs but metafield fails → syncPending stays true
    const resultB = await updateCreditStatus(sql, TEST_ACCOUNT_ID, {
      creditLimitAmount: 80000,
      manualHold: false,
    });
    expect(resultB.success).toBe(true);
    expect(resultB.metafieldSyncPending).toBe(true);

    // Verify B's state: syncPending=true, syncVersion=2
    const [afterB] = await sql<{ syncVersion: number; syncPending: boolean }[]>`
      SELECT "syncVersion", "syncPending" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(afterB.syncVersion).toBe(2);
    expect(afterB.syncPending).toBe(true);

    // Now resolve A successfully
    resolveA!({
      success: true,
      data: { metafieldsSet: { metafields: [{ id: "mf-a" }], userErrors: [] } },
    });
    const resultA = await promiseA;

    // A succeeds but its stale version (1) can't clear B's pending sync
    expect(resultA.success).toBe(true);
    expect(resultA.metafieldSyncPending).toBe(true);

    // Final state: syncPending STILL true (B's pending sync preserved)
    const [final] = await sql<{ syncVersion: number; syncPending: boolean }[]>`
      SELECT "syncVersion", "syncPending" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(final.syncVersion).toBe(2);
    expect(final.syncPending).toBe(true);
  });

  it("happy path: single call clears syncPending", async () => {
    mockShopifyGraphQLRequest.mockResolvedValue({
      success: true,
      data: { metafieldsSet: { metafields: [{ id: "mf-1" }], userErrors: [] } },
    });

    const result = await updateCreditStatus(sql, TEST_ACCOUNT_ID, {
      creditLimitAmount: 75000,
      manualHold: false,
    });

    expect(result.success).toBe(true);
    expect(result.metafieldSyncPending).toBe(false);

    // Verify DB state
    const [final] = await sql<{ syncVersion: number; syncPending: boolean }[]>`
      SELECT "syncVersion", "syncPending" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(final.syncVersion).toBe(1);
    expect(final.syncPending).toBe(false);
  });
});

describeWithDb("syncCreditStatusMetafield gated account", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-gated";
  const TEST_SHOP_ID = `shop-gated-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `gated-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_GATED_ACCOUNT_ID = `acc-gated-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    // Create a gated account with syncPending=true
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "syncPending", "syncVersion",
        gated_at, "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_GATED_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-gated-" + TEST_SUFFIX}, ${"gid://shopify/CompanyLocation/gated-" + TEST_SUFFIX},
        'Gated Account', 100000.00, 'OK', false, true, 1,
        NOW(), NOW(), NOW()
      )
    `;
  });

  beforeEach(async () => {
    // Reset fixture state
    await sql`
      UPDATE "BuyerAccount"
      SET "syncPending" = true, "syncVersion" = 1
      WHERE id = ${TEST_GATED_ACCOUNT_ID}
    `;
    mockShopifyGraphQLRequest.mockReset();
  });

  afterAll(async () => {
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  it("gated account: metafield is written (gating applies only to value-add actions)", async () => {
    // Verify syncPending is true before
    const [before] = await sql<{ syncPending: boolean }[]>`
      SELECT "syncPending" FROM "BuyerAccount" WHERE id = ${TEST_GATED_ACCOUNT_ID}
    `;
    expect(before.syncPending).toBe(true);

    // Mock Shopify GraphQL response
    mockShopifyGraphQLRequest.mockResolvedValue({
      success: true,
      data: {
        metafieldsSet: {
          metafields: [{ id: "gid://shopify/Metafield/123" }],
          userErrors: [],
        },
      },
    });

    // Call the real syncCreditStatusMetafield
    const result = await syncCreditStatusMetafield(sql, TEST_GATED_ACCOUNT_ID);

    // Gated accounts now get metafield writes (gating only applies to value-add actions)
    expect(result.success).toBe(true);
    expect(result.metafieldSyncPending).toBe(false);

    // writeMetafield (shopifyGraphQLRequest) SHOULD be called for gated accounts
    expect(mockShopifyGraphQLRequest).toHaveBeenCalled();

    // Verify syncPending is now false
    const [after] = await sql<{ syncPending: boolean }[]>`
      SELECT "syncPending" FROM "BuyerAccount" WHERE id = ${TEST_GATED_ACCOUNT_ID}
    `;
    expect(after.syncPending).toBe(false);
  });
});

// Note: The "no owner GID" skip branch in syncCreditStatusMetafield cannot be tested
// with real data. The BuyerAccount_kind_consistency constraint requires:
// - COMPANY accounts must have companyLocationId AND companyId
// - TAGGED_CUSTOMER accounts must have customerId
// This ensures all valid accounts have an owner GID, making the skip branch unreachable.
