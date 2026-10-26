/**
 * DB-backed tests for bounded multi-pass drain within one tick.
 *
 * Verifies:
 * 1. Chained stages: a message in pass 1 enqueues a follow-up processed in same tick
 * 2. Stops when both queues are empty (exact read counts)
 * 3. Stops at MAX_DRAIN_PASSES even if messages keep coming
 * 4. Result aggregation across passes
 *
 * Each test must FAIL when the multi-pass fix is reverted to single-pass.
 *
 * Uses describeWithDb for real database integration with pgmq.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { S6_QUEUES } from "~/lib/pgmq.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

function makeTestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-mp`;
}

let sqlRef: postgres.Sql;

vi.mock("~/services/drain/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/drain/admin-client.server")>();
  return {
    ...actual,
    adminGraphQL: vi.fn().mockImplementation(async (_shop: string, query: string, variables?: Record<string, unknown>) => {
      if (query.includes("CompanyById") && variables?.id) {
        return {
          success: true,
          data: {
            node: {
              id: variables.id as string,
              name: "Test Company",
            },
          },
          retryable: false,
        };
      }
      return { success: false, error: "not_found", retryable: false };
    }),
  };
});

vi.mock("~/services/sync/company.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/sync/company.server")>();
  return {
    ...actual,
    isWebhookProcessed: vi.fn().mockResolvedValue(false),
    processCompanyWebhook: vi.fn().mockResolvedValue({
      success: true,
      action: "created",
      entityId: "test-buyer-account-id",
    }),
    markWebhookProcessed: actual.markWebhookProcessed,
  };
});

describeWithDb("multi-pass drain DB tests (#454)", () => {
  const TEST_ID = makeTestId();
  const TEST_SHOP = `test-${TEST_ID}.myshopify.com`;

  beforeAll(async () => {
    sqlRef = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sqlRef`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (
        ${`shop-${TEST_ID}`},
        ${TEST_SHOP},
        'INR',
        NOW(),
        NOW()
      )
      ON CONFLICT (domain) DO NOTHING
    `;
  }, 30000);

  afterAll(async () => {
    try {
      await sqlRef`DELETE FROM "Shop" WHERE id = ${`shop-${TEST_ID}`}`;
    } catch {
      // Ignore cleanup errors
    }
    await sqlRef.end();
  }, 30000);

  beforeEach(async () => {
    vi.clearAllMocks();
    try {
      await sqlRef`DELETE FROM pgmq.q_s6_sync WHERE (message->>'shop')::text = ${TEST_SHOP}`;
      await sqlRef`DELETE FROM pgmq.q_s6_bulk WHERE (message->>'shop')::text = ${TEST_SHOP}`;
    } catch {
      // Ignore if queues don't exist
    }
  }, 30000);

  describe("chained stages", () => {
    it("processes follow-up message enqueued in pass 1 during same tick", async () => {
      const { processCompanyWebhook } = await import("~/services/sync/company.server");
      const mockProcess = processCompanyWebhook as ReturnType<typeof vi.fn>;

      let callCount = 0;
      mockProcess.mockImplementation(async (sql) => {
        callCount++;
        if (callCount === 1) {
          await sql`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sql.json({
            topic: "COMPANIES_UPDATE",
            shop: TEST_SHOP,
            webhookId: `wh-followup-${TEST_ID}-${callCount}`,
            resourceGid: `gid://shopify/Company/followup-${TEST_ID}-${callCount}`,
            enqueuedAt: new Date().toISOString(),
          })})`;
        }
        return { success: true, action: "created", entityId: `ba-${callCount}` };
      });

      await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json({
        topic: "COMPANIES_CREATE",
        shop: TEST_SHOP,
        webhookId: `wh-initial-${TEST_ID}`,
        resourceGid: `gid://shopify/Company/initial-${TEST_ID}`,
        enqueuedAt: new Date().toISOString(),
      })})`;

      const { runDrain } = await import("../processor.server");
      const result = await runDrain(sqlRef, { batchSize: 5, timeBudgetMs: 15000 });

      expect(result.processed).toBe(2);
      expect(callCount).toBe(2);
    }, 30000);
  });

  describe("stop conditions", () => {
    it("stops when both queues are empty (single pass)", async () => {
      const { runDrain } = await import("../processor.server");
      const result = await runDrain(sqlRef, { batchSize: 5, timeBudgetMs: 15000 });

      expect(result.processed).toBe(0);
      expect(result.timedOut).toBe(false);
    }, 30000);

    it("stops at MAX_DRAIN_PASSES even if messages keep coming", async () => {
      const { MAX_DRAIN_PASSES, runDrain } = await import("../processor.server");
      const { processCompanyWebhook } = await import("~/services/sync/company.server");
      const mockProcess = processCompanyWebhook as ReturnType<typeof vi.fn>;

      let processCount = 0;
      mockProcess.mockImplementation(async (sql) => {
        processCount++;
        await sql`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sql.json({
          topic: "COMPANIES_UPDATE",
          shop: TEST_SHOP,
          webhookId: `wh-chain-${TEST_ID}-${processCount}`,
          resourceGid: `gid://shopify/Company/chain-${TEST_ID}-${processCount}`,
          enqueuedAt: new Date().toISOString(),
        })})`;
        return { success: true, action: "created", entityId: `ba-${processCount}` };
      });

      await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json({
        topic: "COMPANIES_CREATE",
        shop: TEST_SHOP,
        webhookId: `wh-start-${TEST_ID}`,
        resourceGid: `gid://shopify/Company/start-${TEST_ID}`,
        enqueuedAt: new Date().toISOString(),
      })})`;

      const result = await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 60000 });

      expect(processCount).toBe(MAX_DRAIN_PASSES);
      expect(result.processed).toBe(MAX_DRAIN_PASSES);
    }, 30000);
  });

  describe("result aggregation", () => {
    it("aggregates processed count across passes", async () => {
      const { processCompanyWebhook } = await import("~/services/sync/company.server");
      const mockProcess = processCompanyWebhook as ReturnType<typeof vi.fn>;

      let callCount = 0;
      mockProcess.mockImplementation(async (sql) => {
        callCount++;
        if (callCount < 3) {
          await sql`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sql.json({
            topic: "COMPANIES_UPDATE",
            shop: TEST_SHOP,
            webhookId: `wh-agg-${TEST_ID}-${callCount}`,
            resourceGid: `gid://shopify/Company/agg-${TEST_ID}-${callCount}`,
            enqueuedAt: new Date().toISOString(),
          })})`;
        }
        return { success: true, action: "created", entityId: `ba-${callCount}` };
      });

      await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json({
        topic: "COMPANIES_CREATE",
        shop: TEST_SHOP,
        webhookId: `wh-aggstart-${TEST_ID}`,
        resourceGid: `gid://shopify/Company/aggstart-${TEST_ID}`,
        enqueuedAt: new Date().toISOString(),
      })})`;

      const { runDrain } = await import("../processor.server");
      const result = await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 15000 });

      expect(result.processed).toBe(3);
      expect(callCount).toBe(3);
    }, 30000);
  });
});

describe("Multi-pass drain constants (no DB)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("MAX_DRAIN_PASSES is 4", async () => {
    const { MAX_DRAIN_PASSES } = await import("../processor.server");
    expect(MAX_DRAIN_PASSES).toBe(4);
  });

  it("PASS_START_MARGIN_MS is 3000", async () => {
    const { PASS_START_MARGIN_MS } = await import("../processor.server");
    expect(PASS_START_MARGIN_MS).toBe(3000);
  });

  it("time budget margin is timeBudgetMs - 3000", async () => {
    const { DEFAULT_DRAIN_CONFIG, PASS_START_MARGIN_MS } = await import("../processor.server");
    expect(DEFAULT_DRAIN_CONFIG.timeBudgetMs - PASS_START_MARGIN_MS).toBe(12000);
  });
});
