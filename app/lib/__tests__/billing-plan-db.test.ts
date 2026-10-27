/**
 * Billing and Plan Coverage Tests (S21) - Additions beyond #481.
 *
 * Tests unique Managed Pricing features not covered by billing-plan-state-db.test.ts:
 * A. Plan resolution via currentAppInstallation activeSubscriptions query - table-driven
 * C. Plan handle to features mapping - table-driven
 * D. PLAN_GATING_ENFORCED behavior
 * E. Unknown/missing handle fails safe
 * G. Log sanitization - no shop domain, gid://, or charge/subscription id
 *
 * Uses real DB rows (Sequential DB group via describeWithDb) and mocked Admin GraphQL.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import crypto from "node:crypto";
import { sqlOptions } from "~/lib/db-light.server";
import {
  ALL_PLAN_KEYS,
  ALL_FEATURE_KEYS,
  type PlanKey,
  getPlanConfig,
  planLimit,
  planHasFeature,
  resolvePlanKey,
} from "~/lib/entitlements";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const SYNTHETIC_TEST_SECRET = "synthetic-billing-test-secret-s21";

function generateShopifyHmac(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

describeWithDb("Billing and Plan Coverage (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-billingplan";
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
   * A. Plan resolution via currentAppInstallation activeSubscriptions query - table-driven.
   *
   * Tests how the app reads the current plan via the Admin GraphQL
   * currentAppInstallation activeSubscriptions query (fetchPlanFromShopify).
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
   * C. Plan handle to features mapping - table-driven.
   */
  describe("C. Plan handle to features mapping (table-driven)", () => {
    const PLAN_FEATURE_MATRIX: Array<{
      planKey: PlanKey;
      companiesLimit: number;
      importsLimit: number;
      aging_dashboard: boolean;
      unlimited_imports: boolean;
      matching: boolean;
      reminders: boolean;
      credit_holds: boolean;
    }> = [
      { planKey: "none", companiesLimit: 0, importsLimit: -1, aging_dashboard: true, unlimited_imports: true, matching: true, reminders: true, credit_holds: true },
      { planKey: "starter", companiesLimit: 25, importsLimit: -1, aging_dashboard: true, unlimited_imports: true, matching: true, reminders: true, credit_holds: true },
      { planKey: "growth", companiesLimit: 100, importsLimit: -1, aging_dashboard: true, unlimited_imports: true, matching: true, reminders: true, credit_holds: true },
      { planKey: "unlimited", companiesLimit: -1, importsLimit: -1, aging_dashboard: true, unlimited_imports: true, matching: true, reminders: true, credit_holds: true },
    ];

    it("coverage guard: all plan keys have a feature matrix row", () => {
      const testedKeys = new Set(PLAN_FEATURE_MATRIX.map(r => r.planKey));
      for (const key of ALL_PLAN_KEYS) {
        expect(testedKeys.has(key)).toBe(true);
      }

      const NON_FEATURE_KEYS = ["planKey", "companiesLimit", "importsLimit"];
      for (const row of PLAN_FEATURE_MATRIX) {
        const featureColumns = Object.keys(row).filter(k => !NON_FEATURE_KEYS.includes(k)).sort();
        expect(featureColumns).toEqual([...ALL_FEATURE_KEYS].sort());
      }
    });

    it.each(PLAN_FEATURE_MATRIX)(
      "plan '$planKey' has companies=$companiesLimit, imports=$importsLimit, features as expected",
      ({ planKey, companiesLimit, importsLimit, aging_dashboard, unlimited_imports, matching, reminders, credit_holds }) => {
        const plan = getPlanConfig(planKey);

        expect(plan.key).toBe(planKey);
        expect(planLimit(plan, "companies")).toBe(companiesLimit);
        expect(planLimit(plan, "importsPerMonth")).toBe(importsLimit);

        expect(planHasFeature(plan, "aging_dashboard")).toBe(aging_dashboard);
        expect(planHasFeature(plan, "unlimited_imports")).toBe(unlimited_imports);
        expect(planHasFeature(plan, "matching")).toBe(matching);
        expect(planHasFeature(plan, "reminders")).toBe(reminders);
        expect(planHasFeature(plan, "credit_holds")).toBe(credit_holds);
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

    function assertNoSensitiveData(
      testShopDomain: string,
      syntheticSubscriptionIds: string[]
    ): void {
      const allOutput = getAllConsoleOutput();
      const outputStr = allOutput.join("\n");

      expect(outputStr).not.toMatch(/\.myshopify\.com/i);
      expect(outputStr).not.toMatch(/gid:\/\/shopify\/App/i);
      expect(outputStr).not.toMatch(/charge_id/i);

      expect(outputStr).not.toContain(testShopDomain);

      for (const subId of syntheticSubscriptionIds) {
        expect(outputStr).not.toContain(subId);
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
      const syntheticSubId = "log-test-sub-refresh";

      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
        VALUES (${shopDomain}, 'UTC', 'INR', 'none', NOW(), NOW())
      `;

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: `gid://shopify/AppSubscription/${syntheticSubId}`,
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

      const allOutput = getAllConsoleOutput();
      expect(allOutput.length).toBeGreaterThan(0);
      expect(allOutput.some(line => line.includes("plan_cache_refreshed"))).toBe(true);

      assertNoSensitiveData(shopDomain, [syntheticSubId]);

      vi.doUnmock("~/services/drain/admin-client.server");
      vi.doUnmock("~/lib/sentry");
    });

    it("webhook success path logs contain no sensitive data", async () => {
      vi.resetModules();
      const syntheticSubId = "webhook-log-sub-success";
      const mockAdminGraphQL = vi.fn().mockResolvedValue({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: `gid://shopify/AppSubscription/${syntheticSubId}`,
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

      const payload = { app_subscription: { id: `gid://shopify/AppSubscription/${syntheticSubId}` } };
      const body = JSON.stringify(payload);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Shopify-API-Version": "2026-10",
        "X-Shopify-Webhook-Id": "log-test-webhook-id",
        "X-Shopify-Topic": "app_subscriptions/update",
        "X-Shopify-Shop-Domain": shopDomain,
        "X-Shopify-Hmac-Sha256": generateShopifyHmac(body, SYNTHETIC_TEST_SECRET),
      };

      const request = new Request("https://example.com/webhooks/app/subscriptions_update", {
        method: "POST",
        headers,
        body,
      });

      const mockWaitUntil = vi.fn();
      const args = {
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
      };

      const { action } = await import("~/routes/webhooks.app.subscriptions_update");
      const response = await action(args as Parameters<typeof action>[0]);
      expect(response.status).toBe(200);

      expect(mockWaitUntil).toHaveBeenCalledTimes(1);
      await mockWaitUntil.mock.calls[0][0];

      const allOutput = getAllConsoleOutput();
      expect(allOutput.length).toBeGreaterThan(0);
      expect(allOutput.some(line => line.includes("Refreshed plan"))).toBe(true);

      assertNoSensitiveData(shopDomain, [syntheticSubId]);

      vi.doUnmock("~/services/drain/admin-client.server");
      vi.doUnmock("~/lib/sentry");
      vi.doUnmock("~/lib/request-context.server");
      vi.doUnmock("~/services/gating.server");
    });
  });
});
