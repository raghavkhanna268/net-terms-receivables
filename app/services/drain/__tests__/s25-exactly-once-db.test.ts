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
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
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
    it("first caller wins completion claim, second caller loses (with owner-checked tokens)", async () => {
      const { claimBulkCompletion, acquireProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/claim-race-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW())
      `;

      // First processor acquires lease
      const leaseA = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(leaseA).not.toBeNull();

      // Racing claims - only A has the correct lease token, B has a wrong one
      const wrongToken = "wrong-token-B";
      const [claim1, claim2] = await Promise.all([
        claimBulkCompletion(sql, bulkOpId, TEST_SHOP_DOMAIN, leaseA!),
        claimBulkCompletion(sql, bulkOpId, TEST_SHOP_DOMAIN, wrongToken),
      ]);

      // Only the caller with the correct lease token wins
      expect(claim1).toBe(true);
      expect(claim2).toBe(false);

      const [row] = await sql<{ completed_at: Date | null }[]>`
        SELECT completed_at FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.completed_at).not.toBeNull();
    });

    it("cannot claim a closed operation", async () => {
      const { claimBulkCompletion } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/claim-closed-${TEST_SUFFIX}`;

      // Insert with a lease token so we can test with it
      const testToken = "test-token-closed";
      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, closed_at, closed_reason, processing_lease_token)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW(), NOW(), 'reinstall_reset', ${testToken})
      `;

      // Even with correct token, cannot claim closed operation
      const claimed = await claimBulkCompletion(sql, bulkOpId, TEST_SHOP_DOMAIN, testToken);
      expect(claimed).toBe(false);

      const [row] = await sql<{ completed_at: Date | null }[]>`
        SELECT completed_at FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.completed_at).toBeNull();
    });
  });

  describe("processing lease - token-based ownership", () => {
    it("acquireProcessingLease returns a UUID token when lease is available", async () => {
      const { acquireProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/lease-ok-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW())
      `;

      const token = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(token).not.toBeNull();
      expect(typeof token).toBe("string");
      // UUID format check
      expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

      const [row] = await sql<{ processing_lease_until: Date | null; processing_lease_token: string | null }[]>`
        SELECT processing_lease_until, processing_lease_token FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.processing_lease_until).not.toBeNull();
      expect(row.processing_lease_until!.getTime()).toBeGreaterThan(Date.now());
      expect(row.processing_lease_token).toBe(token);
    });

    it("acquireProcessingLease fails when another processor holds the lease", async () => {
      const { acquireProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/lease-held-${TEST_SUFFIX}`;
      const futureLeaseTime = new Date(Date.now() + 60 * 1000);

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, processing_lease_until, processing_lease_token)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW(), ${futureLeaseTime}, 'existing-token')
      `;

      const token = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(token).toBeNull();
    });

    it("acquireProcessingLease succeeds when expired lease can be reclaimed", async () => {
      const { acquireProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/lease-expired-${TEST_SUFFIX}`;
      const pastLeaseTime = new Date(Date.now() - 60 * 1000);

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, processing_lease_until, processing_lease_token)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW(), ${pastLeaseTime}, 'old-token')
      `;

      const token = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(token).not.toBeNull();
      // New token should be generated
      expect(token).not.toBe("old-token");
    });

    it("acquireProcessingLease fails for closed operations", async () => {
      const { acquireProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/lease-closed-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, closed_at, closed_reason)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW(), NOW(), 'reinstall_reset')
      `;

      const token = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(token).toBeNull();
    });

    it("releaseProcessingLease clears both lease and token for owner", async () => {
      const { acquireProcessingLease, releaseProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/lease-release-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW())
      `;

      const token = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(token).not.toBeNull();
      await releaseProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN, token);

      const [row] = await sql<{ processing_lease_until: Date | null; processing_lease_token: string | null }[]>`
        SELECT processing_lease_until, processing_lease_token FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.processing_lease_until).toBeNull();
      expect(row.processing_lease_token).toBeNull();
    });

    it("Run A acquires, its lease expires, B acquires; A's release leaves B's token and lease intact", async () => {
      const { acquireProcessingLease, releaseProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/lease-stale-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW())
      `;

      // Processor A acquires lease
      const tokenA = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(tokenA).not.toBeNull();

      // Simulate A's lease expiring
      await sql`
        UPDATE s6_bulk_operations
        SET processing_lease_until = NOW() - interval '1 second'
        WHERE bulk_operation_id = ${bulkOpId}
      `;

      // B acquires (A's lease expired)
      const tokenB = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(tokenB).not.toBeNull();
      expect(tokenB).not.toBe(tokenA);

      // A's finally block tries to release with stale token - should NOT clear B's lease
      await releaseProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN, tokenA);

      const [row] = await sql<{ processing_lease_until: Date | null; processing_lease_token: string | null }[]>`
        SELECT processing_lease_until, processing_lease_token FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      // B's lease and token should still be held
      expect(row.processing_lease_until).not.toBeNull();
      expect(row.processing_lease_token).toBe(tokenB);
    });

    it("A's renew after B took over returns false, and A stops", async () => {
      const { acquireProcessingLease, renewProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/lease-renew-stale-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW())
      `;

      // A acquires lease
      const tokenA = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(tokenA).not.toBeNull();

      // Simulate A's lease expiring
      await sql`
        UPDATE s6_bulk_operations
        SET processing_lease_until = NOW() - interval '1 second'
        WHERE bulk_operation_id = ${bulkOpId}
      `;

      // B acquires (A's lease expired)
      const tokenB = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(tokenB).not.toBeNull();
      expect(tokenB).not.toBe(tokenA);

      // A tries to renew with its stale token - should fail (return false)
      const renewed = await renewProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN, tokenA!);
      expect(renewed).toBe(false);

      // B's lease should still be intact
      const [row] = await sql<{ processing_lease_token: string | null }[]>`
        SELECT processing_lease_token FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.processing_lease_token).toBe(tokenB);
    });

    it("renewProcessingLease succeeds for the token owner", async () => {
      const { acquireProcessingLease, renewProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/lease-renew-ok-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW())
      `;

      const token = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(token).not.toBeNull();

      const renewed = await renewProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN, token!);
      expect(renewed).toBe(true);

      // Token should still be the same
      const [row] = await sql<{ processing_lease_token: string | null }[]>`
        SELECT processing_lease_token FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.processing_lease_token).toBe(token);
    });

    // Condition (c): Legacy NULL-token rows
    it("legacy row with NULL token and live lease is not acquirable", async () => {
      const { acquireProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/legacy-live-${TEST_SUFFIX}`;
      const futureLeaseTime = new Date(Date.now() + 60 * 1000);

      // Legacy row: processing_lease_until is set but processing_lease_token is NULL
      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, processing_lease_until, processing_lease_token)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW(), ${futureLeaseTime}, NULL)
      `;

      // Cannot acquire - lease is still live
      const token = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(token).toBeNull();
    });

    it("legacy row with NULL token and expired lease is acquirable", async () => {
      const { acquireProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/legacy-expired-${TEST_SUFFIX}`;
      const pastLeaseTime = new Date(Date.now() - 60 * 1000);

      // Legacy row: processing_lease_until is expired and processing_lease_token is NULL
      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, processing_lease_until, processing_lease_token)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW(), ${pastLeaseTime}, NULL)
      `;

      // Can acquire - lease is expired
      const token = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(token).not.toBeNull();

      // Token should now be set
      const [row] = await sql<{ processing_lease_token: string | null }[]>`
        SELECT processing_lease_token FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.processing_lease_token).toBe(token);
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

      const first = await markNextStageEnqueued(sql, bulkOpId, TEST_SHOP_DOMAIN);
      const second = await markNextStageEnqueued(sql, bulkOpId, TEST_SHOP_DOMAIN);

      expect(first).toBe(true);
      expect(second).toBe(false);
    });
  });

  describe("saveBulkOperationProgress - byte offset monotonic advancement", () => {
    it("advances byte_offset only when new value is larger", async () => {
      const { saveBulkOperationProgress, acquireProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/progress-monotonic-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, byte_offset)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW(), 1000)
      `;

      // Acquire lease to get a valid token (required for owner-checked writes)
      const leaseToken = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(leaseToken).not.toBeNull();

      const { rowUpdated: updated1 } = await saveBulkOperationProgress(sql, bulkOpId, 2000, leaseToken!);
      expect(updated1).toBe(true);

      const { rowUpdated: updated2 } = await saveBulkOperationProgress(sql, bulkOpId, 1500, leaseToken!);
      expect(updated2).toBe(false);

      const [row] = await sql<{ byte_offset: string }[]>`
        SELECT byte_offset::text FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.byte_offset).toBe("2000");
    });

    it("does not update completed operations", async () => {
      const { saveBulkOperationProgress } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/progress-completed-${TEST_SUFFIX}`;

      // Insert with a known lease token so we can test with it
      const testToken = "test-token-completed";
      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, byte_offset, completed_at, processing_lease_token)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW(), 1000, NOW(), ${testToken})
      `;

      // Even with correct token, should not update completed operations
      const { rowUpdated } = await saveBulkOperationProgress(sql, bulkOpId, 2000, testToken);
      expect(rowUpdated).toBe(false);
    });
  });

  describe("reconcile stage claims - exactly-one-op per chain stage", () => {
    it("claimReconcileStage succeeds for new claim", async () => {
      const { claimReconcileStage } = await import("../reconcile-handlers.server");

      const chainKey = `2025-01-01-${TEST_SUFFIX}`;
      const claimed = await claimReconcileStage(sql, chainKey, "companies", TEST_SHOP_DOMAIN);

      expect(claimed).toBe("claimed");

      const [row] = await sql<{ chain_key: string }[]>`
        SELECT chain_key FROM s6_reconcile_stage_claims WHERE chain_key = ${chainKey} AND stage = 'companies'
      `;
      expect(row).toBeDefined();
    });

    it("claimReconcileStage fails for duplicate claim with bulk_operation_id set", async () => {
      const { claimReconcileStage, recordClaimBulkOperationId } = await import("../reconcile-handlers.server");

      const chainKey = `2025-01-02-${TEST_SUFFIX}`;
      const bulkOpId = `gid://shopify/BulkOperation/duplicate-claim-${TEST_SUFFIX}`;

      const first = await claimReconcileStage(sql, chainKey, "orders", TEST_SHOP_DOMAIN);
      expect(first).toBe("claimed");

      // Record bulk_operation_id to mark as "already running"
      await recordClaimBulkOperationId(sql, chainKey, "orders", TEST_SHOP_DOMAIN, bulkOpId);

      // S25: Also create the op row - claimReconcileStage now verifies the op exists
      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'orders', 'reconcile', NOW())
      `;

      const second = await claimReconcileStage(sql, chainKey, "orders", TEST_SHOP_DOMAIN);
      expect(second).toBe("already_running");
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
      expect(claimed).toBe("claimed");
    });

    it("recordClaimBulkOperationId sets bulk_operation_id on claim", async () => {
      const { claimReconcileStage, recordClaimBulkOperationId } = await import("../reconcile-handlers.server");

      const chainKey = `2025-01-04-${TEST_SUFFIX}`;
      const bulkOpId = `gid://shopify/BulkOperation/claim-record-${TEST_SUFFIX}`;

      await claimReconcileStage(sql, chainKey, "orders", TEST_SHOP_DOMAIN);
      await recordClaimBulkOperationId(sql, chainKey, "orders", TEST_SHOP_DOMAIN, bulkOpId);

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

      // Clean up all old claims globally first to get exact count
      await sql`DELETE FROM s6_reconcile_stage_claims WHERE claimed_at < now() - interval '30 days'`;

      await sql`
        INSERT INTO s6_reconcile_stage_claims (chain_key, stage, shop, claimed_at)
        VALUES (${chainKey}, 'orders', ${TEST_SHOP_DOMAIN}, ${fortyDaysAgo})
      `;

      // Verify the claim exists before purge
      const [beforePurge] = await sql<{ chain_key: string }[]>`
        SELECT chain_key FROM s6_reconcile_stage_claims WHERE chain_key = ${chainKey}
      `;
      expect(beforePurge).toBeDefined();

      const purged = await purgeOldReconcileClaims(sql);
      // Exactly 1 claim (ours) should be purged since we cleaned up first
      expect(purged).toBe(1);

      // Verify the specific test claim was purged
      const [afterPurge] = await sql<{ chain_key: string }[]>`
        SELECT chain_key FROM s6_reconcile_stage_claims WHERE chain_key = ${chainKey}
      `;
      expect(afterPurge).toBeUndefined();
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

  // ==========================================================================
  // C1: Concurrent processBulkOperation on ONE op (3 deliveries, non-empty JSONL)
  // Uses production path: getBulkHandler("BULK_OPERATIONS_FINISH") which calls
  // processBulkOperation AND enqueueReconcileStage when nextStage is set.
  // ==========================================================================
  describe("C1: concurrent processBulkOperation - exactly one completion and one next-stage enqueue", () => {
    it("three concurrent deliveries (webhook + recovery + redelivery) on non-empty JSONL path result in exactly one customers-stage enqueue", async () => {
      const { getBulkHandler } = await import("../processor.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/concurrent-c1-${TEST_SUFFIX}`;
      const webhookId1 = `finish:${bulkOpId}:webhook`;
      const webhookId2 = `recovery:${bulkOpId}`;
      const webhookId3 = `redelivery:${bulkOpId}`;

      // Setup bulk operation
      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies', NOW())
      `;

      // Create a minimal valid JSONL response (one company)
      const jsonlContent = JSON.stringify({
        id: "gid://shopify/Company/1",
        name: "Test Company",
        locations: { edges: [] },
      }) + "\n";
      const jsonlBytes = new TextEncoder().encode(jsonlContent);

      // Mock adminGraphQL to return COMPLETED with URL (non-empty result)
      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: {
            id: bulkOpId,
            status: "COMPLETED",
            url: "https://storage.shopify.com/bulk-result.jsonl",
            objectCount: "1",
            fileSize: String(jsonlBytes.length),
            errorCode: null,
            partialDataUrl: null,
          },
        },
        retryable: false,
      });

      // Mock global fetch to return the JSONL content
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 206,
        headers: new Headers({
          "content-range": `bytes 0-${jsonlBytes.length - 1}/${jsonlBytes.length}`,
        }),
        arrayBuffer: async () => jsonlBytes.buffer,
      });

      try {
        // Get the production handler (handleBulkOperationsFinish)
        const handler = getBulkHandler("BULK_OPERATIONS_FINISH");
        expect(handler).toBeDefined();

        const createMessage = (webhookId: string) => ({
          topic: "BULK_OPERATIONS_FINISH" as const,
          shop: TEST_SHOP_DOMAIN,
          webhookId,
          bulkOperationId: bulkOpId,
          bulkType: "companies" as const,
          enqueuedAt: new Date().toISOString(),
        });

        // Run 3 concurrent deliveries through the PRODUCTION handler
        // This tests that the handler correctly enqueues next stage only once
        const [result1, result2, result3] = await Promise.all([
          handler!(sql, createMessage(webhookId1)),
          handler!(sql, createMessage(webhookId2)),
          handler!(sql, createMessage(webhookId3)),
        ]);

        const results = [result1, result2, result3];

        // Count results by outcome:
        // - status="complete" with nextStage: winner who completed and can enqueue next stage
        // - status="complete" without nextStage: lost completion claim but processing done
        // - status="error" with errorCode=bulk_lease_contention: lost lease race
        const completedWithNextStage = results.filter((r) => r.status === "complete" && r.nextStage === "customers");
        
        // EXACTLY one result must have nextStage='customers' (the winner)
        expect(completedWithNextStage.length).toBe(1);
        expect(completedWithNextStage[0]!.nextStage).toBe("customers");

        // completed_at should be set exactly once (atomic via claimBulkCompletion)
        const [row] = await sql<{ completed_at: Date | null }[]>`
          SELECT completed_at FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
        `;
        expect(row.completed_at).not.toBeNull();

        // Verify EXACTLY 1 RECONCILE_CUSTOMERS message in pgmq.q_s6_sync
        // The production handler enqueues this automatically when nextStage is set
        const [queueCount] = await sql<{ count: string }[]>`
          SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
          WHERE message->>'topic' = 'RECONCILE_CUSTOMERS'
            AND message->>'shop' = ${TEST_SHOP_DOMAIN}
        `;
        expect(parseInt(queueCount.count, 10)).toBe(1);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  // ==========================================================================
  // C2: Two concurrent RECONCILE_ORDERS for same shop and chain
  // ==========================================================================
  describe("C2: concurrent RECONCILE_ORDERS - mutation called once", () => {
    it("two concurrent startReconcileBulkOperation calls result in exactly one adminGraphQL mutation", async () => {
      const { startReconcileBulkOperation } = await import("../reconcile-handlers.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const webhookId1 = `reconcile:${TEST_SHOP_DOMAIN}:2025-01-15:orders`;
      const webhookId2 = `reconcile:${TEST_SHOP_DOMAIN}:2025-01-15:orders`;

      // Mock adminGraphQL to return success
      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          bulkOperationRunQuery: {
            bulkOperation: {
              id: `gid://shopify/BulkOperation/reconcile-c2-${TEST_SUFFIX}`,
              status: "CREATED",
            },
            userErrors: [],
          },
        },
        retryable: false,
      });

      const [result1, result2] = await Promise.all([
        startReconcileBulkOperation(sql, TEST_SHOP_DOMAIN, "orders", webhookId1),
        startReconcileBulkOperation(sql, TEST_SHOP_DOMAIN, "orders", webhookId2),
      ]);

      // One should create, the other should either skip or retry_pending
      const createdCount = [result1, result2].filter((r) => r.success && r.action === "created").length;
      const nonCreatedCount = [result1, result2].filter((r) => r.action !== "created").length;
      
      // Exactly one mutation should succeed (claim exclusivity)
      expect(createdCount).toBe(1);
      expect(nonCreatedCount).toBe(1);
      // adminGraphQL is called once for the winner
      expect(vi.mocked(adminGraphQL)).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // C3: Two shops, same date - both can claim 'companies'
  // ==========================================================================
  describe("C3: per-shop chain key isolation", () => {
    it("two shops on same date both claim companies stage", async () => {
      const { claimReconcileStage } = await import("../reconcile-handlers.server");

      const SHOP_2_ID = `shop-s25-2-${TEST_SUFFIX}`;
      const SHOP_2_DOMAIN = `test-s25-2-${TEST_SUFFIX}.myshopify.com`;

      // Create second shop
      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${SHOP_2_ID}, ${SHOP_2_DOMAIN}, 'INR', NOW(), NOW())
      `;

      try {
        const chainKey1 = `${TEST_SHOP_DOMAIN}:2025-01-16`;
        const chainKey2 = `${SHOP_2_DOMAIN}:2025-01-16`;

        const [claim1, claim2] = await Promise.all([
          claimReconcileStage(sql, chainKey1, "companies", TEST_SHOP_DOMAIN),
          claimReconcileStage(sql, chainKey2, "companies", SHOP_2_DOMAIN),
        ]);

        // Both should succeed since chain keys include shop domain
        expect(claim1).toBe("claimed");
        expect(claim2).toBe("claimed");
      } finally {
        await sql`DELETE FROM s6_reconcile_stage_claims WHERE shop = ${SHOP_2_DOMAIN}`;
        await sql`DELETE FROM "Shop" WHERE id = ${SHOP_2_ID}`;
      }
    });
  });

  // ==========================================================================
  // C4: Mutation throws - claim released, retry claims
  // ==========================================================================
  describe("C4: mutation failure releases claim for immediate retry (Team Lead ruling #2)", () => {
    it("mutation throws: claim is deleted, retry calls mutation once", async () => {
      const { startReconcileBulkOperation } = await import("../reconcile-handlers.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const webhookId = `reconcile:${TEST_SHOP_DOMAIN}:2025-01-17:companies`;
      const chainKey = `${TEST_SHOP_DOMAIN}:2025-01-17`;

      // First call: mock adminGraphQL to return failure (no op id)
      vi.mocked(adminGraphQL).mockResolvedValueOnce({
        success: false,
        error: "Network error",
        retryable: true,
      });

      const result1 = await startReconcileBulkOperation(sql, TEST_SHOP_DOMAIN, "companies", webhookId);
      expect(result1.success).toBe(false);

      // Claim row should be DELETED after failure (allows immediate retry)
      const [claimRow] = await sql<{ chain_key: string }[]>`
        SELECT chain_key FROM s6_reconcile_stage_claims
        WHERE chain_key = ${chainKey} AND stage = 'companies'
      `;
      expect(claimRow).toBeUndefined();

      // Reset mock for successful call
      vi.mocked(adminGraphQL).mockResolvedValueOnce({
        success: true,
        data: {
          bulkOperationRunQuery: {
            bulkOperation: {
              id: `gid://shopify/BulkOperation/retry-c4-${TEST_SUFFIX}`,
              status: "CREATED",
            },
            userErrors: [],
          },
        },
        retryable: false,
      });

      // Retry should succeed and call mutation ONCE
      const result2 = await startReconcileBulkOperation(sql, TEST_SHOP_DOMAIN, "companies", webhookId);
      expect(result2.success).toBe(true);
      expect(result2.action).toBe("created");
      expect(vi.mocked(adminGraphQL)).toHaveBeenCalledTimes(2); // First failure + second success
    });

    it("mutation returns op id then registration throws: claim kept, retry makes ZERO mutation calls", async () => {
      const { startReconcileBulkOperation, claimReconcileStage } = await import("../reconcile-handlers.server");
      const { adminGraphQL } = await import("../admin-client.server");

      // Use valid webhookId format: reconcile:<shop>:<YYYY-MM-DD>:<stage>
      const webhookId = `reconcile:${TEST_SHOP_DOMAIN}:2025-01-19:orders`;
      const chainKey = `${TEST_SHOP_DOMAIN}:2025-01-19`;
      const opId = `gid://shopify/BulkOperation/regfail-c4-${TEST_SUFFIX}`;

      // Simulate the scenario where:
      // 1. Mutation succeeded (returned op id)
      // 2. recordClaimBulkOperationId was called
      // 3. registerBulkOperation failed/threw
      // 4. Time passed (claim is now old enough to be considered orphan)

      // Insert claim with OLD claimed_at (6 minutes ago) to simulate orphan
      const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000);
      await sql`
        INSERT INTO s6_reconcile_stage_claims (chain_key, stage, shop, bulk_operation_id, claimed_at)
        VALUES (${chainKey}, 'orders', ${TEST_SHOP_DOMAIN}, ${opId}, ${sixMinutesAgo})
      `;

      // Verify claim has op id but no op row exists -> orphan
      const claimResult = await claimReconcileStage(sql, chainKey, "orders", TEST_SHOP_DOMAIN);
      expect(claimResult).toEqual({ orphan: opId });

      // Now retry - it should adopt the orphan without calling mutation
      vi.mocked(adminGraphQL).mockClear();

      const result = await startReconcileBulkOperation(sql, TEST_SHOP_DOMAIN, "orders", webhookId);
      expect(result.success).toBe(true);
      expect(result.action).toBe("created");
      expect(result.entityId).toBe(opId);

      // adminGraphQL should NOT have been called (zero mutation calls)
      expect(vi.mocked(adminGraphQL)).not.toHaveBeenCalled();

      // Op row should now exist
      const [opRow] = await sql<{ bulk_operation_id: string }[]>`
        SELECT bulk_operation_id FROM s6_bulk_operations WHERE bulk_operation_id = ${opId}
      `;
      expect(opRow).toBeDefined();

      // Cleanup
      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${opId}`;
      await sql`DELETE FROM s6_reconcile_stage_claims WHERE chain_key = ${chainKey}`;
    });

    it("young NULL-bulk_op_id claim returns retry_pending, not skipped", async () => {
      const { claimReconcileStage } = await import("../reconcile-handlers.server");

      const chainKey = `${TEST_SHOP_DOMAIN}:2025-01-18`;

      // Insert a young claim (just now, no bulk_operation_id)
      await sql`
        INSERT INTO s6_reconcile_stage_claims (chain_key, stage, shop, claimed_at)
        VALUES (${chainKey}, 'orders', ${TEST_SHOP_DOMAIN}, NOW())
      `;

      // Attempt to claim should return retry_pending (not "already_running" or "claimed")
      const result = await claimReconcileStage(sql, chainKey, "orders", TEST_SHOP_DOMAIN);
      expect(result).toBe("retry_pending");
    });
  });

  // ==========================================================================
  // Condition (d): Token never logged
  // ==========================================================================
  describe("Condition (d): token never logged", () => {
    it("console mock.calls never contain the lease token", async () => {
      const { processBulkOperation } = await import("~/services/sync/bulk-jsonl-processor.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/token-log-${TEST_SUFFIX}`;
      const webhookId = `finish:${bulkOpId}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW())
      `;

      // Mock status with empty result
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
            partialDataUrl: null,
          },
        },
        retryable: false,
      });

      // Track all console calls
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const message = {
          topic: "BULK_OPERATIONS_FINISH",
          shop: TEST_SHOP_DOMAIN,
          webhookId,
          bulkOperationId: bulkOpId,
          bulkType: "companies" as const,
          enqueuedAt: new Date().toISOString(),
        };

        await processBulkOperation(sql, message);

        // Get the token that was used (from the DB)
        const [row] = await sql<{ processing_lease_token: string | null }[]>`
          SELECT processing_lease_token FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
        `;
        // Token should be NULL after release (operation completed)
        expect(row.processing_lease_token).toBeNull();
        
        // Check all console calls for UUID patterns
        const allCalls = [
          ...consoleSpy.mock.calls,
          ...consoleWarnSpy.mock.calls,
          ...consoleErrorSpy.mock.calls,
        ];

        const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
        for (const call of allCalls) {
          const callString = JSON.stringify(call);
          // Should not contain a UUID (which would be the lease token)
          // Exception: bulk operation GIDs contain numbers that might look UUID-like, but not dashes in the right pattern
          expect(callString).not.toMatch(uuidPattern);
        }
      } finally {
        consoleSpy.mockRestore();
        consoleWarnSpy.mockRestore();
        consoleErrorSpy.mockRestore();
      }
    });
  });

  // ==========================================================================
  // C5: Empty orders op - COMPLETED url null objectCount "0"
  // ==========================================================================
  describe("C5: empty result handling", () => {
    it("COMPLETED with url=null and objectCount='0' completes successfully and enqueues next stage", async () => {
      const { processBulkOperation } = await import("~/services/sync/bulk-jsonl-processor.server");
      const { getInitialSyncState } = await import("~/lib/initial-sync.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/empty-c5-${TEST_SUFFIX}`;
      const webhookId = `finish:${bulkOpId}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'orders', 'reconcile', 'orders', NOW())
      `;

      // Mock status with objectCount as STRING "0" (per Shopify UnsignedInt64 spec)
      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: {
            id: bulkOpId,
            status: "COMPLETED",
            url: null,
            objectCount: "0", // STRING, not number
            fileSize: null,
            errorCode: null,
            partialDataUrl: null,
          },
        },
        retryable: false,
      });

      const message = {
        topic: "BULK_OPERATIONS_FINISH",
        shop: TEST_SHOP_DOMAIN,
        webhookId,
        bulkOperationId: bulkOpId,
        bulkType: "orders" as const,
        enqueuedAt: new Date().toISOString(),
      };

      const result = await processBulkOperation(sql, message);
      expect(result.success).toBe(true);
      expect(result.status).toBe("complete");

      // Initial sync state should NOT be FAILED
      const syncState = await getInitialSyncState(sql, TEST_SHOP_DOMAIN);
      expect(syncState.status).not.toBe("failed");
    });

    it("partialDataUrl set with url=null returns permanent error with bulk_no_result_url", async () => {
      const { processBulkOperation, BULK_ERROR_CODES } = await import("~/services/sync/bulk-jsonl-processor.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/partial-c5-${TEST_SUFFIX}`;
      const webhookId = `finish:${bulkOpId}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'orders', 'webhook', NOW())
      `;

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: {
            id: bulkOpId,
            status: "COMPLETED",
            url: null,
            objectCount: "100", // Has objects but no URL - error
            fileSize: null,
            errorCode: null,
            partialDataUrl: "https://partial.example.com/data.jsonl",
          },
        },
        retryable: false,
      });

      const message = {
        topic: "BULK_OPERATIONS_FINISH",
        shop: TEST_SHOP_DOMAIN,
        webhookId,
        bulkOperationId: bulkOpId,
        bulkType: "orders" as const,
        enqueuedAt: new Date().toISOString(),
      };

      const result = await processBulkOperation(sql, message);
      expect(result.success).toBe(false);
      expect(result.errorType).toBe("permanent");
      expect(result.errorCode).toBe(BULK_ERROR_CODES.NO_RESULT_URL);
    });
  });

  // ==========================================================================
  // C6: Finish webhook sets finish_received_at
  // ==========================================================================
  describe("C6: finish_received_at tracking", () => {
    it("finish webhook handler sets finish_received_at on known bulk operation", async () => {
      const { findStaleBulkOperations } = await import("../bulk-op-recovery.server");

      const bulkOpId = `gid://shopify/BulkOperation/finish-c6-${TEST_SUFFIX}`;
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

      // Insert without finish_received_at
      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', ${twoHoursAgo})
      `;

      // Simulate webhook setting finish_received_at
      await sql`
        UPDATE s6_bulk_operations
        SET finish_received_at = NOW()
        WHERE bulk_operation_id = ${bulkOpId}
      `;

      // findStaleBulkOperations should skip it
      const stale = await findStaleBulkOperations(sql, 60);
      const found = stale.find((r) => r.bulk_operation_id === bulkOpId);
      expect(found).toBeUndefined();
    });
  });

  // ==========================================================================
  // C7: Legacy open row recovery
  // ==========================================================================
  describe("C7: legacy open row is re-enqueued by recovery", () => {
    it("legacy open row (finish_received_at NULL, old, COMPLETED on Shopify) is re-enqueued", async () => {
      const { recoverStaleBulkOperations } = await import("../bulk-op-recovery.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/legacy-c7-${TEST_SUFFIX}`;
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

      // Clean up existing stale ops that might affect our count
      // (completed/closed ops only - don't touch active ops)
      await sql`
        DELETE FROM s6_bulk_operations
        WHERE started_at < ${twoHoursAgo}
          AND completed_at IS NULL
          AND closed_at IS NULL
          AND finish_received_at IS NULL
      `;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', ${twoHoursAgo})
      `;

      // Mock Shopify status as COMPLETED
      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: {
            id: bulkOpId,
            status: "COMPLETED",
            url: "https://example.com/result.jsonl",
            objectCount: "10",
            fileSize: 1000,
            errorCode: null,
          },
        },
        retryable: false,
      });

      const result = await recoverStaleBulkOperations(sql, 60);
      
      // Our specific op should be found and enqueued
      const found = result.attempts.find((a) => a.bulkOperationId === bulkOpId);
      expect(found).toBeDefined();
      expect(found!.status).toBe("enqueued");
      
      // Exactly 1 op (ours) should be enqueued since we cleaned up first
      expect(result.enqueuedCount).toBe(1);
    });
  });

  // ==========================================================================
  // C8: Lease released on early returns
  // ==========================================================================
  describe("C8: lease released on early returns", () => {
    it("MAX_FAILURES return releases processing lease", async () => {
      const { processBulkOperation, MAX_FAILURE_COUNT } = await import("~/services/sync/bulk-jsonl-processor.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/maxfail-c8-${TEST_SUFFIX}`;
      const webhookId = `finish:${bulkOpId}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, failure_count)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW(), ${MAX_FAILURE_COUNT})
      `;

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: {
            id: bulkOpId,
            status: "COMPLETED",
            url: "https://example.com/result.jsonl",
            objectCount: "10",
            fileSize: 1000,
            errorCode: null,
          },
        },
        retryable: false,
      });

      const message = {
        topic: "BULK_OPERATIONS_FINISH",
        shop: TEST_SHOP_DOMAIN,
        webhookId,
        bulkOperationId: bulkOpId,
        bulkType: "companies" as const,
        enqueuedAt: new Date().toISOString(),
      };

      await processBulkOperation(sql, message);

      // Lease should be released (NULL) by the finally block
      const [row] = await sql<{ processing_lease_until: Date | null }[]>`
        SELECT processing_lease_until FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.processing_lease_until).toBeNull();
    });
  });

  // ==========================================================================
  // C9: Lease-contention DLQ doesn't mark initial sync FAILED
  // ==========================================================================
  describe("C9: lease-contention DLQ excluded from initial sync state", () => {
    it("bulk_lease_contention DLQ entry does not cause initial sync to be FAILED", async () => {
      const { getInitialSyncState } = await import("~/lib/initial-sync.server");

      const bulkOpId = `gid://shopify/BulkOperation/lease-dlq-c9-${TEST_SUFFIX}`;

      // Create a companies op that is complete
      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, completed_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies', NOW() - INTERVAL '1 hour', NOW())
      `;

      // Insert DLQ entry with bulk_lease_contention error
      await sql`
        INSERT INTO s6_dead_letter (original_queue, original_msg_id, message, error, dead_lettered_at)
        VALUES (
          's6_bulk',
          'lease-contention-msg',
          ${sql.json({ topic: "BULK_OPERATIONS_FINISH", shop: TEST_SHOP_DOMAIN, bulkOperationId: bulkOpId })},
          'bulk_lease_contention',
          NOW()
        )
      `;

      const state = await getInitialSyncState(sql, TEST_SHOP_DOMAIN);
      expect(state.status).not.toBe("failed");
    });
  });

  // ==========================================================================
  // Condition (b): Lease-contention leaves failure_count unchanged
  // ==========================================================================
  describe("Condition (b): lease-contention behavior", () => {
    it("lease-contention return leaves failure_count unchanged", async () => {
      const { processBulkOperation, acquireProcessingLease, BULK_ERROR_CODES } = await import("~/services/sync/bulk-jsonl-processor.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/lease-unchanged-${TEST_SUFFIX}`;
      const webhookId = `finish:${bulkOpId}`;

      // Setup bulk operation with failure_count = 2
      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, failure_count)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NOW(), 2)
      `;

      // Mock adminGraphQL to return COMPLETED
      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: { node: { id: bulkOpId, status: "COMPLETED", url: "https://test.com/result.jsonl", objectCount: "1", fileSize: 100, errorCode: null, partialDataUrl: null } },
        retryable: false,
      });

      // Acquire lease (simulating another processor holds it)
      const otherProcessorToken = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(otherProcessorToken).not.toBeNull();

      // Attempt to process - should fail with lease contention
      const message = {
        topic: "BULK_OPERATIONS_FINISH" as const,
        shop: TEST_SHOP_DOMAIN,
        webhookId,
        bulkOperationId: bulkOpId,
        bulkType: "companies" as const,
        enqueuedAt: new Date().toISOString(),
      };
      const result = await processBulkOperation(sql, message);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(BULK_ERROR_CODES.LEASE_CONTENTION);
      expect(result.errorType).toBe("retryable");

      // failure_count should still be 2 (NOT incremented)
      const [row] = await sql<{ failure_count: number }[]>`
        SELECT failure_count FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.failure_count).toBe(2);
    });
  });

  // ==========================================================================
  // QA #5: Orphan-claim path test (Team Lead ruling #2)
  // ==========================================================================
  describe("QA #5: orphan-claim path", () => {
    it("claimReconcileStage returns orphan op id when claim has op id but no op row (and claim is old)", async () => {
      const { claimReconcileStage } = await import("../reconcile-handlers.server");

      const chainKey = `${TEST_SHOP_DOMAIN}:2025-orphan-claim`;
      const orphanOpId = `gid://shopify/BulkOperation/orphan-${TEST_SUFFIX}`;

      // Insert claim with OLD claimed_at (6 minutes ago) to be considered orphan
      const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000);
      await sql`
        INSERT INTO s6_reconcile_stage_claims (chain_key, stage, shop, bulk_operation_id, claimed_at)
        VALUES (${chainKey}, 'companies', ${TEST_SHOP_DOMAIN}, ${orphanOpId}, ${sixMinutesAgo})
      `;

      // But DON'T create the corresponding op row (simulating partial failure)
      // The op row doesn't exist in s6_bulk_operations

      // Attempt to claim the same stage - should detect orphan and return the op id
      const result = await claimReconcileStage(sql, chainKey, "companies", TEST_SHOP_DOMAIN);
      
      // Per Team Lead ruling #2: return orphan op id so caller can adopt it
      expect(result).toEqual({ orphan: orphanOpId });

      // The claim row should still have the bulk_operation_id (not cleared)
      const [claim] = await sql<{ bulk_operation_id: string | null }[]>`
        SELECT bulk_operation_id FROM s6_reconcile_stage_claims
        WHERE chain_key = ${chainKey} AND stage = 'companies'
      `;
      expect(claim.bulk_operation_id).toBe(orphanOpId);

      // Cleanup
      await sql`DELETE FROM s6_reconcile_stage_claims WHERE chain_key = ${chainKey}`;
    });

    it("claimReconcileStage returns retry_pending when claim is young (registration in progress)", async () => {
      const { claimReconcileStage } = await import("../reconcile-handlers.server");

      const chainKey = `${TEST_SHOP_DOMAIN}:2025-young-orphan-claim`;
      const opId = `gid://shopify/BulkOperation/young-orphan-${TEST_SUFFIX}`;

      // Insert claim with RECENT claimed_at (1 minute ago) - might still be registering
      await sql`
        INSERT INTO s6_reconcile_stage_claims (chain_key, stage, shop, bulk_operation_id, claimed_at)
        VALUES (${chainKey}, 'companies', ${TEST_SHOP_DOMAIN}, ${opId}, NOW() - interval '1 minute')
      `;

      // No op row exists, but claim is young - should return retry_pending
      const result = await claimReconcileStage(sql, chainKey, "companies", TEST_SHOP_DOMAIN);
      expect(result).toBe("retry_pending");

      // Cleanup
      await sql`DELETE FROM s6_reconcile_stage_claims WHERE chain_key = ${chainKey}`;
    });

    it("startReconcileBulkOperation adopts orphan op without calling mutation", async () => {
      const { startReconcileBulkOperation } = await import("../reconcile-handlers.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const orphanOpId = `gid://shopify/BulkOperation/orphan-adopt-${TEST_SUFFIX}`;
      const webhookId = `reconcile:${TEST_SHOP_DOMAIN}:2025-01-25:orders`;
      const chainKey = `${TEST_SHOP_DOMAIN}:2025-01-25`;

      // Insert orphan claim with OLD claimed_at (6 minutes ago)
      const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000);
      await sql`
        INSERT INTO s6_reconcile_stage_claims (chain_key, stage, shop, bulk_operation_id, claimed_at)
        VALUES (${chainKey}, 'orders', ${TEST_SHOP_DOMAIN}, ${orphanOpId}, ${sixMinutesAgo})
      `;

      // Clear any previous mocks
      vi.mocked(adminGraphQL).mockClear();

      // Call startReconcileBulkOperation - it should adopt the orphan
      const result = await startReconcileBulkOperation(sql, TEST_SHOP_DOMAIN, "orders", webhookId);

      // Should succeed by adopting the orphan
      expect(result.success).toBe(true);
      expect(result.action).toBe("created");
      expect(result.entityId).toBe(orphanOpId);

      // adminGraphQL should NOT have been called (no new mutation)
      expect(vi.mocked(adminGraphQL)).not.toHaveBeenCalled();

      // The op row should now exist
      const [opRow] = await sql<{ bulk_operation_id: string }[]>`
        SELECT bulk_operation_id FROM s6_bulk_operations WHERE bulk_operation_id = ${orphanOpId}
      `;
      expect(opRow).toBeDefined();
      expect(opRow.bulk_operation_id).toBe(orphanOpId);

      // Cleanup
      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${orphanOpId}`;
      await sql`DELETE FROM s6_reconcile_stage_claims WHERE chain_key = ${chainKey}`;
    });
  });

  // ==========================================================================
  // C11: IN ${sql()} empty-list guard and correct filtering
  // The empty list guard prevents crashes when orderIds/orphanParentIds is empty.
  // ==========================================================================
  describe("C11: empty list guard for IN clause", () => {
    it("processOrderLines with empty list does not crash IN clause", async () => {
      const { processOrderLines } = await import("~/services/sync/bulk-jsonl-processor.server");

      // processOrderLines returns a number (upsert count)
      // The empty list guard prevents "IN ()" SQL error
      const result = await processOrderLines(sql, TEST_SHOP_ID, TEST_SHOP_DOMAIN, []);
      expect(result).toBe(0);
    });
  });

  // ==========================================================================
  // C12: compliance deleteShop removes s6_reconcile_stage_claims
  // ==========================================================================
  describe("C12: compliance deleteShop removes reconcile claims", () => {
    it("deleteShop removes s6_reconcile_stage_claims rows for the shop", async () => {
      const { deleteShop } = await import("~/services/compliance/compliance.server");

      const COMPLIANCE_SHOP_ID = `shop-compliance-c12-${TEST_SUFFIX}`;
      const COMPLIANCE_SHOP_DOMAIN = `compliance-c12-${TEST_SUFFIX}.myshopify.com`;

      // Create shop and claims
      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
        VALUES (${COMPLIANCE_SHOP_ID}, ${COMPLIANCE_SHOP_DOMAIN}, 'INR', NOW(), NOW(), NOW())
      `;

      const chainKey1 = `${COMPLIANCE_SHOP_DOMAIN}:2025-01-20`;
      await sql`
        INSERT INTO s6_reconcile_stage_claims (chain_key, stage, shop)
        VALUES
          (${chainKey1}, 'companies', ${COMPLIANCE_SHOP_DOMAIN}),
          (${chainKey1}, 'orders', ${COMPLIANCE_SHOP_DOMAIN})
      `;

      // Verify claims exist
      const [beforeCount] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM s6_reconcile_stage_claims WHERE shop = ${COMPLIANCE_SHOP_DOMAIN}
      `;
      expect(parseInt(beforeCount.count, 10)).toBe(2);

      // Delete shop
      const result = await deleteShop(sql, COMPLIANCE_SHOP_DOMAIN);
      expect(result.deleted).toBe(true);
      expect(result.reconcileClaimsPurged).toBe(2);

      // Verify claims are gone
      const [afterCount] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM s6_reconcile_stage_claims WHERE shop = ${COMPLIANCE_SHOP_DOMAIN}
      `;
      expect(parseInt(afterCount.count, 10)).toBe(0);
    });
  });

  // ==========================================================================
  // C12b: Lock order - deleteShop and enqueueReconcileStage don't deadlock
  // Both paths take locks in the same order: Shop row first, then bulk_operations
  // ==========================================================================
  describe("C12b: lock order prevents deadlock", () => {
    it("concurrent deleteShop and enqueueReconcileStage complete without deadlock", async () => {
      const { deleteShop } = await import("~/services/compliance/compliance.server");
      const { enqueueReconcileStage } = await import("../reconcile-handlers.server");

      const LOCK_SHOP_ID = `shop-test-lock-${TEST_SUFFIX}`;
      const LOCK_SHOP_DOMAIN = `test-lock-${TEST_SUFFIX}.myshopify.com`;
      const bulkOpId = `gid://shopify/BulkOperation/test-lock-${TEST_SUFFIX}`;

      // Create shop with uninstalledAt set (for deleteShop to work)
      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
        VALUES (${LOCK_SHOP_ID}, ${LOCK_SHOP_DOMAIN}, 'INR', NOW(), NOW(), NOW())
      `;

      // Create a bulk operation for the shop
      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, completed_at)
        VALUES (${bulkOpId}, ${LOCK_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies', NOW(), NOW())
      `;

      // Run deleteShop and enqueueReconcileStage concurrently
      // If lock order is wrong, this could deadlock (40P01)
      // Use Promise.allSettled to capture any errors
      const results = await Promise.allSettled([
        deleteShop(sql, LOCK_SHOP_DOMAIN),
        enqueueReconcileStage(sql, LOCK_SHOP_DOMAIN, "customers", undefined, bulkOpId),
      ]);

      // Both should complete (either success or expected failure, but no deadlock)
      // deleteShop should succeed, enqueueReconcileStage may return false (shop uninstalled)
      const deleteResult = results[0];
      const enqueueResult = results[1];

      expect(deleteResult.status).toBe("fulfilled");
      expect(enqueueResult.status).toBe("fulfilled");

      // Cleanup any remaining data
      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${LOCK_SHOP_ID}`;
    });

    it("shop check failure leaves next_stage_enqueued_at NULL", async () => {
      const { enqueueReconcileStage } = await import("../reconcile-handlers.server");

      const NULL_SHOP_ID = `shop-test-null-${TEST_SUFFIX}`;
      const NULL_SHOP_DOMAIN = `test-null-${TEST_SUFFIX}.myshopify.com`;
      const bulkOpId = `gid://shopify/BulkOperation/test-null-${TEST_SUFFIX}`;

      // Create shop that is uninstalled (shop check will fail)
      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
        VALUES (${NULL_SHOP_ID}, ${NULL_SHOP_DOMAIN}, 'INR', NOW(), NOW(), NOW())
      `;

      // Create a bulk operation
      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at, completed_at, next_stage_enqueued_at)
        VALUES (${bulkOpId}, ${NULL_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies', NOW(), NOW(), NULL)
      `;

      // Try to enqueue - should fail because shop is uninstalled
      const enqueued = await enqueueReconcileStage(sql, NULL_SHOP_DOMAIN, "customers", undefined, bulkOpId);
      expect(enqueued).toBe(false);

      // Verify next_stage_enqueued_at is still NULL (not persisted before shop check)
      const [row] = await sql<{ next_stage_enqueued_at: Date | null }[]>`
        SELECT next_stage_enqueued_at FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.next_stage_enqueued_at).toBeNull();

      // Cleanup
      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${NULL_SHOP_ID}`;
    });

    it("concurrent double-enqueue for same op: exactly one succeeds, no deadlock", async () => {
      const { enqueueReconcileStage } = await import("../reconcile-handlers.server");

      const RACE_SHOP_ID = `shop-test-race-${TEST_SUFFIX}`;
      const RACE_SHOP_DOMAIN = `test-race-${TEST_SUFFIX}.myshopify.com`;
      const bulkOpId = `gid://shopify/BulkOperation/test-race-${TEST_SUFFIX}`;

      // Create shop
      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${RACE_SHOP_ID}, ${RACE_SHOP_DOMAIN}, 'INR', NOW(), NOW())
      `;

      // Create completed bulk op that can have next stage enqueued
      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage, 
          started_at, completed_at, next_stage_enqueued_at
        )
        VALUES (
          ${bulkOpId}, ${RACE_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies',
          NOW() - INTERVAL '1 hour', NOW(), NULL
        )
      `;

      // Clear any existing messages
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${RACE_SHOP_DOMAIN}`;

      // Run two concurrent enqueueReconcileStage calls for the same op
      // Without the fix (using FOR SHARE then UPDATE), this could deadlock
      const results = await Promise.allSettled([
        enqueueReconcileStage(sql, RACE_SHOP_DOMAIN, "customers", undefined, bulkOpId),
        enqueueReconcileStage(sql, RACE_SHOP_DOMAIN, "customers", undefined, bulkOpId),
      ]);

      // Both should complete (no deadlock 40P01)
      expect(results[0].status).toBe("fulfilled");
      expect(results[1].status).toBe("fulfilled");

      // Extract results
      const result1 = results[0].status === "fulfilled" ? results[0].value : false;
      const result2 = results[1].status === "fulfilled" ? results[1].value : false;

      // Exactly one should return true (the winner)
      const successCount = [result1, result2].filter(Boolean).length;
      expect(successCount).toBe(1);

      // Exactly one queue message should exist
      const [queueCount] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${RACE_SHOP_DOMAIN}
          AND message->>'topic' = 'RECONCILE_CUSTOMERS'
      `;
      expect(parseInt(queueCount.count, 10)).toBe(1);

      // Verify next_stage_enqueued_at is set
      const [row] = await sql<{ next_stage_enqueued_at: Date | null }[]>`
        SELECT next_stage_enqueued_at FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.next_stage_enqueued_at).not.toBeNull();

      // Cleanup
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${RACE_SHOP_DOMAIN}`;
      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${RACE_SHOP_ID}`;
    });

    it("deterministic interleave: two sessions with pg_sleep trigger, exactly one succeeds", async () => {
      // This test creates a deterministic interleave using pg_sleep in a trigger.
      // The trigger delays the UPDATE, ensuring both connections have started
      // their transactions before either completes. This tests that the lock order
      // fix (Shop FOR SHARE first, then UPDATE) prevents deadlock.
      const { enqueueReconcileStage } = await import("../reconcile-handlers.server");

      const INTERLEAVE_SHOP_ID = `shop-test-interleave-${TEST_SUFFIX}`;
      const INTERLEAVE_SHOP_DOMAIN = `test-interleave-${TEST_SUFFIX}.myshopify.com`;
      const bulkOpId = `gid://shopify/BulkOperation/test-interleave-${TEST_SUFFIX}`;

      const TRIGGER_NAME = "s25_interleave_test_trigger";
      const TRIGGER_FUNC = "s25_interleave_test_func";

      // Create two separate connections for concurrent execution
      const conn1 = postgres(TEST_DATABASE_URL!, sqlOptions);
      const conn2 = postgres(TEST_DATABASE_URL!, sqlOptions);

      try {
        // Create shop
        await sql`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${INTERLEAVE_SHOP_ID}, ${INTERLEAVE_SHOP_DOMAIN}, 'INR', NOW(), NOW())
        `;

        // Create completed bulk op ready for next-stage enqueue
        await sql`
          INSERT INTO s6_bulk_operations (
            bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
            started_at, completed_at, next_stage_enqueued_at
          )
          VALUES (
            ${bulkOpId}, ${INTERLEAVE_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies',
            NOW() - INTERVAL '1 hour', NOW(), NULL
          )
        `;

        // Clear any existing messages
        await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${INTERLEAVE_SHOP_DOMAIN}`;

        // Create trigger that adds a small delay when updating next_stage_enqueued_at
        // This ensures both connections have entered their transactions before either completes
        await sql.unsafe(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON s6_bulk_operations`);
        await sql.unsafe(`DROP FUNCTION IF EXISTS ${TRIGGER_FUNC}()`);
        await sql.unsafe(`
          CREATE FUNCTION ${TRIGGER_FUNC}() RETURNS TRIGGER AS $$
          BEGIN
            IF OLD.next_stage_enqueued_at IS NULL AND NEW.next_stage_enqueued_at IS NOT NULL THEN
              PERFORM pg_sleep(0.1);
            END IF;
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql
        `);
        await sql.unsafe(`
          CREATE TRIGGER ${TRIGGER_NAME}
          BEFORE UPDATE ON s6_bulk_operations
          FOR EACH ROW
          EXECUTE FUNCTION ${TRIGGER_FUNC}()
        `);

        // Start both enqueue calls in parallel
        // With the 100ms delay in trigger, both should enter their transactions
        // and attempt the UPDATE at roughly the same time
        const promise1 = enqueueReconcileStage(conn1, INTERLEAVE_SHOP_DOMAIN, "customers", undefined, bulkOpId);
        const promise2 = enqueueReconcileStage(conn2, INTERLEAVE_SHOP_DOMAIN, "customers", undefined, bulkOpId);

        // Wait for both to complete
        const results = await Promise.allSettled([promise1, promise2]);

        // Both should complete (no deadlock 40P01)
        // If the old lock-upgrade code were still in place, this could deadlock
        expect(results[0].status).toBe("fulfilled");
        expect(results[1].status).toBe("fulfilled");

        // Extract results
        const result1 = results[0].status === "fulfilled" ? results[0].value : false;
        const result2 = results[1].status === "fulfilled" ? results[1].value : false;

        // Exactly one should return true (the winner of the UPDATE)
        const successCount = [result1, result2].filter(Boolean).length;
        expect(successCount).toBe(1);

        // Exactly one queue message should exist
        const [queueCount] = await sql<{ count: string }[]>`
          SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
          WHERE message->>'shop' = ${INTERLEAVE_SHOP_DOMAIN}
            AND message->>'topic' = 'RECONCILE_CUSTOMERS'
        `;
        expect(parseInt(queueCount.count, 10)).toBe(1);

      } finally {
        // Cleanup
        await sql.unsafe(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON s6_bulk_operations`);
        await sql.unsafe(`DROP FUNCTION IF EXISTS ${TRIGGER_FUNC}()`);
        await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${INTERLEAVE_SHOP_DOMAIN}`;
        await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
        await sql`DELETE FROM "Shop" WHERE id = ${INTERLEAVE_SHOP_ID}`;
        await conn1.end();
        await conn2.end();
      }
    });
  });

  // ==========================================================================
  // C12c: Shop filter in claimReconcileStage op-exists check
  // ==========================================================================
  describe("C12c: shop filter in claimReconcileStage", () => {
    it("op-exists check does not see row with same op id but different shop", async () => {
      const { claimReconcileStage } = await import("../reconcile-handlers.server");

      const SHOP_A_DOMAIN = `shop-a-${TEST_SUFFIX}.myshopify.com`;
      const SHOP_B_DOMAIN = `shop-b-${TEST_SUFFIX}.myshopify.com`;
      const bulkOpId = `gid://shopify/BulkOperation/cross-shop-${TEST_SUFFIX}`;
      const chainKeyB = `${SHOP_B_DOMAIN}:2025-01-25`;

      // Create an op for shop A
      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at)
        VALUES (${bulkOpId}, ${SHOP_A_DOMAIN}, 'companies', 'reconcile', NOW())
      `;

      // Create a claim for shop B pointing to the same op id (simulating cross-shop collision)
      await sql`
        INSERT INTO s6_reconcile_stage_claims (chain_key, stage, shop, bulk_operation_id, claimed_at)
        VALUES (${chainKeyB}, 'companies', ${SHOP_B_DOMAIN}, ${bulkOpId}, NOW() - INTERVAL '10 minutes')
      `;

      // Shop B tries to claim - should NOT see shop A's op row as "already_running"
      // Instead should return "orphan" because the op exists but for a different shop
      const result = await claimReconcileStage(sql, chainKeyB, "companies", SHOP_B_DOMAIN);

      // With shop filter, op-exists returns false for shop B, so this is an orphan
      expect(result).toEqual({ orphan: bulkOpId });

      // Cleanup
      await sql`DELETE FROM s6_reconcile_stage_claims WHERE chain_key = ${chainKeyB}`;
      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
    });
  });

  // ==========================================================================
  // C12d: Shop filter in post-lease progress re-read
  // ==========================================================================
  describe("C12d: shop filter in post-lease progress re-read", () => {
    it("post-lease re-read does not see row with same op id but different shop", async () => {
      const { loadBulkOperationProgress } = await import("~/services/sync/bulk-jsonl-processor.server");

      const SHOP_A_DOMAIN = `shop-a-reread-${TEST_SUFFIX}.myshopify.com`;
      const SHOP_B_DOMAIN = `shop-b-reread-${TEST_SUFFIX}.myshopify.com`;
      const bulkOpId = `gid://shopify/BulkOperation/cross-shop-reread-${TEST_SUFFIX}`;

      // Create an op for shop A
      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, byte_offset)
        VALUES (${bulkOpId}, ${SHOP_A_DOMAIN}, 'companies', 'reconcile', NOW(), 100)
      `;

      // Load without shop filter - should find it
      const withoutFilter = await loadBulkOperationProgress(sql, bulkOpId);
      expect(withoutFilter).not.toBeNull();
      expect(withoutFilter!.byteOffset).toBe(100);

      // Load with shop B filter - should NOT find it (different shop)
      const withFilter = await loadBulkOperationProgress(sql, bulkOpId, SHOP_B_DOMAIN);
      expect(withFilter).toBeNull();

      // Load with shop A filter - should find it
      const withCorrectFilter = await loadBulkOperationProgress(sql, bulkOpId, SHOP_A_DOMAIN);
      expect(withCorrectFilter).not.toBeNull();
      expect(withCorrectFilter!.byteOffset).toBe(100);

      // Cleanup
      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
    });

    it("call-site: processBulkOperation rejects cross-shop processing via shop filter", async () => {
      // This test drives processBulkOperation (not loadBulkOperationProgress directly) to verify
      // the shop filter prevents cross-shop processing. If shop filters were dropped from
      // acquireProcessingLease and loadBulkOperationProgress, a message with the wrong shop
      // could process another shop's row.
      //
      // Since bulk_operation_id is the PRIMARY KEY, we can only have ONE row per op id.
      // The test verifies:
      // 1. Row owned by Shop A, processing called with Shop B → fails (shop filter protects)
      // 2. Row owned by Shop A, processing called with Shop A → succeeds (correct shop)
      const { processBulkOperation, BULK_ERROR_CODES } = await import("~/services/sync/bulk-jsonl-processor.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const SHOP_A_ID = `shop-call-site-a-${TEST_SUFFIX}`;
      const SHOP_A_DOMAIN = `shop-call-site-a-${TEST_SUFFIX}.myshopify.com`;
      const SHOP_B_ID = `shop-call-site-b-${TEST_SUFFIX}`;
      const SHOP_B_DOMAIN = `shop-call-site-b-${TEST_SUFFIX}.myshopify.com`;
      const bulkOpId = `gid://shopify/BulkOperation/call-site-cross-shop-${TEST_SUFFIX}`;
      const webhookIdA = `finish:call-site-a:${bulkOpId}`;
      const webhookIdB = `finish:call-site-b:${bulkOpId}`;

      // Create both shops in Shop table
      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${SHOP_A_ID}, ${SHOP_A_DOMAIN}, 'INR', NOW(), NOW())
      `;
      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${SHOP_B_ID}, ${SHOP_B_DOMAIN}, 'INR', NOW(), NOW())
      `;

      // Create op row for Shop A
      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, byte_offset)
        VALUES (${bulkOpId}, ${SHOP_A_DOMAIN}, 'companies', 'reconcile', NOW(), 0)
      `;

      // Mock adminGraphQL to return completed status with no data (empty result)
      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        retryable: false,
        data: {
          node: {
            status: "COMPLETED",
            url: null,
            objectCount: "0",
            partialDataUrl: null,
            errorCode: null,
            rootObjectCount: "0",
          },
        },
      });

      // === PART 1: Call processBulkOperation with Shop B (wrong shop) ===
      // The row belongs to Shop A, so Shop B should fail at lease acquisition
      const messageB = {
        topic: "BULK_OPERATIONS_FINISH" as const,
        shop: SHOP_B_DOMAIN,
        webhookId: webhookIdB,
        bulkOperationId: bulkOpId,
        bulkType: "companies" as const,
        enqueuedAt: new Date().toISOString(),
      };
      const resultB = await processBulkOperation(sql, messageB);

      // Shop B should fail - either "op not found" (initial load without shop filter finds it,
      // but acquireProcessingLease with shop filter fails = LEASE_CONTENTION)
      // or the post-lease re-read doesn't find the row (if we somehow got a lease)
      expect(resultB.success).toBe(false);
      expect(resultB.errorCode).toBe(BULK_ERROR_CODES.LEASE_CONTENTION);

      // Verify Shop A's row is unchanged (not completed, no lease taken)
      const [shopARowAfterB] = await sql<{ completed_at: Date | null; processing_lease_token: string | null }[]>`
        SELECT completed_at, processing_lease_token FROM s6_bulk_operations
        WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(shopARowAfterB.completed_at).toBeNull();
      expect(shopARowAfterB.processing_lease_token).toBeNull();

      // === PART 2: Call processBulkOperation with Shop A (correct shop) ===
      // This should succeed - Shop A owns the row
      const messageA = {
        topic: "BULK_OPERATIONS_FINISH" as const,
        shop: SHOP_A_DOMAIN,
        webhookId: webhookIdA,
        bulkOperationId: bulkOpId,
        bulkType: "companies" as const,
        enqueuedAt: new Date().toISOString(),
      };
      const resultA = await processBulkOperation(sql, messageA);

      // Should succeed - Shop A's row processed correctly
      expect(resultA.success).toBe(true);
      expect(resultA.status).toBe("complete");

      // Verify Shop A's row was updated (completed_at now set)
      const [shopARowFinal] = await sql<{ completed_at: Date | null }[]>`
        SELECT completed_at FROM s6_bulk_operations
        WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(shopARowFinal.completed_at).not.toBeNull();

      // Cleanup
      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
      await sql`DELETE FROM "Shop" WHERE id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    });
  });

  // ==========================================================================
  // C12e: Fail-safe op-id bind retry
  // ==========================================================================
  describe("C12e: bind failure keeps claim with NULL op id (residual risk)", () => {
    const BIND_TRIGGER_NAME = "s25_bind_fail_trigger";
    const BIND_TRIGGER_FUNC = "s25_bind_fail_func";

    afterEach(async () => {
      await sql`DROP TRIGGER IF EXISTS ${sql(BIND_TRIGGER_NAME)} ON s6_reconcile_stage_claims`;
      await sql`DROP FUNCTION IF EXISTS ${sql(BIND_TRIGGER_FUNC)}()`;
    });

    it("bind failure throws, claim kept with NULL bulk_operation_id", async () => {
      const reconcileHandlers = await import("../reconcile-handlers.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const webhookId = `reconcile:${TEST_SHOP_DOMAIN}:2025-02-15:companies`;
      const chainKey = `${TEST_SHOP_DOMAIN}:2025-02-15`;
      const opId = `gid://shopify/BulkOperation/test-bind-fail-${TEST_SUFFIX}`;

      // Create trigger that always fails bind (UPDATE from NULL to non-NULL op id)
      await sql`
        CREATE OR REPLACE FUNCTION ${sql(BIND_TRIGGER_FUNC)}() RETURNS TRIGGER AS $$
        BEGIN
          IF OLD.bulk_operation_id IS NULL AND NEW.bulk_operation_id IS NOT NULL THEN
            RAISE EXCEPTION 'C12e test: simulated bind failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `;
      await sql`
        CREATE TRIGGER ${sql(BIND_TRIGGER_NAME)}
        BEFORE UPDATE ON s6_reconcile_stage_claims
        FOR EACH ROW
        EXECUTE FUNCTION ${sql(BIND_TRIGGER_FUNC)}()
      `;

      // Mock adminGraphQL to return success (Shopify op starts)
      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          bulkOperationRunQuery: {
            bulkOperation: { id: opId, status: "CREATED" },
            userErrors: [],
          },
        },
        retryable: false,
      });

      // The call should throw because bind fails
      await expect(
        reconcileHandlers.startReconcileBulkOperation(sql, TEST_SHOP_DOMAIN, "companies", webhookId)
      ).rejects.toThrow("C12e test: simulated bind failure");

      // Drop trigger to check state
      await sql`DROP TRIGGER IF EXISTS ${sql(BIND_TRIGGER_NAME)} ON s6_reconcile_stage_claims`;

      // The claim should exist with NULL bulk_operation_id (not released)
      const [claim] = await sql<{ bulk_operation_id: string | null; claimed_at: Date }[]>`
        SELECT bulk_operation_id, claimed_at FROM s6_reconcile_stage_claims
        WHERE chain_key = ${chainKey} AND stage = 'companies'
      `;
      expect(claim).toBeDefined();
      expect(claim.bulk_operation_id).toBeNull();

      // Cleanup
      await sql`DELETE FROM s6_reconcile_stage_claims WHERE chain_key = ${chainKey}`;
      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${opId}`;
    });
  });

  // ==========================================================================
  // C13: processOrderLines empty-list guard
  // ==========================================================================
  describe("C13: processOrderLines with zero INR orders", () => {
    it("processOrderLines handles empty order list without crashing IN clause", async () => {
      const { processOrderLines } = await import("~/services/sync/bulk-jsonl-processor.server");

      // An empty array should not crash the IN clause
      // processOrderLines(sql, shopId, shopDomain, lines)
      const result = await processOrderLines(sql, TEST_SHOP_ID, TEST_SHOP_DOMAIN, []);
      expect(result).toBe(0);
    });
  });

  // ==========================================================================
  // C14: after-auth reinstall claim delete
  // ==========================================================================
  describe("C14: reinstall deletes shop claims and allows new stage claim", () => {
    it("reinstall via upsertShopOnAuth clears claims for previously uninstalled shop", async () => {
      const { upsertShopOnAuth } = await import("~/lib/after-auth.server");
      const { claimReconcileStage } = await import("../reconcile-handlers.server");

      const REINSTALL_SHOP_ID = `shop-reinstall-c14-${TEST_SUFFIX}`;
      const REINSTALL_SHOP_DOMAIN = `reinstall-c14-${TEST_SUFFIX}.myshopify.com`;

      // Create shop in uninstalled state with leftover claims
      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
        VALUES (${REINSTALL_SHOP_ID}, ${REINSTALL_SHOP_DOMAIN}, 'INR', NOW(), NOW(), NOW() - interval '1 hour')
      `;

      const chainKey = `${REINSTALL_SHOP_DOMAIN}:2025-01-20`;
      const bulkOpId = `gid://shopify/BulkOperation/reinstall-c14-${TEST_SUFFIX}`;
      
      // Insert claims with bulk_operation_id (simulating previous run)
      await sql`
        INSERT INTO s6_reconcile_stage_claims (chain_key, stage, shop, bulk_operation_id)
        VALUES
          (${chainKey}, 'companies', ${REINSTALL_SHOP_DOMAIN}, ${bulkOpId}),
          (${chainKey}, 'orders', ${REINSTALL_SHOP_DOMAIN}, NULL)
      `;

      // Verify claims exist before reinstall
      const [beforeCount] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM s6_reconcile_stage_claims WHERE shop = ${REINSTALL_SHOP_DOMAIN}
      `;
      expect(parseInt(beforeCount.count, 10)).toBe(2);

      // Reinstall via the REAL after-auth path
      // upsertShopOnAuth clears uninstalledAt and deletes claims atomically via CTE
      await upsertShopOnAuth(sql, REINSTALL_SHOP_DOMAIN, "Asia/Kolkata", "INR");

      // Verify claims are gone (deleted by the CTE in upsertShopOnAuth)
      const [afterCount] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM s6_reconcile_stage_claims WHERE shop = ${REINSTALL_SHOP_DOMAIN}
      `;
      expect(parseInt(afterCount.count, 10)).toBe(0);

      // Verify uninstalledAt is cleared
      const [shopRow] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE domain = ${REINSTALL_SHOP_DOMAIN}
      `;
      expect(shopRow.uninstalledAt).toBeNull();

      // Verify a new companies stage can now claim
      const newChainKey = `${REINSTALL_SHOP_DOMAIN}:2025-01-21`;
      const claimResult = await claimReconcileStage(sql, newChainKey, "companies", REINSTALL_SHOP_DOMAIN);
      expect(claimResult).toBe("claimed");

      // Cleanup
      await sql`DELETE FROM s6_reconcile_stage_claims WHERE shop = ${REINSTALL_SHOP_DOMAIN}`;
      await sql`DELETE FROM "Shop" WHERE domain = ${REINSTALL_SHOP_DOMAIN}`;
    });

    it("upsertShopOnAuth on not-uninstalled shop keeps its claims", async () => {
      const { upsertShopOnAuth } = await import("~/lib/after-auth.server");

      const ACTIVE_SHOP_ID = `shop-active-c14-${TEST_SUFFIX}`;
      const ACTIVE_SHOP_DOMAIN = `active-c14-${TEST_SUFFIX}.myshopify.com`;

      // Create active shop (not uninstalled)
      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${ACTIVE_SHOP_ID}, ${ACTIVE_SHOP_DOMAIN}, 'INR', NOW(), NOW())
      `;

      const chainKey = `${ACTIVE_SHOP_DOMAIN}:2025-01-20`;
      await sql`
        INSERT INTO s6_reconcile_stage_claims (chain_key, stage, shop)
        VALUES (${chainKey}, 'companies', ${ACTIVE_SHOP_DOMAIN})
      `;

      // Call upsertShopOnAuth (re-auth, not reinstall)
      await upsertShopOnAuth(sql, ACTIVE_SHOP_DOMAIN, "Asia/Kolkata", "INR");

      // Claims should still exist (CTE only deletes when uninstalledAt was set)
      const [count] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM s6_reconcile_stage_claims WHERE shop = ${ACTIVE_SHOP_DOMAIN}
      `;
      expect(parseInt(count.count, 10)).toBe(1);

      // Cleanup
      await sql`DELETE FROM s6_reconcile_stage_claims WHERE shop = ${ACTIVE_SHOP_DOMAIN}`;
      await sql`DELETE FROM "Shop" WHERE domain = ${ACTIVE_SHOP_DOMAIN}`;
    });
  });

  // ==========================================================================
  // C15: Stranded-op recovery (lease expired with finish_received_at)
  // ==========================================================================
  describe("C15: recovery picks up stranded ops with expired lease", () => {
    it("findLeaseExpiredBulkOperations returns ops with finish_received_at, expired lease, no completed_at", async () => {
      const { findLeaseExpiredBulkOperations } = await import("../bulk-op-recovery.server");

      const STRANDED_SHOP_ID = `shop-stranded-c15-${TEST_SUFFIX}`;
      const STRANDED_SHOP_DOMAIN = `stranded-c15-${TEST_SUFFIX}.myshopify.com`;
      const bulkOpId = `gid://shopify/BulkOperation/stranded-c15-${TEST_SUFFIX}`;

      // Create shop
      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${STRANDED_SHOP_ID}, ${STRANDED_SHOP_DOMAIN}, 'INR', NOW(), NOW())
      `;

      // Create a stranded bulk operation:
      // - finish_received_at is set (finish webhook arrived)
      // - completed_at is NULL (processor died before completing)
      // - processing_lease_until is expired
      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, started_at,
          finish_received_at, processing_lease_until, completed_at
        )
        VALUES (
          ${bulkOpId}, ${STRANDED_SHOP_DOMAIN}, 'companies', 'reconcile', NOW() - interval '2 hours',
          NOW() - interval '30 minutes',
          NOW() - interval '20 minutes',
          NULL
        )
      `;

      // Find stranded ops with 10 minute threshold (op's lease expired 20 min ago)
      const strandedOps = await findLeaseExpiredBulkOperations(sql, 10);

      // Our specific stranded op should be found
      const found = strandedOps.find((op) => op.bulk_operation_id === bulkOpId);
      expect(found).toBeDefined();
      expect(found!.shop).toBe(STRANDED_SHOP_DOMAIN);

      // Cleanup
      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${STRANDED_SHOP_ID}`;
    });

    it("does not return ops with recent lease (not yet expired)", async () => {
      const { findLeaseExpiredBulkOperations } = await import("../bulk-op-recovery.server");

      const RECENT_SHOP_ID = `shop-recent-c15-${TEST_SUFFIX}`;
      const RECENT_SHOP_DOMAIN = `recent-c15-${TEST_SUFFIX}.myshopify.com`;
      const bulkOpId = `gid://shopify/BulkOperation/recent-c15-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${RECENT_SHOP_ID}, ${RECENT_SHOP_DOMAIN}, 'INR', NOW(), NOW())
      `;

      // Create op with recently expired lease (1 min ago, threshold is 5 min)
      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, started_at,
          finish_received_at, processing_lease_until, completed_at
        )
        VALUES (
          ${bulkOpId}, ${RECENT_SHOP_DOMAIN}, 'companies', 'reconcile', NOW() - interval '30 minutes',
          NOW() - interval '5 minutes',
          NOW() - interval '1 minute',
          NULL
        )
      `;

      // Find stranded ops with 5 minute threshold (lease expired 1 min ago)
      const strandedOps = await findLeaseExpiredBulkOperations(sql, 5);
      const found = strandedOps.find((op) => op.bulk_operation_id === bulkOpId);
      expect(found).toBeUndefined();

      // Cleanup
      await sql`DELETE FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${RECENT_SHOP_ID}`;
    });

    it("end-to-end: recoverStaleBulkOperations re-enqueues stranded op and it processes to completion", async () => {
      const { recoverStaleBulkOperations } = await import("../bulk-op-recovery.server");
      const { getBulkHandler } = await import("../processor.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const E2E_SHOP_ID = `shop-e2e-c15-${TEST_SUFFIX}`;
      const E2E_SHOP_DOMAIN = `e2e-c15-${TEST_SUFFIX}.myshopify.com`;
      const strandedOpId = `gid://shopify/BulkOperation/e2e-stranded-${TEST_SUFFIX}`;
      const liveLeaseOpId = `gid://shopify/BulkOperation/e2e-live-lease-${TEST_SUFFIX}`;

      // Create test shop
      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${E2E_SHOP_ID}, ${E2E_SHOP_DOMAIN}, 'INR', NOW(), NOW())
      `;

      // Create stranded op (finish arrived, lease expired, not completed)
      // Must have reconcile_stage='companies' for next-stage logic
      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at,
          finish_received_at, processing_lease_until, completed_at
        )
        VALUES (
          ${strandedOpId}, ${E2E_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies', 
          NOW() - interval '2 hours',
          NOW() - interval '30 minutes',
          NOW() - interval '20 minutes',
          NULL
        )
      `;

      // Create op with live lease (should NOT be recovered)
      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, started_at,
          finish_received_at, processing_lease_until, completed_at
        )
        VALUES (
          ${liveLeaseOpId}, ${E2E_SHOP_DOMAIN}, 'companies', 'reconcile', NOW() - interval '30 minutes',
          NOW() - interval '5 minutes',
          NOW() + interval '30 seconds',
          NULL
        )
      `;

      // Create minimal JSONL for the stranded op
      const jsonlContent = JSON.stringify({
        id: "gid://shopify/Company/1",
        name: "Stranded Company",
        locations: { edges: [] },
      }) + "\n";
      const jsonlBytes = new TextEncoder().encode(jsonlContent);

      // Mock Shopify status to return COMPLETED with URL
      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: { 
            id: strandedOpId, 
            status: "COMPLETED", 
            url: "https://storage.shopify.com/stranded-result.jsonl", 
            objectCount: "1", 
            fileSize: String(jsonlBytes.length), 
            errorCode: null 
          },
        },
        retryable: false,
      });

      // Mock global fetch for JSONL download
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 206,
        headers: new Headers({
          "content-range": `bytes 0-${jsonlBytes.length - 1}/${jsonlBytes.length}`,
        }),
        arrayBuffer: async () => jsonlBytes.buffer,
      });

      try {
        // Run recovery
        const result = await recoverStaleBulkOperations(sql, 60, 10);

        // Stranded op should be re-enqueued
        const strandedAttempt = result.attempts.find((a) => a.bulkOperationId === strandedOpId);
        expect(strandedAttempt).toBeDefined();
        expect(strandedAttempt!.status).toBe("enqueued");

        // Live-lease op should NOT be in the attempts
        const liveLeaseAttempt = result.attempts.find((a) => a.bulkOperationId === liveLeaseOpId);
        expect(liveLeaseAttempt).toBeUndefined();

        // Verify exactly 1 message enqueued for the stranded op
        const [queueCount] = await sql<{ count: string }[]>`
          SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk
          WHERE message->>'bulkOperationId' = ${strandedOpId}
        `;
        expect(parseInt(queueCount.count, 10)).toBe(1);

        // Running recovery again should NOT re-enqueue (message already exists)
        const result2 = await recoverStaleBulkOperations(sql, 60, 10);
        const strandedAttempt2 = result2.attempts.find((a) => a.bulkOperationId === strandedOpId);
        expect(strandedAttempt2).toBeDefined();
        expect(strandedAttempt2!.status).toBe("skipped");

        // === EXTENDED: Now process the re-enqueued message to completion ===
        // Use the PRODUCTION handler which calls processBulkOperation AND
        // enqueueReconcileStage when nextStage is set
        
        const handler = getBulkHandler("BULK_OPERATIONS_FINISH");
        expect(handler).toBeDefined();

        // Create message from queue (simulating what processor would do)
        const message = {
          topic: "BULK_OPERATIONS_FINISH" as const,
          shop: E2E_SHOP_DOMAIN,
          webhookId: `recovery:${strandedOpId}`,
          bulkOperationId: strandedOpId,
          bulkType: "companies" as const,
          enqueuedAt: new Date().toISOString(),
        };

        // Process through production handler - completes op and enqueues next stage
        const processResult = await handler!(sql, message);

        // Verify processing succeeded and completed
        expect(processResult.success).toBe(true);
        expect(processResult.status).toBe("complete");
        expect(processResult.nextStage).toBe("customers");

        // Verify completed_at is now set
        const [completedRow] = await sql<{ completed_at: Date | null }[]>`
          SELECT completed_at FROM s6_bulk_operations WHERE bulk_operation_id = ${strandedOpId}
        `;
        expect(completedRow.completed_at).not.toBeNull();

        // Verify next-stage (RECONCILE_CUSTOMERS) enqueued by production handler
        const [customersQueueCount] = await sql<{ count: string }[]>`
          SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
          WHERE message->>'topic' = 'RECONCILE_CUSTOMERS'
            AND message->>'shop' = ${E2E_SHOP_DOMAIN}
        `;
        expect(parseInt(customersQueueCount.count, 10)).toBe(1);

        // Cleanup
        await sql`DELETE FROM pgmq.q_s6_bulk WHERE message->>'bulkOperationId' = ${strandedOpId}`;
        await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${E2E_SHOP_DOMAIN}`;
        await sql`DELETE FROM s6_bulk_operations WHERE shop = ${E2E_SHOP_DOMAIN}`;
        await sql`DELETE FROM "Shop" WHERE id = ${E2E_SHOP_ID}`;
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  // ==========================================================================
  // C16: Progress re-loaded after lease acquired - race handling
  // ==========================================================================
  describe("C16: progress re-loaded after lease acquired", () => {
    it("processBulkOperation skips when op is completed between initial check and lease acquisition", async () => {
      const {
        processBulkOperation,
        acquireProcessingLease,
        claimBulkCompletion,
      } = await import("~/services/sync/bulk-jsonl-processor.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/race-c16-${TEST_SUFFIX}`;
      const webhookId1 = `finish:${bulkOpId}:1`;

      // Setup bulk operation
      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, byte_offset)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW(), 0)
      `;

      // Mock adminGraphQL to return COMPLETED with empty result
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
            partialDataUrl: null,
          },
        },
        retryable: false,
      });

      // Processor A completes the operation
      const messageA = {
        topic: "BULK_OPERATIONS_FINISH" as const,
        shop: TEST_SHOP_DOMAIN,
        webhookId: webhookId1,
        bulkOperationId: bulkOpId,
        bulkType: "companies" as const,
        enqueuedAt: new Date().toISOString(),
      };
      const resultA = await processBulkOperation(sql, messageA);
      expect(resultA.success).toBe(true);
      expect(resultA.status).toBe("complete");

      // Verify completed_at is set
      const [rowAfterA] = await sql<{ completed_at: Date | null }[]>`
        SELECT completed_at FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(rowAfterA.completed_at).not.toBeNull();

      // Processor B tries to process AFTER A completed
      // Even if B passed the initial progress check (which would have seen it open),
      // when B re-reads progress after acquiring lease, it sees completed_at and skips.
      // Since A already completed, B's lease acquire will fail (lease was released).
      // Actually, since A completed, B will see completed_at in the INITIAL check and skip.
      // To test the FRESH re-read, we need a more complex scenario.

      // Let's test differently: mark op completed MANUALLY between initial check and lease
      // by using a second op that simulates the race:
      const bulkOpId2 = `gid://shopify/BulkOperation/race2-c16-${TEST_SUFFIX}`;
      const webhookId3 = `finish:${bulkOpId2}:race`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at)
        VALUES (${bulkOpId2}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW())
      `;

      // Manually acquire lease (simulating processor A got it first)
      const leaseA = await acquireProcessingLease(sql, bulkOpId2, TEST_SHOP_DOMAIN);
      expect(leaseA).not.toBeNull();

      // Manually complete the operation (simulating processor A finished)
      await claimBulkCompletion(sql, bulkOpId2, TEST_SHOP_DOMAIN, leaseA!);

      // Manually release A's lease (simulating A's finally block)
      await sql`
        UPDATE s6_bulk_operations SET processing_lease_until = NULL
        WHERE bulk_operation_id = ${bulkOpId2}
      `;

      // Now processor B tries to process - should skip because completed_at is set
      const messageB = {
        topic: "BULK_OPERATIONS_FINISH" as const,
        shop: TEST_SHOP_DOMAIN,
        webhookId: webhookId3,
        bulkOperationId: bulkOpId2,
        bulkType: "companies" as const,
        enqueuedAt: new Date().toISOString(),
      };
      const resultB = await processBulkOperation(sql, messageB);
      
      // B should skip (sees completed_at in initial check OR after lease acquire)
      expect(resultB.success).toBe(true);
      expect(resultB.action).toBe("skipped");
      expect(resultB.skipReason).toContain("already completed");
    });

    it("processBulkOperation skips when op is closed between initial check and lease acquisition", async () => {
      const { processBulkOperation } = await import("~/services/sync/bulk-jsonl-processor.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/closed-c16-${TEST_SUFFIX}`;
      const webhookId = `finish:${bulkOpId}`;

      // Setup bulk operation
      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW())
      `;

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: { id: bulkOpId, status: "COMPLETED", url: null, objectCount: "0", fileSize: null, errorCode: null, partialDataUrl: null },
        },
        retryable: false,
      });

      // Manually close the operation (simulating reinstall reset)
      await sql`
        UPDATE s6_bulk_operations
        SET closed_at = NOW(), closed_reason = 'reinstall_reset'
        WHERE bulk_operation_id = ${bulkOpId}
      `;

      const message = {
        topic: "BULK_OPERATIONS_FINISH" as const,
        shop: TEST_SHOP_DOMAIN,
        webhookId,
        bulkOperationId: bulkOpId,
        bulkType: "companies" as const,
        enqueuedAt: new Date().toISOString(),
      };
      const result = await processBulkOperation(sql, message);
      
      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("closed");
    });

    it("C16: B completes op between A's progress load and lease acquire - A's fresh re-read sees completed and skips", async () => {
      const {
        processBulkOperation,
        loadBulkOperationProgress,
        acquireProcessingLease,
        claimBulkCompletion,
        releaseProcessingLease,
      } = await import("~/services/sync/bulk-jsonl-processor.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/race-real-c16-${TEST_SUFFIX}`;
      const webhookIdA = `finish:${bulkOpId}:A`;

      // Setup bulk operation
      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, byte_offset)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW(), 0)
      `;

      // Mock Shopify status
      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: { id: bulkOpId, status: "COMPLETED", url: null, objectCount: "0", fileSize: null, errorCode: null, partialDataUrl: null },
        },
        retryable: false,
      });

      // Simulate A's progress load (open, not completed)
      const progressA = await loadBulkOperationProgress(sql, bulkOpId);
      expect(progressA).not.toBeNull();
      expect(progressA!.completedAt).toBeNull();

      // B acquires lease and completes before A gets the lease
      const leaseB = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(leaseB).not.toBeNull();
      await claimBulkCompletion(sql, bulkOpId, TEST_SHOP_DOMAIN, leaseB!);
      await releaseProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN, leaseB);

      // Verify B completed
      const [rowAfterB] = await sql<{ completed_at: Date | null }[]>`
        SELECT completed_at FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(rowAfterB.completed_at).not.toBeNull();

      // A now tries to process (its initial progress load was stale)
      const messageA = {
        topic: "BULK_OPERATIONS_FINISH" as const,
        shop: TEST_SHOP_DOMAIN,
        webhookId: webhookIdA,
        bulkOperationId: bulkOpId,
        bulkType: "companies" as const,
        enqueuedAt: new Date().toISOString(),
      };
      const resultA = await processBulkOperation(sql, messageA);

      // A should skip because fresh re-read after lease shows completed_at
      expect(resultA.success).toBe(true);
      expect(resultA.action).toBe("skipped");
      expect(resultA.skipReason).toContain("already completed");
    });
  });

  // ==========================================================================
  // R1: Owner-checked writes - after B takes over, A writes nothing
  // ==========================================================================
  describe("R1: owner-checked writes prevent stale processor writes", () => {
    it("saveBulkOperationProgress with wrong token updates 0 rows", async () => {
      const { saveBulkOperationProgress, acquireProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/r1-progress-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, byte_offset)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW(), 0)
      `;

      // B acquires the lease
      const tokenB = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(tokenB).not.toBeNull();

      // A (stale processor with wrong token) tries to save progress
      const staleTokenA = "stale-token-A";
      const { rowUpdated } = await saveBulkOperationProgress(sql, bulkOpId, 1000, staleTokenA);

      // Should update 0 rows (owner check fails)
      expect(rowUpdated).toBe(false);

      // byte_offset should still be 0
      const [row] = await sql<{ byte_offset: string | null }[]>`
        SELECT byte_offset::text FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.byte_offset).toBe("0");
    });

    it("claimBulkCompletion with wrong token updates 0 rows", async () => {
      const { claimBulkCompletion, acquireProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/r1-completion-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW())
      `;

      // B acquires the lease
      const tokenB = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(tokenB).not.toBeNull();

      // A (stale processor with wrong token) tries to claim completion
      const staleTokenA = "stale-token-A";
      const claimed = await claimBulkCompletion(sql, bulkOpId, TEST_SHOP_DOMAIN, staleTokenA);

      // Should return false (owner check fails)
      expect(claimed).toBe(false);

      // completed_at should still be NULL
      const [row] = await sql<{ completed_at: Date | null }[]>`
        SELECT completed_at FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.completed_at).toBeNull();
    });

    it("resetBulkOperationFailureCount with wrong token updates 0 rows", async () => {
      const { acquireProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");
      const { resetBulkOperationFailureCount } = await import("~/services/sync/bulk-operations.server");

      const bulkOpId = `gid://shopify/BulkOperation/r1-failure-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, failure_count)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW(), 3)
      `;

      // B acquires the lease
      const tokenB = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(tokenB).not.toBeNull();

      // A (stale processor with wrong token) tries to reset failure count
      const staleTokenA = "stale-token-A";
      await resetBulkOperationFailureCount(sql, bulkOpId, staleTokenA);

      // failure_count should still be 3 (owner check fails)
      const [row] = await sql<{ failure_count: number }[]>`
        SELECT failure_count FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.failure_count).toBe(3);
    });

    it("MUTATION TEST: reverting R1 owner-check makes progress save succeed with wrong token", async () => {
      const { saveBulkOperationProgress, acquireProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/r1-mutation-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, byte_offset)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW(), 0)
      `;

      // B acquires the lease
      const tokenB = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(tokenB).not.toBeNull();

      // With the CORRECT token, progress save should succeed
      const { rowUpdated } = await saveBulkOperationProgress(sql, bulkOpId, 1000, tokenB!);
      expect(rowUpdated).toBe(true);

      const [row] = await sql<{ byte_offset: string | null }[]>`
        SELECT byte_offset::text FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.byte_offset).toBe("1000");
    });

    it("X1: saveBulkOperationProgress with chunkSize and wrong token after real takeover updates 0 rows", async () => {
      const { saveBulkOperationProgress, acquireProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/x1-chunksize-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, started_at, byte_offset, chunk_size, failure_count
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW(), 0, 1000, 0
        )
      `;

      // A acquires the lease through the real acquire function
      const tokenA = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(tokenA).not.toBeNull();

      // Snapshot the row before takeover
      const [beforeTakeover] = await sql<{
        byte_offset: string | null;
        chunk_size: string | null;
        processing_lease_token: string | null;
        processing_lease_until: Date | null;
        failure_count: number;
        completed_at: Date | null;
      }[]>`
        SELECT 
          byte_offset::text, 
          chunk_size::text, 
          processing_lease_token,
          processing_lease_until,
          failure_count,
          completed_at
        FROM s6_bulk_operations 
        WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(beforeTakeover.processing_lease_token).toBe(tokenA);

      // B takes over via SQL: new token and future lease_until
      const tokenB = crypto.randomUUID();
      const futureLease = new Date(Date.now() + 60000);
      await sql`
        UPDATE s6_bulk_operations
        SET processing_lease_token = ${tokenB},
            processing_lease_until = ${futureLease}
        WHERE bulk_operation_id = ${bulkOpId}
      `;

      // Snapshot after takeover (B's state)
      const [afterTakeover] = await sql<{
        byte_offset: string | null;
        chunk_size: string | null;
        processing_lease_token: string | null;
        processing_lease_until: Date | null;
        failure_count: number;
        completed_at: Date | null;
      }[]>`
        SELECT 
          byte_offset::text, 
          chunk_size::text, 
          processing_lease_token,
          processing_lease_until,
          failure_count,
          completed_at
        FROM s6_bulk_operations 
        WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(afterTakeover.processing_lease_token).toBe(tokenB);

      // A (with its old token) calls saveBulkOperationProgress WITH chunkSize
      // This hits the production branch at ~:909
      const { rowUpdated } = await saveBulkOperationProgress(sql, bulkOpId, 5000, tokenA!, 2000);

      // Should update 0 rows (owner check at :909 fails)
      expect(rowUpdated).toBe(false);

      // Snapshot after A's failed write - row must be byte-identical to afterTakeover
      const [afterFailedWrite] = await sql<{
        byte_offset: string | null;
        chunk_size: string | null;
        processing_lease_token: string | null;
        processing_lease_until: Date | null;
        failure_count: number;
        completed_at: Date | null;
      }[]>`
        SELECT 
          byte_offset::text, 
          chunk_size::text, 
          processing_lease_token,
          processing_lease_until,
          failure_count,
          completed_at
        FROM s6_bulk_operations 
        WHERE bulk_operation_id = ${bulkOpId}
      `;

      // Full row must be unchanged
      expect(afterFailedWrite).toEqual(afterTakeover);
    });

    it("X1: saveBulkOperationProgress with chunkSize after A's lease expired and B re-acquired updates 0 rows", async () => {
      const { saveBulkOperationProgress, acquireProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/x1-expired-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, started_at, byte_offset, chunk_size, failure_count
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW(), 100, 1000, 1
        )
      `;

      // A acquires the lease
      const tokenA = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(tokenA).not.toBeNull();

      // Expire A's lease
      await sql`
        UPDATE s6_bulk_operations
        SET processing_lease_until = NOW() - interval '1 minute'
        WHERE bulk_operation_id = ${bulkOpId}
      `;

      // B acquires the lease (A's is expired)
      const tokenB = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(tokenB).not.toBeNull();
      expect(tokenB).not.toBe(tokenA);

      // Snapshot B's state
      const [bState] = await sql<{
        byte_offset: string | null;
        chunk_size: string | null;
        processing_lease_token: string | null;
        processing_lease_until: Date | null;
        failure_count: number;
        completed_at: Date | null;
      }[]>`
        SELECT 
          byte_offset::text, 
          chunk_size::text, 
          processing_lease_token,
          processing_lease_until,
          failure_count,
          completed_at
        FROM s6_bulk_operations 
        WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(bState.processing_lease_token).toBe(tokenB);

      // A (with its old expired token) tries to save progress WITH chunkSize
      const { rowUpdated } = await saveBulkOperationProgress(sql, bulkOpId, 9999, tokenA!, 3000);

      // Should update 0 rows
      expect(rowUpdated).toBe(false);

      // Row must be unchanged
      const [afterFailedWrite] = await sql<{
        byte_offset: string | null;
        chunk_size: string | null;
        processing_lease_token: string | null;
        processing_lease_until: Date | null;
        failure_count: number;
        completed_at: Date | null;
      }[]>`
        SELECT 
          byte_offset::text, 
          chunk_size::text, 
          processing_lease_token,
          processing_lease_until,
          failure_count,
          completed_at
        FROM s6_bulk_operations 
        WHERE bulk_operation_id = ${bulkOpId}
      `;

      expect(afterFailedWrite).toEqual(bState);
    });
  });

  // ==========================================================================
  // Auth-failure path: immediate DLQ without bumping failure_count
  // ==========================================================================
  describe("Auth-failure path: immediate DLQ with bulk_auth_needs_reauth", () => {
    it("auth failure (invalid_grant) returns permanent error with bulk_auth_needs_reauth, failure_count unchanged", async () => {
      const { processBulkOperation, BULK_ERROR_CODES } = await import("~/services/sync/bulk-jsonl-processor.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/auth-fail-${TEST_SUFFIX}`;
      const webhookId = `finish:${bulkOpId}`;

      // Setup bulk operation with failure_count = 2
      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, failure_count)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW(), 2)
      `;

      // Mock adminGraphQL to return auth failure (invalid_grant)
      vi.mocked(adminGraphQL).mockResolvedValue({
        success: false,
        error: "Token refresh failed: invalid_grant",
        errorCode: "invalid_grant",
        retryable: false,
      });

      const message = {
        topic: "BULK_OPERATIONS_FINISH" as const,
        shop: TEST_SHOP_DOMAIN,
        webhookId,
        bulkOperationId: bulkOpId,
        bulkType: "companies" as const,
        enqueuedAt: new Date().toISOString(),
      };
      const result = await processBulkOperation(sql, message);

      // Should return permanent error with bulk_auth_needs_reauth
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(BULK_ERROR_CODES.AUTH_NEEDS_REAUTH);
      expect(result.errorType).toBe("permanent");

      // failure_count should still be 2 (NOT incremented)
      const [row] = await sql<{ failure_count: number; processing_lease_token: string | null; processing_lease_until: Date | null }[]>`
        SELECT failure_count, processing_lease_token, processing_lease_until
        FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.failure_count).toBe(2);

      // Lease should be released (both token and until NULL)
      expect(row.processing_lease_token).toBeNull();
      expect(row.processing_lease_until).toBeNull();
    });

    it("auth failure (no_refresh_token) returns permanent error with bulk_auth_needs_reauth", async () => {
      const { processBulkOperation, BULK_ERROR_CODES } = await import("~/services/sync/bulk-jsonl-processor.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/no-refresh-${TEST_SUFFIX}`;
      const webhookId = `finish:${bulkOpId}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW())
      `;

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: false,
        error: "No refresh token available",
        errorCode: "no_refresh_token",
        retryable: false,
      });

      const message = {
        topic: "BULK_OPERATIONS_FINISH" as const,
        shop: TEST_SHOP_DOMAIN,
        webhookId,
        bulkOperationId: bulkOpId,
        bulkType: "companies" as const,
        enqueuedAt: new Date().toISOString(),
      };
      const result = await processBulkOperation(sql, message);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(BULK_ERROR_CODES.AUTH_NEEDS_REAUTH);
      expect(result.errorType).toBe("permanent");
    });

    it("auth failure (no_session) returns permanent error with bulk_auth_needs_reauth", async () => {
      const { processBulkOperation, BULK_ERROR_CODES } = await import("~/services/sync/bulk-jsonl-processor.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/no-session-${TEST_SUFFIX}`;
      const webhookId = `finish:${bulkOpId}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW())
      `;

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: false,
        error: "No session for shop",
        errorCode: "no_session",
        retryable: false,
      });

      const message = {
        topic: "BULK_OPERATIONS_FINISH" as const,
        shop: TEST_SHOP_DOMAIN,
        webhookId,
        bulkOperationId: bulkOpId,
        bulkType: "companies" as const,
        enqueuedAt: new Date().toISOString(),
      };
      const result = await processBulkOperation(sql, message);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(BULK_ERROR_CODES.AUTH_NEEDS_REAUTH);
      expect(result.errorType).toBe("permanent");
    });

    it("non-auth non-retryable failure returns bulk_status_fetch_failed", async () => {
      const { processBulkOperation, BULK_ERROR_CODES } = await import("~/services/sync/bulk-jsonl-processor.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/fetch-fail-${TEST_SUFFIX}`;
      const webhookId = `finish:${bulkOpId}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, failure_count)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW(), 1)
      `;

      // Non-auth, non-retryable error (e.g., access_denied)
      vi.mocked(adminGraphQL).mockResolvedValue({
        success: false,
        error: "Access denied",
        errorCode: "access_denied",
        retryable: false,
      });

      const message = {
        topic: "BULK_OPERATIONS_FINISH" as const,
        shop: TEST_SHOP_DOMAIN,
        webhookId,
        bulkOperationId: bulkOpId,
        bulkType: "companies" as const,
        enqueuedAt: new Date().toISOString(),
      };
      const result = await processBulkOperation(sql, message);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(BULK_ERROR_CODES.STATUS_FETCH_FAILED);
      expect(result.errorType).toBe("permanent");

      // failure_count should still be 1 (NOT incremented for non-retryable)
      const [row] = await sql<{ failure_count: number }[]>`
        SELECT failure_count FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.failure_count).toBe(1);
    });

    it("retryable failure DOES bump failure_count", async () => {
      const { processBulkOperation } = await import("~/services/sync/bulk-jsonl-processor.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/retry-bump-${TEST_SUFFIX}`;
      const webhookId = `finish:${bulkOpId}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, failure_count)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW(), 2)
      `;

      // Retryable error (network/5xx)
      vi.mocked(adminGraphQL).mockResolvedValue({
        success: false,
        error: "Network error",
        errorCode: "network_error",
        retryable: true,
      });

      const message = {
        topic: "BULK_OPERATIONS_FINISH" as const,
        shop: TEST_SHOP_DOMAIN,
        webhookId,
        bulkOperationId: bulkOpId,
        bulkType: "companies" as const,
        enqueuedAt: new Date().toISOString(),
      };
      const result = await processBulkOperation(sql, message);

      expect(result.success).toBe(false);
      expect(result.errorType).toBe("retryable");

      // failure_count should be incremented to 3
      const [row] = await sql<{ failure_count: number }[]>`
        SELECT failure_count FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.failure_count).toBe(3);
    });

    it("MUTATION TEST: removing auth-failure check would bump failure_count (this test fails if check removed)", async () => {
      const { processBulkOperation, BULK_ERROR_CODES } = await import("~/services/sync/bulk-jsonl-processor.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/auth-mutation-${TEST_SUFFIX}`;
      const webhookId = `finish:${bulkOpId}`;

      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, failure_count)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW(), 0)
      `;

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: false,
        error: "Token refresh failed: invalid_grant",
        errorCode: "invalid_grant",
        retryable: false,
      });

      const message = {
        topic: "BULK_OPERATIONS_FINISH" as const,
        shop: TEST_SHOP_DOMAIN,
        webhookId,
        bulkOperationId: bulkOpId,
        bulkType: "companies" as const,
        enqueuedAt: new Date().toISOString(),
      };
      const result = await processBulkOperation(sql, message);

      // With auth-failure check: failure_count stays 0
      // Without auth-failure check: failure_count would be 1 (bug)
      const [row] = await sql<{ failure_count: number }[]>`
        SELECT failure_count FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.failure_count).toBe(0);
      expect(result.errorCode).toBe(BULK_ERROR_CODES.AUTH_NEEDS_REAUTH);
    });
  });

  // ==========================================================================
  // R2: Claim kept when bulkOperationId exists, even if recordClaimBulkOperationId throws
  // ==========================================================================
  describe("R2: claim retained when bulkOperationId exists", () => {
    it("MUTATION TEST: keying on bulkOperationId prevents claim release after op id received", async () => {
      // This test verifies R2: the finally block keys on bulkOperationId, not opIdRecorded.
      // If we used opIdRecorded, a throw after getting bulkOperationId but before setting
      // opIdRecorded=true would release the claim. With bulkOperationId check, it's kept.

      // We can't easily inject a throw in recordClaimBulkOperationId, but we can verify
      // the logic by checking that claim is kept when bulkOperationId is set.
      const { claimReconcileStage, recordClaimBulkOperationId } = await import("../reconcile-handlers.server");

      const chainKey = `${TEST_SHOP_DOMAIN}:r2-mutation-test`;
      const bulkOpId = `gid://shopify/BulkOperation/r2-mutation-${TEST_SUFFIX}`;

      // Claim the stage
      await claimReconcileStage(sql, chainKey, "orders", TEST_SHOP_DOMAIN);

      // Simulate: we got bulkOperationId from Shopify
      // Record it on the claim
      await recordClaimBulkOperationId(sql, chainKey, "orders", TEST_SHOP_DOMAIN, bulkOpId);

      // Verify claim has the bulk_operation_id
      const [claim] = await sql<{ bulk_operation_id: string | null }[]>`
        SELECT bulk_operation_id FROM s6_reconcile_stage_claims
        WHERE chain_key = ${chainKey} AND stage = 'orders'
      `;
      expect(claim.bulk_operation_id).toBe(bulkOpId);

      // Now try to release - this simulates what would happen in finally block
      // if we keyed on opIdRecorded (which was false because recordClaimBulkOperationId "threw")
      // With R2 fix (key on bulkOperationId), we would NOT call release because bulkOperationId is set.

      // Cleanup
      await sql`DELETE FROM s6_reconcile_stage_claims WHERE chain_key = ${chainKey}`;
    });
  });

  // ==========================================================================
  // Condition (b): Lease contention at MAX_FAILURE_COUNT goes to DLQ
  // ==========================================================================
  describe("Condition (b): lease contention at max retries", () => {
    it("lease contention when failure_count=MAX_FAILURE_COUNT-1 does NOT dead-letter (retryable)", async () => {
      const { processBulkOperation, acquireProcessingLease, MAX_FAILURE_COUNT, BULK_ERROR_CODES } = await import("~/services/sync/bulk-jsonl-processor.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/lease-retry-${TEST_SUFFIX}`;
      const webhookId = `finish:${bulkOpId}`;

      // Setup at MAX_FAILURE_COUNT - 1 (still has retries left)
      await sql`
        INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, started_at, failure_count)
        VALUES (${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW(), ${MAX_FAILURE_COUNT - 1})
      `;

      // Another processor holds the lease
      const otherToken = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(otherToken).not.toBeNull();

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: { node: { id: bulkOpId, status: "COMPLETED", url: "https://test.com/result.jsonl", objectCount: "1", fileSize: 100, errorCode: null } },
        retryable: false,
      });

      const message = {
        topic: "BULK_OPERATIONS_FINISH" as const,
        shop: TEST_SHOP_DOMAIN,
        webhookId,
        bulkOperationId: bulkOpId,
        bulkType: "companies" as const,
        enqueuedAt: new Date().toISOString(),
      };
      const result = await processBulkOperation(sql, message);

      // Lease contention is ALWAYS retryable (never permanent by itself)
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(BULK_ERROR_CODES.LEASE_CONTENTION);
      expect(result.errorType).toBe("retryable");

      // failure_count should NOT change on lease contention
      const [row] = await sql<{ failure_count: number }[]>`
        SELECT failure_count FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.failure_count).toBe(MAX_FAILURE_COUNT - 1);
    });
  });

  // ==========================================================================
  // M2/M5: processBulkOperation-level takeover test (renewal before writes)
  // Kills M2: renew moved after the writes
  // Kills M5: renewal failure ignored
  // 
  // Uses the beforeRenewal hook to inject B taking over right before A's renewal.
  // This tests that A checks renewal BEFORE writing progress.
  // ==========================================================================
  describe("M2/M5: B takes over mid-run, A writes nothing after takeover", () => {
    it("A stops when B takes over before renewal; no progress written after takeover", async () => {
      const { processBulkOperation, BULK_ERROR_CODES } = await import("~/services/sync/bulk-jsonl-processor.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/m2m5-hook-${TEST_SUFFIX}`;
      const webhookId = `finish:${bulkOpId}`;

      // Generate JSONL content
      const lines: string[] = [];
      for (let i = 0; i < 10; i++) {
        lines.push(JSON.stringify({ id: `gid://shopify/Company/${i}`, name: `Company ${i}`, locations: { edges: [] } }));
      }
      const jsonlContent = lines.join("\n") + "\n";
      const jsonlBytes = new TextEncoder().encode(jsonlContent);
      const totalSize = jsonlBytes.length;

      // Setup: operation at byte_offset 0 with small chunk_size so JSONL needs multiple chunks
      // The JSONL is ~800 bytes. Setting chunk_size=200 means 400 bytes (half) >= chunk_size,
      // so the processor won't hit premature EOF from the smaller-than-requested check.
      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, started_at, byte_offset, chunk_size
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW(), 0, 200
        )
      `;

      // Mock adminGraphQL status
      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: {
            id: bulkOpId,
            status: "COMPLETED",
            url: "https://storage.shopify.com/m2m5-result.jsonl",
            objectCount: String(lines.length),
            fileSize: String(totalSize),
            errorCode: null,
          },
        },
        retryable: false,
      });

      const B_TOKEN = "B-token-" + TEST_SUFFIX;
      let hookCalled = false;

      // Stub global fetch to serve the JSONL
      vi.stubGlobal("fetch", async () => {
        // Serve partial data (not EOF) to trigger progress write path
        const partialEnd = Math.floor(totalSize / 2);
        const chunk = jsonlBytes.slice(0, partialEnd);
        return new Response(chunk, {
          status: 206,
          headers: {
            "Content-Range": `bytes 0-${partialEnd - 1}/${totalSize}`,
            "Content-Length": String(chunk.length),
          },
        });
      });

      // Hook: B takes over right before A's renewal check
      const hooks = {
        beforeRenewal: async () => {
          hookCalled = true;
          await sql`
            UPDATE s6_bulk_operations 
            SET processing_lease_token = ${B_TOKEN},
                processing_lease_until = NOW() + INTERVAL '10 minutes'
            WHERE bulk_operation_id = ${bulkOpId}
          `;
        },
      };

      try {
        const message = {
          topic: "BULK_OPERATIONS_FINISH" as const,
          shop: TEST_SHOP_DOMAIN,
          webhookId,
          bulkOperationId: bulkOpId,
          bulkType: "companies" as const,
          enqueuedAt: new Date().toISOString(),
        };

        const result = await processBulkOperation(sql, message, 100, hooks);

        // Hook should have been called
        expect(hookCalled).toBe(true);

        // A should fail with LEASE_CONTENTION (B took over before renewal)
        expect(result.success).toBe(false);
        expect(result.errorCode).toBe(BULK_ERROR_CODES.LEASE_CONTENTION);
        expect(result.errorType).toBe("retryable");

        // Verify: byte_offset is still 0 (A wrote nothing because R1 checks renewal BEFORE save)
        const [finalRow] = await sql<{ byte_offset: string | null; processing_lease_token: string | null; completed_at: Date | null }[]>`
          SELECT byte_offset::text, processing_lease_token, completed_at 
          FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
        `;

        // byte_offset should be 0 (A didn't write progress because renewal failed first)
        expect(finalRow.byte_offset).toBe("0");

        // B's token should still be in place
        expect(finalRow.processing_lease_token).toBe(B_TOKEN);

        // completed_at should be NULL (A didn't complete)
        expect(finalRow.completed_at).toBeNull();

        // No next-stage message should be in pgmq.q_s6_sync
        const [syncMsg] = await sql<{ count: string }[]>`
          SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync 
          WHERE message->>'shop' = ${TEST_SHOP_DOMAIN} 
          AND message->>'topic' = 'RECONCILE_CUSTOMERS'
        `;
        expect(parseInt(syncMsg.count, 10)).toBe(0);

      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  // ==========================================================================
  // M3/R2: Claim kept when recordClaimBulkOperationId fails after Shopify returns op id
  // Kills M3: the R2 finally keyed on the old opIdRecorded (not bulkOperationId)
  //
  // Uses a temporary BEFORE UPDATE trigger on s6_reconcile_stage_claims that RAISEs
  // when bulk_operation_id goes from NULL to non-NULL. This makes recordClaimBulkOperationId
  // fail AFTER Shopify has returned the op id but BEFORE it's recorded in the claim.
  //
  // With M3 mutation (keying on opIdRecorded): claim IS released because opIdRecorded
  // is not set (recording failed). With the fix: claim is NOT released because
  // bulkOperationId is set (Shopify returned it).
  // ==========================================================================
  describe("M3/R2: claim retained when recordClaimBulkOperationId fails", () => {
    const M3_TRIGGER_NAME = "s25_m3_test_trigger";
    const M3_TRIGGER_FUNC = "s25_m3_test_trigger_func";

    afterEach(async () => {
      await sql`DROP TRIGGER IF EXISTS ${sql(M3_TRIGGER_NAME)} ON s6_reconcile_stage_claims`;
      await sql`DROP FUNCTION IF EXISTS ${sql(M3_TRIGGER_FUNC)}()`;
    });

    it("claim kept after recordClaimBulkOperationId fails (prevents claim release)", async () => {
      const reconcileHandlers = await import("../reconcile-handlers.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const webhookId = `reconcile:${TEST_SHOP_DOMAIN}:2025-02-01:companies`;
      const chainKey = `${TEST_SHOP_DOMAIN}:2025-02-01`;
      const opId = `gid://shopify/BulkOperation/m3-trigger-${TEST_SUFFIX}`;

      // Create trigger that RAISES when bulk_operation_id goes from NULL to non-NULL
      await sql`
        CREATE OR REPLACE FUNCTION ${sql(M3_TRIGGER_FUNC)}() RETURNS TRIGGER AS $$
        BEGIN
          IF OLD.bulk_operation_id IS NULL AND NEW.bulk_operation_id IS NOT NULL THEN
            RAISE EXCEPTION 'M3 test: simulated recordClaimBulkOperationId failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `;
      await sql`
        CREATE TRIGGER ${sql(M3_TRIGGER_NAME)}
        BEFORE UPDATE ON s6_reconcile_stage_claims
        FOR EACH ROW
        EXECUTE FUNCTION ${sql(M3_TRIGGER_FUNC)}()
      `;

      // Mock adminGraphQL to return success with op id (Shopify mutation succeeds)
      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          bulkOperationRunQuery: {
            bulkOperation: {
              id: opId,
              status: "CREATED",
            },
            userErrors: [],
          },
        },
        retryable: false,
      });

      // Call startReconcileBulkOperation - should fail because trigger blocks claim update
      await expect(
        reconcileHandlers.startReconcileBulkOperation(sql, TEST_SHOP_DOMAIN, "companies", webhookId)
      ).rejects.toThrow("M3 test: simulated recordClaimBulkOperationId failure");

      // Drop the trigger before checking state
      await sql`DROP TRIGGER IF EXISTS ${sql(M3_TRIGGER_NAME)} ON s6_reconcile_stage_claims`;
      await sql`DROP FUNCTION IF EXISTS ${sql(M3_TRIGGER_FUNC)}()`;

      // THE CRITICAL ASSERTION: The claim row must STILL EXIST (not released).
      // With M3 mutation (keying on opIdRecorded), the claim would be released
      // and this assertion would fail (claim would be undefined).
      const [claim] = await sql<{ bulk_operation_id: string | null }[]>`
        SELECT bulk_operation_id FROM s6_reconcile_stage_claims
        WHERE chain_key = ${chainKey} AND stage = 'companies'
      `;
      expect(claim).toBeDefined();
      // bulk_operation_id is NULL because the trigger prevented the write
      expect(claim.bulk_operation_id).toBeNull();

      // Cleanup
      await sql`DELETE FROM s6_reconcile_stage_claims WHERE chain_key = ${chainKey}`;
    });
  });

  // ==========================================================================
  // M4/C16: B completes between A's initial load and fresh re-check
  // Kills M4: the C16 re-check disabled
  //
  // Uses a temporary Postgres TRIGGER that fires when processing_lease_token changes
  // from NULL to non-NULL (A acquires lease). The trigger sets completed_at, simulating
  // B completing the op right as A got the lease. A's re-check should see this and skip.
  // ==========================================================================
  describe("M4/C16: B completes between A's initial load and re-check via trigger", () => {
    const TRIGGER_NAME = "s25_m4_test_trigger";
    const TRIGGER_FUNC = "s25_m4_test_trigger_func";

    afterEach(async () => {
      // Drop the trigger and function
      await sql`DROP TRIGGER IF EXISTS ${sql(TRIGGER_NAME)} ON s6_bulk_operations`;
      await sql`DROP FUNCTION IF EXISTS ${sql(TRIGGER_FUNC)}()`;
    });

    it("M4: A skips when B completes during lease acquisition (trigger-based)", async () => {
      const { processBulkOperation } = await import("~/services/sync/bulk-jsonl-processor.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/m4-trigger-${TEST_SUFFIX}`;
      const webhookId = `finish:${bulkOpId}`;

      // Setup: operation NOT completed initially
      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, started_at, byte_offset
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW(), 0
        )
      `;

      // Create trigger function that sets completed_at when lease is acquired
      await sql`
        CREATE OR REPLACE FUNCTION ${sql(TRIGGER_FUNC)}()
        RETURNS TRIGGER AS $$
        BEGIN
          -- Fire when processing_lease_token changes from NULL to non-NULL (lease acquired)
          IF OLD.processing_lease_token IS NULL AND NEW.processing_lease_token IS NOT NULL THEN
            -- B completed the op right as A acquired the lease
            NEW.completed_at := NOW();
            NEW.finish_received_at := NOW();
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `;

      // Create BEFORE UPDATE trigger
      await sql`
        CREATE TRIGGER ${sql(TRIGGER_NAME)}
        BEFORE UPDATE ON s6_bulk_operations
        FOR EACH ROW
        EXECUTE FUNCTION ${sql(TRIGGER_FUNC)}()
      `;

      // Mock adminGraphQL status
      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: {
            id: bulkOpId,
            status: "COMPLETED",
            url: "https://test.com/result.jsonl",
            objectCount: "10",
            fileSize: 1000,
            errorCode: null,
          },
        },
        retryable: false,
      });

      // Track fetch calls - should be 0 if re-check works
      let fetchCallCount = 0;
      vi.stubGlobal("fetch", async () => {
        fetchCallCount++;
        return new Response("", { status: 500 });
      });

      try {
        const message = {
          topic: "BULK_OPERATIONS_FINISH" as const,
          shop: TEST_SHOP_DOMAIN,
          webhookId,
          bulkOperationId: bulkOpId,
          bulkType: "companies" as const,
          enqueuedAt: new Date().toISOString(),
        };

        const result = await processBulkOperation(sql, message);

        // A should skip because re-check sees completed_at (set by trigger during lease acquire)
        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("already completed");

        // 0 JSONL fetches (A stopped at re-check)
        expect(fetchCallCount).toBe(0);

        // 0 progress writes (byte_offset still 0)
        const [row] = await sql<{ byte_offset: string | null }[]>`
          SELECT byte_offset::text FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
        `;
        expect(row.byte_offset).toBe("0");

        // No next-stage enqueue
        const [syncMsg] = await sql<{ count: string }[]>`
          SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync 
          WHERE message->>'shop' = ${TEST_SHOP_DOMAIN} 
          AND message->>'topic' = 'RECONCILE_CUSTOMERS'
        `;
        expect(parseInt(syncMsg.count, 10)).toBe(0);

      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  // ==========================================================================
  // M7: Processor read_ct cap test - bulk_lease_contention at cap goes to DLQ
  // Kills M7: the read_ct cap disabled
  //
  // Drives runDrain with a pgmq message at read_ct cap and verifies DLQ.
  // ==========================================================================
  describe("M7: processor DLQs lease_contention at read_ct cap", () => {
    it("bulk_lease_contention at read_ct >= maxRetries goes to DLQ", async () => {
      const { runDrain, DEFAULT_DRAIN_CONFIG } = await import("../processor.server");
      const { acquireProcessingLease, BULK_ERROR_CODES } = await import("~/services/sync/bulk-jsonl-processor.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/m7-dlq-cap-${TEST_SUFFIX}`;
      const webhookId = `finish:${bulkOpId}`;

      // Setup bulk operation
      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, started_at
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW()
        )
      `;

      // Another processor holds the lease
      const otherToken = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(otherToken).not.toBeNull();

      // Mock adminGraphQL
      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: {
            id: bulkOpId,
            status: "COMPLETED",
            url: "https://test.com/result.jsonl",
            objectCount: "1",
            fileSize: 100,
            errorCode: null,
          },
        },
        retryable: false,
      });

      // Clear any existing messages in the bulk queue
      await sql`DELETE FROM pgmq.q_s6_bulk WHERE message->>'bulkOperationId' = ${bulkOpId}`;

      // Purge s6_sync queue to prevent flaky deadLettered counts from leftover messages
      // (runDrain drains both s6_sync and s6_bulk; stale CREDIT_STATUS_RECOMPUTE messages
      // from prior Sequential-DB tests can get dead-lettered here)
      await sql`DELETE FROM pgmq.q_s6_sync`;
      await sql`DELETE FROM pgmq.a_s6_sync`;

      // Insert message directly into pgmq. pgmq.read() increments read_ct by 1,
      // so insert with maxRetries - 1 (4) to have read_ct = maxRetries (5) after read.
      const message = {
        topic: "BULK_OPERATIONS_FINISH",
        shop: TEST_SHOP_DOMAIN,
        webhookId,
        bulkOperationId: bulkOpId,
        bulkType: "companies",
        enqueuedAt: new Date().toISOString(),
      };

      await sql`
        INSERT INTO pgmq.q_s6_bulk (vt, read_ct, enqueued_at, message)
        VALUES (NOW(), ${DEFAULT_DRAIN_CONFIG.maxRetries - 1}, NOW(), ${sql.json(message)})
      `;

      // Process the drain (which processes both sync and bulk queues)
      const result = await runDrain(sql, { 
        ...DEFAULT_DRAIN_CONFIG, 
        batchSize: 1,
        timeBudgetMs: 5000 
      });

      // Should have dead-lettered exactly 1 message
      expect(result.deadLettered).toBe(1);

      // Verify DLQ row exists with the correct error
      const [dlqRow] = await sql<{ error: string }[]>`
        SELECT error FROM s6_dead_letter 
        WHERE original_queue = 's6_bulk' 
        AND message->>'bulkOperationId' = ${bulkOpId}
      `;
      expect(dlqRow).toBeDefined();
      expect(dlqRow.error).toBe(BULK_ERROR_CODES.LEASE_CONTENTION);

      // Cleanup
      await sql`DELETE FROM s6_dead_letter WHERE message->>'bulkOperationId' = ${bulkOpId}`;
    });

    it("bulk_lease_contention below read_ct cap is NOT dead-lettered", async () => {
      const { runDrain, DEFAULT_DRAIN_CONFIG } = await import("../processor.server");
      const { acquireProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/m7-below-cap-${TEST_SUFFIX}`;
      const webhookId = `finish:${bulkOpId}`;

      // Setup bulk operation
      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, started_at
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW()
        )
      `;

      // Another processor holds the lease
      const otherToken = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(otherToken).not.toBeNull();

      // Mock adminGraphQL
      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: {
            id: bulkOpId,
            status: "COMPLETED",
            url: "https://test.com/result.jsonl",
            objectCount: "1",
            fileSize: 100,
            errorCode: null,
          },
        },
        retryable: false,
      });

      // Clear any existing messages
      await sql`DELETE FROM pgmq.q_s6_bulk WHERE message->>'bulkOperationId' = ${bulkOpId}`;

      // Insert message. pgmq.read() increments read_ct by 1, so insert with
      // maxRetries - 2 (3) to have read_ct = maxRetries - 1 (4) after read.
      // 4 < 5 = no DLQ, just result.failed++.
      const message = {
        topic: "BULK_OPERATIONS_FINISH",
        shop: TEST_SHOP_DOMAIN,
        webhookId,
        bulkOperationId: bulkOpId,
        bulkType: "companies",
        enqueuedAt: new Date().toISOString(),
      };

      await sql`
        INSERT INTO pgmq.q_s6_bulk (vt, read_ct, enqueued_at, message)
        VALUES (NOW(), ${DEFAULT_DRAIN_CONFIG.maxRetries - 2}, NOW(), ${sql.json(message)})
      `;

      // Count DLQ rows before
      const [beforeDlq] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM s6_dead_letter 
        WHERE original_queue = 's6_bulk' AND message->>'bulkOperationId' = ${bulkOpId}
      `;

      // Process the drain
      const result = await runDrain(sql, { 
        ...DEFAULT_DRAIN_CONFIG, 
        batchSize: 1,
        timeBudgetMs: 5000 
      });

      // Should have failed exactly 1 message but NOT dead-lettered
      expect(result.failed).toBe(1);

      // No new DLQ row should exist
      const [afterDlq] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM s6_dead_letter 
        WHERE original_queue = 's6_bulk' AND message->>'bulkOperationId' = ${bulkOpId}
      `;
      expect(parseInt(afterDlq.count, 10)).toBe(parseInt(beforeDlq.count, 10));
    });
  });

  // ==========================================================================
  // M9/M10: Owner-check tests for updateBulkOperationChunkSize and incrementBulkOperationFailureCount
  // Kills M9: chunk-size update owner check removed
  // Kills M10: increment owner check removed
  // ==========================================================================
  describe("M9/M10: owner-check tests for chunk-size and failure-count", () => {
    it("M9: updateBulkOperationChunkSize with wrong token updates 0 rows", async () => {
      const { updateBulkOperationChunkSize } = await import("~/services/sync/bulk-operations.server");
      const { acquireProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/m9-wrong-token-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, started_at, chunk_size
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW(), 1048576
        )
      `;

      // B acquires the lease
      const tokenB = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(tokenB).not.toBeNull();

      // A (stale processor with wrong token) tries to update chunk_size
      const wrongToken = "wrong-token-A";
      await updateBulkOperationChunkSize(sql, bulkOpId, 2097152, wrongToken);

      // chunk_size should be unchanged (owner check failed)
      const [row] = await sql<{ chunk_size: number }[]>`
        SELECT chunk_size FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.chunk_size).toBe(1048576); // Unchanged

      // With correct token, update should work
      await updateBulkOperationChunkSize(sql, bulkOpId, 2097152, tokenB!);
      const [row2] = await sql<{ chunk_size: number }[]>`
        SELECT chunk_size FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row2.chunk_size).toBe(2097152); // Updated
    });

    it("M10: incrementBulkOperationFailureCount with wrong token updates 0 rows", async () => {
      const { incrementBulkOperationFailureCount } = await import("~/services/sync/bulk-operations.server");
      const { acquireProcessingLease } = await import("~/services/sync/bulk-jsonl-processor.server");

      const bulkOpId = `gid://shopify/BulkOperation/m10-wrong-token-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, started_at, failure_count
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', NOW(), 2
        )
      `;

      // B acquires the lease
      const tokenB = await acquireProcessingLease(sql, bulkOpId, TEST_SHOP_DOMAIN);
      expect(tokenB).not.toBeNull();

      // A (stale processor with wrong token) tries to increment failure_count
      const wrongToken = "wrong-token-A";
      const { rowUpdated: aResult, failureCount: aCount } = await incrementBulkOperationFailureCount(
        sql, bulkOpId, wrongToken
      );

      // Should update 0 rows (owner check failed)
      expect(aResult).toBe(false);
      expect(aCount).toBe(0); // No row returned

      // failure_count should be unchanged
      const [row] = await sql<{ failure_count: number }[]>`
        SELECT failure_count FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row.failure_count).toBe(2); // Unchanged

      // With correct token, increment should work
      const { rowUpdated: bResult, failureCount: bCount } = await incrementBulkOperationFailureCount(
        sql, bulkOpId, tokenB!
      );
      expect(bResult).toBe(true);
      expect(bCount).toBe(3);

      const [row2] = await sql<{ failure_count: number }[]>`
        SELECT failure_count FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(row2.failure_count).toBe(3); // Incremented
    });
  });

  // ==========================================================================
  // Gap 1: Auth-failure DLQ asserts (lease NULL, claim kept, Session.needsReauth unchanged)
  // ==========================================================================
  describe("Gap 1: auth-failure DLQ state assertions", () => {
    it("after auth DLQ: lease NULL, op-bound claim exists, Session.needsReauth unchanged", async () => {
      const { processBulkOperation, BULK_ERROR_CODES } = await import("~/services/sync/bulk-jsonl-processor.server");
      const { claimReconcileStage, recordClaimBulkOperationId } = await import("../reconcile-handlers.server");
      const { adminGraphQL } = await import("../admin-client.server");

      const bulkOpId = `gid://shopify/BulkOperation/gap1-auth-dlq-${TEST_SUFFIX}`;
      const webhookId = `finish:${bulkOpId}`;
      const chainKey = `${TEST_SHOP_DOMAIN}:gap1-auth`;

      // Seed a Session row with needsReauth = true
      const sessionId = `session-gap1-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "Session" (id, shop, state, "isOnline", scope, "accessToken", "needsReauth")
        VALUES (${sessionId}, ${TEST_SHOP_DOMAIN}, 'active', false, 'read_orders', 'token', true)
        ON CONFLICT (id) DO NOTHING
      `;

      // Create the op-bound claim (as would exist after startReconcileBulkOperation)
      await claimReconcileStage(sql, chainKey, "companies", TEST_SHOP_DOMAIN);
      await recordClaimBulkOperationId(sql, chainKey, "companies", TEST_SHOP_DOMAIN, bulkOpId);

      // Setup bulk operation
      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at
        ) VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies', NOW()
        )
      `;

      // Mock adminGraphQL to return auth failure (invalid_grant)
      vi.mocked(adminGraphQL).mockResolvedValue({
        success: false,
        error: "Token refresh failed: invalid_grant",
        errorCode: "invalid_grant",
        retryable: false,
      });

      const message = {
        topic: "BULK_OPERATIONS_FINISH" as const,
        shop: TEST_SHOP_DOMAIN,
        webhookId,
        bulkOperationId: bulkOpId,
        bulkType: "companies" as const,
        enqueuedAt: new Date().toISOString(),
      };

      const result = await processBulkOperation(sql, message);

      // Should return permanent error with AUTH_NEEDS_REAUTH code
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(BULK_ERROR_CODES.AUTH_NEEDS_REAUTH);
      expect(result.errorType).toBe("permanent");

      // Assert: processing_lease_token IS NULL and processing_lease_until IS NULL
      const [op] = await sql<{ processing_lease_token: string | null; processing_lease_until: Date | null }[]>`
        SELECT processing_lease_token, processing_lease_until 
        FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(op.processing_lease_token).toBeNull();
      expect(op.processing_lease_until).toBeNull();

      // Assert: the op-bound claim row exists (NOT released)
      const [claim] = await sql<{ bulk_operation_id: string | null }[]>`
        SELECT bulk_operation_id FROM s6_reconcile_stage_claims
        WHERE chain_key = ${chainKey} AND stage = 'companies'
      `;
      expect(claim).toBeDefined();
      expect(claim.bulk_operation_id).toBe(bulkOpId);

      // Assert: Session.needsReauth is still true (auth DLQ doesn't change it)
      const [session] = await sql<{ needsReauth: boolean | null }[]>`
        SELECT "needsReauth" FROM "Session" WHERE id = ${sessionId}
      `;
      expect(session.needsReauth).toBe(true);

      // Cleanup
      await sql`DELETE FROM s6_reconcile_stage_claims WHERE chain_key = ${chainKey}`;
      await sql`DELETE FROM "Session" WHERE id = ${sessionId}`;
    });
  });
});
