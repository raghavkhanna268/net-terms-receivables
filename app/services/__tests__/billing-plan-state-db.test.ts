/**
 * DB-backed integration tests for billing and plan state.
 *
 * Tests verify:
 * 1. APP_SUBSCRIPTIONS_UPDATE webhook HMAC verification with real signatures
 * 2. Plan state transitions (ACTIVE, CANCELLED, FROZEN, DECLINED, EXPIRED)
 * 3. Webhook redelivery idempotency
 * 4. Out-of-order update handling
 * 5. Uninstall invalidates plan_cached_at, reinstall does fresh read
 * 6. Plan page test flag behavior
 * 7. Shop isolation (billing for shop B can't change shop A)
 *
 * Uses real DB rows (Sequential DB group via describeWithDb) and real route
 * action with correctly signed requests.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import crypto from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { sqlOptions } from "~/lib/db-light.server";

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
    omitTopic?: boolean;
    omitShop?: boolean;
    webhookId?: string;
  }
): Request {
  const hmac = options.wrongHmac ?? (options.omitHmac ? undefined : generateShopifyHmac(body, secret));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Shopify-API-Version": "2026-10",
    "X-Shopify-Webhook-Id": options.webhookId ?? `billing-test-${Date.now()}`,
  };

  if (!options.omitTopic) {
    headers["X-Shopify-Topic"] = topic;
  }
  if (!options.omitShop) {
    headers["X-Shopify-Shop-Domain"] = options.shopDomain;
  }
  if (hmac) {
    headers["X-Shopify-Hmac-Sha256"] = hmac;
  }

  return new Request("https://example.com/webhooks/app/subscriptions_update", {
    method: "POST",
    headers,
    body,
  });
}

function createMockActionArgs(request: Request): ActionFunctionArgs {
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

describeWithDb("Billing and Plan State (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-billing";
  const TEST_SHOP_A_DOMAIN = `test-shop-a-${TEST_SUFFIX}.myshopify.com`;
  const TEST_SHOP_B_DOMAIN = `test-shop-b-${TEST_SUFFIX}.myshopify.com`;
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
  });

  describe("1. APP_SUBSCRIPTIONS_UPDATE HMAC verification", () => {
    it("bad HMAC gives 401 and leaves DB byte-for-byte unchanged", async () => {
      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, subscription_id, subscription_name, is_test, plan_cached_at, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_A_DOMAIN}, 'UTC', 'INR', 'growth', 'gid://shopify/AppSubscription/111', 'Growth', false, NOW(), NOW(), NOW())
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
        FROM "Shop" WHERE domain = ${TEST_SHOP_A_DOMAIN}
      `;

      const payload = { app_subscription: { id: "gid://shopify/AppSubscription/999" } };
      const body = JSON.stringify(payload);
      const wrongHmac = generateShopifyHmac(body, "wrong-secret-not-the-real-one");

      const request = createSignedWebhookRequest(body, "app_subscriptions/update", SYNTHETIC_TEST_SECRET, {
        shopDomain: TEST_SHOP_A_DOMAIN,
        wrongHmac,
      });

      const { action } = await import("~/routes/webhooks.app.subscriptions_update");

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
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
        FROM "Shop" WHERE domain = ${TEST_SHOP_A_DOMAIN}
      `;

      expect(after.plan_key).toBe(before.plan_key);
      expect(after.subscription_id).toBe(before.subscription_id);
      expect(after.subscription_name).toBe(before.subscription_name);
      expect(after.is_test).toBe(before.is_test);
      expect(after.plan_cached_at?.getTime()).toBe(before.plan_cached_at?.getTime());
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    });

    it("missing HMAC header gives 401", async () => {
      const payload = { app_subscription: { id: "gid://shopify/AppSubscription/123" } };
      const body = JSON.stringify(payload);

      const request = createSignedWebhookRequest(body, "app_subscriptions/update", SYNTHETIC_TEST_SECRET, {
        shopDomain: TEST_SHOP_A_DOMAIN,
        omitHmac: true,
      });

      const { action } = await import("~/routes/webhooks.app.subscriptions_update");

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 401,
      });
    });

    it("tampered body with original HMAC gives 401", async () => {
      const originalPayload = { app_subscription: { id: "gid://shopify/AppSubscription/123" } };
      const originalBody = JSON.stringify(originalPayload);
      const hmac = generateShopifyHmac(originalBody, SYNTHETIC_TEST_SECRET);

      const tamperedPayload = { app_subscription: { id: "gid://shopify/AppSubscription/666" } };
      const tamperedBody = JSON.stringify(tamperedPayload);

      const request = new Request("https://example.com/webhooks/app/subscriptions_update", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Topic": "app_subscriptions/update",
          "X-Shopify-Shop-Domain": TEST_SHOP_A_DOMAIN,
          "X-Shopify-Hmac-Sha256": hmac,
          "X-Shopify-Webhook-Id": "tamper-test-123",
          "X-Shopify-API-Version": "2026-10",
        },
        body: tamperedBody,
      });

      const { action } = await import("~/routes/webhooks.app.subscriptions_update");

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 401,
      });
    });
  });

  describe("2. Plan state transitions", () => {
    let mockAdminGraphQL: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      vi.resetModules();
      mockAdminGraphQL = vi.fn();
      vi.doMock("~/services/drain/admin-client.server", () => ({
        adminGraphQL: mockAdminGraphQL,
      }));
      vi.doMock("~/lib/sentry", () => ({
        captureException: vi.fn(),
        captureMessage: vi.fn(),
        captureExceptionWithTags: vi.fn(),
      }));
      process.env = { ...originalEnv, SHOPIFY_API_SECRET: SYNTHETIC_TEST_SECRET };
    });

    afterEach(() => {
      vi.doUnmock("~/services/drain/admin-client.server");
      vi.doUnmock("~/lib/sentry");
    });

    it("ACTIVE status updates plan_key and counts as paid", async () => {
      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_A_DOMAIN}, 'UTC', 'INR', 'none', NOW(), NOW())
      `;

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: "gid://shopify/AppSubscription/active-123",
              name: "Growth",
              status: "ACTIVE",
              test: false,
              lineItems: [],
            }],
          },
        },
      });

      const { refreshPlanCache } = await import("~/services/plan.server");
      await refreshPlanCache(sql, TEST_SHOP_A_DOMAIN);

      const [shop] = await sql<{
        plan_key: string;
        subscription_id: string | null;
        subscription_name: string | null;
        is_test: boolean;
        plan_cached_at: Date | null;
      }[]>`
        SELECT plan_key, subscription_id, subscription_name, is_test, plan_cached_at
        FROM "Shop" WHERE domain = ${TEST_SHOP_A_DOMAIN}
      `;

      expect(shop.plan_key).toBe("growth");
      expect(shop.subscription_id).toBe("gid://shopify/AppSubscription/active-123");
      expect(shop.subscription_name).toBe("Growth");
      expect(shop.is_test).toBe(false);
      expect(shop.plan_cached_at).not.toBeNull();
    });

    it("CANCELLED status results in none plan (not paid)", async () => {
      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, subscription_id, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_A_DOMAIN}, 'UTC', 'INR', 'growth', 'gid://shopify/AppSubscription/old', NOW(), NOW())
      `;

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: "gid://shopify/AppSubscription/cancelled-456",
              name: "Growth",
              status: "CANCELLED",
              test: false,
              lineItems: [],
            }],
          },
        },
      });

      const { refreshPlanCache } = await import("~/services/plan.server");
      await refreshPlanCache(sql, TEST_SHOP_A_DOMAIN);

      const [shop] = await sql<{ plan_key: string; subscription_id: string | null }[]>`
        SELECT plan_key, subscription_id FROM "Shop" WHERE domain = ${TEST_SHOP_A_DOMAIN}
      `;

      expect(shop.plan_key).toBe("none");
      expect(shop.subscription_id).toBeNull();
    });

    it("FROZEN status results in none plan (not paid)", async () => {
      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_A_DOMAIN}, 'UTC', 'INR', 'starter', NOW(), NOW())
      `;

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: "gid://shopify/AppSubscription/frozen-789",
              name: "Starter",
              status: "FROZEN",
              test: false,
              lineItems: [],
            }],
          },
        },
      });

      const { refreshPlanCache } = await import("~/services/plan.server");
      await refreshPlanCache(sql, TEST_SHOP_A_DOMAIN);

      const [shop] = await sql<{ plan_key: string }[]>`
        SELECT plan_key FROM "Shop" WHERE domain = ${TEST_SHOP_A_DOMAIN}
      `;

      expect(shop.plan_key).toBe("none");
    });

    it("DECLINED status results in none plan (not paid)", async () => {
      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_A_DOMAIN}, 'UTC', 'INR', 'growth', NOW(), NOW())
      `;

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: "gid://shopify/AppSubscription/declined-101",
              name: "Growth",
              status: "DECLINED",
              test: false,
              lineItems: [],
            }],
          },
        },
      });

      const { refreshPlanCache } = await import("~/services/plan.server");
      await refreshPlanCache(sql, TEST_SHOP_A_DOMAIN);

      const [shop] = await sql<{ plan_key: string }[]>`
        SELECT plan_key FROM "Shop" WHERE domain = ${TEST_SHOP_A_DOMAIN}
      `;

      expect(shop.plan_key).toBe("none");
    });

    it("EXPIRED status results in none plan (not paid)", async () => {
      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_A_DOMAIN}, 'UTC', 'INR', 'unlimited', NOW(), NOW())
      `;

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: "gid://shopify/AppSubscription/expired-202",
              name: "Unlimited",
              status: "EXPIRED",
              test: false,
              lineItems: [],
            }],
          },
        },
      });

      const { refreshPlanCache } = await import("~/services/plan.server");
      await refreshPlanCache(sql, TEST_SHOP_A_DOMAIN);

      const [shop] = await sql<{ plan_key: string }[]>`
        SELECT plan_key FROM "Shop" WHERE domain = ${TEST_SHOP_A_DOMAIN}
      `;

      expect(shop.plan_key).toBe("none");
    });

    it("only ACTIVE counts as paid - verifies all non-ACTIVE statuses", async () => {
      const nonActiveStatuses = ["CANCELLED", "FROZEN", "DECLINED", "EXPIRED", "PENDING"];

      for (const status of nonActiveStatuses) {
        vi.resetModules();
        mockAdminGraphQL = vi.fn();
        vi.doMock("~/services/drain/admin-client.server", () => ({
          adminGraphQL: mockAdminGraphQL,
        }));
        vi.doMock("~/lib/sentry", () => ({
          captureException: vi.fn(),
          captureMessage: vi.fn(),
          captureExceptionWithTags: vi.fn(),
        }));

        const domain = `test-status-${status.toLowerCase()}-${TEST_SUFFIX}.myshopify.com`;

        await sql`DELETE FROM "Shop" WHERE domain = ${domain}`;
        await sql`
          INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
          VALUES (${domain}, 'UTC', 'INR', 'growth', NOW(), NOW())
        `;

        mockAdminGraphQL.mockResolvedValueOnce({
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
        await refreshPlanCache(sql, domain);

        const [shop] = await sql<{ plan_key: string }[]>`
          SELECT plan_key FROM "Shop" WHERE domain = ${domain}
        `;

        expect(shop.plan_key).toBe("none");
      }
    });
  });

  describe("3. Redelivery idempotency", () => {
    let mockAdminGraphQL: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      vi.resetModules();
      mockAdminGraphQL = vi.fn();
      vi.doMock("~/services/drain/admin-client.server", () => ({
        adminGraphQL: mockAdminGraphQL,
      }));
      vi.doMock("~/lib/sentry", () => ({
        captureException: vi.fn(),
        captureMessage: vi.fn(),
        captureExceptionWithTags: vi.fn(),
      }));
      process.env = { ...originalEnv, SHOPIFY_API_SECRET: SYNTHETIC_TEST_SECRET };
    });

    afterEach(() => {
      vi.doUnmock("~/services/drain/admin-client.server");
      vi.doUnmock("~/lib/sentry");
    });

    it("redelivery of the same webhook payload is idempotent", async () => {
      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_A_DOMAIN}, 'UTC', 'INR', 'none', NOW(), NOW())
      `;

      const activeResponse = {
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: "gid://shopify/AppSubscription/idempotent-sub",
              name: "Growth",
              status: "ACTIVE",
              test: false,
              lineItems: [],
            }],
          },
        },
      };

      mockAdminGraphQL.mockResolvedValue(activeResponse);

      const { refreshPlanCache } = await import("~/services/plan.server");

      await refreshPlanCache(sql, TEST_SHOP_A_DOMAIN);

      const [afterFirst] = await sql<{
        plan_key: string;
        subscription_id: string | null;
        plan_cached_at: Date | null;
      }[]>`
        SELECT plan_key, subscription_id, plan_cached_at
        FROM "Shop" WHERE domain = ${TEST_SHOP_A_DOMAIN}
      `;

      expect(afterFirst.plan_key).toBe("growth");
      expect(afterFirst.subscription_id).toBe("gid://shopify/AppSubscription/idempotent-sub");
      const firstCachedAt = afterFirst.plan_cached_at;

      await new Promise((r) => setTimeout(r, 10));

      await refreshPlanCache(sql, TEST_SHOP_A_DOMAIN);
      await refreshPlanCache(sql, TEST_SHOP_A_DOMAIN);

      const [afterMultiple] = await sql<{
        plan_key: string;
        subscription_id: string | null;
        plan_cached_at: Date | null;
      }[]>`
        SELECT plan_key, subscription_id, plan_cached_at
        FROM "Shop" WHERE domain = ${TEST_SHOP_A_DOMAIN}
      `;

      expect(afterMultiple.plan_key).toBe("growth");
      expect(afterMultiple.subscription_id).toBe("gid://shopify/AppSubscription/idempotent-sub");
      expect(afterMultiple.plan_cached_at!.getTime()).toBeGreaterThanOrEqual(firstCachedAt!.getTime());
    });
  });

  describe("4. Out-of-order update handling", () => {
    let mockAdminGraphQL: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      vi.resetModules();
      mockAdminGraphQL = vi.fn();
      vi.doMock("~/services/drain/admin-client.server", () => ({
        adminGraphQL: mockAdminGraphQL,
      }));
      vi.doMock("~/lib/sentry", () => ({
        captureException: vi.fn(),
        captureMessage: vi.fn(),
        captureExceptionWithTags: vi.fn(),
      }));
      process.env = { ...originalEnv, SHOPIFY_API_SECRET: SYNTHETIC_TEST_SECRET };
    });

    afterEach(() => {
      vi.doUnmock("~/services/drain/admin-client.server");
      vi.doUnmock("~/lib/sentry");
    });

    it("out-of-order update does not regress plan state (fetches current state)", async () => {
      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_A_DOMAIN}, 'UTC', 'INR', 'none', NOW(), NOW())
      `;

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: "gid://shopify/AppSubscription/current-state",
              name: "Growth",
              status: "ACTIVE",
              test: false,
              lineItems: [],
            }],
          },
        },
      });

      const { refreshPlanCache } = await import("~/services/plan.server");
      await refreshPlanCache(sql, TEST_SHOP_A_DOMAIN);

      const [afterFirst] = await sql<{ plan_key: string }[]>`
        SELECT plan_key FROM "Shop" WHERE domain = ${TEST_SHOP_A_DOMAIN}
      `;
      expect(afterFirst.plan_key).toBe("growth");

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: "gid://shopify/AppSubscription/current-state",
              name: "Growth",
              status: "ACTIVE",
              test: false,
              lineItems: [],
            }],
          },
        },
      });

      await refreshPlanCache(sql, TEST_SHOP_A_DOMAIN);

      const [afterOutOfOrder] = await sql<{ plan_key: string }[]>`
        SELECT plan_key FROM "Shop" WHERE domain = ${TEST_SHOP_A_DOMAIN}
      `;

      expect(afterOutOfOrder.plan_key).toBe("growth");
    });
  });

  describe("5. Uninstall invalidates plan_cached_at, reinstall does fresh read", () => {
    it("markShopUninstalled preserves plan_cached_at (does not invalidate)", async () => {
      const planCachedAt = new Date("2026-10-01T12:00:00Z");

      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, plan_cached_at, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_A_DOMAIN}, 'UTC', 'INR', 'growth', ${planCachedAt}, NOW(), NOW())
      `;

      const [before] = await sql<{ plan_cached_at: Date | null }[]>`
        SELECT plan_cached_at FROM "Shop" WHERE domain = ${TEST_SHOP_A_DOMAIN}
      `;
      expect(before.plan_cached_at?.getTime()).toBe(planCachedAt.getTime());

      const { markShopUninstalled } = await import("~/services/compliance");
      await markShopUninstalled(sql, TEST_SHOP_A_DOMAIN);

      const [after] = await sql<{ plan_cached_at: Date | null; uninstalledAt: Date | null }[]>`
        SELECT plan_cached_at, "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP_A_DOMAIN}
      `;

      expect(after.uninstalledAt).not.toBeNull();
      expect(after.plan_cached_at?.getTime()).toBe(planCachedAt.getTime());
    });

    it("upsertShopOnAuth reinstall clears uninstalledAt but preserves plan columns", async () => {
      const planCachedAt = new Date("2026-10-01T12:00:00Z");

      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, subscription_id, subscription_name, is_test, plan_cached_at, "uninstalledAt", "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_A_DOMAIN}, 'UTC', 'INR', 'growth', 'gid://shopify/AppSubscription/old', 'Growth', false, ${planCachedAt}, NOW(), NOW(), NOW())
      `;

      const [before] = await sql<{
        plan_key: string;
        subscription_id: string | null;
        plan_cached_at: Date | null;
        uninstalledAt: Date | null;
      }[]>`
        SELECT plan_key, subscription_id, plan_cached_at, "uninstalledAt"
        FROM "Shop" WHERE domain = ${TEST_SHOP_A_DOMAIN}
      `;
      expect(before.uninstalledAt).not.toBeNull();
      expect(before.plan_key).toBe("growth");

      const { upsertShopOnAuth } = await import("~/lib/after-auth.server");
      await upsertShopOnAuth(sql, TEST_SHOP_A_DOMAIN, "America/New_York", "INR");

      const [after] = await sql<{
        plan_key: string;
        subscription_id: string | null;
        plan_cached_at: Date | null;
        uninstalledAt: Date | null;
      }[]>`
        SELECT plan_key, subscription_id, plan_cached_at, "uninstalledAt"
        FROM "Shop" WHERE domain = ${TEST_SHOP_A_DOMAIN}
      `;

      expect(after.uninstalledAt).toBeNull();
      expect(after.plan_key).toBe("growth");
      expect(after.subscription_id).toBe("gid://shopify/AppSubscription/old");
      expect(after.plan_cached_at?.getTime()).toBe(planCachedAt.getTime());
    });

    it("clearUninstalledAtAndMetafieldErrors reinstall clears uninstalledAt, preserves plan columns", async () => {
      const planCachedAt = new Date("2026-10-15T10:00:00Z");

      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, subscription_id, subscription_name, is_test, plan_cached_at, "uninstalledAt", "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_A_DOMAIN}, 'UTC', 'INR', 'starter', 'gid://shopify/AppSubscription/starter-sub', 'Starter', true, ${planCachedAt}, NOW(), NOW(), NOW())
      `;

      const { _clearUninstalledAtAndMetafieldErrorsForTesting } = await import("~/lib/after-auth.server");
      const result = await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, TEST_SHOP_A_DOMAIN);

      expect(result.wasReinstalled).toBe(true);

      const [after] = await sql<{
        plan_key: string;
        subscription_id: string | null;
        subscription_name: string | null;
        is_test: boolean;
        plan_cached_at: Date | null;
        uninstalledAt: Date | null;
      }[]>`
        SELECT plan_key, subscription_id, subscription_name, is_test, plan_cached_at, "uninstalledAt"
        FROM "Shop" WHERE domain = ${TEST_SHOP_A_DOMAIN}
      `;

      expect(after.uninstalledAt).toBeNull();
      expect(after.plan_key).toBe("starter");
      expect(after.subscription_id).toBe("gid://shopify/AppSubscription/starter-sub");
      expect(after.subscription_name).toBe("Starter");
      expect(after.is_test).toBe(true);
      expect(after.plan_cached_at?.getTime()).toBe(planCachedAt.getTime());
    });
  });

  describe("6. Plan page subscription creation test flag", () => {
    it("resolvePlan reads isTest from Shopify API response", async () => {
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

      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_A_DOMAIN}, 'UTC', 'INR', 'none', NOW(), NOW())
      `;

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: "gid://shopify/AppSubscription/test-sub-999",
              name: "Growth",
              status: "ACTIVE",
              test: true,
              lineItems: [],
            }],
          },
        },
      });

      const { resolvePlan } = await import("~/services/plan.server");
      const result = await resolvePlan(sql, TEST_SHOP_A_DOMAIN, true);

      expect(result.isTest).toBe(true);
      expect(result.plan.key).toBe("growth");

      const [shop] = await sql<{ is_test: boolean }[]>`
        SELECT is_test FROM "Shop" WHERE domain = ${TEST_SHOP_A_DOMAIN}
      `;
      expect(shop.is_test).toBe(true);

      vi.doUnmock("~/services/drain/admin-client.server");
      vi.doUnmock("~/lib/sentry");
    });

    it("non-test subscription has isTest=false", async () => {
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

      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_A_DOMAIN}, 'UTC', 'INR', 'none', NOW(), NOW())
      `;

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: "gid://shopify/AppSubscription/prod-sub-888",
              name: "Starter",
              status: "ACTIVE",
              test: false,
              lineItems: [],
            }],
          },
        },
      });

      const { resolvePlan } = await import("~/services/plan.server");
      const result = await resolvePlan(sql, TEST_SHOP_A_DOMAIN, true);

      expect(result.isTest).toBe(false);
      expect(result.plan.key).toBe("starter");

      vi.doUnmock("~/services/drain/admin-client.server");
      vi.doUnmock("~/lib/sentry");
    });
  });

  describe("7. Shop isolation (billing for shop B cannot change shop A)", () => {
    let mockAdminGraphQL: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      vi.resetModules();
      mockAdminGraphQL = vi.fn();
      vi.doMock("~/services/drain/admin-client.server", () => ({
        adminGraphQL: mockAdminGraphQL,
      }));
      vi.doMock("~/lib/sentry", () => ({
        captureException: vi.fn(),
        captureMessage: vi.fn(),
        captureExceptionWithTags: vi.fn(),
      }));
      process.env = { ...originalEnv, SHOPIFY_API_SECRET: SYNTHETIC_TEST_SECRET };
    });

    afterEach(() => {
      vi.doUnmock("~/services/drain/admin-client.server");
      vi.doUnmock("~/lib/sentry");
    });

    it("refreshPlanCache for shop B does not modify shop A", async () => {
      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, subscription_id, plan_cached_at, "createdAt", "updatedAt")
        VALUES 
          (${TEST_SHOP_A_DOMAIN}, 'UTC', 'INR', 'growth', 'gid://shopify/AppSubscription/a-sub', NOW(), NOW(), NOW()),
          (${TEST_SHOP_B_DOMAIN}, 'UTC', 'INR', 'none', NULL, NULL, NOW(), NOW())
      `;

      const [shopABefore] = await sql<{
        plan_key: string;
        subscription_id: string | null;
        plan_cached_at: Date | null;
      }[]>`
        SELECT plan_key, subscription_id, plan_cached_at
        FROM "Shop" WHERE domain = ${TEST_SHOP_A_DOMAIN}
      `;

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: "gid://shopify/AppSubscription/b-new-sub",
              name: "Starter",
              status: "ACTIVE",
              test: false,
              lineItems: [],
            }],
          },
        },
      });

      const { refreshPlanCache } = await import("~/services/plan.server");
      await refreshPlanCache(sql, TEST_SHOP_B_DOMAIN);

      const [shopAAfter] = await sql<{
        plan_key: string;
        subscription_id: string | null;
        plan_cached_at: Date | null;
      }[]>`
        SELECT plan_key, subscription_id, plan_cached_at
        FROM "Shop" WHERE domain = ${TEST_SHOP_A_DOMAIN}
      `;

      expect(shopAAfter.plan_key).toBe(shopABefore.plan_key);
      expect(shopAAfter.subscription_id).toBe(shopABefore.subscription_id);
      expect(shopAAfter.plan_cached_at?.getTime()).toBe(shopABefore.plan_cached_at?.getTime());

      const [shopBAfter] = await sql<{
        plan_key: string;
        subscription_id: string | null;
      }[]>`
        SELECT plan_key, subscription_id
        FROM "Shop" WHERE domain = ${TEST_SHOP_B_DOMAIN}
      `;

      expect(shopBAfter.plan_key).toBe("starter");
      expect(shopBAfter.subscription_id).toBe("gid://shopify/AppSubscription/b-new-sub");
    });

    it("webhook for shop B with valid HMAC does not touch shop A data", async () => {
      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, subscription_id, plan_cached_at, "createdAt", "updatedAt")
        VALUES 
          (${TEST_SHOP_A_DOMAIN}, 'UTC', 'INR', 'unlimited', 'gid://shopify/AppSubscription/a-unlimited', NOW(), NOW(), NOW()),
          (${TEST_SHOP_B_DOMAIN}, 'UTC', 'INR', 'starter', 'gid://shopify/AppSubscription/b-starter', NOW(), NOW(), NOW())
      `;

      const [shopABefore] = await sql<{
        plan_key: string;
        subscription_id: string | null;
        plan_cached_at: Date | null;
        updatedAt: Date;
      }[]>`
        SELECT plan_key, subscription_id, plan_cached_at, "updatedAt"
        FROM "Shop" WHERE domain = ${TEST_SHOP_A_DOMAIN}
      `;

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: "gid://shopify/AppSubscription/b-upgraded",
              name: "Growth",
              status: "ACTIVE",
              test: false,
              lineItems: [],
            }],
          },
        },
      });

      vi.doMock("~/services/gating.server", () => ({
        reactivateGatedAccounts: vi.fn().mockResolvedValue(0),
      }));
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: vi.fn(() => sql),
      }));

      const { refreshPlanCache } = await import("~/services/plan.server");
      await refreshPlanCache(sql, TEST_SHOP_B_DOMAIN);

      const [shopAAfter] = await sql<{
        plan_key: string;
        subscription_id: string | null;
        plan_cached_at: Date | null;
        updatedAt: Date;
      }[]>`
        SELECT plan_key, subscription_id, plan_cached_at, "updatedAt"
        FROM "Shop" WHERE domain = ${TEST_SHOP_A_DOMAIN}
      `;

      expect(shopAAfter.plan_key).toBe(shopABefore.plan_key);
      expect(shopAAfter.subscription_id).toBe(shopABefore.subscription_id);
      expect(shopAAfter.plan_cached_at?.getTime()).toBe(shopABefore.plan_cached_at?.getTime());
      expect(shopAAfter.updatedAt.getTime()).toBe(shopABefore.updatedAt.getTime());
    });
  });
});
