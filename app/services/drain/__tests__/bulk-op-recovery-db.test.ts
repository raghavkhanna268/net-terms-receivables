/**
 * DB-backed integration tests for bulk operation recovery.
 *
 * Tests verify:
 * 1. Old open rows (> threshold) are found and recovered
 * 2. Fresh open rows (< threshold) are left alone
 * 3. COMPLETED operations are enqueued for processing
 * 4. FAILED/CANCELED/EXPIRED operations are marked failed
 * 5. Already-completed operations are not affected
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

vi.mock("../admin-client.server", () => ({
  adminGraphQL: vi.fn(),
  BULK_OPERATION_STATUS_QUERY: "mock-query",
}));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("bulk-op-recovery (DB-backed)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-recovery";
  const TEST_SHOP_ID = `shop-recovery-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `recovery-test-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_bulk_operations WHERE shop = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    await sql`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_bulk_operations WHERE shop = ${TEST_SHOP_DOMAIN}`;
  });

  describe("findStaleBulkOperations", () => {
    it("finds old open rows (started > threshold ago)", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/stale-${TEST_SUFFIX}`;
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies', ${twoHoursAgo})
      `;

      const { findStaleBulkOperations } = await import("../bulk-op-recovery.server");
      const result = await findStaleBulkOperations(sql, 60);

      const found = result.find((r) => r.bulk_operation_id === bulkOpId);
      expect(found).toBeDefined();
      expect(found?.shop).toBe(TEST_SHOP_DOMAIN);
    });

    it("ignores fresh open rows (started < threshold ago)", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/fresh-${TEST_SUFFIX}`;
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies', ${tenMinutesAgo})
      `;

      const { findStaleBulkOperations } = await import("../bulk-op-recovery.server");
      const result = await findStaleBulkOperations(sql, 60);

      const found = result.find((r) => r.bulk_operation_id === bulkOpId);
      expect(found).toBeUndefined();
    });

    it("ignores completed operations", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/completed-${TEST_SUFFIX}`;
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000);

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, completed_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies', ${twoHoursAgo}, ${oneHourAgo})
      `;

      const { findStaleBulkOperations } = await import("../bulk-op-recovery.server");
      const result = await findStaleBulkOperations(sql, 60);

      const found = result.find((r) => r.bulk_operation_id === bulkOpId);
      expect(found).toBeUndefined();
    });
  });

  describe("markBulkOperationFailed", () => {
    it("sets failure_count to 5 for open operation", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/mark-failed-${TEST_SUFFIX}`;
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, failure_count)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies', ${twoHoursAgo}, 0)
      `;

      const { markBulkOperationFailed } = await import("../bulk-op-recovery.server");
      const result = await markBulkOperationFailed(sql, bulkOpId);

      expect(result).toBe(true);

      const [row] = await sql<{ failure_count: number }[]>`
        SELECT failure_count FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.failure_count).toBe(5);
    });

    it("returns false for already-completed operation", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/mark-completed-${TEST_SUFFIX}`;
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000);

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, completed_at, failure_count)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies', ${twoHoursAgo}, ${oneHourAgo}, 0)
      `;

      const { markBulkOperationFailed } = await import("../bulk-op-recovery.server");
      const result = await markBulkOperationFailed(sql, bulkOpId);

      expect(result).toBe(false);

      const [row] = await sql<{ failure_count: number }[]>`
        SELECT failure_count FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.failure_count).toBe(0);
    });
  });

  describe("recoverStaleBulkOperations (integration)", () => {
    it("enqueues COMPLETED stale operation", async () => {
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/recover-completed-${TEST_SUFFIX}`;
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: { node: { id: bulkOpId, status: "COMPLETED" } },
        retryable: false,
      });

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies', ${twoHoursAgo})
      `;

      const { recoverStaleBulkOperations } = await import("../bulk-op-recovery.server");
      const result = await recoverStaleBulkOperations(sql, 60);

      expect(result.found).toBeGreaterThanOrEqual(1);

      const opAttempt = result.attempts.find((a) => a.bulkOperationId === bulkOpId);
      expect(opAttempt).toBeDefined();
      expect(opAttempt?.status).toBe("enqueued");

      const [queuedMsg] = await sql<{ message: { bulkOperationId: string } }[]>`
        SELECT message FROM pgmq.q_s6_bulk
        WHERE message->>'bulkOperationId' = ${bulkOpId}
        LIMIT 1
      `;
      expect(queuedMsg).toBeDefined();
      expect(queuedMsg.message.bulkOperationId).toBe(bulkOpId);
    });

    it("marks FAILED stale operation as failed", async () => {
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/recover-failed-${TEST_SUFFIX}`;
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: { node: { id: bulkOpId, status: "FAILED" } },
        retryable: false,
      });

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, failure_count)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'orders', 'reconcile', 'orders', ${twoHoursAgo}, 0)
      `;

      const { recoverStaleBulkOperations } = await import("../bulk-op-recovery.server");
      const result = await recoverStaleBulkOperations(sql, 60);

      const opAttempt = result.attempts.find((a) => a.bulkOperationId === bulkOpId);
      expect(opAttempt).toBeDefined();
      expect(opAttempt?.status).toBe("marked_failed");

      const [row] = await sql<{ failure_count: number }[]>`
        SELECT failure_count FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.failure_count).toBe(5);
    });

    it("leaves fresh open rows alone", async () => {
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/fresh-running-${TEST_SUFFIX}`;
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: { node: { id: bulkOpId, status: "RUNNING" } },
        retryable: false,
      });

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, failure_count)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies', ${tenMinutesAgo}, 0)
      `;

      const { recoverStaleBulkOperations } = await import("../bulk-op-recovery.server");
      const result = await recoverStaleBulkOperations(sql, 60);

      const opAttempt = result.attempts.find((a) => a.bulkOperationId === bulkOpId);
      expect(opAttempt).toBeUndefined();

      const [row] = await sql<{ failure_count: number; completed_at: Date | null }[]>`
        SELECT failure_count, completed_at FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.failure_count).toBe(0);
      expect(row.completed_at).toBeNull();
    });

    it("skips RUNNING stale operations (still in progress at Shopify)", async () => {
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/stale-running-${TEST_SUFFIX}`;
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: { node: { id: bulkOpId, status: "RUNNING" } },
        retryable: false,
      });

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, failure_count)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies', ${twoHoursAgo}, 0)
      `;

      const { recoverStaleBulkOperations } = await import("../bulk-op-recovery.server");
      const result = await recoverStaleBulkOperations(sql, 60);

      const opAttempt = result.attempts.find((a) => a.bulkOperationId === bulkOpId);
      expect(opAttempt).toBeDefined();
      expect(opAttempt?.status).toBe("skipped");
      expect(opAttempt?.shopifyStatus).toBe("RUNNING");

      const [row] = await sql<{ failure_count: number; completed_at: Date | null }[]>`
        SELECT failure_count, completed_at FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.failure_count).toBe(0);
      expect(row.completed_at).toBeNull();
    });
  });

  describe("recoverStaleBulkOperationsForShop", () => {
    it("only recovers operations for the specified shop", async () => {
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/shop-specific-${TEST_SUFFIX}`;
      const otherBulkOpId = `gid://shopify/BulkOperation/other-shop-${TEST_SUFFIX}`;
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const otherShopDomain = `other-${TEST_SUFFIX}.myshopify.com`;
      const otherShopId = `shop-other-${TEST_SUFFIX}`;

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: { node: { status: "FAILED" } },
        retryable: false,
      });

      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${otherShopId}, ${otherShopDomain}, 'USD', NOW(), NOW())
      `;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies', ${twoHoursAgo})
      `;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at)
        VALUES (${otherBulkOpId}, ${otherShopDomain}, 'companies', 'reconcile', 'companies', ${twoHoursAgo})
      `;

      const { recoverStaleBulkOperationsForShop } = await import("../bulk-op-recovery.server");
      const result = await recoverStaleBulkOperationsForShop(sql, TEST_SHOP_DOMAIN, 60);

      expect(result.found).toBe(1);
      const attempt = result.attempts.find((a) => a.bulkOperationId === bulkOpId);
      expect(attempt).toBeDefined();

      const [otherRow] = await sql<{ failure_count: number }[]>`
        SELECT failure_count FROM s6_bulk_operations WHERE bulk_operation_id = ${otherBulkOpId}
      `;
      expect(otherRow.failure_count).toBe(0);

      await sql`DELETE FROM s6_bulk_operations WHERE shop = ${otherShopDomain}`;
      await sql`DELETE FROM "Shop" WHERE id = ${otherShopId}`;
    });
  });
});
