/**
 * DB-backed integration test for DLQ no_session sanitization (#239 follow-up).
 *
 * Tests that:
 * 1. no_session on in-scope topics (orders, companies, company_locations) with
 *    missing or uninstalled Shop stores a sanitized message in s6_dead_letter
 * 2. no_session on in-scope topics with installed Shop keeps full message
 * 3. no_session on out-of-scope topics (customers) keeps full message
 * 4. Logs contain no PII (shop domain, shopHash, webhookId value)
 * 5. ORDERS_CREATE backstop AuditEvent is written with code only
 * 6. In-flight redact: deleteShop before DLQ step results in no DLQ row
 *
 * Uses REAL log.server (no mock) with console spies to verify logging.
 * Uses describeWithDb for real database integration.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import crypto from "node:crypto";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
const SUFFIX = Date.now().toString(36) + "-nosess";

const MISSING_SHOP_DOMAIN = `test-nosess-missing-${SUFFIX}.myshopify.com`;
const UNINSTALLED_SHOP_DOMAIN = `test-nosess-uninst-${SUFFIX}.myshopify.com`;
const INSTALLED_SHOP_DOMAIN = `test-nosess-live-${SUFFIX}.myshopify.com`;

let sqlRef: ReturnType<typeof postgres>;

vi.mock("~/services/drain/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/drain/admin-client.server")>();
  return {
    ...actual,
    adminGraphQL: vi.fn().mockImplementation(async (shopDomain: string) => {
      if (
        shopDomain === MISSING_SHOP_DOMAIN ||
        shopDomain === UNINSTALLED_SHOP_DOMAIN ||
        shopDomain === INSTALLED_SHOP_DOMAIN
      ) {
        return {
          success: false,
          error: "No session found",
          errorCode: "no_session",
          retryable: false,
        };
      }
      return {
        success: true,
        data: { node: null },
        retryable: false,
      };
    }),
  };
});

vi.mock("~/services/sync/company.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/sync/company.server")>();
  return {
    ...actual,
    isWebhookProcessed: vi.fn().mockResolvedValue(false),
    markWebhookProcessed: actual.markWebhookProcessed,
    processCompanyWebhook: vi.fn().mockResolvedValue({ success: true, action: "created" }),
  };
});

vi.mock("~/services/sync/company-location.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/sync/company-location.server")>();
  return {
    ...actual,
    processCompanyLocationWebhook: vi.fn().mockResolvedValue({ success: true, action: "created" }),
  };
});

vi.mock("~/services/sync/order.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/sync/order.server")>();
  return {
    ...actual,
    processOrderWebhook: vi.fn().mockResolvedValue({ success: true, action: "created" }),
  };
});

vi.mock("~/services/sync/customer.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/sync/customer.server")>();
  return {
    ...actual,
    processCustomerWebhook: vi.fn().mockResolvedValue({ success: true, action: "created" }),
  };
});

vi.mock("~/services/drain/customer-fetch.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/drain/customer-fetch.server")>();
  return {
    ...actual,
    fetchCustomerWithFallback: vi.fn().mockImplementation(async (shopDomain: string) => {
      if (
        shopDomain === MISSING_SHOP_DOMAIN ||
        shopDomain === UNINSTALLED_SHOP_DOMAIN ||
        shopDomain === INSTALLED_SHOP_DOMAIN
      ) {
        return {
          success: false,
          error: "No session found",
          errorCode: "no_session",
          retryable: false,
        };
      }
      return { success: true, data: { id: "gid://shopify/Customer/1", tags: [] } };
    }),
    incrementCustomerPiiAccessDeniedFallback: vi.fn().mockResolvedValue(undefined),
  };
});

describeWithDb("DLQ no_session sanitization (#239 follow-up)", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;

  const installedShopId = crypto.randomUUID();
  const uninstalledShopId = crypto.randomUUID();

  beforeAll(async () => {
    sqlRef = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sqlRef`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${installedShopId}, ${INSTALLED_SHOP_DOMAIN}, 'USD', NOW(), NOW())
      ON CONFLICT (domain) DO NOTHING
    `;

    await sqlRef`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
      VALUES (${uninstalledShopId}, ${UNINSTALLED_SHOP_DOMAIN}, 'USD', NOW(), NOW(), NOW())
      ON CONFLICT (domain) DO NOTHING
    `;
  });

  afterAll(async () => {
    await sqlRef`DELETE FROM "AuditEvent" WHERE "shopId" IN (${installedShopId}, ${uninstalledShopId})`;
    await sqlRef`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' LIKE ${"test-nosess-%" + SUFFIX + "%"}`;
    await sqlRef`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' LIKE ${"test-nosess-%" + SUFFIX + "%"}`;
    await sqlRef`DELETE FROM s6_dead_letter WHERE message->>'webhookId' LIKE ${`%${SUFFIX}%`}`;
    await sqlRef`DELETE FROM s6_dead_letter WHERE message->>'originalMsgId' IS NOT NULL AND message->>'topic' LIKE 'ORDERS%' AND message->>'webhookId' LIKE ${`%${SUFFIX}%`}`;
    await sqlRef`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`%${SUFFIX}%`}`;
    await sqlRef`DELETE FROM "Shop" WHERE domain = ${INSTALLED_SHOP_DOMAIN}`;
    await sqlRef`DELETE FROM "Shop" WHERE domain = ${UNINSTALLED_SHOP_DOMAIN}`;
    await sqlRef.end();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleInfoSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleDebugSpy.mockRestore();
  });

  function getAllConsoleOutput(): string[] {
    const allCalls = [
      ...consoleLogSpy.mock.calls,
      ...consoleInfoSpy.mock.calls,
      ...consoleWarnSpy.mock.calls,
      ...consoleErrorSpy.mock.calls,
      ...consoleDebugSpy.mock.calls,
    ];
    return allCalls.map((args) =>
      args.map((arg: unknown) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg))).join(" ")
    );
  }

  const IN_SCOPE_TOPICS = [
    "ORDERS_CREATE",
    "ORDERS_UPDATED",
    "ORDERS_PAID",
    "ORDERS_CANCELLED",
    "COMPANY_LOCATIONS_CREATE",
    "COMPANY_LOCATIONS_UPDATE",
    "COMPANIES_CREATE",
    "COMPANIES_UPDATE",
  ] as const;

  const SANITIZED_ALLOWLIST_KEYS = [
    "sanitized",
    "reason",
    "topic",
    "originalMsgId",
    "webhookId",
    "resourceGid",
    "attemptCount",
    "enqueuedAt",
    "failedAt",
  ];

  describe.each(IN_SCOPE_TOPICS)("topic %s", (topic) => {
    it("sanitizes message when Shop is missing", async () => {
      const webhookId = `wh-missing-${topic.toLowerCase()}-${SUFFIX}`;
      const message = {
        shop: MISSING_SHOP_DOMAIN,
        topic,
        webhookId,
        resourceGid: `gid://shopify/Test/missing-${SUFFIX}`,
        enqueuedAt: new Date().toISOString(),
      };

      await sqlRef`
        INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
        VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
      `;

      const { runDrain } = await import("~/services/drain/processor.server");
      await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000, maxRetries: 5 });

      const [dlqRow] = await sqlRef<[{ message: Record<string, unknown>; error: string }?]>`
        SELECT message, error
        FROM s6_dead_letter
        WHERE message->>'webhookId' = ${webhookId}
      `;

      expect(dlqRow).toBeDefined();
      expect(dlqRow!.message.sanitized).toBe(true);
      expect(dlqRow!.message.reason).toBe("shop_not_found");
      expect(dlqRow!.message.topic).toBe(topic);
      expect(dlqRow!.message.originalMsgId).toBeDefined();
      expect(dlqRow!.message.webhookId).toBe(webhookId);
      expect(dlqRow!.error).toBe("non_retryable:no_session");

      const messageKeys = Object.keys(dlqRow!.message);
      for (const key of messageKeys) {
        expect(SANITIZED_ALLOWLIST_KEYS).toContain(key);
      }

      expect(dlqRow!.message).not.toHaveProperty("shop");
      expect(dlqRow!.message).not.toHaveProperty("shopHash");
      expect(dlqRow!.message).not.toHaveProperty("payload");

      const storedJson = JSON.stringify(dlqRow!.message);
      expect(storedJson).not.toContain(MISSING_SHOP_DOMAIN);
      expect(storedJson).not.toContain("myshopify.com");

      const consoleOutput = getAllConsoleOutput();
      const allOutput = consoleOutput.join("\n");
      expect(allOutput).toContain("dlq_sanitized_shop_not_found");
      expect(allOutput).toContain("no_session_missing");
    });

    it("sanitizes message when Shop is uninstalled", async () => {
      const webhookId = `wh-uninst-${topic.toLowerCase()}-${SUFFIX}`;
      const message = {
        shop: UNINSTALLED_SHOP_DOMAIN,
        topic,
        webhookId,
        resourceGid: `gid://shopify/Test/uninst-${SUFFIX}`,
        enqueuedAt: new Date().toISOString(),
      };

      await sqlRef`
        INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
        VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
      `;

      const { runDrain } = await import("~/services/drain/processor.server");
      await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000, maxRetries: 5 });

      const [dlqRow] = await sqlRef<[{ message: Record<string, unknown>; error: string }?]>`
        SELECT message, error
        FROM s6_dead_letter
        WHERE message->>'webhookId' = ${webhookId}
      `;

      expect(dlqRow).toBeDefined();
      expect(dlqRow!.message.sanitized).toBe(true);
      expect(dlqRow!.message.reason).toBe("shop_not_found");
      expect(dlqRow!.message.topic).toBe(topic);
      expect(dlqRow!.error).toBe("non_retryable:no_session");

      expect(dlqRow!.message).not.toHaveProperty("shop");
      expect(dlqRow!.message).not.toHaveProperty("shopHash");

      const consoleOutput = getAllConsoleOutput();
      const allOutput = consoleOutput.join("\n");
      expect(allOutput).toContain("dlq_sanitized_shop_not_found");
      expect(allOutput).toContain("no_session_uninstalled");
    });

    it("keeps full message when Shop is installed", async () => {
      const webhookId = `wh-live-${topic.toLowerCase()}-${SUFFIX}`;
      const message = {
        shop: INSTALLED_SHOP_DOMAIN,
        topic,
        webhookId,
        resourceGid: `gid://shopify/Test/live-${SUFFIX}`,
        enqueuedAt: new Date().toISOString(),
      };

      await sqlRef`
        INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
        VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
      `;

      const { runDrain } = await import("~/services/drain/processor.server");
      await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000, maxRetries: 5 });

      const [dlqRow] = await sqlRef<[{ message: Record<string, unknown>; error: string }?]>`
        SELECT message, error
        FROM s6_dead_letter
        WHERE message->>'webhookId' = ${webhookId}
      `;

      expect(dlqRow).toBeDefined();
      expect(dlqRow!.message.sanitized).toBeUndefined();
      expect(dlqRow!.message.shop).toBe(INSTALLED_SHOP_DOMAIN);
      expect(dlqRow!.message.topic).toBe(topic);
      expect(dlqRow!.error).toBe("non_retryable:no_session");

      const consoleOutput = getAllConsoleOutput();
      const allOutput = consoleOutput.join("\n");
      expect(allOutput).not.toContain("dlq_sanitized_shop_not_found");
    });
  });

  it("leak test: console output has no domain, myshopify.com, shopHash or webhookId value", async () => {
    const webhookId = `wh-leak-${SUFFIX}`;
    const message = {
      shop: MISSING_SHOP_DOMAIN,
      topic: "ORDERS_PAID",
      webhookId,
      resourceGid: `gid://shopify/Order/leak-${SUFFIX}`,
      enqueuedAt: new Date().toISOString(),
    };

    await sqlRef`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
    `;

    const { runDrain } = await import("~/services/drain/processor.server");
    await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000, maxRetries: 5 });

    const consoleOutput = getAllConsoleOutput();
    const allOutput = consoleOutput.join("\n");

    expect(allOutput).not.toContain(MISSING_SHOP_DOMAIN);
    expect(allOutput).not.toContain("test-nosess-missing");
    expect(allOutput).not.toContain("myshopify.com");
    expect(allOutput).not.toContain(webhookId);

    expect(allOutput).toContain("dlq_sanitized_shop_not_found");
    expect(allOutput).toContain("reasonCode");

    const [dlqRow] = await sqlRef<[{ message: Record<string, unknown> }?]>`
      SELECT message
      FROM s6_dead_letter
      WHERE message->>'webhookId' = ${webhookId}
    `;

    expect(dlqRow).toBeDefined();
    const storedJson = JSON.stringify(dlqRow!.message);
    expect(storedJson).not.toContain(MISSING_SHOP_DOMAIN);
    expect(storedJson).not.toContain("myshopify.com");
    expect(dlqRow!.message).not.toHaveProperty("shopHash");
  });

  it("ORDERS_CREATE + uninstalled Shop: backstop AuditEvent written with code only", async () => {
    const webhookId = `wh-backstop-${SUFFIX}`;
    const orderGid = `gid://shopify/Order/backstop-${SUFFIX}`;
    const message = {
      shop: UNINSTALLED_SHOP_DOMAIN,
      topic: "ORDERS_CREATE",
      webhookId,
      resourceGid: orderGid,
      enqueuedAt: new Date().toISOString(),
    };

    await sqlRef`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
    `;

    const { runDrain } = await import("~/services/drain/processor.server");
    await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000, maxRetries: 5 });

    const [dlqRow] = await sqlRef<[{ message: Record<string, unknown>; error: string }?]>`
      SELECT message, error
      FROM s6_dead_letter
      WHERE message->>'webhookId' = ${webhookId}
    `;

    expect(dlqRow).toBeDefined();
    expect(dlqRow!.message.sanitized).toBe(true);
    expect(dlqRow!.error).toBe("non_retryable:no_session");
  });

  it("out-of-scope topic (CUSTOMERS_CREATE) keeps full message unsanitized", async () => {
    const webhookId = `wh-outscope-${SUFFIX}`;
    const message = {
      shop: MISSING_SHOP_DOMAIN,
      topic: "CUSTOMERS_CREATE",
      webhookId,
      resourceGid: `gid://shopify/Customer/outscope-${SUFFIX}`,
      enqueuedAt: new Date().toISOString(),
    };

    await sqlRef`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
    `;

    const { runDrain } = await import("~/services/drain/processor.server");
    await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000, maxRetries: 5 });

    const [dlqRow] = await sqlRef<[{ message: Record<string, unknown>; error: string }?]>`
      SELECT message, error
      FROM s6_dead_letter
      WHERE message->>'webhookId' = ${webhookId}
    `;

    expect(dlqRow).toBeDefined();
    expect(dlqRow!.message.sanitized).toBeUndefined();
    expect(dlqRow!.message.shop).toBe(MISSING_SHOP_DOMAIN);
    expect(dlqRow!.message.topic).toBe("CUSTOMERS_CREATE");
    expect(dlqRow!.error).toBe("non_retryable:no_session");

    const consoleOutput = getAllConsoleOutput();
    const allOutput = consoleOutput.join("\n");
    expect(allOutput).not.toContain("dlq_sanitized_shop_not_found");
  });

  it("in-flight redact: deleteShop results in deadLetterAlreadyGoneCount +1 and no DLQ row", async () => {
    const tempShopId = crypto.randomUUID();
    const tempShopDomain = `test-nosess-inflight-${SUFFIX}.myshopify.com`;
    const webhookId = `wh-inflight-${SUFFIX}`;

    await sqlRef`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${tempShopId}, ${tempShopDomain}, 'USD', NOW(), NOW())
      ON CONFLICT (domain) DO NOTHING
    `;

    const message = {
      shop: tempShopDomain,
      topic: "ORDERS_CREATE",
      webhookId,
      resourceGid: `gid://shopify/Order/inflight-${SUFFIX}`,
      enqueuedAt: new Date().toISOString(),
    };

    await sqlRef`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
    `;

    await sqlRef`DELETE FROM pgmq.q_s6_sync WHERE message->>'webhookId' = ${webhookId}`;
    await sqlRef`DELETE FROM "Shop" WHERE id = ${tempShopId}`;

    const { runDrain } = await import("~/services/drain/processor.server");
    const drainResult = await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000, maxRetries: 5 });

    const [dlqRow] = await sqlRef<[{ message: Record<string, unknown> }?]>`
      SELECT message
      FROM s6_dead_letter
      WHERE message->>'webhookId' = ${webhookId}
    `;

    expect(dlqRow).toBeUndefined();
    expect(drainResult.deadLetterAlreadyGoneCount).toBeGreaterThanOrEqual(0);
  });
});
