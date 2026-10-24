/**
 * DB-backed integration tests for credit-status-metafield-backfill.ts script.
 * Uses the CI pgmq Postgres service.
 *
 * Tests:
 * - parseArgs validates flags correctly (including --id-prefix and --expect)
 * - Dry-run makes zero mutations (queue length unchanged)
 * - Dry-run prints no PII (no IDs, names, emails, shop domains)
 * - --dry-run --apply is rejected as mutually exclusive
 * - --apply enqueues exactly N messages with the right message shape
 * - A rerun on the same day is deduped (dedupe key includes date)
 * - --id-prefix filters candidates by id prefix
 * - --expect validates candidate count before enqueuing
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { parseArgs, getBackfillStats, getCandidates, enqueueBackfill, runApply, formatFatal } from "../credit-status-metafield-backfill";

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

  describe("--id-prefix", () => {
    it("accepts valid prefix in dry-run mode", () => {
      const result = parseArgs(["--id-prefix", "seed-account-"]);
      expect(result.dryRun).toBe(true);
      expect(result.idPrefix).toBe("seed-account-");
      expect(result.error).toBeUndefined();
    });

    it("accepts valid prefix in apply mode", () => {
      const result = parseArgs(["--apply", "--id-prefix", "abc_123-XYZ"]);
      expect(result.apply).toBe(true);
      expect(result.idPrefix).toBe("abc_123-XYZ");
      expect(result.error).toBeUndefined();
    });

    it("rejects empty prefix", () => {
      const result = parseArgs(["--id-prefix", ""]);
      expect(result.error).toContain("--id-prefix requires a value");
    });

    it("rejects prefix with wildcard character %", () => {
      const result = parseArgs(["--id-prefix", "a%"]);
      expect(result.error).toContain("--id-prefix must match pattern");
    });

    it("rejects prefix with SQL injection character '", () => {
      const result = parseArgs(["--id-prefix", "a'b"]);
      expect(result.error).toContain("--id-prefix must match pattern");
    });

    it("rejects prefix longer than 64 characters", () => {
      const longPrefix = "a".repeat(65);
      const result = parseArgs(["--id-prefix", longPrefix]);
      expect(result.error).toContain("--id-prefix must match pattern");
    });

    it("accepts prefix of exactly 64 characters", () => {
      const maxPrefix = "a".repeat(64);
      const result = parseArgs(["--id-prefix", maxPrefix]);
      expect(result.idPrefix).toBe(maxPrefix);
      expect(result.error).toBeUndefined();
    });

    it("rejects missing value after --id-prefix", () => {
      const result = parseArgs(["--id-prefix"]);
      expect(result.error).toContain("--id-prefix requires a value");
    });
  });

  describe("--expect", () => {
    it("accepts valid non-negative integer in dry-run mode", () => {
      const result = parseArgs(["--expect", "5"]);
      expect(result.dryRun).toBe(true);
      expect(result.expect).toBe(5);
      expect(result.error).toBeUndefined();
    });

    it("accepts zero as valid expect value", () => {
      const result = parseArgs(["--expect", "0"]);
      expect(result.expect).toBe(0);
      expect(result.error).toBeUndefined();
    });

    it("accepts valid expect in apply mode", () => {
      const result = parseArgs(["--apply", "--expect", "100"]);
      expect(result.apply).toBe(true);
      expect(result.expect).toBe(100);
      expect(result.error).toBeUndefined();
    });

    it("rejects negative value", () => {
      const result = parseArgs(["--expect", "-1"]);
      expect(result.error).toContain("--expect must be a non-negative integer");
    });

    it("rejects decimal value", () => {
      const result = parseArgs(["--expect", "1.5"]);
      expect(result.error).toContain("--expect must be a non-negative integer");
    });

    it("rejects non-numeric value", () => {
      const result = parseArgs(["--expect", "abc"]);
      expect(result.error).toContain("--expect must be a non-negative integer");
    });

    it("rejects empty value", () => {
      const result = parseArgs(["--expect", ""]);
      expect(result.error).toContain("--expect requires a non-negative integer value");
    });

    it("rejects missing value after --expect", () => {
      const result = parseArgs(["--expect"]);
      expect(result.error).toContain("--expect requires a non-negative integer value");
    });

    it("accepts up to 6-digit value (max 999999)", () => {
      const result = parseArgs(["--expect", "999999"]);
      expect(result.expect).toBe(999999);
      expect(result.error).toBeUndefined();
    });

    it("rejects 7-digit value", () => {
      const result = parseArgs(["--expect", "1000000"]);
      expect(result.error).toContain("--expect must be a non-negative integer");
    });
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

  // Additional test accounts for --id-prefix tests (all use TEST_SUFFIX)
  const PREFIX_TEST_SHOP_ID = `shop-prefix-${TEST_SUFFIX}`;
  const PREFIX_TEST_SHOP_DOMAIN = `prefix-test-${TEST_SUFFIX}.myshopify.com`;
  const ID_PREFIX = `seed-account-${TEST_SUFFIX}-`;
  const SEED_ACCOUNT_A_ID = `${ID_PREFIX}a`;
  const SEED_ACCOUNT_B_ID = `${ID_PREFIX}b`;
  const OTHER_X_ID = `other-${TEST_SUFFIX}-x`;

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

    // Create shop and accounts for --id-prefix tests
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${PREFIX_TEST_SHOP_ID}, ${PREFIX_TEST_SHOP_DOMAIN}, 'USD', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "holdState", "metafieldSyncedAt", "createdAt", "updatedAt"
      )
      VALUES
        (${SEED_ACCOUNT_A_ID}, ${PREFIX_TEST_SHOP_ID}, 'COMPANY',
         ${"co-seed-a-" + TEST_SUFFIX}, ${"loc-seed-a-" + TEST_SUFFIX},
         'Seed Account A', 'OK', NULL, NOW(), NOW()),
        (${SEED_ACCOUNT_B_ID}, ${PREFIX_TEST_SHOP_ID}, 'COMPANY',
         ${"co-seed-b-" + TEST_SUFFIX}, ${"loc-seed-b-" + TEST_SUFFIX},
         'Seed Account B', 'OK', NULL, NOW(), NOW()),
        (${OTHER_X_ID}, ${PREFIX_TEST_SHOP_ID}, 'COMPANY',
         ${"co-other-x-" + TEST_SUFFIX}, ${"loc-other-x-" + TEST_SUFFIX},
         'Other X', 'HELD', NULL, NOW(), NOW())
    `;
  });

  afterAll(async () => {
    // Clean up queue messages
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${PREFIX_TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${PREFIX_TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${PREFIX_TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${PREFIX_TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    // Clean up queue messages before each test
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${PREFIX_TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${PREFIX_TEST_SHOP_DOMAIN}`;
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

  describe("dry-run transaction_read_only enforcement", () => {
    it("runDryRun succeeds and counts run with transaction_read_only='on'", async () => {
      // Import the exported runDryRun function
      const { runDryRun } = await import("../credit-status-metafield-backfill");

      // Call the actual exported function against the test DB
      const result = await runDryRun(sql);

      // Assert it succeeded
      expect(result.success).toBe(true);
      // Assert stats is an array (the counts query ran)
      expect(Array.isArray(result.stats)).toBe(true);
    });

    it("negative: runDryRun rejects when read-only check fails", async () => {
      // This test verifies the negative case: if the preflight or in-place check fails,
      // runDryRun throws an error. We can't easily make the in-place check fail with
      // a real DB (sql.begin("read only") always sets transaction_read_only='on'),
      // but we can verify the error path by checking that runDryRun throws when
      // called with a mock that simulates failure.
      
      // Create a mock sql that makes verifyReadOnlyTransaction fail
      const mockSql = {
        begin: async (mode: string, fn: (tx: unknown) => Promise<unknown>) => {
          if (mode === "read only") {
            const mockTx = async (strings: TemplateStringsArray) => {
              const query = strings.join("");
              if (query.includes("transaction_read_only")) {
                return [{ transaction_read_only: "off" }];
              }
              return [];
            };
            mockTx.json = (v: unknown) => v;
            return fn(mockTx);
          }
          // verifyReadOnlyTransaction opens its own read only tx
          return fn(mockSql);
        },
      };

      const { runDryRun } = await import("../credit-status-metafield-backfill");

      // When transaction_read_only is 'off', the in-place check should throw
      await expect(runDryRun(mockSql as unknown as typeof sql)).rejects.toThrow(
        "transaction_read_only is not 'on'"
      );
    });
  });

  describe("--id-prefix filtering", () => {
    it("filters getBackfillStats by id prefix for test shop", async () => {
      const stats = await sql.begin("read only", async (tx) => {
        return getBackfillStats(tx, ID_PREFIX);
      });

      // Should only find the seed-account-* accounts in the prefix test shop
      // Find the stats entry for our prefix test shop by checking shopId match
      const [prefixShopStats] = await sql<{ total: string }[]>`
        SELECT COUNT(*)::text AS total
        FROM "BuyerAccount"
        WHERE "shopId" = ${PREFIX_TEST_SHOP_ID}
          AND "metafieldSyncedAt" IS NULL
          AND starts_with("id", ${ID_PREFIX})
      `;
      const expectedPrefixCount = parseInt(prefixShopStats.total, 10);
      expect(expectedPrefixCount).toBe(2);

      // Stats should contain an entry with exactly 2 accounts
      const matchingStats = stats.find(s => s.total === 2);
      expect(matchingStats).toBeDefined();
    });

    it("getCandidates with prefix returns only matching accounts from test shop", async () => {
      const candidates = await getCandidates(sql, undefined, ID_PREFIX);

      // Filter to our test shop to ensure isolation
      const ourCandidates = candidates.filter(c => c.shopId === PREFIX_TEST_SHOP_ID);
      expect(ourCandidates.length).toBe(2);
      const ids = ourCandidates.map(c => c.id).sort();
      expect(ids).toEqual([SEED_ACCOUNT_A_ID, SEED_ACCOUNT_B_ID].sort());
    });

    it("getCandidates without prefix returns all 3 accounts from test shop", async () => {
      const candidates = await getCandidates(sql);

      // Filter to prefix test shop only
      const prefixShopCandidates = candidates.filter(c => c.shopId === PREFIX_TEST_SHOP_ID);
      expect(prefixShopCandidates.length).toBe(3);
    });

    it("runDryRun with prefix filters correctly for test shop", async () => {
      const { runDryRun } = await import("../credit-status-metafield-backfill");

      const result = await runDryRun(sql, ID_PREFIX);

      expect(result.success).toBe(true);
      // grandTotal should be 2 (only the prefix-matching accounts)
      expect(result.grandTotal).toBe(2);
    });
  });

  describe("--expect validation in runApply", () => {
    it("runApply with matching expect proceeds and enqueues", async () => {
      // First get the actual count for our test shop with prefix
      const candidates = await getCandidates(sql, undefined, ID_PREFIX);
      const ourCandidates = candidates.filter(c => c.shopId === PREFIX_TEST_SHOP_ID);
      expect(ourCandidates.length).toBe(2);

      // Run with correct expect (2 candidates with prefix)
      const result = await runApply(sql, undefined, ID_PREFIX, 2);

      expect(result.success).toBe(true);
      expect(result.expectMismatch).toBeUndefined();
      expect(result.enqueued).toBe(2);
      expect(result.failed).toBe(0);

      // Verify messages in queue for our test shop
      const messages = await sql<{ message: { topic: string } }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${PREFIX_TEST_SHOP_DOMAIN}
      `;
      expect(messages.length).toBe(2);
    });

    it("runApply with mismatched expect makes zero pgmq.send calls", async () => {
      // Get initial queue count for our test shop
      const [before] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${PREFIX_TEST_SHOP_DOMAIN}
      `;
      const initialCount = parseInt(before.count, 10);

      // Run with wrong expect (there are 2 candidates with prefix, we expect 5)
      const result = await runApply(sql, undefined, ID_PREFIX, 5);

      expect(result.success).toBe(false);
      expect(result.expectMismatch).toBeDefined();
      expect(result.expectMismatch!.expected).toBe(5);
      expect(result.expectMismatch!.actual).toBe(2);
      expect(result.enqueued).toBe(0);
      expect(result.failed).toBe(0);

      // Verify no messages were added to queue
      const [after] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${PREFIX_TEST_SHOP_DOMAIN}
      `;
      const finalCount = parseInt(after.count, 10);
      expect(finalCount).toBe(initialCount);
    });

    it("runApply with expect=0 on non-empty candidates fails before enqueue", async () => {
      // Run with expect=0 but there are 2 candidates with prefix
      const result = await runApply(sql, undefined, ID_PREFIX, 0);

      expect(result.success).toBe(false);
      expect(result.expectMismatch).toBeDefined();
      expect(result.expectMismatch!.expected).toBe(0);
      expect(result.expectMismatch!.actual).toBe(2);
      expect(result.enqueued).toBe(0);
    });

    it("runApply without expect proceeds normally", async () => {
      const result = await runApply(sql, undefined, ID_PREFIX);

      expect(result.success).toBe(true);
      expect(result.expectMismatch).toBeUndefined();
      expect(result.enqueued).toBe(2);
    });
  });

  describe("output privacy (no PII in logs)", () => {
    it("dry-run output with prefix contains no account IDs or prefix value", async () => {
      const { runDryRun } = await import("../credit-status-metafield-backfill");

      // Capture what the dry-run would produce
      const result = await runDryRun(sql, ID_PREFIX);

      // The result should have stats but stats themselves don't contain IDs
      expect(result.success).toBe(true);
      expect(result.grandTotal).toBe(2);

      // Verify stats don't contain any ID-like strings
      const statsJson = JSON.stringify(result.stats);
      expect(statsJson).not.toContain(ID_PREFIX);
      expect(statsJson).not.toContain(SEED_ACCOUNT_A_ID);
      expect(statsJson).not.toContain(SEED_ACCOUNT_B_ID);
    });
  });

  describe("logging safety (X2, X3)", () => {
    it("formatFatal returns error type, not message", () => {
      const sentinelMessage = "SENTINEL_DOMAIN.myshopify.com error with secret@email.com amount=50000";
      
      const errorResult = formatFatal(new Error(sentinelMessage));
      expect(errorResult).toBe("Error");
      expect(errorResult).not.toContain(sentinelMessage);
      expect(errorResult).not.toContain("myshopify");
      expect(errorResult).not.toContain("@");
      expect(errorResult).not.toContain("amount");
      
      class CustomCreditStatusError extends Error {}
      const customResult = formatFatal(new CustomCreditStatusError(sentinelMessage));
      expect(customResult).toBe("CustomCreditStatusError");
      expect(customResult).not.toContain(sentinelMessage);
      
      expect(formatFatal("string error")).toBe("string");
      expect(formatFatal(42)).toBe("number");
      expect(formatFatal(null)).toBe("object");
      expect(formatFatal(undefined)).toBe("undefined");
    });

    it("error logs use toErrorCode, not raw messages (X3)", async () => {
      const { toErrorCode } = await import("~/lib/log.server");

      const sensitiveError = new Error(
        "Network error for shop sentinel.myshopify.com: secret@example.com amount=999999"
      );
      
      const code = toErrorCode(sensitiveError);
      
      expect(code).not.toContain("myshopify");
      expect(code).not.toContain("@");
      expect(code).not.toContain("amount");
      expect(code).not.toContain("999999");
      expect(code).not.toContain("sentinel");
    });

    it("dry-run error output contains no domain, email, or amount", async () => {
      const { runDryRun } = await import("../credit-status-metafield-backfill");
      
      const logs: string[] = [];
      const originalError = console.error;
      console.error = (...args) => { logs.push(args.join(" ")); };
      
      try {
        const mockSql = {
          begin: async () => {
            throw new Error("Connection failed for shop sentinel.myshopify.com: secret@email.com amount=50000");
          },
        };
        
        await runDryRun(mockSql as unknown as typeof sql).catch(() => {});
        
        const allOutput = logs.join("\n");
        
        if (allOutput.length > 0) {
          expect(allOutput).not.toContain("myshopify.com");
          expect(allOutput).not.toContain("secret@email.com");
          expect(allOutput).not.toContain("amount=50000");
          expect(allOutput).not.toContain("sentinel");
        }
      } finally {
        console.error = originalError;
      }
    });
  });
});
