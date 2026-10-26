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
 *    - Reconcile (enqueueReconcileForAllShops excludes uninstalled shops)
 *    - Compliance webhooks (customers/data_request, customers/redact)
 * 5. Cross-isolate reinstall: clearUninstalledAtAndMetafieldErrors clears uninstalledAt
 *    even when shop is in setupCompletedShops cache
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
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
      await upsertShopOnAuth(sql, TEST_SHOP_DOMAIN, TEST_TIMEZONE, "INR");

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
      await upsertShopOnAuth(sql, TEST_SHOP_DOMAIN_2, TEST_TIMEZONE, "INR");

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
      
      await upsertShopOnAuth(sql, TEST_SHOP_DOMAIN_3, TEST_TIMEZONE, "INR");
      await upsertShopOnAuth(sql, TEST_SHOP_DOMAIN_3, "Asia/Kolkata", "INR");

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
      
      await upsertShopOnAuth(sql, TEST_SHOP_DOMAIN_TZ, "America/New_York", "INR");

      const [before] = await sql<{ timezone: string }[]>`
        SELECT timezone FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN_TZ}
      `;
      expect(before.timezone).toBe("America/New_York");

      await upsertShopOnAuth(sql, TEST_SHOP_DOMAIN_TZ, null, "INR");

      const [after] = await sql<{ timezone: string }[]>`
        SELECT timezone FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN_TZ}
      `;
      expect(after.timezone).toBe("America/New_York");
    });

    it("fresh install with failed tz query gets default timezone", async () => {
      const { upsertShopOnAuth } = await import("../after-auth.server");
      const FRESH_SHOP = `fresh-tz-fail-${TEST_SUFFIX}.myshopify.com`;
      
      await upsertShopOnAuth(sql, FRESH_SHOP, null, "INR");

      const [shop] = await sql<{ timezone: string }[]>`
        SELECT timezone FROM "Shop" WHERE domain = ${FRESH_SHOP}
      `;
      expect(shop.timezone).toBe("Asia/Kolkata");
    });
  });
});

describeWithDb("clearUninstalledAtAndMetafieldErrors cross-isolate reinstall (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-clearuninstalled";

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

  describe("clears uninstalledAt even when shop is in cache", () => {
    it("clearUninstalledAtAndMetafieldErrors clears uninstalledAt for shop marked uninstalled", async () => {
      const TEST_SHOP = `cached-reinstall-${TEST_SUFFIX}.myshopify.com`;
      
      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "uninstalledAt", "createdAt", "updatedAt")
        VALUES (${TEST_SHOP}, 'America/New_York', 'INR', 'starter', NOW(), NOW(), NOW())
      `;

      const [before] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(before.uninstalledAt).not.toBeNull();

      const { _clearUninstalledAtAndMetafieldErrorsForTesting } = await import("../after-auth.server");
      await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, TEST_SHOP);

      const [after] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(after.uninstalledAt).toBeNull();
    });
  });

  describe("does not touch other columns", () => {
    it("clearUninstalledAtAndMetafieldErrors only clears uninstalledAt, preserves plan/timezone/other columns", async () => {
      const TEST_SHOP = `preserve-columns-${TEST_SUFFIX}.myshopify.com`;
      
      await sql`
        INSERT INTO "Shop" (
          domain, timezone, currency, plan_key, "defaultTermsDays",
          "uninstalledAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${TEST_SHOP}, 'America/Los_Angeles', 'USD', 'growth', 45,
          NOW(), NOW(), NOW()
        )
      `;

      const [before] = await sql<{
        timezone: string;
        currency: string;
        plan_key: string;
        defaultTermsDays: number | null;
        updatedAt: Date;
      }[]>`
        SELECT timezone, currency, plan_key, "defaultTermsDays", "updatedAt"
        FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;

      const { _clearUninstalledAtAndMetafieldErrorsForTesting } = await import("../after-auth.server");
      await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, TEST_SHOP);

      const [after] = await sql<{
        timezone: string;
        currency: string;
        plan_key: string;
        defaultTermsDays: number | null;
        uninstalledAt: Date | null;
        updatedAt: Date;
      }[]>`
        SELECT timezone, currency, plan_key, "defaultTermsDays", "uninstalledAt", "updatedAt"
        FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;

      expect(after.uninstalledAt).toBeNull();
      expect(after.timezone).toBe(before.timezone);
      expect(after.currency).toBe(before.currency);
      expect(after.plan_key).toBe(before.plan_key);
      expect(after.defaultTermsDays).toBe(before.defaultTermsDays);
      // updatedAt is updated by the Shop_updatedAt trigger on any UPDATE
      expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
    });
  });

  describe("does not touch other shops", () => {
    it("clearUninstalledAtAndMetafieldErrors does not affect another shop's uninstalledAt", async () => {
      const SHOP_A = `shop-a-${TEST_SUFFIX}.myshopify.com`;
      const SHOP_B = `shop-b-${TEST_SUFFIX}.myshopify.com`;
      
      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "uninstalledAt", "createdAt", "updatedAt")
        VALUES 
          (${SHOP_A}, 'UTC', 'INR', 'free', NOW(), NOW(), NOW()),
          (${SHOP_B}, 'UTC', 'INR', 'free', NOW(), NOW(), NOW())
      `;

      const { _clearUninstalledAtAndMetafieldErrorsForTesting } = await import("../after-auth.server");
      await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, SHOP_A);

      const [shopA] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE domain = ${SHOP_A}
      `;
      const [shopB] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE domain = ${SHOP_B}
      `;

      expect(shopA.uninstalledAt).toBeNull();
      expect(shopB.uninstalledAt).not.toBeNull();
    });
  });

  describe("is a no-op when uninstalledAt is already NULL", () => {
    it("clearUninstalledAtAndMetafieldErrors does nothing when shop is not uninstalled", async () => {
      const TEST_SHOP = `not-uninstalled-${TEST_SUFFIX}.myshopify.com`;
      
      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP}, 'UTC', 'INR', 'free', NOW(), NOW())
      `;

      const [before] = await sql<{ updatedAt: Date }[]>`
        SELECT "updatedAt" FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;

      const { _clearUninstalledAtAndMetafieldErrorsForTesting } = await import("../after-auth.server");
      await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, TEST_SHOP);

      const [after] = await sql<{ updatedAt: Date; uninstalledAt: Date | null }[]>`
        SELECT "updatedAt", "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;

      expect(after.uninstalledAt).toBeNull();
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    });
  });

  describe("concurrent reinstall atomicity", () => {
    afterEach(() => {
      vi.doUnmock("../validation-registration.server");
      vi.doUnmock("../metafield-definitions.server");
      vi.doUnmock("../payment-customization-registration.server");
      vi.doUnmock("../request-context.server");
      vi.doUnmock("~/services/plan.server");
      vi.resetModules();
    });

    it("two concurrent clearUninstalledAtAndMetafieldErrors: exactly one gets RETURNING row", async () => {
      const TEST_SHOP = `concurrent-atomicity-${TEST_SUFFIX}.myshopify.com`;
      
      // Create shop with uninstalledAt set
      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "uninstalledAt", "createdAt", "updatedAt")
        VALUES (${TEST_SHOP}, 'UTC', 'INR', 'free', NOW(), NOW(), NOW())
      `;

      const [before] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(before.uninstalledAt).not.toBeNull();

      const { _clearUninstalledAtAndMetafieldErrorsForTesting } = await import("../after-auth.server");

      // Run two concurrent clearUninstalledAtAndMetafieldErrors calls with Promise.all
      // This simulates two isolates receiving the same reinstall simultaneously
      const [result1, result2] = await Promise.all([
        _clearUninstalledAtAndMetafieldErrorsForTesting(sql, TEST_SHOP),
        _clearUninstalledAtAndMetafieldErrorsForTesting(sql, TEST_SHOP),
      ]);

      // Count how many calls got the RETURNING row (wasReinstalled=true)
      const reinstallWinners = [result1, result2].filter(r => r.wasReinstalled);
      const normalPathTakers = [result1, result2].filter(r => !r.wasReinstalled);

      // EXACTLY ONE call should get the RETURNING row (reinstall path winner)
      expect(reinstallWinners).toHaveLength(1);
      // The other call should get empty (normal path - row already cleared)
      expect(normalPathTakers).toHaveLength(1);

      // Both should have same shop ID (the winner got it, loser has undefined)
      expect(reinstallWinners[0].shopId).toBeDefined();
      expect(normalPathTakers[0].shopId).toBeUndefined();

      // Verify the shop is now cleared
      const [after] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(after.uninstalledAt).toBeNull();
    });

    it("concurrent reinstall: registration runs exactly once due to inFlightSetups deduplication", async () => {
      const TEST_SHOP = `concurrent-registration-${TEST_SUFFIX}.myshopify.com`;
      
      // Create shop with uninstalledAt set
      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "uninstalledAt", "createdAt", "updatedAt")
        VALUES (${TEST_SHOP}, 'UTC', 'INR', 'free', NOW(), NOW(), NOW())
      `;

      // Track registration calls
      let registrationCallCount = 0;
      const mockEnsureValidation = vi.fn().mockImplementation(async () => {
        registrationCallCount++;
        // Add delay to increase chance of concurrent execution
        await new Promise(r => setTimeout(r, 20));
        return { id: "val-123", created: false };
      });

      // Mock using relative paths that match after-auth.server.ts imports
      vi.doMock("../validation-registration.server", () => ({
        ensureValidation: mockEnsureValidation,
      }));
      vi.doMock("../metafield-definitions.server", () => ({
        ensureMetafieldDefinitions: vi.fn().mockResolvedValue([]),
      }));
      vi.doMock("../payment-customization-registration.server", () => ({
        ensurePaymentCustomization: vi.fn().mockResolvedValue({ id: "pc-123", created: false }),
      }));
      vi.doMock("../request-context.server", () => ({
        getRequestSql: vi.fn(() => sql),
      }));
      vi.doMock("~/services/plan.server", () => ({
        refreshPlanCache: vi.fn().mockResolvedValue(undefined),
      }));

      vi.resetModules();
      const { runAfterAuth, _resetSetupCacheForTesting } = await import("../after-auth.server");
      _resetSetupCacheForTesting();

      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: () => Promise.resolve({ data: { shop: { ianaTimezone: "America/New_York" } } }),
        }),
      };
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p: Promise<unknown>) => waitUntilPromises.push(p));

      // Run two concurrent runAfterAuth calls - both will race on clearUninstalledAtAndMetafieldErrors
      // One wins the SQL RETURNING row (wasReinstalled=true), the other loses (wasReinstalled=false)
      // With the inFlightSetups deduplication fix, the loser should wait on the winner's promise
      await Promise.all([
        runAfterAuth(TEST_SHOP, mockAdmin as Parameters<typeof runAfterAuth>[1], mockWaitUntil),
        runAfterAuth(TEST_SHOP, mockAdmin as Parameters<typeof runAfterAuth>[1], mockWaitUntil),
      ]);

      await Promise.allSettled(waitUntilPromises);

      // With the deduplication fix in clearAndMaybeSetup:
      // - First call (RETURNING winner) creates setup promise, adds to inFlightSetups, runs registration
      // - Second call (RETURNING loser) finds in-flight promise, waits on it instead of starting own setup
      // Result: registration runs exactly ONCE
      expect(registrationCallCount).toBe(1);
    });

    it("concurrent reinstall: loser awaits winner's critical registration before runAfterAuth resolves (Bug B fix)", async () => {
      const TEST_SHOP = `concurrent-await-${TEST_SUFFIX}.myshopify.com`;
      
      // Create shop with uninstalledAt set
      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "uninstalledAt", "createdAt", "updatedAt")
        VALUES (${TEST_SHOP}, 'UTC', 'INR', 'free', NOW(), NOW(), NOW())
      `;

      // Create a deferred that we control to hold the winner's registration
      let resolveRegistration!: () => void;
      const registrationDeferred = new Promise<void>((resolve) => {
        resolveRegistration = resolve;
      });

      const mockEnsureValidation = vi.fn().mockImplementation(async () => {
        // Hold here until we release the deferred
        await registrationDeferred;
        return { id: "val-123", created: false };
      });

      vi.doMock("../validation-registration.server", () => ({
        ensureValidation: mockEnsureValidation,
      }));
      vi.doMock("../metafield-definitions.server", () => ({
        ensureMetafieldDefinitions: vi.fn().mockResolvedValue([]),
      }));
      vi.doMock("../payment-customization-registration.server", () => ({
        ensurePaymentCustomization: vi.fn().mockResolvedValue({ id: "pc-123", created: false }),
      }));
      vi.doMock("../request-context.server", () => ({
        getRequestSql: vi.fn(() => sql),
      }));
      vi.doMock("~/services/plan.server", () => ({
        refreshPlanCache: vi.fn().mockResolvedValue(undefined),
      }));

      vi.resetModules();
      const { runAfterAuth, _resetSetupCacheForTesting } = await import("../after-auth.server");
      _resetSetupCacheForTesting();

      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: () => Promise.resolve({ data: { shop: { ianaTimezone: "America/New_York" } } }),
        }),
      };
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p: Promise<unknown>) => waitUntilPromises.push(p));

      // Track whether each runAfterAuth has resolved
      let call1Resolved = false;
      let call2Resolved = false;

      // Start two concurrent runAfterAuth calls
      const call1Promise = runAfterAuth(TEST_SHOP, mockAdmin as Parameters<typeof runAfterAuth>[1], mockWaitUntil)
        .then(() => { call1Resolved = true; });
      const call2Promise = runAfterAuth(TEST_SHOP, mockAdmin as Parameters<typeof runAfterAuth>[1], mockWaitUntil)
        .then(() => { call2Resolved = true; });

      // Wait a tick for both calls to reach the registration wait point
      await new Promise(r => setTimeout(r, 50));

      // Bug B fix assertion: NEITHER call should have resolved yet because
      // the winner is blocked on registration, and the loser AWAITS the winner's
      // critical promise (not just waitUntil). Without the fix, the loser would
      // return immediately, allowing the Setup Guide to render stale state.
      expect(call1Resolved).toBe(false);
      expect(call2Resolved).toBe(false);

      // Release the registration
      resolveRegistration();

      // Now both should resolve
      await Promise.all([call1Promise, call2Promise]);

      expect(call1Resolved).toBe(true);
      expect(call2Resolved).toBe(true);

      // Cleanup: wait for background promises
      await Promise.allSettled(waitUntilPromises);
    });
  });
});

describeWithDb("S23-09: reinstall resets onboarding_dismissed_at (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-s23onboarding";

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

  describe("reinstall clears onboarding_dismissed_at", () => {
    it("clearUninstalledAtAndMetafieldErrors resets onboarding_dismissed_at when shop was uninstalled", async () => {
      const TEST_SHOP = `reinstall-onboarding-${TEST_SUFFIX}.myshopify.com`;
      const dismissedDate = new Date("2026-10-01T00:00:00Z");

      await sql`
        INSERT INTO "Shop" (
          domain, timezone, currency, plan_key,
          onboarding_dismissed_at, "uninstalledAt",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${TEST_SHOP}, 'America/New_York', 'INR', 'starter',
          ${dismissedDate}, NOW(),
          NOW(), NOW()
        )
      `;

      const [before] = await sql<{
        onboarding_dismissed_at: Date | null;
        uninstalledAt: Date | null;
      }[]>`
        SELECT onboarding_dismissed_at, "uninstalledAt"
        FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(before.onboarding_dismissed_at).not.toBeNull();
      expect(before.uninstalledAt).not.toBeNull();

      const { _clearUninstalledAtAndMetafieldErrorsForTesting } = await import("../after-auth.server");
      await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, TEST_SHOP);

      const [after] = await sql<{
        onboarding_dismissed_at: Date | null;
        uninstalledAt: Date | null;
      }[]>`
        SELECT onboarding_dismissed_at, "uninstalledAt"
        FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(after.onboarding_dismissed_at).toBeNull();
      expect(after.uninstalledAt).toBeNull();
    });

    it("reinstall preserves plan, timezone, terms, and subscription columns while clearing onboarding", async () => {
      const TEST_SHOP = `reinstall-preserve-${TEST_SUFFIX}.myshopify.com`;
      const dismissedDate = new Date("2026-09-15T12:00:00Z");
      const planCachedAt = new Date("2026-09-20T10:00:00Z");

      await sql`
        INSERT INTO "Shop" (
          domain, timezone, currency, plan_key, "defaultTermsDays",
          subscription_id, subscription_name, is_test, plan_cached_at,
          onboarding_dismissed_at, "uninstalledAt",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${TEST_SHOP}, 'America/Los_Angeles', 'USD', 'growth', 45,
          'gid://shopify/AppSubscription/123', 'Growth Plan', true, ${planCachedAt},
          ${dismissedDate}, NOW(),
          NOW(), NOW()
        )
      `;

      const [before] = await sql<{
        timezone: string;
        currency: string;
        plan_key: string;
        defaultTermsDays: number | null;
        subscription_id: string | null;
        subscription_name: string | null;
        is_test: boolean;
        plan_cached_at: Date | null;
        onboarding_dismissed_at: Date | null;
      }[]>`
        SELECT timezone, currency, plan_key, "defaultTermsDays",
               subscription_id, subscription_name, is_test, plan_cached_at,
               onboarding_dismissed_at
        FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(before.onboarding_dismissed_at).not.toBeNull();
      expect(before.subscription_id).toBe("gid://shopify/AppSubscription/123");
      expect(before.is_test).toBe(true);

      const { _clearUninstalledAtAndMetafieldErrorsForTesting } = await import("../after-auth.server");
      await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, TEST_SHOP);

      const [after] = await sql<{
        timezone: string;
        currency: string;
        plan_key: string;
        defaultTermsDays: number | null;
        subscription_id: string | null;
        subscription_name: string | null;
        is_test: boolean;
        plan_cached_at: Date | null;
        onboarding_dismissed_at: Date | null;
        uninstalledAt: Date | null;
      }[]>`
        SELECT timezone, currency, plan_key, "defaultTermsDays",
               subscription_id, subscription_name, is_test, plan_cached_at,
               onboarding_dismissed_at, "uninstalledAt"
        FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;

      expect(after.onboarding_dismissed_at).toBeNull();
      expect(after.uninstalledAt).toBeNull();
      expect(after.timezone).toBe(before.timezone);
      expect(after.currency).toBe(before.currency);
      expect(after.plan_key).toBe(before.plan_key);
      expect(after.defaultTermsDays).toBe(before.defaultTermsDays);
      expect(after.subscription_id).toBe(before.subscription_id);
      expect(after.subscription_name).toBe(before.subscription_name);
      expect(after.is_test).toBe(before.is_test);
      expect(after.plan_cached_at?.getTime()).toBe(before.plan_cached_at?.getTime());
    });
  });

  describe("upsertShopOnAuth race condition fix", () => {
    it("upsertShopOnAuth resets onboarding when uninstalledAt was set (race fix)", async () => {
      const TEST_SHOP = `upsert-race-${TEST_SUFFIX}.myshopify.com`;
      const dismissedDate = new Date("2026-10-01T00:00:00Z");

      await sql`
        INSERT INTO "Shop" (
          domain, timezone, currency, plan_key,
          onboarding_dismissed_at, "uninstalledAt",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${TEST_SHOP}, 'America/New_York', 'INR', 'starter',
          ${dismissedDate}, NOW(),
          NOW(), NOW()
        )
      `;

      const [before] = await sql<{
        onboarding_dismissed_at: Date | null;
        uninstalledAt: Date | null;
      }[]>`
        SELECT onboarding_dismissed_at, "uninstalledAt"
        FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(before.onboarding_dismissed_at).not.toBeNull();
      expect(before.uninstalledAt).not.toBeNull();

      const { upsertShopOnAuth } = await import("../after-auth.server");
      await upsertShopOnAuth(sql, TEST_SHOP, "America/New_York", "INR");

      const [after] = await sql<{
        onboarding_dismissed_at: Date | null;
        uninstalledAt: Date | null;
      }[]>`
        SELECT onboarding_dismissed_at, "uninstalledAt"
        FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(after.onboarding_dismissed_at).toBeNull();
      expect(after.uninstalledAt).toBeNull();
    });
  });

  describe("fresh install leaves onboarding state alone", () => {
    it("upsertShopOnAuth does not set onboarding_dismissed_at on fresh install", async () => {
      const TEST_SHOP = `fresh-onboarding-${TEST_SUFFIX}.myshopify.com`;

      const [existingBefore] = await sql<{ id: string }[]>`
        SELECT id FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(existingBefore).toBeUndefined();

      const { upsertShopOnAuth } = await import("../after-auth.server");
      await upsertShopOnAuth(sql, TEST_SHOP, "America/New_York", "INR");

      const [shop] = await sql<{
        onboarding_dismissed_at: Date | null;
        uninstalledAt: Date | null;
      }[]>`
        SELECT onboarding_dismissed_at, "uninstalledAt"
        FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(shop.onboarding_dismissed_at).toBeNull();
      expect(shop.uninstalledAt).toBeNull();
    });

    it("clearUninstalledAtAndMetafieldErrors is no-op on fresh install (no row exists)", async () => {
      const TEST_SHOP = `nonexistent-${TEST_SUFFIX}.myshopify.com`;

      const { _clearUninstalledAtAndMetafieldErrorsForTesting } = await import("../after-auth.server");
      const result = await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, TEST_SHOP);

      expect(result.wasReinstalled).toBe(false);
    });
  });

  describe("normal load does not reset dismissed onboarding", () => {
    it("clearUninstalledAtAndMetafieldErrors does not touch onboarding when uninstalledAt is NULL", async () => {
      const TEST_SHOP = `installed-dismissed-${TEST_SUFFIX}.myshopify.com`;
      const dismissedDate = new Date("2026-10-10T08:00:00Z");

      await sql`
        INSERT INTO "Shop" (
          domain, timezone, currency, plan_key,
          onboarding_dismissed_at,
          "createdAt", "updatedAt"
        )
        VALUES (
          ${TEST_SHOP}, 'Asia/Kolkata', 'INR', 'free',
          ${dismissedDate},
          NOW(), NOW()
        )
      `;

      const [before] = await sql<{
        onboarding_dismissed_at: Date | null;
        uninstalledAt: Date | null;
        updatedAt: Date;
      }[]>`
        SELECT onboarding_dismissed_at, "uninstalledAt", "updatedAt"
        FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(before.onboarding_dismissed_at).not.toBeNull();
      expect(before.uninstalledAt).toBeNull();

      const { _clearUninstalledAtAndMetafieldErrorsForTesting } = await import("../after-auth.server");
      const result = await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, TEST_SHOP);

      expect(result.wasReinstalled).toBe(false);

      const [after] = await sql<{
        onboarding_dismissed_at: Date | null;
        uninstalledAt: Date | null;
        updatedAt: Date;
      }[]>`
        SELECT onboarding_dismissed_at, "uninstalledAt", "updatedAt"
        FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;

      expect(after.onboarding_dismissed_at?.getTime()).toBe(dismissedDate.getTime());
      expect(after.uninstalledAt).toBeNull();
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    });

    it("re-auth on installed shop with dismissed onboarding preserves onboarding state", async () => {
      const TEST_SHOP = `reauth-dismissed-${TEST_SUFFIX}.myshopify.com`;
      const dismissedDate = new Date("2026-10-05T14:30:00Z");

      await sql`
        INSERT INTO "Shop" (
          domain, timezone, currency, plan_key,
          onboarding_dismissed_at,
          "createdAt", "updatedAt"
        )
        VALUES (
          ${TEST_SHOP}, 'Europe/London', 'GBP', 'starter',
          ${dismissedDate},
          NOW(), NOW()
        )
      `;

      const { upsertShopOnAuth } = await import("../after-auth.server");
      await upsertShopOnAuth(sql, TEST_SHOP, "Europe/London", "INR");

      const [after] = await sql<{
        onboarding_dismissed_at: Date | null;
        uninstalledAt: Date | null;
      }[]>`
        SELECT onboarding_dismissed_at, "uninstalledAt"
        FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;

      expect(after.onboarding_dismissed_at?.getTime()).toBe(dismissedDate.getTime());
      expect(after.uninstalledAt).toBeNull();
    });
  });
});

describeWithDb("runAfterAuth cross-isolate reinstall via getRequestSql mock (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-runafterauth";

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql`DELETE FROM "Shop" WHERE domain LIKE ${'%-' + TEST_SUFFIX + '.myshopify.com'}`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM "Shop" WHERE domain LIKE ${'%-' + TEST_SUFFIX + '.myshopify.com'}`;
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("runAfterAuth clears uninstalledAt, preserves plan columns, writes XXX on failed currency read (fail-closed, G4)", async () => {
    const TEST_SHOP = `cached-runafterauth-${TEST_SUFFIX}.myshopify.com`;

    await sql`
      INSERT INTO "Shop" (
        domain, timezone, currency, plan_key, "defaultTermsDays",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_SHOP}, 'America/Chicago', 'USD', 'growth', 30,
        NOW(), NOW()
      )
    `;

    const [beforeSetup] = await sql<{
      timezone: string;
      plan_key: string;
      defaultTermsDays: number | null;
    }[]>`
      SELECT timezone, plan_key, "defaultTermsDays"
      FROM "Shop" WHERE domain = ${TEST_SHOP}
    `;

    vi.doMock("../request-context.server", () => ({
      getRequestSql: vi.fn(() => sql),
    }));

    vi.doMock("../metafield-definitions.server", () => ({
      ensureMetafieldDefinitions: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock("../validation-registration.server", () => ({
      ensureValidation: vi.fn().mockResolvedValue({ id: "test", created: false }),
    }));
    vi.doMock("../payment-customization-registration.server", () => ({
      ensurePaymentCustomization: vi.fn().mockResolvedValue({ id: "pc-test", created: false }),
    }));

    const { runAfterAuth, _resetSetupCacheForTesting, _isShopSetupComplete } =
      await import("../after-auth.server");

    _resetSetupCacheForTesting();

    const mockAdmin = {
      graphql: vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ data: { shop: { ianaTimezone: "America/Chicago" } } }),
      }),
    };

    const waitUntilPromises: Promise<unknown>[] = [];
    const mockWaitUntil = (p: Promise<unknown>) => waitUntilPromises.push(p);

    runAfterAuth(TEST_SHOP, mockAdmin as Parameters<typeof runAfterAuth>[1], mockWaitUntil);

    await Promise.all(waitUntilPromises);
    await vi.waitFor(() => expect(_isShopSetupComplete(TEST_SHOP)).toBe(true));

    await sql`
      UPDATE "Shop"
      SET "uninstalledAt" = NOW()
      WHERE domain = ${TEST_SHOP}
    `;

    const [afterUninstall] = await sql<{ uninstalledAt: Date | null }[]>`
      SELECT "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP}
    `;
    expect(afterUninstall.uninstalledAt).not.toBeNull();

    waitUntilPromises.length = 0;

    runAfterAuth(TEST_SHOP, mockAdmin as Parameters<typeof runAfterAuth>[1], mockWaitUntil);

    await Promise.all(waitUntilPromises);

    const [afterReinstall] = await sql<{
      uninstalledAt: Date | null;
      timezone: string;
      currency: string;
      plan_key: string;
      defaultTermsDays: number | null;
    }[]>`
      SELECT "uninstalledAt", timezone, currency, plan_key, "defaultTermsDays"
      FROM "Shop" WHERE domain = ${TEST_SHOP}
    `;

    expect(afterReinstall.uninstalledAt).toBeNull();
    expect(afterReinstall.timezone).toBe(beforeSetup.timezone);
    expect(afterReinstall.currency).toBe("XXX");
    expect(afterReinstall.plan_key).toBe(beforeSetup.plan_key);
    expect(afterReinstall.defaultTermsDays).toBe(beforeSetup.defaultTermsDays);
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
    await upsertShopOnAuth(sql, TEST_SHOP_DOMAIN, "America/New_York", "INR");
    
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
        {}
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

describeWithDb("reinstall clears metafieldSyncErrorCode and metafieldSyncErrorAt (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-metafieldsyncerr";

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (
      SELECT id FROM "Shop" WHERE domain LIKE ${'%-' + TEST_SUFFIX + '.myshopify.com'}
    )`;
    await sql`DELETE FROM "Shop" WHERE domain LIKE ${'%-' + TEST_SUFFIX + '.myshopify.com'}`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (
      SELECT id FROM "Shop" WHERE domain LIKE ${'%-' + TEST_SUFFIX + '.myshopify.com'}
    )`;
    await sql`DELETE FROM "Shop" WHERE domain LIKE ${'%-' + TEST_SUFFIX + '.myshopify.com'}`;
  });

  describe("reinstall clears both error fields", () => {
    it("clearUninstalledAtAndMetafieldErrors clears both fields atomically for reinstalled shop", async () => {
      const TEST_SHOP = `test-reinstall-metafield-${TEST_SUFFIX}.myshopify.com`;
      const errorDate = new Date("2026-10-15T12:00:00Z");

      const [{ id: shopId }] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "uninstalledAt", "createdAt", "updatedAt")
        VALUES (${TEST_SHOP}, 'America/New_York', 'INR', 'starter', NOW(), NOW(), NOW())
        RETURNING id
      `;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "metafieldSyncErrorCode", "metafieldSyncErrorAt",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${shopId}, 'COMPANY'::"AccountKind",
          'gid://shopify/Company/test-123', 'gid://shopify/CompanyLocation/test-456',
          'Test Account', 'OK', 'no_session', ${errorDate},
          NOW(), NOW()
        )
      `;

      const [beforeReinstall] = await sql<{
        metafieldSyncErrorCode: string | null;
        metafieldSyncErrorAt: Date | null;
      }[]>`
        SELECT "metafieldSyncErrorCode", "metafieldSyncErrorAt"
        FROM "BuyerAccount" WHERE "shopId" = ${shopId}
      `;
      expect(beforeReinstall.metafieldSyncErrorCode).toBe("no_session");
      expect(beforeReinstall.metafieldSyncErrorAt).not.toBeNull();

      const { _clearUninstalledAtAndMetafieldErrorsForTesting } =
        await import("../after-auth.server");

      const result = await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, TEST_SHOP);
      expect(result.wasReinstalled).toBe(true);
      expect(result.shopId).toBe(shopId);

      const [afterReinstall] = await sql<{
        metafieldSyncErrorCode: string | null;
        metafieldSyncErrorAt: Date | null;
      }[]>`
        SELECT "metafieldSyncErrorCode", "metafieldSyncErrorAt"
        FROM "BuyerAccount" WHERE "shopId" = ${shopId}
      `;
      expect(afterReinstall.metafieldSyncErrorCode).toBeNull();
      expect(afterReinstall.metafieldSyncErrorAt).toBeNull();
    });

    it("clears errors for all accounts belonging to the reinstalled shop", async () => {
      const TEST_SHOP = `test-multi-accounts-${TEST_SUFFIX}.myshopify.com`;
      const errorDate = new Date("2026-10-15T12:00:00Z");

      const [{ id: shopId }] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "uninstalledAt", "createdAt", "updatedAt")
        VALUES (${TEST_SHOP}, 'America/New_York', 'INR', 'starter', NOW(), NOW(), NOW())
        RETURNING id
      `;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "metafieldSyncErrorCode", "metafieldSyncErrorAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${shopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/test-a', 'gid://shopify/CompanyLocation/test-a1',
           'Account A', 'OK', 'no_session', ${errorDate}, NOW(), NOW()),
          (${shopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/test-b', 'gid://shopify/CompanyLocation/test-b1',
           'Account B', 'OK', 'access_denied', ${errorDate}, NOW(), NOW()),
          (${shopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/test-c', 'gid://shopify/CompanyLocation/test-c1',
           'Account C (no error)', 'OK', NULL, NULL, NOW(), NOW())
      `;

      const { _clearUninstalledAtAndMetafieldErrorsForTesting } =
        await import("../after-auth.server");

      const result = await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, TEST_SHOP);
      expect(result.wasReinstalled).toBe(true);

      const accounts = await sql<{
        name: string;
        metafieldSyncErrorCode: string | null;
        metafieldSyncErrorAt: Date | null;
      }[]>`
        SELECT name, "metafieldSyncErrorCode", "metafieldSyncErrorAt"
        FROM "BuyerAccount" WHERE "shopId" = ${shopId}
        ORDER BY name
      `;

      expect(accounts).toHaveLength(3);
      for (const account of accounts) {
        expect(account.metafieldSyncErrorCode).toBeNull();
        expect(account.metafieldSyncErrorAt).toBeNull();
      }
    });
  });

  describe("normal re-auth preserves error fields", () => {
    it("clearUninstalledAtAndMetafieldErrors is no-op when uninstalledAt is NULL, preserving error fields", async () => {
      const TEST_SHOP = `test-reauth-preserve-${TEST_SUFFIX}.myshopify.com`;
      const errorDate = new Date("2026-10-15T12:00:00Z");

      const [{ id: shopId }] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP}, 'America/New_York', 'INR', 'starter', NOW(), NOW())
        RETURNING id
      `;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "metafieldSyncErrorCode", "metafieldSyncErrorAt",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${shopId}, 'COMPANY'::"AccountKind",
          'gid://shopify/Company/test-preserve', 'gid://shopify/CompanyLocation/test-preserve',
          'Test Account', 'OK', 'no_session', ${errorDate},
          NOW(), NOW()
        )
      `;

      const { _clearUninstalledAtAndMetafieldErrorsForTesting } = await import("../after-auth.server");

      const result = await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, TEST_SHOP);
      expect(result.wasReinstalled).toBe(false);
      expect(result.shopId).toBeUndefined();

      const [afterReauth] = await sql<{
        metafieldSyncErrorCode: string | null;
        metafieldSyncErrorAt: Date | null;
      }[]>`
        SELECT "metafieldSyncErrorCode", "metafieldSyncErrorAt"
        FROM "BuyerAccount" WHERE "shopId" = ${shopId}
      `;
      expect(afterReauth.metafieldSyncErrorCode).toBe("no_session");
      expect(afterReauth.metafieldSyncErrorAt?.getTime()).toBe(errorDate.getTime());
    });
  });

  describe("other shop's accounts are unchanged", () => {
    it("clearUninstalledAtAndMetafieldErrors only affects the specified shop's accounts", async () => {
      const TEST_SHOP_A = `test-shop-a-${TEST_SUFFIX}.myshopify.com`;
      const TEST_SHOP_B = `test-shop-b-${TEST_SUFFIX}.myshopify.com`;
      const errorDate = new Date("2026-10-15T12:00:00Z");

      const [{ id: shopAId }] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "uninstalledAt", "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_A}, 'America/New_York', 'INR', 'starter', NOW(), NOW(), NOW())
        RETURNING id
      `;

      const [{ id: shopBId }] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "uninstalledAt", "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_B}, 'America/New_York', 'INR', 'starter', NOW(), NOW(), NOW())
        RETURNING id
      `;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "metafieldSyncErrorCode", "metafieldSyncErrorAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${shopAId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/shop-a', 'gid://shopify/CompanyLocation/shop-a',
           'Shop A Account', 'OK', 'no_session', ${errorDate}, NOW(), NOW()),
          (${shopBId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/shop-b', 'gid://shopify/CompanyLocation/shop-b',
           'Shop B Account', 'OK', 'access_denied', ${errorDate}, NOW(), NOW())
      `;

      const { _clearUninstalledAtAndMetafieldErrorsForTesting } =
        await import("../after-auth.server");

      const result = await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, TEST_SHOP_A);
      expect(result.wasReinstalled).toBe(true);

      const [shopAAccount] = await sql<{
        metafieldSyncErrorCode: string | null;
        metafieldSyncErrorAt: Date | null;
      }[]>`
        SELECT "metafieldSyncErrorCode", "metafieldSyncErrorAt"
        FROM "BuyerAccount" WHERE "shopId" = ${shopAId}
      `;
      expect(shopAAccount.metafieldSyncErrorCode).toBeNull();
      expect(shopAAccount.metafieldSyncErrorAt).toBeNull();

      const [shopBAccount] = await sql<{
        metafieldSyncErrorCode: string | null;
        metafieldSyncErrorAt: Date | null;
      }[]>`
        SELECT "metafieldSyncErrorCode", "metafieldSyncErrorAt"
        FROM "BuyerAccount" WHERE "shopId" = ${shopBId}
      `;
      expect(shopBAccount.metafieldSyncErrorCode).toBe("access_denied");
      expect(shopBAccount.metafieldSyncErrorAt?.getTime()).toBe(errorDate.getTime());
    });
  });

  describe("preserves other BuyerAccount columns", () => {
    it("clearUninstalledAtAndMetafieldErrors only clears error fields, preserves all other columns", async () => {
      const TEST_SHOP = `test-preserve-cols-${TEST_SUFFIX}.myshopify.com`;
      const errorDate = new Date("2026-10-15T12:00:00Z");
      const syncedAt = new Date("2026-10-14T10:00:00Z");

      const [{ id: shopId }] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "uninstalledAt", "createdAt", "updatedAt")
        VALUES (${TEST_SHOP}, 'America/New_York', 'INR', 'starter', NOW(), NOW(), NOW())
        RETURNING id
      `;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "defaultTermsDays", "holdState", "holdReasonCode",
          bypass, "manualHold", "syncPending", "syncVersion",
          "metafieldSyncedAt", "metafieldSyncErrorCode", "metafieldSyncErrorAt",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${shopId}, 'COMPANY'::"AccountKind",
          'gid://shopify/Company/test-cols', 'gid://shopify/CompanyLocation/test-cols',
          'Preserve Columns Account', 50000.00, 45, 'HELD', 'MANUAL_HOLD',
          true, true, true, 5,
          ${syncedAt}, 'no_session', ${errorDate},
          NOW(), NOW()
        )
      `;

      const [before] = await sql<{
        name: string;
        creditLimit: string | null;
        defaultTermsDays: number | null;
        holdState: string;
        holdReasonCode: string | null;
        bypass: boolean;
        manualHold: boolean;
        syncPending: boolean;
        syncVersion: number;
        metafieldSyncedAt: Date | null;
      }[]>`
        SELECT name, "creditLimit", "defaultTermsDays", "holdState", "holdReasonCode",
               bypass, "manualHold", "syncPending", "syncVersion", "metafieldSyncedAt"
        FROM "BuyerAccount" WHERE "shopId" = ${shopId}
      `;

      const { _clearUninstalledAtAndMetafieldErrorsForTesting } =
        await import("../after-auth.server");

      await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, TEST_SHOP);

      const [after] = await sql<{
        name: string;
        creditLimit: string | null;
        defaultTermsDays: number | null;
        holdState: string;
        holdReasonCode: string | null;
        bypass: boolean;
        manualHold: boolean;
        syncPending: boolean;
        syncVersion: number;
        metafieldSyncedAt: Date | null;
        metafieldSyncErrorCode: string | null;
        metafieldSyncErrorAt: Date | null;
      }[]>`
        SELECT name, "creditLimit", "defaultTermsDays", "holdState", "holdReasonCode",
               bypass, "manualHold", "syncPending", "syncVersion", "metafieldSyncedAt",
               "metafieldSyncErrorCode", "metafieldSyncErrorAt"
        FROM "BuyerAccount" WHERE "shopId" = ${shopId}
      `;

      expect(after.metafieldSyncErrorCode).toBeNull();
      expect(after.metafieldSyncErrorAt).toBeNull();

      expect(after.name).toBe(before.name);
      expect(after.creditLimit).toBe(before.creditLimit);
      expect(after.defaultTermsDays).toBe(before.defaultTermsDays);
      expect(after.holdState).toBe(before.holdState);
      expect(after.holdReasonCode).toBe(before.holdReasonCode);
      expect(after.bypass).toBe(before.bypass);
      expect(after.manualHold).toBe(before.manualHold);
      expect(after.syncPending).toBe(before.syncPending);
      expect(after.syncVersion).toBe(before.syncVersion);
      expect(after.metafieldSyncedAt?.getTime()).toBe(before.metafieldSyncedAt?.getTime());
    });
  });

  /**
   * Atomicity note: The CTE-based implementation uses a single SQL statement to
   * clear both Shop.uninstalledAt and BuyerAccount.metafieldSyncErrorCode/At.
   * PostgreSQL executes CTEs atomically within a single statement - if any part
   * fails, the entire statement is rolled back. This guarantees that either both
   * updates succeed or neither does, preserving the reinstall signal if the marker
   * clear fails. No explicit test is needed because PostgreSQL's transactional
   * semantics guarantee this behavior for single statements with CTEs.
   */
});

describeWithDb("upsertShopOnAuth clears metafield sync errors on reinstall (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-upsertmetafield";

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (
      SELECT id FROM "Shop" WHERE domain LIKE ${'%-' + TEST_SUFFIX + '.myshopify.com'}
    )`;
    await sql`DELETE FROM "Shop" WHERE domain LIKE ${'%-' + TEST_SUFFIX + '.myshopify.com'}`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (
      SELECT id FROM "Shop" WHERE domain LIKE ${'%-' + TEST_SUFFIX + '.myshopify.com'}
    )`;
    await sql`DELETE FROM "Shop" WHERE domain LIKE ${'%-' + TEST_SUFFIX + '.myshopify.com'}`;
  });

  describe("reinstall via upsertShopOnAuth clears metafield errors", () => {
    it("upsertShopOnAuth clears metafield sync errors when uninstalledAt was set (reinstall)", async () => {
      const TEST_SHOP = `test-upsert-reinstall-${TEST_SUFFIX}.myshopify.com`;
      const errorDate = new Date("2026-10-15T12:00:00Z");

      const [{ id: shopId }] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "uninstalledAt", "createdAt", "updatedAt")
        VALUES (${TEST_SHOP}, 'America/New_York', 'INR', 'starter', NOW(), NOW(), NOW())
        RETURNING id
      `;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "metafieldSyncErrorCode", "metafieldSyncErrorAt",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${shopId}, 'COMPANY'::"AccountKind",
          'gid://shopify/Company/test-upsert', 'gid://shopify/CompanyLocation/test-upsert',
          'Test Account', 'OK', 'no_session', ${errorDate},
          NOW(), NOW()
        )
      `;

      const [beforeReinstall] = await sql<{
        metafieldSyncErrorCode: string | null;
        metafieldSyncErrorAt: Date | null;
      }[]>`
        SELECT "metafieldSyncErrorCode", "metafieldSyncErrorAt"
        FROM "BuyerAccount" WHERE "shopId" = ${shopId}
      `;
      expect(beforeReinstall.metafieldSyncErrorCode).toBe("no_session");
      expect(beforeReinstall.metafieldSyncErrorAt).not.toBeNull();

      const { upsertShopOnAuth } = await import("../after-auth.server");
      await upsertShopOnAuth(sql, TEST_SHOP, "America/New_York", "INR");

      const [afterReinstall] = await sql<{
        metafieldSyncErrorCode: string | null;
        metafieldSyncErrorAt: Date | null;
      }[]>`
        SELECT "metafieldSyncErrorCode", "metafieldSyncErrorAt"
        FROM "BuyerAccount" WHERE "shopId" = ${shopId}
      `;
      expect(afterReinstall.metafieldSyncErrorCode).toBeNull();
      expect(afterReinstall.metafieldSyncErrorAt).toBeNull();
    });

    it("upsertShopOnAuth preserves metafield sync errors on normal re-auth (uninstalledAt was NULL)", async () => {
      const TEST_SHOP = `test-upsert-reauth-${TEST_SUFFIX}.myshopify.com`;
      const errorDate = new Date("2026-10-15T12:00:00Z");

      const [{ id: shopId }] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP}, 'America/New_York', 'INR', 'starter', NOW(), NOW())
        RETURNING id
      `;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "metafieldSyncErrorCode", "metafieldSyncErrorAt",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${shopId}, 'COMPANY'::"AccountKind",
          'gid://shopify/Company/test-upsert-reauth', 'gid://shopify/CompanyLocation/test-upsert-reauth',
          'Test Account', 'OK', 'no_session', ${errorDate},
          NOW(), NOW()
        )
      `;

      const { upsertShopOnAuth } = await import("../after-auth.server");
      await upsertShopOnAuth(sql, TEST_SHOP, "America/Los_Angeles", "INR");

      const [afterReauth] = await sql<{
        metafieldSyncErrorCode: string | null;
        metafieldSyncErrorAt: Date | null;
      }[]>`
        SELECT "metafieldSyncErrorCode", "metafieldSyncErrorAt"
        FROM "BuyerAccount" WHERE "shopId" = ${shopId}
      `;
      expect(afterReauth.metafieldSyncErrorCode).toBe("no_session");
      expect(afterReauth.metafieldSyncErrorAt?.getTime()).toBe(errorDate.getTime());
    });

    it("upsertShopOnAuth on fresh install does not affect other shops' accounts", async () => {
      const TEST_SHOP_NEW = `test-fresh-install-${TEST_SUFFIX}.myshopify.com`;
      const TEST_SHOP_EXISTING = `test-existing-${TEST_SUFFIX}.myshopify.com`;
      const errorDate = new Date("2026-10-15T12:00:00Z");

      const [{ id: existingShopId }] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_EXISTING}, 'America/New_York', 'INR', 'starter', NOW(), NOW())
        RETURNING id
      `;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "metafieldSyncErrorCode", "metafieldSyncErrorAt",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${existingShopId}, 'COMPANY'::"AccountKind",
          'gid://shopify/Company/test-existing', 'gid://shopify/CompanyLocation/test-existing',
          'Existing Account', 'OK', 'no_session', ${errorDate},
          NOW(), NOW()
        )
      `;

      const { upsertShopOnAuth } = await import("../after-auth.server");
      await upsertShopOnAuth(sql, TEST_SHOP_NEW, "America/Los_Angeles", "INR");

      const [existingAccount] = await sql<{
        metafieldSyncErrorCode: string | null;
        metafieldSyncErrorAt: Date | null;
      }[]>`
        SELECT "metafieldSyncErrorCode", "metafieldSyncErrorAt"
        FROM "BuyerAccount" WHERE "shopId" = ${existingShopId}
      `;
      expect(existingAccount.metafieldSyncErrorCode).toBe("no_session");
      expect(existingAccount.metafieldSyncErrorAt?.getTime()).toBe(errorDate.getTime());
    });
  });
});

describeWithDb("full after-auth flow clears metafield errors on reinstall (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-fullflow";

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (
      SELECT id FROM "Shop" WHERE domain LIKE ${'%-' + TEST_SUFFIX + '.myshopify.com'}
    )`;
    await sql`DELETE FROM "Shop" WHERE domain LIKE ${'%-' + TEST_SUFFIX + '.myshopify.com'}`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (
      SELECT id FROM "Shop" WHERE domain LIKE ${'%-' + TEST_SUFFIX + '.myshopify.com'}
    )`;
    await sql`DELETE FROM "Shop" WHERE domain LIKE ${'%-' + TEST_SUFFIX + '.myshopify.com'}`;
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe("clearAndMaybeSetup flow", () => {
    it("reinstall: clearAndMaybeSetup clears metafield errors atomically with uninstalledAt", async () => {
      const TEST_SHOP = `test-fullflow-reinstall-${TEST_SUFFIX}.myshopify.com`;
      const errorDate = new Date("2026-10-15T12:00:00Z");

      const [{ id: shopId }] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "uninstalledAt", "createdAt", "updatedAt")
        VALUES (${TEST_SHOP}, 'America/New_York', 'INR', 'starter', NOW(), NOW(), NOW())
        RETURNING id
      `;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "metafieldSyncErrorCode", "metafieldSyncErrorAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${shopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/test-flow-a', 'gid://shopify/CompanyLocation/test-flow-a',
           'Account A', 'OK', 'no_session', ${errorDate}, NOW(), NOW()),
          (${shopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/test-flow-b', 'gid://shopify/CompanyLocation/test-flow-b',
           'Account B', 'OK', 'access_denied', ${errorDate}, NOW(), NOW())
      `;

      vi.doMock("../request-context.server", () => ({
        getRequestSql: vi.fn(() => sql),
      }));

      vi.doMock("../metafield-definitions.server", () => ({
        ensureMetafieldDefinitions: vi.fn().mockResolvedValue([]),
      }));
      vi.doMock("../validation-registration.server", () => ({
        ensureValidation: vi.fn().mockResolvedValue({ id: "test", created: false }),
      }));
      vi.doMock("../payment-customization-registration.server", () => ({
        ensurePaymentCustomization: vi.fn().mockResolvedValue({ id: "pc-test", created: false }),
      }));

      const { runAfterAuth, _resetSetupCacheForTesting, _isShopSetupComplete } =
        await import("../after-auth.server");

      _resetSetupCacheForTesting();

      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: () => Promise.resolve({ data: { shop: { ianaTimezone: "America/New_York" } } }),
        }),
      };

      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = (p: Promise<unknown>) => waitUntilPromises.push(p);

      runAfterAuth(TEST_SHOP, mockAdmin as Parameters<typeof runAfterAuth>[1], mockWaitUntil);

      await Promise.all(waitUntilPromises);
      await vi.waitFor(() => expect(_isShopSetupComplete(TEST_SHOP)).toBe(true));

      const [shop] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(shop.uninstalledAt).toBeNull();

      const accounts = await sql<{
        name: string;
        metafieldSyncErrorCode: string | null;
        metafieldSyncErrorAt: Date | null;
      }[]>`
        SELECT name, "metafieldSyncErrorCode", "metafieldSyncErrorAt"
        FROM "BuyerAccount" WHERE "shopId" = ${shopId}
        ORDER BY name
      `;

      expect(accounts).toHaveLength(2);
      for (const account of accounts) {
        expect(account.metafieldSyncErrorCode).toBeNull();
        expect(account.metafieldSyncErrorAt).toBeNull();
      }
    });

    it("normal re-auth: clearAndMaybeSetup preserves metafield errors", async () => {
      const TEST_SHOP = `test-fullflow-reauth-${TEST_SUFFIX}.myshopify.com`;
      const errorDate = new Date("2026-10-15T12:00:00Z");

      const [{ id: shopId }] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP}, 'America/New_York', 'INR', 'starter', NOW(), NOW())
        RETURNING id
      `;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "metafieldSyncErrorCode", "metafieldSyncErrorAt",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${shopId}, 'COMPANY'::"AccountKind",
          'gid://shopify/Company/test-flow-reauth', 'gid://shopify/CompanyLocation/test-flow-reauth',
          'Account', 'OK', 'no_session', ${errorDate},
          NOW(), NOW()
        )
      `;

      vi.doMock("../request-context.server", () => ({
        getRequestSql: vi.fn(() => sql),
      }));

      vi.doMock("../metafield-definitions.server", () => ({
        ensureMetafieldDefinitions: vi.fn().mockResolvedValue([]),
      }));
      vi.doMock("../validation-registration.server", () => ({
        ensureValidation: vi.fn().mockResolvedValue({ id: "test", created: false }),
      }));
      vi.doMock("../payment-customization-registration.server", () => ({
        ensurePaymentCustomization: vi.fn().mockResolvedValue({ id: "pc-test", created: false }),
      }));

      const { runAfterAuth, _resetSetupCacheForTesting, _isShopSetupComplete } =
        await import("../after-auth.server");

      _resetSetupCacheForTesting();

      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: () => Promise.resolve({ data: { shop: { ianaTimezone: "America/New_York" } } }),
        }),
      };

      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = (p: Promise<unknown>) => waitUntilPromises.push(p);

      runAfterAuth(TEST_SHOP, mockAdmin as Parameters<typeof runAfterAuth>[1], mockWaitUntil);

      await Promise.all(waitUntilPromises);
      await vi.waitFor(() => expect(_isShopSetupComplete(TEST_SHOP)).toBe(true));

      const [account] = await sql<{
        metafieldSyncErrorCode: string | null;
        metafieldSyncErrorAt: Date | null;
      }[]>`
        SELECT "metafieldSyncErrorCode", "metafieldSyncErrorAt"
        FROM "BuyerAccount" WHERE "shopId" = ${shopId}
      `;

      expect(account.metafieldSyncErrorCode).toBe("no_session");
      expect(account.metafieldSyncErrorAt?.getTime()).toBe(errorDate.getTime());
    });
  });

  describe("shop already in setup cache (only clearAndMaybeSetup path)", () => {
    it("reinstall with cached shop: clears metafield errors via clearAndMaybeSetup only", async () => {
      const TEST_SHOP = `test-cached-reinstall-${TEST_SUFFIX}.myshopify.com`;
      const errorDate = new Date("2026-10-15T12:00:00Z");

      const [{ id: shopId }] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP}, 'America/New_York', 'INR', 'starter', NOW(), NOW())
        RETURNING id
      `;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "metafieldSyncErrorCode", "metafieldSyncErrorAt",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${shopId}, 'COMPANY'::"AccountKind",
          'gid://shopify/Company/test-cached', 'gid://shopify/CompanyLocation/test-cached',
          'Cached Test Account', 'OK', 'no_session', ${errorDate},
          NOW(), NOW()
        )
      `;

      vi.doMock("../request-context.server", () => ({
        getRequestSql: vi.fn(() => sql),
      }));

      vi.doMock("../metafield-definitions.server", () => ({
        ensureMetafieldDefinitions: vi.fn().mockResolvedValue([]),
      }));
      vi.doMock("../validation-registration.server", () => ({
        ensureValidation: vi.fn().mockResolvedValue({ id: "test", created: false }),
      }));
      vi.doMock("../payment-customization-registration.server", () => ({
        ensurePaymentCustomization: vi.fn().mockResolvedValue({ id: "pc-test", created: false }),
      }));

      const { runAfterAuth, _resetSetupCacheForTesting, _isShopSetupComplete } =
        await import("../after-auth.server");

      _resetSetupCacheForTesting();

      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: () => Promise.resolve({ data: { shop: { ianaTimezone: "America/New_York" } } }),
        }),
      };

      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = (p: Promise<unknown>) => waitUntilPromises.push(p);

      runAfterAuth(TEST_SHOP, mockAdmin as Parameters<typeof runAfterAuth>[1], mockWaitUntil);

      await Promise.all(waitUntilPromises);
      await vi.waitFor(() => expect(_isShopSetupComplete(TEST_SHOP)).toBe(true));

      await sql`
        UPDATE "Shop"
        SET "uninstalledAt" = NOW()
        WHERE domain = ${TEST_SHOP}
      `;

      const [afterUninstall] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(afterUninstall.uninstalledAt).not.toBeNull();

      waitUntilPromises.length = 0;

      runAfterAuth(TEST_SHOP, mockAdmin as Parameters<typeof runAfterAuth>[1], mockWaitUntil);

      await Promise.all(waitUntilPromises);

      const [shop] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(shop.uninstalledAt).toBeNull();

      const [account] = await sql<{
        metafieldSyncErrorCode: string | null;
        metafieldSyncErrorAt: Date | null;
      }[]>`
        SELECT "metafieldSyncErrorCode", "metafieldSyncErrorAt"
        FROM "BuyerAccount" WHERE "shopId" = ${shopId}
      `;
      expect(account.metafieldSyncErrorCode).toBeNull();
      expect(account.metafieldSyncErrorAt).toBeNull();
    });

    it("normal re-auth with cached shop: preserves metafield errors", async () => {
      const TEST_SHOP = `test-cached-reauth-${TEST_SUFFIX}.myshopify.com`;
      const errorDate = new Date("2026-10-15T12:00:00Z");

      const [{ id: shopId }] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP}, 'America/New_York', 'INR', 'starter', NOW(), NOW())
        RETURNING id
      `;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "metafieldSyncErrorCode", "metafieldSyncErrorAt",
          "createdAt", "updatedAt"
        )
        VALUES (
          ${shopId}, 'COMPANY'::"AccountKind",
          'gid://shopify/Company/test-cached-reauth', 'gid://shopify/CompanyLocation/test-cached-reauth',
          'Cached Reauth Account', 'OK', 'access_denied', ${errorDate},
          NOW(), NOW()
        )
      `;

      vi.doMock("../request-context.server", () => ({
        getRequestSql: vi.fn(() => sql),
      }));

      vi.doMock("../metafield-definitions.server", () => ({
        ensureMetafieldDefinitions: vi.fn().mockResolvedValue([]),
      }));
      vi.doMock("../validation-registration.server", () => ({
        ensureValidation: vi.fn().mockResolvedValue({ id: "test", created: false }),
      }));
      vi.doMock("../payment-customization-registration.server", () => ({
        ensurePaymentCustomization: vi.fn().mockResolvedValue({ id: "pc-test", created: false }),
      }));

      const { runAfterAuth, _resetSetupCacheForTesting, _isShopSetupComplete } =
        await import("../after-auth.server");

      _resetSetupCacheForTesting();

      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: () => Promise.resolve({ data: { shop: { ianaTimezone: "America/New_York" } } }),
        }),
      };

      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = (p: Promise<unknown>) => waitUntilPromises.push(p);

      runAfterAuth(TEST_SHOP, mockAdmin as Parameters<typeof runAfterAuth>[1], mockWaitUntil);

      await Promise.all(waitUntilPromises);
      await vi.waitFor(() => expect(_isShopSetupComplete(TEST_SHOP)).toBe(true));

      waitUntilPromises.length = 0;

      runAfterAuth(TEST_SHOP, mockAdmin as Parameters<typeof runAfterAuth>[1], mockWaitUntil);

      await Promise.all(waitUntilPromises);

      const [account] = await sql<{
        metafieldSyncErrorCode: string | null;
        metafieldSyncErrorAt: Date | null;
      }[]>`
        SELECT "metafieldSyncErrorCode", "metafieldSyncErrorAt"
        FROM "BuyerAccount" WHERE "shopId" = ${shopId}
      `;
      expect(account.metafieldSyncErrorCode).toBe("access_denied");
      expect(account.metafieldSyncErrorAt?.getTime()).toBe(errorDate.getTime());
    });
  });
});

/**
 * #292: Currency handling tests for INR-only support.
 * 
 * Tests verify:
 * 1. USD stores 'USD' (successful read stores actual currency)
 * 2. Failed read stores 'XXX' on fresh install
 * 3. Existing currency is preserved on conflict when new value is 'XXX'
 */
describeWithDb("#292: currency handling in upsertShopOnAuth (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-292currency";

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

  describe("successful currency read stores actual currency", () => {
    it("upsertShopOnAuth stores 'USD' when currency is USD", async () => {
      const TEST_SHOP = `usd-shop-${TEST_SUFFIX}.myshopify.com`;
      const { upsertShopOnAuth } = await import("../after-auth.server");

      await upsertShopOnAuth(sql, TEST_SHOP, "America/New_York", "USD");

      const [shop] = await sql<{ currency: string }[]>`
        SELECT currency FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(shop.currency).toBe("USD");
    });

    it("upsertShopOnAuth stores 'INR' when currency is INR", async () => {
      const TEST_SHOP = `inr-shop-${TEST_SUFFIX}.myshopify.com`;
      const { upsertShopOnAuth } = await import("../after-auth.server");

      await upsertShopOnAuth(sql, TEST_SHOP, "Asia/Kolkata", "INR");

      const [shop] = await sql<{ currency: string }[]>`
        SELECT currency FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(shop.currency).toBe("INR");
    });

    it("upsertShopOnAuth stores 'GBP' when currency is GBP", async () => {
      const TEST_SHOP = `gbp-shop-${TEST_SUFFIX}.myshopify.com`;
      const { upsertShopOnAuth } = await import("../after-auth.server");

      await upsertShopOnAuth(sql, TEST_SHOP, "Europe/London", "GBP");

      const [shop] = await sql<{ currency: string }[]>`
        SELECT currency FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(shop.currency).toBe("GBP");
    });
  });

  describe("failed currency read stores 'XXX' on fresh install", () => {
    it("upsertShopOnAuth stores 'XXX' when currency query fails on fresh install", async () => {
      const TEST_SHOP = `xxx-fresh-${TEST_SUFFIX}.myshopify.com`;
      const { upsertShopOnAuth } = await import("../after-auth.server");

      await upsertShopOnAuth(sql, TEST_SHOP, "America/New_York", "XXX");

      const [shop] = await sql<{ currency: string }[]>`
        SELECT currency FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(shop.currency).toBe("XXX");
    });
  });

  describe("fail-closed: 'XXX' currency written on failed read (G4)", () => {
    it("re-auth with 'XXX' overwrites existing 'USD' currency (fail-closed)", async () => {
      const TEST_SHOP = `failclosed-usd-${TEST_SUFFIX}.myshopify.com`;
      const { upsertShopOnAuth } = await import("../after-auth.server");

      await upsertShopOnAuth(sql, TEST_SHOP, "America/New_York", "USD");

      const [before] = await sql<{ currency: string }[]>`
        SELECT currency FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(before.currency).toBe("USD");

      await upsertShopOnAuth(sql, TEST_SHOP, "America/New_York", "XXX");

      const [after] = await sql<{ currency: string }[]>`
        SELECT currency FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(after.currency).toBe("XXX");
    });

    it("re-auth with 'XXX' overwrites existing 'INR' currency (fail-closed)", async () => {
      const TEST_SHOP = `failclosed-inr-${TEST_SUFFIX}.myshopify.com`;
      const { upsertShopOnAuth } = await import("../after-auth.server");

      await upsertShopOnAuth(sql, TEST_SHOP, "Asia/Kolkata", "INR");

      const [before] = await sql<{ currency: string }[]>`
        SELECT currency FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(before.currency).toBe("INR");

      await upsertShopOnAuth(sql, TEST_SHOP, "Asia/Kolkata", "XXX");

      const [after] = await sql<{ currency: string }[]>`
        SELECT currency FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(after.currency).toBe("XXX");
    });

    it("re-auth with valid currency updates existing currency", async () => {
      const TEST_SHOP = `update-currency-${TEST_SUFFIX}.myshopify.com`;
      const { upsertShopOnAuth } = await import("../after-auth.server");

      await upsertShopOnAuth(sql, TEST_SHOP, "America/New_York", "USD");

      const [before] = await sql<{ currency: string }[]>`
        SELECT currency FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(before.currency).toBe("USD");

      await upsertShopOnAuth(sql, TEST_SHOP, "Europe/London", "GBP");

      const [after] = await sql<{ currency: string }[]>`
        SELECT currency FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(after.currency).toBe("GBP");
    });
  });

  describe("reinstall currency handling", () => {
    it("reinstall with 'XXX' overwrites existing currency (fail-closed, G4)", async () => {
      const TEST_SHOP = `reinstall-xxx-${TEST_SUFFIX}.myshopify.com`;
      const { upsertShopOnAuth } = await import("../after-auth.server");

      await upsertShopOnAuth(sql, TEST_SHOP, "Asia/Kolkata", "INR");

      await sql`
        UPDATE "Shop" SET "uninstalledAt" = NOW() WHERE domain = ${TEST_SHOP}
      `;

      const [beforeReinstall] = await sql<{ currency: string; uninstalledAt: Date | null }[]>`
        SELECT currency, "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(beforeReinstall.currency).toBe("INR");
      expect(beforeReinstall.uninstalledAt).not.toBeNull();

      await upsertShopOnAuth(sql, TEST_SHOP, "Asia/Kolkata", "XXX");

      const [afterReinstall] = await sql<{ currency: string; uninstalledAt: Date | null }[]>`
        SELECT currency, "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(afterReinstall.currency).toBe("XXX");
      expect(afterReinstall.uninstalledAt).toBeNull();
    });

    it("reinstall with valid currency updates existing currency", async () => {
      const TEST_SHOP = `reinstall-update-${TEST_SUFFIX}.myshopify.com`;
      const { upsertShopOnAuth } = await import("../after-auth.server");

      await upsertShopOnAuth(sql, TEST_SHOP, "Asia/Kolkata", "INR");

      await sql`
        UPDATE "Shop" SET "uninstalledAt" = NOW() WHERE domain = ${TEST_SHOP}
      `;

      const [beforeReinstall] = await sql<{ currency: string }[]>`
        SELECT currency FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(beforeReinstall.currency).toBe("INR");

      await upsertShopOnAuth(sql, TEST_SHOP, "America/New_York", "USD");

      const [afterReinstall] = await sql<{ currency: string; uninstalledAt: Date | null }[]>`
        SELECT currency, "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP}
      `;
      expect(afterReinstall.currency).toBe("USD");
      expect(afterReinstall.uninstalledAt).toBeNull();
    });
  });
});

/**
 * #292: Currency flip safety tests.
 *
 * Tests verify that reinstall/re-auth of a USD shop with financial rows
 * does NOT relabel historical amounts as rupees.
 *
 * Uses the shared guard to decide whether to block the flip, then passes
 * the effective currency to upsertShopOnAuth (same as syncShopInfo does).
 */
describeWithDb("after-auth currency flip safety (#292)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = `test-${Date.now().toString(36)}-cfs`;

  const SHOP_WITH_INVOICE = `shop-invoice-${TEST_SUFFIX}`;
  const SHOP_EMPTY = `shop-empty-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shops with USD currency (use example.com to satisfy logging allowlist)
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES
        (${SHOP_WITH_INVOICE}, ${SHOP_WITH_INVOICE + ".example.com"}, 'USD', NOW(), NOW()),
        (${SHOP_EMPTY}, ${SHOP_EMPTY + ".example.com"}, 'USD', NOW(), NOW())
    `;

    // Create a BuyerAccount for shop with invoice (TAGGED_CUSTOMER kind)
    const BUYER_ID = `buyer-${TEST_SUFFIX}`;
    const CUSTOMER_ID = `gid://shopify/Customer/test-${TEST_SUFFIX}`;
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "customerId", name, "createdAt", "updatedAt")
      VALUES (${BUYER_ID}, ${SHOP_WITH_INVOICE}, 'TAGGED_CUSTOMER', ${CUSTOMER_ID}, 'Test Buyer', NOW(), NOW())
    `;

    // Create an Invoice for SHOP_WITH_INVOICE (must have orderId per Invoice_order_xor_draft constraint)
    const ORDER_ID = `gid://shopify/Order/test-${TEST_SUFFIX}`;
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, "issuedAt", "createdAt", "updatedAt")
      VALUES (${`inv-${TEST_SUFFIX}`}, ${SHOP_WITH_INVOICE}, ${BUYER_ID}, ${ORDER_ID}, '#1001', 1000, 1000, NOW(), NOW(), NOW())
    `;
  });

  afterAll(async () => {
    // Clean up test data
    await sql`DELETE FROM "Invoice" WHERE id = ${`inv-${TEST_SUFFIX}`}`;
    await sql`DELETE FROM "BuyerAccount" WHERE id = ${`buyer-${TEST_SUFFIX}`}`;
    await sql`DELETE FROM "Shop" WHERE id IN (${SHOP_WITH_INVOICE}, ${SHOP_EMPTY})`;
    await sql.end();
  });

  it("USD shop with financial rows: re-auth with INR does NOT update currency (blocked)", async () => {
    const { upsertShopOnAuth } = await import("../after-auth.server");
    const { hasFinancialRows, decideShopCurrencyUpdate } = await import("../shop-currency-guard.server");

    // Verify the shop has financial rows
    const hasRows = await hasFinancialRows(sql, SHOP_WITH_INVOICE);
    expect(hasRows).toBe(true);

    // Verify the guard blocks the flip
    const decision = decideShopCurrencyUpdate({
      storedCurrency: "USD",
      liveCurrency: "INR",
      hasFinancialRows: hasRows,
    });
    expect(decision.blocked).toBe(true);
    expect(decision.effectiveCurrency).toBe("USD");

    // Simulate re-auth: call upsertShopOnAuth with the EFFECTIVE currency (USD, not INR)
    // In real code, syncShopInfo applies the guard before calling upsertShopOnAuth
    await upsertShopOnAuth(
      sql,
      SHOP_WITH_INVOICE + ".example.com",
      "Asia/Kolkata",
      decision.effectiveCurrency,
    );

    // Verify currency is still USD
    const [shop] = await sql<{ currency: string }[]>`
      SELECT currency FROM "Shop" WHERE id = ${SHOP_WITH_INVOICE}
    `;
    expect(shop.currency).toBe("USD");
  });

  it("USD shop with zero financial rows: re-auth with INR updates currency (allowed)", async () => {
    const { upsertShopOnAuth } = await import("../after-auth.server");
    const { hasFinancialRows, decideShopCurrencyUpdate } = await import("../shop-currency-guard.server");

    // Verify the shop has no financial rows
    const hasRows = await hasFinancialRows(sql, SHOP_EMPTY);
    expect(hasRows).toBe(false);

    // Verify the guard allows the flip
    const decision = decideShopCurrencyUpdate({
      storedCurrency: "USD",
      liveCurrency: "INR",
      hasFinancialRows: hasRows,
    });
    expect(decision.blocked).toBe(false);
    expect(decision.effectiveCurrency).toBe("INR");

    // Simulate re-auth: call upsertShopOnAuth with the live currency (INR)
    await upsertShopOnAuth(
      sql,
      SHOP_EMPTY + ".example.com",
      "Asia/Kolkata",
      decision.effectiveCurrency,
    );

    // Verify currency is now INR
    const [shop] = await sql<{ currency: string }[]>`
      SELECT currency FROM "Shop" WHERE id = ${SHOP_EMPTY}
    `;
    expect(shop.currency).toBe("INR");
  });

  it("XXX stored + INR live + financial rows: blocked (fail-closed)", async () => {
    const { hasFinancialRows, decideShopCurrencyUpdate } = await import("../shop-currency-guard.server");

    // Set currency to XXX to simulate failed query sentinel
    await sql`
      UPDATE "Shop" SET currency = 'XXX' WHERE id = ${SHOP_WITH_INVOICE}
    `;

    // Verify the guard blocks the flip (fail-closed behavior)
    const hasRows = await hasFinancialRows(sql, SHOP_WITH_INVOICE);
    expect(hasRows).toBe(true);

    const decision = decideShopCurrencyUpdate({
      storedCurrency: "XXX",
      liveCurrency: "INR",
      hasFinancialRows: hasRows,
    });
    expect(decision.blocked).toBe(true);
    expect(decision.effectiveCurrency).toBe("XXX");

    // Restore currency to USD for other tests
    await sql`
      UPDATE "Shop" SET currency = 'USD' WHERE id = ${SHOP_WITH_INVOICE}
    `;
  });
});

describeWithDb("markShopUninstalled plan cache invalidation (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-plancache";
  const TEST_SHOP_DOMAIN = `plan-cache-${TEST_SUFFIX}.myshopify.com`;

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

  it("markShopUninstalled sets plan_cached_at to NULL", async () => {
    // Create shop with plan_cached_at set
    await sql`
      INSERT INTO "Shop" (domain, timezone, currency, plan_key, plan_cached_at, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'UTC', 'INR', 'starter', NOW(), NOW(), NOW())
    `;

    // Verify plan_cached_at is set
    const [before] = await sql<{ plan_cached_at: Date | null }[]>`
      SELECT plan_cached_at FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
    `;
    expect(before.plan_cached_at).not.toBeNull();

    // Mark shop uninstalled
    const { markShopUninstalled } = await import("~/services/compliance/compliance.server");
    const result = await markShopUninstalled(sql, TEST_SHOP_DOMAIN);
    expect(result).toBe(true);

    // Verify plan_cached_at is now NULL
    const [after] = await sql<{ plan_cached_at: Date | null; uninstalledAt: Date | null }[]>`
      SELECT plan_cached_at, "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
    `;
    expect(after.plan_cached_at).toBeNull();
    expect(after.uninstalledAt).not.toBeNull();
  });

  it("plan_cached_at NULL after uninstall means cache is stale for next resolvePlan", async () => {
    // Create shop with cached plan (plan_cached_at set = cache is valid)
    await sql`
      INSERT INTO "Shop" (domain, timezone, currency, plan_key, subscription_id, plan_cached_at, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'UTC', 'INR', 'starter', 'gid://shopify/AppSubscription/123', NOW(), NOW(), NOW())
    `;

    // Verify cached plan exists with valid cache
    const [before] = await sql<{ plan_key: string; plan_cached_at: Date | null }[]>`
      SELECT plan_key, plan_cached_at FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
    `;
    expect(before.plan_key).toBe("starter");
    expect(before.plan_cached_at).not.toBeNull();

    // Mark shop uninstalled (this should clear plan_cached_at)
    const { markShopUninstalled } = await import("~/services/compliance/compliance.server");
    await markShopUninstalled(sql, TEST_SHOP_DOMAIN);

    // Verify plan_cached_at is NULL (cache invalidated)
    const [afterUninstall] = await sql<{ plan_cached_at: Date | null; plan_key: string }[]>`
      SELECT plan_cached_at, plan_key FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
    `;
    expect(afterUninstall.plan_cached_at).toBeNull();
    // plan_key is preserved (not cleared) - only the cache timestamp is invalidated
    expect(afterUninstall.plan_key).toBe("starter");
  });

  describe("runAfterAuth reinstall updates plan from Shopify", () => {
    afterEach(() => {
      vi.doUnmock("../../services/drain/admin-client.server");
      vi.doUnmock("../validation-registration.server");
      vi.doUnmock("../metafield-definitions.server");
      vi.doUnmock("../payment-customization-registration.server");
      vi.doUnmock("../request-context.server");
      vi.resetModules();
    });

    it("runAfterAuth on reinstall updates plan_key and plan_cached_at from mocked Shopify", async () => {
      // Setup: create shop with stale plan (starter) and uninstalledAt set (ready for reinstall)
      // The plan_cached_at is set to simulate a valid cache that was invalidated by uninstall
      const stalePlanCachedAt = new Date("2026-10-01T00:00:00Z");
      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, subscription_id, plan_cached_at, "uninstalledAt", "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_DOMAIN}, 'UTC', 'INR', 'starter', 'gid://shopify/AppSubscription/old-123', ${stalePlanCachedAt}, NOW(), NOW(), NOW())
      `;

      // Verify initial state: stale plan, uninstalledAt set
      const [before] = await sql<{ plan_key: string; plan_cached_at: Date | null; uninstalledAt: Date | null }[]>`
        SELECT plan_key, plan_cached_at, "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
      `;
      expect(before.plan_key).toBe("starter");
      expect(before.plan_cached_at).not.toBeNull();
      expect(before.uninstalledAt).not.toBeNull();

      // Mock adminGraphQL to return a DIFFERENT plan (growth instead of starter)
      const mockAdminGraphQL = vi.fn().mockImplementation(async (shop: string, query: string) => {
        if (query.includes("currentAppInstallation")) {
          return {
            success: true,
            data: {
              currentAppInstallation: {
                activeSubscriptions: [{
                  id: "gid://shopify/AppSubscription/new-456",
                  name: "Growth",
                  status: "ACTIVE",
                  test: false,
                  lineItems: [],
                }],
              },
            },
            retryable: false,
          };
        }
        return { success: false, error: "Unknown query", retryable: false };
      });

      // Mock modules for runAfterAuth
      vi.doMock("../../services/drain/admin-client.server", () => ({
        adminGraphQL: mockAdminGraphQL,
      }));
      vi.doMock("../validation-registration.server", () => ({
        ensureValidation: vi.fn().mockResolvedValue({ id: "val-123", created: false }),
      }));
      vi.doMock("../metafield-definitions.server", () => ({
        ensureMetafieldDefinitions: vi.fn().mockResolvedValue([]),
      }));
      vi.doMock("../payment-customization-registration.server", () => ({
        ensurePaymentCustomization: vi.fn().mockResolvedValue({ id: "pc-123", created: false }),
      }));
      vi.doMock("../request-context.server", () => ({
        getRequestSql: vi.fn(() => sql),
      }));

      vi.resetModules();
      const { runAfterAuth, _resetSetupCacheForTesting } = await import("../after-auth.server");
      _resetSetupCacheForTesting();

      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: () => Promise.resolve({ data: { shop: { id: "gid://shopify/Shop/123", ianaTimezone: "America/New_York", currencyCode: "INR" } } }),
        }),
      };

      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p: Promise<unknown>) => waitUntilPromises.push(p));

      // Call runAfterAuth - this triggers the reinstall path because wasReinstalled=true
      // The reinstall path calls refreshPlanCache which queries Shopify and updates the plan
      await runAfterAuth(TEST_SHOP_DOMAIN, mockAdmin as Parameters<typeof runAfterAuth>[1], mockWaitUntil);

      // Wait for background promises to complete
      await Promise.allSettled(waitUntilPromises);

      // Assert: plan_key should now be 'growth' (from mocked Shopify), not 'starter' (stale cache)
      // Assert: plan_cached_at should be updated (not the old stalePlanCachedAt)
      const [after] = await sql<{ plan_key: string; plan_cached_at: Date | null; uninstalledAt: Date | null }[]>`
        SELECT plan_key, plan_cached_at, "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
      `;

      expect(after.uninstalledAt).toBeNull(); // Cleared by reinstall
      expect(after.plan_key).toBe("growth"); // Updated from mocked Shopify
      expect(after.plan_cached_at).not.toBeNull(); // Cache refreshed
      // plan_cached_at should be newer than the stale one
      expect(after.plan_cached_at!.getTime()).toBeGreaterThan(stalePlanCachedAt.getTime());
    });
  });
});
