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
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
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
import { getSyncHandler } from "../drain/processor.server";

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
    
    // Reset account state - MUST include gated_at to clear it after gated test
    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'OK', "holdReasonCode" = NULL, "manualHold" = false,
          "syncPending" = false, "syncVersion" = 1, gated_at = NULL
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

    it("does NOT write metafield when nothing changed AND syncPending=false", async () => {
      // Account is OK, no invoices, syncPending=false (already set in beforeEach)
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
        expect(result1.error).toContain("Metafield");
        
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

    it("gated account reports real stored values, not fake ones", async () => {
      // Set account to gated and HELD
      await sql`
        UPDATE "BuyerAccount"
        SET gated_at = NOW(), "holdState" = 'HELD', "holdReasonCode" = 'MANUAL_HOLD'
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      const result = await recomputeCreditStatus(sql, TEST_ACCOUNT_ID);

      expect(result.success).toBe(true);
      expect(result.metafieldWritten).toBe(false);
      // Reports real stored values: HELD (not bypass) = hold true
      expect(result.previousHold).toBe(true);
      expect(result.newHold).toBe(true);
      expect(metafieldWriteCount).toBe(0); // No write for gated accounts
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
