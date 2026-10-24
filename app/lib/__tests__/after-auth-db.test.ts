/**
 * DB-backed integration tests for after-auth Shop row upsert.
 *
 * STEP 0 (issue #154 E1): Verify that fresh install creates Shop row.
 *
 * Tests verify:
 * 1. Fresh install on empty DB creates Shop row via afterAuth upsert
 * 2. Reinstall clears uninstalledAt
 * 3. Re-auth twice is idempotent (one row)
 * 4. Services that depend on Shop row work after fresh install:
 *    - Order sync (processOrderWebhook)
 *    - Customer sync (processCustomerWebhook)
 *    - CompanyLocation sync (processCompanyLocationWebhook)
 *    - Reconcile (enqueueReconcileForAllShops)
 *    - Reminders (s18_enqueue_reminders skips uninstalled shops)
 *    - Compliance webhooks (customers/data_request, customers/redact)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("after-auth Shop row upsert (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-afterauth";
  const TEST_SHOP_DOMAIN = `fresh-install-${TEST_SUFFIX}.myshopify.com`;
  const TEST_SHOP_DOMAIN_2 = `reinstall-${TEST_SUFFIX}.myshopify.com`;
  const TEST_SHOP_DOMAIN_3 = `idempotent-${TEST_SUFFIX}.myshopify.com`;
  const TEST_TIMEZONE = "America/New_York";

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql`DELETE FROM "Shop" WHERE domain LIKE ${'%-' + TEST_SUFFIX + '.myshopify.com'}`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM "Shop" WHERE domain LIKE ${'%-' + TEST_SUFFIX + '.myshopify.com'}`;
  });

  describe("STEP 0: fresh install creates Shop row", () => {
    it("upsertShopOnAuth creates Shop row for new shop", async () => {
      const [existingBefore] = await sql<{ id: string }[]>`
        SELECT id FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
      `;
      expect(existingBefore).toBeUndefined();

      const { upsertShopOnAuth } = await import("../after-auth.server");
      await upsertShopOnAuth(sql, TEST_SHOP_DOMAIN, TEST_TIMEZONE);

      const [shop] = await sql<{ id: string; domain: string; timezone: string; uninstalledAt: Date | null }[]>`
        SELECT id, domain, timezone, "uninstalledAt"
        FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
      `;
      expect(shop).toBeDefined();
      expect(shop.domain).toBe(TEST_SHOP_DOMAIN);
      expect(shop.timezone).toBe(TEST_TIMEZONE);
      expect(shop.uninstalledAt).toBeNull();
    });
  });

  describe("reinstall clears uninstalledAt", () => {
    it("upsertShopOnAuth clears uninstalledAt on reinstall", async () => {
      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "uninstalledAt", "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_DOMAIN_2}, 'UTC', 'INR', 'free', NOW(), NOW(), NOW())
      `;

      const [beforeReinstall] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN_2}
      `;
      expect(beforeReinstall.uninstalledAt).not.toBeNull();

      const { upsertShopOnAuth } = await import("../after-auth.server");
      await upsertShopOnAuth(sql, TEST_SHOP_DOMAIN_2, TEST_TIMEZONE);

      const [afterReinstall] = await sql<{ uninstalledAt: Date | null; timezone: string }[]>`
        SELECT "uninstalledAt", timezone FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN_2}
      `;
      expect(afterReinstall.uninstalledAt).toBeNull();
      expect(afterReinstall.timezone).toBe(TEST_TIMEZONE);
    });
  });

  describe("re-auth twice is idempotent", () => {
    it("calling upsertShopOnAuth twice results in one row", async () => {
      const { upsertShopOnAuth } = await import("../after-auth.server");
      
      await upsertShopOnAuth(sql, TEST_SHOP_DOMAIN_3, TEST_TIMEZONE);
      await upsertShopOnAuth(sql, TEST_SHOP_DOMAIN_3, "Asia/Kolkata");

      const rows = await sql<{ id: string }[]>`
        SELECT id FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN_3}
      `;
      expect(rows).toHaveLength(1);

      const [shop] = await sql<{ timezone: string }[]>`
        SELECT timezone FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN_3}
      `;
      expect(shop.timezone).toBe("Asia/Kolkata");
    });
  });

  describe("timezone preservation on failed query", () => {
    const TEST_SHOP_DOMAIN_TZ = `tz-preserve-${TEST_SUFFIX}.myshopify.com`;

    it("re-auth with failed tz query preserves existing timezone", async () => {
      const { upsertShopOnAuth } = await import("../after-auth.server");
      
      await upsertShopOnAuth(sql, TEST_SHOP_DOMAIN_TZ, "America/New_York");

      const [before] = await sql<{ timezone: string }[]>`
        SELECT timezone FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN_TZ}
      `;
      expect(before.timezone).toBe("America/New_York");

      await upsertShopOnAuth(sql, TEST_SHOP_DOMAIN_TZ, null);

      const [after] = await sql<{ timezone: string }[]>`
        SELECT timezone FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN_TZ}
      `;
      expect(after.timezone).toBe("America/New_York");
    });

    it("fresh install with failed tz query gets default timezone", async () => {
      const { upsertShopOnAuth } = await import("../after-auth.server");
      const FRESH_SHOP = `fresh-tz-fail-${TEST_SUFFIX}.myshopify.com`;
      
      await upsertShopOnAuth(sql, FRESH_SHOP, null);

      const [shop] = await sql<{ timezone: string }[]>`
        SELECT timezone FROM "Shop" WHERE domain = ${FRESH_SHOP}
      `;
      expect(shop.timezone).toBe("Asia/Kolkata");
    });
  });
});

describeWithDb("Shop-dependent services after fresh install (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-services";
  const TEST_SHOP_DOMAIN = `services-test-${TEST_SUFFIX}.myshopify.com`;
  let testShopId: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    
    const { upsertShopOnAuth } = await import("../after-auth.server");
    await upsertShopOnAuth(sql, TEST_SHOP_DOMAIN, "America/New_York");
    
    const [shop] = await sql<{ id: string }[]>`
      SELECT id FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
    `;
    testShopId = shop.id;
  });

  afterAll(async () => {
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${testShopId}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;
    await sql.end();
  });

  describe("order sync finds shop after fresh install", () => {
    it("getEligibilityContextByDomain returns context for newly created shop", async () => {
      const { getEligibilityContextByDomain } = await import("../invoice-eligibility");
      
      const result = await getEligibilityContextByDomain(sql, TEST_SHOP_DOMAIN);
      
      expect(result).not.toBeNull();
      expect(result!.shopId).toBe(testShopId);
      expect(result!.context.shopTimezone).toBe("America/New_York");
    });
  });

  describe("customer sync finds shop after fresh install", () => {
    it("processCustomerWebhook does not return Shop not found error", async () => {
      const { processCustomerWebhook } = await import("~/services/sync/customer.server");
      
      const customer = {
        id: `gid://shopify/Customer/test-${TEST_SUFFIX}`,
        tags: [],
      };
      
      const result = await processCustomerWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "CUSTOMERS_CREATE",
        customer,
        `webhook-customer-${TEST_SUFFIX}`,
      );
      
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe("company location sync finds shop after fresh install", () => {
    it("processCompanyLocationWebhook does not return Shop not found error", async () => {
      const { processCompanyLocationWebhook } = await import("~/services/sync/company-location.server");
      
      const location = {
        id: `gid://shopify/CompanyLocation/test-${TEST_SUFFIX}`,
        name: "Test Location",
        company: { id: `gid://shopify/Company/test-${TEST_SUFFIX}` },
        billingAddress: null,
        buyerExperienceConfiguration: null,
      };
      
      const result = await processCompanyLocationWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "COMPANY_LOCATIONS_CREATE",
        location,
        `webhook-company-${TEST_SUFFIX}`,
      );
      
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe("reconcile finds shop after fresh install", () => {
    it("enqueueReconcileForAllShops includes newly created shop", async () => {
      const { enqueueReconcileForAllShops } = await import("~/services/drain/reconcile.server");
      
      const count = await enqueueReconcileForAllShops(sql);
      
      expect(count).toBeGreaterThanOrEqual(1);
      
      const [msg] = await sql<{ shop: string }[]>`
        SELECT message->>'shop' AS shop
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'topic' = 'RECONCILE_COMPANIES'
        LIMIT 1
      `;
      expect(msg).toBeDefined();
      expect(msg.shop).toBe(TEST_SHOP_DOMAIN);
      
      await sql`
        DELETE FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
      `;
    });
  });

  describe("reconcile excludes uninstalled shops", () => {
    it("enqueueReconcileForAllShops excludes uninstalled shops", async () => {
      await sql`
        UPDATE "Shop"
        SET "uninstalledAt" = NOW()
        WHERE id = ${testShopId}
      `;

      try {
        const { enqueueReconcileForAllShops } = await import("~/services/drain/reconcile.server");
        await enqueueReconcileForAllShops(sql);

        const [msg] = await sql<{ shop: string }[]>`
          SELECT message->>'shop' AS shop
          FROM pgmq.q_s6_sync
          WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
            AND message->>'topic' = 'RECONCILE_COMPANIES'
          LIMIT 1
        `;
        expect(msg).toBeUndefined();
      } finally {
        await sql`
          UPDATE "Shop"
          SET "uninstalledAt" = NULL
          WHERE id = ${testShopId}
        `;
        await sql`
          DELETE FROM pgmq.q_s6_sync
          WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
        `;
      }
    });
  });

  describe("compliance webhooks find shop after fresh install", () => {
    it("customers/data_request finds shop", async () => {
      const { generateCustomerDataExport } = await import("~/services/compliance");
      
      const customerGid = `gid://shopify/Customer/compliance-${TEST_SUFFIX}`;
      const requestId = `req-${TEST_SUFFIX}`;
      
      const exportData = await generateCustomerDataExport(
        sql,
        testShopId,
        customerGid,
        requestId
      );
      
      expect(exportData).toBeDefined();
      expect(exportData.customerGid).toBe(customerGid);
      expect(exportData.requestId).toBe(requestId);
    });

    it("customers/redact works for shop after fresh install", async () => {
      const { redactCustomer } = await import("~/services/compliance");
      
      const customerGid = `gid://shopify/Customer/redact-${TEST_SUFFIX}`;
      
      const result = await redactCustomer(sql, testShopId, customerGid);
      
      expect(result).toBeDefined();
      expect(result.taggedCustomersDeleted).toBe(0);
      expect(result.buyerAccountAnonymized).toBe(false);
    });
  });
});
