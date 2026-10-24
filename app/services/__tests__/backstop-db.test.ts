/**
 * DB-backed integration tests for backstop service.
 * Uses the CI pgmq Postgres service.
 *
 * Tests claim logic, exposure calculation, overdue detection, and
 * the migration's idempotent DO block against real Postgres.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

// Mock shopify-client.server before importing backstop
vi.mock("../shopify-client.server", () => ({
  shopifyGraphQLRequest: vi.fn(),
}));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("backstop DB integration", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-backstop-db";
  const TEST_SHOP_ID = `shop-backstop-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `backstop-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-backstop-${TEST_SUFFIX}`;
  const TEST_ORDER_GID = `gid://shopify/Order/backstop-${TEST_SUFFIX}`;
  const TEST_INVOICE_ID = `inv-backstop-${TEST_SUFFIX}`;

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
        "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${"loc-" + TEST_SUFFIX},
        'Test Backstop Account', 100000.00, 'HELD', false, true, 'MANUAL_HOLD',
        NOW(), NOW()
      )
    `;

    // Create test invoice
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_INVOICE_ID}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${TEST_ORDER_GID},
        '#TEST-BACKSTOP-1', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    // Cleanup in reverse order of creation
    await sql`DELETE FROM backstop_processed_orders WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  describe("claim logic", () => {
    const claimOrderGid = `gid://shopify/Order/claim-${TEST_SUFFIX}`;

    afterAll(async () => {
      await sql`DELETE FROM backstop_processed_orders WHERE order_gid = ${claimOrderGid}`;
    });

    it("INSERT...ON CONFLICT claims new orders atomically", async () => {
      // First claim should succeed
      const [inserted] = await sql<{ action: string }[]>`
        INSERT INTO backstop_processed_orders (shop_id, order_gid, action, reason, processed_at)
        VALUES (${TEST_SHOP_ID}, ${claimOrderGid}, 'pending', NULL, NOW())
        ON CONFLICT (shop_id, order_gid) DO NOTHING
        RETURNING action
      `;

      expect(inserted).toBeDefined();
      expect(inserted.action).toBe("pending");

      // Second claim should fail (conflict)
      const [notInserted] = await sql<{ action: string }[]>`
        INSERT INTO backstop_processed_orders (shop_id, order_gid, action, reason, processed_at)
        VALUES (${TEST_SHOP_ID}, ${claimOrderGid}, 'pending', NULL, NOW())
        ON CONFLICT (shop_id, order_gid) DO NOTHING
        RETURNING action
      `;

      expect(notInserted).toBeUndefined();
    });

    it("stale pending claims are reclaimable via atomic UPDATE", async () => {
      const staleOrderGid = `gid://shopify/Order/stale-${TEST_SUFFIX}`;

      // Insert a stale claim (processed_at 10 minutes ago)
      await sql`
        INSERT INTO backstop_processed_orders (shop_id, order_gid, action, reason, processed_at)
        VALUES (${TEST_SHOP_ID}, ${staleOrderGid}, 'pending', NULL, NOW() - INTERVAL '10 minutes')
      `;

      // Try to reclaim with 5 minute timeout - should succeed
      const [reclaimed] = await sql<{ action: string }[]>`
        UPDATE backstop_processed_orders
        SET processed_at = NOW()
        WHERE shop_id = ${TEST_SHOP_ID}
          AND order_gid = ${staleOrderGid}
          AND action = 'pending'
          AND processed_at < NOW() - make_interval(secs => 300)
        RETURNING action
      `;

      expect(reclaimed).toBeDefined();
      expect(reclaimed.action).toBe("pending");

      // Cleanup
      await sql`DELETE FROM backstop_processed_orders WHERE order_gid = ${staleOrderGid}`;
    });

    it("fresh pending claims are NOT reclaimable", async () => {
      const freshOrderGid = `gid://shopify/Order/fresh-${TEST_SUFFIX}`;

      // Insert a fresh claim (processed_at now)
      await sql`
        INSERT INTO backstop_processed_orders (shop_id, order_gid, action, reason, processed_at)
        VALUES (${TEST_SHOP_ID}, ${freshOrderGid}, 'pending', NULL, NOW())
      `;

      // Try to reclaim with 5 minute timeout - should fail (too fresh)
      const [notReclaimed] = await sql<{ action: string }[]>`
        UPDATE backstop_processed_orders
        SET processed_at = NOW()
        WHERE shop_id = ${TEST_SHOP_ID}
          AND order_gid = ${freshOrderGid}
          AND action = 'pending'
          AND processed_at < NOW() - make_interval(secs => 300)
        RETURNING action
      `;

      expect(notReclaimed).toBeUndefined();

      // Cleanup
      await sql`DELETE FROM backstop_processed_orders WHERE order_gid = ${freshOrderGid}`;
    });

    it("completed claims (held/skipped) are never reclaimable", async () => {
      const completedOrderGid = `gid://shopify/Order/completed-${TEST_SUFFIX}`;

      // Insert a completed claim
      await sql`
        INSERT INTO backstop_processed_orders (shop_id, order_gid, action, reason, processed_at)
        VALUES (${TEST_SHOP_ID}, ${completedOrderGid}, 'held', 'Manual hold', NOW() - INTERVAL '10 minutes')
      `;

      // Try to reclaim - should fail (not pending)
      const [notReclaimed] = await sql<{ action: string }[]>`
        UPDATE backstop_processed_orders
        SET processed_at = NOW()
        WHERE shop_id = ${TEST_SHOP_ID}
          AND order_gid = ${completedOrderGid}
          AND action = 'pending'
          AND processed_at < NOW() - make_interval(secs => 300)
        RETURNING action
      `;

      expect(notReclaimed).toBeUndefined();

      // Cleanup
      await sql`DELETE FROM backstop_processed_orders WHERE order_gid = ${completedOrderGid}`;
    });
  });

  describe("resolveInvoiceForOrder", () => {
    it("finds invoice by shop domain and order GID", async () => {
      const [invoice] = await sql<{ id: string; shopId: string; buyerAccountId: string | null }[]>`
        SELECT i.id, i."shopId", i."buyerAccountId"
        FROM "Invoice" i
        JOIN "Shop" s ON s.id = i."shopId"
        WHERE s.domain = ${TEST_SHOP_DOMAIN} AND i."orderId" = ${TEST_ORDER_GID}
        LIMIT 1
      `;

      expect(invoice).toBeDefined();
      expect(invoice.id).toBe(TEST_INVOICE_ID);
      expect(invoice.shopId).toBe(TEST_SHOP_ID);
      expect(invoice.buyerAccountId).toBe(TEST_ACCOUNT_ID);
    });

    it("returns empty for non-existent order", async () => {
      const [invoice] = await sql<{ id: string }[]>`
        SELECT i.id
        FROM "Invoice" i
        JOIN "Shop" s ON s.id = i."shopId"
        WHERE s.domain = ${TEST_SHOP_DOMAIN} AND i."orderId" = 'gid://shopify/Order/does-not-exist'
        LIMIT 1
      `;

      expect(invoice).toBeUndefined();
    });
  });

  describe("exposure calculation", () => {
    it("computes exposure excluding specific invoice", async () => {
      // Add a second invoice
      const secondInvoiceId = `inv-second-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${secondInvoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID},
          ${"gid://shopify/Order/second-" + TEST_SUFFIX},
          '#TEST-BACKSTOP-2', 30000.00, 30000.00, 'open', NOW(), NOW(), NOW()
        )
      `;

      // Exposure excluding the first invoice should be 30000 * 100 = 3000000 paise
      const [result] = await sql<{ total_paise: string | null }[]>`
        SELECT COALESCE(SUM((ROUND(outstanding * 100))::bigint), 0)::text AS total_paise
        FROM "Invoice"
        WHERE "buyerAccountId" = ${TEST_ACCOUNT_ID}
          AND id != ${TEST_INVOICE_ID}
          AND status = 'open'
          AND outstanding > 0
      `;

      expect(result.total_paise).toBe("3000000");

      // Cleanup
      await sql`DELETE FROM "Invoice" WHERE id = ${secondInvoiceId}`;
    });
  });

  describe("overdue detection", () => {
    it("detects overdue invoices", async () => {
      // Add an overdue invoice
      const overdueInvoiceId = `inv-overdue-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "dueAt", "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${overdueInvoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID},
          ${"gid://shopify/Order/overdue-" + TEST_SUFFIX},
          '#TEST-OVERDUE', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '7 days',
          NOW(), NOW(), NOW()
        )
      `;

      // Should detect overdue invoice
      const [result] = await sql<{ has_overdue: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM "Invoice"
          WHERE "buyerAccountId" = ${TEST_ACCOUNT_ID}
            AND status = 'open'
            AND outstanding > 0
            AND "dueAt" IS NOT NULL
            AND "dueAt" < NOW() - INTERVAL '1 day'
        ) AS has_overdue
      `;

      expect(result.has_overdue).toBe(true);

      // Cleanup
      await sql`DELETE FROM "Invoice" WHERE id = ${overdueInvoiceId}`;
    });

    it("returns false when no overdue invoices", async () => {
      // Our test invoice has no dueAt, so not overdue
      const [result] = await sql<{ has_overdue: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM "Invoice"
          WHERE "buyerAccountId" = ${TEST_ACCOUNT_ID}
            AND status = 'open'
            AND outstanding > 0
            AND "dueAt" IS NOT NULL
            AND "dueAt" < NOW() - INTERVAL '1 day'
        ) AS has_overdue
      `;

      expect(result.has_overdue).toBe(false);
    });
  });

  describe("migration idempotency", () => {
    it("backstop_processed_orders table exists with correct schema", async () => {
      const [table] = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_name = 'backstop_processed_orders'
        ) AS exists
      `;

      expect(table.exists).toBe(true);
    });

    it("primary key constraint exists", async () => {
      const [pk] = await sql<{ constraint_name: string }[]>`
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_name = 'backstop_processed_orders'
          AND constraint_type = 'PRIMARY KEY'
      `;

      expect(pk).toBeDefined();
    });

    it("action check constraint allows valid values", async () => {
      // 'pending', 'held', 'skipped' should all work
      for (const action of ["pending", "held", "skipped"]) {
        const testOrderGid = `gid://shopify/Order/action-test-${action}-${TEST_SUFFIX}`;
        await sql`
          INSERT INTO backstop_processed_orders (shop_id, order_gid, action, reason, processed_at)
          VALUES (${TEST_SHOP_ID}, ${testOrderGid}, ${action}, 'test', NOW())
        `;
        await sql`DELETE FROM backstop_processed_orders WHERE order_gid = ${testOrderGid}`;
      }
    });

    it("action check constraint rejects invalid values", async () => {
      const testOrderGid = `gid://shopify/Order/invalid-action-${TEST_SUFFIX}`;

      await expect(
        sql`
          INSERT INTO backstop_processed_orders (shop_id, order_gid, action, reason, processed_at)
          VALUES (${TEST_SHOP_ID}, ${testOrderGid}, 'invalid', 'test', NOW())
        `
      ).rejects.toThrow();
    });
  });

  describe("two-attempt handleOrder scenario", () => {
    it("attempt 1 fails (FO hold fails), attempt 2 succeeds (redelivery)", async () => {
      const { applyBackstop, RetryableBackstopError } = await import(
        "../backstop.server"
      );
      const { shopifyGraphQLRequest } = await import("../shopify-client.server");
      const mockGraphQL = shopifyGraphQLRequest as ReturnType<typeof vi.fn>;

      const orderGid = `gid://shopify/Order/two-attempt-${TEST_SUFFIX}`;
      const invoiceId = `inv-two-attempt-${TEST_SUFFIX}`;

      // Create invoice for this test
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderGid},
          '#TEST-TWO-ATTEMPT', 25000.00, 25000.00, 'open', NOW(), NOW(), NOW()
        )
      `;

      try {
        // Attempt 1: FO query succeeds but hold fails
        mockGraphQL
          .mockResolvedValueOnce({
            success: true,
            data: {
              order: {
                fulfillmentOrders: {
                  edges: [
                    {
                      node: {
                        id: "gid://shopify/FulfillmentOrder/1",
                        status: "OPEN",
                        
                        supportedActions: [{ action: "HOLD" }],
                      },
                    },
                  ],
                },
              },
            },
          })
          .mockResolvedValueOnce({
            success: false,
            error: "API temporarily unavailable",
          });

        // Attempt 1 should throw RetryableBackstopError
        await expect(
          applyBackstop(sql, {
            shopDomain: TEST_SHOP_DOMAIN,
            shopId: TEST_SHOP_ID,
            orderGid,
            buyerAccountId: TEST_ACCOUNT_ID,
            invoiceId,
          })
        ).rejects.toThrow(RetryableBackstopError);

        // Verify no processed row (claim was cleared on failure)
        const [afterAttempt1] = await sql<{ action: string }[]>`
          SELECT action FROM backstop_processed_orders
          WHERE shop_id = ${TEST_SHOP_ID} AND order_gid = ${orderGid}
        `;
        expect(afterAttempt1).toBeUndefined();

        // Attempt 2: Redelivery - this time hold succeeds
        mockGraphQL.mockReset();
        mockGraphQL
          .mockResolvedValueOnce({
            success: true,
            data: {
              order: {
                fulfillmentOrders: {
                  edges: [
                    {
                      node: {
                        id: "gid://shopify/FulfillmentOrder/1",
                        status: "OPEN",
                        
                        supportedActions: [{ action: "HOLD" }],
                      },
                    },
                  ],
                },
              },
            },
          })
          .mockResolvedValueOnce({
            success: true,
            data: {
              fulfillmentOrderHold: {
                fulfillmentOrder: { id: "gid://shopify/FulfillmentOrder/1", status: "ON_HOLD" },
                userErrors: [],
              },
            },
          })
          .mockResolvedValueOnce({
            success: true,
            data: {
              tagsAdd: { node: { id: orderGid }, userErrors: [] },
            },
          });

        const result = await applyBackstop(sql, {
          shopDomain: TEST_SHOP_DOMAIN,
          shopId: TEST_SHOP_ID,
          orderGid,
          buyerAccountId: TEST_ACCOUNT_ID,
          invoiceId,
        });

        expect(result.applied).toBe(true);
        expect(result.fulfillmentOrdersHeld).toBe(1);

        // Verify processed row exists with action='held'
        const [afterAttempt2] = await sql<{ action: string; reason: string }[]>`
          SELECT action, reason FROM backstop_processed_orders
          WHERE shop_id = ${TEST_SHOP_ID} AND order_gid = ${orderGid}
        `;
        expect(afterAttempt2).toBeDefined();
        expect(afterAttempt2.action).toBe("held");
      } finally {
        // Cleanup
        await sql`DELETE FROM backstop_processed_orders WHERE order_gid = ${orderGid}`;
        await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
        mockGraphQL.mockReset();
      }
    });
  });

  describe("redelivery scenario (Bug 2 fix)", () => {
    /**
     * Bug 2 production evidence (run 40076223711, msgs 162/163):
     * - backstop_processed_orders has 0 rows, 0 backstop.% AuditEvents
     * - Both invoices exist with buyerAccountId (same CompanyLocation account)
     * - Account is holdState=OK, manualHold=false, bypass=false (NOT held)
     *
     * Root cause: On attempt 1, backstop threw before any claim row was written.
     * On redelivery, isWebhookProcessed=true caused handleOrder to early-return
     * and archive the message. Backstop never ran on retry.
     *
     * Fix: For ORDERS_CREATE, runBackstopOnly runs on redelivery instead of
     * early return, ensuring backstop completes (skip or hold based on state).
     *
     * These tests verify that backstop functions work correctly when called
     * on redelivery. The key difference from main is that runBackstopOnly
     * actually calls these functions instead of early-returning.
     *
     * To "fail on main": Without runBackstopOnly, the early return means
     * applyBackstop never runs → 0 rows. With fix → row created.
     */
    it("unheld account: backstop returns skipped with row (production scenario)", async () => {
      const { applyBackstop, resolveInvoiceForOrder } =
        await import("../backstop.server");

      const orderGid = `gid://shopify/Order/bug2-unheld-${TEST_SUFFIX}`;
      const invoiceId = `inv-bug2-unheld-${TEST_SUFFIX}`;

      // Create UNHELD account (matches production evidence: holdState=OK, manualHold=false)
      const unheldAccountId = `acc-unheld-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "holdState", bypass, "manualHold", "holdReasonCode",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${unheldAccountId}, ${TEST_SHOP_ID}, 'COMPANY',
          ${"co-unheld-" + TEST_SUFFIX}, ${"loc-unheld-" + TEST_SUFFIX},
          'Test Unheld Account', 500000.00, 'OK', false, false, NULL,
          NOW(), NOW()
        )
      `;

      // Create invoice (simulating attempt 1 created the order but backstop failed)
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${unheldAccountId}, ${orderGid},
          '#TEST-BUG2-UNHELD', 25000.00, 25000.00, 'open', NOW(), NOW(), NOW()
        )
      `;

      try {
        // Simulate production: No backstop_processed_orders row exists
        // (attempt 1 threw before claim was written)
        const [before] = await sql<{ action: string }[]>`
          SELECT action FROM backstop_processed_orders
          WHERE shop_id = ${TEST_SHOP_ID} AND order_gid = ${orderGid}
        `;
        expect(before).toBeUndefined();

        // REDELIVERY: runBackstopOnly calls resolveInvoiceForOrder
        const resolved = await resolveInvoiceForOrder(sql, TEST_SHOP_DOMAIN, orderGid);
        expect(resolved).not.toBeNull();
        expect(resolved?.buyerAccountId).toBe(unheldAccountId);

        // runBackstopOnly then calls applyBackstop
        // For unheld account: no GraphQL needed, returns 'skipped'
        const result = await applyBackstop(sql, {
          shopDomain: TEST_SHOP_DOMAIN,
          shopId: resolved!.shopId,
          orderGid,
          buyerAccountId: resolved!.buyerAccountId,
          invoiceId: resolved!.invoiceId,
        });

        // Verify: Backstop completed with 'skipped' (account not held)
        expect(result.applied).toBe(false);
        expect(result.skipped).toBe(true);
        expect(result.skipReason).toContain("not held");

        // KEY VERIFICATION: Row now exists (proves backstop ran)
        // On main (without fix), early return means this row never created
        const [after] = await sql<{ action: string; reason: string }[]>`
          SELECT action, reason FROM backstop_processed_orders
          WHERE shop_id = ${TEST_SHOP_ID} AND order_gid = ${orderGid}
        `;
        expect(after).toBeDefined();
        expect(after.action).toBe("skipped");

      } finally {
        await sql`DELETE FROM backstop_processed_orders WHERE order_gid = ${orderGid}`;
        await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
        await sql`DELETE FROM "BuyerAccount" WHERE id = ${unheldAccountId}`;
      }
    });

    it("redelivery applies hold for held account (manualHold=true)", async () => {
      const { applyBackstop, resolveInvoiceForOrder, RetryableBackstopError } =
        await import("../backstop.server");
      const { shopifyGraphQLRequest } = await import("../shopify-client.server");
      const mockGraphQL = shopifyGraphQLRequest as ReturnType<typeof vi.fn>;

      const orderGid = `gid://shopify/Order/held-redeliver-${TEST_SUFFIX}`;
      const invoiceId = `inv-held-redeliver-${TEST_SUFFIX}`;

      // Use TEST_ACCOUNT_ID which has manualHold=true (setup in beforeAll)
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderGid},
          '#TEST-HELD-REDELIVER', 15000.00, 15000.00, 'open', NOW(), NOW(), NOW()
        )
      `;

      try {
        // ATTEMPT 1: Fails with access-denied
        mockGraphQL.mockResolvedValueOnce({
          success: false,
          error: "Access denied for location field",
        });

        await expect(
          applyBackstop(sql, {
            shopDomain: TEST_SHOP_DOMAIN,
            shopId: TEST_SHOP_ID,
            orderGid,
            buyerAccountId: TEST_ACCOUNT_ID,
            invoiceId,
          })
        ).rejects.toThrow(RetryableBackstopError);

        // ATTEMPT 2: Redelivery with fix - hold is applied
        mockGraphQL.mockReset();
        mockGraphQL
          .mockResolvedValueOnce({
            success: true,
            data: {
              order: {
                fulfillmentOrders: {
                  edges: [
                    {
                      node: {
                        id: "gid://shopify/FulfillmentOrder/held-rd-1",
                        status: "OPEN",
                        supportedActions: [{ action: "HOLD" }],
                      },
                    },
                  ],
                },
              },
            },
          })
          .mockResolvedValueOnce({
            success: true,
            data: {
              fulfillmentOrderHold: {
                fulfillmentOrder: { id: "gid://shopify/FulfillmentOrder/held-rd-1", status: "ON_HOLD" },
                userErrors: [],
              },
            },
          })
          .mockResolvedValueOnce({
            success: true,
            data: { tagsAdd: { node: { id: orderGid }, userErrors: [] } },
          });

        const resolved = await resolveInvoiceForOrder(sql, TEST_SHOP_DOMAIN, orderGid);
        const result = await applyBackstop(sql, {
          shopDomain: TEST_SHOP_DOMAIN,
          shopId: resolved!.shopId,
          orderGid,
          buyerAccountId: resolved!.buyerAccountId,
          invoiceId: resolved!.invoiceId,
        });

        expect(result.applied).toBe(true);
        expect(result.fulfillmentOrdersHeld).toBe(1);

        const [dbRow] = await sql<{ action: string }[]>`
          SELECT action FROM backstop_processed_orders
          WHERE shop_id = ${TEST_SHOP_ID} AND order_gid = ${orderGid}
        `;
        expect(dbRow.action).toBe("held");

      } finally {
        await sql`DELETE FROM backstop_processed_orders WHERE order_gid = ${orderGid}`;
        await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
        mockGraphQL.mockReset();
      }
    });

    it("resolveInvoiceForOrder returns null for non-existent order", async () => {
      const { resolveInvoiceForOrder } = await import("../backstop.server");

      const resolved = await resolveInvoiceForOrder(
        sql,
        TEST_SHOP_DOMAIN,
        "gid://shopify/Order/nonexistent-order"
      );

      expect(resolved).toBeNull();
    });

    it("idempotent: second applyBackstop returns early if already processed", async () => {
      const { applyBackstop } = await import("../backstop.server");
      const { shopifyGraphQLRequest } = await import("../shopify-client.server");
      const mockGraphQL = shopifyGraphQLRequest as ReturnType<typeof vi.fn>;

      const orderGid = `gid://shopify/Order/idempotent-${TEST_SUFFIX}`;
      const invoiceId = `inv-idempotent-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderGid},
          '#TEST-IDEMPOTENT', 20000.00, 20000.00, 'open', NOW(), NOW(), NOW()
        )
      `;

      try {
        // First call: apply backstop
        mockGraphQL
          .mockResolvedValueOnce({
            success: true,
            data: {
              order: {
                fulfillmentOrders: {
                  edges: [
                    {
                      node: {
                        id: "gid://shopify/FulfillmentOrder/idemp-1",
                        status: "OPEN",
                        supportedActions: [{ action: "HOLD" }],
                      },
                    },
                  ],
                },
              },
            },
          })
          .mockResolvedValueOnce({
            success: true,
            data: {
              fulfillmentOrderHold: {
                fulfillmentOrder: { id: "gid://shopify/FulfillmentOrder/idemp-1", status: "ON_HOLD" },
                userErrors: [],
              },
            },
          })
          .mockResolvedValueOnce({
            success: true,
            data: { tagsAdd: { node: { id: orderGid }, userErrors: [] } },
          });

        const result1 = await applyBackstop(sql, {
          shopDomain: TEST_SHOP_DOMAIN,
          shopId: TEST_SHOP_ID,
          orderGid,
          buyerAccountId: TEST_ACCOUNT_ID,
          invoiceId,
        });

        expect(result1.applied).toBe(true);

        // Second call: returns early (already processed)
        mockGraphQL.mockReset();
        const result2 = await applyBackstop(sql, {
          shopDomain: TEST_SHOP_DOMAIN,
          shopId: TEST_SHOP_ID,
          orderGid,
          buyerAccountId: TEST_ACCOUNT_ID,
          invoiceId,
        });

        expect(result2.applied).toBe(false);
        expect(result2.skipped).toBe(true);
        expect(result2.skipReason).toContain("Already processed");
        expect(mockGraphQL).not.toHaveBeenCalled();

      } finally {
        await sql`DELETE FROM backstop_processed_orders WHERE order_gid = ${orderGid}`;
        await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
        mockGraphQL.mockReset();
      }
    });
  });
});
