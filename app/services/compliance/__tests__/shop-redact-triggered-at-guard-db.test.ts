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
import { deleteShop, markShopUninstalled } from "../compliance.server";

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

  describe("6. 47h boundary tests", () => {
    const SHOP_ID_EXACT = `shop-47h-exact-${TEST_SUFFIX}`;
    const SHOP_DOMAIN_EXACT = `test-47h-exact-${TEST_SUFFIX}.myshopify.com`;
    const SHOP_ID_MINUS1 = `shop-47h-minus1-${TEST_SUFFIX}`;
    const SHOP_DOMAIN_MINUS1 = `test-47h-minus1-${TEST_SUFFIX}.myshopify.com`;
    const SHOP_ID_PLUS1 = `shop-47h-plus1-${TEST_SUFFIX}`;
    const SHOP_DOMAIN_PLUS1 = `test-47h-plus1-${TEST_SUFFIX}.myshopify.com`;

    // REVERT NOTE: This test FAILS if the triggeredAt guard is reverted.
    it("exactly at 47h boundary: uninstalledAt == triggeredAt - 47h skips (reinstall detected)", async () => {
      const triggeredAt = new Date();
      const uninstalledAt = new Date(triggeredAt.getTime() - 47 * 60 * 60 * 1000);
      await seedShop(SHOP_ID_EXACT, SHOP_DOMAIN_EXACT, uninstalledAt);

      const result = await deleteShop(sql, SHOP_DOMAIN_EXACT, triggeredAt);

      expect(result.deleted).toBe(false);
      expect(result.skippedReinstalled).toBe(true);
    });

    // REVERT NOTE: This test FAILS if the triggeredAt guard is reverted.
    it("1 minute inside 47h window: uninstalledAt == triggeredAt - 47h + 1min skips", async () => {
      const triggeredAt = new Date();
      const uninstalledAt = new Date(triggeredAt.getTime() - 47 * 60 * 60 * 1000 + 60 * 1000);
      await seedShop(SHOP_ID_MINUS1, SHOP_DOMAIN_MINUS1, uninstalledAt);

      const result = await deleteShop(sql, SHOP_DOMAIN_MINUS1, triggeredAt);

      expect(result.deleted).toBe(false);
      expect(result.skippedReinstalled).toBe(true);
    });

    it("1 minute outside 47h window: uninstalledAt == triggeredAt - 47h - 1min deletes", async () => {
      const triggeredAt = new Date();
      const uninstalledAt = new Date(triggeredAt.getTime() - 47 * 60 * 60 * 1000 - 60 * 1000);
      await seedShop(SHOP_ID_PLUS1, SHOP_DOMAIN_PLUS1, uninstalledAt);

      const result = await deleteShop(sql, SHOP_DOMAIN_PLUS1, triggeredAt);

      expect(result.deleted).toBe(true);
      expect(result.skippedReinstalled).toBe(false);
    });
  });

  describe("7. markShopUninstalled redelivery does not advance timestamp", () => {
    const SHOP_ID = `shop-redeliver-${TEST_SUFFIX}`;
    const SHOP_DOMAIN = `test-redeliver-${TEST_SUFFIX}.myshopify.com`;

    // REVERT NOTE: This test FAILS if markShopUninstalled COALESCE is reverted.
    it("redelivered app/uninstalled keeps first uninstalledAt, then shop/redact deletes", async () => {
      const now = new Date();
      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', ${now}, ${now}, NULL)
      `;
      allShopIds.push(SHOP_ID);
      allShopDomains.push(SHOP_DOMAIN);

      await markShopUninstalled(sql, SHOP_DOMAIN);
      const [first] = await sql<[{ uninstalledAt: Date }]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE id = ${SHOP_ID}
      `;
      const firstUninstalledAt = first.uninstalledAt;
      expect(firstUninstalledAt).not.toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 50));

      await markShopUninstalled(sql, SHOP_DOMAIN);
      const [second] = await sql<[{ uninstalledAt: Date }]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE id = ${SHOP_ID}
      `;
      expect(second.uninstalledAt.getTime()).toBe(firstUninstalledAt.getTime());

      const triggeredAt = new Date(firstUninstalledAt.getTime() + 48 * 60 * 60 * 1000);
      const result = await deleteShop(sql, SHOP_DOMAIN, triggeredAt);

      expect(result.deleted).toBe(true);
      expect(result.skippedReinstalled).toBe(false);
    });
  });

  describe("8. Uninstall, reinstall, uninstall again lifecycle", () => {
    const SHOP_ID = `shop-lifecycle-${TEST_SUFFIX}`;
    const SHOP_DOMAIN = `test-lifecycle-${TEST_SUFFIX}.myshopify.com`;

    // REVERT NOTE: This test FAILS if the triggeredAt guard is reverted.
    it("first redact skips (reinstalled), second redact (after re-uninstall) deletes", async () => {
      const now = new Date();
      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', ${now}, ${now}, NULL)
      `;
      allShopIds.push(SHOP_ID);
      allShopDomains.push(SHOP_DOMAIN);

      await markShopUninstalled(sql, SHOP_DOMAIN);
      const [firstUninstall] = await sql<[{ uninstalledAt: Date }]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE id = ${SHOP_ID}
      `;
      const firstUninstalledAt = firstUninstall.uninstalledAt;

      await sql`
        UPDATE "Shop" SET "uninstalledAt" = NULL WHERE id = ${SHOP_ID}
      `;

      await sql`
        UPDATE "Shop" SET "uninstalledAt" = NOW() WHERE id = ${SHOP_ID}
      `;
      const [secondUninstall] = await sql<[{ uninstalledAt: Date }]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE id = ${SHOP_ID}
      `;
      const secondUninstalledAt = secondUninstall.uninstalledAt;

      const firstRedactTriggeredAt = new Date(firstUninstalledAt.getTime() + 48 * 60 * 60 * 1000);
      const firstRedactResult = await deleteShop(sql, SHOP_DOMAIN, firstRedactTriggeredAt);
      expect(firstRedactResult.deleted).toBe(false);
      expect(firstRedactResult.skippedReinstalled).toBe(true);
      expect(await getShopExists(SHOP_ID)).toBe(true);

      const secondRedactTriggeredAt = new Date(secondUninstalledAt.getTime() + 48 * 60 * 60 * 1000);
      const secondRedactResult = await deleteShop(sql, SHOP_DOMAIN, secondRedactTriggeredAt);
      expect(secondRedactResult.deleted).toBe(true);
      expect(secondRedactResult.skippedReinstalled).toBe(false);
      expect(await getShopExists(SHOP_ID)).toBe(false);
    });
  });

  describe("9. Failed reinstall clear leaves old uninstalledAt (fail-safe)", () => {
    const SHOP_ID = `shop-failsafe-${TEST_SUFFIX}`;
    const SHOP_DOMAIN = `test-failsafe-${TEST_SUFFIX}.myshopify.com`;

    /**
     * FAIL-SAFE: If the after-auth reinstall clear fails or is skipped (e.g., DB error,
     * race condition, or code bug), the old uninstalledAt remains. This ensures the
     * shop/redact triggered by the original uninstall STILL DELETES the shop, which
     * is the safe direction: better to delete an active shop (merchant can reinstall
     * and restore from Shopify) than to preserve a shop that should have been erased.
     */
    it("shop/redact deletes when reinstall failed to clear uninstalledAt", async () => {
      const firstUninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await seedShop(SHOP_ID, SHOP_DOMAIN, firstUninstalledAt);

      const triggeredAt = new Date(firstUninstalledAt.getTime() + 48 * 60 * 60 * 1000);
      const result = await deleteShop(sql, SHOP_DOMAIN, triggeredAt);

      expect(result.deleted).toBe(true);
      expect(result.skippedReinstalled).toBe(false);
      expect(await getShopExists(SHOP_ID)).toBe(false);
    });
  });
});
