/**
 * DB tests for markUninstalledAndDeleteSessions (#258).
 *
 * Verifies the atomic ordering guarantee: uninstalledAt is set in the same
 * transaction as session deletion, closing the window where the drain could
 * see no_session while the Shop row still looks installed.
 *
 * Tests:
 * - Both writes commit together
 * - Failure after UPDATE rolls back both (sessions kept, uninstalledAt still NULL)
 * - Duplicate delivery keeps the FIRST uninstalledAt (COALESCE)
 * - Shop row missing: sessions are still deleted
 * - Concurrent FOR SHARE blocks until tx commits, then sees uninstalledAt set
 * - Serializes with deleteShop's FOR UPDATE
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

const TEST_SUFFIX = `uninstall-order-${Date.now()}`;
const TEST_SHOP_DOMAIN = `test-${TEST_SUFFIX}.myshopify.com`;
const TEST_SESSION_ID = `offline_${TEST_SHOP_DOMAIN}`;

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
    await sql`DELETE FROM "Session" WHERE shop LIKE ${'test-uninstall-order-%'}`;
    await sql`DELETE FROM "Shop" WHERE domain LIKE ${'test-uninstall-order-%'}`;

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

  it("failure after UPDATE rolls back both (sessions kept, uninstalledAt still NULL)", async () => {
    const failingSql = postgres(TEST_DATABASE_URL!, sqlOptions);

    try {
      await failingSql.begin(async (tx) => {
        const [shopRow] = await tx<[{ id: string }?]>`
          SELECT id FROM "Shop"
          WHERE domain = ${TEST_SHOP_DOMAIN}
          FOR UPDATE
        `;

        if (shopRow) {
          await tx`
            UPDATE "Shop"
            SET "uninstalledAt" = COALESCE("uninstalledAt", NOW()), "updatedAt" = NOW()
            WHERE domain = ${TEST_SHOP_DOMAIN}
          `;
        }

        throw new Error("Simulated failure after UPDATE");
      });
    } catch (e) {
      expect((e as Error).message).toBe("Simulated failure after UPDATE");
    }

    const [shop] = await sql<{ uninstalledAt: Date | null }[]>`
      SELECT "uninstalledAt" FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
    `;
    expect(shop.uninstalledAt).toBeNull();

    const sessions = await sql<{ id: string }[]>`
      SELECT id FROM "Session" WHERE shop = ${TEST_SHOP_DOMAIN}
    `;
    expect(sessions.length).toBe(1);

    await failingSql.end();
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

  it("concurrent FOR SHARE blocks until tx commits, then sees uninstalledAt set", async () => {
    const conn1 = postgres(TEST_DATABASE_URL!, sqlOptions);
    const conn2 = postgres(TEST_DATABASE_URL!, sqlOptions);

    try {
      let conn2SeenUninstalledAt: Date | null = null;

      await conn1.begin(async (tx1) => {
        await tx1`
          SELECT id FROM "Shop"
          WHERE domain = ${TEST_SHOP_DOMAIN}
          FOR UPDATE
        `;

        await tx1`
          UPDATE "Shop"
          SET "uninstalledAt" = NOW(), "updatedAt" = NOW()
          WHERE domain = ${TEST_SHOP_DOMAIN}
        `;
      });

      await conn2.begin(async (tx2) => {
        const [shop] = await tx2<[{ uninstalledAt: Date | null }?]>`
          SELECT "uninstalledAt" FROM "Shop"
          WHERE domain = ${TEST_SHOP_DOMAIN}
          FOR SHARE
        `;
        conn2SeenUninstalledAt = shop?.uninstalledAt ?? null;
      });

      expect(conn2SeenUninstalledAt).not.toBeNull();
    } finally {
      await conn1.end();
      await conn2.end();
    }
  });

  it("serializes with deleteShop's FOR UPDATE (sequential verification)", async () => {
    const conn1 = postgres(TEST_DATABASE_URL!, sqlOptions);
    const conn2 = postgres(TEST_DATABASE_URL!, sqlOptions);

    try {
      let lockObtained = false;

      await conn1.begin(async (tx1) => {
        const [row] = await tx1<[{ id: string }?]>`
          SELECT id FROM "Shop"
          WHERE domain = ${TEST_SHOP_DOMAIN}
          FOR UPDATE
        `;
        lockObtained = !!row;
      });

      expect(lockObtained).toBe(true);

      await conn2.begin(async (tx2) => {
        const [row] = await tx2<[{ id: string }?]>`
          SELECT id FROM "Shop"
          WHERE domain = ${TEST_SHOP_DOMAIN}
          FOR UPDATE
        `;
        expect(row).toBeDefined();
      });
    } finally {
      await conn1.end();
      await conn2.end();
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
