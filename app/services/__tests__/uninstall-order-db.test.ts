/**
 * DB tests for markUninstalledAndDeleteSessions (#258).
 *
 * Verifies the atomic ordering guarantee: uninstalledAt is set in the same
 * transaction as session deletion, closing the window where the drain could
 * see no_session while the Shop row still looks installed.
 *
 * Tests:
 * - Both writes commit together
 * - Failure during session DELETE rolls back both (trigger-based injection)
 * - Duplicate delivery keeps the FIRST uninstalledAt (COALESCE)
 * - Shop row missing: sessions are still deleted
 * - Helper blocks while Shop row is locked by FOR SHARE (drain guard lock)
 * - Helper serializes with deleteShop's FOR UPDATE (deterministic lock detection)
 * - Reinstall scenario: afterAuth clears uninstalledAt and creates new session
 * - KNOWN-GAP: late uninstall after reinstall deletes fresh session
 *
 * NOTE: This test requires a running PostgreSQL instance.
 * Run in the "Sequential DB" vitest project.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const TEST_SUFFIX = `uninstall_order_${Date.now()}`;
const TEST_SHOP_DOMAIN = `test-${TEST_SUFFIX}.myshopify.com`;
const TEST_SESSION_ID = `offline_${TEST_SHOP_DOMAIN}`;

async function waitForBlocking(
  sql: ReturnType<typeof postgres>,
  blockedPid: number,
  blockerPid: number,
  deadlineMs: number = 10000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const [result] = await sql<[{ blocking_pids: number[] }]>`
      SELECT pg_blocking_pids(${blockedPid}) as blocking_pids
    `;
    if (result.blocking_pids.includes(blockerPid)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `Timeout: pid ${blockedPid} was not blocked by pid ${blockerPid} within ${deadlineMs}ms`
  );
}

function isPromiseSettled<T>(p: Promise<T>): Promise<boolean> {
  return Promise.race([
    p.then(() => true, () => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 0)),
  ]);
}

describeWithDb("markUninstalledAndDeleteSessions (DB)", () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    await sql`SELECT 1`;
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM "Session" WHERE shop LIKE ${'test-uninstall_order_%'}`;
    await sql`DELETE FROM "Shop" WHERE domain LIKE ${'test-uninstall_order_%'}`;

    await sql`
      INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'UTC', 'INR', 'free', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken", scope)
      VALUES (${TEST_SESSION_ID}, ${TEST_SHOP_DOMAIN}, 'test-state', false, 'test-token', 'read_products')
    `;
  });

  it("both writes commit together", async () => {
    const { markUninstalledAndDeleteSessions } = await import("../compliance/compliance.server");

    const result = await markUninstalledAndDeleteSessions(sql, TEST_SHOP_DOMAIN);

    expect(result.shopFound).toBe(true);
    expect(result.sessionsDeleted).toBe(1);

    const [shop] = await sql<{ uninstalledAt: Date | null }[]>`
      SELECT "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
    `;
    expect(shop.uninstalledAt).not.toBeNull();

    const sessions = await sql<{ id: string }[]>`
      SELECT id FROM "Session" WHERE shop = ${TEST_SHOP_DOMAIN}
    `;
    expect(sessions.length).toBe(0);
  });

  it("failure during session DELETE rolls back uninstalledAt (atomic guarantee)", async () => {
    const { markUninstalledAndDeleteSessions } = await import("../compliance/compliance.server");

    const triggerFnName = `block_session_delete_${TEST_SUFFIX}`;
    const triggerName = `trg_block_session_delete_${TEST_SUFFIX}`;

    try {
      await sql`
        CREATE OR REPLACE FUNCTION ${sql(triggerFnName)}()
        RETURNS TRIGGER AS $$
        BEGIN
          IF OLD.shop LIKE 'test-uninstall_order_%' THEN
            RAISE EXCEPTION 'Simulated session delete failure for test';
          END IF;
          RETURN OLD;
        END;
        $$ LANGUAGE plpgsql
      `;

      await sql`
        CREATE TRIGGER ${sql(triggerName)}
        BEFORE DELETE ON "Session"
        FOR EACH ROW
        EXECUTE FUNCTION ${sql(triggerFnName)}()
      `;

      await expect(
        markUninstalledAndDeleteSessions(sql, TEST_SHOP_DOMAIN)
      ).rejects.toThrow("Simulated session delete failure for test");

      const [shop] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
      `;
      expect(shop.uninstalledAt).toBeNull();

      const sessions = await sql<{ id: string }[]>`
        SELECT id FROM "Session" WHERE shop = ${TEST_SHOP_DOMAIN}
      `;
      expect(sessions.length).toBe(1);
    } finally {
      await sql`DROP TRIGGER IF EXISTS ${sql(triggerName)} ON "Session"`;
      await sql`DROP FUNCTION IF EXISTS ${sql(triggerFnName)}()`;
    }
  });

  it("duplicate delivery keeps the FIRST uninstalledAt (COALESCE)", async () => {
    const { markUninstalledAndDeleteSessions } = await import("../compliance/compliance.server");

    const result1 = await markUninstalledAndDeleteSessions(sql, TEST_SHOP_DOMAIN);
    expect(result1.shopFound).toBe(true);

    const [afterFirst] = await sql<{ uninstalledAt: Date }[]>`
      SELECT "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
    `;
    const firstTimestamp = afterFirst.uninstalledAt;

    await new Promise((r) => setTimeout(r, 50));

    const result2 = await markUninstalledAndDeleteSessions(sql, TEST_SHOP_DOMAIN);
    expect(result2.shopFound).toBe(true);
    expect(result2.sessionsDeleted).toBe(0);

    const [afterSecond] = await sql<{ uninstalledAt: Date }[]>`
      SELECT "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
    `;

    expect(afterSecond.uninstalledAt.getTime()).toBe(firstTimestamp.getTime());
  });

  it("shop row missing: sessions are still deleted", async () => {
    const { markUninstalledAndDeleteSessions } = await import("../compliance/compliance.server");

    await sql`DELETE FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}`;

    const sessions1 = await sql<{ id: string }[]>`
      SELECT id FROM "Session" WHERE shop = ${TEST_SHOP_DOMAIN}
    `;
    expect(sessions1.length).toBe(1);

    const result = await markUninstalledAndDeleteSessions(sql, TEST_SHOP_DOMAIN);

    expect(result.shopFound).toBe(false);
    expect(result.sessionsDeleted).toBe(1);

    const sessions2 = await sql<{ id: string }[]>`
      SELECT id FROM "Session" WHERE shop = ${TEST_SHOP_DOMAIN}
    `;
    expect(sessions2.length).toBe(0);
  });

  it("helper blocks while Shop row is locked by FOR SHARE (drain guard lock)", async () => {
    const { markUninstalledAndDeleteSessions } = await import("../compliance/compliance.server");

    const connA = postgres(TEST_DATABASE_URL!, { ...sqlOptions, max: 1 });
    const connB = postgres(TEST_DATABASE_URL!, { ...sqlOptions, max: 1 });

    let releaseGate: () => void = () => {};

    try {
      const gatePromise = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });

      const [{ pid: pidA }] = await connA<[{ pid: number }]>`SELECT pg_backend_pid() as pid`;
      const [{ pid: pidB }] = await connB<[{ pid: number }]>`SELECT pg_backend_pid() as pid`;

      let lockAcquired = false;
      const connATransaction = connA.begin(async (txA) => {
        await txA`
          SELECT id FROM "Shop"
          WHERE domain = ${TEST_SHOP_DOMAIN}
          FOR SHARE
        `;
        lockAcquired = true;

        await gatePromise;
      });

      const lockDeadline = Date.now() + 10000;
      while (!lockAcquired) {
        if (Date.now() > lockDeadline) {
          throw new Error("Timeout: connA did not acquire FOR SHARE lock within 10s");
        }
        await new Promise((r) => setTimeout(r, 5));
      }

      const helperPromise = markUninstalledAndDeleteSessions(connB, TEST_SHOP_DOMAIN);

      await waitForBlocking(sql, pidB, pidA);

      const settled = await isPromiseSettled(helperPromise);
      expect(settled).toBe(false);

      releaseGate();
      await connATransaction;

      const helperResult = await helperPromise;
      expect(helperResult.shopFound).toBe(true);
      expect(helperResult.sessionsDeleted).toBe(1);

      const [shop] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
      `;
      expect(shop.uninstalledAt).not.toBeNull();

      const sessions = await sql<{ id: string }[]>`
        SELECT id FROM "Session" WHERE shop = ${TEST_SHOP_DOMAIN}
      `;
      expect(sessions.length).toBe(0);
    } finally {
      releaseGate();
      await connA.end();
      await connB.end();
    }
  });

  it("helper serializes with deleteShop's FOR UPDATE (deterministic lock detection)", async () => {
    const { markUninstalledAndDeleteSessions } = await import("../compliance/compliance.server");
    const { deleteShop } = await import("../compliance/compliance.server");

    const gate = postgres(TEST_DATABASE_URL!, { ...sqlOptions, max: 1 });
    const connA = postgres(TEST_DATABASE_URL!, { ...sqlOptions, max: 1 });
    const connB = postgres(TEST_DATABASE_URL!, { ...sqlOptions, max: 1 });

    const triggerFnName = `hold_shop_delete_${TEST_SUFFIX}`;
    const triggerName = `trg_hold_shop_delete_${TEST_SUFFIX}`;

    await sql`
      UPDATE "Shop"
      SET "uninstalledAt" = NOW() - INTERVAL '49 hours'
      WHERE domain = ${TEST_SHOP_DOMAIN}
    `;

    try {
      await sql`
        CREATE OR REPLACE FUNCTION ${sql(triggerFnName)}()
        RETURNS TRIGGER AS $$
        BEGIN
          IF OLD.domain LIKE 'test-uninstall_order_%' THEN
            -- Acquire then release: blocks until gate session releases the lock
            PERFORM pg_advisory_lock(hashtext(OLD.domain));
            PERFORM pg_advisory_unlock(hashtext(OLD.domain));
          END IF;
          RETURN OLD;
        END;
        $$ LANGUAGE plpgsql
      `;

      await sql`
        CREATE TRIGGER ${sql(triggerName)}
        BEFORE DELETE ON "Shop"
        FOR EACH ROW
        EXECUTE FUNCTION ${sql(triggerFnName)}()
      `;

      const [{ pid: gatePid }] = await gate<[{ pid: number }]>`SELECT pg_backend_pid() as pid`;
      const [{ pid: pidA }] = await connA<[{ pid: number }]>`SELECT pg_backend_pid() as pid`;
      const [{ pid: pidB }] = await connB<[{ pid: number }]>`SELECT pg_backend_pid() as pid`;

      await gate`SELECT pg_advisory_lock(hashtext(${TEST_SHOP_DOMAIN}))`;

      const deleteShopPromise = deleteShop(connA, TEST_SHOP_DOMAIN);

      await waitForBlocking(sql, pidA, gatePid);

      const helperPromise = markUninstalledAndDeleteSessions(connB, TEST_SHOP_DOMAIN);

      await waitForBlocking(sql, pidB, pidA);

      const settled = await isPromiseSettled(helperPromise);
      expect(settled).toBe(false);

      await gate`SELECT pg_advisory_unlock(hashtext(${TEST_SHOP_DOMAIN}))`;

      const deleteResult = await deleteShopPromise;
      expect(deleteResult.deleted).toBe(true);

      const helperResult = await helperPromise;
      expect(helperResult.shopFound).toBe(false);
      expect(helperResult.sessionsDeleted).toBe(0);

      const shops = await sql<{ domain: string }[]>`
        SELECT domain FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
      `;
      expect(shops.length).toBe(0);
    } finally {
      await gate`SELECT pg_advisory_unlock_all()`.catch(() => {});
      await sql`DROP TRIGGER IF EXISTS ${sql(triggerName)} ON "Shop"`;
      await sql`DROP FUNCTION IF EXISTS ${sql(triggerFnName)}()`;
      await gate.end();
      await connA.end();
      await connB.end();
    }
  });

  describe("reinstall scenario", () => {
    it("afterAuth clears uninstalledAt and new session is stored", async () => {
      const { markUninstalledAndDeleteSessions } = await import("../compliance/compliance.server");

      await markUninstalledAndDeleteSessions(sql, TEST_SHOP_DOMAIN);

      const [afterUninstall] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
      `;
      expect(afterUninstall.uninstalledAt).not.toBeNull();

      await sql`
        UPDATE "Shop"
        SET "uninstalledAt" = NULL, onboarding_dismissed_at = NULL
        WHERE domain = ${TEST_SHOP_DOMAIN} AND "uninstalledAt" IS NOT NULL
      `;

      const newSessionId = `offline_reinstall_${TEST_SHOP_DOMAIN}`;
      await sql`
        INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken", scope)
        VALUES (${newSessionId}, ${TEST_SHOP_DOMAIN}, 'reinstall-state', false, 'new-token', 'read_products')
      `;

      const [afterReinstall] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
      `;
      expect(afterReinstall.uninstalledAt).toBeNull();

      const sessions = await sql<{ id: string }[]>`
        SELECT id FROM "Session" WHERE shop = ${TEST_SHOP_DOMAIN}
      `;
      expect(sessions.length).toBe(1);
      expect(sessions[0].id).toBe(newSessionId);
    });

    it("KNOWN-GAP: late uninstall webhook after reinstall deletes fresh session and sets uninstalledAt", async () => {
      const { markUninstalledAndDeleteSessions } = await import("../compliance/compliance.server");

      await markUninstalledAndDeleteSessions(sql, TEST_SHOP_DOMAIN);

      await sql`
        UPDATE "Shop"
        SET "uninstalledAt" = NULL, onboarding_dismissed_at = NULL
        WHERE domain = ${TEST_SHOP_DOMAIN}
      `;

      const newSessionId = `offline_reinstall_${TEST_SHOP_DOMAIN}`;
      await sql`
        INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken", scope)
        VALUES (${newSessionId}, ${TEST_SHOP_DOMAIN}, 'reinstall-state', false, 'new-token', 'read_products')
      `;

      const [beforeLateWebhook] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
      `;
      expect(beforeLateWebhook.uninstalledAt).toBeNull();

      const sessionsBefore = await sql<{ id: string }[]>`
        SELECT id FROM "Session" WHERE shop = ${TEST_SHOP_DOMAIN}
      `;
      expect(sessionsBefore.length).toBe(1);

      const lateWebhookResult = await markUninstalledAndDeleteSessions(sql, TEST_SHOP_DOMAIN);

      expect(lateWebhookResult.shopFound).toBe(true);
      expect(lateWebhookResult.sessionsDeleted).toBe(1);

      const [afterLateWebhook] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
      `;
      expect(afterLateWebhook.uninstalledAt).not.toBeNull();

      const sessionsAfter = await sql<{ id: string }[]>`
        SELECT id FROM "Session" WHERE shop = ${TEST_SHOP_DOMAIN}
      `;
      expect(sessionsAfter.length).toBe(0);
    });
  });
});
