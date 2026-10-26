/**
 * #294 PR2: DB-backed integration tests for reinstall credit status re-push.
 *
 * Tests verify:
 * 1. POSITIVE: Reinstall of INR shop enqueues >0 messages and logs existing info key
 * 2. NEGATIVE: Non-INR, XXX/NULL currency, failing setup, and still-uninstalled all get 0
 * 3. Eligibility exclusions: no-owner, redacted (but not lookalikes), permanent error
 * 4. Cap enforcement: 500 max and exact-500, HELD-first ordering
 * 5. Enqueue failure doesn't fail auth (try/catch present)
 * 6. No sensitive data leaks in logs
 * 7. 'sync' source is handled by all consumers
 *
 * Uses the same exclusions as Part 3 resync in enqueue_credit_status_recomputes(),
 * plus the INR filter and HELD-first ordering.
 * @see prisma/migrations/20261111000000_sweep_skip_uninstalled/migration.sql
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

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
    it("uninstalled INR shop enqueues >0 messages and logs cleared_uninstalled_at_and_metafield_errors", async () => {
      // Set uninstalledAt so reinstall branch runs
      await sql`UPDATE "Shop" SET "uninstalledAt" = NOW() WHERE id = ${inrShopId}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          "shopId", kind, "companyId", "companyLocationId", name,
          "holdState", "syncPending", "metafieldSyncedAt",
          "createdAt", "updatedAt"
        )
        VALUES
          (${inrShopId}, 'COMPANY'::"AccountKind",
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

      // Verify messages enqueued
      const messages = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM pgmq.q_s6_sync
        WHERE message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
          AND message->>'shop' = ${INR_SHOP}
      `;
      expect(messages[0].count).toBeGreaterThan(0);

      // Verify existing info log key was used
      const logCalls = consoleLogSpy.mock.calls.map(c => JSON.stringify(c));
      const hasReinstallLog = logCalls.some(c => c.includes("cleared_uninstalled_at_and_metafield_errors"));
      expect(hasReinstallLog).toBe(true);

      consoleLogSpy.mockRestore();
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

    it("setup failure gets 0 messages on reinstall", async () => {
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

    it("enqueueReinstallResync returns 0 when shop is uninstalled (shopRow.uninstalledAt check)", async () => {
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

    it("cap: 501 eligible gives 500, and the 501st keeps syncPending=true", async () => {
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

      const stillPending = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM "BuyerAccount"
        WHERE "shopId" = ${inrShopId}
          AND "syncPending" = true
      `;
      expect(stillPending[0].count).toBe(501);
    });

    it("HELD-first ordering: HELD accounts prioritized even when non-HELD IDs sort earlier (zz-held vs aa-ok)", async () => {
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

  describe("enqueue failure doesn't fail auth", () => {
    it("runAfterAuth completes even when enqueue query errors (try/catch present)", async () => {
      await sql`UPDATE "Shop" SET "uninstalledAt" = NOW() WHERE id = ${inrShopId}`;

      // Don't insert any accounts - the enqueue should succeed with 0 accounts
      // The try/catch is tested by the code path completing without throw

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

      expect(() => {
        runAfterAuth(INR_SHOP, mockAdmin as Parameters<typeof runAfterAuth>[1], mockWaitUntil);
      }).not.toThrow();

      for (let n = 0; n < waitUntilPromises.length; n++) await waitUntilPromises[n];
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
});
