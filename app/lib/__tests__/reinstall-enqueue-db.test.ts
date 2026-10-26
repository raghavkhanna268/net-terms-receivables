/**
 * #294 PR2: DB-backed integration tests for reinstall credit status re-push.
 *
 * Tests verify:
 * 1. POSITIVE: Reinstall of INR shop enqueues exactly 1 message with correct shape
 * 2. NEGATIVE: Non-INR, XXX currency, failing setup, and still-uninstalled all get 0
 * 3. Eligibility exclusions: no-owner, redacted (but not lookalikes), permanent error
 * 4. Cap enforcement: 500 max and exact-500, HELD-first ordering
 * 5. Enqueue failure doesn't fail auth (try/catch present) with no leaks
 * 6. No sensitive data leaks in logs
 * 7. 'sync' source is handled by all consumers
 * 8. Message shape matches helper (6 keys, headers NULL, read_ct 0)
 * 9. Helper-direct tests for currency filtering (c-SQL)
 * 10. Late uninstall test (SQL filter)
 * 11. Second same-day reinstall produces distinct webhookIds
 * 12. No-owner accounts are excluded
 *
 * Uses the same exclusions as Part 3 resync in enqueue_credit_status_recomputes(),
 * plus the INR filter and HELD-first ordering.
 * @see prisma/migrations/20261111000000_sweep_skip_uninstalled/migration.sql
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

// Mock shopifyGraphQLRequest for double-write test
let metafieldWriteCount = 0;
const mockShopifyGraphQLRequest = vi.fn();
vi.mock("~/services/shopify-client.server", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    shopifyGraphQLRequest: (...args: unknown[]) => mockShopifyGraphQLRequest(...args),
  };
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("#294 PR2: reinstall enqueues credit status recompute (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = "re-" + process.hrtime.bigint().toString(36) + "-main";

  const INR_SHOP = `test-reinstall-enqueue-inr-${TEST_SUFFIX}.myshopify.com`;
  const USD_SHOP = `test-reinstall-enqueue-usd-${TEST_SUFFIX}.myshopify.com`;
  const XXX_SHOP = `test-reinstall-enqueue-xxx-${TEST_SUFFIX}.myshopify.com`;
  const UNINSTALLED_SHOP = `test-reinstall-enqueue-uninstalled-${TEST_SUFFIX}.myshopify.com`;
  const CONTROL_SHOP = `test-reinstall-enqueue-control-${TEST_SUFFIX}.myshopify.com`;

  let inrShopId: string;
  let usdShopId: string;
  let xxxShopId: string;
  let uninstalledShopId: string;
  let controlShopId: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' LIKE ${'test-reinstall-enqueue-%-' + TEST_SUFFIX + '.myshopify.com'}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_recompute:%-' + TEST_SUFFIX + ':%'} OR webhook_id LIKE ${'credit_resync:%-' + TEST_SUFFIX + ':%'}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (
      SELECT id FROM "Shop" WHERE domain LIKE ${'test-reinstall-enqueue-%-' + TEST_SUFFIX + '.myshopify.com'}
    )`;
    await sql`DELETE FROM "Shop" WHERE domain LIKE ${'test-reinstall-enqueue-%-' + TEST_SUFFIX + '.myshopify.com'}`;
    await sql.end();
  });

  beforeEach(async () => {
    vi.resetModules();

    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' LIKE ${'test-reinstall-enqueue-%-' + TEST_SUFFIX + '.myshopify.com'}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_recompute:%-' + TEST_SUFFIX + ':%'} OR webhook_id LIKE ${'credit_resync:%-' + TEST_SUFFIX + ':%'}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (
      SELECT id FROM "Shop" WHERE domain LIKE ${'test-reinstall-enqueue-%-' + TEST_SUFFIX + '.myshopify.com'}
    )`;
    await sql`DELETE FROM "Shop" WHERE domain LIKE ${'test-reinstall-enqueue-%-' + TEST_SUFFIX + '.myshopify.com'}`;

    const [inr] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
      VALUES (${INR_SHOP}, 'Asia/Kolkata', 'INR', 'free', NOW(), NOW())
      RETURNING id
    `;
    inrShopId = inr.id;

    const [usd] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
      VALUES (${USD_SHOP}, 'America/New_York', 'USD', 'free', NOW(), NOW())
      RETURNING id
    `;
    usdShopId = usd.id;

    const [xxx] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
      VALUES (${XXX_SHOP}, 'UTC', 'XXX', 'free', NOW(), NOW())
      RETURNING id
    `;
    xxxShopId = xxx.id;

    const [uninstalled] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, timezone, currency, plan_key, "uninstalledAt", "createdAt", "updatedAt")
      VALUES (${UNINSTALLED_SHOP}, 'Asia/Kolkata', 'INR', 'free', NOW(), NOW(), NOW())
      RETURNING id
    `;
    uninstalledShopId = uninstalled.id;

    const [control] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
      VALUES (${CONTROL_SHOP}, 'Asia/Kolkata', 'INR', 'free', NOW(), NOW())
      RETURNING id
    `;
    controlShopId = control.id;
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe("POSITIVE: reinstall of INR shop enqueues messages", () => {
    it("uninstalled INR shop enqueues exactly 1 message with correct shape and logs cleared_uninstalled_at_and_metafield_errors", async () => {
      // Set uninstalledAt so reinstall branch runs
      await sql`UPDATE "Shop" SET "uninstalledAt" = NOW() WHERE id = ${inrShopId}`;

      const testAccountId = `pos-test-acct-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "syncPending", "metafieldSyncedAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${testAccountId}, ${inrShopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/pos-1', 'gid://shopify/CompanyLocation/pos-1',
           'Positive Test Account', 'OK', true, NULL, NOW(), NOW())
      `;

      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

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

      const { runAfterAuth, _resetSetupCacheForTesting } = await import("../after-auth.server");
      _resetSetupCacheForTesting();

      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: () => Promise.resolve({ data: { shop: { id: "gid://shopify/Shop/1", ianaTimezone: "Asia/Kolkata", currencyCode: "INR" } } }),
        }),
      };

      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = (p: Promise<unknown>) => waitUntilPromises.push(p);

      runAfterAuth(INR_SHOP, mockAdmin as Parameters<typeof runAfterAuth>[1], mockWaitUntil);
      for (let n = 0; n < waitUntilPromises.length; n++) await waitUntilPromises[n];

      // Verify exactly 1 message enqueued
      const messages = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM pgmq.q_s6_sync
        WHERE message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
          AND message->>'shop' = ${INR_SHOP}
      `;
      expect(messages[0].count).toBe(1);

      // Verify existing info log key was used
      const logCalls = consoleLogSpy.mock.calls.map(c => JSON.stringify(c));
      const hasReinstallLog = logCalls.some(c => c.includes("cleared_uninstalled_at_and_metafield_errors"));
      expect(hasReinstallLog).toBe(true);

      consoleLogSpy.mockRestore();
    });

    it("message has exact 6-key shape with headers NULL and read_ct 0 (read-back test)", async () => {
      const testAccountId = `shape-test-acct-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "syncPending", "metafieldSyncedAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${testAccountId}, ${inrShopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/shape-1', 'gid://shopify/CompanyLocation/shape-1',
           'Shape Test Account', 'OK', true, NULL, NOW(), NOW())
      `;

      const { _enqueueReinstallResyncForTesting } = await import("../after-auth.server");
      const enqueuedCount = await _enqueueReinstallResyncForTesting(sql, inrShopId, INR_SHOP);
      expect(enqueuedCount).toBe(1);

      // Read back with pgmq.read to verify shape
      const [msg] = await sql<{
        msg_id: string;
        read_ct: number;
        message: Record<string, unknown>;
        headers: unknown;
      }[]>`
        SELECT msg_id, read_ct, message, headers
        FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${testAccountId}
      `;

      expect(msg).toBeDefined();
      expect(msg.read_ct).toBe(0);
      expect(msg.headers).toBeNull();

      // Verify exact 6 keys
      const messageKeys = Object.keys(msg.message).sort();
      expect(messageKeys).toEqual(["buyerAccountId", "resourceGid", "shop", "source", "topic", "webhookId"]);

      // Verify values
      expect(msg.message.topic).toBe("CREDIT_STATUS_RECOMPUTE");
      expect(msg.message.shop).toBe(INR_SHOP);
      expect(msg.message.buyerAccountId).toBe(testAccountId);
      expect(msg.message.source).toBe("sync");
      expect(msg.message.resourceGid).toBe(testAccountId);
      expect(msg.message.webhookId).toMatch(new RegExp(`^credit_recompute:${testAccountId}:\\d+$`));
    });

    it("second same-day reinstall produces distinct webhookIds", async () => {
      const testAccountId = `second-reinstall-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "syncPending", "metafieldSyncedAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${testAccountId}, ${inrShopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/second-1', 'gid://shopify/CompanyLocation/second-1',
           'Second Reinstall Account', 'OK', true, NULL, NOW(), NOW())
      `;

      const { _enqueueReinstallResyncForTesting } = await import("../after-auth.server");

      // First reinstall at time t
      const dateNowSpy = vi.spyOn(Date, "now");
      dateNowSpy.mockReturnValue(1700000000000);

      await _enqueueReinstallResyncForTesting(sql, inrShopId, INR_SHOP);

      // Second reinstall at time t+1
      dateNowSpy.mockReturnValue(1700000000001);
      await _enqueueReinstallResyncForTesting(sql, inrShopId, INR_SHOP);

      dateNowSpy.mockRestore();

      // Get both webhookIds
      const webhookIds = await sql<{ webhookId: string }[]>`
        SELECT message->>'webhookId' AS "webhookId"
        FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${testAccountId}
        ORDER BY msg_id
      `;

      expect(webhookIds).toHaveLength(2);
      expect(webhookIds[0].webhookId).not.toBe(webhookIds[1].webhookId);
      expect(webhookIds[0].webhookId).toContain(":1700000000000");
      expect(webhookIds[1].webhookId).toContain(":1700000000001");
    });
  });

  describe("NEGATIVE: conditions that get 0 messages", () => {
    it("non-INR shop gets 0 messages on reinstall", async () => {
      await sql`UPDATE "Shop" SET "uninstalledAt" = NOW() WHERE id = ${usdShopId}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "syncPending", "metafieldSyncedAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${usdShopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/usd-acct', 'gid://shopify/CompanyLocation/usd-acct',
           'USD Account', 'OK', true, NULL, NOW(), NOW())
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

      const { runAfterAuth, _resetSetupCacheForTesting } = await import("../after-auth.server");
      _resetSetupCacheForTesting();

      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: () => Promise.resolve({ data: { shop: { ianaTimezone: "America/New_York", currencyCode: "USD" } } }),
        }),
      };

      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = (p: Promise<unknown>) => waitUntilPromises.push(p);

      runAfterAuth(USD_SHOP, mockAdmin as Parameters<typeof runAfterAuth>[1], mockWaitUntil);
      for (let n = 0; n < waitUntilPromises.length; n++) await waitUntilPromises[n];

      const messages = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM pgmq.q_s6_sync
        WHERE message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
          AND message->>'shop' = ${USD_SHOP}
      `;
      expect(messages[0].count).toBe(0);
    });

    it("XXX (unknown) currency shop gets 0 messages on reinstall", async () => {
      await sql`UPDATE "Shop" SET "uninstalledAt" = NOW() WHERE id = ${xxxShopId}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "syncPending", "metafieldSyncedAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${xxxShopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/xxx-acct', 'gid://shopify/CompanyLocation/xxx-acct',
           'XXX Account', 'OK', true, NULL, NOW(), NOW())
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

      const { runAfterAuth, _resetSetupCacheForTesting } = await import("../after-auth.server");
      _resetSetupCacheForTesting();

      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: () => Promise.resolve({ data: { shop: { ianaTimezone: "UTC" } } }),
        }),
      };

      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = (p: Promise<unknown>) => waitUntilPromises.push(p);

      runAfterAuth(XXX_SHOP, mockAdmin as Parameters<typeof runAfterAuth>[1], mockWaitUntil);
      for (let n = 0; n < waitUntilPromises.length; n++) await waitUntilPromises[n];

      const messages = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM pgmq.q_s6_sync
        WHERE message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
          AND message->>'shop' = ${XXX_SHOP}
      `;
      expect(messages[0].count).toBe(0);
    });

    it("setup failure gets 0 messages on reinstall (mutation e1: setup error makes currency XXX)", async () => {
      await sql`UPDATE "Shop" SET "uninstalledAt" = NOW() WHERE id = ${inrShopId}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "syncPending", "metafieldSyncedAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${inrShopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/setup-fail', 'gid://shopify/CompanyLocation/setup-fail',
           'Setup Fail Account', 'OK', true, NULL, NOW(), NOW())
      `;

      vi.doMock("../request-context.server", () => ({
        getRequestSql: vi.fn(() => sql),
      }));
      vi.doMock("../metafield-definitions.server", () => ({
        ensureMetafieldDefinitions: vi.fn().mockRejectedValue(new Error("Setup failed")),
      }));
      vi.doMock("../validation-registration.server", () => ({
        ensureValidation: vi.fn().mockRejectedValue(new Error("Setup failed")),
      }));
      vi.doMock("../payment-customization-registration.server", () => ({
        ensurePaymentCustomization: vi.fn().mockRejectedValue(new Error("Setup failed")),
      }));

      const { runAfterAuth, _resetSetupCacheForTesting, _isShopSetupComplete } =
        await import("../after-auth.server");
      _resetSetupCacheForTesting();

      const mockAdmin = {
        graphql: vi.fn().mockRejectedValue(new Error("API failed")),
      };

      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = (p: Promise<unknown>) => waitUntilPromises.push(p);

      runAfterAuth(INR_SHOP, mockAdmin as Parameters<typeof runAfterAuth>[1], mockWaitUntil);
      for (let n = 0; n < waitUntilPromises.length; n++) await waitUntilPromises[n];

      expect(_isShopSetupComplete(INR_SHOP)).toBe(false);

      const messages = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM pgmq.q_s6_sync
        WHERE message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
          AND message->>'shop' = ${INR_SHOP}
      `;
      expect(messages[0].count).toBe(0);
    });

    it("setup incomplete blocks enqueue even with INR currency (mutation e2: setupCompletedShops check)", async () => {
      await sql`UPDATE "Shop" SET "uninstalledAt" = NOW() WHERE id = ${inrShopId}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "syncPending", "metafieldSyncedAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${inrShopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/setup-inr', 'gid://shopify/CompanyLocation/setup-inr',
           'Setup INR Account', 'OK', true, NULL, NOW(), NOW())
      `;

      vi.doMock("../request-context.server", () => ({
        getRequestSql: vi.fn(() => sql),
      }));
      vi.doMock("../metafield-definitions.server", () => ({
        ensureMetafieldDefinitions: vi.fn().mockResolvedValue([]),
      }));
      vi.doMock("../validation-registration.server", () => ({
        ensureValidation: vi.fn().mockRejectedValue(new Error("Validation API failed")),
      }));
      vi.doMock("../payment-customization-registration.server", () => ({
        ensurePaymentCustomization: vi.fn().mockResolvedValue({ id: "pc-test", created: false }),
      }));

      const { runAfterAuth, _resetSetupCacheForTesting, _isShopSetupComplete } =
        await import("../after-auth.server");
      _resetSetupCacheForTesting();

      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: () => Promise.resolve({
            data: { shop: { id: "gid://shopify/Shop/1", ianaTimezone: "Asia/Kolkata", currencyCode: "INR" } },
          }),
        }),
      };

      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = (p: Promise<unknown>) => waitUntilPromises.push(p);

      runAfterAuth(INR_SHOP, mockAdmin as Parameters<typeof runAfterAuth>[1], mockWaitUntil);
      for (let n = 0; n < waitUntilPromises.length; n++) await waitUntilPromises[n];

      // Verify the shop has INR currency (so the SQL currency filter would pass)
      const shopCheck = await sql<{ currency: string }[]>`
        SELECT currency FROM "Shop" WHERE id = ${inrShopId}
      `;
      expect(shopCheck[0].currency).toBe("INR");

      // Verify setup is NOT complete (ensureValidation failed)
      expect(_isShopSetupComplete(INR_SHOP)).toBe(false);

      // Verify 0 messages enqueued (the setupCompletedShops check blocked it)
      const messages = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM pgmq.q_s6_sync
        WHERE message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
          AND message->>'shop' = ${INR_SHOP}
      `;
      expect(messages[0].count).toBe(0);
    });

    it("enqueueReinstallResync returns 0 when shop is uninstalled (SQL uninstalledAt filter)", async () => {
      // The SQL JOIN includes s."uninstalledAt" IS NULL - test it directly
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "syncPending", "metafieldSyncedAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${uninstalledShopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/uninst-check', 'gid://shopify/CompanyLocation/uninst-check',
           'Uninstalled Check Account', 'OK', true, NULL, NOW(), NOW())
      `;

      // Verify the shop is indeed uninstalled
      const shopCheck = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE id = ${uninstalledShopId}
      `;
      expect(shopCheck[0].uninstalledAt).not.toBeNull();

      const { _enqueueReinstallResyncForTesting } = await import("../after-auth.server");
      const enqueuedCount = await _enqueueReinstallResyncForTesting(sql, uninstalledShopId, UNINSTALLED_SHOP);

      // The SQL query's JOIN on s."uninstalledAt" IS NULL excludes this shop
      expect(enqueuedCount).toBe(0);
    });

    it("plain re-auth (never uninstalled) gets 0 messages", async () => {
      // controlShopId has uninstalledAt = NULL from beforeEach, so this is plain re-auth
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "syncPending", "metafieldSyncedAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${controlShopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/reauth-acct', 'gid://shopify/CompanyLocation/reauth-acct',
           'Reauth Account', 'OK', true, NULL, NOW(), NOW())
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

      const { runAfterAuth, _resetSetupCacheForTesting } = await import("../after-auth.server");
      _resetSetupCacheForTesting();

      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: () => Promise.resolve({ data: { shop: { ianaTimezone: "Asia/Kolkata", currencyCode: "INR" } } }),
        }),
      };

      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = (p: Promise<unknown>) => waitUntilPromises.push(p);

      runAfterAuth(CONTROL_SHOP, mockAdmin as Parameters<typeof runAfterAuth>[1], mockWaitUntil);
      for (let n = 0; n < waitUntilPromises.length; n++) await waitUntilPromises[n];

      const messages = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM pgmq.q_s6_sync
        WHERE message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
          AND message->>'shop' = ${CONTROL_SHOP}
      `;
      expect(messages[0].count).toBe(0);
    });

    it("still-uninstalled shop (via SQL helper) gets 0 messages", async () => {
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "syncPending", "metafieldSyncedAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${uninstalledShopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/uninst-acct', 'gid://shopify/CompanyLocation/uninst-acct',
           'Uninstalled Account', 'OK', true, NULL, NOW(), NOW())
      `;

      const { _enqueueReinstallResyncForTesting } = await import("../after-auth.server");

      const beforeCheck = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE id = ${uninstalledShopId}
      `;
      expect(beforeCheck[0].uninstalledAt).not.toBeNull();

      const enqueuedCount = await _enqueueReinstallResyncForTesting(sql, uninstalledShopId, UNINSTALLED_SHOP);
      expect(enqueuedCount).toBe(0);
    });

    it("helper-direct: USD shop returns 0 (c-SQL test)", async () => {
      // USD shop is installed (uninstalledAt = NULL) but currency is not INR
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "syncPending", "metafieldSyncedAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${usdShopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/usd-direct', 'gid://shopify/CompanyLocation/usd-direct',
           'USD Direct Account', 'OK', true, NULL, NOW(), NOW())
      `;

      const { _enqueueReinstallResyncForTesting } = await import("../after-auth.server");

      // Verify shop is installed
      const shopCheck = await sql<{ uninstalledAt: Date | null; currency: string }[]>`
        SELECT "uninstalledAt", currency FROM "Shop" WHERE id = ${usdShopId}
      `;
      expect(shopCheck[0].uninstalledAt).toBeNull();
      expect(shopCheck[0].currency).toBe("USD");

      const enqueuedCount = await _enqueueReinstallResyncForTesting(sql, usdShopId, USD_SHOP);
      expect(enqueuedCount).toBe(0);
    });

    it("helper-direct: XXX shop returns 0 (c-SQL test)", async () => {
      // XXX shop is installed but currency is invalid
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "syncPending", "metafieldSyncedAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${xxxShopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/xxx-direct', 'gid://shopify/CompanyLocation/xxx-direct',
           'XXX Direct Account', 'OK', true, NULL, NOW(), NOW())
      `;

      const { _enqueueReinstallResyncForTesting } = await import("../after-auth.server");

      // Verify shop is installed
      const shopCheck = await sql<{ uninstalledAt: Date | null; currency: string }[]>`
        SELECT "uninstalledAt", currency FROM "Shop" WHERE id = ${xxxShopId}
      `;
      expect(shopCheck[0].uninstalledAt).toBeNull();
      expect(shopCheck[0].currency).toBe("XXX");

      const enqueuedCount = await _enqueueReinstallResyncForTesting(sql, xxxShopId, XXX_SHOP);
      expect(enqueuedCount).toBe(0);
    });

    it("late uninstall: shop re-uninstalled after clear gets 0 from helper (SQL filter test)", async () => {
      // This tests the SQL-level guard: if shop.uninstalledAt is set,
      // the SELECT returns no rows even with eligible accounts.
      // In production, a late uninstall (between clear and enqueue) is caught by this guard.

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "syncPending", "metafieldSyncedAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${inrShopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/late-uninst', 'gid://shopify/CompanyLocation/late-uninst',
           'Late Uninstall Account', 'OK', true, NULL, NOW(), NOW())
      `;

      // First verify the shop is installed and would normally enqueue
      const { _enqueueReinstallResyncForTesting } = await import("../after-auth.server");
      const firstCount = await _enqueueReinstallResyncForTesting(sql, inrShopId, INR_SHOP);
      expect(firstCount).toBe(1);

      // Clear the queue for this test
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${INR_SHOP}`;

      // Now simulate late uninstall - set uninstalledAt
      await sql`UPDATE "Shop" SET "uninstalledAt" = NOW() WHERE id = ${inrShopId}`;

      // The helper should now return 0 because the SQL guard catches the uninstalled state
      const enqueuedCount = await _enqueueReinstallResyncForTesting(sql, inrShopId, INR_SHOP);
      expect(enqueuedCount).toBe(0);
    });
  });

  describe("eligibility exclusions", () => {
    it("account with redacted customerId is NOT enqueued", async () => {
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", "customerId", name,
          "holdState", "syncPending", "metafieldSyncedAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${inrShopId}, 'TAGGED_CUSTOMER'::"AccountKind",
           NULL, NULL, 'gid://shopify/Customer/normal-customer',
           'Normal Customer', 'OK', true, NULL, NOW(), NOW()),
          (${inrShopId}, 'TAGGED_CUSTOMER'::"AccountKind",
           NULL, NULL, 'gid://shopify/Customer/abc_redacted_1234567890',
           'Redacted Customer', 'OK', true, NULL, NOW(), NOW())
      `;

      const { _enqueueReinstallResyncForTesting } = await import("../after-auth.server");
      const enqueuedCount = await _enqueueReinstallResyncForTesting(sql, inrShopId, INR_SHOP);

      expect(enqueuedCount).toBe(1);

      const messages = await sql<{ name: string }[]>`
        SELECT ba.name
        FROM pgmq.q_s6_sync q
        JOIN "BuyerAccount" ba ON ba.id = q.message->>'buyerAccountId'
        WHERE q.message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
          AND q.message->>'shop' = ${INR_SHOP}
      `;
      expect(messages).toHaveLength(1);
      expect(messages[0].name).toBe("Normal Customer");
    });

    it("look-alike: 'Xredacted-1' (no underscore prefix) IS enqueued, '_redacted_' is NOT", async () => {
      vi.resetModules();
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", "customerId", name,
          "holdState", "syncPending", "metafieldSyncedAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${inrShopId}, 'TAGGED_CUSTOMER'::"AccountKind",
           NULL, NULL, 'gid://shopify/Customer/Xredacted-1',
           'Look-alike (should enqueue)', 'OK', true, NULL, NOW(), NOW()),
          (${inrShopId}, 'TAGGED_CUSTOMER'::"AccountKind",
           NULL, NULL, 'gid://shopify/Customer/real_redacted_timestamp',
           'Real redacted (should NOT enqueue)', 'OK', true, NULL, NOW(), NOW())
      `;

      const { _enqueueReinstallResyncForTesting } = await import("../after-auth.server");
      const enqueuedCount = await _enqueueReinstallResyncForTesting(sql, inrShopId, INR_SHOP);

      expect(enqueuedCount).toBe(1);

      const messages = await sql<{ name: string }[]>`
        SELECT ba.name
        FROM pgmq.q_s6_sync q
        JOIN "BuyerAccount" ba ON ba.id = q.message->>'buyerAccountId'
        WHERE q.message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
          AND q.message->>'shop' = ${INR_SHOP}
      `;
      expect(messages).toHaveLength(1);
      expect(messages[0].name).toBe("Look-alike (should enqueue)");
    });

    it("account with permanent metafieldSyncErrorCode is NOT enqueued", async () => {
      vi.resetModules();
      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "syncPending", "metafieldSyncedAt", "metafieldSyncErrorCode",
          "createdAt", "updatedAt"
        )
        VALUES
          (${inrShopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/no-err', 'gid://shopify/CompanyLocation/no-err',
           'No Error', 'OK', true, NULL, NULL, NOW(), NOW()),
          (${inrShopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/has-err', 'gid://shopify/CompanyLocation/has-err',
           'Has Error', 'OK', true, NULL, 'no_session', NOW(), NOW())
      `;

      const { _enqueueReinstallResyncForTesting } = await import("../after-auth.server");
      const enqueuedCount = await _enqueueReinstallResyncForTesting(sql, inrShopId, INR_SHOP);

      expect(enqueuedCount).toBe(1);

      const messages = await sql<{ name: string }[]>`
        SELECT ba.name
        FROM pgmq.q_s6_sync q
        JOIN "BuyerAccount" ba ON ba.id = q.message->>'buyerAccountId'
        WHERE q.message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
          AND q.message->>'shop' = ${INR_SHOP}
      `;
      expect(messages).toHaveLength(1);
      expect(messages[0].name).toBe("No Error");
    });

    it("no-owner accounts are NOT enqueued (rolled-back constraint test)", async () => {
      vi.resetModules();

      // Use a transaction to temporarily drop the constraint, insert invalid rows, test, and rollback
      await expect(
        sql.begin(async (tx) => {
          // Drop the constraint temporarily
          await tx`ALTER TABLE "BuyerAccount" DROP CONSTRAINT IF EXISTS "BuyerAccount_kind_consistency"`;

          // Insert accounts without owners (violates usual constraint)
          await tx`
            INSERT INTO "BuyerAccount" (
              "shopId", kind, "companyId", "companyLocationId", "customerId", name,
              "holdState", "syncPending", "metafieldSyncedAt",
              "createdAt", "updatedAt"
            )
            VALUES
              (${inrShopId}, 'COMPANY'::"AccountKind",
               'gid://shopify/Company/no-owner', NULL,
               NULL, 'No Owner Company', 'OK', true, NULL, NOW(), NOW()),
              (${inrShopId}, 'TAGGED_CUSTOMER'::"AccountKind",
               NULL, NULL, NULL,
               'No Owner Customer', 'OK', true, NULL, NOW(), NOW()),
              (${inrShopId}, 'COMPANY'::"AccountKind",
               'gid://shopify/Company/has-owner', 'gid://shopify/CompanyLocation/has-owner',
               NULL, 'Has Owner', 'OK', true, NULL, NOW(), NOW())
          `;

          const { _enqueueReinstallResyncForTesting } = await import("../after-auth.server");
          const enqueuedCount = await _enqueueReinstallResyncForTesting(tx, inrShopId, INR_SHOP);

          // Only the account with owner should be enqueued
          expect(enqueuedCount).toBe(1);

          const messages = await tx<{ name: string }[]>`
            SELECT ba.name
            FROM pgmq.q_s6_sync q
            JOIN "BuyerAccount" ba ON ba.id = q.message->>'buyerAccountId'
            WHERE q.message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
              AND q.message->>'shop' = ${INR_SHOP}
          `;
          expect(messages).toHaveLength(1);
          expect(messages[0].name).toBe("Has Owner");

          // Throw to rollback the transaction (don't persist invalid rows)
          throw new Error("ROLLBACK_EXPECTED");
        })
      ).rejects.toThrow("ROLLBACK_EXPECTED");
    });

    it("cross-shop isolation: reinstalling shop A does NOT enqueue accounts from shop B (mutation b)", async () => {
      vi.resetModules();

      // Create a second INR shop (shop B) with an eligible account
      const SHOP_B = `test-reinstall-enqueue-shopb-${TEST_SUFFIX}.myshopify.com`;
      const [shopB] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
        VALUES (${SHOP_B}, 'Asia/Kolkata', 'INR', 'free', NOW(), NOW())
        RETURNING id
      `;

      // Insert eligible accounts in both shops
      const shopAAccountId = `shop-a-acct-${TEST_SUFFIX}`;
      const shopBAccountId = `shop-b-acct-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "syncPending", "metafieldSyncedAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${shopAAccountId}, ${inrShopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/shop-a', 'gid://shopify/CompanyLocation/shop-a',
           'Shop A Account', 'OK', true, NULL, NOW(), NOW()),
          (${shopBAccountId}, ${shopB.id}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/shop-b', 'gid://shopify/CompanyLocation/shop-b',
           'Shop B Account', 'OK', true, NULL, NOW(), NOW())
      `;

      // Reinstall shop A only
      const { _enqueueReinstallResyncForTesting } = await import("../after-auth.server");
      const enqueuedCount = await _enqueueReinstallResyncForTesting(sql, inrShopId, INR_SHOP);

      expect(enqueuedCount).toBe(1);

      // Verify ALL queued messages belong to shop A
      const allMessages = await sql<{ buyerAccountId: string }[]>`
        SELECT message->>'buyerAccountId' AS "buyerAccountId"
        FROM pgmq.q_s6_sync
        WHERE message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
      `;

      // Shop A's account should be enqueued
      expect(allMessages.some(m => m.buyerAccountId === shopAAccountId)).toBe(true);
      // Shop B's account should NOT be enqueued
      expect(allMessages.some(m => m.buyerAccountId === shopBAccountId)).toBe(false);

      // Cleanup shop B
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${shopB.id}`;
      await sql`DELETE FROM "Shop" WHERE id = ${shopB.id}`;
    });

    it("metafieldSyncedAt age filter: recently synced accounts are NOT enqueued (mutation n)", async () => {
      vi.resetModules();

      // Insert two accounts:
      // - One synced just now (should NOT be enqueued)
      // - One synced 2 days ago (should be enqueued)
      const recentAccountId = `recent-sync-${TEST_SUFFIX}`;
      const oldAccountId = `old-sync-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "syncPending", "metafieldSyncedAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${recentAccountId}, ${inrShopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/recent-sync', 'gid://shopify/CompanyLocation/recent-sync',
           'Recently Synced', 'OK', true, NOW(), NOW(), NOW()),
          (${oldAccountId}, ${inrShopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/old-sync', 'gid://shopify/CompanyLocation/old-sync',
           'Old Synced', 'OK', true, NOW() - INTERVAL '2 days', NOW(), NOW())
      `;

      const { _enqueueReinstallResyncForTesting } = await import("../after-auth.server");
      const enqueuedCount = await _enqueueReinstallResyncForTesting(sql, inrShopId, INR_SHOP);

      expect(enqueuedCount).toBe(1);

      // Verify only the old-synced account was enqueued
      const messages = await sql<{ buyerAccountId: string }[]>`
        SELECT message->>'buyerAccountId' AS "buyerAccountId"
        FROM pgmq.q_s6_sync
        WHERE message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
          AND message->>'shop' = ${INR_SHOP}
      `;

      expect(messages).toHaveLength(1);
      expect(messages[0].buyerAccountId).toBe(oldAccountId);
    });
  });

  describe("cap boundary and HELD-first ordering", () => {
    it("cap: exactly 500 eligible gives 500", async () => {
      const { _REINSTALL_ENQUEUE_CAP_FOR_TESTING } = await import("../after-auth.server");
      expect(_REINSTALL_ENQUEUE_CAP_FOR_TESTING).toBe(500);

      for (let i = 0; i < 500; i++) {
        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "companyId", "companyLocationId", name,
            "holdState", "syncPending", "metafieldSyncedAt",
            "createdAt", "updatedAt"
          )
          VALUES (
            ${`cap-exact-${String(i).padStart(4, '0')}-${TEST_SUFFIX}`},
            ${inrShopId}, 'COMPANY'::"AccountKind",
            ${'gid://shopify/Company/cap-exact-' + i}, ${'gid://shopify/CompanyLocation/cap-exact-' + i},
            ${'Cap Exact Account ' + i}, 'OK', true, NULL, NOW(), NOW()
          )
        `;
      }

      const { _enqueueReinstallResyncForTesting } = await import("../after-auth.server");
      const enqueuedCount = await _enqueueReinstallResyncForTesting(sql, inrShopId, INR_SHOP);

      expect(enqueuedCount).toBe(500);
    });

    it("cap: 501 eligible gives 500; 0500 has NO message, 0000-0499 all do", async () => {
      vi.resetModules();

      for (let i = 0; i < 501; i++) {
        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "companyId", "companyLocationId", name,
            "holdState", "syncPending", "metafieldSyncedAt",
            "createdAt", "updatedAt"
          )
          VALUES (
            ${`cap-test-${String(i).padStart(4, '0')}-${TEST_SUFFIX}`},
            ${inrShopId}, 'COMPANY'::"AccountKind",
            ${'gid://shopify/Company/cap-' + i}, ${'gid://shopify/CompanyLocation/cap-' + i},
            ${'Cap Account ' + i}, 'OK', true, NULL, NOW(), NOW()
          )
        `;
      }

      const { _enqueueReinstallResyncForTesting, _REINSTALL_ENQUEUE_CAP_FOR_TESTING } =
        await import("../after-auth.server");
      expect(_REINSTALL_ENQUEUE_CAP_FOR_TESTING).toBe(500);

      const enqueuedCount = await _enqueueReinstallResyncForTesting(sql, inrShopId, INR_SHOP);

      expect(enqueuedCount).toBe(500);

      // Verify the 501st (0500) has NO message
      const msg0500 = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${`cap-test-0500-${TEST_SUFFIX}`}
      `;
      expect(msg0500[0].count).toBe(0);

      // Verify all 0000-0499 have messages
      const enqueuedIds = await sql<{ id: string }[]>`
        SELECT message->>'buyerAccountId' AS id
        FROM pgmq.q_s6_sync
        WHERE message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
          AND message->>'shop' = ${INR_SHOP}
      `;
      expect(enqueuedIds).toHaveLength(500);

      // All enqueued IDs should be 0000-0499
      for (let i = 0; i < 500; i++) {
        const expectedId = `cap-test-${String(i).padStart(4, '0')}-${TEST_SUFFIX}`;
        expect(enqueuedIds.some(m => m.id === expectedId)).toBe(true);
      }

      // Additionally verify syncPending is still true for all (enqueue doesn't change it)
      const stillPending = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM "BuyerAccount"
        WHERE "shopId" = ${inrShopId}
          AND "syncPending" = true
      `;
      expect(stillPending[0].count).toBe(501);
    });

    it("HELD-first ordering: HELD accounts prioritized even when non-HELD IDs sort earlier (zz-held vs aa-ok)", { timeout: 15000 }, async () => {
      vi.resetModules();
      // Use IDs where non-HELD (aa-ok-*) would sort BEFORE HELD (zz-held-*) alphabetically
      for (let i = 0; i < 10; i++) {
        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "companyId", "companyLocationId", name,
            "holdState", "syncPending", "metafieldSyncedAt",
            "createdAt", "updatedAt"
          )
          VALUES (
            ${`zz-held-${String(i).padStart(4, '0')}-${TEST_SUFFIX}`},
            ${inrShopId}, 'COMPANY'::"AccountKind",
            ${'gid://shopify/Company/held-' + i}, ${'gid://shopify/CompanyLocation/held-' + i},
            ${'HELD Account ' + i}, 'HELD', true, NULL, NOW(), NOW()
          )
        `;
      }

      for (let i = 0; i < 500; i++) {
        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "companyId", "companyLocationId", name,
            "holdState", "syncPending", "metafieldSyncedAt",
            "createdAt", "updatedAt"
          )
          VALUES (
            ${`aa-ok-${String(i).padStart(4, '0')}-${TEST_SUFFIX}`},
            ${inrShopId}, 'COMPANY'::"AccountKind",
            ${'gid://shopify/Company/ok-' + i}, ${'gid://shopify/CompanyLocation/ok-' + i},
            ${'OK Account ' + i}, 'OK', true, NULL, NOW(), NOW()
          )
        `;
      }

      const { _enqueueReinstallResyncForTesting } = await import("../after-auth.server");
      await _enqueueReinstallResyncForTesting(sql, inrShopId, INR_SHOP);

      const enqueuedIds = await sql<{ buyerAccountId: string }[]>`
        SELECT message->>'buyerAccountId' AS "buyerAccountId"
        FROM pgmq.q_s6_sync
        WHERE message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
          AND message->>'shop' = ${INR_SHOP}
      `;

      // All 10 HELD accounts should be enqueued despite having IDs that sort later (zz > aa)
      const heldIds = enqueuedIds
        .map((m) => m.buyerAccountId)
        .filter((id) => id.startsWith("zz-held-"));

      expect(heldIds).toHaveLength(10);
      expect(enqueuedIds).toHaveLength(500);
    });
  });

  describe("enqueue failure doesn't fail auth (mutation h)", () => {
    it("runAfterAuth completes when enqueue SELECT fails; no leaks in logs", async () => {
      const FAILURE_SHOP = `test-reinstall-enqueue-fail-${TEST_SUFFIX}.myshopify.com`;

      // Create shop and set as uninstalled
      const [failShop] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "uninstalledAt", "createdAt", "updatedAt")
        VALUES (${FAILURE_SHOP}, 'Asia/Kolkata', 'INR', 'free', NOW(), NOW(), NOW())
        RETURNING id
      `;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "syncPending", "metafieldSyncedAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${failShop.id}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/fail-test', 'gid://shopify/CompanyLocation/fail-test',
           'Failure Test Account', 'OK', true, NULL, NOW(), NOW())
      `;

      // Create a sql wrapper that fails on SELECT queries after clearUninstalledAt
      let selectCount = 0;
      const errorMessage = `boom ${FAILURE_SHOP} shpat_fake_token_123`;

      const failingSql = new Proxy(sql, {
        apply: (_target, _thisArg, args) => {
          const queryStr = String(args[0]?.strings?.join?.("") ?? args[0] ?? "");
          // Let the first few queries (upsert, clear) pass, fail the SELECT for eligible accounts
          if (queryStr.includes("SELECT") && queryStr.includes("BuyerAccount") && queryStr.includes("syncPending")) {
            selectCount++;
            if (selectCount >= 1) {
              return Promise.reject(new Error(errorMessage));
            }
          }
          return Reflect.apply(sql, sql, args);
        },
        get: (target, prop, receiver) => {
          if (prop === "begin") {
            return target.begin.bind(target);
          }
          return Reflect.get(target, prop, receiver);
        }
      }) as typeof sql;

      // Capture console calls with real log.server (no mocking)
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      vi.doMock("../request-context.server", () => ({
        getRequestSql: vi.fn(() => failingSql),
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

      const { runAfterAuth, _resetSetupCacheForTesting } = await import("../after-auth.server");
      _resetSetupCacheForTesting();

      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: () =>
            Promise.resolve({ data: { shop: { id: "gid://shopify/Shop/1", ianaTimezone: "Asia/Kolkata", currencyCode: "INR" } } }),
        }),
      };

      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = (p: Promise<unknown>) => waitUntilPromises.push(p);

      // Should not throw
      expect(() => {
        runAfterAuth(FAILURE_SHOP, mockAdmin as Parameters<typeof runAfterAuth>[1], mockWaitUntil);
      }).not.toThrow();

      // Drain loop should resolve (try/catch present)
      for (let n = 0; n < waitUntilPromises.length; n++) await waitUntilPromises[n];

      // Verify uninstalledAt was cleared (reinstall happened)
      const shopRow = await sql<{ uninstalledAt: Date | null; syncPending?: boolean }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE id = ${failShop.id}
      `;
      expect(shopRow[0].uninstalledAt).toBeNull();

      // Verify syncPending still true (enqueue failed, no change)
      const accountRow = await sql<{ syncPending: boolean }[]>`
        SELECT "syncPending" FROM "BuyerAccount" WHERE "shopId" = ${failShop.id}
      `;
      expect(accountRow[0].syncPending).toBe(true);

      // Verify no queue rows exist for this shop
      const queueRows = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${FAILURE_SHOP}
      `;
      expect(queueRows[0].count).toBe(0);

      // Verify no sensitive data leaked in logs
      const allCalls = [
        ...consoleSpy.mock.calls,
        ...consoleWarnSpy.mock.calls,
        ...consoleLogSpy.mock.calls,
      ];

      for (const call of allCalls) {
        const callStr = JSON.stringify(call);
        expect(callStr).not.toContain(".myshopify.com");
        expect(callStr).not.toMatch(/shpat_/i);
        expect(callStr).not.toContain("boom");
      }

      consoleSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();

      // Cleanup
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${failShop.id}`;
      await sql`DELETE FROM "Shop" WHERE id = ${failShop.id}`;
    });
  });

  describe("leak test: no sensitive data in logs", () => {
    it("no shop domain, token, or error message text in console mock.calls (on reinstall)", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await sql`UPDATE "Shop" SET "uninstalledAt" = NOW() WHERE id = ${inrShopId}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "syncPending", "metafieldSyncedAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${inrShopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/leak-test', 'gid://shopify/CompanyLocation/leak-test',
           'Leak Test Account', 'OK', true, NULL, NOW(), NOW())
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

      const { runAfterAuth, _resetSetupCacheForTesting } = await import("../after-auth.server");
      _resetSetupCacheForTesting();

      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: () =>
            Promise.resolve({ data: { shop: { id: "gid://shopify/Shop/1", ianaTimezone: "Asia/Kolkata", currencyCode: "INR" } } }),
        }),
      };

      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = (p: Promise<unknown>) => waitUntilPromises.push(p);

      runAfterAuth(INR_SHOP, mockAdmin as Parameters<typeof runAfterAuth>[1], mockWaitUntil);
      for (let n = 0; n < waitUntilPromises.length; n++) await waitUntilPromises[n];

      const allCalls = [
        ...consoleSpy.mock.calls,
        ...consoleWarnSpy.mock.calls,
        ...consoleLogSpy.mock.calls,
      ];

      for (const call of allCalls) {
        const callStr = JSON.stringify(call);
        expect(callStr).not.toContain(".myshopify.com");
        expect(callStr).not.toMatch(/shpat_/i);
        expect(callStr).not.toMatch(/shpua_/i);
        expect(callStr).not.toMatch(/Bearer /i);
      }

      consoleSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });
  });

  describe("'sync' source is handled by all consumers", () => {
    it("CREDIT_STATUS_SOURCES includes 'sync'", async () => {
      vi.resetModules();
      const creditStatusModule = await import("~/services/credit-status.server");
      expect(creditStatusModule.CREDIT_STATUS_SOURCES).toContain("sync");
    });

    it("enqueueCreditStatusRecompute accepts 'sync' source", async () => {
      vi.resetModules();
      const { enqueueCreditStatusRecompute } = await import("~/services/credit-status-recompute.server");
      const testBuyerAccountId = `test-sync-source-${Date.now()}-${TEST_SUFFIX}`;

      await enqueueCreditStatusRecompute(sql, INR_SHOP, testBuyerAccountId, "sync");

      const messages = await sql<{ source: string }[]>`
        SELECT message->>'source' AS source
        FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${testBuyerAccountId}
      `;
      expect(messages[0]?.source).toBe("sync");
    });
  });

  describe("drain handler integration", () => {
    it("drain through real handler: HELD account gets hold=true in metafield, syncPending=false, metafieldSyncedAt set", async () => {
      vi.resetModules();

      const drainAccountId = `drain-held-${TEST_SUFFIX}`;
      const locationGid = "gid://shopify/CompanyLocation/drain-held-1";

      // Use manualHold=true so the account stays HELD after recompute
      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "manualHold", "holdReasonCode", "syncPending", "syncVersion", "metafieldSyncedAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${drainAccountId}, ${inrShopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/drain-held', ${locationGid},
           'Drain HELD Account', 'HELD', true, 'MANUAL_HOLD', true, 1, NULL, NOW(), NOW())
      `;

      // Track metafieldsSet call
      let capturedVariables: Record<string, unknown> | null = null;
      mockShopifyGraphQLRequest.mockImplementation(async (_shop: string, _query: string, vars?: Record<string, unknown>) => {
        if (vars?.metafields) {
          capturedVariables = vars;
        }
        return {
          success: true,
          data: { metafieldsSet: { metafields: [{ id: "mf-drain" }], userErrors: [] } },
        };
      });

      // Enqueue via reinstall helper
      const { _enqueueReinstallResyncForTesting } = await import("../after-auth.server");
      const enqueued = await _enqueueReinstallResyncForTesting(sql, inrShopId, INR_SHOP);
      expect(enqueued).toBe(1);

      // Get the message
      const [msg] = await sql<{ msg_id: string; message: Record<string, unknown> }[]>`
        SELECT msg_id::text AS msg_id, message
        FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${drainAccountId}
      `;
      expect(msg).toBeDefined();
      expect(msg.message.source).toBe("sync");

      // Drain through real handler
      const { getSyncHandler } = await import("~/services/drain/processor.server");
      const handler = getSyncHandler("CREDIT_STATUS_RECOMPUTE");
      expect(handler).toBeDefined();

      // Simulate pgmq.read
      await sql`
        UPDATE pgmq.q_s6_sync
        SET read_ct = read_ct + 1, vt = NOW() + INTERVAL '30 seconds'
        WHERE msg_id = ${msg.msg_id}
      `;
      const result = await handler!(sql, msg.message as never);
      expect(result.success).toBe(true);

      // Archive on success
      await sql`SELECT pgmq.archive('s6_sync', ${msg.msg_id}::bigint)`;

      // Verify credit_status value in metafieldsSet variables has hold=true
      expect(capturedVariables).not.toBeNull();
      const metafields = capturedVariables!.metafields as Array<{ key: string; value: string }>;
      const creditStatusMetafield = metafields?.find(mf => mf.key === "credit_status");
      expect(creditStatusMetafield).toBeDefined();
      const creditStatusValue = JSON.parse(creditStatusMetafield!.value);
      expect(creditStatusValue.hold).toBe(true);

      // Verify syncPending=false and metafieldSyncedAt is set
      const [account] = await sql<{ syncPending: boolean; metafieldSyncedAt: Date | null }[]>`
        SELECT "syncPending", "metafieldSyncedAt"
        FROM "BuyerAccount"
        WHERE id = ${drainAccountId}
      `;
      expect(account.syncPending).toBe(false);
      expect(account.metafieldSyncedAt).not.toBeNull();

      // Cleanup
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${inrShopId}`;
    });
  });

  describe("double-write prevention", () => {
    it("reinstall + daily sweep enqueue same account; drain both → exactly 1 metafield write", async () => {
      vi.resetModules();
      metafieldWriteCount = 0;

      const doubleWriteAccountId = `double-write-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "syncPending", "syncVersion", "metafieldSyncedAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${doubleWriteAccountId}, ${inrShopId}, 'COMPANY'::"AccountKind",
           'gid://shopify/Company/double-write', 'gid://shopify/CompanyLocation/double-write',
           'Double Write Account', 'OK', true, 1, NULL, NOW(), NOW())
      `;

      // Mock shopifyGraphQLRequest to count writes
      mockShopifyGraphQLRequest.mockImplementation(async () => {
        metafieldWriteCount++;
        return {
          success: true,
          data: { metafieldsSet: { metafields: [{ id: "mf-1" }], userErrors: [] } },
        };
      });

      // 1. Enqueue via reinstall helper
      const { _enqueueReinstallResyncForTesting } = await import("../after-auth.server");
      await _enqueueReinstallResyncForTesting(sql, inrShopId, INR_SHOP);

      // 2. Enqueue via enqueueCreditStatusRecompute (simulating daily sweep)
      const { enqueueCreditStatusRecompute } = await import("~/services/credit-status-recompute.server");
      await enqueueCreditStatusRecompute(sql, INR_SHOP, doubleWriteAccountId, "daily_sweep");

      // Get both message IDs
      const msgIds = await sql<{ msg_id: string }[]>`
        SELECT msg_id::text AS msg_id
        FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${doubleWriteAccountId}
        ORDER BY msg_id
      `;
      expect(msgIds).toHaveLength(2);

      // Process both messages through the real handler
      const { getSyncHandler } = await import("~/services/drain/processor.server");
      const handler = getSyncHandler("CREDIT_STATUS_RECOMPUTE");
      expect(handler).toBeDefined();

      for (const { msg_id } of msgIds) {
        // Simulate pgmq.read
        const [row] = await sql<{ message: Record<string, unknown> }[]>`
          UPDATE pgmq.q_s6_sync
          SET read_ct = read_ct + 1, vt = NOW() + INTERVAL '30 seconds'
          WHERE msg_id = ${msg_id}
          RETURNING message
        `;
        if (row && handler) {
          const result = await handler(sql, row.message as never);
          if (result.success) {
            await sql`SELECT pgmq.archive('s6_sync', ${msg_id}::bigint)`;
          }
        }
      }

      // Assert exactly 1 metafield write (syncVersion prevents double write)
      expect(metafieldWriteCount).toBe(1);

      // Cleanup
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${inrShopId}`;
    });
  });
});
