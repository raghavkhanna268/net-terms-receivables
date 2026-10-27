/**
 * Billing and Plan Coverage Tests (S21).
 *
 * Tests the Managed Pricing integration:
 * A. Plan handle redirect and currentAppInstallation query - table-driven
 * B. Plan cache update on webhook (ACTIVE, DECLINED, CANCELLED, EXPIRED, FROZEN) + reinstall #468
 * C. Plan handle to features mapping - table-driven
 * D. PLAN_GATING_ENFORCED behavior
 * E. Unknown/missing handle fails safe
 * F. Webhook HMAC failure - rejected with no plan or cache change
 * G. Log sanitization - no shop domain, gid://, or charge/subscription id
 *
 * Uses real DB rows (Sequential DB group via describeWithDb) and real route
 * handlers with correctly signed requests and mocked Admin GraphQL.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import crypto from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { sqlOptions } from "~/lib/db-light.server";
import {
  ALL_PLAN_KEYS,
  type PlanKey,
  getPlanConfig,
  planLimit,
  planHasFeature,
  ALL_FEATURE_KEYS,
  resolvePlanKey,
} from "~/lib/entitlements";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const SYNTHETIC_TEST_SECRET = "synthetic-billing-test-secret-s21";

function generateShopifyHmac(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

function createSignedWebhookRequest(
  body: string,
  topic: string,
  secret: string,
  options: {
    shopDomain: string;
    omitHmac?: boolean;
    wrongHmac?: string;
    webhookId?: string;
  }
): Request {
  const hmac = options.wrongHmac ?? (options.omitHmac ? undefined : generateShopifyHmac(body, secret));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Shopify-API-Version": "2026-10",
    "X-Shopify-Webhook-Id": options.webhookId ?? `billing-test-${Date.now()}`,
    "X-Shopify-Topic": topic,
    "X-Shopify-Shop-Domain": options.shopDomain,
  };

  if (hmac) {
    headers["X-Shopify-Hmac-Sha256"] = hmac;
  }

  return new Request("https://example.com/webhooks/app/subscriptions_update", {
    method: "POST",
    headers,
    body,
  });
}

function createMockWebhookActionArgs(request: Request): ActionFunctionArgs & { _waitUntil: ReturnType<typeof vi.fn> } {
  const mockWaitUntil = vi.fn();
  return {
    request,
    params: {},
    context: {
      cloudflare: {
        env: {},
        ctx: { waitUntil: mockWaitUntil },
      },
    },
    url: new URL(request.url),
    pattern: "/webhooks/app/subscriptions_update",
    _waitUntil: mockWaitUntil,
  } as unknown as ActionFunctionArgs & { _waitUntil: ReturnType<typeof vi.fn> };
}

describeWithDb("Billing and Plan Coverage (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-billingplan";
  const _TEST_SHOP_DOMAIN = `test-shop-${TEST_SUFFIX}.myshopify.com`;
  const originalEnv = process.env;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql`DELETE FROM "Shop" WHERE domain LIKE ${'%-' + TEST_SUFFIX + '.myshopify.com'}`;
    await sql.end();
  });

  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...originalEnv, SHOPIFY_API_SECRET: SYNTHETIC_TEST_SECRET };
    await sql`DELETE FROM "Shop" WHERE domain LIKE ${'%-' + TEST_SUFFIX + '.myshopify.com'}`;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  /**
   * A. Plan handle redirect and currentAppInstallation query - table-driven.
   *
   * Tests how the app reads the current plan via:
   * 1. The plan_handle redirect param (processPlanWelcome)
   * 2. The currentAppInstallation activeSubscriptions query (fetchPlanFromShopify)
   */
  describe("A. Plan resolution from Admin API (table-driven)", () => {
    const KNOWN_HANDLES: Array<{ handle: string; expectedPlanKey: PlanKey; expectedLimit: number }> = [
      { handle: "starter", expectedPlanKey: "starter", expectedLimit: 25 },
      { handle: "growth", expectedPlanKey: "growth", expectedLimit: 100 },
      { handle: "unlimited", expectedPlanKey: "unlimited", expectedLimit: -1 },
    ];

    const PLAN_COVERAGE_GUARD = new Set(KNOWN_HANDLES.map(h => h.expectedPlanKey));

    it("coverage guard: all paid plan keys have a test row", () => {
      const paidPlanKeys = ALL_PLAN_KEYS.filter(k => k !== "none");
      for (const key of paidPlanKeys) {
        expect(PLAN_COVERAGE_GUARD.has(key)).toBe(true);
      }
    });

    it.each(KNOWN_HANDLES)(
      "handle '$handle' resolves to plan '$expectedPlanKey' with limit $expectedLimit",
      async ({ handle, expectedPlanKey, expectedLimit }) => {
        vi.resetModules();
        const mockAdminGraphQL = vi.fn();
        vi.doMock("~/services/drain/admin-client.server", () => ({
          adminGraphQL: mockAdminGraphQL,
        }));
        vi.doMock("~/lib/sentry", () => ({
          captureException: vi.fn(),
          captureMessage: vi.fn(),
          captureExceptionWithTags: vi.fn(),
        }));

        const shopDomain = `test-handle-${handle}-${TEST_SUFFIX}.myshopify.com`;

        await sql`
          INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
          VALUES (${shopDomain}, 'UTC', 'INR', 'none', NOW(), NOW())
        `;

        mockAdminGraphQL.mockResolvedValueOnce({
          success: true,
          data: {
            currentAppInstallation: {
              activeSubscriptions: [{
                id: `gid://shopify/AppSubscription/${handle}-sub-123`,
                name: handle.charAt(0).toUpperCase() + handle.slice(1),
                status: "ACTIVE",
                test: false,
                lineItems: [],
              }],
            },
          },
        });

        const { refreshPlanCache } = await import("~/services/plan.server");
        await refreshPlanCache(sql, shopDomain);

        const [shop] = await sql<{
          plan_key: string;
          subscription_name: string | null;
        }[]>`
          SELECT plan_key, subscription_name
          FROM "Shop" WHERE domain = ${shopDomain}
        `;

        expect(shop.plan_key).toBe(expectedPlanKey);

        const plan = getPlanConfig(shop.plan_key as PlanKey);
        expect(planLimit(plan, "companies")).toBe(expectedLimit);

        vi.doUnmock("~/services/drain/admin-client.server");
        vi.doUnmock("~/lib/sentry");
      }
    );

    it("Admin API query uses CurrentAppInstallation with activeSubscriptions", async () => {
      let capturedQuery: string | undefined;

      vi.resetModules();
      const mockAdminGraphQL = vi.fn().mockImplementation(async (_shop: string, query: string) => {
        capturedQuery = query;
        return {
          success: true,
          data: {
            currentAppInstallation: {
              activeSubscriptions: [{
                id: "gid://shopify/AppSubscription/query-test-123",
                name: "Starter",
                status: "ACTIVE",
                test: false,
                lineItems: [],
              }],
            },
          },
        };
      });

      vi.doMock("~/services/drain/admin-client.server", () => ({
        adminGraphQL: mockAdminGraphQL,
      }));
      vi.doMock("~/lib/sentry", () => ({
        captureException: vi.fn(),
        captureMessage: vi.fn(),
        captureExceptionWithTags: vi.fn(),
      }));

      const shopDomain = `test-query-shape-${TEST_SUFFIX}.myshopify.com`;

      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
        VALUES (${shopDomain}, 'UTC', 'INR', 'none', NOW(), NOW())
      `;

      const { refreshPlanCache } = await import("~/services/plan.server");
      await refreshPlanCache(sql, shopDomain);

      expect(capturedQuery).toBeDefined();
      expect(capturedQuery).toContain("currentAppInstallation");
      expect(capturedQuery).toContain("activeSubscriptions");
      expect(capturedQuery).toContain("status");
      expect(capturedQuery).toContain("name");
      expect(capturedQuery).toContain("test");

      vi.doUnmock("~/services/drain/admin-client.server");
      vi.doUnmock("~/lib/sentry");
    });
  });

  /**
   * B. Plan cache update on webhook + reinstall behavior (#468).
   */
  describe("B. Plan cache update on webhook (state transitions)", () => {
    it("ACTIVE status sets paid plan and updates cache", async () => {
      vi.resetModules();
      const mockAdminGraphQL = vi.fn();
      vi.doMock("~/services/drain/admin-client.server", () => ({
        adminGraphQL: mockAdminGraphQL,
      }));
      vi.doMock("~/lib/sentry", () => ({
        captureException: vi.fn(),
        captureMessage: vi.fn(),
        captureExceptionWithTags: vi.fn(),
      }));

      const shopDomain = `test-active-${TEST_SUFFIX}.myshopify.com`;

      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
        VALUES (${shopDomain}, 'UTC', 'INR', 'none', NOW(), NOW())
      `;

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: "gid://shopify/AppSubscription/active-sub",
              name: "Growth",
              status: "ACTIVE",
              test: false,
              lineItems: [],
            }],
          },
        },
      });

      const { refreshPlanCache } = await import("~/services/plan.server");
      await refreshPlanCache(sql, shopDomain);

      const [shop] = await sql<{
        plan_key: string;
        subscription_id: string | null;
        plan_cached_at: Date | null;
      }[]>`
        SELECT plan_key, subscription_id, plan_cached_at
        FROM "Shop" WHERE domain = ${shopDomain}
      `;

      expect(shop.plan_key).toBe("growth");
      expect(shop.subscription_id).toBe("gid://shopify/AppSubscription/active-sub");
      expect(shop.plan_cached_at).not.toBeNull();

      vi.doUnmock("~/services/drain/admin-client.server");
      vi.doUnmock("~/lib/sentry");
    });

    const NON_ACTIVE_STATUSES = ["DECLINED", "CANCELLED", "EXPIRED", "FROZEN"];

    it.each(NON_ACTIVE_STATUSES)(
      "%s status leaves no stale paid state (plan becomes none)",
      async (status) => {
        vi.resetModules();
        const localMockAdminGraphQL = vi.fn();
        vi.doMock("~/services/drain/admin-client.server", () => ({
          adminGraphQL: localMockAdminGraphQL,
        }));
        vi.doMock("~/lib/sentry", () => ({
          captureException: vi.fn(),
          captureMessage: vi.fn(),
          captureExceptionWithTags: vi.fn(),
        }));

        const shopDomain = `test-${status.toLowerCase()}-${TEST_SUFFIX}.myshopify.com`;

        await sql`
          INSERT INTO "Shop" (domain, timezone, currency, plan_key, subscription_id, "createdAt", "updatedAt")
          VALUES (${shopDomain}, 'UTC', 'INR', 'growth', 'gid://shopify/AppSubscription/old-sub', NOW(), NOW())
        `;

        localMockAdminGraphQL.mockResolvedValueOnce({
          success: true,
          data: {
            currentAppInstallation: {
              activeSubscriptions: [{
                id: `gid://shopify/AppSubscription/${status.toLowerCase()}-sub`,
                name: "Growth",
                status,
                test: false,
                lineItems: [],
              }],
            },
          },
        });

        const { refreshPlanCache } = await import("~/services/plan.server");
        await refreshPlanCache(sql, shopDomain);

        const [shop] = await sql<{ plan_key: string; subscription_id: string | null }[]>`
          SELECT plan_key, subscription_id FROM "Shop" WHERE domain = ${shopDomain}
        `;

        expect(shop.plan_key).toBe("none");
        expect(shop.subscription_id).toBeNull();

        vi.doUnmock("~/services/drain/admin-client.server");
        vi.doUnmock("~/lib/sentry");
      }
    );

    it("reinstall clears plan_cached_at (#468) forcing fresh read", async () => {
      const shopDomain = `test-reinstall-${TEST_SUFFIX}.myshopify.com`;
      const planCachedAt = new Date("2026-10-01T12:00:00Z");

      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, plan_cached_at, "createdAt", "updatedAt")
        VALUES (${shopDomain}, 'UTC', 'INR', 'growth', ${planCachedAt}, NOW(), NOW())
      `;

      const [before] = await sql<{ plan_cached_at: Date | null }[]>`
        SELECT plan_cached_at FROM "Shop" WHERE domain = ${shopDomain}
      `;
      expect(before.plan_cached_at?.getTime()).toBe(planCachedAt.getTime());

      const { markShopUninstalled } = await import("~/services/compliance");
      await markShopUninstalled(sql, shopDomain);

      const [afterUninstall] = await sql<{ plan_cached_at: Date | null; uninstalledAt: Date | null }[]>`
        SELECT plan_cached_at, "uninstalledAt" FROM "Shop" WHERE domain = ${shopDomain}
      `;

      expect(afterUninstall.uninstalledAt).not.toBeNull();
      expect(afterUninstall.plan_cached_at).toBeNull();

      const { upsertShopOnAuth } = await import("~/lib/after-auth.server");
      await upsertShopOnAuth(sql, shopDomain, "America/New_York", "INR");

      const [afterReinstall] = await sql<{
        plan_cached_at: Date | null;
        uninstalledAt: Date | null;
      }[]>`
        SELECT plan_cached_at, "uninstalledAt" FROM "Shop" WHERE domain = ${shopDomain}
      `;

      expect(afterReinstall.uninstalledAt).toBeNull();
      expect(afterReinstall.plan_cached_at).toBeNull();
    });
  });

  /**
   * C. Plan handle to features mapping - table-driven.
   */
  describe("C. Plan handle to features mapping (table-driven)", () => {
    const PLAN_FEATURE_MATRIX: Array<{
      planKey: PlanKey;
      companiesLimit: number;
      importsLimit: number;
      hasAllFeatures: boolean;
    }> = [
      { planKey: "none", companiesLimit: 0, importsLimit: -1, hasAllFeatures: true },
      { planKey: "starter", companiesLimit: 25, importsLimit: -1, hasAllFeatures: true },
      { planKey: "growth", companiesLimit: 100, importsLimit: -1, hasAllFeatures: true },
      { planKey: "unlimited", companiesLimit: -1, importsLimit: -1, hasAllFeatures: true },
    ];

    it("coverage guard: all plan keys have a feature matrix row", () => {
      const testedKeys = new Set(PLAN_FEATURE_MATRIX.map(r => r.planKey));
      for (const key of ALL_PLAN_KEYS) {
        expect(testedKeys.has(key)).toBe(true);
      }
    });

    it.each(PLAN_FEATURE_MATRIX)(
      "plan '$planKey' has companies=$companiesLimit, imports=$importsLimit, allFeatures=$hasAllFeatures",
      ({ planKey, companiesLimit, importsLimit, hasAllFeatures }) => {
        const plan = getPlanConfig(planKey);

        expect(plan.key).toBe(planKey);
        expect(planLimit(plan, "companies")).toBe(companiesLimit);
        expect(planLimit(plan, "importsPerMonth")).toBe(importsLimit);

        if (hasAllFeatures) {
          for (const feature of ALL_FEATURE_KEYS) {
            expect(planHasFeature(plan, feature)).toBe(true);
          }
        }
      }
    );

    it("resolvePlanKey maps all known handles correctly", () => {
      expect(resolvePlanKey("starter")).toBe("starter");
      expect(resolvePlanKey("Starter")).toBe("starter");
      expect(resolvePlanKey("STARTER")).toBe("starter");
      expect(resolvePlanKey("growth")).toBe("growth");
      expect(resolvePlanKey("Growth")).toBe("growth");
      expect(resolvePlanKey("unlimited")).toBe("unlimited");
      expect(resolvePlanKey("Unlimited")).toBe("unlimited");
    });

    it("resolvePlanKey maps legacy values correctly", () => {
      expect(resolvePlanKey("free")).toBe("none");
      expect(resolvePlanKey("scale")).toBe("unlimited");
    });
  });

  /**
   * D. PLAN_GATING_ENFORCED behavior.
   */
  describe("D. PLAN_GATING_ENFORCED behavior", () => {
    it("PLAN_GATING_ENFORCED='false' blocks nothing", async () => {
      vi.stubEnv("PLAN_GATING_ENFORCED", "false");
      vi.resetModules();

      const { isGatingEnforced, checkCompanyLimit, isAccountActive } = await import("~/services/gating.server");

      expect(isGatingEnforced()).toBe(false);

      const shopDomain = `test-gating-off-${TEST_SUFFIX}.myshopify.com`;
      const shopId = `shop-gating-off-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Shop" (id, domain, timezone, currency, plan_key, plan_cached_at, "createdAt", "updatedAt")
        VALUES (${shopId}, ${shopDomain}, 'UTC', 'INR', 'none', NOW(), NOW(), NOW())
      `;

      const result = await checkCompanyLimit(sql, shopId);
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("not enforced");

      expect(isAccountActive(null)).toBe(true);
      expect(isAccountActive(new Date())).toBe(true);
    });

    it("PLAN_GATING_ENFORCED='true' applies gates as documented", async () => {
      vi.stubEnv("PLAN_GATING_ENFORCED", "true");
      vi.resetModules();

      const { isGatingEnforced, checkCompanyLimit, isAccountActive } = await import("~/services/gating.server");

      expect(isGatingEnforced()).toBe(true);

      const shopDomain = `test-gating-on-${TEST_SUFFIX}.myshopify.com`;
      const shopId = `shop-gating-on-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Shop" (id, domain, timezone, currency, plan_key, plan_cached_at, "createdAt", "updatedAt")
        VALUES (${shopId}, ${shopDomain}, 'UTC', 'INR', 'none', NOW(), NOW(), NOW())
      `;

      const result = await checkCompanyLimit(sql, shopId);
      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(0);

      expect(isAccountActive(null)).toBe(true);
      expect(isAccountActive(new Date())).toBe(false);
    });

    it("PLAN_GATING_ENFORCED='1' is equivalent to 'true'", async () => {
      vi.stubEnv("PLAN_GATING_ENFORCED", "1");
      vi.resetModules();

      const { isGatingEnforced } = await import("~/services/gating.server");
      expect(isGatingEnforced()).toBe(true);
    });
  });

  /**
   * E. Unknown or missing handle fails safe.
   */
  describe("E. Unknown/missing handle fails safe", () => {
    it("unknown handle resolves to 'none' (no paid features when gating on)", () => {
      expect(resolvePlanKey("unknown_plan_xyz")).toBe("none");
      expect(resolvePlanKey("premium")).toBe("none");
      expect(resolvePlanKey("enterprise")).toBe("none");
      expect(resolvePlanKey("$0_test_plan")).toBe("none");
    });

    it("missing/null/empty handle resolves to 'none'", () => {
      expect(resolvePlanKey(null)).toBe("none");
      expect(resolvePlanKey(undefined)).toBe("none");
      expect(resolvePlanKey("")).toBe("none");
      expect(resolvePlanKey("   ")).toBe("none");
    });

    it("getPlanConfig handles unknown keys defensively", () => {
      const plan = getPlanConfig("unknown_key" as PlanKey);
      expect(plan.key).toBe("none");
      expect(planLimit(plan, "companies")).toBe(0);
    });

    it("Admin API returns no active subscription -> plan is none", async () => {
      vi.resetModules();
      const mockAdminGraphQL = vi.fn();
      vi.doMock("~/services/drain/admin-client.server", () => ({
        adminGraphQL: mockAdminGraphQL,
      }));
      vi.doMock("~/lib/sentry", () => ({
        captureException: vi.fn(),
        captureMessage: vi.fn(),
        captureExceptionWithTags: vi.fn(),
      }));

      const shopDomain = `test-no-sub-${TEST_SUFFIX}.myshopify.com`;

      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
        VALUES (${shopDomain}, 'UTC', 'INR', 'growth', NOW(), NOW())
      `;

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [],
          },
        },
      });

      const { refreshPlanCache } = await import("~/services/plan.server");
      await refreshPlanCache(sql, shopDomain);

      const [shop] = await sql<{ plan_key: string }[]>`
        SELECT plan_key FROM "Shop" WHERE domain = ${shopDomain}
      `;

      expect(shop.plan_key).toBe("none");

      vi.doUnmock("~/services/drain/admin-client.server");
      vi.doUnmock("~/lib/sentry");
    });
  });

  /**
   * F. Webhook HMAC failure - rejected with no plan or cache change.
   */
  describe("F. Webhook HMAC failure", () => {
    it("bad HMAC returns 401 and leaves DB unchanged", async () => {
      const shopDomain = `test-hmac-fail-${TEST_SUFFIX}.myshopify.com`;

      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, subscription_id, subscription_name, is_test, plan_cached_at, "createdAt", "updatedAt")
        VALUES (${shopDomain}, 'UTC', 'INR', 'growth', 'gid://shopify/AppSubscription/existing', 'Growth', false, NOW(), NOW(), NOW())
      `;

      const [before] = await sql<{
        plan_key: string;
        subscription_id: string | null;
        subscription_name: string | null;
        is_test: boolean;
        plan_cached_at: Date | null;
        updatedAt: Date;
      }[]>`
        SELECT plan_key, subscription_id, subscription_name, is_test, plan_cached_at, "updatedAt"
        FROM "Shop" WHERE domain = ${shopDomain}
      `;

      const payload = { app_subscription: { id: "gid://shopify/AppSubscription/attacker" } };
      const body = JSON.stringify(payload);
      const wrongHmac = generateShopifyHmac(body, "wrong-secret-not-real");

      const request = createSignedWebhookRequest(body, "app_subscriptions/update", SYNTHETIC_TEST_SECRET, {
        shopDomain,
        wrongHmac,
      });

      const { action } = await import("~/routes/webhooks.app.subscriptions_update");

      await expect(action(createMockWebhookActionArgs(request))).rejects.toMatchObject({
        status: 401,
      });

      const [after] = await sql<{
        plan_key: string;
        subscription_id: string | null;
        subscription_name: string | null;
        is_test: boolean;
        plan_cached_at: Date | null;
        updatedAt: Date;
      }[]>`
        SELECT plan_key, subscription_id, subscription_name, is_test, plan_cached_at, "updatedAt"
        FROM "Shop" WHERE domain = ${shopDomain}
      `;

      expect(after.plan_key).toBe(before.plan_key);
      expect(after.subscription_id).toBe(before.subscription_id);
      expect(after.subscription_name).toBe(before.subscription_name);
      expect(after.is_test).toBe(before.is_test);
      expect(after.plan_cached_at?.getTime()).toBe(before.plan_cached_at?.getTime());
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    });

    it("missing HMAC header returns 401", async () => {
      const shopDomain = `test-hmac-missing-${TEST_SUFFIX}.myshopify.com`;
      const payload = { app_subscription: { id: "gid://shopify/AppSubscription/test" } };
      const body = JSON.stringify(payload);

      const request = createSignedWebhookRequest(body, "app_subscriptions/update", SYNTHETIC_TEST_SECRET, {
        shopDomain,
        omitHmac: true,
      });

      const { action } = await import("~/routes/webhooks.app.subscriptions_update");

      await expect(action(createMockWebhookActionArgs(request))).rejects.toMatchObject({
        status: 401,
      });
    });

    it("tampered body with original HMAC returns 401", async () => {
      const shopDomain = `test-hmac-tamper-${TEST_SUFFIX}.myshopify.com`;
      const originalPayload = { app_subscription: { id: "gid://shopify/AppSubscription/original" } };
      const originalBody = JSON.stringify(originalPayload);
      const hmac = generateShopifyHmac(originalBody, SYNTHETIC_TEST_SECRET);

      const tamperedPayload = { app_subscription: { id: "gid://shopify/AppSubscription/tampered" } };
      const tamperedBody = JSON.stringify(tamperedPayload);

      const request = new Request("https://example.com/webhooks/app/subscriptions_update", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Topic": "app_subscriptions/update",
          "X-Shopify-Shop-Domain": shopDomain,
          "X-Shopify-Hmac-Sha256": hmac,
          "X-Shopify-Webhook-Id": "tamper-test-123",
          "X-Shopify-API-Version": "2026-10",
        },
        body: tamperedBody,
      });

      const { action } = await import("~/routes/webhooks.app.subscriptions_update");

      await expect(action(createMockWebhookActionArgs(request))).rejects.toMatchObject({
        status: 401,
      });
    });
  });

  /**
   * G. Log sanitization - no shop domain, gid://, or charge/subscription id.
   */
  describe("G. Log sanitization", () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
    let consoleDebugSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      consoleInfoSpy.mockRestore();
      consoleDebugSpy.mockRestore();
    });

    function getAllConsoleOutput(): string[] {
      const allCalls = [
        ...consoleLogSpy.mock.calls,
        ...consoleWarnSpy.mock.calls,
        ...consoleErrorSpy.mock.calls,
        ...consoleInfoSpy.mock.calls,
        ...consoleDebugSpy.mock.calls,
      ];
      return allCalls.map(args =>
        args.map((arg: unknown) =>
          typeof arg === "object" ? JSON.stringify(arg) : String(arg)
        ).join(" ")
      );
    }

    function assertNoSensitiveData(testShopDomain?: string): void {
      const allOutput = getAllConsoleOutput();
      const outputStr = allOutput.join("\n");

      expect(outputStr).not.toMatch(/\.myshopify\.com/i);
      expect(outputStr).not.toMatch(/gid:\/\/shopify\/App/i);
      expect(outputStr).not.toMatch(/charge_id/i);

      if (testShopDomain) {
        expect(outputStr).not.toContain(testShopDomain);
      }
    }

    it("plan refresh logs contain no shop domain or subscription GID", async () => {
      vi.resetModules();
      const mockAdminGraphQL = vi.fn();
      vi.doMock("~/services/drain/admin-client.server", () => ({
        adminGraphQL: mockAdminGraphQL,
      }));
      vi.doMock("~/lib/sentry", () => ({
        captureException: vi.fn(),
        captureMessage: vi.fn(),
        captureExceptionWithTags: vi.fn(),
      }));

      const shopDomain = `test-log-refresh-${TEST_SUFFIX}.myshopify.com`;

      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
        VALUES (${shopDomain}, 'UTC', 'INR', 'none', NOW(), NOW())
      `;

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: "gid://shopify/AppSubscription/log-test-sub",
              name: "Starter",
              status: "ACTIVE",
              test: false,
              lineItems: [],
            }],
          },
        },
      });

      const { refreshPlanCache } = await import("~/services/plan.server");
      await refreshPlanCache(sql, shopDomain);

      assertNoSensitiveData(shopDomain);

      vi.doUnmock("~/services/drain/admin-client.server");
      vi.doUnmock("~/lib/sentry");
    });

    it("webhook success path logs contain no sensitive data", async () => {
      vi.resetModules();
      const mockAdminGraphQL = vi.fn().mockResolvedValue({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: "gid://shopify/AppSubscription/webhook-log-sub",
              name: "Growth",
              status: "ACTIVE",
              test: false,
              lineItems: [],
            }],
          },
        },
      });

      vi.doMock("~/services/drain/admin-client.server", () => ({
        adminGraphQL: mockAdminGraphQL,
      }));
      vi.doMock("~/lib/sentry", () => ({
        captureException: vi.fn(),
        captureMessage: vi.fn(),
        captureExceptionWithTags: vi.fn(),
      }));
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: vi.fn(() => sql),
      }));
      vi.doMock("~/services/gating.server", () => ({
        reactivateGatedAccounts: vi.fn().mockResolvedValue(0),
      }));

      const shopDomain = `test-log-webhook-${TEST_SUFFIX}.myshopify.com`;

      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
        VALUES (${shopDomain}, 'UTC', 'INR', 'none', NOW(), NOW())
      `;

      const payload = { app_subscription: { id: "gid://shopify/AppSubscription/webhook-log-sub" } };
      const body = JSON.stringify(payload);

      const request = createSignedWebhookRequest(body, "app_subscriptions/update", SYNTHETIC_TEST_SECRET, {
        shopDomain,
        webhookId: "log-test-webhook-id",
      });

      const { action } = await import("~/routes/webhooks.app.subscriptions_update");

      const args = createMockWebhookActionArgs(request);
      const response = await action(args);
      expect(response.status).toBe(200);

      if (args._waitUntil.mock.calls.length > 0) {
        await args._waitUntil.mock.calls[0][0];
      }

      assertNoSensitiveData(shopDomain);

      vi.doUnmock("~/services/drain/admin-client.server");
      vi.doUnmock("~/lib/sentry");
      vi.doUnmock("~/lib/request-context.server");
      vi.doUnmock("~/services/gating.server");
    });

    it("HMAC failure path logs contain no sensitive data", async () => {
      const shopDomain = `test-log-hmac-fail-${TEST_SUFFIX}.myshopify.com`;
      const payload = { app_subscription: { id: "gid://shopify/AppSubscription/hmac-fail-log" } };
      const body = JSON.stringify(payload);
      const wrongHmac = generateShopifyHmac(body, "wrong-secret");

      const request = createSignedWebhookRequest(body, "app_subscriptions/update", SYNTHETIC_TEST_SECRET, {
        shopDomain,
        wrongHmac,
      });

      const { action } = await import("~/routes/webhooks.app.subscriptions_update");

      try {
        await action(createMockWebhookActionArgs(request));
      } catch {
        // Expected 401
      }

      assertNoSensitiveData(shopDomain);
    });

    it("gating check logs contain no sensitive data", async () => {
      vi.stubEnv("PLAN_GATING_ENFORCED", "true");
      vi.resetModules();

      const shopDomain = `test-log-gating-${TEST_SUFFIX}.myshopify.com`;
      const shopId = `shop-log-gating-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Shop" (id, domain, timezone, currency, plan_key, plan_cached_at, "createdAt", "updatedAt")
        VALUES (${shopId}, ${shopDomain}, 'UTC', 'INR', 'none', NOW(), NOW(), NOW())
      `;

      const { checkCompanyLimit } = await import("~/services/gating.server");
      await checkCompanyLimit(sql, shopId);

      assertNoSensitiveData(shopDomain);
    });
  });

  /**
   * Additional: Test subscription test flag behavior.
   */
  describe("Additional: Test subscription flag", () => {
    it("test:true from API is stored in is_test column", async () => {
      vi.resetModules();
      const mockAdminGraphQL = vi.fn();
      vi.doMock("~/services/drain/admin-client.server", () => ({
        adminGraphQL: mockAdminGraphQL,
      }));
      vi.doMock("~/lib/sentry", () => ({
        captureException: vi.fn(),
        captureMessage: vi.fn(),
        captureExceptionWithTags: vi.fn(),
      }));

      const shopDomain = `test-flag-true-${TEST_SUFFIX}.myshopify.com`;

      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
        VALUES (${shopDomain}, 'UTC', 'INR', 'none', NOW(), NOW())
      `;

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: "gid://shopify/AppSubscription/test-sub",
              name: "Growth",
              status: "ACTIVE",
              test: true,
              lineItems: [],
            }],
          },
        },
      });

      const { refreshPlanCache, resolvePlan } = await import("~/services/plan.server");
      await refreshPlanCache(sql, shopDomain);

      const [shop] = await sql<{ is_test: boolean }[]>`
        SELECT is_test FROM "Shop" WHERE domain = ${shopDomain}
      `;
      expect(shop.is_test).toBe(true);

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: "gid://shopify/AppSubscription/test-sub",
              name: "Growth",
              status: "ACTIVE",
              test: true,
              lineItems: [],
            }],
          },
        },
      });

      const resolved = await resolvePlan(sql, shopDomain, true);
      expect(resolved.isTest).toBe(true);

      vi.doUnmock("~/services/drain/admin-client.server");
      vi.doUnmock("~/lib/sentry");
    });

    it("test:false from API is stored in is_test column", async () => {
      vi.resetModules();
      const mockAdminGraphQL = vi.fn();
      vi.doMock("~/services/drain/admin-client.server", () => ({
        adminGraphQL: mockAdminGraphQL,
      }));
      vi.doMock("~/lib/sentry", () => ({
        captureException: vi.fn(),
        captureMessage: vi.fn(),
        captureExceptionWithTags: vi.fn(),
      }));

      const shopDomain = `test-flag-false-${TEST_SUFFIX}.myshopify.com`;

      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, is_test, "createdAt", "updatedAt")
        VALUES (${shopDomain}, 'UTC', 'INR', 'none', true, NOW(), NOW())
      `;

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: "gid://shopify/AppSubscription/prod-sub",
              name: "Growth",
              status: "ACTIVE",
              test: false,
              lineItems: [],
            }],
          },
        },
      });

      const { refreshPlanCache } = await import("~/services/plan.server");
      await refreshPlanCache(sql, shopDomain);

      const [shop] = await sql<{ is_test: boolean }[]>`
        SELECT is_test FROM "Shop" WHERE domain = ${shopDomain}
      `;
      expect(shop.is_test).toBe(false);

      vi.doUnmock("~/services/drain/admin-client.server");
      vi.doUnmock("~/lib/sentry");
    });
  });
});
