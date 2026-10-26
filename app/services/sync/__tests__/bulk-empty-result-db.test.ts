/**
 * DB-backed tests for bulk operation empty result handling.
 *
 * Tests verify:
 * 1. COMPLETED, objectCount '0', url key ABSENT: completes
 * 2. COMPLETED, '0', url null: completes (regression)
 * 3. COMPLETED, objectCount absent, url absent: stays the retryable NO_RESULT_URL path
 * 4. COMPLETED, '1', url absent: NO_RESULT_URL permanent
 * 5. COMPLETED, '0', url absent, partialDataUrl set: not treated as empty
 * 6. failure_count 5 + COMPLETED '0' url absent: completes
 * 7. failure_count 5 + non-empty status: MAX_FAILURES
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { assertNoQueueLeftovers } from "../../../../tests/helpers/queue-leftovers";

vi.mock("../../drain/admin-client.server", () => ({
  adminGraphQL: vi.fn(),
  BULK_OPERATION_STATUS_QUERY: "mock-query",
}));

vi.mock("~/lib/request-context.server", () => ({
  getRequestEnv: vi.fn(() => ({ CUSTOMER_PII_FIELDS: "1" })),
  getRequestSql: vi.fn(() => ({})),
  getRequestWaitUntil: vi.fn(() => () => {}),
  requestContext: { getStore: vi.fn() },
}));

vi.mock("~/shopify.server", () => ({
  sessionStorage: {},
  shopify: {},
}));

vi.mock("~/services/sync/company.server", () => ({
  isWebhookProcessed: vi.fn().mockResolvedValue(false),
  markWebhookProcessed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("~/services/sync/company-location.server", () => ({
  mapCompanyLocationToBuyerAccount: vi.fn(() => ({})),
  bulkUpsertBuyerAccounts: vi.fn().mockResolvedValue(0),
}));

vi.mock("~/services/sync/order.server", () => ({
  mapOrderToInvoiceWithEligibility: vi.fn(() => ({ invoiceData: {}, outstandingMissing: false })),
  bulkUpsertInvoices: vi.fn().mockResolvedValue(0),
}));

vi.mock("~/lib/invoice-eligibility", () => ({
  checkOrderEligibility: vi.fn().mockResolvedValue({ eligible: true, buyerAccountId: "buyer-mock" }),
  getEligibilityContext: vi.fn().mockResolvedValue({ shop: { id: "shop-123" } }),
  isTerminalFinancialStatus: vi.fn().mockReturnValue(false),
}));

vi.mock("~/services/sync/customer.server", () => ({
  processBulkCustomer: vi.fn().mockResolvedValue({ success: true, action: "skipped" }),
  getTagRules: vi.fn().mockResolvedValue([]),
}));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("bulk empty-result handling (DB-backed)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-empty";
  const TEST_SHOP_ID = `test-shop-empty-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-empty-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_reconcile_stage_claims WHERE shop = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_bulk_operations WHERE shop = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;

    await assertNoQueueLeftovers(sql, [TEST_SHOP_DOMAIN], "bulk-empty-result-db.test.ts");

    await sql.end();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_reconcile_stage_claims WHERE shop = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_bulk_operations WHERE shop = ${TEST_SHOP_DOMAIN}`;
  });

  describe("empty result detection with url absent vs null", () => {
    it("(1) COMPLETED, objectCount '0', url key ABSENT: completes, completed_at is set, failure_count 0, no DLQ", async () => {
      const { adminGraphQL } = await import("../../drain/admin-client.server");
      const { processBulkOperation } = await import("../bulk-jsonl-processor.server");
      const { getInitialSyncState } = await import("~/lib/initial-sync.server");

      const bulkOpId = `gid://shopify/BulkOperation/empty-url-absent-${TEST_SUFFIX}`;
      const webhookId = `webhook-empty-url-absent-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, failure_count)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'orders', 'reconcile', 'orders', NOW(), 0)
      `;

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: {
            id: bulkOpId,
            status: "COMPLETED",
            objectCount: "0",
            fileSize: null,
            errorCode: null,
          },
        },
        retryable: false,
      });

      const result = await processBulkOperation(sql, {
        topic: "BULK_OPERATIONS_FINISH",
        shop: TEST_SHOP_DOMAIN,
        webhookId,
        enqueuedAt: new Date().toISOString(),
        bulkOperationId: bulkOpId,
        bulkType: "orders",
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe("complete");

      const [row] = await sql<{ completed_at: Date | null; failure_count: number }[]>`
        SELECT completed_at, failure_count FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.completed_at).not.toBeNull();
      expect(row.failure_count).toBe(0);

      const dlqRows = await sql`
        SELECT * FROM s6_dead_letter WHERE message->>'bulkOperationId' = ${bulkOpId}
      `;
      expect(dlqRows.length).toBe(0);

      const syncState = await getInitialSyncState(sql, TEST_SHOP_DOMAIN);
      expect(syncState.status).not.toBe("failed");
    });

    it("(2) COMPLETED, objectCount '0', url null: completes (regression)", async () => {
      const { adminGraphQL } = await import("../../drain/admin-client.server");
      const { processBulkOperation } = await import("../bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/empty-url-null-${TEST_SUFFIX}`;
      const webhookId = `webhook-empty-url-null-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, failure_count)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'orders', 'reconcile', 'orders', NOW(), 0)
      `;

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: {
            id: bulkOpId,
            status: "COMPLETED",
            url: null,
            objectCount: "0",
            fileSize: null,
            errorCode: null,
          },
        },
        retryable: false,
      });

      const result = await processBulkOperation(sql, {
        topic: "BULK_OPERATIONS_FINISH",
        shop: TEST_SHOP_DOMAIN,
        webhookId,
        enqueuedAt: new Date().toISOString(),
        bulkOperationId: bulkOpId,
        bulkType: "orders",
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe("complete");

      const [row] = await sql<{ completed_at: Date | null }[]>`
        SELECT completed_at FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.completed_at).not.toBeNull();
    });

    it("(3) COMPLETED, objectCount absent, url absent: stays the retryable NO_RESULT_URL path (failure_count increments)", async () => {
      const { adminGraphQL } = await import("../../drain/admin-client.server");
      const { processBulkOperation } = await import("../bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/no-objectcount-${TEST_SUFFIX}`;
      const webhookId = `webhook-no-objectcount-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, failure_count)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'orders', 'reconcile', 'orders', NOW(), 0)
      `;

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: {
            id: bulkOpId,
            status: "COMPLETED",
            fileSize: null,
            errorCode: null,
          },
        },
        retryable: false,
      });

      const result = await processBulkOperation(sql, {
        topic: "BULK_OPERATIONS_FINISH",
        shop: TEST_SHOP_DOMAIN,
        webhookId,
        enqueuedAt: new Date().toISOString(),
        bulkOperationId: bulkOpId,
        bulkType: "orders",
      });

      expect(result.success).toBe(false);
      expect(result.errorType).toBe("retryable");
      expect(result.errorCode).toBe("bulk_no_result_url");

      const [row] = await sql<{ failure_count: number }[]>`
        SELECT failure_count FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.failure_count).toBe(1);
    });

    it("(4) COMPLETED, objectCount '1', url absent: NO_RESULT_URL permanent (the S25 branch)", async () => {
      const { adminGraphQL } = await import("../../drain/admin-client.server");
      const { processBulkOperation } = await import("../bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/has-objects-no-url-${TEST_SUFFIX}`;
      const webhookId = `webhook-has-objects-no-url-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, failure_count)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'orders', 'reconcile', 'orders', NOW(), 0)
      `;

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: {
            id: bulkOpId,
            status: "COMPLETED",
            objectCount: "1",
            fileSize: null,
            errorCode: null,
          },
        },
        retryable: false,
      });

      const result = await processBulkOperation(sql, {
        topic: "BULK_OPERATIONS_FINISH",
        shop: TEST_SHOP_DOMAIN,
        webhookId,
        enqueuedAt: new Date().toISOString(),
        bulkOperationId: bulkOpId,
        bulkType: "orders",
      });

      expect(result.success).toBe(false);
      expect(result.errorType).toBe("permanent");
      expect(result.errorCode).toBe("bulk_no_result_url");
    });

    it("(5) COMPLETED, objectCount '0', url absent, partialDataUrl set: not treated as empty", async () => {
      const { adminGraphQL } = await import("../../drain/admin-client.server");
      const { processBulkOperation } = await import("../bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/partial-data-url-${TEST_SUFFIX}`;
      const webhookId = `webhook-partial-data-url-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, failure_count)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'orders', 'reconcile', 'orders', NOW(), 0)
      `;

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: {
            id: bulkOpId,
            status: "COMPLETED",
            objectCount: "0",
            fileSize: null,
            errorCode: null,
            partialDataUrl: "https://storage.shopify.com/partial.jsonl",
          },
        },
        retryable: false,
      });

      const result = await processBulkOperation(sql, {
        topic: "BULK_OPERATIONS_FINISH",
        shop: TEST_SHOP_DOMAIN,
        webhookId,
        enqueuedAt: new Date().toISOString(),
        bulkOperationId: bulkOpId,
        bulkType: "orders",
      });

      expect(result.success).toBe(false);
      expect(result.errorType).toBe("permanent");
      expect(result.errorCode).toBe("bulk_no_result_url");
    });
  });

  describe("failure_count 5 handling with empty result", () => {
    it("(6) failure_count 5 + COMPLETED '0' url absent (and null): completes, completed_at is set, initial-sync not failed", async () => {
      const { adminGraphQL } = await import("../../drain/admin-client.server");
      const { processBulkOperation } = await import("../bulk-jsonl-processor.server");
      const { getInitialSyncState } = await import("~/lib/initial-sync.server");

      const bulkOpId = `gid://shopify/BulkOperation/maxfail-empty-${TEST_SUFFIX}`;
      const webhookId = `webhook-maxfail-empty-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, failure_count)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'orders', 'reconcile', 'orders', NOW(), 5)
      `;

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: {
            id: bulkOpId,
            status: "COMPLETED",
            objectCount: "0",
            fileSize: null,
            errorCode: null,
          },
        },
        retryable: false,
      });

      const result = await processBulkOperation(sql, {
        topic: "BULK_OPERATIONS_FINISH",
        shop: TEST_SHOP_DOMAIN,
        webhookId,
        enqueuedAt: new Date().toISOString(),
        bulkOperationId: bulkOpId,
        bulkType: "orders",
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe("complete");

      const [row] = await sql<{ completed_at: Date | null }[]>`
        SELECT completed_at FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.completed_at).not.toBeNull();

      const syncState = await getInitialSyncState(sql, TEST_SHOP_DOMAIN);
      expect(syncState.status).not.toBe("failed");
    });

    it("(7) failure_count 5 with non-empty status (url absent, '1'): still returns MAX_FAILURES", async () => {
      const { adminGraphQL } = await import("../../drain/admin-client.server");
      const { processBulkOperation } = await import("../bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/maxfail-nonempty-${TEST_SUFFIX}`;
      const webhookId = `webhook-maxfail-nonempty-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, failure_count)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'orders', 'reconcile', 'orders', NOW(), 5)
      `;

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: {
            id: bulkOpId,
            status: "COMPLETED",
            objectCount: "1",
            fileSize: null,
            errorCode: null,
          },
        },
        retryable: false,
      });

      const result = await processBulkOperation(sql, {
        topic: "BULK_OPERATIONS_FINISH",
        shop: TEST_SHOP_DOMAIN,
        webhookId,
        enqueuedAt: new Date().toISOString(),
        bulkOperationId: bulkOpId,
        bulkType: "orders",
      });

      expect(result.success).toBe(false);
      expect(result.errorType).toBe("permanent");
      expect(result.errorCode).toBe("bulk_max_failures");
    });
  });
});
