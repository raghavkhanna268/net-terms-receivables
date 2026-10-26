/**
 * DB-backed integration test for ORDERS_* no-session ACK behavior (#239 extension).
 *
 * Tests that ORDERS_* webhooks for uninstalled shops are ACKed (not DLQ'd):
 * - No s6_dead_letter row created
 * - No backstop.failed record
 * - Message removed from queue
 *
 * Also tests that installed shops with no session still go to DLQ as before.
 *
 * This test uses the "Sequential DB" project via the *-db.test.ts naming pattern.
 */
import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
const SUFFIX = Date.now().toString(36) + "-orders-nosession";

const UNINSTALLED_SHOP = {
  id: `shop-uninstalled-${SUFFIX}`,
  domain: `test-uninstalled-${SUFFIX}.myshopify.com`,
};

const INSTALLED_SHOP = {
  id: `shop-installed-${SUFFIX}`,
  domain: `test-installed-${SUFFIX}.myshopify.com`,
};

let sqlRef: ReturnType<typeof postgres>;

vi.mock("~/services/drain/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/drain/admin-client.server")>();
  return {
    ...actual,
    adminGraphQL: vi.fn().mockImplementation(async () => {
      return {
        success: false,
        error: "No session found",
        errorCode: "no_session",
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
  };
});

describeWithDb("ORDERS_* no-session ACK behavior (#239 extension)", () => {
  beforeAll(async () => {
    sqlRef = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    const allDomains = [UNINSTALLED_SHOP.domain, INSTALLED_SHOP.domain];

    await sqlRef`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM s6_dead_letter WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`%${SUFFIX}%`}`;
    await sqlRef`DELETE FROM backstop_processed_orders WHERE order_gid LIKE ${`%${SUFFIX}%`}`;
    await sqlRef`DELETE FROM "Shop" WHERE id IN (${UNINSTALLED_SHOP.id}, ${INSTALLED_SHOP.id})`;

    await sqlRef.end();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("ORDERS_CREATE for uninstalled shop: ACKed, no DLQ, no backstop.failed", async () => {
    const now = new Date();
    const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);

    await sqlRef`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
      VALUES (${UNINSTALLED_SHOP.id}, ${UNINSTALLED_SHOP.domain}, 'INR', ${now}, ${now}, ${uninstalledAt})
    `;

    const orderMsg = {
      shop: UNINSTALLED_SHOP.domain,
      topic: "ORDERS_CREATE",
      webhookId: `wh-orders-create-${SUFFIX}`,
      resourceGid: `gid://shopify/Order/uninstalled-${SUFFIX}`,
      enqueuedAt: now.toISOString(),
    };

    await sqlRef`SELECT pgmq.send('s6_sync', ${sqlRef.json(orderMsg)})`;

    const [queueCountBefore] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${UNINSTALLED_SHOP.domain}
    `;
    expect(parseInt(queueCountBefore.count, 10)).toBe(1);

    const { runDrain } = await import("~/services/drain/processor.server");
    const result = await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

    expect(result.processed + result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.deadLettered).toBe(0);

    const [queueCountAfter] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${UNINSTALLED_SHOP.domain}
    `;
    expect(parseInt(queueCountAfter.count, 10), "message removed from q_s6_sync").toBe(0);

    const [dlqCount] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM s6_dead_letter
      WHERE message->>'shop' = ${UNINSTALLED_SHOP.domain}
    `;
    expect(parseInt(dlqCount.count, 10), "no DLQ entry for uninstalled shop").toBe(0);

    const [backstopCount] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM backstop_processed_orders
      WHERE order_gid = ${orderMsg.resourceGid}
        AND outcome = 'failed'
    `;
    expect(parseInt(backstopCount.count, 10), "no backstop.failed record").toBe(0);

    await sqlRef`DELETE FROM "Shop" WHERE id = ${UNINSTALLED_SHOP.id}`;
  });

  it("ORDERS_CREATE for installed shop with no session: still goes to DLQ", async () => {
    const now = new Date();

    await sqlRef`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${INSTALLED_SHOP.id}, ${INSTALLED_SHOP.domain}, 'INR', ${now}, ${now})
    `;

    const orderMsg = {
      shop: INSTALLED_SHOP.domain,
      topic: "ORDERS_CREATE",
      webhookId: `wh-orders-create-installed-${SUFFIX}`,
      resourceGid: `gid://shopify/Order/installed-${SUFFIX}`,
      enqueuedAt: now.toISOString(),
    };

    await sqlRef`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 4, NOW(), ${sqlRef.json(orderMsg)}::jsonb)
    `;

    const [queueCountBefore] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${INSTALLED_SHOP.domain}
    `;
    expect(parseInt(queueCountBefore.count, 10)).toBe(1);

    const { runDrain } = await import("~/services/drain/processor.server");
    await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

    const [queueCountAfter] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${INSTALLED_SHOP.domain}
    `;
    expect(parseInt(queueCountAfter.count, 10), "message removed from q_s6_sync").toBe(0);

    const [dlqCount] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM s6_dead_letter
      WHERE message->>'shop' = ${INSTALLED_SHOP.domain}
    `;
    expect(parseInt(dlqCount.count, 10), "installed shop no_session goes to DLQ").toBe(1);

    await sqlRef`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${INSTALLED_SHOP.domain}`;
    await sqlRef`DELETE FROM "Shop" WHERE id = ${INSTALLED_SHOP.id}`;
  });
});
