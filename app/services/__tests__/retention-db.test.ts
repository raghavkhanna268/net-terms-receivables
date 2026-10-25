/**
 * DB integration tests for access event retention purge.
 *
 * Tests:
 * - Only access.* events older than 365 days are deleted
 * - Financial events (match.*, invoice.*) are never deleted by the purge
 * - Look-alike types (access_x, accessibility.y) survive (not LIKE 'access.%')
 * - Younger access.* events (364 days) survive
 * - The DO block is idempotent (safe to run twice, with or without pg_cron)
 *
 * Requires a running PostgreSQL instance with pgmq.
 * Run with: TEST_DATABASE_URL=postgresql://... npm test -- retention-db
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import {
  ACCESS_EVENT_PURGE_JOB,
  ACCESS_EVENT_PURGE_SCHEDULE,
  ACCESS_EVENT_PURGE_SQL,
} from "../retention.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("access event retention purge (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-retention";

  const SHOP_A_ID = `shop-a-${TEST_SUFFIX}`;
  const SHOP_A_DOMAIN = `shop-a-${TEST_SUFFIX}.example.com`;

  const SHOP_B_ID = `shop-b-${TEST_SUFFIX}`;
  const SHOP_B_DOMAIN = `shop-b-${TEST_SUFFIX}.example.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_A_ID}, ${SHOP_A_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_B_ID}, ${SHOP_B_DOMAIN}, 'INR', NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "Shop" WHERE id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
  });

  describe("purge deletes only old access.* events", () => {
    it("deletes 366-day-old access.* events, keeps 364-day-old and non-access types", async () => {
      const now = new Date();
      const days366Ago = new Date(now.getTime() - 366 * 24 * 60 * 60 * 1000);
      const days364Ago = new Date(now.getTime() - 364 * 24 * 60 * 60 * 1000);
      const days400Ago = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000);

      // Shop A: access.* events at different ages
      await sql`
        INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
        VALUES
          (gen_random_uuid(), ${SHOP_A_ID}, 'user-1', 'access.dashboard', '{"recordType":"BuyerAccount"}', ${days366Ago}),
          (gen_random_uuid(), ${SHOP_A_ID}, 'user-1', 'access.imports', '{"recordType":"BankImport"}', ${days366Ago}),
          (gen_random_uuid(), ${SHOP_A_ID}, 'user-2', 'access.dashboard', '{"recordType":"BuyerAccount"}', ${days364Ago}),
          (gen_random_uuid(), ${SHOP_A_ID}, 'user-2', 'access.imports', '{"recordType":"BankImport"}', ${days364Ago})
      `;

      // Shop B: access.* events at different ages
      await sql`
        INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
        VALUES
          (gen_random_uuid(), ${SHOP_B_ID}, 'user-3', 'access.dashboard', '{"recordType":"BuyerAccount"}', ${days366Ago}),
          (gen_random_uuid(), ${SHOP_B_ID}, 'user-3', 'access.accounts_detail', '{"recordType":"BuyerAccount","recordId":"acc-1"}', ${days366Ago}),
          (gen_random_uuid(), ${SHOP_B_ID}, 'user-4', 'access.reconcile', '{"recordType":"Payment","count":5}', ${days364Ago})
      `;

      // Shop A: Financial events at 400 days (should survive)
      await sql`
        INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
        VALUES
          (gen_random_uuid(), ${SHOP_A_ID}, 'system', 'match.applied', '{"matchId":"m1"}', ${days400Ago}),
          (gen_random_uuid(), ${SHOP_A_ID}, 'system', 'invoice.paid', '{"invoiceId":"inv1"}', ${days400Ago})
      `;

      // Shop B: Financial events at 400 days (should survive)
      await sql`
        INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
        VALUES
          (gen_random_uuid(), ${SHOP_B_ID}, 'system', 'match.confirmed', '{"matchId":"m2"}', ${days400Ago}),
          (gen_random_uuid(), ${SHOP_B_ID}, 'system', 'match.unmatched', '{"matchId":"m3"}', ${days400Ago})
      `;

      // Shop A: Look-alike types at 400 days (should survive - not LIKE 'access.%')
      await sql`
        INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
        VALUES
          (gen_random_uuid(), ${SHOP_A_ID}, 'system', 'access_x', '{"note":"lookalike1"}', ${days400Ago}),
          (gen_random_uuid(), ${SHOP_B_ID}, 'system', 'accessibility.y', '{"note":"lookalike2"}', ${days400Ago})
      `;

      // Count before purge
      const beforeCounts = await sql<{ type: string; cnt: string }[]>`
        SELECT type, COUNT(*)::text as cnt
        FROM "AuditEvent"
        WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})
        GROUP BY type
        ORDER BY type
      `;

      const beforeMap = new Map(beforeCounts.map((r) => [r.type, parseInt(r.cnt, 10)]));

      // Verify we have the expected rows before purge
      expect(beforeMap.get("access.dashboard")).toBe(3); // 2 at 366d (A), 1 at 364d (A)
      expect(beforeMap.get("access.imports")).toBe(2); // 1 at 366d (A), 1 at 364d (A)
      expect(beforeMap.get("access.accounts_detail")).toBe(1); // 1 at 366d (B)
      expect(beforeMap.get("access.reconcile")).toBe(1); // 1 at 364d (B)
      expect(beforeMap.get("match.applied")).toBe(1);
      expect(beforeMap.get("invoice.paid")).toBe(1);
      expect(beforeMap.get("match.confirmed")).toBe(1);
      expect(beforeMap.get("match.unmatched")).toBe(1);
      expect(beforeMap.get("access_x")).toBe(1);
      expect(beforeMap.get("accessibility.y")).toBe(1);

      // Run the purge SQL
      await sql.unsafe(ACCESS_EVENT_PURGE_SQL);

      // Count after purge
      const afterCounts = await sql<{ type: string; cnt: string }[]>`
        SELECT type, COUNT(*)::text as cnt
        FROM "AuditEvent"
        WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})
        GROUP BY type
        ORDER BY type
      `;

      const afterMap = new Map(afterCounts.map((r) => [r.type, parseInt(r.cnt, 10)]));

      // 366-day access.* events should be deleted
      // Only 364-day access.* events should remain
      expect(afterMap.get("access.dashboard")).toBe(1); // Only the 364d one (A)
      expect(afterMap.get("access.imports")).toBe(1); // Only the 364d one (A)
      expect(afterMap.get("access.accounts_detail")).toBeUndefined(); // Was 366d (B), deleted
      expect(afterMap.get("access.reconcile")).toBe(1); // Was 364d (B), survives

      // Financial events should all survive
      expect(afterMap.get("match.applied")).toBe(1);
      expect(afterMap.get("invoice.paid")).toBe(1);
      expect(afterMap.get("match.confirmed")).toBe(1);
      expect(afterMap.get("match.unmatched")).toBe(1);

      // Look-alike types should survive
      expect(afterMap.get("access_x")).toBe(1);
      expect(afterMap.get("accessibility.y")).toBe(1);
    });

    it("purge is idempotent (running twice deletes nothing extra)", async () => {
      const now = new Date();
      const days366Ago = new Date(now.getTime() - 366 * 24 * 60 * 60 * 1000);
      const days364Ago = new Date(now.getTime() - 364 * 24 * 60 * 60 * 1000);

      await sql`
        INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
        VALUES
          (gen_random_uuid(), ${SHOP_A_ID}, 'user-1', 'access.dashboard', '{"recordType":"BuyerAccount"}', ${days366Ago}),
          (gen_random_uuid(), ${SHOP_A_ID}, 'user-2', 'access.dashboard', '{"recordType":"BuyerAccount"}', ${days364Ago})
      `;

      // First purge
      await sql.unsafe(ACCESS_EVENT_PURGE_SQL);

      const countAfterFirst = await sql<{ cnt: string }[]>`
        SELECT COUNT(*)::text as cnt
        FROM "AuditEvent"
        WHERE "shopId" = ${SHOP_A_ID}
      `;
      expect(parseInt(countAfterFirst[0].cnt, 10)).toBe(1);

      // Second purge (should not delete anything more)
      await sql.unsafe(ACCESS_EVENT_PURGE_SQL);

      const countAfterSecond = await sql<{ cnt: string }[]>`
        SELECT COUNT(*)::text as cnt
        FROM "AuditEvent"
        WHERE "shopId" = ${SHOP_A_ID}
      `;
      expect(parseInt(countAfterSecond[0].cnt, 10)).toBe(1);
    });
  });

  describe("migration DO block idempotency", () => {
    it("DO block is safe to run twice when pg_cron is NOT present", async () => {
      // The DO block checks for pg_cron extension and only schedules if present
      // When pg_cron is not present, it should be a no-op
      const doBlock = `
        DO $do$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
            PERFORM cron.schedule(
              '${ACCESS_EVENT_PURGE_JOB}',
              '${ACCESS_EVENT_PURGE_SCHEDULE}',
              $job$${ACCESS_EVENT_PURGE_SQL}$job$
            );
          END IF;
        END$do$;
      `;

      // Check if pg_cron is present
      const [extCheck] = await sql<{ exists: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') as exists
      `;

      // Run DO block twice - should not throw
      await sql.unsafe(doBlock);
      await sql.unsafe(doBlock);

      if (extCheck.exists) {
        // If pg_cron is present, verify job was scheduled (or already exists)
        const jobs = await sql<{ jobname: string }[]>`
          SELECT jobname FROM cron.job WHERE jobname = ${ACCESS_EVENT_PURGE_JOB}
        `;
        expect(jobs.length).toBeGreaterThanOrEqual(1);
      }
      // If pg_cron is not present, the test passes by not throwing
    });

    it("DO block is safe to run twice when pg_cron IS present", async () => {
      // Check if pg_cron is present
      const [extCheck] = await sql<{ exists: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') as exists
      `;

      if (!extCheck.exists) {
        // Skip this test if pg_cron is not present
        return;
      }

      // Clean up any existing job first
      await sql`SELECT cron.unschedule(${ACCESS_EVENT_PURGE_JOB})`.catch(() => {
        // Ignore if job doesn't exist
      });

      const doBlock = `
        DO $do$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
            PERFORM cron.schedule(
              '${ACCESS_EVENT_PURGE_JOB}',
              '${ACCESS_EVENT_PURGE_SCHEDULE}',
              $job$${ACCESS_EVENT_PURGE_SQL}$job$
            );
          END IF;
        END$do$;
      `;

      // First run - should create job
      await sql.unsafe(doBlock);

      const jobsAfterFirst = await sql<{ jobname: string }[]>`
        SELECT jobname FROM cron.job WHERE jobname = ${ACCESS_EVENT_PURGE_JOB}
      `;
      expect(jobsAfterFirst.length).toBe(1);

      // Second run - cron.schedule with same name updates existing job
      // This should not throw and should not create duplicates
      await sql.unsafe(doBlock);

      const jobsAfterSecond = await sql<{ jobname: string }[]>`
        SELECT jobname FROM cron.job WHERE jobname = ${ACCESS_EVENT_PURGE_JOB}
      `;
      expect(jobsAfterSecond.length).toBe(1);

      // Clean up
      await sql`SELECT cron.unschedule(${ACCESS_EVENT_PURGE_JOB})`.catch(() => {
        // Ignore if job doesn't exist
      });
    });
  });

  describe("constants match migration", () => {
    it("ACCESS_EVENT_PURGE_JOB is the expected value", () => {
      expect(ACCESS_EVENT_PURGE_JOB).toBe("audit_purge_access_events_365d");
    });

    it("ACCESS_EVENT_PURGE_SCHEDULE is daily at 03:30 UTC", () => {
      expect(ACCESS_EVENT_PURGE_SCHEDULE).toBe("30 3 * * *");
    });

    it("ACCESS_EVENT_PURGE_SQL targets only access.* types older than 365 days", () => {
      expect(ACCESS_EVENT_PURGE_SQL).toContain("LIKE 'access.%'");
      expect(ACCESS_EVENT_PURGE_SQL).toContain("INTERVAL '365 days'");
      expect(ACCESS_EVENT_PURGE_SQL).toContain('DELETE FROM "AuditEvent"');
    });
  });
});
