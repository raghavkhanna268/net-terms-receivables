/**
 * DB-backed integration tests for credit-status persistence.
 * Uses the CI pgmq Postgres service.
 *
 * This file tests the real DB operations while mocking only the HTTP layer
 * (shopifyGraphQLRequest) for syncVersion race condition tests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
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

// Note: The "no owner GID" branch in syncCreditStatusMetafield requires temporarily
// disabling the BuyerAccount_kind_consistency constraint for testing, since it prevents
// inserting rows without the required owner GID fields.

describeWithDb("syncCreditStatusMetafield no-owner accounts (#203)", () => {
  let sql: ReturnType<typeof postgres>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  const TEST_SUFFIX = Date.now().toString(36) + "-noowner";
  const TEST_SHOP_ID = `shop-noowner-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `noowner-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_COMPANY_ACCOUNT_ID = `acc-noowner-co-${TEST_SUFFIX}`;
  const TEST_TAGGED_ACCOUNT_ID = `acc-noowner-tag-${TEST_SUFFIX}`;
  const TEST_MISMATCH_ACCOUNT_ID = `acc-noowner-mis-${TEST_SUFFIX}`;

  const HOLD_UNENFORCEABLE_AUDIT_KEYS = [
    "buyerAccountId",
    "holdState",
    "kind",
    "syncVersion",
  ];

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    // Disable CHECK constraint for the duration of all tests in this describe block
    await sql`ALTER TABLE "BuyerAccount" DROP CONSTRAINT IF EXISTS "BuyerAccount_kind_consistency"`;

    // COMPANY with null companyLocationId
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "syncPending", "syncVersion",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_COMPANY_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-noowner-" + TEST_SUFFIX}, NULL,
        'No-Owner Company Account', 100000.00, 'OK', false, true, 0,
        NOW(), NOW()
      )
    `;

    // TAGGED_CUSTOMER with null customerId
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "customerId", name,
        "creditLimit", "holdState", bypass, "syncPending", "syncVersion",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_TAGGED_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER',
        NULL, 'No-Owner Tagged Account', 100000.00, 'OK', false, true, 0,
        NOW(), NOW()
      )
    `;

    // Kind/owner mismatch: COMPANY with customerId but no companyLocationId
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", "customerId", name,
        "creditLimit", "holdState", bypass, "syncPending", "syncVersion",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_MISMATCH_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-mismatch-" + TEST_SUFFIX}, NULL, ${"cust-mismatch-" + TEST_SUFFIX},
        'Mismatch Account', 100000.00, 'OK', false, true, 0,
        NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    // Clean up test data first while constraint is dropped
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    
    // Re-enable constraint - must happen after all no-owner rows are deleted
    await sql`
      ALTER TABLE "BuyerAccount"
      ADD CONSTRAINT "BuyerAccount_kind_consistency" CHECK (
        (kind = 'COMPANY' AND "companyLocationId" IS NOT NULL AND "companyId" IS NOT NULL)
        OR (kind = 'TAGGED_CUSTOMER' AND "customerId" IS NOT NULL)
      )
    `;
    
    await sql.end();
  });

  beforeEach(async () => {
    consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockShopifyGraphQLRequest.mockReset();
    mockShopifyGraphQLRequest.mockResolvedValue({
      success: true,
      data: { metafieldsSet: { metafields: [{ id: "mf-noowner" }], userErrors: [] } },
    });
    
    // Reset all test accounts to OK state (constraint is dropped, so this will work)
    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'OK', "syncPending" = true, "syncVersion" = 0,
          "metafieldSyncedAt" = NULL
      WHERE "shopId" = ${TEST_SHOP_ID}
    `;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("COMPANY with null companyLocationId: holdState persisted, metafieldSyncedAt NULL, no Shopify write", async () => {
    const invoiceId = `inv-noowner-co-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/noowner-co-${TEST_SUFFIX}`;

    // Create overdue invoice to trigger HELD state
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_COMPANY_ACCOUNT_ID}, ${orderId},
        '#NOOWNER-CO-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '30 days',
        NOW() - INTERVAL '10 days',
        NOW(), NOW()
      )
    `;

    const result = await syncCreditStatusMetafield(sql, TEST_COMPANY_ACCOUNT_ID, "daily_sweep");

    expect(result.success).toBe(true);
    expect(result.metafieldSyncPending).toBe(false);
    expect(result.noOwner).toBe(true);

    // Shopify mock should NOT be called
    expect(mockShopifyGraphQLRequest).not.toHaveBeenCalled();

    // Verify DB state
    const [account] = await sql<{
      holdState: string;
      syncPending: boolean;
      syncVersion: number;
      metafieldSyncedAt: Date | null;
    }[]>`
      SELECT "holdState", "syncPending", "syncVersion", "metafieldSyncedAt"
      FROM "BuyerAccount"
      WHERE id = ${TEST_COMPANY_ACCOUNT_ID}
    `;

    expect(account.holdState).toBe("HELD");
    expect(account.syncPending).toBe(false);
    expect(account.syncVersion).toBe(1);
    expect(account.metafieldSyncedAt).toBeNull();
  });

  it("TAGGED_CUSTOMER with null customerId: holdState persisted, metafieldSyncedAt NULL, no Shopify write", async () => {
    const invoiceId = `inv-noowner-tag-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/noowner-tag-${TEST_SUFFIX}`;

    // Create overdue invoice to trigger HELD state
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_TAGGED_ACCOUNT_ID}, ${orderId},
        '#NOOWNER-TAG-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '30 days',
        NOW() - INTERVAL '10 days',
        NOW(), NOW()
      )
    `;

    const result = await syncCreditStatusMetafield(sql, TEST_TAGGED_ACCOUNT_ID, "daily_sweep");

    expect(result.success).toBe(true);
    expect(result.metafieldSyncPending).toBe(false);
    expect(result.noOwner).toBe(true);

    // Shopify mock should NOT be called
    expect(mockShopifyGraphQLRequest).not.toHaveBeenCalled();

    // Verify DB state
    const [account] = await sql<{
      holdState: string;
      syncPending: boolean;
      syncVersion: number;
      metafieldSyncedAt: Date | null;
    }[]>`
      SELECT "holdState", "syncPending", "syncVersion", "metafieldSyncedAt"
      FROM "BuyerAccount"
      WHERE id = ${TEST_TAGGED_ACCOUNT_ID}
    `;

    expect(account.holdState).toBe("HELD");
    expect(account.syncPending).toBe(false);
    expect(account.syncVersion).toBe(1);
    expect(account.metafieldSyncedAt).toBeNull();
  });

  it("Kind/owner mismatch (COMPANY with only customerId) treated as no-owner", async () => {
    const invoiceId = `inv-mismatch-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/mismatch-${TEST_SUFFIX}`;

    // Create overdue invoice to trigger HELD state
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_MISMATCH_ACCOUNT_ID}, ${orderId},
        '#MISMATCH-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '30 days',
        NOW() - INTERVAL '10 days',
        NOW(), NOW()
      )
    `;

    const result = await syncCreditStatusMetafield(sql, TEST_MISMATCH_ACCOUNT_ID, "daily_sweep");

    expect(result.success).toBe(true);
    expect(result.noOwner).toBe(true);

    // Shopify mock should NOT be called
    expect(mockShopifyGraphQLRequest).not.toHaveBeenCalled();

    // Verify holdState is HELD
    const [account] = await sql<{ holdState: string }[]>`
      SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_MISMATCH_ACCOUNT_ID}
    `;
    expect(account.holdState).toBe("HELD");
  });

  it("state change logs credit_status_no_owner and records hold_unenforceable audit", async () => {
    const invoiceId = `inv-audit-noowner-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/audit-noowner-${TEST_SUFFIX}`;

    // Create overdue invoice to trigger HELD state
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_COMPANY_ACCOUNT_ID}, ${orderId},
        '#AUDIT-NOOWNER-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '30 days',
        NOW() - INTERVAL '10 days',
        NOW(), NOW()
      )
    `;

    await syncCreditStatusMetafield(sql, TEST_COMPANY_ACCOUNT_ID, "daily_sweep");

    // Verify log was called
    expect(consoleSpy).toHaveBeenCalled();
    const warnCalls = consoleSpy.mock.calls.filter((call: unknown[]) => 
      typeof call[0] === 'string' && call[0].includes('credit_status_no_owner')
    );
    expect(warnCalls.length).toBe(1);

    // Parse the log payload and verify keys
    const logPayload = JSON.parse(warnCalls[0][0] as string);
    expect(logPayload.event).toBe("credit_status_no_owner");
    expect(logPayload.buyerAccountId).toBe(TEST_COMPANY_ACCOUNT_ID);
    // kind may be redacted by safeLog, but the key should exist
    expect(Object.keys(logPayload)).toContain("kind");
    // Verify no PII keys
    expect(Object.keys(logPayload)).not.toContain("domain");
    expect(Object.keys(logPayload)).not.toContain("email");
    expect(Object.keys(logPayload)).not.toContain("name");

    // Verify audit event
    const events = await sql<{ type: string; data: Record<string, unknown> }[]>`
      SELECT type, data FROM "AuditEvent"
      WHERE "shopId" = ${TEST_SHOP_ID}
        AND type = 'credit_status.hold_unenforceable'
    `;
    expect(events.length).toBe(1);
    
    // Verify audit data has exactly the allowed keys
    const dataKeys = Object.keys(events[0].data).sort();
    expect(dataKeys).toEqual(HOLD_UNENFORCEABLE_AUDIT_KEYS.sort());
    
    // Verify audit data content
    expect(events[0].data.buyerAccountId).toBe(TEST_COMPANY_ACCOUNT_ID);
    expect(events[0].data.kind).toBe("COMPANY");
    expect(events[0].data.holdState).toBe("HELD");
    expect(typeof events[0].data.syncVersion).toBe("number");

    // Verify NO hold_applied audit event
    const holdAppliedEvents = await sql<{ type: string }[]>`
      SELECT type FROM "AuditEvent"
      WHERE "shopId" = ${TEST_SHOP_ID}
        AND type = 'credit_status.hold_applied'
    `;
    expect(holdAppliedEvents.length).toBe(0);
  });

  it("no-op recompute (no state change) does NOT log or audit", async () => {
    // Account is OK with no overdue invoices
    await syncCreditStatusMetafield(sql, TEST_COMPANY_ACCOUNT_ID, "daily_sweep");

    // Verify no log was called for credit_status_no_owner
    const warnCalls = consoleSpy.mock.calls.filter((call: unknown[]) => 
      typeof call[0] === 'string' && call[0].includes('credit_status_no_owner')
    );
    expect(warnCalls.length).toBe(0);

    // Verify no audit event
    const events = await sql<{ type: string }[]>`
      SELECT type FROM "AuditEvent"
      WHERE "shopId" = ${TEST_SHOP_ID}
    `;
    expect(events.length).toBe(0);
  });

  it("state change back (invoice paid) logs and audits once more with holdState OK", async () => {
    const invoiceId = `inv-release-noowner-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/release-noowner-${TEST_SUFFIX}`;

    // First: Create overdue invoice and sync to HELD
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_COMPANY_ACCOUNT_ID}, ${orderId},
        '#RELEASE-NOOWNER-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '30 days',
        NOW() - INTERVAL '10 days',
        NOW(), NOW()
      )
    `;

    await syncCreditStatusMetafield(sql, TEST_COMPANY_ACCOUNT_ID, "daily_sweep");
    consoleSpy.mockClear();
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;

    // Second: Pay the invoice and sync back to OK
    await sql`
      UPDATE "Invoice"
      SET status = 'paid', outstanding = 0
      WHERE id = ${invoiceId}
    `;

    await syncCreditStatusMetafield(sql, TEST_COMPANY_ACCOUNT_ID, "daily_sweep");

    // Verify log was called
    const warnCalls = consoleSpy.mock.calls.filter((call: unknown[]) => 
      typeof call[0] === 'string' && call[0].includes('credit_status_no_owner')
    );
    expect(warnCalls.length).toBe(1);

    // Verify audit event with holdState OK
    const events = await sql<{ type: string; data: Record<string, unknown> }[]>`
      SELECT type, data FROM "AuditEvent"
      WHERE "shopId" = ${TEST_SHOP_ID}
        AND type = 'credit_status.hold_unenforceable'
    `;
    expect(events.length).toBe(1);
    expect(events[0].data.holdState).toBe("OK");
  });

  it("regression: accounts with an owner still sync and set metafieldSyncedAt", async () => {
    // Create an account WITH an owner for regression testing
    // Constraint is already dropped in beforeAll, so we can insert directly
    const ownerAccountId = `acc-with-owner-${TEST_SUFFIX}`;
    
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "syncPending", "syncVersion",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${ownerAccountId}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-withowner-" + TEST_SUFFIX}, ${"gid://shopify/CompanyLocation/withowner-" + TEST_SUFFIX},
        'With-Owner Account', 100000.00, 'OK', false, true, 0,
        NOW(), NOW()
      )
    `;

    try {
      const result = await syncCreditStatusMetafield(sql, ownerAccountId, "daily_sweep");

      expect(result.success).toBe(true);
      expect(result.noOwner).toBeUndefined();

      // Shopify mock SHOULD be called
      expect(mockShopifyGraphQLRequest).toHaveBeenCalled();

      // Verify metafieldSyncedAt is set
      const [account] = await sql<{
        syncPending: boolean;
        metafieldSyncedAt: Date | null;
      }[]>`
        SELECT "syncPending", "metafieldSyncedAt"
        FROM "BuyerAccount"
        WHERE id = ${ownerAccountId}
      `;

      expect(account.syncPending).toBe(false);
      expect(account.metafieldSyncedAt).not.toBeNull();
    } finally {
      // Clean up the test account
      await sql`DELETE FROM "BuyerAccount" WHERE id = ${ownerAccountId}`;
    }
  });
});

describeWithDb("hold-transition audit events", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-holdaudit";
  const TEST_SHOP_ID = `shop-holdaudit-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `holdaudit-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-holdaudit-${TEST_SUFFIX}`;

  const ALLOWED_AUDIT_DATA_KEYS = [
    "buyerAccountId",
    "holdReasonCode",
    "source",
    "previousHoldState",
    "newHoldState",
  ];

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold", "syncPending", "syncVersion",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${"gid://shopify/CompanyLocation/" + TEST_SUFFIX},
        'Hold Audit Test Account', 100000.00, 'OK', false, false, false, 0,
        NOW(), NOW()
      )
    `;
  });

  beforeEach(async () => {
    // Reset fixture state before each test
    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'OK', "manualHold" = false, "holdReasonCode" = NULL,
          "syncPending" = false, "syncVersion" = 0, bypass = false
      WHERE id = ${TEST_ACCOUNT_ID}
    `;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    mockShopifyGraphQLRequest.mockReset();
    mockShopifyGraphQLRequest.mockResolvedValue({
      success: true,
      data: { metafieldsSet: { metafields: [{ id: "mf-audit-test" }], userErrors: [] } },
    });
  });

  afterAll(async () => {
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  it("OK -> HELD writes exactly one hold_applied event", async () => {
    const result = await updateCreditStatus(sql, TEST_ACCOUNT_ID, {
      creditLimitAmount: 100000,
      manualHold: true,
      holdReasonCode: "MANUAL_HOLD",
    });

    expect(result.success).toBe(true);

    const events = await sql<{ type: string; data: unknown }[]>`
      SELECT type, data FROM "AuditEvent"
      WHERE "shopId" = ${TEST_SHOP_ID}
        AND type LIKE 'credit_status.%'
      ORDER BY at
    `;

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("credit_status.hold_applied");
  });

  it("HELD -> OK writes exactly one hold_released event", async () => {
    // First set to HELD
    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'HELD', "manualHold" = true, "holdReasonCode" = 'MANUAL_HOLD'
      WHERE id = ${TEST_ACCOUNT_ID}
    `;

    const result = await updateCreditStatus(sql, TEST_ACCOUNT_ID, {
      creditLimitAmount: 100000,
      manualHold: false,
    });

    expect(result.success).toBe(true);

    const events = await sql<{ type: string; data: unknown }[]>`
      SELECT type, data FROM "AuditEvent"
      WHERE "shopId" = ${TEST_SHOP_ID}
        AND type LIKE 'credit_status.%'
      ORDER BY at
    `;

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("credit_status.hold_released");
  });

  it("no-op recompute writes no audit events", async () => {
    // Account is OK, update without changing hold state
    const result = await updateCreditStatus(sql, TEST_ACCOUNT_ID, {
      creditLimitAmount: 90000,
      manualHold: false,
    });

    expect(result.success).toBe(true);

    const events = await sql<{ type: string }[]>`
      SELECT type FROM "AuditEvent"
      WHERE "shopId" = ${TEST_SHOP_ID}
        AND type LIKE 'credit_status.%'
    `;

    expect(events.length).toBe(0);
  });

  it("audit event data has exactly the allowed keys", async () => {
    const result = await updateCreditStatus(sql, TEST_ACCOUNT_ID, {
      creditLimitAmount: 100000,
      manualHold: true,
      holdReasonCode: "MANUAL_HOLD",
    });

    expect(result.success).toBe(true);

    const events = await sql<{ data: Record<string, unknown> }[]>`
      SELECT data FROM "AuditEvent"
      WHERE "shopId" = ${TEST_SHOP_ID}
        AND type LIKE 'credit_status.%'
    `;

    expect(events.length).toBe(1);
    const dataKeys = Object.keys(events[0].data).sort();
    expect(dataKeys).toEqual(ALLOWED_AUDIT_DATA_KEYS.sort());

    // Verify the actual content
    expect(events[0].data.buyerAccountId).toBe(TEST_ACCOUNT_ID);
    expect(events[0].data.holdReasonCode).toBe("MANUAL_HOLD");
    expect(events[0].data.source).toBe("manual");
    expect(events[0].data.previousHoldState).toBe("OK");
    expect(events[0].data.newHoldState).toBe("HELD");
  });

  it("failed metafield write still records the transition (audit in tx)", async () => {
    // Make metafield write fail
    mockShopifyGraphQLRequest.mockResolvedValue({
      success: false,
      error: "Network error",
    });

    const result = await updateCreditStatus(sql, TEST_ACCOUNT_ID, {
      creditLimitAmount: 100000,
      manualHold: true,
      holdReasonCode: "MANUAL_HOLD",
    });

    // DB update succeeded but metafield failed
    expect(result.success).toBe(true);
    expect(result.metafieldSyncPending).toBe(true);

    // Audit event should still be recorded (it was in the same tx as holdState UPDATE)
    const events = await sql<{ type: string; data: Record<string, unknown> }[]>`
      SELECT type, data FROM "AuditEvent"
      WHERE "shopId" = ${TEST_SHOP_ID}
        AND type LIKE 'credit_status.%'
    `;

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("credit_status.hold_applied");
    expect(events[0].data.buyerAccountId).toBe(TEST_ACCOUNT_ID);
  });

  it("syncCreditStatusMetafield records audit event with source", async () => {
    // Set up: account is OK with an overdue invoice (will trigger auto-hold)
    const invoiceId = `inv-audit-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/audit-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#AUDIT-1', 1000.00, 1000.00, 'open',
        NOW() - INTERVAL '30 days',
        NOW() - INTERVAL '10 days',
        NOW(), NOW()
      )
    `;

    try {
      // Call syncCreditStatusMetafield with a specific source
      const result = await syncCreditStatusMetafield(sql, TEST_ACCOUNT_ID, "invoice_change");

      expect(result.success).toBe(true);

      // Check audit event was recorded with correct source
      const events = await sql<{ type: string; data: Record<string, unknown> }[]>`
        SELECT type, data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type LIKE 'credit_status.%'
      `;

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("credit_status.hold_applied");
      expect(events[0].data.source).toBe("invoice_change");
    } finally {
      await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
    }
  });

  it("bypass account does not trigger hold_applied even when manualHold is set", async () => {
    // Set bypass=true
    await sql`
      UPDATE "BuyerAccount"
      SET bypass = true
      WHERE id = ${TEST_ACCOUNT_ID}
    `;

    const result = await updateCreditStatus(sql, TEST_ACCOUNT_ID, {
      creditLimitAmount: 100000,
      manualHold: true,
      holdReasonCode: "MANUAL_HOLD",
    });

    expect(result.success).toBe(true);

    // No audit event because effective hold didn't change (bypass prevents hold)
    const events = await sql<{ type: string }[]>`
      SELECT type FROM "AuditEvent"
      WHERE "shopId" = ${TEST_SHOP_ID}
        AND type LIKE 'credit_status.%'
    `;

    expect(events.length).toBe(0);
  });
});
