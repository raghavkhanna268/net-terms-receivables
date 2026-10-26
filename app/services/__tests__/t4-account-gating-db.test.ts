/**
 * DB-backed integration tests for T4 account-count gating.
 *
 * These tests verify the account gating logic that blocks NEW accounts over
 * the plan limit. Existing rows and updates never change gated_at.
 *
 * Tests written against the T4 API:
 * - decideNewAccountGate(tx, shopId) - decides if new account should be gated
 * - countActiveAccounts(sql, shopId) - counts ungated accounts
 * - reactivateGatedAccounts(sql, shopId) - reactivates oldest gated accounts on upgrade
 *
 * Plan limits (T1): none/starter/growth/unlimited = 0/25/100/-1
 * Tests set limits by updating Shop.plan_key directly.
 *
 * Fixture domains: test-* (no PII)
 *
 * IMPORTANT: No it.skip or describe.skip - all tests must pass.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("T4 account-count gating (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-t4-gating";

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql.end();
  });

  describe("(a) Gating at limit: 25th ungated, 26th gated (COMPANY and TAGGED_CUSTOMER mix)", () => {
    const SHOP_ID = `shop-limit25-${TEST_SUFFIX}`;
    const SHOP_DOMAIN = `test-limit25-${TEST_SUFFIX}.myshopify.com`;
    let originalEnv: string | undefined;

    beforeAll(async () => {
      originalEnv = process.env.PLAN_GATING_ENFORCED;
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, plan_cached_at, "createdAt", "updatedAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'starter', '2026-01-01 00:00:00', NOW(), NOW())
      `;
    });

    afterAll(async () => {
      if (originalEnv === undefined) {
        delete (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED;
      } else {
        (process.env as Record<string, string>).PLAN_GATING_ENFORCED = originalEnv;
      }
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${SHOP_ID}`;
      await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
    });

    beforeEach(async () => {
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${SHOP_ID}`;
    });

    it("creates 24 ungated accounts, then 25th ungated, 26th gated (mix of COMPANY and TAGGED_CUSTOMER)", async () => {
      const { checkCompanyLimit, isGatingEnforced } = await import("../gating.server");
      expect(isGatingEnforced()).toBe(true);

      for (let i = 1; i <= 12; i++) {
        const accountId = `acc-company-${i}-${TEST_SUFFIX}`;
        const locationId = `gid://shopify/CompanyLocation/${i}-${TEST_SUFFIX}`;
        const companyId = `gid://shopify/Company/${i}-${TEST_SUFFIX}`;

        const limitCheck = await checkCompanyLimit(sql, SHOP_ID);
        const shouldGate = !limitCheck.allowed;

        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "companyId", "companyLocationId", name,
            "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
            "syncPending", "syncVersion", gated_at, "createdAt", "updatedAt"
          )
          VALUES (
            ${accountId}, ${SHOP_ID}, 'COMPANY',
            ${companyId}, ${locationId}, ${'Company Account ' + i},
            100000.00, 'OK', false, false, 30, 'explicit',
            false, 1, ${shouldGate ? new Date() : null}, NOW(), NOW()
          )
        `;
      }

      for (let i = 1; i <= 12; i++) {
        const accountId = `acc-tagged-${i}-${TEST_SUFFIX}`;
        const customerId = `gid://shopify/Customer/${i}-${TEST_SUFFIX}`;

        const limitCheck = await checkCompanyLimit(sql, SHOP_ID);
        const shouldGate = !limitCheck.allowed;

        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "customerId", name,
            "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
            "syncPending", "syncVersion", gated_at, "createdAt", "updatedAt"
          )
          VALUES (
            ${accountId}, ${SHOP_ID}, 'TAGGED_CUSTOMER',
            ${customerId}, ${'Tagged Customer ' + i},
            100000.00, 'OK', false, false, 30, 'tag',
            false, 1, ${shouldGate ? new Date() : null}, NOW(), NOW()
          )
        `;
      }

      const accountsAfter24 = await sql<{ count: string; ungated: string }[]>`
        SELECT 
          COUNT(*)::text as count,
          COUNT(*) FILTER (WHERE gated_at IS NULL)::text as ungated
        FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}
      `;
      expect(parseInt(accountsAfter24[0].count)).toBe(24);
      expect(parseInt(accountsAfter24[0].ungated)).toBe(24);

      const limitCheck25 = await checkCompanyLimit(sql, SHOP_ID);
      expect(limitCheck25.allowed).toBe(true);
      expect(limitCheck25.currentUsage).toBe(24);
      expect(limitCheck25.limit).toBe(25);

      const account25Id = `acc-company-25-${TEST_SUFFIX}`;
      const location25Id = `gid://shopify/CompanyLocation/25-${TEST_SUFFIX}`;
      const company25Id = `gid://shopify/Company/25-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
          "syncPending", "syncVersion", gated_at, "createdAt", "updatedAt"
        )
        VALUES (
          ${account25Id}, ${SHOP_ID}, 'COMPANY',
          ${company25Id}, ${location25Id}, 'Company Account 25',
          100000.00, 'OK', false, false, 30, 'explicit',
          false, 1, NULL, NOW(), NOW()
        )
      `;

      const [account25] = await sql<{ gated_at: Date | null }[]>`
        SELECT gated_at FROM "BuyerAccount" WHERE id = ${account25Id}
      `;
      expect(account25.gated_at).toBeNull();

      const limitCheck26 = await checkCompanyLimit(sql, SHOP_ID);
      expect(limitCheck26.allowed).toBe(false);
      expect(limitCheck26.currentUsage).toBe(25);
      expect(limitCheck26.limit).toBe(25);

      const account26Id = `acc-tagged-26-${TEST_SUFFIX}`;
      const customer26Id = `gid://shopify/Customer/26-${TEST_SUFFIX}`;
      const shouldGate26 = !limitCheck26.allowed;
      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "customerId", name,
          "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
          "syncPending", "syncVersion", gated_at, "createdAt", "updatedAt"
        )
        VALUES (
          ${account26Id}, ${SHOP_ID}, 'TAGGED_CUSTOMER',
          ${customer26Id}, 'Tagged Customer 26',
          100000.00, 'OK', false, false, 30, 'tag',
          false, 1, ${shouldGate26 ? new Date() : null}, NOW(), NOW()
        )
      `;

      const [account26] = await sql<{ gated_at: Date | null }[]>`
        SELECT gated_at FROM "BuyerAccount" WHERE id = ${account26Id}
      `;
      expect(account26.gated_at).not.toBeNull();
      expect(account26.gated_at).toBeInstanceOf(Date);

      const finalCounts = await sql<{ total: string; ungated: string; gated: string }[]>`
        SELECT 
          COUNT(*)::text as total,
          COUNT(*) FILTER (WHERE gated_at IS NULL)::text as ungated,
          COUNT(*) FILTER (WHERE gated_at IS NOT NULL)::text as gated
        FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}
      `;
      expect(parseInt(finalCounts[0].total)).toBe(26);
      expect(parseInt(finalCounts[0].ungated)).toBe(25);
      expect(parseInt(finalCounts[0].gated)).toBe(1);
    });

    it("webhook/sync-created account over limit is created gated, never dropped", async () => {
      for (let i = 1; i <= 25; i++) {
        const accountId = `acc-webhook-fill-${i}-${TEST_SUFFIX}`;
        const locationId = `gid://shopify/CompanyLocation/fill-${i}-${TEST_SUFFIX}`;
        const companyId = `gid://shopify/Company/fill-${i}-${TEST_SUFFIX}`;
        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "companyId", "companyLocationId", name,
            "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
            "syncPending", "syncVersion", "createdAt", "updatedAt"
          )
          VALUES (
            ${accountId}, ${SHOP_ID}, 'COMPANY',
            ${companyId}, ${locationId}, ${'Fill Account ' + i},
            100000.00, 'OK', false, false, 30, 'explicit',
            false, 1, NOW(), NOW()
          )
        `;
      }

      const { processCompanyLocationWebhook } = await import("../sync/company-location.server");
      const webhookId = `webhook-over-limit-${TEST_SUFFIX}`;
      const location = {
        id: `gid://shopify/CompanyLocation/webhook-over-${TEST_SUFFIX}`,
        company: { id: `gid://shopify/Company/webhook-over-${TEST_SUFFIX}` },
        name: "Webhook Created Over Limit",
        billingAddress: null,
        buyerExperienceConfiguration: null,
      };

      const result = await processCompanyLocationWebhook(
        sql,
        SHOP_DOMAIN,
        "COMPANY_LOCATIONS_CREATE",
        location,
        webhookId,
        {}
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("gated");
      expect(result.entityId).toBeDefined();

      const [createdAccount] = await sql<{ id: string; gated_at: Date | null }[]>`
        SELECT id, gated_at FROM "BuyerAccount"
        WHERE "companyLocationId" = ${location.id}
      `;
      expect(createdAccount).toBeDefined();
      expect(createdAccount.gated_at).not.toBeNull();

      const finalCounts = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}
      `;
      expect(parseInt(finalCounts[0].count)).toBe(26);
    });
  });

  describe("(b) Update of existing row never changes gated_at", () => {
    const SHOP_ID = `shop-update-${TEST_SUFFIX}`;
    const SHOP_DOMAIN = `test-update-${TEST_SUFFIX}.myshopify.com`;
    let originalEnv: string | undefined;

    beforeAll(async () => {
      originalEnv = process.env.PLAN_GATING_ENFORCED;
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, plan_cached_at, "createdAt", "updatedAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'starter', '2026-01-01 00:00:00', NOW(), NOW())
      `;
    });

    afterAll(async () => {
      if (originalEnv === undefined) {
        delete (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED;
      } else {
        (process.env as Record<string, string>).PLAN_GATING_ENFORCED = originalEnv;
      }
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%' + TEST_SUFFIX + '%'}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
    });

    it("update webhook on ungated account does not set gated_at", async () => {
      const accountId = `acc-update-ungated-${TEST_SUFFIX}`;
      const locationId = `gid://shopify/CompanyLocation/update-ungated-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/update-ungated-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
          "syncPending", "syncVersion", "createdAt", "updatedAt"
        )
        VALUES (
          ${accountId}, ${SHOP_ID}, 'COMPANY',
          ${companyId}, ${locationId}, 'Original Name',
          100000.00, 'OK', false, false, 30, 'explicit',
          false, 1, NOW(), NOW()
        )
      `;

      const [beforeUpdate] = await sql<{ gated_at: Date | null; name: string }[]>`
        SELECT gated_at, name FROM "BuyerAccount" WHERE id = ${accountId}
      `;
      expect(beforeUpdate.gated_at).toBeNull();
      expect(beforeUpdate.name).toBe('Original Name');

      const { processCompanyLocationWebhook } = await import("../sync/company-location.server");
      const webhookId = `webhook-update-ungated-${TEST_SUFFIX}`;
      const location = {
        id: locationId,
        company: { id: companyId },
        name: "Updated Name",
        billingAddress: null,
        buyerExperienceConfiguration: null,
      };

      const result = await processCompanyLocationWebhook(
        sql,
        SHOP_DOMAIN,
        "COMPANY_LOCATIONS_UPDATE",
        location,
        webhookId,
        {}
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("updated");

      const [afterUpdate] = await sql<{ gated_at: Date | null; name: string }[]>`
        SELECT gated_at, name FROM "BuyerAccount" WHERE id = ${accountId}
      `;
      expect(afterUpdate.gated_at).toBeNull();
      expect(afterUpdate.name).toBe('Updated Name');
    });

    it("update webhook on gated account does not clear gated_at", async () => {
      const accountId = `acc-update-gated-${TEST_SUFFIX}`;
      const locationId = `gid://shopify/CompanyLocation/update-gated-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/update-gated-${TEST_SUFFIX}`;
      const originalGatedAt = new Date('2026-01-15T10:00:00Z');

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
          "syncPending", "syncVersion", gated_at, "createdAt", "updatedAt"
        )
        VALUES (
          ${accountId}, ${SHOP_ID}, 'COMPANY',
          ${companyId}, ${locationId}, 'Gated Account',
          100000.00, 'OK', false, false, 30, 'explicit',
          false, 1, ${originalGatedAt}, NOW(), NOW()
        )
      `;

      const [beforeUpdate] = await sql<{ gated_at: Date | null }[]>`
        SELECT gated_at FROM "BuyerAccount" WHERE id = ${accountId}
      `;
      expect(beforeUpdate.gated_at).not.toBeNull();

      const { processCompanyLocationWebhook } = await import("../sync/company-location.server");
      const webhookId = `webhook-update-gated-${TEST_SUFFIX}`;
      const location = {
        id: locationId,
        company: { id: companyId },
        name: "Updated Gated Account Name",
        billingAddress: null,
        buyerExperienceConfiguration: null,
      };

      const result = await processCompanyLocationWebhook(
        sql,
        SHOP_DOMAIN,
        "COMPANY_LOCATIONS_UPDATE",
        location,
        webhookId,
        {}
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("updated");

      const [afterUpdate] = await sql<{ gated_at: Date | null; name: string }[]>`
        SELECT gated_at, name FROM "BuyerAccount" WHERE id = ${accountId}
      `;
      expect(afterUpdate.gated_at).not.toBeNull();
      expect(afterUpdate.gated_at!.getTime()).toBe(originalGatedAt.getTime());
      expect(afterUpdate.name).toBe('Updated Gated Account Name');
    });
  });

  describe("(c) Bulk batch straddling the limit - first free slots ungated, rest gated in feed order", () => {
    const SHOP_ID = `shop-bulk-${TEST_SUFFIX}`;
    const SHOP_DOMAIN = `test-bulk-${TEST_SUFFIX}.myshopify.com`;
    let originalEnv: string | undefined;

    beforeAll(async () => {
      originalEnv = process.env.PLAN_GATING_ENFORCED;
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, plan_cached_at, "createdAt", "updatedAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'starter', '2026-01-01 00:00:00', NOW(), NOW())
      `;
    });

    afterAll(async () => {
      if (originalEnv === undefined) {
        delete (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED;
      } else {
        (process.env as Record<string, string>).PLAN_GATING_ENFORCED = originalEnv;
      }
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
    });

    beforeEach(async () => {
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}`;
    });

    it("bulk upsert with 20 existing and 10 new accounts: first 5 ungated, last 5 gated", async () => {
      for (let i = 1; i <= 20; i++) {
        const accountId = `acc-bulk-existing-${i}-${TEST_SUFFIX}`;
        const locationId = `gid://shopify/CompanyLocation/bulk-existing-${i}-${TEST_SUFFIX}`;
        const companyId = `gid://shopify/Company/bulk-existing-${i}-${TEST_SUFFIX}`;
        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "companyId", "companyLocationId", name,
            "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
            "syncPending", "syncVersion", "createdAt", "updatedAt"
          )
          VALUES (
            ${accountId}, ${SHOP_ID}, 'COMPANY',
            ${companyId}, ${locationId}, ${'Existing Account ' + i},
            100000.00, 'OK', false, false, 30, 'explicit',
            false, 1, NOW(), NOW()
          )
        `;
      }

      const { bulkUpsertBuyerAccounts, mapCompanyLocationToBuyerAccount } = await import("../sync/company-location.server");

      const newLocations = [];
      for (let i = 1; i <= 10; i++) {
        newLocations.push({
          id: `gid://shopify/CompanyLocation/bulk-new-${i}-${TEST_SUFFIX}`,
          company: { id: `gid://shopify/Company/bulk-new-${i}-${TEST_SUFFIX}` },
          name: `New Bulk Account ${i}`,
          billingAddress: null,
          buyerExperienceConfiguration: null,
        });
      }

      const mappedAccounts = newLocations.map((loc) => mapCompanyLocationToBuyerAccount(SHOP_ID, loc, {}));

      const upsertCount = await bulkUpsertBuyerAccounts(sql, mappedAccounts);
      expect(upsertCount).toBe(10);

      const results = await sql<{ companyLocationId: string; gated_at: Date | null }[]>`
        SELECT "companyLocationId", gated_at FROM "BuyerAccount"
        WHERE "shopId" = ${SHOP_ID}
          AND "companyLocationId" LIKE ${'%bulk-new-%'}
        ORDER BY "companyLocationId"
      `;

      expect(results.length).toBe(10);

      let ungatedCount = 0;
      let gatedCount = 0;
      for (const r of results) {
        if (r.gated_at === null) {
          ungatedCount++;
        } else {
          gatedCount++;
        }
      }

      expect(ungatedCount).toBe(5);
      expect(gatedCount).toBe(5);

      const totalCounts = await sql<{ ungated: string; gated: string }[]>`
        SELECT 
          COUNT(*) FILTER (WHERE gated_at IS NULL)::text as ungated,
          COUNT(*) FILTER (WHERE gated_at IS NOT NULL)::text as gated
        FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}
      `;
      expect(parseInt(totalCounts[0].ungated)).toBe(25);
      expect(parseInt(totalCounts[0].gated)).toBe(5);
    });

    it("bulk upsert with >25 new rows across multiple batches: exactly limit ungated, rest gated", async () => {
      // Start with 15 existing accounts, limit is 25 (starter plan)
      // Creating 40 new accounts should result in: 10 ungated (slots available), 30 gated
      // This tests batch straddling: BATCH_SIZE=25, so rows span 2 batches
      for (let i = 1; i <= 15; i++) {
        const accountId = `acc-multi-batch-existing-${i}-${TEST_SUFFIX}`;
        const locationId = `gid://shopify/CompanyLocation/multi-batch-existing-${i}-${TEST_SUFFIX}`;
        const companyId = `gid://shopify/Company/multi-batch-existing-${i}-${TEST_SUFFIX}`;
        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "companyId", "companyLocationId", name,
            "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
            "syncPending", "syncVersion", "createdAt", "updatedAt"
          )
          VALUES (
            ${accountId}, ${SHOP_ID}, 'COMPANY',
            ${companyId}, ${locationId}, ${'Multi-batch Existing ' + i},
            100000.00, 'OK', false, false, 30, 'explicit',
            false, 1, NOW(), NOW()
          )
        `;
      }

      const { bulkUpsertBuyerAccounts, mapCompanyLocationToBuyerAccount } = await import("../sync/company-location.server");

      // Create 40 new accounts (spans 2 batches at BATCH_SIZE=25)
      const newLocations = [];
      for (let i = 1; i <= 40; i++) {
        newLocations.push({
          id: `gid://shopify/CompanyLocation/multi-batch-new-${i}-${TEST_SUFFIX}`,
          company: { id: `gid://shopify/Company/multi-batch-new-${i}-${TEST_SUFFIX}` },
          name: `Multi-batch New ${i}`,
          billingAddress: null,
          buyerExperienceConfiguration: null,
        });
      }

      const mappedAccounts = newLocations.map((loc) => mapCompanyLocationToBuyerAccount(SHOP_ID, loc, {}));

      const upsertCount = await bulkUpsertBuyerAccounts(sql, mappedAccounts);
      expect(upsertCount).toBe(40);

      // Verify: 10 ungated (slots available from 15 to 25), 30 gated
      const results = await sql<{ companyLocationId: string; gated_at: Date | null }[]>`
        SELECT "companyLocationId", gated_at FROM "BuyerAccount"
        WHERE "shopId" = ${SHOP_ID}
          AND "companyLocationId" LIKE ${'%multi-batch-new-%'}
        ORDER BY "companyLocationId"
      `;

      expect(results.length).toBe(40);

      let ungatedCount = 0;
      let gatedCount = 0;
      for (const r of results) {
        if (r.gated_at === null) {
          ungatedCount++;
        } else {
          gatedCount++;
        }
      }

      // 25 (limit) - 15 (existing) = 10 slots available
      expect(ungatedCount).toBe(10);
      expect(gatedCount).toBe(30);

      // Total: 15 existing + 10 ungated + 30 gated = 55 accounts
      // But only 25 should be ungated (15 existing + 10 new)
      const totalCounts = await sql<{ ungated: string; gated: string }[]>`
        SELECT 
          COUNT(*) FILTER (WHERE gated_at IS NULL)::text as ungated,
          COUNT(*) FILTER (WHERE gated_at IS NOT NULL)::text as gated
        FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}
      `;
      expect(parseInt(totalCounts[0].ungated)).toBe(25); // 15 existing + 10 new ungated
      expect(parseInt(totalCounts[0].gated)).toBe(30);   // 40 new - 10 ungated = 30 gated
    });
  });

  describe("(d) CONCURRENCY: two concurrent creates at used = limit-1", () => {
    const SHOP_ID = `shop-concurrent-${TEST_SUFFIX}`;
    const SHOP_DOMAIN = `test-concurrent-${TEST_SUFFIX}.myshopify.com`;
    let originalEnv: string | undefined;

    beforeAll(async () => {
      originalEnv = process.env.PLAN_GATING_ENFORCED;
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, plan_cached_at, "createdAt", "updatedAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'starter', '2026-01-01 00:00:00', NOW(), NOW())
      `;
    });

    afterAll(async () => {
      if (originalEnv === undefined) {
        delete (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED;
      } else {
        (process.env as Record<string, string>).PLAN_GATING_ENFORCED = originalEnv;
      }
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%' + TEST_SUFFIX + '%'}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
    });

    beforeEach(async () => {
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%concurrent%' + TEST_SUFFIX + '%'}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}`;
    });

    it("two concurrent creates at limit-1 give exactly 1 ungated and 1 gated (pg_advisory_xact_lock)", async () => {
      for (let i = 1; i <= 24; i++) {
        const accountId = `acc-concurrent-fill-${i}-${TEST_SUFFIX}`;
        const locationId = `gid://shopify/CompanyLocation/concurrent-fill-${i}-${TEST_SUFFIX}`;
        const companyId = `gid://shopify/Company/concurrent-fill-${i}-${TEST_SUFFIX}`;
        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "companyId", "companyLocationId", name,
            "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
            "syncPending", "syncVersion", "createdAt", "updatedAt"
          )
          VALUES (
            ${accountId}, ${SHOP_ID}, 'COMPANY',
            ${companyId}, ${locationId}, ${'Fill Account ' + i},
            100000.00, 'OK', false, false, 30, 'explicit',
            false, 1, NOW(), NOW()
          )
        `;
      }

      const [countBefore] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM "BuyerAccount" 
        WHERE "shopId" = ${SHOP_ID} AND gated_at IS NULL
      `;
      expect(parseInt(countBefore.count)).toBe(24);

      const sql1 = postgres(TEST_DATABASE_URL!, sqlOptions);
      const sql2 = postgres(TEST_DATABASE_URL!, sqlOptions);

      const { processCompanyLocationWebhook } = await import("../sync/company-location.server");

      const location1 = {
        id: `gid://shopify/CompanyLocation/concurrent-1-${TEST_SUFFIX}`,
        company: { id: `gid://shopify/Company/concurrent-1-${TEST_SUFFIX}` },
        name: "Concurrent Account 1",
        billingAddress: null,
        buyerExperienceConfiguration: null,
      };

      const location2 = {
        id: `gid://shopify/CompanyLocation/concurrent-2-${TEST_SUFFIX}`,
        company: { id: `gid://shopify/Company/concurrent-2-${TEST_SUFFIX}` },
        name: "Concurrent Account 2",
        billingAddress: null,
        buyerExperienceConfiguration: null,
      };

      try {
        const [result1, result2] = await Promise.all([
          processCompanyLocationWebhook(
            sql1,
            SHOP_DOMAIN,
            "COMPANY_LOCATIONS_CREATE",
            location1,
            `webhook-concurrent-1-${TEST_SUFFIX}`,
            {}
          ),
          processCompanyLocationWebhook(
            sql2,
            SHOP_DOMAIN,
            "COMPANY_LOCATIONS_CREATE",
            location2,
            `webhook-concurrent-2-${TEST_SUFFIX}`,
            {}
          ),
        ]);

        expect(result1.success).toBe(true);
        expect(result2.success).toBe(true);

        const accounts = await sql<{ companyLocationId: string; gated_at: Date | null }[]>`
          SELECT "companyLocationId", gated_at FROM "BuyerAccount"
          WHERE "shopId" = ${SHOP_ID}
            AND "companyLocationId" IN (${location1.id}, ${location2.id})
        `;

        expect(accounts.length).toBe(2);

        const ungatedAccounts = accounts.filter(a => a.gated_at === null);
        const gatedAccounts = accounts.filter(a => a.gated_at !== null);

        expect(ungatedAccounts.length).toBe(1);
        expect(gatedAccounts.length).toBe(1);

        const finalCount = await sql<{ ungated: string; total: string }[]>`
          SELECT 
            COUNT(*) FILTER (WHERE gated_at IS NULL)::text as ungated,
            COUNT(*)::text as total
          FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}
        `;
        expect(parseInt(finalCount[0].ungated)).toBe(25);
        expect(parseInt(finalCount[0].total)).toBe(26);
      } finally {
        await sql1.end();
        await sql2.end();
      }
    });
  });

  describe("(e) reactivateGatedAccounts: oldest createdAt first, up to new limit, all when -1", () => {
    const SHOP_ID = `shop-reactivate-${TEST_SUFFIX}`;
    const SHOP_DOMAIN = `test-reactivate-${TEST_SUFFIX}.myshopify.com`;
    let originalEnv: string | undefined;

    beforeAll(async () => {
      originalEnv = process.env.PLAN_GATING_ENFORCED;
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, plan_cached_at, "createdAt", "updatedAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'starter', '2026-01-01 00:00:00', NOW(), NOW())
      `;
    });

    afterAll(async () => {
      if (originalEnv === undefined) {
        delete (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED;
      } else {
        (process.env as Record<string, string>).PLAN_GATING_ENFORCED = originalEnv;
      }
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
    });

    beforeEach(async () => {
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}`;
    });

    it("reactivates oldest gated accounts first, up to the new limit", async () => {
      for (let i = 1; i <= 25; i++) {
        const accountId = `acc-reactivate-active-${i}-${TEST_SUFFIX}`;
        const locationId = `gid://shopify/CompanyLocation/reactivate-active-${i}-${TEST_SUFFIX}`;
        const companyId = `gid://shopify/Company/reactivate-active-${i}-${TEST_SUFFIX}`;
        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "companyId", "companyLocationId", name,
            "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
            "syncPending", "syncVersion", "createdAt", "updatedAt"
          )
          VALUES (
            ${accountId}, ${SHOP_ID}, 'COMPANY',
            ${companyId}, ${locationId}, ${'Active Account ' + i},
            100000.00, 'OK', false, false, 30, 'explicit',
            false, 1, NOW() - INTERVAL '100 days', NOW()
          )
        `;
      }

      const baseDate = new Date('2026-01-01T00:00:00Z');
      for (let i = 1; i <= 10; i++) {
        const accountId = `acc-reactivate-gated-${i}-${TEST_SUFFIX}`;
        const locationId = `gid://shopify/CompanyLocation/reactivate-gated-${i}-${TEST_SUFFIX}`;
        const companyId = `gid://shopify/Company/reactivate-gated-${i}-${TEST_SUFFIX}`;
        const createdAt = new Date(baseDate.getTime() + i * 24 * 60 * 60 * 1000);
        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "companyId", "companyLocationId", name,
            "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
            "syncPending", "syncVersion", gated_at, "createdAt", "updatedAt"
          )
          VALUES (
            ${accountId}, ${SHOP_ID}, 'COMPANY',
            ${companyId}, ${locationId}, ${'Gated Account ' + i},
            100000.00, 'OK', false, false, 30, 'explicit',
            false, 1, NOW(), ${createdAt}, NOW()
          )
        `;
      }

      await sql`UPDATE "Shop" SET plan_key = 'growth' WHERE id = ${SHOP_ID}`;

      const { reactivateGatedAccounts } = await import("../gating.server");

      const reactivatedCount = await reactivateGatedAccounts(sql, SHOP_ID);

      expect(reactivatedCount).toBe(10);

      const finalCounts = await sql<{ ungated: string; gated: string }[]>`
        SELECT 
          COUNT(*) FILTER (WHERE gated_at IS NULL)::text as ungated,
          COUNT(*) FILTER (WHERE gated_at IS NOT NULL)::text as gated
        FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}
      `;
      expect(parseInt(finalCounts[0].ungated)).toBe(35);
      expect(parseInt(finalCounts[0].gated)).toBe(0);
    });

    it("reactivates only as many accounts as slots available (new limit - current active)", async () => {
      for (let i = 1; i <= 20; i++) {
        const accountId = `acc-partial-active-${i}-${TEST_SUFFIX}`;
        const locationId = `gid://shopify/CompanyLocation/partial-active-${i}-${TEST_SUFFIX}`;
        const companyId = `gid://shopify/Company/partial-active-${i}-${TEST_SUFFIX}`;
        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "companyId", "companyLocationId", name,
            "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
            "syncPending", "syncVersion", "createdAt", "updatedAt"
          )
          VALUES (
            ${accountId}, ${SHOP_ID}, 'COMPANY',
            ${companyId}, ${locationId}, ${'Active Account ' + i},
            100000.00, 'OK', false, false, 30, 'explicit',
            false, 1, NOW(), NOW()
          )
        `;
      }

      const baseDate = new Date('2026-01-01T00:00:00Z');
      for (let i = 1; i <= 10; i++) {
        const accountId = `acc-partial-gated-${i}-${TEST_SUFFIX}`;
        const locationId = `gid://shopify/CompanyLocation/partial-gated-${i}-${TEST_SUFFIX}`;
        const companyId = `gid://shopify/Company/partial-gated-${i}-${TEST_SUFFIX}`;
        const createdAt = new Date(baseDate.getTime() + i * 24 * 60 * 60 * 1000);
        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "companyId", "companyLocationId", name,
            "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
            "syncPending", "syncVersion", gated_at, "createdAt", "updatedAt"
          )
          VALUES (
            ${accountId}, ${SHOP_ID}, 'COMPANY',
            ${companyId}, ${locationId}, ${'Gated Account ' + i},
            100000.00, 'OK', false, false, 30, 'explicit',
            false, 1, NOW(), ${createdAt}, NOW()
          )
        `;
      }

      await sql`UPDATE "Shop" SET plan_key = 'starter' WHERE id = ${SHOP_ID}`;

      const { reactivateGatedAccounts } = await import("../gating.server");

      const reactivatedCount = await reactivateGatedAccounts(sql, SHOP_ID);

      expect(reactivatedCount).toBe(5);

      const reactivatedAccounts = await sql<{ name: string }[]>`
        SELECT name FROM "BuyerAccount"
        WHERE "shopId" = ${SHOP_ID}
          AND "companyLocationId" LIKE ${'%partial-gated-%'}
          AND gated_at IS NULL
        ORDER BY "createdAt" ASC
      `;
      expect(reactivatedAccounts.length).toBe(5);
      expect(reactivatedAccounts[0].name).toBe('Gated Account 1');
      expect(reactivatedAccounts[4].name).toBe('Gated Account 5');

      const stillGated = await sql<{ name: string }[]>`
        SELECT name FROM "BuyerAccount"
        WHERE "shopId" = ${SHOP_ID}
          AND "companyLocationId" LIKE ${'%partial-gated-%'}
          AND gated_at IS NOT NULL
        ORDER BY "createdAt" ASC
      `;
      expect(stillGated.length).toBe(5);
      expect(stillGated[0].name).toBe('Gated Account 6');
    });

    it("reactivates all gated accounts when new plan is unlimited (-1)", async () => {
      for (let i = 1; i <= 100; i++) {
        const accountId = `acc-unlimited-active-${i}-${TEST_SUFFIX}`;
        const locationId = `gid://shopify/CompanyLocation/unlimited-active-${i}-${TEST_SUFFIX}`;
        const companyId = `gid://shopify/Company/unlimited-active-${i}-${TEST_SUFFIX}`;
        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "companyId", "companyLocationId", name,
            "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
            "syncPending", "syncVersion", "createdAt", "updatedAt"
          )
          VALUES (
            ${accountId}, ${SHOP_ID}, 'COMPANY',
            ${companyId}, ${locationId}, ${'Active Account ' + i},
            100000.00, 'OK', false, false, 30, 'explicit',
            false, 1, NOW(), NOW()
          )
        `;
      }

      for (let i = 1; i <= 50; i++) {
        const accountId = `acc-unlimited-gated-${i}-${TEST_SUFFIX}`;
        const locationId = `gid://shopify/CompanyLocation/unlimited-gated-${i}-${TEST_SUFFIX}`;
        const companyId = `gid://shopify/Company/unlimited-gated-${i}-${TEST_SUFFIX}`;
        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "companyId", "companyLocationId", name,
            "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
            "syncPending", "syncVersion", gated_at, "createdAt", "updatedAt"
          )
          VALUES (
            ${accountId}, ${SHOP_ID}, 'COMPANY',
            ${companyId}, ${locationId}, ${'Gated Account ' + i},
            100000.00, 'OK', false, false, 30, 'explicit',
            false, 1, NOW(), NOW(), NOW()
          )
        `;
      }

      await sql`UPDATE "Shop" SET plan_key = 'unlimited' WHERE id = ${SHOP_ID}`;

      const { reactivateGatedAccounts } = await import("../gating.server");

      const reactivatedCount = await reactivateGatedAccounts(sql, SHOP_ID);

      expect(reactivatedCount).toBe(50);

      const finalCounts = await sql<{ gated: string }[]>`
        SELECT COUNT(*) FILTER (WHERE gated_at IS NOT NULL)::text as gated
        FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}
      `;
      expect(parseInt(finalCounts[0].gated)).toBe(0);
    });
  });

  describe("(f) Unlimited (-1) and gating off never gate", () => {
    const SHOP_ID_UNLIMITED = `shop-unlimited-${TEST_SUFFIX}`;
    const SHOP_DOMAIN_UNLIMITED = `test-unlimited-${TEST_SUFFIX}.myshopify.com`;
    const SHOP_ID_OFF = `shop-gating-off-${TEST_SUFFIX}`;
    const SHOP_DOMAIN_OFF = `test-gating-off-${TEST_SUFFIX}.myshopify.com`;
    let originalEnv: string | undefined;

    beforeAll(async () => {
      originalEnv = process.env.PLAN_GATING_ENFORCED;

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, plan_cached_at, "createdAt", "updatedAt")
        VALUES 
          (${SHOP_ID_UNLIMITED}, ${SHOP_DOMAIN_UNLIMITED}, 'INR', 'Asia/Kolkata', 'unlimited', '2026-01-01 00:00:00', NOW(), NOW()),
          (${SHOP_ID_OFF}, ${SHOP_DOMAIN_OFF}, 'INR', 'Asia/Kolkata', 'starter', '2026-01-01 00:00:00', NOW(), NOW())
      `;
    });

    afterAll(async () => {
      if (originalEnv === undefined) {
        delete (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED;
      } else {
        (process.env as Record<string, string>).PLAN_GATING_ENFORCED = originalEnv;
      }
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%' + TEST_SUFFIX + '%'}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (${SHOP_ID_UNLIMITED}, ${SHOP_ID_OFF})`;
      await sql`DELETE FROM "Shop" WHERE id IN (${SHOP_ID_UNLIMITED}, ${SHOP_ID_OFF})`;
    });

    beforeEach(async () => {
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%unlimited%' + TEST_SUFFIX + '%'}`;
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%gating-off%' + TEST_SUFFIX + '%'}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (${SHOP_ID_UNLIMITED}, ${SHOP_ID_OFF})`;
    });

    it("unlimited plan (-1 limit) never gates accounts", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";

      const { checkCompanyLimit } = await import("../gating.server");
      const limitCheck = await checkCompanyLimit(sql, SHOP_ID_UNLIMITED);
      expect(limitCheck.allowed).toBe(true);
      expect(limitCheck.limit).toBe(-1);

      for (let i = 1; i <= 200; i++) {
        const accountId = `acc-unlimited-${i}-${TEST_SUFFIX}`;
        const locationId = `gid://shopify/CompanyLocation/unlimited-${i}-${TEST_SUFFIX}`;
        const companyId = `gid://shopify/Company/unlimited-${i}-${TEST_SUFFIX}`;

        const check = await checkCompanyLimit(sql, SHOP_ID_UNLIMITED);
        const shouldGate = !check.allowed;

        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "companyId", "companyLocationId", name,
            "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
            "syncPending", "syncVersion", gated_at, "createdAt", "updatedAt"
          )
          VALUES (
            ${accountId}, ${SHOP_ID_UNLIMITED}, 'COMPANY',
            ${companyId}, ${locationId}, ${'Unlimited Account ' + i},
            100000.00, 'OK', false, false, 30, 'explicit',
            false, 1, ${shouldGate ? new Date() : null}, NOW(), NOW()
          )
        `;
      }

      const finalCounts = await sql<{ total: string; gated: string }[]>`
        SELECT 
          COUNT(*)::text as total,
          COUNT(*) FILTER (WHERE gated_at IS NOT NULL)::text as gated
        FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID_UNLIMITED}
      `;
      expect(parseInt(finalCounts[0].total)).toBe(200);
      expect(parseInt(finalCounts[0].gated)).toBe(0);
    });

    it("gating off (PLAN_GATING_ENFORCED=false) never gates accounts", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";

      vi.resetModules();
      const { checkCompanyLimit, isGatingEnforced } = await import("../gating.server");
      expect(isGatingEnforced()).toBe(false);

      for (let i = 1; i <= 50; i++) {
        const accountId = `acc-gating-off-${i}-${TEST_SUFFIX}`;
        const locationId = `gid://shopify/CompanyLocation/gating-off-${i}-${TEST_SUFFIX}`;
        const companyId = `gid://shopify/Company/gating-off-${i}-${TEST_SUFFIX}`;

        const check = await checkCompanyLimit(sql, SHOP_ID_OFF);
        expect(check.allowed).toBe(true);
        expect(check.reason).toContain("Gating not enforced");

        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "companyId", "companyLocationId", name,
            "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
            "syncPending", "syncVersion", "createdAt", "updatedAt"
          )
          VALUES (
            ${accountId}, ${SHOP_ID_OFF}, 'COMPANY',
            ${companyId}, ${locationId}, ${'Gating Off Account ' + i},
            100000.00, 'OK', false, false, 30, 'explicit',
            false, 1, NOW(), NOW()
          )
        `;
      }

      const finalCounts = await sql<{ total: string; gated: string }[]>`
        SELECT 
          COUNT(*)::text as total,
          COUNT(*) FILTER (WHERE gated_at IS NOT NULL)::text as gated
        FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID_OFF}
      `;
      expect(parseInt(finalCounts[0].total)).toBe(50);
      expect(parseInt(finalCounts[0].gated)).toBe(0);

      if (originalEnv === undefined) {
        delete (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED;
      } else {
        (process.env as Record<string, string>).PLAN_GATING_ENFORCED = originalEnv;
      }
    });
  });

  describe("(g) processBulkCustomer path gates at the limit", () => {
    const SHOP_ID = `shop-bulk-customer-${TEST_SUFFIX}`;
    const SHOP_DOMAIN = `test-bulk-customer-${TEST_SUFFIX}.myshopify.com`;
    const TAG_RULE_ID = `tag-rule-${TEST_SUFFIX}`;
    let originalEnv: string | undefined;

    beforeAll(async () => {
      originalEnv = process.env.PLAN_GATING_ENFORCED;
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, plan_cached_at, "createdAt", "updatedAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'starter', '2026-01-01 00:00:00', NOW(), NOW())
      `;

      await sql`
        INSERT INTO "AccountSource" (id, "shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
        VALUES (${TAG_RULE_ID}, ${SHOP_ID}, 'net-terms', 30, NOW(), NOW())
      `;
    });

    afterAll(async () => {
      if (originalEnv === undefined) {
        delete (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED;
      } else {
        (process.env as Record<string, string>).PLAN_GATING_ENFORCED = originalEnv;
      }
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${SHOP_ID}`;
      await sql`DELETE FROM "AccountSource" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
    });

    beforeEach(async () => {
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${SHOP_ID}`;
    });

    it("processBulkCustomer creates gated account when at limit", async () => {
      for (let i = 1; i <= 25; i++) {
        const accountId = `acc-bulk-cust-fill-${i}-${TEST_SUFFIX}`;
        const customerId = `gid://shopify/Customer/fill-${i}-${TEST_SUFFIX}`;
        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "customerId", name,
            "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
            "syncPending", "syncVersion", "createdAt", "updatedAt"
          )
          VALUES (
            ${accountId}, ${SHOP_ID}, 'TAGGED_CUSTOMER',
            ${customerId}, ${'Fill Customer ' + i},
            100000.00, 'OK', false, false, 30, 'tag',
            false, 1, NOW(), NOW()
          )
        `;
      }

      const { processBulkCustomer } = await import("../sync/customer.server");

      const customer = {
        id: `gid://shopify/Customer/bulk-over-limit-${TEST_SUFFIX}`,
        tags: ["net-terms"],
        email: null,
        displayName: null,
      };

      const result = await processBulkCustomer(sql, SHOP_DOMAIN, customer, "disabled");

      expect(result.success).toBe(true);
      expect(result.action).toBe("gated");
      expect(result.entityId).toBeDefined();

      const [createdAccount] = await sql<{ gated_at: Date | null }[]>`
        SELECT gated_at FROM "BuyerAccount"
        WHERE "customerId" = ${customer.id}
      `;
      expect(createdAccount).toBeDefined();
      expect(createdAccount.gated_at).not.toBeNull();
    });

    it("processBulkCustomer creates ungated account when under limit", async () => {
      for (let i = 1; i <= 20; i++) {
        const accountId = `acc-bulk-cust-under-${i}-${TEST_SUFFIX}`;
        const customerId = `gid://shopify/Customer/under-${i}-${TEST_SUFFIX}`;
        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "customerId", name,
            "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
            "syncPending", "syncVersion", "createdAt", "updatedAt"
          )
          VALUES (
            ${accountId}, ${SHOP_ID}, 'TAGGED_CUSTOMER',
            ${customerId}, ${'Fill Customer ' + i},
            100000.00, 'OK', false, false, 30, 'tag',
            false, 1, NOW(), NOW()
          )
        `;
      }

      const { processBulkCustomer } = await import("../sync/customer.server");

      const customer = {
        id: `gid://shopify/Customer/bulk-under-limit-${TEST_SUFFIX}`,
        tags: ["net-terms"],
        email: null,
        displayName: null,
      };

      const result = await processBulkCustomer(sql, SHOP_DOMAIN, customer, "disabled");

      expect(result.success).toBe(true);
      expect(result.action).toBe("created");

      const [createdAccount] = await sql<{ gated_at: Date | null }[]>`
        SELECT gated_at FROM "BuyerAccount"
        WHERE "customerId" = ${customer.id}
      `;
      expect(createdAccount).toBeDefined();
      expect(createdAccount.gated_at).toBeNull();
    });

    it("processBulkCustomer with multiple customers straddling limit", async () => {
      for (let i = 1; i <= 23; i++) {
        const accountId = `acc-bulk-cust-straddle-${i}-${TEST_SUFFIX}`;
        const customerId = `gid://shopify/Customer/straddle-${i}-${TEST_SUFFIX}`;
        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "customerId", name,
            "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
            "syncPending", "syncVersion", "createdAt", "updatedAt"
          )
          VALUES (
            ${accountId}, ${SHOP_ID}, 'TAGGED_CUSTOMER',
            ${customerId}, ${'Fill Customer ' + i},
            100000.00, 'OK', false, false, 30, 'tag',
            false, 1, NOW(), NOW()
          )
        `;
      }

      const { processBulkCustomer } = await import("../sync/customer.server");

      const customers = [
        { id: `gid://shopify/Customer/straddle-new-1-${TEST_SUFFIX}`, tags: ["net-terms"], email: null, displayName: null },
        { id: `gid://shopify/Customer/straddle-new-2-${TEST_SUFFIX}`, tags: ["net-terms"], email: null, displayName: null },
        { id: `gid://shopify/Customer/straddle-new-3-${TEST_SUFFIX}`, tags: ["net-terms"], email: null, displayName: null },
        { id: `gid://shopify/Customer/straddle-new-4-${TEST_SUFFIX}`, tags: ["net-terms"], email: null, displayName: null },
      ];

      const results = [];
      for (const customer of customers) {
        const result = await processBulkCustomer(sql, SHOP_DOMAIN, customer, "disabled");
        results.push(result);
      }

      expect(results.every(r => r.success)).toBe(true);

      const createdAccounts = await sql<{ customerId: string; gated_at: Date | null }[]>`
        SELECT "customerId", gated_at FROM "BuyerAccount"
        WHERE "shopId" = ${SHOP_ID}
          AND "customerId" LIKE ${'%straddle-new-%'}
        ORDER BY "customerId"
      `;

      expect(createdAccounts.length).toBe(4);

      const ungatedCount = createdAccounts.filter(a => a.gated_at === null).length;
      const gatedCount = createdAccounts.filter(a => a.gated_at !== null).length;

      expect(ungatedCount).toBe(2);
      expect(gatedCount).toBe(2);
    });
  });

  describe("(h) none=0 gates first account", () => {
    const SHOP_ID = `shop-none-plan-${TEST_SUFFIX}`;
    const SHOP_DOMAIN = `test-none-plan-${TEST_SUFFIX}.myshopify.com`;
    let originalEnv: string | undefined;

    beforeAll(async () => {
      originalEnv = process.env.PLAN_GATING_ENFORCED;
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, plan_cached_at, "createdAt", "updatedAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'none', '2026-01-01 00:00:00', NOW(), NOW())
      `;
    });

    afterAll(async () => {
      if (originalEnv === undefined) {
        delete (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED;
      } else {
        (process.env as Record<string, string>).PLAN_GATING_ENFORCED = originalEnv;
      }
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%' + TEST_SUFFIX + '%'}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
    });

    it("none plan (limit=0) gates the very first account", async () => {
      const { checkCompanyLimit, isGatingEnforced } = await import("../gating.server");
      expect(isGatingEnforced()).toBe(true);

      const limitCheck = await checkCompanyLimit(sql, SHOP_ID);
      expect(limitCheck.allowed).toBe(false);
      expect(limitCheck.currentUsage).toBe(0);
      expect(limitCheck.limit).toBe(0);

      const { processCompanyLocationWebhook } = await import("../sync/company-location.server");
      const webhookId = `webhook-none-first-${TEST_SUFFIX}`;
      const location = {
        id: `gid://shopify/CompanyLocation/none-first-${TEST_SUFFIX}`,
        company: { id: `gid://shopify/Company/none-first-${TEST_SUFFIX}` },
        name: "First Account on None Plan",
        billingAddress: null,
        buyerExperienceConfiguration: null,
      };

      const result = await processCompanyLocationWebhook(
        sql,
        SHOP_DOMAIN,
        "COMPANY_LOCATIONS_CREATE",
        location,
        webhookId,
        {}
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("gated");

      const [createdAccount] = await sql<{ gated_at: Date | null }[]>`
        SELECT gated_at FROM "BuyerAccount"
        WHERE "companyLocationId" = ${location.id}
      `;
      expect(createdAccount).toBeDefined();
      expect(createdAccount.gated_at).not.toBeNull();
    });
  });

  describe("(i) flag-off: no sql.begin called (spied)", () => {
    const SHOP_ID = `shop-flagoff-notx-${TEST_SUFFIX}`;
    const SHOP_DOMAIN = `test-flagoff-notx-${TEST_SUFFIX}.myshopify.com`;
    let originalEnv: string | undefined;
    let beginSpy: ReturnType<typeof vi.spyOn>;

    beforeAll(async () => {
      originalEnv = process.env.PLAN_GATING_ENFORCED;
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, plan_cached_at, "createdAt", "updatedAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'none', '2026-01-01 00:00:00', NOW(), NOW())
      `;
    });

    afterAll(async () => {
      if (originalEnv === undefined) {
        delete (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED;
      } else {
        (process.env as Record<string, string>).PLAN_GATING_ENFORCED = originalEnv;
      }
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%' + TEST_SUFFIX + '%'}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
    });

    beforeEach(async () => {
      vi.resetModules();
      beginSpy = vi.spyOn(sql, "begin");
    });

    afterEach(() => {
      beginSpy.mockRestore();
    });

    it("processCompanyLocationWebhook flag-off: sql.begin not called, account ungated", async () => {
      const { processCompanyLocationWebhook } = await import("../sync/company-location.server");
      const webhookId = `webhook-flagoff-notx-${TEST_SUFFIX}`;
      const location = {
        id: `gid://shopify/CompanyLocation/flagoff-notx-${TEST_SUFFIX}`,
        company: { id: `gid://shopify/Company/flagoff-notx-${TEST_SUFFIX}` },
        name: "Flag Off No Transaction",
        billingAddress: null,
        buyerExperienceConfiguration: null,
      };

      const result = await processCompanyLocationWebhook(
        sql,
        SHOP_DOMAIN,
        "COMPANY_LOCATIONS_CREATE",
        location,
        webhookId,
        {}
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("created");
      expect(beginSpy).not.toHaveBeenCalled();

      const [createdAccount] = await sql<{ gated_at: Date | null }[]>`
        SELECT gated_at FROM "BuyerAccount"
        WHERE "companyLocationId" = ${location.id}
      `;
      expect(createdAccount).toBeDefined();
      expect(createdAccount.gated_at).toBeNull();
    });

    it("bulkUpsertBuyerAccounts flag-off: sql.begin not called, all accounts ungated", async () => {
      beginSpy.mockClear();
      const { bulkUpsertBuyerAccounts, mapCompanyLocationToBuyerAccount } = await import("../sync/company-location.server");

      const newLocations = [];
      for (let i = 1; i <= 5; i++) {
        newLocations.push({
          id: `gid://shopify/CompanyLocation/flagoff-bulk-${i}-${TEST_SUFFIX}`,
          company: { id: `gid://shopify/Company/flagoff-bulk-${i}-${TEST_SUFFIX}` },
          name: `Flag Off Bulk ${i}`,
          billingAddress: null,
          buyerExperienceConfiguration: null,
        });
      }

      const mappedAccounts = newLocations.map((loc) => mapCompanyLocationToBuyerAccount(SHOP_ID, loc, {}));

      const upsertCount = await bulkUpsertBuyerAccounts(sql, mappedAccounts);
      expect(upsertCount).toBe(5);
      expect(beginSpy).not.toHaveBeenCalled();

      const results = await sql<{ gated_at: Date | null }[]>`
        SELECT gated_at FROM "BuyerAccount"
        WHERE "shopId" = ${SHOP_ID}
          AND "companyLocationId" LIKE ${'%flagoff-bulk-%'}
      `;

      expect(results.length).toBe(5);
      expect(results.every(r => r.gated_at === null)).toBe(true);
    });

    it("processBulkCustomer flag-off: sql.begin not called, account ungated", async () => {
      beginSpy.mockClear();
      const TAG_RULE_ID = `tag-rule-flagoff-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "AccountSource" (id, "shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
        VALUES (${TAG_RULE_ID}, ${SHOP_ID}, 'wholesale', 30, NOW(), NOW())
        ON CONFLICT DO NOTHING
      `;

      const { processBulkCustomer } = await import("../sync/customer.server");

      const customer = {
        id: `gid://shopify/Customer/flagoff-bulk-${TEST_SUFFIX}`,
        tags: ["wholesale"],
        email: null,
        displayName: null,
      };

      const result = await processBulkCustomer(sql, SHOP_DOMAIN, customer, "disabled");

      expect(result.success).toBe(true);
      expect(result.action).toBe("created");
      expect(beginSpy).not.toHaveBeenCalled();

      const [createdAccount] = await sql<{ gated_at: Date | null }[]>`
        SELECT gated_at FROM "BuyerAccount"
        WHERE "customerId" = ${customer.id}
      `;
      expect(createdAccount).toBeDefined();
      expect(createdAccount.gated_at).toBeNull();
    });
  });

  describe("(j) unlimited plan (-1): no sql.begin called (spied)", () => {
    const SHOP_ID = `shop-unlimited-notx-${TEST_SUFFIX}`;
    const SHOP_DOMAIN = `test-unlimited-notx-${TEST_SUFFIX}.myshopify.com`;
    let originalEnv: string | undefined;
    let beginSpy: ReturnType<typeof vi.spyOn>;

    beforeAll(async () => {
      originalEnv = process.env.PLAN_GATING_ENFORCED;
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, plan_cached_at, "createdAt", "updatedAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'unlimited', '2026-01-01 00:00:00', NOW(), NOW())
      `;
    });

    afterAll(async () => {
      if (originalEnv === undefined) {
        delete (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED;
      } else {
        (process.env as Record<string, string>).PLAN_GATING_ENFORCED = originalEnv;
      }
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%' + TEST_SUFFIX + '%'}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
    });

    beforeEach(async () => {
      vi.resetModules();
      beginSpy = vi.spyOn(sql, "begin");
    });

    afterEach(() => {
      beginSpy.mockRestore();
    });

    it("processCompanyLocationWebhook unlimited: sql.begin not called, account ungated", async () => {
      const { processCompanyLocationWebhook } = await import("../sync/company-location.server");
      const webhookId = `webhook-unlimited-notx-${TEST_SUFFIX}`;
      const location = {
        id: `gid://shopify/CompanyLocation/unlimited-notx-${TEST_SUFFIX}`,
        company: { id: `gid://shopify/Company/unlimited-notx-${TEST_SUFFIX}` },
        name: "Unlimited No Transaction",
        billingAddress: null,
        buyerExperienceConfiguration: null,
      };

      const result = await processCompanyLocationWebhook(
        sql,
        SHOP_DOMAIN,
        "COMPANY_LOCATIONS_CREATE",
        location,
        webhookId,
        {}
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("created");
      expect(beginSpy).not.toHaveBeenCalled();

      const [createdAccount] = await sql<{ gated_at: Date | null }[]>`
        SELECT gated_at FROM "BuyerAccount"
        WHERE "companyLocationId" = ${location.id}
      `;
      expect(createdAccount).toBeDefined();
      expect(createdAccount.gated_at).toBeNull();
    });

    it("bulkUpsertBuyerAccounts unlimited: sql.begin not called, all accounts ungated", async () => {
      beginSpy.mockClear();
      const { bulkUpsertBuyerAccounts, mapCompanyLocationToBuyerAccount } = await import("../sync/company-location.server");

      const newLocations = [];
      for (let i = 1; i <= 30; i++) {
        newLocations.push({
          id: `gid://shopify/CompanyLocation/unlimited-bulk-${i}-${TEST_SUFFIX}`,
          company: { id: `gid://shopify/Company/unlimited-bulk-${i}-${TEST_SUFFIX}` },
          name: `Unlimited Bulk ${i}`,
          billingAddress: null,
          buyerExperienceConfiguration: null,
        });
      }

      const mappedAccounts = newLocations.map((loc) => mapCompanyLocationToBuyerAccount(SHOP_ID, loc, {}));

      const upsertCount = await bulkUpsertBuyerAccounts(sql, mappedAccounts);
      expect(upsertCount).toBe(30);
      expect(beginSpy).not.toHaveBeenCalled();

      const results = await sql<{ gated_at: Date | null }[]>`
        SELECT gated_at FROM "BuyerAccount"
        WHERE "shopId" = ${SHOP_ID}
          AND "companyLocationId" LIKE ${'%unlimited-bulk-%'}
      `;

      expect(results.length).toBe(30);
      expect(results.every(r => r.gated_at === null)).toBe(true);
    });

    it("processBulkCustomer unlimited: sql.begin not called, account ungated", async () => {
      beginSpy.mockClear();
      const TAG_RULE_ID = `tag-rule-unlimited-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "AccountSource" (id, "shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
        VALUES (${TAG_RULE_ID}, ${SHOP_ID}, 'wholesale', 30, NOW(), NOW())
        ON CONFLICT DO NOTHING
      `;

      const { processBulkCustomer } = await import("../sync/customer.server");

      const customer = {
        id: `gid://shopify/Customer/unlimited-bulk-${TEST_SUFFIX}`,
        tags: ["wholesale"],
        email: null,
        displayName: null,
      };

      const result = await processBulkCustomer(sql, SHOP_DOMAIN, customer, "disabled");

      expect(result.success).toBe(true);
      expect(result.action).toBe("created");
      expect(beginSpy).not.toHaveBeenCalled();

      const [createdAccount] = await sql<{ gated_at: Date | null }[]>`
        SELECT gated_at FROM "BuyerAccount"
        WHERE "customerId" = ${customer.id}
      `;
      expect(createdAccount).toBeDefined();
      expect(createdAccount.gated_at).toBeNull();
    });
  });

  describe("(k) downgrade from Growth to Starter with 60 rows gates 0 existing", () => {
    const SHOP_ID = `shop-downgrade-${TEST_SUFFIX}`;
    const SHOP_DOMAIN = `test-downgrade-${TEST_SUFFIX}.myshopify.com`;
    let originalEnv: string | undefined;

    beforeAll(async () => {
      originalEnv = process.env.PLAN_GATING_ENFORCED;
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, plan_cached_at, "createdAt", "updatedAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'growth', '2026-01-01 00:00:00', NOW(), NOW())
      `;
    });

    afterAll(async () => {
      if (originalEnv === undefined) {
        delete (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED;
      } else {
        (process.env as Record<string, string>).PLAN_GATING_ENFORCED = originalEnv;
      }
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
    });

    it("downgrading from Growth to Starter with 60 existing accounts gates 0 existing", async () => {
      for (let i = 1; i <= 60; i++) {
        const accountId = `acc-downgrade-${i}-${TEST_SUFFIX}`;
        const locationId = `gid://shopify/CompanyLocation/downgrade-${i}-${TEST_SUFFIX}`;
        const companyId = `gid://shopify/Company/downgrade-${i}-${TEST_SUFFIX}`;
        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "companyId", "companyLocationId", name,
            "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
            "syncPending", "syncVersion", "createdAt", "updatedAt"
          )
          VALUES (
            ${accountId}, ${SHOP_ID}, 'COMPANY',
            ${companyId}, ${locationId}, ${'Downgrade Account ' + i},
            100000.00, 'OK', false, false, 30, 'explicit',
            false, 1, NOW(), NOW()
          )
        `;
      }

      const [beforeDowngrade] = await sql<{ ungated: string; gated: string }[]>`
        SELECT 
          COUNT(*) FILTER (WHERE gated_at IS NULL)::text as ungated,
          COUNT(*) FILTER (WHERE gated_at IS NOT NULL)::text as gated
        FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}
      `;
      expect(parseInt(beforeDowngrade.ungated)).toBe(60);
      expect(parseInt(beforeDowngrade.gated)).toBe(0);

      await sql`UPDATE "Shop" SET plan_key = 'starter' WHERE id = ${SHOP_ID}`;

      const [afterDowngrade] = await sql<{ ungated: string; gated: string }[]>`
        SELECT 
          COUNT(*) FILTER (WHERE gated_at IS NULL)::text as ungated,
          COUNT(*) FILTER (WHERE gated_at IS NOT NULL)::text as gated
        FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}
      `;
      expect(parseInt(afterDowngrade.ungated)).toBe(60);
      expect(parseInt(afterDowngrade.gated)).toBe(0);

      const { checkCompanyLimit } = await import("../gating.server");
      const limitCheck = await checkCompanyLimit(sql, SHOP_ID);
      expect(limitCheck.allowed).toBe(false);
      expect(limitCheck.currentUsage).toBe(60);
      expect(limitCheck.limit).toBe(25);

      const { processCompanyLocationWebhook } = await import("../sync/company-location.server");
      const webhookId = `webhook-after-downgrade-${TEST_SUFFIX}`;
      const location = {
        id: `gid://shopify/CompanyLocation/after-downgrade-${TEST_SUFFIX}`,
        company: { id: `gid://shopify/Company/after-downgrade-${TEST_SUFFIX}` },
        name: "Account After Downgrade",
        billingAddress: null,
        buyerExperienceConfiguration: null,
      };

      const result = await processCompanyLocationWebhook(
        sql,
        SHOP_DOMAIN,
        "COMPANY_LOCATIONS_CREATE",
        location,
        webhookId,
        {}
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("gated");

      const [finalCounts] = await sql<{ ungated: string; gated: string }[]>`
        SELECT 
          COUNT(*) FILTER (WHERE gated_at IS NULL)::text as ungated,
          COUNT(*) FILTER (WHERE gated_at IS NOT NULL)::text as gated
        FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}
      `;
      expect(parseInt(finalCounts.ungated)).toBe(60);
      expect(parseInt(finalCounts.gated)).toBe(1);
    });
  });

  describe("(l) positive control: flag-on limit=0 uses sql.begin and gates accounts", () => {
    const SHOP_ID = `shop-positive-${TEST_SUFFIX}`;
    const SHOP_DOMAIN = `test-positive-${TEST_SUFFIX}.myshopify.com`;
    let originalEnv: string | undefined;
    let beginSpy: ReturnType<typeof vi.spyOn>;

    beforeAll(async () => {
      originalEnv = process.env.PLAN_GATING_ENFORCED;
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, plan_cached_at, "createdAt", "updatedAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'none', '2026-01-01 00:00:00', NOW(), NOW())
      `;

      await sql`
        INSERT INTO "AccountSource" (id, "shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
        VALUES (${'tag-rule-positive-' + TEST_SUFFIX}, ${SHOP_ID}, 'wholesale', 30, NOW(), NOW())
      `;
    });

    afterAll(async () => {
      if (originalEnv === undefined) {
        delete (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED;
      } else {
        (process.env as Record<string, string>).PLAN_GATING_ENFORCED = originalEnv;
      }
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%positive%' + TEST_SUFFIX + '%'}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM "AccountSource" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
    });

    beforeEach(async () => {
      vi.resetModules();
      beginSpy = vi.spyOn(sql, "begin");
    });

    afterEach(() => {
      beginSpy.mockRestore();
    });

    it("processCompanyLocationWebhook flag-on limit=0: sql.begin called, account gated", async () => {
      const { processCompanyLocationWebhook } = await import("../sync/company-location.server");
      const webhookId = `webhook-positive-company-${TEST_SUFFIX}`;
      const location = {
        id: `gid://shopify/CompanyLocation/positive-company-${TEST_SUFFIX}`,
        company: { id: `gid://shopify/Company/positive-company-${TEST_SUFFIX}` },
        name: "Positive Control Company",
        billingAddress: null,
        buyerExperienceConfiguration: null,
      };

      const result = await processCompanyLocationWebhook(
        sql,
        SHOP_DOMAIN,
        "COMPANY_LOCATIONS_CREATE",
        location,
        webhookId,
        {}
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("gated");
      expect(beginSpy).toHaveBeenCalled();

      const [createdAccount] = await sql<{ gated_at: Date | null }[]>`
        SELECT gated_at FROM "BuyerAccount"
        WHERE "companyLocationId" = ${location.id}
      `;
      expect(createdAccount).toBeDefined();
      expect(createdAccount.gated_at).not.toBeNull();
    });

    it("bulkUpsertBuyerAccounts flag-on limit=0: sql.begin called, all accounts gated", async () => {
      beginSpy.mockClear();
      const { bulkUpsertBuyerAccounts, mapCompanyLocationToBuyerAccount } = await import("../sync/company-location.server");

      const newLocations = [];
      for (let i = 1; i <= 3; i++) {
        newLocations.push({
          id: `gid://shopify/CompanyLocation/positive-bulk-${i}-${TEST_SUFFIX}`,
          company: { id: `gid://shopify/Company/positive-bulk-${i}-${TEST_SUFFIX}` },
          name: `Positive Bulk ${i}`,
          billingAddress: null,
          buyerExperienceConfiguration: null,
        });
      }

      const mappedAccounts = newLocations.map((loc) => mapCompanyLocationToBuyerAccount(SHOP_ID, loc, {}));

      const upsertCount = await bulkUpsertBuyerAccounts(sql, mappedAccounts);
      expect(upsertCount).toBe(3);
      expect(beginSpy).toHaveBeenCalled();

      const results = await sql<{ gated_at: Date | null }[]>`
        SELECT gated_at FROM "BuyerAccount"
        WHERE "shopId" = ${SHOP_ID}
          AND "companyLocationId" LIKE ${'%positive-bulk-%'}
      `;

      expect(results.length).toBe(3);
      expect(results.every(r => r.gated_at !== null)).toBe(true);
    });

    it("processBulkCustomer flag-on limit=0: sql.begin called, account gated", async () => {
      beginSpy.mockClear();
      const { processBulkCustomer } = await import("../sync/customer.server");

      const customer = {
        id: `gid://shopify/Customer/positive-bulk-${TEST_SUFFIX}`,
        tags: ["wholesale"],
        email: null,
        displayName: null,
      };

      const result = await processBulkCustomer(sql, SHOP_DOMAIN, customer, "disabled");

      expect(result.success).toBe(true);
      expect(result.action).toBe("gated");
      expect(beginSpy).toHaveBeenCalled();

      const [createdAccount] = await sql<{ gated_at: Date | null }[]>`
        SELECT gated_at FROM "BuyerAccount"
        WHERE "customerId" = ${customer.id}
      `;
      expect(createdAccount).toBeDefined();
      expect(createdAccount.gated_at).not.toBeNull();
    });
  });

  describe("(m) Ruling (b): unconfirmed shop (plan_cached_at NULL) is not gated", () => {
    const SHOP_ID = `shop-unconfirmed-${TEST_SUFFIX}`;
    const SHOP_DOMAIN = `test-unconfirmed-${TEST_SUFFIX}.myshopify.com`;
    let originalEnv: string | undefined;

    beforeAll(async () => {
      originalEnv = process.env.PLAN_GATING_ENFORCED;
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, plan_cached_at, "createdAt", "updatedAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'none', NULL, NOW(), NOW())
      `;
    });

    afterAll(async () => {
      if (originalEnv === undefined) {
        delete (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED;
      } else {
        (process.env as Record<string, string>).PLAN_GATING_ENFORCED = originalEnv;
      }
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%unconfirmed%' + TEST_SUFFIX + '%'}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
    });

    it("unconfirmed shop (plan_cached_at NULL) with none plan creates ungated account despite limit=0", async () => {
      const { checkCompanyLimit, isGatingEnforced } = await import("../gating.server");
      expect(isGatingEnforced()).toBe(true);

      const limitCheck = await checkCompanyLimit(sql, SHOP_ID);
      expect(limitCheck.allowed).toBe(true);
      expect(limitCheck.reason).toContain("Plan not confirmed");

      const { processCompanyLocationWebhook } = await import("../sync/company-location.server");
      const webhookId = `webhook-unconfirmed-${TEST_SUFFIX}`;
      const location = {
        id: `gid://shopify/CompanyLocation/unconfirmed-${TEST_SUFFIX}`,
        company: { id: `gid://shopify/Company/unconfirmed-${TEST_SUFFIX}` },
        name: "Account on Unconfirmed Shop",
        billingAddress: null,
        buyerExperienceConfiguration: null,
      };

      const result = await processCompanyLocationWebhook(
        sql,
        SHOP_DOMAIN,
        "COMPANY_LOCATIONS_CREATE",
        location,
        webhookId,
        {}
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("created");

      const [createdAccount] = await sql<{ gated_at: Date | null }[]>`
        SELECT gated_at FROM "BuyerAccount"
        WHERE "companyLocationId" = ${location.id}
      `;
      expect(createdAccount).toBeDefined();
      expect(createdAccount.gated_at).toBeNull();
    });
  });
});
