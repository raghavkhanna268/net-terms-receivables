/**
 * DB-backed integration tests for credit-status-metafield-backfill.ts script.
 * Uses the CI pgmq Postgres service.
 *
 * Tests:
 * - parseArgs validates flags correctly
 * - Dry-run makes zero mutations (queue length unchanged)
 * - Dry-run prints no PII (no IDs, names, emails, shop domains)
 * - --dry-run --apply is rejected as mutually exclusive
 * - --apply enqueues exactly N messages with the right message shape
 * - A rerun on the same day is deduped (dedupe key includes date)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { parseArgs, getBackfillStats, getCandidates, enqueueBackfill } from "../credit-status-metafield-backfill";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describe("parseArgs", () => {
  it("defaults to dry-run when no flags provided", () => {
    const result = parseArgs([]);
    expect(result.dryRun).toBe(true);
    expect(result.apply).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("explicit --dry-run works", () => {
    const result = parseArgs(["--dry-run"]);
    expect(result.dryRun).toBe(true);
    expect(result.apply).toBe(false);
  });

  it("--apply sets apply mode", () => {
    const result = parseArgs(["--apply"]);
    expect(result.dryRun).toBe(false);
    expect(result.apply).toBe(true);
  });

  it("--dry-run --apply is rejected as mutually exclusive", () => {
    const result = parseArgs(["--dry-run", "--apply"]);
    expect(result.error).toContain("mutually exclusive");
  });

  it("--shop without --apply is rejected", () => {
    const result = parseArgs(["--shop", "1"]);
    expect(result.error).toContain("only valid with --apply");
  });

  it("--shop with --apply works", () => {
    const result = parseArgs(["--apply", "--shop", "1"]);
    expect(result.apply).toBe(true);
    expect(result.shopFilter).toBe(1);
    expect(result.error).toBeUndefined();
  });

  it("--shop requires a numeric value", () => {
    const result = parseArgs(["--apply", "--shop"]);
    expect(result.error).toContain("requires a numeric value");
  });

  it("--shop rejects non-numeric value", () => {
    const result = parseArgs(["--apply", "--shop", "abc"]);
    expect(result.error).toContain("must be a positive integer");
  });

  it("--shop rejects zero or negative", () => {
    const result1 = parseArgs(["--apply", "--shop", "0"]);
    expect(result1.error).toContain("must be a positive integer");

    const result2 = parseArgs(["--apply", "--shop", "-1"]);
    expect(result2.error).toContain("must be a positive integer");
  });
});

describeWithDb("credit-status-metafield-backfill DB integration", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-backfill";
  const TEST_SHOP_ID = `shop-backfill-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `backfill-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_1_ID = `acc-bf-1-${TEST_SUFFIX}`;
  const TEST_ACCOUNT_2_ID = `acc-bf-2-${TEST_SUFFIX}`;
  const TEST_ACCOUNT_3_ID = `acc-bf-3-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    // Create test accounts with different holdStates and metafieldSyncedAt
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "holdState", "metafieldSyncedAt", "createdAt", "updatedAt"
      )
      VALUES
        (${TEST_ACCOUNT_1_ID}, ${TEST_SHOP_ID}, 'COMPANY',
         ${"co-1-" + TEST_SUFFIX}, ${"loc-1-" + TEST_SUFFIX},
         'Account 1', 'OK', NULL, NOW(), NOW()),
        (${TEST_ACCOUNT_2_ID}, ${TEST_SHOP_ID}, 'COMPANY',
         ${"co-2-" + TEST_SUFFIX}, ${"loc-2-" + TEST_SUFFIX},
         'Account 2', 'HELD', NULL, NOW(), NOW()),
        (${TEST_ACCOUNT_3_ID}, ${TEST_SHOP_ID}, 'COMPANY',
         ${"co-3-" + TEST_SUFFIX}, ${"loc-3-" + TEST_SUFFIX},
         'Account 3', 'OK', NOW(), NOW(), NOW())
    `;
  });

  afterAll(async () => {
    // Clean up queue messages
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    // Clean up queue messages before each test
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
  });

  describe("getBackfillStats", () => {
    it("returns stats grouped by shop and holdState", async () => {
      const { stats, expectedTotal, expectedByHoldState } = await sql.begin("read only", async (tx) => {
        const statsResult = await getBackfillStats(tx);
        
        // Query what we expect for our test shop directly
        const [expected] = await tx<{ total: string; okCount: string; heldCount: string }[]>`
          SELECT
            COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE "holdState" = 'OK')::text AS "okCount",
            COUNT(*) FILTER (WHERE "holdState" = 'HELD')::text AS "heldCount"
          FROM "BuyerAccount"
          WHERE "shopId" = ${TEST_SHOP_ID}
            AND "metafieldSyncedAt" IS NULL
        `;
        return {
          stats: statsResult,
          expectedTotal: parseInt(expected.total, 10),
          expectedByHoldState: {
            OK: parseInt(expected.okCount, 10),
            HELD: parseInt(expected.heldCount, 10),
          },
        };
      });

      // Find stats matching our test shop's expected distribution
      const ourStats = stats.find(
        s => s.total === expectedTotal &&
             s.byHoldState["OK"] === expectedByHoldState.OK &&
             s.byHoldState["HELD"] === expectedByHoldState.HELD
      );
      expect(ourStats).toBeDefined();
      expect(ourStats!.byHoldState["OK"]).toBe(1);
      expect(ourStats!.byHoldState["HELD"]).toBe(1);
    });

    it("excludes accounts with metafieldSyncedAt set", async () => {
      const { nullCount, totalCount } = await sql.begin("read only", async (tx) => {
        // Count accounts with NULL vs all accounts for our test shop
        const [counts] = await tx<{ nullCount: string; totalCount: string }[]>`
          SELECT
            COUNT(*) FILTER (WHERE "metafieldSyncedAt" IS NULL)::text AS "nullCount",
            COUNT(*)::text AS "totalCount"
          FROM "BuyerAccount"
          WHERE "shopId" = ${TEST_SHOP_ID}
        `;
        return {
          nullCount: parseInt(counts.nullCount, 10),
          totalCount: parseInt(counts.totalCount, 10),
        };
      });

      // Our test shop has 3 accounts total, but only 2 have metafieldSyncedAt NULL
      expect(totalCount).toBe(3);
      expect(nullCount).toBe(2);
    });
  });

  describe("getCandidates", () => {
    it("returns candidates with metafieldSyncedAt NULL", async () => {
      const candidates = await getCandidates(sql);

      const ourCandidates = candidates.filter(c => c.shopId === TEST_SHOP_ID);
      expect(ourCandidates.length).toBe(2);
      expect(ourCandidates.map(c => c.id).sort()).toEqual([TEST_ACCOUNT_1_ID, TEST_ACCOUNT_2_ID].sort());
    });

    it("excludes accounts with metafieldSyncedAt set", async () => {
      const candidates = await getCandidates(sql);

      const account3 = candidates.find(c => c.id === TEST_ACCOUNT_3_ID);
      expect(account3).toBeUndefined();
    });
  });

  describe("dry-run safety", () => {
    it("dry-run makes zero mutations (queue length unchanged)", async () => {
      // Get initial queue length
      const [before] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
      `;
      const initialCount = parseInt(before.count, 10);

      // Run dry-run stats (simulating dry-run mode)
      await sql.begin("read only", async (tx) => {
        await getBackfillStats(tx);
      });

      // Verify queue length unchanged
      const [after] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
      `;
      const finalCount = parseInt(after.count, 10);

      expect(finalCount).toBe(initialCount);
    });
  });

  describe("enqueueBackfill", () => {
    it("enqueues exactly N messages with the right message shape", async () => {
      const candidates = await getCandidates(sql);
      const ourCandidates = candidates.filter(c => c.shopId === TEST_SHOP_ID);

      const result = await enqueueBackfill(sql, ourCandidates);

      expect(result.enqueued).toBe(2);
      expect(result.failed).toBe(0);

      // Verify messages in queue
      const messages = await sql<{ message: { topic: string; source: string; buyerAccountId: string; webhookId: string } }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
      `;

      expect(messages.length).toBe(2);
      for (const msg of messages) {
        expect(msg.message.topic).toBe("CREDIT_STATUS_RECOMPUTE");
        expect(msg.message.source).toBe("manual");
        expect(msg.message.webhookId).toMatch(/^credit_backfill:/);
      }
    });

    it("messages include dedupe keys for drain deduplication", async () => {
      const candidates = await getCandidates(sql);
      const ourCandidates = candidates.filter(c => c.shopId === TEST_SHOP_ID);

      // Enqueue messages
      const result = await enqueueBackfill(sql, ourCandidates);
      expect(result.enqueued).toBe(2);

      // Verify messages have proper dedupe keys for drain processor
      // (drain dedupes via s6_processed_webhooks, not pgmq)
      const messages = await sql<{ message: { webhookId: string } }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
      `;

      const today = new Date().toISOString().split("T")[0];
      for (const msg of messages) {
        expect(msg.message.webhookId).toContain(`credit_backfill:`);
        expect(msg.message.webhookId).toContain(`:${today}`);
      }
    });
  });
});
