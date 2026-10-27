/**
 * DB-backed integration tests for initial-sync.server.ts (S23-04).
 *
 * Tests verify that getInitialSyncState correctly queries s6_bulk_operations
 * using the real column name (bulk_operation_id) and returns the expected
 * sync status.
 *
 * Bug fix: #209 introduced a typo selecting nonexistent column `bulk_op_id` instead of `bulk_operation_id`.
 * These tests verify the fix by running against the actual migrated schema.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("getInitialSyncState (DB-backed)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-initsync";
  const TEST_SHOP_DOMAIN = `test-initsync-${TEST_SUFFIX}.myshopify.com`;
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
  });

  describe("column name fix validation", () => {
    it("queries s6_bulk_operations using bulk_operation_id column successfully", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/test-col-${TEST_SUFFIX}`;

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

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(sql, TEST_SHOP_DOMAIN);

      expect(result.status).toBe("in_progress");
    });
  });

  describe("status: not_started", () => {
    it("returns not_started when no bulk operations exist for the shop", async () => {
      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(sql, TEST_SHOP_DOMAIN);

      expect(result.status).toBe("not_started");
    });

    it("returns not_started when only non-reconcile operations exist", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/webhook-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, failure_count
        )
        VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'webhook', NULL,
          NOW(), 0
        )
      `;

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(sql, TEST_SHOP_DOMAIN);

      expect(result.status).toBe("not_started");
    });
  });

  describe("status: in_progress", () => {
    it("returns in_progress when companies op exists but not completed", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/companies-incomplete-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, completed_at, failure_count
        )
        VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies',
          NOW(), NULL, 0
        )
      `;

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(sql, TEST_SHOP_DOMAIN);

      expect(result.status).toBe("in_progress");
    });

    it("returns in_progress when companies completed but no orders op yet", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/companies-done-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, completed_at, failure_count
        )
        VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies',
          NOW(), NOW(), 0
        )
      `;

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(sql, TEST_SHOP_DOMAIN);

      expect(result.status).toBe("in_progress");
    });

    it("returns in_progress when companies done and orders started but not completed", async () => {
      const companiesOpId = `gid://shopify/BulkOperation/companies-done2-${TEST_SUFFIX}`;
      const ordersOpId = `gid://shopify/BulkOperation/orders-started-${TEST_SUFFIX}`;
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
           ${startTime}, NULL, 0)
      `;

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(sql, TEST_SHOP_DOMAIN);

      expect(result.status).toBe("in_progress");
    });
  });

  describe("status: done", () => {
    it("returns done when both companies and orders are completed", async () => {
      const companiesOpId = `gid://shopify/BulkOperation/companies-complete-${TEST_SUFFIX}`;
      const ordersOpId = `gid://shopify/BulkOperation/orders-complete-${TEST_SUFFIX}`;
      const startTime = new Date();
      const completeTime = new Date(startTime.getTime() + 60000);

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, completed_at, failure_count
        )
        VALUES
          (${companiesOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies',
           ${startTime}, ${completeTime}, 0),
          (${ordersOpId}, ${TEST_SHOP_DOMAIN}, 'orders', 'reconcile', 'orders',
           ${startTime}, ${completeTime}, 0)
      `;

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(sql, TEST_SHOP_DOMAIN);

      expect(result.status).toBe("done");
    });
  });

  describe("status: failed", () => {
    it("returns failed when companies failure_count >= 5", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/companies-failed-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, completed_at, failure_count
        )
        VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies',
          NOW(), NULL, 5
        )
      `;

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(sql, TEST_SHOP_DOMAIN);

      expect(result.status).toBe("failed");
    });

    it("returns failed when orders failure_count >= 5", async () => {
      const companiesOpId = `gid://shopify/BulkOperation/companies-ok-${TEST_SUFFIX}`;
      const ordersOpId = `gid://shopify/BulkOperation/orders-failed-${TEST_SUFFIX}`;
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
           ${startTime}, NULL, 5)
      `;

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(sql, TEST_SHOP_DOMAIN);

      expect(result.status).toBe("failed");
    });

    it("returns failed when DLQ entries exist for the current run bulk_operation_id", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/companies-dlq-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, completed_at, failure_count
        )
        VALUES (
          ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies',
          NOW(), NULL, 0
        )
      `;

      await sql`
        INSERT INTO s6_dead_letter (original_queue, original_msg_id, message, error)
        VALUES (
          's6_sync',
          'msg-dlq-test',
          ${sql.json({
            shop: TEST_SHOP_DOMAIN,
            topic: "RECONCILE_COMPANIES",
            bulkOperationId: bulkOpId,
          })},
          'test error'
        )
      `;

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(sql, TEST_SHOP_DOMAIN);

      expect(result.status).toBe("failed");
    });
  });

  describe("latest run selection", () => {
    it("uses the latest companies op when multiple exist", async () => {
      const oldCompaniesOpId = `gid://shopify/BulkOperation/old-companies-${TEST_SUFFIX}`;
      const newCompaniesOpId = `gid://shopify/BulkOperation/new-companies-${TEST_SUFFIX}`;
      const oldStart = new Date("2026-10-01T00:00:00Z");
      const newStart = new Date("2026-10-02T00:00:00Z");

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, completed_at, failure_count
        )
        VALUES
          (${oldCompaniesOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies',
           ${oldStart}, NULL, 5),
          (${newCompaniesOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies',
           ${newStart}, ${newStart}, 0)
      `;

      const newOrdersOpId = `gid://shopify/BulkOperation/new-orders-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, completed_at, failure_count
        )
        VALUES (
          ${newOrdersOpId}, ${TEST_SHOP_DOMAIN}, 'orders', 'reconcile', 'orders',
          ${newStart}, ${newStart}, 0
        )
      `;

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(sql, TEST_SHOP_DOMAIN);

      expect(result.status).toBe("done");
    });

    it("ignores orders ops that started before the latest companies op", async () => {
      const companiesOpId = `gid://shopify/BulkOperation/new-run-companies-${TEST_SUFFIX}`;
      const oldOrdersOpId = `gid://shopify/BulkOperation/old-run-orders-${TEST_SUFFIX}`;
      const oldStart = new Date("2026-10-01T00:00:00Z");
      const newStart = new Date("2026-10-02T00:00:00Z");

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, completed_at, failure_count
        )
        VALUES
          (${oldOrdersOpId}, ${TEST_SHOP_DOMAIN}, 'orders', 'reconcile', 'orders',
           ${oldStart}, ${oldStart}, 0),
          (${companiesOpId}, ${TEST_SHOP_DOMAIN}, 'companies', 'reconcile', 'companies',
           ${newStart}, ${newStart}, 0)
      `;

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(sql, TEST_SHOP_DOMAIN);

      expect(result.status).toBe("in_progress");
    });
  });
});

describeWithDb("Sequential DB: Initial Sync currency scenarios", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-currsync";
  const TEST_USD_SHOP = `test-usd-${TEST_SUFFIX}.myshopify.com`;
  const TEST_INR_SHOP = `test-inr-${TEST_SUFFIX}.myshopify.com`;
  let usdShopId: string;
  let inrShopId: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    const [usdShop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
      VALUES (${TEST_USD_SHOP}, 'America/New_York', 'USD', 'starter', NOW(), NOW())
      RETURNING id
    `;
    usdShopId = usdShop.id;

    const [inrShop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
      VALUES (${TEST_INR_SHOP}, 'Asia/Kolkata', 'INR', 'starter', NOW(), NOW())
      RETURNING id
    `;
    inrShopId = inrShop.id;
  });

  afterAll(async () => {
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' IN (${TEST_USD_SHOP}, ${TEST_INR_SHOP})`;
    await sql`DELETE FROM s6_bulk_operations WHERE shop IN (${TEST_USD_SHOP}, ${TEST_INR_SHOP})`;
    await sql`DELETE FROM "Shop" WHERE id IN (${usdShopId}, ${inrShopId})`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' IN (${TEST_USD_SHOP}, ${TEST_INR_SHOP})`;
    await sql`DELETE FROM s6_bulk_operations WHERE shop IN (${TEST_USD_SHOP}, ${TEST_INR_SHOP})`;
  });

  describe("(a) USD shop with no ops", () => {
    it("returns not_started for USD shop with no bulk operations", async () => {
      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(sql, TEST_USD_SHOP);

      expect(result.status).toBe("not_started");
    });

    it("isShopCurrencySupported returns false for USD", async () => {
      const { isShopCurrencySupported } = await import("../shop-currency.server");
      expect(isShopCurrencySupported("USD")).toBe(false);
    });
  });

  describe("(b) INR-to-USD flip: USD shop with open companies op", () => {
    it("getInitialSyncState returns in_progress for USD shop with open companies op", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/usd-open-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, completed_at, failure_count
        )
        VALUES (
          ${bulkOpId}, ${TEST_USD_SHOP}, 'companies', 'reconcile', 'companies',
          NOW(), NULL, 0
        )
      `;

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(sql, TEST_USD_SHOP);

      expect(result.status).toBe("in_progress");
    });

    it("enqueueInitialSync returns unsupported_currency for USD shop", async () => {
      const { enqueueInitialSync } = await import("../initial-sync.server");
      const result = await enqueueInitialSync(sql, TEST_USD_SHOP);

      expect(result.enqueued).toBe(false);
      expect(result.reason).toBe("unsupported_currency");
    });
  });

  describe("(c) INR shop with open op", () => {
    it("getInitialSyncState returns in_progress for INR shop with open companies op", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/inr-open-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, completed_at, failure_count
        )
        VALUES (
          ${bulkOpId}, ${TEST_INR_SHOP}, 'companies', 'reconcile', 'companies',
          NOW(), NULL, 0
        )
      `;

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(sql, TEST_INR_SHOP);

      expect(result.status).toBe("in_progress");
    });

    it("isShopCurrencySupported returns true for INR", async () => {
      const { isShopCurrencySupported } = await import("../shop-currency.server");
      expect(isShopCurrencySupported("INR")).toBe(true);
    });

    it("enqueueInitialSync returns in_progress for INR shop with existing open op", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/inr-enqueue-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, origin, reconcile_stage,
          started_at, completed_at, failure_count
        )
        VALUES (
          ${bulkOpId}, ${TEST_INR_SHOP}, 'companies', 'reconcile', 'companies',
          NOW(), NULL, 0
        )
      `;

      const { enqueueInitialSync } = await import("../initial-sync.server");
      const result = await enqueueInitialSync(sql, TEST_INR_SHOP);

      expect(result.enqueued).toBe(false);
      expect(result.reason).toBe("in_progress");
    });
  });
});
