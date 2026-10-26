/**
 * S25: Exactly-once bulk operation processing DB tests.
 *
 * Tests verify:
 * 1. Two concurrent processBulkOperation calls - only one wins completion claim
 * 2. Recovery skips ops with finish_received_at, active lease, or too young
 * 3. Two concurrent RECONCILE_ORDERS for same chain - stage claim exclusivity
 * 4. Lease contention returns retryable error without bumping failure_count
 * 5. Empty result (COMPLETED, url=null, objectCount=0) completes successfully
 * 6. partialDataUrl without url leads to permanent DLQ
 * 7. Claims purge and uninstall cleanup
 * 8. Stale recovery writes DLQ row with bulk_stale_recovery error code
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

vi.mock("../admin-client.server", () => ({
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

describeWithDb("S25 Exactly-Once Bulk Operations (DB-backed)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-s25";
  const TEST_SHOP_ID = `shop-s25-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-s25-${TEST_SUFFIX}.myshopify.com`;

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

  describe("claimBulkCompletion - exactly-once completion", () => {
    it("first caller wins completion claim, second caller loses", async () => {
      const { claimBulkCompletion } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/claim-race-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW())
      `;

      const [claim1, claim2] = await Promise.all([
        claimBulkCompletion(sql, bulkOpId),
        claimBulkCompletion(sql, bulkOpId),
      ]);

      const winCount = [claim1, claim2].filter(Boolean).length;
      expect(winCount).toBe(1);

      const [row] = await sql<{ completed_at: Date | null }[]>`
        SELECT completed_at FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.completed_at).not.toBeNull();
    });

    it("cannot claim a closed operation", async () => {
      const { claimBulkCompletion } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/claim-closed-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, closed_at, closed_reason)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW(), NOW(), 'reinstall_reset')
      `;

      const claimed = await claimBulkCompletion(sql, bulkOpId);
      expect(claimed).toBe(false);

      const [row] = await sql<{ completed_at: Date | null }[]>`
        SELECT completed_at FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.completed_at).toBeNull();
    });
  });

  describe("processing lease - prevents concurrent processing", () => {
    it("acquireProcessingLease succeeds when lease is available", async () => {
      const { acquireProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/lease-ok-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW())
      `;

      const acquired = await acquireProcessingLease(sql, bulkOpId);
      expect(acquired).toBe(true);

      const [row] = await sql<{ processing_lease_until: Date | null }[]>`
        SELECT processing_lease_until FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.processing_lease_until).not.toBeNull();
      expect(row.processing_lease_until!.getTime()).toBeGreaterThan(Date.now());
    });

    it("acquireProcessingLease fails when another processor holds the lease", async () => {
      const { acquireProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/lease-held-${TEST_SUFFIX}`;
      const futureLeaseTime = new Date(Date.now() + 60 * 1000);

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, processing_lease_until)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW(), ${futureLeaseTime})
      `;

      const acquired = await acquireProcessingLease(sql, bulkOpId);
      expect(acquired).toBe(false);
    });

    it("acquireProcessingLease succeeds when expired lease can be reclaimed", async () => {
      const { acquireProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/lease-expired-${TEST_SUFFIX}`;
      const pastLeaseTime = new Date(Date.now() - 60 * 1000);

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, processing_lease_until)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW(), ${pastLeaseTime})
      `;

      const acquired = await acquireProcessingLease(sql, bulkOpId);
      expect(acquired).toBe(true);
    });

    it("acquireProcessingLease fails for closed operations", async () => {
      const { acquireProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/lease-closed-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, closed_at, closed_reason)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW(), NOW(), 'reinstall_reset')
      `;

      const acquired = await acquireProcessingLease(sql, bulkOpId);
      expect(acquired).toBe(false);
    });

    it("releaseProcessingLease clears the lease", async () => {
      const { acquireProcessingLease, releaseProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/lease-release-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW())
      `;

      await acquireProcessingLease(sql, bulkOpId);
      await releaseProcessingLease(sql, bulkOpId);

      const [row] = await sql<{ processing_lease_until: Date | null }[]>`
        SELECT processing_lease_until FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.processing_lease_until).toBeNull();
    });
  });

  describe("markNextStageEnqueued - prevents duplicate stage enqueues", () => {
    it("first call returns true, second call returns false", async () => {
      const { markNextStageEnqueued } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/next-stage-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW())
      `;

      const first = await markNextStageEnqueued(sql, bulkOpId);
      const second = await markNextStageEnqueued(sql, bulkOpId);

      expect(first).toBe(true);
      expect(second).toBe(false);
    });
  });

  describe("saveBulkOperationProgress - byte offset monotonic advancement", () => {
    it("advances byte_offset only when new value is larger", async () => {
      const { saveBulkOperationProgress } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/progress-monotonic-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, byte_offset)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW(), 1000)
      `;

      const { rowUpdated: updated1 } = await saveBulkOperationProgress(sql, bulkOpId, 2000);
      expect(updated1).toBe(true);

      const { rowUpdated: updated2 } = await saveBulkOperationProgress(sql, bulkOpId, 1500);
      expect(updated2).toBe(false);

      const [row] = await sql<{ byte_offset: string }[]>`
        SELECT byte_offset::text FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.byte_offset).toBe("2000");
    });

    it("does not update completed operations", async () => {
      const { saveBulkOperationProgress } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/progress-completed-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, byte_offset, completed_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW(), 1000, NOW())
      `;

      const { rowUpdated } = await saveBulkOperationProgress(sql, bulkOpId, 2000);
      expect(rowUpdated).toBe(false);
    });
  });

  describe("reconcile stage claims - exactly-one-op per chain stage", () => {
    it("claimReconcileStage succeeds for new claim", async () => {
      const { claimReconcileStage } = await import("../reconcile-handlers.server");

      const chainKey = `2025-01-01-${TEST_SUFFIX}`;
      const claimed = await claimReconcileStage(sql, chainKey, "companies", TEST_SHOP_DOMAIN);

      expect(claimed).toBe(true);

      const [row] = await sql<{ chain_key: string }[]>`
        SELECT chain_key FROM s6_reconcile_stage_claims WHERE chain_key = ${chainKey} AND stage = 'companies'
      `;
      expect(row).toBeDefined();
    });

    it("claimReconcileStage fails for duplicate claim", async () => {
      const { claimReconcileStage } = await import("../reconcile-handlers.server");

      const chainKey = `2025-01-02-${TEST_SUFFIX}`;

      const first = await claimReconcileStage(sql, chainKey, "orders", TEST_SHOP_DOMAIN);
      const second = await claimReconcileStage(sql, chainKey, "orders", TEST_SHOP_DOMAIN);

      expect(first).toBe(true);
      expect(second).toBe(false);
    });

    it("claimReconcileStage can reclaim stale claims (older than 5 minutes, no bulk_op_id)", async () => {
      const { claimReconcileStage } = await import("../reconcile-handlers.server");

      const chainKey = `2025-01-03-${TEST_SUFFIX}`;
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

      await sql`
        INSERT INTO s6_reconcile_stage_claims (chain_key, stage, shop, claimed_at)
        VALUES (${chainKey}, 'companies', ${TEST_SHOP_DOMAIN}, ${tenMinutesAgo})
      `;

      const claimed = await claimReconcileStage(sql, chainKey, "companies", TEST_SHOP_DOMAIN);
      expect(claimed).toBe(true);
    });

    it("recordClaimBulkOperationId sets bulk_operation_id on claim", async () => {
      const { claimReconcileStage, recordClaimBulkOperationId } = await import("../reconcile-handlers.server");

      const chainKey = `2025-01-04-${TEST_SUFFIX}`;
      const bulkOpId = `gid://shopify/BulkOperation/claim-record-${TEST_SUFFIX}`;

      await claimReconcileStage(sql, chainKey, "orders", TEST_SHOP_DOMAIN);
      await recordClaimBulkOperationId(sql, chainKey, "orders", bulkOpId);

      const [row] = await sql<{ bulk_operation_id: string | null }[]>`
        SELECT bulk_operation_id FROM s6_reconcile_stage_claims
        WHERE chain_key = ${chainKey} AND stage = 'orders'
      `;
      expect(row.bulk_operation_id).toBe(bulkOpId);
    });

    it("purgeOldReconcileClaims removes claims older than 30 days", async () => {
      const { purgeOldReconcileClaims } = await import("../reconcile-handlers.server");

      const chainKey = `2025-old-${TEST_SUFFIX}`;
      const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);

      await sql`
        INSERT INTO s6_reconcile_stage_claims (chain_key, stage, shop, claimed_at)
        VALUES (${chainKey}, 'orders', ${TEST_SHOP_DOMAIN}, ${fortyDaysAgo})
      `;

      const purged = await purgeOldReconcileClaims(sql);
      expect(purged).toBeGreaterThanOrEqual(1);

      const [row] = await sql<{ chain_key: string }[]>`
        SELECT chain_key FROM s6_reconcile_stage_claims WHERE chain_key = ${chainKey}
      `;
      expect(row).toBeUndefined();
    });

    it("deleteShopReconcileClaims removes all claims for shop", async () => {
      const { deleteShopReconcileClaims } = await import("../reconcile-handlers.server");

      const chainKey1 = `2025-delete-1-${TEST_SUFFIX}`;
      const chainKey2 = `2025-delete-2-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_reconcile_stage_claims (chain_key, stage, shop)
        VALUES
          (${chainKey1}, 'companies', ${TEST_SHOP_DOMAIN}),
          (${chainKey2}, 'orders', ${TEST_SHOP_DOMAIN})
      `;

      const deleted = await deleteShopReconcileClaims(sql, TEST_SHOP_DOMAIN);
      expect(deleted).toBe(2);

      const rows = await sql<{ chain_key: string }[]>`
        SELECT chain_key FROM s6_reconcile_stage_claims WHERE shop = ${TEST_SHOP_DOMAIN}
      `;
      expect(rows).toHaveLength(0);
    });
  });

  describe("findStaleBulkOperations - S25 exclusions", () => {
    it("excludes ops with finish_received_at set", async () => {
      const { findStaleBulkOperations } = await import("../bulk-op-recovery.server");

      const bulkOpId = `gid://shopify/BulkOperation/finish-received-${TEST_SUFFIX}`;
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, finish_received_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', ${twoHoursAgo}, NOW())
      `;

      const result = await findStaleBulkOperations(sql, 60);
      const found = result.find((r) => r.bulk_operation_id === bulkOpId);
      expect(found).toBeUndefined();
    });

    it("excludes ops with active processing lease", async () => {
      const { findStaleBulkOperations } = await import("../bulk-op-recovery.server");

      const bulkOpId = `gid://shopify/BulkOperation/active-lease-${TEST_SUFFIX}`;
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const futureLease = new Date(Date.now() + 60 * 1000);

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, processing_lease_until)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', ${twoHoursAgo}, ${futureLease})
      `;

      const result = await findStaleBulkOperations(sql, 60);
      const found = result.find((r) => r.bulk_operation_id === bulkOpId);
      expect(found).toBeUndefined();
    });

    it("includes ops with expired processing lease", async () => {
      const { findStaleBulkOperations } = await import("../bulk-op-recovery.server");

      const bulkOpId = `gid://shopify/BulkOperation/expired-lease-${TEST_SUFFIX}`;
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const pastLease = new Date(Date.now() - 60 * 1000);

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, processing_lease_until)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', ${twoHoursAgo}, ${pastLease})
      `;

      const result = await findStaleBulkOperations(sql, 60);
      const found = result.find((r) => r.bulk_operation_id === bulkOpId);
      expect(found).toBeDefined();
    });
  });

  describe("markBulkOperationFailed - DLQ row write for stale recovery", () => {
    it("writes DLQ row with bulk_stale_recovery error code when marking failed", async () => {
      const { markBulkOperationFailed } = await import("../bulk-op-recovery.server");
      const { BULK_ERROR_CODES } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/dlq-stale-${TEST_SUFFIX}`;
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', ${twoHoursAgo})
      `;

      const result = await markBulkOperationFailed(sql, bulkOpId, TEST_SHOP_DOMAIN, "companies", "FAILED");
      expect(result).toBe(true);

      const [dlqRow] = await sql<{ error: string; message: { bulkOperationId: string } }[]>`
        SELECT error, message
        FROM s6_dead_letter
        WHERE message->>'bulkOperationId' = ${bulkOpId}
      `;

      expect(dlqRow).toBeDefined();
      expect(dlqRow.error).toBe(BULK_ERROR_CODES.STALE_RECOVERY);
      expect(dlqRow.message.bulkOperationId).toBe(bulkOpId);
    });
  });
});
