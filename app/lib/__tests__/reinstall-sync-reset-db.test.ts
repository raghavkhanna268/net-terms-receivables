/**
 * DB-backed integration tests for #293 reinstall sync reset.
 *
 * Tests verify that reinstall (after uninstall) closes all open bulk operations
 * and allows the merchant to start a fresh sync.
 *
 * Test cases:
 * 1. Open companies op -> reinstall -> closed, state=not_started
 * 2. Done run -> reinstall -> closed, state=not_started
 * 3. Idempotent: second call closes 0 rows
 * 4. Re-auth without uninstall: rows untouched, state preserved
 * 5. Race: reset vs concurrent finish/drain write
 * 6. resetBulkOperationFailureCount on closed row is no-op
 * 7. enqueueReconcileStage with closed prev op returns false
 * 8. New run after reset is not closed
 * 9. upsertShopOnAuth fallback also resets
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("reinstall sync reset (DB-backed)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-reinstallreset";
  const TEST_SHOP_DOMAIN = `test-reinstall-${TEST_SUFFIX}.myshopify.com`;
  let testShopId: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'America/New_York', 'INR', 'starter', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;
  });

  afterAll(async () => {
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_bulk_operations WHERE shop = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_bulk_operations WHERE shop = ${TEST_SHOP_DOMAIN}`;
    await sql`UPDATE "Shop" SET "uninstalledAt" = NULL WHERE id = ${testShopId}`;
  });

  describe("reinstall closes open bulk operations", () => {
    it("closes open companies op and state becomes not_started", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/open-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, failure_count
        )
        VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies',
          NOW(), 0
        )
      `;

      await sql`UPDATE "Shop" SET "uninstalledAt" = NOW() WHERE id = ${testShopId}`;

      const { _clearUninstalledAtAndMetafieldErrorsForTesting } =
        await import("../after-auth.server");
      const result = await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, TEST_SHOP_DOMAIN);
      expect(result.wasReinstalled).toBe(true);

      const [op] = await sql<{ closed_at: Date | null; closed_reason: string | null }[]>`
        SELECT closed_at, closed_reason FROM s6_bulk_operations
        WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(op.closed_at).not.toBeNull();
      expect(op.closed_reason).toBe("reinstall_reset");

      const { getInitialSyncState } = await import("../initial-sync.server");
      const state = await getInitialSyncState(sql, TEST_SHOP_DOMAIN);
      expect(state.status).toBe("not_started");
    });

    it("closes done run and state becomes not_started", async () => {
      const companiesOpId = `gid://shopify/BulkOperation/done-companies-${TEST_SUFFIX}`;
      const ordersOpId = `gid://shopify/BulkOperation/done-orders-${TEST_SUFFIX}`;
      const startTime = new Date();

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, completed_at, failure_count
        )
        VALUES
          (${companiesOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies',
           ${startTime}, ${startTime}, 0),
          (${ordersOpId}, ${TEST_SHOP_DOMAIN}, 'orders', 'reconcile', 'orders',
           ${startTime}, ${startTime}, 0)
      `;

      const { getInitialSyncState } = await import("../initial-sync.server");
      const beforeState = await getInitialSyncState(sql, TEST_SHOP_DOMAIN);
      expect(beforeState.status).toBe("done");

      await sql`UPDATE "Shop" SET "uninstalledAt" = NOW() WHERE id = ${testShopId}`;

      const { _clearUninstalledAtAndMetafieldErrorsForTesting } =
        await import("../after-auth.server");
      await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, TEST_SHOP_DOMAIN);

      const afterState = await getInitialSyncState(sql, TEST_SHOP_DOMAIN);
      expect(afterState.status).toBe("not_started");

      const ops = await sql<{ closed_reason: string | null }[]>`
        SELECT closed_reason FROM s6_bulk_operations
        WHERE shop = ${TEST_SHOP_DOMAIN}
      `;
      expect(ops).toHaveLength(2);
      for (const op of ops) {
        expect(op.closed_reason).toBe("reinstall_reset");
      }
    });
  });

  describe("idempotency", () => {
    it("second call closes 0 rows and leaves closed_at unchanged", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/idempotent-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, failure_count
        )
        VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies',
          NOW(), 0
        )
      `;

      await sql`UPDATE "Shop" SET "uninstalledAt" = NOW() WHERE id = ${testShopId}`;

      const { _clearUninstalledAtAndMetafieldErrorsForTesting } =
        await import("../after-auth.server");

      const firstResult = await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, TEST_SHOP_DOMAIN);
      expect(firstResult.wasReinstalled).toBe(true);

      const [firstOp] = await sql<{ closed_at: Date }[]>`
        SELECT closed_at FROM s6_bulk_operations
        WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(firstOp.closed_at).not.toBeNull();
      const firstClosedAt = firstOp.closed_at;

      await sql`UPDATE "Shop" SET "uninstalledAt" = NOW() WHERE id = ${testShopId}`;

      const secondResult = await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, TEST_SHOP_DOMAIN);
      expect(secondResult.wasReinstalled).toBe(true);

      const [secondOp] = await sql<{ closed_at: Date }[]>`
        SELECT closed_at FROM s6_bulk_operations
        WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(secondOp.closed_at.getTime()).toBe(firstClosedAt.getTime());
    });
  });

  describe("re-auth without uninstall", () => {
    it("rows untouched and state preserved", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/reauth-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, failure_count
        )
        VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies',
          NOW(), 0
        )
      `;

      const { _clearUninstalledAtAndMetafieldErrorsForTesting } =
        await import("../after-auth.server");
      const result = await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, TEST_SHOP_DOMAIN);
      expect(result.wasReinstalled).toBe(false);

      const [op] = await sql<{ closed_at: Date | null }[]>`
        SELECT closed_at FROM s6_bulk_operations
        WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(op.closed_at).toBeNull();

      const { getInitialSyncState } = await import("../initial-sync.server");
      const state = await getInitialSyncState(sql, TEST_SHOP_DOMAIN);
      expect(state.status).toBe("in_progress");
    });
  });

  describe("race: reset vs concurrent finish/drain write", () => {
    it("concurrent saveBulkOperationProgress updates 0 rows after reset", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/race-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, failure_count
        )
        VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies',
          NOW(), 0
        )
      `;

      await sql`UPDATE "Shop" SET "uninstalledAt" = NOW() WHERE id = ${testShopId}`;

      const sql2 = postgres(TEST_DATABASE_URL!, sqlOptions);

      try {
        const { _clearUninstalledAtAndMetafieldErrorsForTesting } =
          await import("../after-auth.server");
        await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, TEST_SHOP_DOMAIN);

        const { saveBulkOperationProgress } = await import(
          "~/services/sync/bulk-jsonl-processor.server"
        );
        const { rowUpdated } = await saveBulkOperationProgress(
          sql2,
          bulkOpId,
          1000,
          new Date()
        );
        expect(rowUpdated).toBe(false);

        const [op] = await sql<{ closed_at: Date | null; completed_at: Date | null }[]>`
          SELECT closed_at, completed_at FROM s6_bulk_operations
          WHERE bulk_operation_id = ${bulkOpId}
        `;
        expect(op.closed_at).not.toBeNull();
        expect(op.completed_at).toBeNull();
      } finally {
        await sql2.end();
      }
    });
  });

  describe("resetBulkOperationFailureCount on closed row", () => {
    it("is a no-op", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/reset-fail-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, failure_count, closed_at, closed_reason
        )
        VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies',
          NOW(), 3, NOW(), 'reinstall_reset'
        )
      `;

      const { resetBulkOperationFailureCount } = await import(
        "~/services/sync/bulk-operations.server"
      );
      await resetBulkOperationFailureCount(sql, bulkOpId);

      const [op] = await sql<{ failure_count: number }[]>`
        SELECT failure_count FROM s6_bulk_operations
        WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(op.failure_count).toBe(3);
    });
  });

  describe("enqueueReconcileStage with closed prev op", () => {
    it("returns false", async () => {
      const prevOpId = `gid://shopify/BulkOperation/prev-closed-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, completed_at, failure_count, closed_at, closed_reason
        )
        VALUES (
          ${prevOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies',
          NOW(), NOW(), 0, NOW(), 'reinstall_reset'
        )
      `;

      const { enqueueReconcileStage } = await import(
        "~/services/drain/reconcile-handlers.server"
      );
      const result = await enqueueReconcileStage(
        sql,
        TEST_SHOP_DOMAIN,
        "customers",
        undefined,
        prevOpId
      );
      expect(result).toBe(false);

      const [msg] = await sql<{ msg_id: string }[]>`
        SELECT msg_id::text FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'topic' = 'RECONCILE_CUSTOMERS'
        LIMIT 1
      `;
      expect(msg).toBeUndefined();
    });
  });

  describe("new run after reset", () => {
    it("is not closed and drives the state", async () => {
      const oldOpId = `gid://shopify/BulkOperation/old-closed-${TEST_SUFFIX}`;
      const newOpId = `gid://shopify/BulkOperation/new-open-${TEST_SUFFIX}`;
      const oldStart = new Date("2026-10-01T00:00:00Z");
      const newStart = new Date("2026-10-02T00:00:00Z");

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, failure_count, closed_at, closed_reason
        )
        VALUES (
          ${oldOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies',
          ${oldStart}, 0, NOW(), 'reinstall_reset'
        )
      `;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, failure_count
        )
        VALUES (
          ${newOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies',
          ${newStart}, 0
        )
      `;

      const { getInitialSyncState } = await import("../initial-sync.server");
      const state = await getInitialSyncState(sql, TEST_SHOP_DOMAIN);
      expect(state.status).toBe("in_progress");

      const [newOp] = await sql<{ closed_at: Date | null }[]>`
        SELECT closed_at FROM s6_bulk_operations
        WHERE bulk_operation_id = ${newOpId}
      `;
      expect(newOp.closed_at).toBeNull();
    });
  });

  describe("upsertShopOnAuth fallback", () => {
    it("also closes bulk operations on reinstall", async () => {
      const TEST_SHOP_2 = `test-upsert-reinstall-${TEST_SUFFIX}.myshopify.com`;
      const bulkOpId = `gid://shopify/BulkOperation/upsert-${TEST_SUFFIX}`;

      const [{ id: shopId2 }] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "uninstalledAt", "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_2}, 'America/New_York', 'INR', 'starter', NOW(), NOW(), NOW())
        RETURNING id
      `;

      try {
        await sql`
          INSERT INTO s6_bulk_operations (
            bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
            started_at, failure_count
          )
          VALUES (
            ${bulkOpId}, ${TEST_SHOP_2}, 'companies', 'reconcile', 'companies',
            NOW(), 0
          )
        `;

        const { upsertShopOnAuth } = await import("../after-auth.server");
        await upsertShopOnAuth(sql, TEST_SHOP_2, "America/New_York", "INR");

        const [op] = await sql<{ closed_at: Date | null; closed_reason: string | null }[]>`
          SELECT closed_at, closed_reason FROM s6_bulk_operations
          WHERE bulk_operation_id = ${bulkOpId}
        `;
        expect(op.closed_at).not.toBeNull();
        expect(op.closed_reason).toBe("reinstall_reset");

        const [shop] = await sql<{ uninstalledAt: Date | null }[]>`
          SELECT "uninstalledAt" FROM "Shop" WHERE id = ${shopId2}
        `;
        expect(shop.uninstalledAt).toBeNull();
      } finally {
        await sql`DELETE FROM s6_bulk_operations WHERE shop = ${TEST_SHOP_2}`;
        await sql`DELETE FROM "Shop" WHERE id = ${shopId2}`;
      }
    });
  });

  describe("closes all origins", () => {
    it("closes reconcile, manual, and webhook origin ops", async () => {
      const reconcileOpId = `gid://shopify/BulkOperation/reconcile-${TEST_SUFFIX}`;
      const manualOpId = `gid://shopify/BulkOperation/manual-${TEST_SUFFIX}`;
      const webhookOpId = `gid://shopify/BulkOperation/webhook-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, failure_count
        )
        VALUES
          (${reconcileOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies', NOW(), 0),
          (${manualOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'manual', NULL, NOW(), 0),
          (${webhookOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NULL, NOW(), 0)
      `;

      await sql`UPDATE "Shop" SET "uninstalledAt" = NOW() WHERE id = ${testShopId}`;

      const { _clearUninstalledAtAndMetafieldErrorsForTesting } =
        await import("../after-auth.server");
      await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, TEST_SHOP_DOMAIN);

      const ops = await sql<{ bulk_operation_id: string; closed_reason: string | null }[]>`
        SELECT bulk_operation_id, closed_reason FROM s6_bulk_operations
        WHERE shop = ${TEST_SHOP_DOMAIN}
      `;
      expect(ops).toHaveLength(3);
      for (const op of ops) {
        expect(op.closed_reason).toBe("reinstall_reset");
      }
    });
  });
});
