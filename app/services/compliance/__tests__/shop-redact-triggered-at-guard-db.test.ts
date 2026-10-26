/**
 * DB-backed integration test for shop/redact triggeredAt-based reinstall guard.
 *
 * Hardens the GDPR shop/redact handler against redacting a shop that was
 * reinstalled between the original uninstall and the shop/redact webhook arrival.
 *
 * Shopify sends X-Shopify-Triggered-At with the timestamp of when the webhook
 * was originally triggered (the uninstall time). If Shop.uninstalledAt is newer
 * than triggeredAt - 47h, the shop was reinstalled after the uninstall that
 * triggered this webhook, so we skip deletion.
 *
 * Test scenarios:
 * 1. NULL uninstalledAt skips (existing behaviour, keep passing)
 * 2. uninstalledAt about 48h before triggeredAt (matching uninstall): deletes
 * 3. uninstalledAt newer than triggeredAt - 47h (reinstalled): skips
 * 4. Header missing or unparsable: current behaviour (deletes when uninstalledAt is set and old)
 * 5. FOR UPDATE lock race: concurrent transaction updates uninstalledAt, deleteShop sees post-lock value
 *
 * NOTE: This test requires a running PostgreSQL instance with pgmq extension.
 * Run in the "Sequential DB" vitest project via DB_TEST_PATTERNS in vitest.config.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { deleteShop } from "../compliance.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("shop/redact triggeredAt guard", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-trigat-guard";

  const allShopIds: string[] = [];
  const allShopDomains: string[] = [];

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    if (allShopIds.length > 0) {
      await sql`DELETE FROM "Match" WHERE "shopId" IN ${sql(allShopIds)}`;
      await sql`DELETE FROM "ReminderLog" WHERE "shopId" IN ${sql(allShopIds)}`;
      await sql`DELETE FROM rejected_matches WHERE "shopId" IN ${sql(allShopIds)}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" IN ${sql(allShopIds)}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" IN ${sql(allShopIds)}`;
      await sql`DELETE FROM "ReminderRule" WHERE "shopId" IN ${sql(allShopIds)}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" IN ${sql(allShopIds)}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" IN (SELECT id FROM "BuyerAccount" WHERE "shopId" IN ${sql(allShopIds)})`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN ${sql(allShopIds)}`;
      await sql`DELETE FROM "AccountSource" WHERE "shopId" IN ${sql(allShopIds)}`;
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" IN ${sql(allShopIds)}`;
      await sql`DELETE FROM s8_tagged_customers WHERE shop_id IN ${sql(allShopIds)}`;
      await sql`DELETE FROM s8_draft_orders WHERE shop_id IN ${sql(allShopIds)}`;
      await sql`DELETE FROM s22_data_requests WHERE shop_id IN ${sql(allShopIds)}`;
      await sql`DELETE FROM backstop_processed_orders WHERE shop_id IN ${sql(allShopIds)}`;
      await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id IN ${sql(allShopIds)}`;
    }
    if (allShopDomains.length > 0) {
      await sql`DELETE FROM webhook_receipts WHERE shop IN ${sql(allShopDomains)}`;
      await sql`DELETE FROM s10b_order_refetch_null WHERE shop IN ${sql(allShopDomains)}`;
      await sql`DELETE FROM s6_bulk_operations WHERE shop IN ${sql(allShopDomains)}`;
      await sql`DELETE FROM s6_reconcile_stage_claims WHERE shop IN ${sql(allShopDomains)}`;
      await sql`DELETE FROM order_outstanding_missing WHERE shop IN ${sql(allShopDomains)}`;
      await sql`DELETE FROM s10b_customer_pii_fallback WHERE shop IN ${sql(allShopDomains)}`;
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sql(allShopDomains)}`;
      await sql`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' IN ${sql(allShopDomains)}`;
      await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sql(allShopDomains)}`;
      await sql`DELETE FROM pgmq.a_s6_bulk WHERE message->>'shop' IN ${sql(allShopDomains)}`;
      await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' IN ${sql(allShopDomains)}`;
      await sql`DELETE FROM "Session" WHERE shop IN ${sql(allShopDomains)}`;
    }
    if (allShopIds.length > 0) {
      await sql`DELETE FROM "Shop" WHERE id IN ${sql(allShopIds)}`;
    }
    await sql.end();
  });

  async function seedShop(
    shopId: string,
    shopDomain: string,
    uninstalledAt: Date | null
  ): Promise<void> {
    allShopIds.push(shopId);
    allShopDomains.push(shopDomain);

    const now = new Date();
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
      VALUES (${shopId}, ${shopDomain}, 'INR', ${now}, ${now}, ${uninstalledAt})
    `;
    await sql`
      INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
      VALUES (${"offline_" + shopDomain}, ${shopDomain}, 'test-state', false, 'test-token')
    `;
  }

  async function getShopExists(shopId: string): Promise<boolean> {
    const [row] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM "Shop" WHERE id = ${shopId}
    `;
    return parseInt(row.count, 10) > 0;
  }

  describe("1. NULL uninstalledAt skips (existing behaviour)", () => {
    const SHOP_ID = `shop-null-uninst-${TEST_SUFFIX}`;
    const SHOP_DOMAIN = `test-null-uninst-${TEST_SUFFIX}.myshopify.com`;

    // REVERT NOTE: This test passes with or without the triggeredAt guard change.
    it("skips deletion when uninstalledAt is NULL, regardless of triggeredAt", async () => {
      await seedShop(SHOP_ID, SHOP_DOMAIN, null);

      const triggeredAt = new Date();
      const result = await deleteShop(sql, SHOP_DOMAIN, triggeredAt);

      expect(result.deleted).toBe(false);
      expect(result.skippedReinstalled).toBe(true);
      expect(result.shopId).toBe(SHOP_ID);
      expect(await getShopExists(SHOP_ID)).toBe(true);
    });
  });

  describe("2. uninstalledAt ~48h before triggeredAt (matching uninstall): deletes", () => {
    const SHOP_ID = `shop-48h-${TEST_SUFFIX}`;
    const SHOP_DOMAIN = `test-48h-${TEST_SUFFIX}.myshopify.com`;

    // REVERT NOTE: This test passes with or without the triggeredAt guard change.
    it("deletes when uninstalledAt is ~48h before triggeredAt", async () => {
      const triggeredAt = new Date();
      const uninstalledAt = new Date(triggeredAt.getTime() - 48 * 60 * 60 * 1000);
      await seedShop(SHOP_ID, SHOP_DOMAIN, uninstalledAt);

      const result = await deleteShop(sql, SHOP_DOMAIN, triggeredAt);

      expect(result.deleted).toBe(true);
      expect(result.skippedReinstalled).toBe(false);
      expect(result.shopId).toBe(SHOP_ID);
      expect(await getShopExists(SHOP_ID)).toBe(false);
    });
  });

  describe("3. uninstalledAt newer than triggeredAt - 47h (reinstalled): skips", () => {
    const SHOP_ID = `shop-reinstalled-${TEST_SUFFIX}`;
    const SHOP_DOMAIN = `test-reinstalled-${TEST_SUFFIX}.myshopify.com`;

    // REVERT NOTE: This test FAILS if the triggeredAt guard is reverted.
    // Without the guard, this would incorrectly delete a reinstalled shop.
    it("skips deletion when uninstalledAt is newer than triggeredAt - 47h", async () => {
      const triggeredAt = new Date();
      const uninstalledAt = new Date(triggeredAt.getTime() - 46 * 60 * 60 * 1000);
      await seedShop(SHOP_ID, SHOP_DOMAIN, uninstalledAt);

      const result = await deleteShop(sql, SHOP_DOMAIN, triggeredAt);

      expect(result.deleted).toBe(false);
      expect(result.skippedReinstalled).toBe(true);
      expect(result.shopId).toBe(SHOP_ID);
      expect(await getShopExists(SHOP_ID)).toBe(true);
    });
  });

  describe("4. Header missing or unparsable: current behaviour", () => {
    const SHOP_ID_MISSING = `shop-hdr-missing-${TEST_SUFFIX}`;
    const SHOP_DOMAIN_MISSING = `test-hdr-missing-${TEST_SUFFIX}.myshopify.com`;
    const SHOP_ID_NULL = `shop-hdr-null-${TEST_SUFFIX}`;
    const SHOP_DOMAIN_NULL = `test-hdr-null-${TEST_SUFFIX}.myshopify.com`;

    // REVERT NOTE: These tests pass with or without the triggeredAt guard change.
    it("deletes when triggeredAt is undefined and uninstalledAt is set", async () => {
      const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await seedShop(SHOP_ID_MISSING, SHOP_DOMAIN_MISSING, uninstalledAt);

      const result = await deleteShop(sql, SHOP_DOMAIN_MISSING, undefined);

      expect(result.deleted).toBe(true);
      expect(result.skippedReinstalled).toBe(false);
    });

    it("deletes when triggeredAt is null and uninstalledAt is set", async () => {
      const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await seedShop(SHOP_ID_NULL, SHOP_DOMAIN_NULL, uninstalledAt);

      const result = await deleteShop(sql, SHOP_DOMAIN_NULL, null);

      expect(result.deleted).toBe(true);
      expect(result.skippedReinstalled).toBe(false);
    });
  });

  describe("5. FOR UPDATE lock race: concurrent transaction updates uninstalledAt", () => {
    const SHOP_ID = `shop-race-trigat-${TEST_SUFFIX}`;
    const SHOP_DOMAIN = `test-race-trigat-${TEST_SUFFIX}.myshopify.com`;

    // REVERT NOTE: This test FAILS if the triggeredAt guard is reverted.
    // The race condition would not be detected without the triggeredAt check.
    it("deleteShop sees the post-lock uninstalledAt value and skips if reinstalled", async () => {
      const triggeredAt = new Date();
      const originalUninstalledAt = new Date(triggeredAt.getTime() - 48 * 60 * 60 * 1000);
      await seedShop(SHOP_ID, SHOP_DOMAIN, originalUninstalledAt);

      const sqlConn1 = postgres(TEST_DATABASE_URL!, sqlOptions);
      const sqlConn2 = postgres(TEST_DATABASE_URL!, sqlOptions);

      try {
        const reinstallPromise = sqlConn1.begin(async (tx1) => {
          await tx1`SELECT id FROM "Shop" WHERE domain = ${SHOP_DOMAIN} FOR UPDATE`;
          const newUninstalledAt = new Date(triggeredAt.getTime() - 30 * 60 * 60 * 1000);
          await tx1`
            UPDATE "Shop" SET "uninstalledAt" = ${newUninstalledAt}, "updatedAt" = NOW()
            WHERE domain = ${SHOP_DOMAIN}
          `;
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { committed: true };
        });

        await new Promise((resolve) => setTimeout(resolve, 50));

        const redactPromise = deleteShop(sqlConn2, SHOP_DOMAIN, triggeredAt);

        const [reinstallResult, redactResult] = await Promise.all([
          reinstallPromise,
          redactPromise,
        ]);

        expect(reinstallResult.committed).toBe(true);
        expect(redactResult.deleted).toBe(false);
        expect(redactResult.skippedReinstalled).toBe(true);
        expect(redactResult.shopId).toBe(SHOP_ID);

        expect(await getShopExists(SHOP_ID)).toBe(true);
      } finally {
        await sqlConn1.end();
        await sqlConn2.end();
      }
    });
  });
});
