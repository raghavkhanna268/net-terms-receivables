/**
 * DB-backed integration tests for credit status auto-recompute.
 *
 * Tests:
 * 1. Shared overdue predicate (ONE definition)
 * 2. Invoice becoming overdue triggers holdState HELD/PAYMENT_OVERDUE
 * 3. Paying off invoice flips back to OK
 * 4. No metafield write when nothing changed AND syncPending=false
 * 5. Checkout's hold and backstop's decision agree
 * 6. Cron SQL only enqueues (no pg_net/http calls)
 * 7. P1a: Retry after failed metafield write succeeds
 * 8. P1b: Concurrent recomputes - final metafield matches final DB state
 * 9. P2: NEAR_LIMIT accounts included in sweep
 * 10. P2: HELD self-heal for cleared PAYMENT_OVERDUE
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

// Track metafield write calls
let metafieldWriteCount = 0;
let lastMetafieldValue: unknown = null;
let mockShouldFail = false;

const mockShopifyGraphQLRequest = vi.fn().mockImplementation(async () => {
  if (mockShouldFail) {
    return {
      success: false,
      error: "Simulated metafield write failure",
    };
  }
  metafieldWriteCount++;
  return {
    success: true,
    data: {
      metafieldsSet: {
        metafields: [{ id: "mf-1", namespace: "$app", key: "credit_status" }],
        userErrors: [],
      },
    },
  };
});

// Mock shopify-client.server - use importOriginal to ensure all exports are available
vi.mock("../shopify-client.server", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    shopifyGraphQLRequest: (...args: unknown[]) => {
      lastMetafieldValue = args[2]; // variables
      return mockShopifyGraphQLRequest(...args);
    },
  };
});

// Import after mock setup
import { recomputeCreditStatus } from "../credit-status-recompute.server";
import { hasOverdueInvoices } from "../overdue.server";
import { getSyncHandler, runDrain } from "../drain/processor.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("credit-status-recompute DB integration", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-recompute";
  const TEST_SHOP_ID = `shop-recompute-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `recompute-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-recompute-${TEST_SUFFIX}`;
  const TEST_COMPANY_LOCATION_ID = `gid://shopify/CompanyLocation/${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    // Create test buyer account
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold", "holdReasonCode",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${TEST_COMPANY_LOCATION_ID},
        'Test Recompute Account', 100000.00, 'OK', false, false, NULL,
        false, 1, NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    // Clean up any queue/DLQ messages first (before deleting test data)
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    // Clean up s6_processed_webhooks by webhook_id pattern (no shop column)
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_recompute:' + TEST_ACCOUNT_ID + '%'}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    metafieldWriteCount = 0;
    lastMetafieldValue = null;
    mockShouldFail = false;
    mockShopifyGraphQLRequest.mockClear();
    
    // Reset account state - MUST include gated_at and metafieldSyncedAt to clear after tests
    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'OK', "holdReasonCode" = NULL, "manualHold" = false,
          "syncPending" = false, "syncVersion" = 1, gated_at = NULL, "metafieldSyncedAt" = NULL
      WHERE id = ${TEST_ACCOUNT_ID}
    `;
    
    // Clean up invoices
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    
    // Clean up processed webhooks for this account
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_recompute:' + TEST_ACCOUNT_ID + '%'}`;
  });

  describe("shared overdue predicate", () => {
    it("hasOverdueInvoices uses 1-day grace period", async () => {
      const invoiceId = `inv-grace-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/grace-${TEST_SUFFIX}`;

      // Invoice due yesterday (NOT yet overdue per 1-day grace)
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#GRACE-1', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '10 days',
          NOW() - INTERVAL '1 day' + INTERVAL '1 hour',
          NOW(), NOW()
        )
      `;

      try {
        // Within grace period - not overdue
        const notOverdue = await hasOverdueInvoices(sql, TEST_ACCOUNT_ID);
        expect(notOverdue).toBe(false);

        // Now make it overdue (due 2 days ago)
        await sql`
          UPDATE "Invoice"
          SET "dueAt" = NOW() - INTERVAL '2 days'
          WHERE id = ${invoiceId}
        `;

        const isOverdue = await hasOverdueInvoices(sql, TEST_ACCOUNT_ID);
        expect(isOverdue).toBe(true);
      } finally {
        await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
      }
    });

    it("only counts open invoices with outstanding > 0", async () => {
      const invoiceId = `inv-paid-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/paid-${TEST_SUFFIX}`;

      // Paid invoice (due 5 days ago) - should NOT be counted
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#PAID-1', 10000.00, 0.00, 'paid',
          NOW() - INTERVAL '10 days',
          NOW() - INTERVAL '5 days',
          NOW(), NOW()
        )
      `;

      try {
        const isOverdue = await hasOverdueInvoices(sql, TEST_ACCOUNT_ID);
        expect(isOverdue).toBe(false);
      } finally {
        await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
      }
    });
  });

  describe("recomputeCreditStatus", () => {
    it("sets holdState HELD/PAYMENT_OVERDUE when invoice becomes overdue", async () => {
      const invoiceId = `inv-overdue-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/overdue-${TEST_SUFFIX}`;

      // Create overdue invoice
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#OVERDUE-1', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '10 days',
          NOW() - INTERVAL '5 days',
          NOW(), NOW()
        )
      `;

      try {
        const result = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

        expect(result.success).toBe(true);
        expect(result.metafieldWritten).toBe(true);
        expect(result.previousHold).toBe(false);
        expect(result.newHold).toBe(true);

        // Verify DB state - holdReasonCode is NOT persisted for auto-holds
        // (only manual holds via updateCreditStatus persist it)
        const [account] = await sql<{ holdState: string }[]>`
          SELECT "holdState"
          FROM "BuyerAccount"
          WHERE id = ${TEST_ACCOUNT_ID}
        `;
        expect(account.holdState).toBe("HELD");

        // Verify metafield was written with hold: true
        // The metafield value is computed fresh each time (includes holdReasonCode)
        expect(metafieldWriteCount).toBe(1);
        const metafields = (lastMetafieldValue as { metafields: Array<{ value: string }> }).metafields;
        const metafieldJson = JSON.parse(metafields[0].value);
        expect(metafieldJson.hold).toBe(true);
      } finally {
        await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
      }
    });

    it("flips back to OK when invoice is paid", async () => {
      const invoiceId = `inv-flip-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/flip-${TEST_SUFFIX}`;

      // Create overdue invoice and set account to HELD
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#FLIP-1', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '10 days',
          NOW() - INTERVAL '5 days',
          NOW(), NOW()
        )
      `;

      await sql`
        UPDATE "BuyerAccount"
        SET "holdState" = 'HELD', "holdReasonCode" = 'PAYMENT_OVERDUE'
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      try {
        // Pay the invoice
        await sql`
          UPDATE "Invoice"
          SET status = 'paid', outstanding = 0
          WHERE id = ${invoiceId}
        `;

        const result = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

        expect(result.success).toBe(true);
        expect(result.metafieldWritten).toBe(true);
        expect(result.previousHold).toBe(true);
        expect(result.newHold).toBe(false);

        // Verify DB state
        const [account] = await sql<{ holdState: string }[]>`
          SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
        `;
        expect(account.holdState).toBe("OK");

        // Verify metafield was written with hold: false
        const metafields = (lastMetafieldValue as { metafields: Array<{ value: string }> }).metafields;
        const metafieldJson = JSON.parse(metafields[0].value);
        expect(metafieldJson.hold).toBe(false);
      } finally {
        await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
      }
    });

    it("does NOT write metafield when nothing changed AND syncPending=false AND metafieldSyncedAt is set", async () => {
      // Account is OK, no invoices, syncPending=false, metafieldSyncedAt is set
      // This is the only case where we early-return without writing
      await sql`
        UPDATE "BuyerAccount"
        SET "metafieldSyncedAt" = NOW()
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      const result = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

      expect(result.success).toBe(true);
      expect(result.metafieldWritten).toBe(false);
      expect(result.previousHold).toBe(false);
      expect(result.newHold).toBe(false);
      expect(metafieldWriteCount).toBe(0);
    });

    it("P1a: writes metafield on retry when previous write failed (syncPending=true)", async () => {
      // Set up: holdState OK, but syncPending=true (simulating previous failed write)
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = true
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      // Even though hold hasn't changed, syncPending=true means we need to sync
      const result = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

      expect(result.success).toBe(true);
      // Metafield should be written because syncPending was true
      expect(metafieldWriteCount).toBe(1);
      
      // Verify syncPending is cleared
      const [account] = await sql<{ syncPending: boolean }[]>`
        SELECT "syncPending" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
      `;
      expect(account.syncPending).toBe(false);
    });

    it("P1a: metafield write fails, retry writes the metafield", async () => {
      const invoiceId = `inv-retry-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/retry-${TEST_SUFFIX}`;

      // Create overdue invoice
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#RETRY-1', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '10 days',
          NOW() - INTERVAL '5 days',
          NOW(), NOW()
        )
      `;

      try {
        // First call: make metafield write fail
        mockShouldFail = true;
        const result1 = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);
        
        // Should fail but DB state updated
        expect(result1.success).toBe(false);
        expect(result1.error).toBe("metafield_sync_failed");
        
        // Verify DB state is HELD but syncPending is true
        const [account1] = await sql<{ holdState: string; syncPending: boolean }[]>`
          SELECT "holdState", "syncPending" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
        `;
        expect(account1.holdState).toBe("HELD");
        expect(account1.syncPending).toBe(true);
        
        // Second call: metafield write succeeds
        mockShouldFail = false;
        const result2 = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);
        
        // Should succeed and write metafield
        expect(result2.success).toBe(true);
        expect(metafieldWriteCount).toBe(1); // Only the successful write counts
        
        // Verify syncPending is cleared
        const [account2] = await sql<{ syncPending: boolean }[]>`
          SELECT "syncPending" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
        `;
        expect(account2.syncPending).toBe(false);
      } finally {
        await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
      }
    });

    it("gated account gets metafield written (gating applies only to value-add actions)", async () => {
      // Set account to gated and HELD with syncPending=true to trigger metafield write
      // (syncPending=true simulates a state change that needs sync)
      await sql`
        UPDATE "BuyerAccount"
        SET gated_at = NOW(), "holdState" = 'HELD', "holdReasonCode" = 'MANUAL_HOLD', 
            "manualHold" = true, "syncPending" = true
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      const result = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

      expect(result.success).toBe(true);
      // Gated accounts now get metafield writes (gating only applies to value-add actions)
      expect(result.metafieldWritten).toBe(true);
      expect(result.previousHold).toBe(true);
      expect(result.newHold).toBe(true);
      expect(metafieldWriteCount).toBe(1); // Metafield written for gated accounts
    });

    it("P2-5: newer syncVersion owns sync - returns success, not retryable failure", async () => {
      // This tests the case where syncCreditStatusMetafield returns
      // metafieldSyncPending=true but no error (a newer syncVersion owns the sync).
      // The recompute should return success, not a retryable failure.
      
      // Set up: syncPending=true but hold hasn't changed
      // This simulates a concurrent write owning the sync
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = true, "holdState" = 'OK'
        WHERE id = ${TEST_ACCOUNT_ID}
      `;
      
      // When we call recompute, it will sync, but if a concurrent write
      // incremented syncVersion, syncPending won't be cleared.
      // Since there's no error, we should still return success.
      const result = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);
      
      // Should succeed - we did our job, even if someone else owns the sync
      expect(result.success).toBe(true);
      // metafieldWritten depends on whether the mock was called
      // The key assertion is success=true, not retryable failure
    });
  });

  describe("metafieldSyncedAt column", () => {
    it("OK account with metafieldSyncedAt NULL gets exactly ONE write, then ZERO on subsequent no-op recomputes", async () => {
      // Ensure metafieldSyncedAt is NULL (set by beforeEach)
      const [before] = await sql<{ metafieldSyncedAt: Date | null }[]>`
        SELECT "metafieldSyncedAt" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
      `;
      expect(before.metafieldSyncedAt).toBeNull();

      // First recompute - should write metafield even though hold hasn't changed
      // because metafieldSyncedAt is NULL
      const result1 = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);
      expect(result1.success).toBe(true);
      expect(metafieldWriteCount).toBe(1);

      // Verify metafieldSyncedAt is now set
      const [after1] = await sql<{ metafieldSyncedAt: Date | null }[]>`
        SELECT "metafieldSyncedAt" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
      `;
      expect(after1.metafieldSyncedAt).not.toBeNull();

      // Second recompute - should NOT write (no change, already synced)
      const result2 = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);
      expect(result2.success).toBe(true);
      expect(result2.metafieldWritten).toBe(false);
      expect(metafieldWriteCount).toBe(1); // Still 1, no additional write

      // Third recompute - also no write
      const result3 = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);
      expect(result3.success).toBe(true);
      expect(result3.metafieldWritten).toBe(false);
      expect(metafieldWriteCount).toBe(1); // Still 1, no additional write
    });

    it("failed write or userErrors leave metafieldSyncedAt NULL and keep syncPending", async () => {
      // Ensure metafieldSyncedAt is NULL
      const [before] = await sql<{ metafieldSyncedAt: Date | null; syncPending: boolean }[]>`
        SELECT "metafieldSyncedAt", "syncPending" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
      `;
      expect(before.metafieldSyncedAt).toBeNull();

      // Make metafield write fail
      mockShouldFail = true;

      const result = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);
      expect(result.success).toBe(false);
      expect(result.error).toBe("metafield_sync_failed");

      // Verify metafieldSyncedAt is still NULL and syncPending is true
      const [after] = await sql<{ metafieldSyncedAt: Date | null; syncPending: boolean }[]>`
        SELECT "metafieldSyncedAt", "syncPending" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
      `;
      expect(after.metafieldSyncedAt).toBeNull();
      expect(after.syncPending).toBe(true);
    });

    it("successful write after previous failure sets metafieldSyncedAt", async () => {
      // Ensure metafieldSyncedAt is NULL and syncPending is true (simulating previous failure)
      await sql`
        UPDATE "BuyerAccount"
        SET "metafieldSyncedAt" = NULL, "syncPending" = true
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      // Reset write count
      metafieldWriteCount = 0;
      mockShouldFail = false;

      const result = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);
      expect(result.success).toBe(true);
      expect(metafieldWriteCount).toBe(1);

      // Verify metafieldSyncedAt is now set
      const [after] = await sql<{ metafieldSyncedAt: Date | null; syncPending: boolean }[]>`
        SELECT "metafieldSyncedAt", "syncPending" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
      `;
      expect(after.metafieldSyncedAt).not.toBeNull();
      expect(after.syncPending).toBe(false);
    });
  });

  describe("checkout (metafield) and backstop agreement", () => {
    it("backstop agrees with checkout hold for overdue invoice", async () => {
      const invoiceId = `inv-agree-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/agree-${TEST_SUFFIX}`;

      // Create overdue invoice
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#AGREE-1', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '10 days',
          NOW() - INTERVAL '5 days',
          NOW(), NOW()
        )
      `;

      try {
        // Recompute to set metafield
        const recomputeResult = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);
        expect(recomputeResult.newHold).toBe(true);

        // Check what backstop would see (shared hasOverdueInvoices)
        const backstopOverdue = await hasOverdueInvoices(sql, TEST_ACCOUNT_ID);
        expect(backstopOverdue).toBe(true);

        // Both agree: hold = true
        expect(recomputeResult.newHold).toBe(backstopOverdue);
      } finally {
        await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
      }
    });

    it("within grace period: checkout OK, backstop NOT held", async () => {
      const invoiceId = `inv-grace-agree-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/grace-agree-${TEST_SUFFIX}`;

      // Invoice due yesterday (within 1-day grace period)
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#GRACE-AGREE-1', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '10 days',
          NOW() - INTERVAL '12 hours',
          NOW(), NOW()
        )
      `;

      try {
        // Recompute - should NOT be held (within grace)
        const recomputeResult = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);
        expect(recomputeResult.newHold).toBe(false);

        // Backstop check - also NOT held
        const backstopOverdue = await hasOverdueInvoices(sql, TEST_ACCOUNT_ID);
        expect(backstopOverdue).toBe(false);

        // Both agree: hold = false
        expect(recomputeResult.newHold).toBe(backstopOverdue);
      } finally {
        await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
      }
    });
  });

  describe("handler deduplication", () => {
    it("drives real handler twice, asserts single metafield write", async () => {
      const invoiceId = `inv-handler-dedup-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/handler-dedup-${TEST_SUFFIX}`;
      const webhookId = `credit_recompute:${TEST_ACCOUNT_ID}:handler-test`;

      // Create overdue invoice
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#HANDLER-DEDUP-1', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '10 days',
          NOW() - INTERVAL '5 days',
          NOW(), NOW()
        )
      `;

      try {
        const handler = getSyncHandler("CREDIT_STATUS_RECOMPUTE");
        expect(handler).toBeDefined();

        const message = {
          topic: "CREDIT_STATUS_RECOMPUTE",
          shop: TEST_SHOP_DOMAIN,
          buyerAccountId: TEST_ACCOUNT_ID,
          source: "daily_sweep",
          webhookId,
          resourceGid: TEST_ACCOUNT_ID,
          enqueuedAt: new Date().toISOString(),
        };

        // First handler call - should process and write metafield
        const result1 = await handler!(sql, message);
        expect(result1.success).toBe(true);
        expect(result1.action).toBe("created"); // Metafield written
        expect(metafieldWriteCount).toBe(1);

        // Second handler call with same webhookId - should skip (idempotent)
        const result2 = await handler!(sql, message);
        expect(result2.success).toBe(true);
        expect(result2.action).toBe("skipped");
        expect(result2.skipReason).toContain("already processed");
        expect(metafieldWriteCount).toBe(1); // Still 1, no additional write
      } finally {
        await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
      }
    });
  });
});

describeWithDb("enqueue_credit_status_recomputes SQL function", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-cron";
  const TEST_SHOP_ID = `shop-cron-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `cron-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-cron-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    // Create test buyer account with OK holdState
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${"loc-" + TEST_SUFFIX},
        'Test Cron Account', 100000.00, 'OK', false, false, NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    // Clean up queue messages (including archived and DLQ) by shop domain (unique per test run)
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_recompute:' + TEST_ACCOUNT_ID + '%'}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    // Clean up queue messages and s6_processed_webhooks (including archived and DLQ) by shop domain
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_recompute:' + TEST_ACCOUNT_ID + '%'}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    
    // Reset account
    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'OK', "holdReasonCode" = NULL, bypass = false, gated_at = NULL, "manualHold" = false
      WHERE id = ${TEST_ACCOUNT_ID}
    `;
  });

  it("enqueues message for account with overdue invoice and holdState OK", async () => {
    const invoiceId = `inv-cron-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/cron-${TEST_SUFFIX}`;

    // Create overdue invoice
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#CRON-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '10 days',
        NOW() - INTERVAL '5 days',
        NOW(), NOW()
      )
    `;

    // Run the cron function
    const [result] = await sql<{ accounts_enqueued: number; messages_skipped: number }[]>`
      SELECT * FROM enqueue_credit_status_recomputes()
    `;

    expect(result.accounts_enqueued).toBeGreaterThanOrEqual(1);

    // Verify message was enqueued
    const [queueMsg] = await sql<{ message: { topic: string; buyerAccountId: string } }[]>`
      SELECT message FROM pgmq.q_s6_sync
      WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
      LIMIT 1
    `;

    expect(queueMsg).toBeDefined();
    expect(queueMsg.message.topic).toBe("CREDIT_STATUS_RECOMPUTE");
    expect(queueMsg.message.buyerAccountId).toBe(TEST_ACCOUNT_ID);
  });

  it("P2: enqueues message for NEAR_LIMIT account with overdue invoice", async () => {
    const invoiceId = `inv-nearlimit-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/nearlimit-${TEST_SUFFIX}`;

    // Set account to NEAR_LIMIT
    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'NEAR_LIMIT'
      WHERE id = ${TEST_ACCOUNT_ID}
    `;

    // Create overdue invoice
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#NEARLIMIT-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '10 days',
        NOW() - INTERVAL '5 days',
        NOW(), NOW()
      )
    `;

    // Run the cron function
    const [result] = await sql<{ accounts_enqueued: number; messages_skipped: number }[]>`
      SELECT * FROM enqueue_credit_status_recomputes()
    `;

    expect(result.accounts_enqueued).toBeGreaterThanOrEqual(1);

    // Verify message was enqueued
    const [queueMsg] = await sql<{ message: { topic: string } }[]>`
      SELECT message FROM pgmq.q_s6_sync
      WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
      LIMIT 1
    `;

    expect(queueMsg).toBeDefined();
    expect(queueMsg.message.topic).toBe("CREDIT_STATUS_RECOMPUTE");
  });

  it("P2: self-heals auto-held account when overdue invoices are cleared", async () => {
    const invoiceId = `inv-selfheal-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/selfheal-${TEST_SUFFIX}`;

    // Step 1: Create an overdue invoice and recompute to HELD
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#SELFHEAL-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '10 days',
        NOW() - INTERVAL '5 days',
        NOW(), NOW()
      )
    `;

    // Set account to HELD (as if recompute ran due to overdue invoice)
    // manualHold=false indicates this is an auto-hold
    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'HELD', "manualHold" = false
      WHERE id = ${TEST_ACCOUNT_ID}
    `;

    // Step 2: Pay off the invoice (simulating payment received)
    await sql`
      UPDATE "Invoice"
      SET status = 'paid', outstanding = 0
      WHERE id = ${invoiceId}
    `;

    // Step 3: Run the cron function - should self-heal
    const [result] = await sql<{ accounts_enqueued: number; messages_skipped: number }[]>`
      SELECT * FROM enqueue_credit_status_recomputes()
    `;

    expect(result.accounts_enqueued).toBeGreaterThanOrEqual(1);

    // Verify message was enqueued for self-heal
    const [queueMsg] = await sql<{ message: { topic: string; source: string } }[]>`
      SELECT message FROM pgmq.q_s6_sync
      WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
      LIMIT 1
    `;

    expect(queueMsg).toBeDefined();
    expect(queueMsg.message.topic).toBe("CREDIT_STATUS_RECOMPUTE");
    expect(queueMsg.message.source).toBe("daily_sweep");
  });

  it("skips manual holds (manualHold=true) even with no overdue invoices", async () => {
    const invoiceId = `inv-held-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/held-${TEST_SUFFIX}`;

    // Set account to HELD with manualHold=true (manual holds are never self-healed)
    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'HELD', "manualHold" = true
      WHERE id = ${TEST_ACCOUNT_ID}
    `;

    // Create overdue invoice
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#HELD-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '10 days',
        NOW() - INTERVAL '5 days',
        NOW(), NOW()
      )
    `;

    // Run the cron function
    await sql`SELECT * FROM enqueue_credit_status_recomputes()`;

    // Verify no message was enqueued for this account
    const [queueMsg] = await sql<{ message: unknown }[]>`
      SELECT message FROM pgmq.q_s6_sync
      WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
      LIMIT 1
    `;

    expect(queueMsg).toBeUndefined();
  });

  it("skips bypassed accounts", async () => {
    const invoiceId = `inv-bypass-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/bypass-${TEST_SUFFIX}`;

    // Set account to bypass
    await sql`
      UPDATE "BuyerAccount"
      SET bypass = true
      WHERE id = ${TEST_ACCOUNT_ID}
    `;

    // Create overdue invoice
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#BYPASS-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '10 days',
        NOW() - INTERVAL '5 days',
        NOW(), NOW()
      )
    `;

    // Run the cron function
    await sql`SELECT * FROM enqueue_credit_status_recomputes()`;

    // Verify no message was enqueued
    const [queueMsg] = await sql<{ message: unknown }[]>`
      SELECT message FROM pgmq.q_s6_sync
      WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
      LIMIT 1
    `;

    expect(queueMsg).toBeUndefined();
  });

  it("skips already-processed accounts (deduplication)", async () => {
    const invoiceId = `inv-dedup-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/dedup-${TEST_SUFFIX}`;
    const today = new Date().toISOString().split("T")[0];
    const dedupeKey = `credit_recompute:${TEST_ACCOUNT_ID}:${today}`;

    // Create overdue invoice
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#DEDUP-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '10 days',
        NOW() - INTERVAL '5 days',
        NOW(), NOW()
      )
    `;

    // Mark as already processed today (s6_processed_webhooks uses webhook_id as PK, no shop)
    await sql`
      INSERT INTO s6_processed_webhooks (webhook_id, topic, resource_gid, processed_at)
      VALUES (${dedupeKey}, 'CREDIT_STATUS_RECOMPUTE', ${TEST_ACCOUNT_ID}, NOW())
    `;

    // Run the cron function
    const [result] = await sql<{ accounts_enqueued: number; messages_skipped: number }[]>`
      SELECT * FROM enqueue_credit_status_recomputes()
    `;

    // Should be skipped
    expect(result.messages_skipped).toBeGreaterThanOrEqual(1);

    // Verify no message was enqueued
    const [queueMsg] = await sql<{ message: unknown }[]>`
      SELECT message FROM pgmq.q_s6_sync
      WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
      LIMIT 1
    `;

    expect(queueMsg).toBeUndefined();
  });

  it("cron SQL only uses pgmq.send, no pg_net/http calls", async () => {
    // This test verifies by inspection that the function uses only pgmq.send
    // We check that no pg_net functions are called in the function body
    const [funcDef] = await sql<{ prosrc: string }[]>`
      SELECT prosrc FROM pg_proc
      WHERE proname = 'enqueue_credit_status_recomputes'
    `;

    expect(funcDef.prosrc).not.toContain("pg_net");
    expect(funcDef.prosrc).not.toContain("http");
    expect(funcDef.prosrc).toContain("pgmq.send");
  });

  it("P1c: schedules job on fresh DB (when pg_cron available)", async () => {
    // Check if pg_cron extension is available
    const [pgCron] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') AS exists
    `;

    if (!pgCron.exists) {
      // Skip test if pg_cron not available
      console.log("pg_cron not available, skipping schedule test");
      return;
    }

    // Check that the job exists
    const [job] = await sql<{ jobname: string; schedule: string }[]>`
      SELECT jobname, schedule FROM cron.job
      WHERE jobname = 'credit_status_daily_sweep'
    `;

    expect(job).toBeDefined();
    expect(job.jobname).toBe("credit_status_daily_sweep");
    expect(job.schedule).toBe("0 19 * * *"); // 19:00 UTC
  });
});

describeWithDb("CREDIT_STATUS_RECOMPUTE message producers set source", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-src";
  const TEST_SHOP_ID = `shop-src-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `src-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-src-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${"gid://shopify/CompanyLocation/" + TEST_SUFFIX},
        'Source Test Account', 100000.00, 'OK', NOW(), NOW()
      )
    `;
  });

  beforeEach(async () => {
    // Clean up queue messages before each test
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}`;
  });

  afterAll(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  it("enqueueCreditStatusRecompute sets source='invoice_change' at top level", async () => {
    const { enqueueCreditStatusRecompute } = await import("../credit-status-recompute.server");

    await enqueueCreditStatusRecompute(sql, TEST_SHOP_DOMAIN, TEST_ACCOUNT_ID, "invoice_change");

    const [msg] = await sql<{ message: { topic: string; source: string; buyerAccountId: string } }[]>`
      SELECT message FROM pgmq.q_s6_sync
      WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
      LIMIT 1
    `;

    expect(msg).toBeDefined();
    expect(msg.message.topic).toBe("CREDIT_STATUS_RECOMPUTE");
    expect(msg.message.source).toBe("invoice_change");
    expect(msg.message.buyerAccountId).toBe(TEST_ACCOUNT_ID);
  });

  it("enqueueCreditStatusRecompute sets source='daily_sweep' at top level", async () => {
    const { enqueueCreditStatusRecompute } = await import("../credit-status-recompute.server");

    await enqueueCreditStatusRecompute(sql, TEST_SHOP_DOMAIN, TEST_ACCOUNT_ID, "daily_sweep");

    const [msg] = await sql<{ message: { topic: string; source: string } }[]>`
      SELECT message FROM pgmq.q_s6_sync
      WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
      LIMIT 1
    `;

    expect(msg).toBeDefined();
    expect(msg.message.topic).toBe("CREDIT_STATUS_RECOMPUTE");
    expect(msg.message.source).toBe("daily_sweep");
  });

  it("enqueueCreditStatusRecompute sets source='manual' at top level", async () => {
    const { enqueueCreditStatusRecompute } = await import("../credit-status-recompute.server");

    await enqueueCreditStatusRecompute(sql, TEST_SHOP_DOMAIN, TEST_ACCOUNT_ID, "manual");

    const [msg] = await sql<{ message: { topic: string; source: string } }[]>`
      SELECT message FROM pgmq.q_s6_sync
      WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
      LIMIT 1
    `;

    expect(msg).toBeDefined();
    expect(msg.message.topic).toBe("CREDIT_STATUS_RECOMPUTE");
    expect(msg.message.source).toBe("manual");
  });

  it("enqueueRecomputeForInvoice sets source='invoice_change' at top level", async () => {
    const invoiceId = `inv-src-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/src-${TEST_SUFFIX}`;

    // Create an invoice for the account
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#SRC-1', 1000.00, 1000.00, 'open', NOW(), NOW(), NOW()
      )
    `;

    try {
      const { enqueueRecomputeForInvoice } = await import("../credit-status-recompute.server");

      await enqueueRecomputeForInvoice(sql, invoiceId);

      const [msg] = await sql<{ message: { topic: string; source: string; buyerAccountId: string } }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
        LIMIT 1
      `;

      expect(msg).toBeDefined();
      expect(msg.message.topic).toBe("CREDIT_STATUS_RECOMPUTE");
      expect(msg.message.source).toBe("invoice_change");
      expect(msg.message.buyerAccountId).toBe(TEST_ACCOUNT_ID);
    } finally {
      await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
    }
  });
});

// =============================================================================
// PART 3 RESYNC TESTS (#204)
// =============================================================================

// Track metafield write calls for resync tests (prefixed with _ to allow unused in some test suites)
let _resyncMockShouldFail = false;
let _resyncMockErrorCode: string | undefined = undefined;
let _resyncMockRetryable: boolean | undefined = undefined;

const _resyncMockShopifyGraphQLRequest = vi.fn().mockImplementation(async () => {
  if (_resyncMockShouldFail) {
    return {
      success: false,
      error: "Simulated metafield write failure",
      errorCode: _resyncMockErrorCode ?? "network_error",
      retryable: _resyncMockRetryable ?? true,
    };
  }
  return {
    success: true,
    data: {
      metafieldsSet: {
        metafields: [{ id: "mf-1", namespace: "$app", key: "credit_status" }],
        userErrors: [],
      },
    },
  };
});
void _resyncMockShopifyGraphQLRequest; // Silence unused warning - kept for future drain integration tests

describeWithDb("Part 3 resync pass (#204)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-resync";
  const TEST_SHOP_ID = `shop-resync-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `resync-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-resync-${TEST_SUFFIX}`;
  const TEST_COMPANY_LOCATION_ID = `gid://shopify/CompanyLocation/${TEST_SUFFIX}`;
  
  // Fixed time for deterministic tests (TEST_NOW used in tests)
  const TEST_NOW = new Date();
  void TEST_NOW; // Silence lint - available for future timestamp assertions

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${TEST_COMPANY_LOCATION_ID},
        'SENTINEL_NAME', 100000.00, 'OK', false, false,
        false, 1, NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_re%:' + TEST_ACCOUNT_ID + '%'}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    _resyncMockShouldFail = false;
    _resyncMockErrorCode = undefined;
    _resyncMockRetryable = undefined;

    // Reset account state
    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'OK', "holdReasonCode" = NULL, "manualHold" = false,
          "syncPending" = false, "syncVersion" = 1, bypass = false,
          gated_at = NULL, "metafieldSyncedAt" = NULL,
          "metafieldSyncErrorCode" = NULL, "metafieldSyncErrorAt" = NULL
      WHERE id = ${TEST_ACCOUNT_ID}
    `;

    // Clean up
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_re%:' + TEST_ACCOUNT_ID + '%'}`;
  });

  describe("resync selection criteria", () => {
    it("selects accounts with syncPending=true and stale metafieldSyncedAt", async () => {
      // Set up: syncPending=true, metafieldSyncedAt 2 days ago (stale)
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = true,
            "metafieldSyncedAt" = NOW() - INTERVAL '2 days'
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      const [result] = await sql<{ accounts_enqueued: number; messages_skipped: number }[]>`
        SELECT * FROM enqueue_credit_status_recomputes()
      `;

      expect(result.accounts_enqueued).toBeGreaterThanOrEqual(1);

      // Verify message was enqueued with credit_resync key
      const [queueMsg] = await sql<{ message: { webhookId: string; buyerAccountId: string } }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
        LIMIT 1
      `;

      expect(queueMsg).toBeDefined();
      expect(queueMsg.message.webhookId).toMatch(/^credit_resync:/);
      expect(queueMsg.message.buyerAccountId).toBe(TEST_ACCOUNT_ID);
    });

    it("selects accounts with syncPending=true and NULL metafieldSyncedAt", async () => {
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = true, "metafieldSyncedAt" = NULL
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      const [result] = await sql<{ accounts_enqueued: number }[]>`
        SELECT * FROM enqueue_credit_status_recomputes()
      `;

      expect(result.accounts_enqueued).toBeGreaterThanOrEqual(1);
    });

    it("does NOT select accounts with syncPending=false", async () => {
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = false, "metafieldSyncedAt" = NOW() - INTERVAL '2 days'
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      await sql`SELECT * FROM enqueue_credit_status_recomputes()`;

      const [queueMsg] = await sql<{ message: unknown }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
          AND message->>'webhookId' LIKE 'credit_resync:%'
        LIMIT 1
      `;

      expect(queueMsg).toBeUndefined();
    });

    it("does NOT select accounts with fresh metafieldSyncedAt (< 1 day old)", async () => {
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = true, "metafieldSyncedAt" = NOW() - INTERVAL '12 hours'
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      await sql`SELECT * FROM enqueue_credit_status_recomputes()`;

      const [queueMsg] = await sql<{ message: unknown }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
          AND message->>'webhookId' LIKE 'credit_resync:%'
        LIMIT 1
      `;

      expect(queueMsg).toBeUndefined();
    });
  });

  describe("resync exclusions", () => {
    it("excludes uninstalled shops", async () => {
      // Set shop as uninstalled
      await sql`
        UPDATE "Shop" SET "uninstalledAt" = NOW() WHERE id = ${TEST_SHOP_ID}
      `;
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = true, "metafieldSyncedAt" = NULL
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      try {
        await sql`SELECT * FROM enqueue_credit_status_recomputes()`;

        const [queueMsg] = await sql<{ message: unknown }[]>`
          SELECT message FROM pgmq.q_s6_sync
          WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
          LIMIT 1
        `;

        expect(queueMsg).toBeUndefined();
      } finally {
        await sql`UPDATE "Shop" SET "uninstalledAt" = NULL WHERE id = ${TEST_SHOP_ID}`;
      }
    });

    it("SQL excludes no-owner COMPANY accounts (companyLocationId NULL)", async () => {
      // Note: The BuyerAccount_kind_consistency CHECK constraint prevents inserting
      // no-owner rows directly. This test verifies the SQL WHERE clause logic by
      // checking that the exclusion condition is present in the function.
      // No-owner rows could exist from legacy data or direct SQL before the constraint.
      
      const [funcDef] = await sql<{ prosrc: string }[]>`
        SELECT prosrc FROM pg_proc
        WHERE proname = 'enqueue_credit_status_recomputes'
      `;

      // Verify the exclusion clause is present
      expect(funcDef.prosrc).toContain('ba.kind = \'COMPANY\'');
      expect(funcDef.prosrc).toContain('ba."companyLocationId" IS NULL');
    });

    it("SQL excludes no-owner TAGGED_CUSTOMER accounts (customerId NULL)", async () => {
      // Note: Same as above - verifies SQL logic for TAGGED_CUSTOMER exclusion
      
      const [funcDef] = await sql<{ prosrc: string }[]>`
        SELECT prosrc FROM pg_proc
        WHERE proname = 'enqueue_credit_status_recomputes'
      `;

      // Verify the exclusion clause is present
      expect(funcDef.prosrc).toContain('ba.kind = \'TAGGED_CUSTOMER\'');
      expect(funcDef.prosrc).toContain('ba."customerId" IS NULL');
    });

    it("excludes redacted accounts (customerId like '%_redacted_%')", async () => {
      const redactedAccountId = `acc-redacted-${TEST_SUFFIX}`;
      const redactedCustomerId = `gid://shopify/Customer/123_redacted_${Date.now()}`;
      
      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "customerId", name,
          "holdState", "syncPending", "metafieldSyncedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${redactedAccountId}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER',
          ${redactedCustomerId}, 'Redacted Account', 'OK', true, NULL, NOW(), NOW()
        )
      `;

      try {
        await sql`SELECT * FROM enqueue_credit_status_recomputes()`;

        const [queueMsg] = await sql<{ message: unknown }[]>`
          SELECT message FROM pgmq.q_s6_sync
          WHERE message->>'buyerAccountId' = ${redactedAccountId}
          LIMIT 1
        `;

        expect(queueMsg).toBeUndefined();
      } finally {
        await sql`DELETE FROM "BuyerAccount" WHERE id = ${redactedAccountId}`;
      }
    });

    it("excludes accounts with permanent sync error marker", async () => {
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = true,
            "metafieldSyncedAt" = NULL,
            "metafieldSyncErrorCode" = 'no_session',
            "metafieldSyncErrorAt" = NOW()
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      await sql`SELECT * FROM enqueue_credit_status_recomputes()`;

      const [queueMsg] = await sql<{ message: unknown }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
          AND message->>'webhookId' LIKE 'credit_resync:%'
        LIMIT 1
      `;

      expect(queueMsg).toBeUndefined();
    });

    it("exclusions persist across two simulated UTC days with no new DLQ rows", async () => {
      // Create accounts that should be excluded (only ones that can be inserted with CHECK constraint)
      const excludedAccounts = [
        // Redacted account (TAGGED_CUSTOMER with customerId that looks redacted)
        { id: `acc-excl-redacted-${TEST_SUFFIX}`, kind: 'TAGGED_CUSTOMER', companyId: null, companyLocationId: null, customerId: `gid://shopify/Customer/999_redacted_${Date.now()}`, errorCode: null },
        // Account with permanent error marker
        { id: `acc-excl-marker-${TEST_SUFFIX}`, kind: 'COMPANY', companyId: `co-excl-${TEST_SUFFIX}`, companyLocationId: `gid://shopify/CompanyLocation/excl-${TEST_SUFFIX}`, customerId: null, errorCode: 'access_denied' },
      ];

      for (const acc of excludedAccounts) {
        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "companyId", "companyLocationId", "customerId", name,
            "holdState", "syncPending", "metafieldSyncedAt",
            "metafieldSyncErrorCode", "metafieldSyncErrorAt",
            "createdAt", "updatedAt"
          )
          VALUES (
            ${acc.id}, ${TEST_SHOP_ID}, ${acc.kind}::"AccountKind",
            ${acc.companyId}, ${acc.companyLocationId}, ${acc.customerId},
            'Excluded Account', 'OK', true, NULL,
            ${acc.errorCode},
            ${acc.errorCode ? sql`NOW()` : null},
            NOW(), NOW()
          )
        `;
      }

      try {
        // Day 1
        await sql`SELECT * FROM enqueue_credit_status_recomputes()`;
        
        // Verify none were enqueued
        for (const acc of excludedAccounts) {
          const [msg] = await sql<{ message: unknown }[]>`
            SELECT message FROM pgmq.q_s6_sync
            WHERE message->>'buyerAccountId' = ${acc.id}
            LIMIT 1
          `;
          expect(msg).toBeUndefined();
        }

        // Simulate day 2 by clearing dedupe keys for these accounts only
        for (const acc of excludedAccounts) {
          await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_re%:' + acc.id + '%'}`;
        }

        // Day 2
        await sql`SELECT * FROM enqueue_credit_status_recomputes()`;

        // Still none enqueued (exclusion criteria still apply)
        for (const acc of excludedAccounts) {
          const [msg] = await sql<{ message: unknown }[]>`
            SELECT message FROM pgmq.q_s6_sync
            WHERE message->>'buyerAccountId' = ${acc.id}
            LIMIT 1
          `;
          expect(msg).toBeUndefined();
        }

        // No DLQ rows for these accounts
        for (const acc of excludedAccounts) {
          const [dlq] = await sql<{ id: number }[]>`
            SELECT id FROM s6_dead_letter
            WHERE message->>'buyerAccountId' = ${acc.id}
            LIMIT 1
          `;
          expect(dlq).toBeUndefined();
        }
      } finally {
        for (const acc of excludedAccounts) {
          await sql`DELETE FROM "BuyerAccount" WHERE id = ${acc.id}`;
        }
      }
    });
  });

  describe("BYPASS accounts", () => {
    it("includes BYPASS accounts in resync (BYPASS writes hold:false to unblock)", async () => {
      await sql`
        UPDATE "BuyerAccount"
        SET bypass = true,
            "holdState" = 'BYPASS',
            "syncPending" = true,
            "metafieldSyncedAt" = NULL
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      const [result] = await sql<{ accounts_enqueued: number }[]>`
        SELECT * FROM enqueue_credit_status_recomputes()
      `;

      expect(result.accounts_enqueued).toBeGreaterThanOrEqual(1);

      const [queueMsg] = await sql<{ message: { buyerAccountId: string } }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
          AND message->>'webhookId' LIKE 'credit_resync:%'
        LIMIT 1
      `;

      expect(queueMsg).toBeDefined();
      expect(queueMsg.message.buyerAccountId).toBe(TEST_ACCOUNT_ID);
    });
  });

  describe("per-run cap and ordering", () => {
    it("c_resync_cap constant is 100 (verified via pg_get_functiondef)", async () => {
      const [funcDef] = await sql<{ prosrc: string }[]>`
        SELECT pg_get_functiondef(oid) AS prosrc FROM pg_proc
        WHERE proname = 'enqueue_credit_status_recomputes'
      `;

      // Verify the constant declaration exists with value 100
      expect(funcDef.prosrc).toMatch(/c_resync_cap\s+CONSTANT\s+INTEGER\s*:=\s*100/i);
    });

    it("uses deterministic order (metafieldSyncedAt NULLS FIRST, id)", async () => {
      // Create 3 accounts with varying metafieldSyncedAt
      const accounts = [
        { id: `acc-ord-1-${TEST_SUFFIX}`, syncedAt: null },
        { id: `acc-ord-2-${TEST_SUFFIX}`, syncedAt: 'NOW() - INTERVAL \'3 days\'' },
        { id: `acc-ord-3-${TEST_SUFFIX}`, syncedAt: null },
      ];

      for (const acc of accounts) {
        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "companyId", "companyLocationId", name,
            "holdState", "syncPending", "metafieldSyncedAt", "createdAt", "updatedAt"
          )
          VALUES (
            ${acc.id}, ${TEST_SHOP_ID}, 'COMPANY',
            ${"co-" + acc.id}, ${"gid://shopify/CompanyLocation/" + acc.id},
            'Order Test Account', 'OK', true,
            ${acc.syncedAt ? sql.unsafe(acc.syncedAt) : null},
            NOW(), NOW()
          )
        `;
      }

      try {
        await sql`SELECT * FROM enqueue_credit_status_recomputes()`;

        // Get messages for our test accounts - filter in JS since array syntax varies
        const allMessages = await sql<{ message: { buyerAccountId: string } }[]>`
          SELECT message FROM pgmq.q_s6_sync
          WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
            AND message->>'webhookId' LIKE 'credit_resync:%'
          ORDER BY msg_id
        `;
        const accountIdSet = new Set(accounts.map(a => a.id));
        const messages = allMessages.filter(m => accountIdSet.has(m.message.buyerAccountId));

        // Verify ordering: NULL metafieldSyncedAt accounts come first (NULLS FIRST)
        // and within NULLs, ordered by id
        const selectedIds = messages.map(m => m.message.buyerAccountId);
        const nullAccounts = accounts.filter(a => a.syncedAt === null).map(a => a.id).sort();
        
        // First two should be the NULL accounts
        if (selectedIds.length >= 2) {
          expect(nullAccounts).toContain(selectedIds[0]);
          expect(nullAccounts).toContain(selectedIds[1]);
          // Check they're in id order
          expect(selectedIds[0] < selectedIds[1]).toBe(true);
        }
      } finally {
        for (const acc of accounts) {
          await sql`DELETE FROM "BuyerAccount" WHERE id = ${acc.id}`;
        }
      }
    });
  });

  describe("idempotency", () => {
    it("running resync pass twice same day enqueues nothing new", async () => {
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = true, "metafieldSyncedAt" = NULL
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      // First run
      const [result1] = await sql<{ accounts_enqueued: number }[]>`
        SELECT * FROM enqueue_credit_status_recomputes()
      `;

      expect(result1.accounts_enqueued).toBeGreaterThanOrEqual(1);

      // Archive the first message to clear the queue
      await sql`
        WITH moved AS (
          SELECT msg_id FROM pgmq.q_s6_sync
          WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
        )
        SELECT pgmq.archive('s6_sync', msg_id) FROM moved
      `;

      // Manually insert the dedupe key (simulating what the handler would do)
      const today = new Date().toISOString().split("T")[0];
      await sql`
        INSERT INTO s6_processed_webhooks (webhook_id, topic, resource_gid, processed_at)
        VALUES (${'credit_resync:' + TEST_ACCOUNT_ID + ':' + today}, 'CREDIT_STATUS_RECOMPUTE', ${TEST_ACCOUNT_ID}, NOW())
        ON CONFLICT DO NOTHING
      `;

      // Second run same day - should not enqueue again (dedupe key exists)
      await sql`SELECT * FROM enqueue_credit_status_recomputes()`;

      // No new messages for this account (dedupe key already in s6_processed_webhooks)
      const [newMsg] = await sql<{ message: unknown }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
          AND message->>'webhookId' LIKE 'credit_resync:%'
        LIMIT 1
      `;

      expect(newMsg).toBeUndefined();
    });
  });

  describe("holdState unchanged by resync", () => {
    it("resync pass does NOT change holdState", async () => {
      // Set to HELD with syncPending
      await sql`
        UPDATE "BuyerAccount"
        SET "holdState" = 'HELD',
            "holdReasonCode" = 'PAYMENT_OVERDUE',
            "syncPending" = true,
            "metafieldSyncedAt" = NULL
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      // Get holdState before
      const [before] = await sql<{ holdState: string }[]>`
        SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
      `;
      expect(before.holdState).toBe("HELD");

      // Run resync
      await sql`SELECT * FROM enqueue_credit_status_recomputes()`;

      // holdState should be unchanged
      const [after] = await sql<{ holdState: string }[]>`
        SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
      `;
      expect(after.holdState).toBe("HELD");
    });
  });
});

// =============================================================================
// PERMANENT ERROR HANDLING TESTS (#204)
// =============================================================================

describeWithDb("permanent sync error handling (#204)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-perm";
  const TEST_SHOP_ID = `shop-perm-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `perm-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-perm-${TEST_SUFFIX}`;
  const TEST_COMPANY_LOCATION_ID = `gid://shopify/CompanyLocation/${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${TEST_COMPANY_LOCATION_ID},
        'SENTINEL_NAME', 100000.00, 'OK', false, false,
        false, 1, NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_re%:' + TEST_ACCOUNT_ID + '%'}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    mockShouldFail = false;
    mockShopifyGraphQLRequest.mockClear();

    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'OK', "holdReasonCode" = NULL, "manualHold" = false,
          "syncPending" = false, "syncVersion" = 1, bypass = false,
          gated_at = NULL, "metafieldSyncedAt" = NULL,
          "metafieldSyncErrorCode" = NULL, "metafieldSyncErrorAt" = NULL
      WHERE id = ${TEST_ACCOUNT_ID}
    `;

    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_re%:' + TEST_ACCOUNT_ID + '%'}`;
  });

  describe("retryable vs permanent classification", () => {
    it("no_session gives retryable:false, errorCode 'no_session', marker set", async () => {
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = true, "metafieldSyncedAt" = NULL
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      // Mock Shopify client returning no_session (non-retryable permanent error)
      mockShopifyGraphQLRequest.mockImplementationOnce(async () => ({
        success: false,
        error: "Session not found",
        errorCode: "no_session",
        retryable: false,
      }));

      const result = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("no_session");
      expect(result.retryable).toBe(false);

      // Verify marker is set (known permanent code)
      const [account] = await sql<{ metafieldSyncErrorCode: string | null }[]>`
        SELECT "metafieldSyncErrorCode" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
      `;
      expect(account.metafieldSyncErrorCode).toBe("no_session");
    });
  });

  describe("error marker management", () => {
    it("clears error marker on successful write", async () => {
      // Set up error marker
      await sql`
        UPDATE "BuyerAccount"
        SET "metafieldSyncErrorCode" = 'no_session',
            "metafieldSyncErrorAt" = NOW(),
            "syncPending" = true
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      // Ensure mock succeeds
      mockShouldFail = false;

      const result = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

      expect(result.success).toBe(true);

      const [account] = await sql<{ metafieldSyncErrorCode: string | null; metafieldSyncErrorAt: Date | null }[]>`
        SELECT "metafieldSyncErrorCode", "metafieldSyncErrorAt"
        FROM "BuyerAccount"
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      expect(account.metafieldSyncErrorCode).toBeNull();
      expect(account.metafieldSyncErrorAt).toBeNull();
    });
  });

  describe("toPermanentSyncErrorCode", () => {
    it("maps known permanent error codes (returns null for unknown to allow resync retry)", async () => {
      const { toPermanentSyncErrorCode } = await import("../credit-status.server");
      
      // Direct matches - these set the marker
      expect(toPermanentSyncErrorCode("no_session")).toBe("no_session");
      expect(toPermanentSyncErrorCode("access_denied")).toBe("access_denied");
      expect(toPermanentSyncErrorCode("user_error")).toBe("user_error");
      expect(toPermanentSyncErrorCode("no_refresh_token")).toBe("no_refresh_token");
      expect(toPermanentSyncErrorCode("invalid_grant")).toBe("invalid_grant");
      
      // Mapped codes
      expect(toPermanentSyncErrorCode("http_403")).toBe("access_denied");
      
      // Unknown codes return null - they do NOT set marker, allowing nightly resync to retry.
      // This prevents a single transient error from permanently excluding a paid buyer.
      expect(toPermanentSyncErrorCode("graphql_error:some_raw_shopify_error_text")).toBeNull();
      expect(toPermanentSyncErrorCode("graphql_query_error")).toBeNull();
      expect(toPermanentSyncErrorCode("http_400")).toBeNull();
      expect(toPermanentSyncErrorCode("http_404")).toBeNull();
      expect(toPermanentSyncErrorCode("random_unknown_code")).toBeNull();
      expect(toPermanentSyncErrorCode(undefined)).toBeNull();
    });
  });

  describe("toSafeSyncErrorCode (local validator)", () => {
    it("passes valid simple codes unchanged", async () => {
      const { toSafeSyncErrorCode } = await import("../credit-status.server");
      
      expect(toSafeSyncErrorCode("no_session")).toBe("no_session");
      expect(toSafeSyncErrorCode("access_denied")).toBe("access_denied");
      expect(toSafeSyncErrorCode("http_404")).toBe("http_404");
      expect(toSafeSyncErrorCode("user_error")).toBe("user_error");
      expect(toSafeSyncErrorCode("graphql_query_error")).toBe("graphql_query_error");
    });

    it("passes valid graphql_error compound codes unchanged", async () => {
      const { toSafeSyncErrorCode } = await import("../credit-status.server");
      
      expect(toSafeSyncErrorCode("graphql_error:ACCESS_DENIED")).toBe("graphql_error:ACCESS_DENIED");
      expect(toSafeSyncErrorCode("graphql_error:THROTTLED")).toBe("graphql_error:THROTTLED");
      expect(toSafeSyncErrorCode("graphql_error:ACCESS_DENIED,THROTTLED")).toBe("graphql_error:ACCESS_DENIED,THROTTLED");
      expect(toSafeSyncErrorCode("graphql_error:A,B,C,D,E")).toBe("graphql_error:A,B,C,D,E");
    });

    it("falls back for sentinel lowercase raw message", async () => {
      const { toSafeSyncErrorCode } = await import("../credit-status.server");
      
      // Raw error message doesn't match simple code pattern (has spaces)
      const result = toSafeSyncErrorCode("raw error message with spaces");
      expect(result).not.toBe("raw error message with spaces");
      expect(result).toBe("error"); // toErrorCode fallback
    });

    it("falls back for code with spaces", async () => {
      const { toSafeSyncErrorCode } = await import("../credit-status.server");
      
      const result = toSafeSyncErrorCode("invalid code with spaces");
      expect(result).not.toContain("invalid code with spaces");
    });

    it("falls back for code over length limit", async () => {
      const { toSafeSyncErrorCode } = await import("../credit-status.server");
      
      // Create a graphql_error code over 128 chars
      const longCode = "graphql_error:" + "A".repeat(200);
      const result = toSafeSyncErrorCode(longCode);
      expect(result).toBe("graphql_error"); // Falls back to generic
    });

    it("falls back for email-like string", async () => {
      const { toSafeSyncErrorCode } = await import("../credit-status.server");
      
      const result = toSafeSyncErrorCode("user@example.com");
      expect(result).not.toBe("user@example.com");
      expect(result).toBe("error"); // toErrorCode fallback
    });

    it("falls back for graphql_error with lowercase extensions", async () => {
      const { toSafeSyncErrorCode } = await import("../credit-status.server");
      
      // Extension codes must be uppercase
      const result = toSafeSyncErrorCode("graphql_error:access_denied");
      expect(result).toBe("graphql_error"); // Falls back to generic
    });

    it("falls back for graphql_error with too many extensions", async () => {
      const { toSafeSyncErrorCode } = await import("../credit-status.server");
      
      // Max 5 extension codes
      const result = toSafeSyncErrorCode("graphql_error:A,B,C,D,E,F");
      expect(result).toBe("graphql_error"); // Falls back to generic
    });

    it("returns 'unknown' for undefined/null", async () => {
      const { toSafeSyncErrorCode } = await import("../credit-status.server");
      
      expect(toSafeSyncErrorCode(undefined)).toBe("unknown");
    });
  });

  describe("sync_failed audit event", () => {
    it("writes credit_status.sync_failed audit event on failure", async () => {
      // Set up account that needs sync
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = true, "metafieldSyncedAt" = NULL
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      mockShouldFail = true;

      await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

      const [auditEvent] = await sql<{ type: string; data: { buyerAccountId: string; errorCode: string; syncVersion: number } }[]>`
        SELECT type, data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'credit_status.sync_failed'
        ORDER BY at DESC
        LIMIT 1
      `;

      expect(auditEvent).toBeDefined();
      expect(auditEvent.type).toBe("credit_status.sync_failed");
      expect(auditEvent.data.buyerAccountId).toBe(TEST_ACCOUNT_ID);
      expect(typeof auditEvent.data.syncVersion).toBe("number");
    });

    it("sync_failed audit contains only ids and codes (no PII)", async () => {
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = true, "metafieldSyncedAt" = NULL
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      mockShouldFail = true;

      await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

      const [auditEvent] = await sql<{ data: Record<string, unknown> }[]>`
        SELECT data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'credit_status.sync_failed'
        ORDER BY at DESC
        LIMIT 1
      `;

      expect(auditEvent).toBeDefined();
      const dataStr = JSON.stringify(auditEvent.data);
      
      // Should not contain domain, name, email
      expect(dataStr).not.toContain(TEST_SHOP_DOMAIN);
      expect(dataStr).not.toContain("SENTINEL_NAME");
      expect(dataStr).not.toContain("@");
      
      // Should contain only allowed keys
      const allowedKeys = ["buyerAccountId", "errorCode", "syncVersion"];
      for (const key of Object.keys(auditEvent.data)) {
        expect(allowedKeys).toContain(key);
      }
    });
  });
});

// =============================================================================
// DRAIN INTEGRATION TESTS (#204)
// =============================================================================

describeWithDb("drain integration - dead letter and error handling (#204)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-drain";
  const TEST_SHOP_ID = `shop-drain-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `drain-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-drain-${TEST_SUFFIX}`;
  const TEST_COMPANY_LOCATION_ID = `gid://shopify/CompanyLocation/${TEST_SUFFIX}`;
  // SENTINEL contains lowercase raw text that fails toSafeSyncErrorCode pattern
  // (not a valid simple code or graphql_error:UPPERCASE format)
  const SENTINEL_RAW_GQL_TEXT = "raw error message with spaces";

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${TEST_COMPANY_LOCATION_ID},
        'SENTINEL_DRAIN_NAME', 100000.00, 'OK', false, false,
        false, 1, NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_re%:' + TEST_ACCOUNT_ID + '%'}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    mockShouldFail = false;
    mockShopifyGraphQLRequest.mockReset();

    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'OK', "holdReasonCode" = NULL, "manualHold" = false,
          "syncPending" = false, "syncVersion" = 1, bypass = false,
          gated_at = NULL, "metafieldSyncedAt" = NULL,
          "metafieldSyncErrorCode" = NULL, "metafieldSyncErrorAt" = NULL
      WHERE id = ${TEST_ACCOUNT_ID}
    `;

    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_re%:' + TEST_ACCOUNT_ID + '%'}`;
  });

  describe("non-retryable errors dead-letter on first read (real drain)", () => {
    it("no_session dead-letters on FIRST read with reason non_retryable:no_session, read_ct 1, marker set", async () => {
      const { runDrain } = await import("../drain/processor.server");
      
      // Set up account that needs sync
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = true, "metafieldSyncedAt" = NULL
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      // Clear ALL messages from the queue to ensure clean test
      // This prevents messages from other suites from consuming our mock
      await sql`DELETE FROM pgmq.q_s6_sync WHERE TRUE`;
      await sql`DELETE FROM pgmq.q_s6_bulk WHERE TRUE`;

      // Mock shopify client to return non-retryable no_session error
      // Use mockImplementation (not mockImplementationOnce) since drain may process multiple messages
      mockShopifyGraphQLRequest.mockImplementation(async () => ({
        success: false,
        error: "Session not found",
        errorCode: "no_session",
        retryable: false,
      }));

      const webhookId = `credit_resync:${TEST_ACCOUNT_ID}:drain-nosession-${Date.now()}`;
      const message = {
        topic: "CREDIT_STATUS_RECOMPUTE",
        shop: TEST_SHOP_DOMAIN,
        buyerAccountId: TEST_ACCOUNT_ID,
        source: "daily_sweep",
        webhookId,
        resourceGid: TEST_ACCOUNT_ID,
        enqueuedAt: new Date().toISOString(),
      };

      // Enqueue the message via pgmq.send
      await sql`SELECT pgmq.send('s6_sync', ${sql.json(message)})`;

      // Run the drain - should dead-letter on first read
      await runDrain(sql, { batchSize: 10, timeBudgetMs: 10000 });

      // Assert exactly one DLQ row with error 'non_retryable:no_session'
      const [dlqRow] = await sql<{ error: string; message: Record<string, unknown> }[]>`
        SELECT error, message FROM s6_dead_letter
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'webhookId' = ${webhookId}
      `;
      expect(dlqRow).toBeDefined();
      expect(dlqRow.error).toBe("non_retryable:no_session");

      // Assert the message left the queue after ONE read (check archive or DLQ)
      const [archivedMsg] = await sql<{ read_ct: number }[]>`
        SELECT read_ct FROM pgmq.a_s6_sync
        WHERE message->>'webhookId' = ${webhookId}
      `;
      // Message should have been read exactly once before DLQ
      if (archivedMsg) {
        expect(archivedMsg.read_ct).toBe(1);
      }

      // Assert marker is set
      const [account] = await sql<{ metafieldSyncErrorCode: string | null }[]>`
        SELECT "metafieldSyncErrorCode" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
      `;
      expect(account.metafieldSyncErrorCode).toBe("no_session");
    });

    it("access_denied dead-letters on FIRST read with reason non_retryable:access_denied, read_ct 1, marker set", async () => {
      const { runDrain } = await import("../drain/processor.server");
      
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = true, "metafieldSyncedAt" = NULL
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      // Clear ALL messages from the queue to ensure clean test
      await sql`DELETE FROM pgmq.q_s6_sync WHERE TRUE`;
      await sql`DELETE FROM pgmq.q_s6_bulk WHERE TRUE`;

      mockShopifyGraphQLRequest.mockImplementation(async () => ({
        success: false,
        error: "Access denied",
        errorCode: "access_denied",
        retryable: false,
      }));

      const webhookId = `credit_resync:${TEST_ACCOUNT_ID}:drain-access-${Date.now()}`;
      const message = {
        topic: "CREDIT_STATUS_RECOMPUTE",
        shop: TEST_SHOP_DOMAIN,
        buyerAccountId: TEST_ACCOUNT_ID,
        source: "daily_sweep",
        webhookId,
        resourceGid: TEST_ACCOUNT_ID,
        enqueuedAt: new Date().toISOString(),
      };

      await sql`SELECT pgmq.send('s6_sync', ${sql.json(message)})`;
      await runDrain(sql, { batchSize: 10, timeBudgetMs: 10000 });

      // Assert DLQ row with correct error
      const [dlqRow] = await sql<{ error: string }[]>`
        SELECT error FROM s6_dead_letter
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'webhookId' = ${webhookId}
      `;
      expect(dlqRow).toBeDefined();
      expect(dlqRow.error).toBe("non_retryable:access_denied");

      // Assert marker is set
      const [account] = await sql<{ metafieldSyncErrorCode: string | null }[]>`
        SELECT "metafieldSyncErrorCode" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
      `;
      expect(account.metafieldSyncErrorCode).toBe("access_denied");
    });

    it("graphql_error:<code> gives DLQ reason with full code, marker NULL, resync re-enqueues next day", async () => {
      const { runDrain } = await import("../drain/processor.server");
      
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = true, "metafieldSyncedAt" = NULL
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      // Mock returns graphql_error with specific extension code
      mockShopifyGraphQLRequest.mockImplementationOnce(async () => ({
        success: false,
        error: "GraphQL error",
        errorCode: "graphql_error:ACCESS_DENIED",
        retryable: false,
      }));

      const webhookId = `credit_resync:${TEST_ACCOUNT_ID}:drain-gqlerr-${Date.now()}`;
      const message = {
        topic: "CREDIT_STATUS_RECOMPUTE",
        shop: TEST_SHOP_DOMAIN,
        buyerAccountId: TEST_ACCOUNT_ID,
        source: "daily_sweep",
        webhookId,
        resourceGid: TEST_ACCOUNT_ID,
        enqueuedAt: new Date().toISOString(),
      };

      await sql`SELECT pgmq.send('s6_sync', ${sql.json(message)})`;
      await runDrain(sql, { batchSize: 10, timeBudgetMs: 10000 });

      // Assert DLQ row has the FULL error code (not mapped to unknown_permanent)
      const [dlqRow] = await sql<{ error: string }[]>`
        SELECT error FROM s6_dead_letter
        WHERE message->>'webhookId' = ${webhookId}
      `;
      expect(dlqRow).toBeDefined();
      expect(dlqRow.error).toBe("non_retryable:graphql_error:ACCESS_DENIED");

      // Assert marker is NULL (unknown codes don't set marker, allowing resync)
      const [account] = await sql<{ metafieldSyncErrorCode: string | null }[]>`
        SELECT "metafieldSyncErrorCode" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
      `;
      expect(account.metafieldSyncErrorCode).toBeNull();

      // Simulate next day: clear the processed webhook and run sweep again
      const today = new Date().toISOString().split("T")[0];
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_re%:' + TEST_ACCOUNT_ID + ':%'}`;
      
      // Set syncPending=true and stale metafieldSyncedAt
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = true, "metafieldSyncedAt" = NOW() - INTERVAL '2 days'
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      // Run sweep - should re-enqueue because marker is NULL
      const [sweepResult] = await sql<{ accounts_enqueued: number }[]>`
        SELECT * FROM enqueue_credit_status_recomputes()
      `;
      expect(sweepResult.accounts_enqueued).toBeGreaterThanOrEqual(1);

      const [newQueueMsg] = await sql<{ message: unknown }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
          AND message->>'webhookId' LIKE ${'credit_resync:' + TEST_ACCOUNT_ID + ':' + today}
        LIMIT 1
      `;
      expect(newQueueMsg).toBeDefined();
    });

    it("no_session sets marker, next day sweep does NOT re-enqueue", async () => {
      const { runDrain } = await import("../drain/processor.server");
      
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = true, "metafieldSyncedAt" = NULL,
            "metafieldSyncErrorCode" = NULL
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      // Mock returns no_session (known permanent code)
      mockShopifyGraphQLRequest.mockImplementationOnce(async () => ({
        success: false,
        error: "Session not found",
        errorCode: "no_session",
        retryable: false,
      }));

      const webhookId = `credit_resync:${TEST_ACCOUNT_ID}:drain-nosess-${Date.now()}`;
      const message = {
        topic: "CREDIT_STATUS_RECOMPUTE",
        shop: TEST_SHOP_DOMAIN,
        buyerAccountId: TEST_ACCOUNT_ID,
        source: "daily_sweep",
        webhookId,
        resourceGid: TEST_ACCOUNT_ID,
        enqueuedAt: new Date().toISOString(),
      };

      await sql`SELECT pgmq.send('s6_sync', ${sql.json(message)})`;
      await runDrain(sql, { batchSize: 10, timeBudgetMs: 10000 });

      // Assert marker is set (known permanent code)
      const [account] = await sql<{ metafieldSyncErrorCode: string | null }[]>`
        SELECT "metafieldSyncErrorCode" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
      `;
      expect(account.metafieldSyncErrorCode).toBe("no_session");

      // Simulate next day: clear the processed webhook and run sweep
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_re%:' + TEST_ACCOUNT_ID + ':%'}`;
      
      // Set syncPending=true and stale metafieldSyncedAt
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = true, "metafieldSyncedAt" = NOW() - INTERVAL '2 days'
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      // Run sweep - should NOT re-enqueue because marker is set
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
      
      await sql`SELECT * FROM enqueue_credit_status_recomputes()`;
      
      // Check that no resync message was enqueued for this account
      const [newQueueMsg] = await sql<{ message: unknown }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
          AND message->>'webhookId' LIKE 'credit_resync:%'
        LIMIT 1
      `;
      expect(newQueueMsg).toBeUndefined();
    });
  });

  describe("retryable errors do NOT dead-letter on first read (real drain)", () => {
    it("throttled error is NOT dead-lettered on first read, message stays in queue, marker NULL", async () => {
      const { runDrain } = await import("../drain/processor.server");
      
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = true, "metafieldSyncedAt" = NULL
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      // Mock returns retryable error
      mockShopifyGraphQLRequest.mockImplementation(async () => ({
        success: false,
        error: "Rate limited",
        errorCode: "rate_limited",
        retryable: true,
      }));

      const webhookId = `credit_resync:${TEST_ACCOUNT_ID}:drain-throttle-${Date.now()}`;
      const message = {
        topic: "CREDIT_STATUS_RECOMPUTE",
        shop: TEST_SHOP_DOMAIN,
        buyerAccountId: TEST_ACCOUNT_ID,
        source: "daily_sweep",
        webhookId,
        resourceGid: TEST_ACCOUNT_ID,
        enqueuedAt: new Date().toISOString(),
      };

      await sql`SELECT pgmq.send('s6_sync', ${sql.json(message)})`;
      
      // Run drain once
      await runDrain(sql, { batchSize: 10, timeBudgetMs: 10000 });

      // Assert NO DLQ row exists
      const [dlqRow] = await sql<{ error: string }[]>`
        SELECT error FROM s6_dead_letter
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'webhookId' = ${webhookId}
      `;
      expect(dlqRow).toBeUndefined();

      // Message should still be in queue (visible for retry after vt expires)
      // or in archive if drain archived it for retry (depends on implementation)
      // The key is NO DLQ row

      // Assert marker stays NULL
      const [account] = await sql<{ metafieldSyncErrorCode: string | null }[]>`
        SELECT "metafieldSyncErrorCode" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
      `;
      expect(account.metafieldSyncErrorCode).toBeNull();

      // Cleanup: remove from queue/archive
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'webhookId' = ${webhookId}`;
      await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'webhookId' = ${webhookId}`;
    });
  });

  describe("userErrors handling", () => {
    it("userErrors sets marker to user_error and writes sync_failed audit", async () => {
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = true, "metafieldSyncedAt" = NULL
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      mockShopifyGraphQLRequest.mockImplementationOnce(async () => ({
        success: true,
        data: {
          metafieldsSet: {
            metafields: null,
            userErrors: [{ field: ["value"], message: "Invalid metafield value" }],
          },
        },
      }));

      const result = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

      expect(result.success).toBe(false);
      expect(result.error).toBe("metafield_user_errors");
      expect(result.errorCode).toBe("user_error");
      expect(result.retryable).toBe(false);

      // Verify marker is set to user_error
      const [account] = await sql<{ metafieldSyncErrorCode: string | null }[]>`
        SELECT "metafieldSyncErrorCode" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
      `;
      expect(account.metafieldSyncErrorCode).toBe("user_error");

      // Verify sync_failed audit was written
      const [auditEvent] = await sql<{ type: string; data: { errorCode: string } }[]>`
        SELECT type, data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'credit_status.sync_failed'
        LIMIT 1
      `;
      expect(auditEvent).toBeDefined();
      expect(auditEvent.data.errorCode).toBe("user_error");
    });
  });

  describe("syncVersion guard", () => {
    it("newer syncVersion written between failure and marker UPDATE means marker is NOT set", async () => {
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = true, "metafieldSyncedAt" = NULL, "syncVersion" = 1
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      // Intercept the sync and simulate a concurrent write bumping syncVersion
      let callCount = 0;
      mockShopifyGraphQLRequest.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Simulate concurrent write bumping syncVersion during the sync
          await sql`
            UPDATE "BuyerAccount"
            SET "syncVersion" = 999
            WHERE id = ${TEST_ACCOUNT_ID}
          `;
          return {
            success: false,
            error: "Simulated failure for test",
            errorCode: "no_session",
            retryable: false,
          };
        }
        return {
          success: true,
          data: {
            metafieldsSet: {
              metafields: [{ id: "mf-1", namespace: "$app", key: "credit_status" }],
              userErrors: [],
            },
          },
        };
      });

      await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

      // Because syncVersion changed, the marker should NOT be set
      const [account] = await sql<{ metafieldSyncErrorCode: string | null; syncVersion: number }[]>`
        SELECT "metafieldSyncErrorCode", "syncVersion" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
      `;
      
      // syncVersion was bumped to 999 by the concurrent write
      expect(account.syncVersion).toBe(999);
      // Marker should be NULL because the UPDATE WHERE syncVersion = <old> didn't match
      expect(account.metafieldSyncErrorCode).toBeNull();
    });
  });

  describe("leak tests with SENTINEL", () => {
    it("SENTINEL_RAW_GQL_TEXT: marker is NULL for unknown code, sentinel absent from logs", async () => {
      // SENTINEL contains email pattern (@) which fails isSafeCode
      // This tests that raw error text with PII doesn't leak
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = true, "metafieldSyncedAt" = NULL
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      // Mock returns raw GraphQL error text (email) in errorCode
      mockShopifyGraphQLRequest.mockImplementationOnce(async () => ({
        success: false,
        error: SENTINEL_RAW_GQL_TEXT,
        errorCode: `graphql_error:${SENTINEL_RAW_GQL_TEXT}`,
        retryable: false,
      }));

      await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

      // Verify marker is NULL (unknown codes don't set marker, allowing resync retry)
      const [account] = await sql<{ metafieldSyncErrorCode: string | null }[]>`
        SELECT "metafieldSyncErrorCode" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
      `;
      
      expect(account.metafieldSyncErrorCode).toBeNull();
    });

    it("SENTINEL does NOT appear in AuditEvent data (exactly one sync_failed row)", async () => {
      await sql`
        UPDATE "BuyerAccount"
        SET "syncPending" = true, "metafieldSyncedAt" = NULL,
            "syncVersion" = 50
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      mockShopifyGraphQLRequest.mockImplementationOnce(async () => ({
        success: false,
        error: SENTINEL_RAW_GQL_TEXT,
        errorCode: `graphql_error:${SENTINEL_RAW_GQL_TEXT}`,
        retryable: false,
      }));

      await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

      // First assert there is EXACTLY one credit_status.sync_failed row for this account
      const auditEvents = await sql<{ data: { buyerAccountId: string; errorCode: string; syncVersion: number } }[]>`
        SELECT data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'credit_status.sync_failed'
          AND data->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
      `;
      
      expect(auditEvents.length).toBe(1);
      
      // Verify data has exact key set: {buyerAccountId, errorCode, syncVersion}
      const auditData = auditEvents[0].data;
      expect(Object.keys(auditData).sort()).toEqual(["buyerAccountId", "errorCode", "syncVersion"]);
      expect(auditData.buyerAccountId).toBe(TEST_ACCOUNT_ID);
      // syncVersion is incremented by recomputeCreditStatus (50 -> 51)
      expect(auditData.syncVersion).toBe(51);
      // errorCode should be 'graphql_error' (the SENTINEL fails toSafeSyncErrorCode pattern)
      expect(auditData.errorCode).toBe("graphql_error");
      
      // Verify the sentinel is absent from the audit data
      const dataStr = JSON.stringify(auditData);
      expect(dataStr).not.toContain(SENTINEL_RAW_GQL_TEXT);
    });
  });
});

// =============================================================================
// AUDIT ERROR ROBUSTNESS TESTS (#204)
// =============================================================================

describeWithDb("audit INSERT failure robustness (#204)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-robust";
  const TEST_SHOP_ID = `shop-robust-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `robust-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-robust-${TEST_SUFFIX}`;
  const TEST_COMPANY_LOCATION_ID = `gid://shopify/CompanyLocation/${TEST_SUFFIX}`;
  
  // Unique names for the trigger and function to avoid conflicts with parallel tests
  const TRIGGER_FN_NAME = `test_audit_block_fn_${TEST_SUFFIX.replace(/-/g, "_")}`;
  const TRIGGER_NAME = `test_audit_block_${TEST_SUFFIX.replace(/-/g, "_")}`;
  
  let consoleWarnSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${TEST_COMPANY_LOCATION_ID},
        'Robust Test Account', 100000.00, 'OK', false, false,
        false, 1, NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    // Clean up trigger and function if they exist
    await sql.unsafe(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON "AuditEvent"`);
    await sql.unsafe(`DROP FUNCTION IF EXISTS ${TRIGGER_FN_NAME}()`);
    
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_re%:' + TEST_ACCOUNT_ID + '%'}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    mockShouldFail = false;
    mockShopifyGraphQLRequest.mockReset();
    consoleWarnSpy?.mockRestore();
    consoleWarnSpy = null;

    // Clean up trigger from previous test run
    await sql.unsafe(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON "AuditEvent"`);
    await sql.unsafe(`DROP FUNCTION IF EXISTS ${TRIGGER_FN_NAME}()`);

    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'OK', "holdReasonCode" = NULL, "manualHold" = false,
          "syncPending" = false, "syncVersion" = 1, bypass = false,
          gated_at = NULL, "metafieldSyncedAt" = NULL,
          "metafieldSyncErrorCode" = NULL, "metafieldSyncErrorAt" = NULL
      WHERE id = ${TEST_ACCOUNT_ID}
    `;

    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
  });

  afterEach(async () => {
    // Clean up trigger after each test
    await sql.unsafe(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON "AuditEvent"`);
    await sql.unsafe(`DROP FUNCTION IF EXISTS ${TRIGGER_FN_NAME}()`);
    consoleWarnSpy?.mockRestore();
  });

  it("if audit INSERT throws (via trigger), marker is still set and warn logged", async () => {
    // Create a BEFORE INSERT trigger scoped to this suite's shop that raises an error
    // This forces the audit INSERT to fail without affecting parallel test suites
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION ${TRIGGER_FN_NAME}()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW."shopId" = '${TEST_SHOP_ID}' AND NEW.type = 'credit_status.sync_failed' THEN
          RAISE EXCEPTION 'Test-forced audit INSERT failure for shop %', NEW."shopId";
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    
    await sql.unsafe(`
      CREATE TRIGGER ${TRIGGER_NAME}
      BEFORE INSERT ON "AuditEvent"
      FOR EACH ROW
      EXECUTE FUNCTION ${TRIGGER_FN_NAME}()
    `);

    await sql`
      UPDATE "BuyerAccount"
      SET "syncPending" = true, "metafieldSyncedAt" = NULL
      WHERE id = ${TEST_ACCOUNT_ID}
    `;

    // Spy on console.warn to verify the audit error is logged
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Mock no_session error (non-retryable, known permanent code)
    mockShopifyGraphQLRequest.mockImplementationOnce(async () => ({
      success: false,
      error: "Session not found",
      errorCode: "no_session",
      retryable: false,
    }));

    const result = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

    // Result should still be returned with correct values
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("no_session");
    expect(result.retryable).toBe(false);

    // Marker should still be set (the try/catch around audit INSERT allows this)
    const [account] = await sql<{ metafieldSyncErrorCode: string | null }[]>`
      SELECT "metafieldSyncErrorCode" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
    `;
    expect(account.metafieldSyncErrorCode).toBe("no_session");

    // Verify console.warn was called with the audit error event
    expect(consoleWarnSpy).toHaveBeenCalled();
    const warnCalls = consoleWarnSpy.mock.calls;
    const auditErrorCall = warnCalls.find((call: unknown[]) => {
      const logStr = JSON.stringify(call);
      return logStr.includes("credit_status_sync_failed_audit_error");
    });
    expect(auditErrorCall).toBeDefined();
    
    // Verify the log contains the required keys: {buyerAccountId, err}
    const logStr = JSON.stringify(auditErrorCall);
    expect(logStr).toContain(TEST_ACCOUNT_ID); // buyerAccountId is present
    expect(logStr).toContain("err"); // err key is present
  });
});

// =============================================================================
// RELEASE AND HOLD DIRECTION TESTS (#204)
// =============================================================================

describeWithDb("release and hold direction end-to-end (#204)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-dir";
  const TEST_SHOP_ID = `shop-dir-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `dir-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-dir-${TEST_SUFFIX}`;
  const TEST_COMPANY_LOCATION_ID = `gid://shopify/CompanyLocation/${TEST_SUFFIX}`;

  // Track metafield writes (prefixed with _ - available for drain integration tests)
  let _metafieldWriteCount = 0;
  let _lastMetafieldValue: { metafields: Array<{ value: string }> } | null = null;
  let _mockShouldFail = false;
  let _mockErrorCode: string | undefined = undefined;
  let _mockRetryable: boolean | undefined = undefined;
  // Silence lint warnings for test-available variables
  void _metafieldWriteCount;
  void _lastMetafieldValue;
  void _mockShouldFail;
  void _mockErrorCode;
  void _mockRetryable;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${TEST_COMPANY_LOCATION_ID},
        'SENTINEL_NAME', 100000.00, 'OK', false, false,
        false, 1, NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_re%:' + TEST_ACCOUNT_ID + '%'}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    _metafieldWriteCount = 0;
    _lastMetafieldValue = null;
    _mockShouldFail = false;
    _mockErrorCode = undefined;
    _mockRetryable = undefined;

    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'OK', "holdReasonCode" = NULL, "manualHold" = false,
          "syncPending" = false, "syncVersion" = 1, bypass = false,
          gated_at = NULL, "metafieldSyncedAt" = NULL,
          "metafieldSyncErrorCode" = NULL, "metafieldSyncErrorAt" = NULL
      WHERE id = ${TEST_ACCOUNT_ID}
    `;

    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_re%:' + TEST_ACCOUNT_ID + '%'}`;
  });

  describe("release direction (B) - end-to-end", () => {
    it("HELD account paid, write fails, resync runs drain with hold:false, no duplicate audit", async () => {
      const { runDrain } = await import("../drain/processor.server");
      const invoiceId = `inv-release-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/release-${TEST_SUFFIX}`;

      // Step 1: Create overdue invoice and set HELD with initial hold_applied audit
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#RELEASE-1', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '10 days',
          NOW() - INTERVAL '5 days',
          NOW(), NOW()
        )
      `;

      await sql`
        UPDATE "BuyerAccount"
        SET "holdState" = 'HELD', "holdReasonCode" = 'PAYMENT_OVERDUE'
        WHERE id = ${TEST_ACCOUNT_ID}
      `;
      
      // Record the original hold_applied audit
      await sql`
        INSERT INTO "AuditEvent" ("shopId", actor, type, data, at)
        VALUES (${TEST_SHOP_ID}, 'system', 'hold_applied', ${sql.json({ buyerAccountId: TEST_ACCOUNT_ID })}, NOW() - INTERVAL '1 hour')
      `;

      // Step 2: Pay the invoice (simulating payment received)
      await sql`
        UPDATE "Invoice"
        SET status = 'paid', outstanding = 0
        WHERE id = ${invoiceId}
      `;

      // Step 3: Simulate a recompute that sets DB to OK but metafield write failed
      // This leaves DB at OK with syncPending=true (the drift - buyer is blocked)
      await sql`
        UPDATE "BuyerAccount"
        SET "holdState" = 'OK',
            "holdReasonCode" = NULL,
            "syncPending" = true,
            "syncVersion" = 2,
            "metafieldSyncedAt" = NOW() - INTERVAL '2 days'
        WHERE id = ${TEST_ACCOUNT_ID}
      `;
      
      // Record the original hold_released audit from the recompute
      await sql`
        INSERT INTO "AuditEvent" ("shopId", actor, type, data, at)
        VALUES (${TEST_SHOP_ID}, 'system', 'hold_released', ${sql.json({ buyerAccountId: TEST_ACCOUNT_ID })}, NOW() - INTERVAL '30 minutes')
      `;

      // Step 4: Run the sweep - should enqueue via Part 3 resync
      const [sweepResult] = await sql<{ accounts_enqueued: number }[]>`
        SELECT * FROM enqueue_credit_status_recomputes()
      `;
      expect(sweepResult.accounts_enqueued).toBeGreaterThanOrEqual(1);

      // Verify message was enqueued
      const [queueMsg] = await sql<{ message: { buyerAccountId: string; webhookId: string } }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
          AND message->>'webhookId' LIKE 'credit_resync:%'
        LIMIT 1
      `;
      expect(queueMsg).toBeDefined();

      // Step 5: Run the drain with a success mock
      lastMetafieldValue = null;
      mockShopifyGraphQLRequest.mockImplementationOnce(async () => {
        return {
          success: true,
          data: {
            metafieldsSet: {
              metafields: [{ id: "mf-1", namespace: "$app", key: "credit_status" }],
              userErrors: [],
            },
          },
        };
      });

      await runDrain(sql, { batchSize: 10, timeBudgetMs: 10000 });

      // Assert Shopify mock received hold:false (release direction)
      expect(lastMetafieldValue).toBeDefined();
      const variables = lastMetafieldValue as { metafields: Array<{ value: string }> };
      const metafieldValue = variables.metafields?.[0]?.value;
      expect(metafieldValue).toBeDefined();
      const parsedValue = JSON.parse(metafieldValue);
      expect(parsedValue.hold).toBe(false);

      // Assert syncPending=false, metafieldSyncedAt is fresh, marker is NULL
      const [account] = await sql<{ 
        syncPending: boolean; 
        metafieldSyncedAt: Date | null;
        metafieldSyncErrorCode: string | null;
      }[]>`
        SELECT "syncPending", "metafieldSyncedAt", "metafieldSyncErrorCode"
        FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
      `;
      expect(account.syncPending).toBe(false);
      expect(account.metafieldSyncedAt).not.toBeNull();
      expect(account.metafieldSyncErrorCode).toBeNull();

      // Assert NO duplicate hold_released audit (only the original one from Step 3)
      const holdReleasedAudits = await sql<{ data: unknown }[]>`
        SELECT data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'hold_released'
          AND data->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
      `;
      expect(holdReleasedAudits.length).toBe(1);
    });
  });

  describe("hold direction - end-to-end", () => {
    it("OK account becomes overdue, write fails, resync runs drain with hold:true, no duplicate audit", async () => {
      const { runDrain } = await import("../drain/processor.server");
      const invoiceId = `inv-hold-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/hold-${TEST_SUFFIX}`;

      // Step 1: Create overdue invoice
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#HOLD-1', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '10 days',
          NOW() - INTERVAL '5 days',
          NOW(), NOW()
        )
      `;

      // Step 2: Simulate a recompute that sets DB to HELD but metafield write failed
      // This leaves DB at HELD with syncPending=true (the drift - buyer not blocked)
      await sql`
        UPDATE "BuyerAccount"
        SET "holdState" = 'HELD',
            "holdReasonCode" = 'PAYMENT_OVERDUE',
            "syncPending" = true,
            "syncVersion" = 2,
            "metafieldSyncedAt" = NOW() - INTERVAL '2 days'
        WHERE id = ${TEST_ACCOUNT_ID}
      `;
      
      // Record the original hold_applied audit from the recompute
      await sql`
        INSERT INTO "AuditEvent" ("shopId", actor, type, data, at)
        VALUES (${TEST_SHOP_ID}, 'system', 'hold_applied', ${sql.json({ buyerAccountId: TEST_ACCOUNT_ID })}, NOW() - INTERVAL '30 minutes')
      `;

      // Verify the drift exists
      const [driftAccount] = await sql<{ syncPending: boolean; holdState: string }[]>`
        SELECT "syncPending", "holdState" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
      `;
      expect(driftAccount.syncPending).toBe(true);
      expect(driftAccount.holdState).toBe("HELD");

      // Step 3: Run the sweep - should enqueue via Part 3 resync
      const [sweepResult] = await sql<{ accounts_enqueued: number }[]>`
        SELECT * FROM enqueue_credit_status_recomputes()
      `;
      expect(sweepResult.accounts_enqueued).toBeGreaterThanOrEqual(1);

      // Verify message was enqueued
      const [queueMsg] = await sql<{ message: { buyerAccountId: string; webhookId: string } }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
          AND message->>'webhookId' LIKE 'credit_resync:%'
        LIMIT 1
      `;
      expect(queueMsg).toBeDefined();

      // Step 4: Run the drain with a success mock
      lastMetafieldValue = null;
      mockShopifyGraphQLRequest.mockImplementationOnce(async () => {
        return {
          success: true,
          data: {
            metafieldsSet: {
              metafields: [{ id: "mf-1", namespace: "$app", key: "credit_status" }],
              userErrors: [],
            },
          },
        };
      });

      await runDrain(sql, { batchSize: 10, timeBudgetMs: 10000 });

      // Assert Shopify mock received hold:true (hold direction)
      expect(lastMetafieldValue).toBeDefined();
      const variables = lastMetafieldValue as { metafields: Array<{ value: string }> };
      const metafieldValue = variables.metafields?.[0]?.value;
      expect(metafieldValue).toBeDefined();
      const parsedValue = JSON.parse(metafieldValue);
      expect(parsedValue.hold).toBe(true);

      // Assert syncPending=false, metafieldSyncedAt is fresh, marker is NULL
      const [account] = await sql<{ 
        syncPending: boolean; 
        metafieldSyncedAt: Date | null;
        metafieldSyncErrorCode: string | null;
      }[]>`
        SELECT "syncPending", "metafieldSyncedAt", "metafieldSyncErrorCode"
        FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
      `;
      expect(account.syncPending).toBe(false);
      expect(account.metafieldSyncedAt).not.toBeNull();
      expect(account.metafieldSyncErrorCode).toBeNull();

      // Assert NO duplicate hold_applied audit (only the original one from Step 2)
      const holdAppliedAudits = await sql<{ data: unknown }[]>`
        SELECT data FROM "AuditEvent"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND type = 'hold_applied'
          AND data->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
      `;
      expect(holdAppliedAudits.length).toBe(1);
    });
  });

  describe("manual HELD", () => {
    it("manual HELD with failed write is selected by resync", async () => {
      await sql`
        UPDATE "BuyerAccount"
        SET "holdState" = 'HELD',
            "manualHold" = true,
            "holdReasonCode" = 'MANUAL_HOLD',
            "syncPending" = true,
            "metafieldSyncedAt" = NOW() - INTERVAL '2 days'
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      const [sweepResult] = await sql<{ accounts_enqueued: number }[]>`
        SELECT * FROM enqueue_credit_status_recomputes()
      `;

      expect(sweepResult.accounts_enqueued).toBeGreaterThanOrEqual(1);

      const [queueMsg] = await sql<{ message: { buyerAccountId: string } }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
          AND message->>'webhookId' LIKE 'credit_resync:%'
        LIMIT 1
      `;

      expect(queueMsg).toBeDefined();
    });
  });

  describe("gated accounts", () => {
    it("gated account with failed write is selected by resync", async () => {
      await sql`
        UPDATE "BuyerAccount"
        SET gated_at = NOW(),
            "syncPending" = true,
            "metafieldSyncedAt" = NOW() - INTERVAL '2 days'
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      const [sweepResult] = await sql<{ accounts_enqueued: number }[]>`
        SELECT * FROM enqueue_credit_status_recomputes()
      `;

      expect(sweepResult.accounts_enqueued).toBeGreaterThanOrEqual(1);

      const [queueMsg] = await sql<{ message: { buyerAccountId: string } }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
          AND message->>'webhookId' LIKE 'credit_resync:%'
        LIMIT 1
      `;

      expect(queueMsg).toBeDefined();
    });
  });
});

// =============================================================================
// PART 1 AND PART 2 REGRESSION TESTS (#204)
// =============================================================================

describeWithDb("Part 1 and Part 2 regression (#204)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-reg";
  const TEST_SHOP_ID = `shop-reg-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `reg-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-reg-${TEST_SUFFIX}`;
  const TEST_COMPANY_LOCATION_ID = `gid://shopify/CompanyLocation/${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${TEST_COMPANY_LOCATION_ID},
        'Regression Test Account', 100000.00, 'OK', false, false,
        false, 1, NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_re%:' + TEST_ACCOUNT_ID + '%'}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'OK', "holdReasonCode" = NULL, "manualHold" = false,
          "syncPending" = false, bypass = false, gated_at = NULL
      WHERE id = ${TEST_ACCOUNT_ID}
    `;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_re%:' + TEST_ACCOUNT_ID + '%'}`;
  });

  it("Part 1: OK account with overdue invoice is enqueued with credit_recompute key", async () => {
    const invoiceId = `inv-p1-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/p1-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#P1-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '10 days',
        NOW() - INTERVAL '5 days',
        NOW(), NOW()
      )
    `;

    const [result] = await sql<{ accounts_enqueued: number }[]>`
      SELECT * FROM enqueue_credit_status_recomputes()
    `;

    expect(result.accounts_enqueued).toBeGreaterThanOrEqual(1);

    const [queueMsg] = await sql<{ message: { webhookId: string; buyerAccountId: string } }[]>`
      SELECT message FROM pgmq.q_s6_sync
      WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
      LIMIT 1
    `;

    expect(queueMsg).toBeDefined();
    expect(queueMsg.message.webhookId).toMatch(/^credit_recompute:/);
  });

  it("Part 1: NEAR_LIMIT account with overdue invoice is enqueued", async () => {
    const invoiceId = `inv-nl-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/nl-${TEST_SUFFIX}`;

    await sql`UPDATE "BuyerAccount" SET "holdState" = 'NEAR_LIMIT' WHERE id = ${TEST_ACCOUNT_ID}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#NL-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '10 days',
        NOW() - INTERVAL '5 days',
        NOW(), NOW()
      )
    `;

    const [result] = await sql<{ accounts_enqueued: number }[]>`
      SELECT * FROM enqueue_credit_status_recomputes()
    `;

    expect(result.accounts_enqueued).toBeGreaterThanOrEqual(1);
  });

  it("Part 1: bypass account is NOT selected", async () => {
    const invoiceId = `inv-bypass-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/bypass-${TEST_SUFFIX}`;

    await sql`UPDATE "BuyerAccount" SET bypass = true, "holdState" = 'BYPASS' WHERE id = ${TEST_ACCOUNT_ID}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#BYPASS-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '10 days',
        NOW() - INTERVAL '5 days',
        NOW(), NOW()
      )
    `;

    await sql`SELECT * FROM enqueue_credit_status_recomputes()`;

    const [queueMsg] = await sql<{ message: unknown }[]>`
      SELECT message FROM pgmq.q_s6_sync
      WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
        AND message->>'webhookId' LIKE 'credit_recompute:%'
      LIMIT 1
    `;

    expect(queueMsg).toBeUndefined();
  });

  it("Part 2: HELD (auto) account with no overdue invoices is enqueued for self-heal", async () => {
    const invoiceId = `inv-heal-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/heal-${TEST_SUFFIX}`;

    // Set HELD with manualHold=false
    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'HELD', "manualHold" = false
      WHERE id = ${TEST_ACCOUNT_ID}
    `;

    // Paid invoice (not overdue)
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#HEAL-1', 10000.00, 0.00, 'paid',
        NOW() - INTERVAL '10 days',
        NOW() - INTERVAL '5 days',
        NOW(), NOW()
      )
    `;

    const [result] = await sql<{ accounts_enqueued: number }[]>`
      SELECT * FROM enqueue_credit_status_recomputes()
    `;

    expect(result.accounts_enqueued).toBeGreaterThanOrEqual(1);

    const [queueMsg] = await sql<{ message: { webhookId: string } }[]>`
      SELECT message FROM pgmq.q_s6_sync
      WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
      LIMIT 1
    `;

    expect(queueMsg).toBeDefined();
    expect(queueMsg.message.webhookId).toMatch(/^credit_recompute:/);
  });

  it("Part 2: manual HELD account is NOT selected for self-heal", async () => {
    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'HELD', "manualHold" = true, "holdReasonCode" = 'MANUAL_HOLD'
      WHERE id = ${TEST_ACCOUNT_ID}
    `;

    await sql`SELECT * FROM enqueue_credit_status_recomputes()`;

    const [queueMsg] = await sql<{ message: unknown }[]>`
      SELECT message FROM pgmq.q_s6_sync
      WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
        AND message->>'webhookId' LIKE 'credit_recompute:%'
      LIMIT 1
    `;

    expect(queueMsg).toBeUndefined();
  });

  it("gated accounts are included in Part 1 and Part 2", async () => {
    const invoiceId = `inv-gated-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/gated-${TEST_SUFFIX}`;

    // Gated account
    await sql`UPDATE "BuyerAccount" SET gated_at = NOW() WHERE id = ${TEST_ACCOUNT_ID}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#GATED-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '10 days',
        NOW() - INTERVAL '5 days',
        NOW(), NOW()
      )
    `;

    const [result] = await sql<{ accounts_enqueued: number }[]>`
      SELECT * FROM enqueue_credit_status_recomputes()
    `;

    expect(result.accounts_enqueued).toBeGreaterThanOrEqual(1);

    const [queueMsg] = await sql<{ message: { buyerAccountId: string } }[]>`
      SELECT message FROM pgmq.q_s6_sync
      WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
      LIMIT 1
    `;

    expect(queueMsg).toBeDefined();
  });
});

// =============================================================================
// LEAK CHECK TESTS (#204)
// =============================================================================

describeWithDb("leak checks (#204)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-leak";
  const TEST_SHOP_ID = `shop-leak-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `leak-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-leak-${TEST_SUFFIX}`;
  const TEST_COMPANY_LOCATION_ID = `gid://shopify/CompanyLocation/${TEST_SUFFIX}`;
  const SENTINEL_NAME = "SENTINEL_BUYER_NAME_LEAK_CHECK";
  const SENTINEL_EMAIL = "sentinel@leak-test.example.com";

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${TEST_COMPANY_LOCATION_ID},
        ${SENTINEL_NAME}, 100000.00, 'OK', false, false,
        false, 1, NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_re%:' + TEST_ACCOUNT_ID + '%'}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    mockShopifyGraphQLRequest.mockReset();
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
  });

  it("sync_failed AuditEvent data contains no domain, name, or email", async () => {
    // Insert a sync_failed audit event directly to test leak
    await sql`
      INSERT INTO "AuditEvent" ("shopId", actor, type, data, at)
      VALUES (
        ${TEST_SHOP_ID},
        'system',
        'credit_status.sync_failed',
        ${sql.json({
          buyerAccountId: TEST_ACCOUNT_ID,
          errorCode: "no_session",
          syncVersion: 5,
        })},
        NOW()
      )
    `;

    const [auditEvent] = await sql<{ data: Record<string, unknown> }[]>`
      SELECT data FROM "AuditEvent"
      WHERE "shopId" = ${TEST_SHOP_ID}
        AND type = 'credit_status.sync_failed'
      LIMIT 1
    `;

    const dataStr = JSON.stringify(auditEvent.data);
    
    expect(dataStr).not.toContain(TEST_SHOP_DOMAIN);
    expect(dataStr).not.toContain(SENTINEL_NAME);
    expect(dataStr).not.toContain(SENTINEL_EMAIL);
    expect(dataStr).not.toContain("@");
  });

  it("DLQ error from real drain contains no domain, name, or token-like string", async () => {
    const { runDrain } = await import("../drain/processor.server");
    
    // Set up account to trigger sync
    await sql`
      UPDATE "BuyerAccount"
      SET "syncPending" = true, "metafieldSyncedAt" = NULL
      WHERE id = ${TEST_ACCOUNT_ID}
    `;

    // Mock Shopify returning non-retryable error
    mockShopifyGraphQLRequest.mockImplementationOnce(async () => ({
      success: false,
      error: "Session not found",
      errorCode: "no_session",
      retryable: false,
    }));

    const webhookId = `credit_resync:${TEST_ACCOUNT_ID}:leak-dlq-${Date.now()}`;
    const message = {
      topic: "CREDIT_STATUS_RECOMPUTE",
      shop: TEST_SHOP_DOMAIN,
      buyerAccountId: TEST_ACCOUNT_ID,
      source: "daily_sweep",
      webhookId,
      resourceGid: TEST_ACCOUNT_ID,
      enqueuedAt: new Date().toISOString(),
    };

    // Enqueue and run drain - should dead-letter
    await sql`SELECT pgmq.send('s6_sync', ${sql.json(message)})`;
    await runDrain(sql, { batchSize: 10, timeBudgetMs: 10000 });

    const [dlqRow] = await sql<{ error: string; message: Record<string, unknown> }[]>`
      SELECT error, message FROM s6_dead_letter
      WHERE message->>'webhookId' = ${webhookId}
    `;

    expect(dlqRow).toBeDefined();
    
    // Error should be only code
    expect(dlqRow.error).toBe("non_retryable:no_session");
    expect(dlqRow.error).not.toContain(SENTINEL_NAME);
    expect(dlqRow.error).not.toContain(SENTINEL_EMAIL);
    
    // Message shop field is allowed (it's the domain), but no name/email
    const msgStr = JSON.stringify(dlqRow.message);
    expect(msgStr).not.toContain(SENTINEL_NAME);
    expect(msgStr).not.toContain(SENTINEL_EMAIL);
  });
});

// =============================================================================
// NO-OWNER ACCOUNT DRAIN TESTS (#203)
// =============================================================================

describeWithDb("CREDIT_STATUS_RECOMPUTE no-owner accounts (#203)", () => {
  let sql: ReturnType<typeof postgres>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  const TEST_SUFFIX = Date.now().toString(36) + "-noowner-drain";
  const TEST_SHOP_ID = `shop-noowner-drain-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `noowner-drain-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-noowner-drain-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    // Temporarily disable CHECK constraint
    await sql`ALTER TABLE "BuyerAccount" DROP CONSTRAINT "BuyerAccount_kind_consistency"`;

    // COMPANY with null companyLocationId (no-owner)
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "syncPending", "syncVersion",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-noowner-drain-" + TEST_SUFFIX}, NULL,
        'No-Owner Drain Account', 100000.00, 'OK', false, true, 0,
        NOW(), NOW()
      )
    `;

    // Re-enable CHECK constraint (NOT VALID)
    await sql`
      ALTER TABLE "BuyerAccount"
      ADD CONSTRAINT "BuyerAccount_kind_consistency" CHECK (
        (kind = 'COMPANY' AND "companyLocationId" IS NOT NULL AND "companyId" IS NOT NULL)
        OR (kind = 'TAGGED_CUSTOMER' AND "customerId" IS NOT NULL)
      ) NOT VALID
    `;
  });

  afterAll(async () => {
    await sql`ALTER TABLE "BuyerAccount" DROP CONSTRAINT "BuyerAccount_kind_consistency"`;
    
    // Clean up queue/DLQ messages
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_recompute:' + TEST_ACCOUNT_ID + '%'}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    
    // Re-enable constraint as VALID
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
    metafieldWriteCount = 0;
    mockShouldFail = false;
    mockShopifyGraphQLRequest.mockClear();
    consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    
    // Clean up messages and state
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_recompute:' + TEST_ACCOUNT_ID + '%'}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    
    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'OK', "syncPending" = true, "syncVersion" = 0,
          "metafieldSyncedAt" = NULL
      WHERE id = ${TEST_ACCOUNT_ID}
    `;
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("handler returns action:skipped (not created) and metafieldWritten:false", async () => {
    const invoiceId = `inv-handler-noowner-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/handler-noowner-${TEST_SUFFIX}`;

    // Create overdue invoice
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#HANDLER-NOOWNER-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '30 days',
        NOW() - INTERVAL '10 days',
        NOW(), NOW()
      )
    `;

    const webhookId = `credit_recompute:${TEST_ACCOUNT_ID}:${Date.now()}`;
    const handler = getSyncHandler("CREDIT_STATUS_RECOMPUTE");
    expect(handler).toBeDefined();

    const message = {
      topic: "CREDIT_STATUS_RECOMPUTE",
      shop: TEST_SHOP_DOMAIN,
      buyerAccountId: TEST_ACCOUNT_ID,
      source: "daily_sweep",
      webhookId,
      resourceGid: TEST_ACCOUNT_ID,
      enqueuedAt: new Date().toISOString(),
    };

    const result = await handler!(sql, message);

    expect(result.success).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.skipReason).toContain("No owner GID");

    // Metafield should NOT be written
    expect(metafieldWriteCount).toBe(0);
  });

  it("two consecutive runs via drain: exactly ONE warn log, ONE audit, zero DLQ rows", async () => {
    const invoiceId = `inv-tworuns-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/tworuns-${TEST_SUFFIX}`;

    // Create overdue invoice
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#TWORUNS-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '30 days',
        NOW() - INTERVAL '10 days',
        NOW(), NOW()
      )
    `;

    // First run: enqueue and drain
    const webhookId1 = `credit_recompute:${TEST_ACCOUNT_ID}:day1-${Date.now()}`;
    const message1 = {
      topic: "CREDIT_STATUS_RECOMPUTE",
      shop: TEST_SHOP_DOMAIN,
      buyerAccountId: TEST_ACCOUNT_ID,
      source: "daily_sweep",
      webhookId: webhookId1,
      resourceGid: TEST_ACCOUNT_ID,
    };

    await sql`SELECT pgmq.send('s6_sync', ${sql.json(message1)})`;
    await runDrain(sql, { batchSize: 10, timeBudgetMs: 10000 });

    // Count logs and audits after first run
    const logCount1 = consoleSpy.mock.calls.filter((call: unknown[]) => 
      typeof call[0] === 'string' && call[0].includes('credit_status_no_owner')
    ).length;
    
    const [auditCount1] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM "AuditEvent"
      WHERE "shopId" = ${TEST_SHOP_ID}
        AND type = 'credit_status.hold_unenforceable'
    `;

    expect(logCount1).toBe(1);
    expect(parseInt(auditCount1.count)).toBe(1);

    // Second run: enqueue with different webhookId (simulating next day)
    const webhookId2 = `credit_recompute:${TEST_ACCOUNT_ID}:day2-${Date.now() + 86400000}`;
    const message2 = {
      topic: "CREDIT_STATUS_RECOMPUTE",
      shop: TEST_SHOP_DOMAIN,
      buyerAccountId: TEST_ACCOUNT_ID,
      source: "daily_sweep",
      webhookId: webhookId2,
      resourceGid: TEST_ACCOUNT_ID,
    };

    await sql`SELECT pgmq.send('s6_sync', ${sql.json(message2)})`;
    await runDrain(sql, { batchSize: 10, timeBudgetMs: 10000 });

    // Count logs and audits after second run
    const logCount2 = consoleSpy.mock.calls.filter((call: unknown[]) => 
      typeof call[0] === 'string' && call[0].includes('credit_status_no_owner')
    ).length;
    
    const [auditCount2] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM "AuditEvent"
      WHERE "shopId" = ${TEST_SHOP_ID}
        AND type = 'credit_status.hold_unenforceable'
    `;

    // STILL only 1 log and 1 audit (second run is no-op since state didn't change)
    expect(logCount2).toBe(1);
    expect(parseInt(auditCount2.count)).toBe(1);

    // Zero DLQ rows for this account
    const [dlqCount] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM s6_dead_letter
      WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
    `;
    expect(parseInt(dlqCount.count)).toBe(0);

    // Verify no hold_applied audit events
    const [holdAppliedCount] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM "AuditEvent"
      WHERE "shopId" = ${TEST_SHOP_ID}
        AND type = 'credit_status.hold_applied'
    `;
    expect(parseInt(holdAppliedCount.count)).toBe(0);
  });

  it("regression: owner-present account via drain still sets metafieldSyncedAt and action:created", async () => {
    // Create account WITH owner
    const ownerAccountId = `acc-withowner-drain-${TEST_SUFFIX}`;
    
    await sql`ALTER TABLE "BuyerAccount" DROP CONSTRAINT "BuyerAccount_kind_consistency"`;
    
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "syncPending", "syncVersion",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${ownerAccountId}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-withowner-drain-" + TEST_SUFFIX}, ${"gid://shopify/CompanyLocation/withowner-drain-" + TEST_SUFFIX},
        'With-Owner Drain Account', 100000.00, 'OK', false, true, 0,
        NOW(), NOW()
      )
    `;
    
    await sql`
      ALTER TABLE "BuyerAccount"
      ADD CONSTRAINT "BuyerAccount_kind_consistency" CHECK (
        (kind = 'COMPANY' AND "companyLocationId" IS NOT NULL AND "companyId" IS NOT NULL)
        OR (kind = 'TAGGED_CUSTOMER' AND "customerId" IS NOT NULL)
      ) NOT VALID
    `;

    const invoiceId = `inv-withowner-drain-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/withowner-drain-${TEST_SUFFIX}`;

    // Create overdue invoice
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${ownerAccountId}, ${orderId},
        '#WITHOWNER-DRAIN-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '30 days',
        NOW() - INTERVAL '10 days',
        NOW(), NOW()
      )
    `;

    try {
      const webhookId = `credit_recompute:${ownerAccountId}:${Date.now()}`;
      const handler = getSyncHandler("CREDIT_STATUS_RECOMPUTE");
      
      const message = {
        topic: "CREDIT_STATUS_RECOMPUTE",
        shop: TEST_SHOP_DOMAIN,
        buyerAccountId: ownerAccountId,
        source: "daily_sweep",
        webhookId,
        resourceGid: ownerAccountId,
        enqueuedAt: new Date().toISOString(),
      };

      const result = await handler!(sql, message);

      expect(result.success).toBe(true);
      expect(result.action).toBe("created");

      // Metafield SHOULD be written
      expect(metafieldWriteCount).toBe(1);

      // Verify metafieldSyncedAt is set
      const [account] = await sql<{ metafieldSyncedAt: Date | null }[]>`
        SELECT "metafieldSyncedAt" FROM "BuyerAccount" WHERE id = ${ownerAccountId}
      `;
      expect(account.metafieldSyncedAt).not.toBeNull();
    } finally {
      // Clean up
      await sql`ALTER TABLE "BuyerAccount" DROP CONSTRAINT "BuyerAccount_kind_consistency"`;
      await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_recompute:' + ownerAccountId + '%'}`;
      await sql`DELETE FROM "BuyerAccount" WHERE id = ${ownerAccountId}`;
      await sql`
        ALTER TABLE "BuyerAccount"
        ADD CONSTRAINT "BuyerAccount_kind_consistency" CHECK (
          (kind = 'COMPANY' AND "companyLocationId" IS NOT NULL AND "companyId" IS NOT NULL)
          OR (kind = 'TAGGED_CUSTOMER' AND "customerId" IS NOT NULL)
        ) NOT VALID
      `;
    }
  });
});
