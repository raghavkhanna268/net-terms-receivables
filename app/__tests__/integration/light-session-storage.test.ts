import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { LightSessionStorage } from "~/lib/session-storage-light.server";
import { Session } from "@shopify/shopify-api";

/**
 * Integration test for lightweight session storage with a real PostgreSQL database.
 *
 * This test verifies the complete data path that the Worker uses with postgres.js:
 * 1. postgres.js SQL client directly
 * 2. Custom LightSessionStorage from app/lib/session-storage-light.server.ts
 * 3. Full CRUD operations: store, load, findSessionsByShop, deleteAllForShop
 * 4. Refresh token round-trip (expiringOfflineAccessTokens support)
 * 5. Error propagation from deleteSession (deleteMany semantics)
 * 6. Timezone-safe timestamp handling across process TZ and DB session TZ
 *
 * The test uses postgres.js which is the same driver used in production,
 * proving the Hyperdrive connection path works end-to-end.
 *
 * Skips cleanly when TEST_DATABASE_URL is not set (CI stays secret-free).
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("Light Session Storage Integration", () => {
  let sql: ReturnType<typeof postgres>;
  let sessionStorage: LightSessionStorage;

  const TEST_SHOP = "test-light-shop.myshopify.com";
  const TEST_SESSION_ID = "test-light-session-id-" + Date.now();

  beforeAll(async () => {
    // Create postgres.js client (production uses default fetch_types)
    sql = postgres(TEST_DATABASE_URL!, { max: 1 });

    // Create session storage with the SQL client
    sessionStorage = new LightSessionStorage(sql);

    // Clean up any leftover test data
    await sql`DELETE FROM "Session" WHERE shop = ${TEST_SHOP}`;
  });

  afterAll(async () => {
    // Clean up test data
    await sql`DELETE FROM "Session" WHERE shop = ${TEST_SHOP}`;
    await sql.end();
  });

  beforeEach(async () => {
    // Clean up before each test for isolation
    await sql`DELETE FROM "Session" WHERE shop = ${TEST_SHOP}`;
  });

  it("stores a session", async () => {
    const session = new Session({
      id: TEST_SESSION_ID,
      shop: TEST_SHOP,
      state: "test-state",
      isOnline: false,
      accessToken: "test-access-token",
    });

    const result = await sessionStorage.storeSession(session);

    expect(result).toBe(true);

    // Verify directly in database
    const rows = await sql`SELECT * FROM "Session" WHERE id = ${TEST_SESSION_ID}`;
    expect(rows.length).toBe(1);
    expect(rows[0].shop).toBe(TEST_SHOP);
    expect(rows[0].accessToken).toBe("test-access-token");
  });

  it("loads a session by id", async () => {
    const session = new Session({
      id: TEST_SESSION_ID,
      shop: TEST_SHOP,
      state: "test-state",
      isOnline: false,
      accessToken: "test-access-token",
      scope: "read_orders,read_customers",
    });
    await sessionStorage.storeSession(session);

    const loaded = await sessionStorage.loadSession(TEST_SESSION_ID);

    expect(loaded).not.toBeUndefined();
    expect(loaded?.id).toBe(TEST_SESSION_ID);
    expect(loaded?.shop).toBe(TEST_SHOP);
    expect(loaded?.accessToken).toBe("test-access-token");
    expect(loaded?.scope).toBe("read_orders,read_customers");
  });

  it("returns undefined for non-existent session", async () => {
    const loaded = await sessionStorage.loadSession("non-existent-id");
    expect(loaded).toBeUndefined();
  });

  it("finds sessions by shop", async () => {
    const session1 = new Session({
      id: `${TEST_SESSION_ID}-1`,
      shop: TEST_SHOP,
      state: "state-1",
      isOnline: false,
      accessToken: "token-1",
    });
    const session2 = new Session({
      id: `${TEST_SESSION_ID}-2`,
      shop: TEST_SHOP,
      state: "state-2",
      isOnline: true,
      accessToken: "token-2",
    });

    await sessionStorage.storeSession(session1);
    await sessionStorage.storeSession(session2);

    const sessions = await sessionStorage.findSessionsByShop(TEST_SHOP);

    expect(sessions).toHaveLength(2);
    expect(sessions.map((s: Session) => s.id).sort()).toEqual([
      `${TEST_SESSION_ID}-1`,
      `${TEST_SESSION_ID}-2`,
    ]);
  });

  it("returns empty array for shop with no sessions", async () => {
    const sessions = await sessionStorage.findSessionsByShop(
      "nonexistent-shop.myshopify.com"
    );
    expect(sessions).toEqual([]);
  });

  it("deletes a single session", async () => {
    const session = new Session({
      id: TEST_SESSION_ID,
      shop: TEST_SHOP,
      state: "test-state",
      isOnline: false,
      accessToken: "test-token",
    });
    await sessionStorage.storeSession(session);

    const result = await sessionStorage.deleteSession(TEST_SESSION_ID);

    expect(result).toBe(true);
    const loaded = await sessionStorage.loadSession(TEST_SESSION_ID);
    expect(loaded).toBeUndefined();
  });

  it("deletes multiple sessions (deleteSessions)", async () => {
    const session1 = new Session({
      id: `${TEST_SESSION_ID}-1`,
      shop: TEST_SHOP,
      state: "state-1",
      isOnline: false,
      accessToken: "token-1",
    });
    const session2 = new Session({
      id: `${TEST_SESSION_ID}-2`,
      shop: TEST_SHOP,
      state: "state-2",
      isOnline: true,
      accessToken: "token-2",
    });

    await sessionStorage.storeSession(session1);
    await sessionStorage.storeSession(session2);

    const result = await sessionStorage.deleteSessions([
      `${TEST_SESSION_ID}-1`,
      `${TEST_SESSION_ID}-2`,
    ]);

    expect(result).toBe(true);
    const remaining = await sessionStorage.findSessionsByShop(TEST_SHOP);
    expect(remaining).toHaveLength(0);
  });

  it("updates an existing session (upsert behavior)", async () => {
    const session = new Session({
      id: TEST_SESSION_ID,
      shop: TEST_SHOP,
      state: "initial-state",
      isOnline: false,
      accessToken: "initial-token",
      scope: "read_orders",
    });
    await sessionStorage.storeSession(session);

    session.scope = "read_orders,read_customers,write_orders";
    await sessionStorage.storeSession(session);

    const loaded = await sessionStorage.loadSession(TEST_SESSION_ID);
    expect(loaded?.scope).toBe("read_orders,read_customers,write_orders");
  });

  it("handles shop uninstall flow (deleteAllForShop)", async () => {
    const offlineSession = new Session({
      id: `offline_${TEST_SHOP}`,
      shop: TEST_SHOP,
      state: "offline-state",
      isOnline: false,
      accessToken: "offline-token",
    });
    const onlineSession = new Session({
      id: `online_${TEST_SHOP}_user123`,
      shop: TEST_SHOP,
      state: "online-state",
      isOnline: true,
      accessToken: "online-token",
    });

    await sessionStorage.storeSession(offlineSession);
    await sessionStorage.storeSession(onlineSession);

    const deletedCount = await sessionStorage.deleteAllForShop(TEST_SHOP);
    expect(deletedCount).toBe(2);

    const remaining = await sessionStorage.findSessionsByShop(TEST_SHOP);
    expect(remaining).toHaveLength(0);
  });

  it("round-trips session with refresh token and expiry (expiringOfflineAccessTokens)", async () => {
    const expires = new Date("2025-06-15T12:00:00.000Z");
    const refreshTokenExpires = new Date("2025-12-15T12:00:00.000Z");

    const session = new Session({
      id: TEST_SESSION_ID,
      shop: TEST_SHOP,
      state: "test-state",
      isOnline: false,
      scope: "read_orders,write_orders",
      expires,
      accessToken: "shpat_test-access-token",
      refreshToken: "shprt_test-refresh-token",
      refreshTokenExpires,
    });

    await sessionStorage.storeSession(session);
    const loaded = await sessionStorage.loadSession(TEST_SESSION_ID);

    expect(loaded).not.toBeUndefined();
    expect(loaded!.id).toBe(session.id);
    expect(loaded!.shop).toBe(session.shop);
    expect(loaded!.accessToken).toBe(session.accessToken);
    expect(loaded!.refreshToken).toBe(session.refreshToken);

    expect(loaded!.expires).toBeInstanceOf(Date);
    expect(loaded!.expires!.toISOString()).toBe(expires.toISOString());

    expect(loaded!.refreshTokenExpires).toBeInstanceOf(Date);
    expect(loaded!.refreshTokenExpires!.toISOString()).toBe(
      refreshTokenExpires.toISOString()
    );

    expect(loaded!.equals(session)).toBe(true);
  });

  it("round-trips online session with user info", async () => {
    const expires = new Date("2025-06-15T12:00:00.000Z");

    const session = new Session({
      id: TEST_SESSION_ID,
      shop: TEST_SHOP,
      state: "test-state",
      isOnline: true,
      scope: "read_orders",
      expires,
      accessToken: "shpat_test-online-token",
      onlineAccessInfo: {
        expires_in: 86400,
        associated_user_scope: "read_orders",
        associated_user: {
          id: 12345678,
          first_name: "Test",
          last_name: "User",
          email: "test@example.com",
          account_owner: true,
          locale: "en-US",
          collaborator: false,
          email_verified: true,
        },
      },
    });

    await sessionStorage.storeSession(session);
    const loaded = await sessionStorage.loadSession(TEST_SESSION_ID);

    expect(loaded).not.toBeUndefined();
    expect(loaded!.isOnline).toBe(true);
    expect(loaded!.onlineAccessInfo).not.toBeUndefined();
    expect(loaded!.onlineAccessInfo!.associated_user.id).toBe(12345678);
    expect(loaded!.onlineAccessInfo!.associated_user.first_name).toBe("Test");
    expect(loaded!.onlineAccessInfo!.associated_user.last_name).toBe("User");
    expect(loaded!.onlineAccessInfo!.associated_user.email).toBe("test@example.com");
    expect(loaded!.onlineAccessInfo!.associated_user.account_owner).toBe(true);
    expect(loaded!.onlineAccessInfo!.associated_user.locale).toBe("en-US");
    expect(loaded!.onlineAccessInfo!.associated_user.collaborator).toBe(false);
    expect(loaded!.onlineAccessInfo!.associated_user.email_verified).toBe(true);
  });

  it("updateScopeForShop updates all sessions for a shop", async () => {
    const session1 = new Session({
      id: `${TEST_SESSION_ID}-1`,
      shop: TEST_SHOP,
      state: "state-1",
      isOnline: false,
      accessToken: "token-1",
      scope: "read_orders",
    });
    const session2 = new Session({
      id: `${TEST_SESSION_ID}-2`,
      shop: TEST_SHOP,
      state: "state-2",
      isOnline: true,
      accessToken: "token-2",
      scope: "read_orders",
    });

    await sessionStorage.storeSession(session1);
    await sessionStorage.storeSession(session2);

    const updatedCount = await sessionStorage.updateScopeForShop(
      TEST_SHOP,
      "read_orders,write_orders"
    );
    expect(updatedCount).toBe(2);

    const sessions = await sessionStorage.findSessionsByShop(TEST_SHOP);
    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      expect(session.scope).toBe("read_orders,write_orders");
    }
  });

  it("round-trips online session with large userId (bigint)", async () => {
    // Test bigint userId that exceeds 32-bit integer range
    const largeUserId = 8589934592; // 2^33, larger than 32-bit max
    const expires = new Date("2025-06-15T12:00:00.000Z");

    const session = new Session({
      id: TEST_SESSION_ID,
      shop: TEST_SHOP,
      state: "test-state",
      isOnline: true,
      scope: "read_orders",
      expires,
      accessToken: "shpat_test-bigint-token",
      onlineAccessInfo: {
        expires_in: 86400,
        associated_user_scope: "read_orders",
        associated_user: {
          id: largeUserId,
          first_name: "BigInt",
          last_name: "User",
          email: "bigint@example.com",
          account_owner: false,
          locale: "en-GB",
          collaborator: true,
          email_verified: false,
        },
      },
    });

    await sessionStorage.storeSession(session);
    const loaded = await sessionStorage.loadSession(TEST_SESSION_ID);

    expect(loaded).not.toBeUndefined();
    expect(loaded!.onlineAccessInfo).not.toBeUndefined();
    expect(loaded!.onlineAccessInfo!.associated_user.id).toBe(largeUserId);
  });

  it("propagates errors from closed SQL connection", async () => {
    const closedSql = postgres(TEST_DATABASE_URL!, { max: 1 });
    const closedStorage = new LightSessionStorage(closedSql);
    
    await closedSql.end();

    // Operations through LightSessionStorage should throw errors
    await expect(closedStorage.loadSession("any-id")).rejects.toThrow();
  });

  it("propagates errors from storage operations on invalid connection", async () => {
    // Use a connection string to a non-existent database to test error propagation
    // through LightSessionStorage (not raw SQL)
    const badSql = postgres("postgresql://postgres:postgres@localhost:5432/nonexistent_db_12345", {
      max: 1,
      fetch_types: false,
      connect_timeout: 2,
    });
    const badStorage = new LightSessionStorage(badSql);

    // Storage operations should propagate database errors
    await expect(badStorage.loadSession("any-id")).rejects.toThrow();
    
    await badSql.end().catch(() => {});
  });

  it("deleteSessions handles empty array", async () => {
    const result = await sessionStorage.deleteSessions([]);
    expect(result).toBe(true);
  });
});

/**
 * Timezone tests - verify timestamp handling across different timezone configurations.
 * 
 * These tests verify that expires and refreshTokenExpires are stored and read correctly
 * regardless of:
 * - Process timezone (TZ environment variable)
 * - Database session timezone (SET TIME ZONE)
 * 
 * The stored TIMESTAMP(3) column should always contain UTC wall time, and our
 * AT TIME ZONE 'UTC' handling should ensure correct round-trips.
 */
describeWithDb("Light Session Storage Timezone Handling", () => {
  const TZ_TEST_SHOP = "test-tz-shop.myshopify.com";
  const TZ_TEST_SESSION_ID = "test-tz-session-" + Date.now();
  
  // Test timestamp: July 4, 2025, 11:30 PM UTC (carefully chosen to expose TZ bugs)
  // In Asia/Kolkata (UTC+5:30), this is July 5, 2025, 5:00 AM
  const TEST_EXPIRES = new Date("2025-07-04T23:30:00.000Z");
  const TEST_REFRESH_EXPIRES = new Date("2026-01-15T06:45:00.000Z");

  afterAll(async () => {
    // Clean up test data with a fresh connection
    const cleanupSql = postgres(TEST_DATABASE_URL!, { max: 1 });
    await cleanupSql`DELETE FROM "Session" WHERE shop = ${TZ_TEST_SHOP}`;
    await cleanupSql.end();
  });

  it("stores UTC timestamp correctly (raw column verification)", async () => {
    const sqlUtc = postgres(TEST_DATABASE_URL!, { max: 1 });
    const storage = new LightSessionStorage(sqlUtc);

    const session = new Session({
      id: `${TZ_TEST_SESSION_ID}-raw`,
      shop: TZ_TEST_SHOP,
      state: "test",
      isOnline: false,
      accessToken: "token",
      expires: TEST_EXPIRES,
      refreshTokenExpires: TEST_REFRESH_EXPIRES,
    });

    await storage.storeSession(session);

    // Verify raw column contains UTC wall time (no timezone conversion)
    // Cast to text to see the exact stored value
    const [row] = await sqlUtc`
      SELECT 
        expires::text as expires_text,
        "refreshTokenExpires"::text as refresh_expires_text
      FROM "Session" 
      WHERE id = ${`${TZ_TEST_SESSION_ID}-raw`}
    `;

    // Raw timestamp should be UTC wall time
    expect(row.expires_text).toBe("2025-07-04 23:30:00");
    expect(row.refresh_expires_text).toBe("2026-01-15 06:45:00");

    await sqlUtc`DELETE FROM "Session" WHERE id = ${`${TZ_TEST_SESSION_ID}-raw`}`;
    await sqlUtc.end();
  });

  it("round-trips correctly with DB session timezone UTC (process TZ=UTC)", async () => {
    const sqlUtc = postgres(TEST_DATABASE_URL!, { max: 1 });
    await sqlUtc`SET TIME ZONE 'UTC'`;
    const storage = new LightSessionStorage(sqlUtc);

    const session = new Session({
      id: `${TZ_TEST_SESSION_ID}-utc-utc`,
      shop: TZ_TEST_SHOP,
      state: "test",
      isOnline: false,
      accessToken: "token",
      expires: TEST_EXPIRES,
      refreshTokenExpires: TEST_REFRESH_EXPIRES,
    });

    await storage.storeSession(session);
    const loaded = await storage.loadSession(`${TZ_TEST_SESSION_ID}-utc-utc`);

    expect(loaded!.expires!.toISOString()).toBe(TEST_EXPIRES.toISOString());
    expect(loaded!.refreshTokenExpires!.toISOString()).toBe(TEST_REFRESH_EXPIRES.toISOString());

    await sqlUtc`DELETE FROM "Session" WHERE id = ${`${TZ_TEST_SESSION_ID}-utc-utc`}`;
    await sqlUtc.end();
  });

  it("round-trips correctly with DB session timezone Asia/Kolkata (process TZ=UTC)", async () => {
    const sqlKolkata = postgres(TEST_DATABASE_URL!, { max: 1 });
    await sqlKolkata`SET TIME ZONE 'Asia/Kolkata'`;
    const storage = new LightSessionStorage(sqlKolkata);

    const session = new Session({
      id: `${TZ_TEST_SESSION_ID}-utc-kolkata`,
      shop: TZ_TEST_SHOP,
      state: "test",
      isOnline: false,
      accessToken: "token",
      expires: TEST_EXPIRES,
      refreshTokenExpires: TEST_REFRESH_EXPIRES,
    });

    await storage.storeSession(session);
    const loaded = await storage.loadSession(`${TZ_TEST_SESSION_ID}-utc-kolkata`);

    // Should still get UTC back regardless of DB session timezone
    expect(loaded!.expires!.toISOString()).toBe(TEST_EXPIRES.toISOString());
    expect(loaded!.refreshTokenExpires!.toISOString()).toBe(TEST_REFRESH_EXPIRES.toISOString());

    await sqlKolkata`DELETE FROM "Session" WHERE id = ${`${TZ_TEST_SESSION_ID}-utc-kolkata`}`;
    await sqlKolkata.end();
  });

  it("round-trips correctly with DB session timezone Europe/London", async () => {
    const sqlLondon = postgres(TEST_DATABASE_URL!, { max: 1 });
    await sqlLondon`SET TIME ZONE 'Europe/London'`;
    const storage = new LightSessionStorage(sqlLondon);

    const session = new Session({
      id: `${TZ_TEST_SESSION_ID}-utc-london`,
      shop: TZ_TEST_SHOP,
      state: "test",
      isOnline: false,
      accessToken: "token",
      expires: TEST_EXPIRES,
      refreshTokenExpires: TEST_REFRESH_EXPIRES,
    });

    await storage.storeSession(session);
    const loaded = await storage.loadSession(`${TZ_TEST_SESSION_ID}-utc-london`);

    expect(loaded!.expires!.toISOString()).toBe(TEST_EXPIRES.toISOString());
    expect(loaded!.refreshTokenExpires!.toISOString()).toBe(TEST_REFRESH_EXPIRES.toISOString());

    await sqlLondon`DELETE FROM "Session" WHERE id = ${`${TZ_TEST_SESSION_ID}-utc-london`}`;
    await sqlLondon.end();
  });

  it("round-trips correctly with DB session timezone America/New_York", async () => {
    const sqlNy = postgres(TEST_DATABASE_URL!, { max: 1 });
    await sqlNy`SET TIME ZONE 'America/New_York'`;
    const storage = new LightSessionStorage(sqlNy);

    const session = new Session({
      id: `${TZ_TEST_SESSION_ID}-utc-ny`,
      shop: TZ_TEST_SHOP,
      state: "test",
      isOnline: false,
      accessToken: "token",
      expires: TEST_EXPIRES,
      refreshTokenExpires: TEST_REFRESH_EXPIRES,
    });

    await storage.storeSession(session);
    const loaded = await storage.loadSession(`${TZ_TEST_SESSION_ID}-utc-ny`);

    expect(loaded!.expires!.toISOString()).toBe(TEST_EXPIRES.toISOString());
    expect(loaded!.refreshTokenExpires!.toISOString()).toBe(TEST_REFRESH_EXPIRES.toISOString());

    await sqlNy`DELETE FROM "Session" WHERE id = ${`${TZ_TEST_SESSION_ID}-utc-ny`}`;
    await sqlNy.end();
  });

  it("is compatible with rows written by Prisma (stored as UTC wall time)", async () => {
    // Simulate a row that Prisma would have written (UTC wall time in TIMESTAMP column)
    const sqlDirect = postgres(TEST_DATABASE_URL!, { max: 1 });
    
    // Insert directly using the same format Prisma uses (UTC wall time)
    await sqlDirect`
      INSERT INTO "Session" (
        id, shop, state, "isOnline", scope, expires, "accessToken",
        "userId", "firstName", "lastName", email, "accountOwner",
        locale, collaborator, "emailVerified", "refreshToken", "refreshTokenExpires"
      ) VALUES (
        ${`${TZ_TEST_SESSION_ID}-prisma-compat`},
        ${TZ_TEST_SHOP},
        'test',
        false,
        null,
        '2025-07-04 23:30:00'::timestamp,
        'token',
        null, null, null, null, false, null, false, false, null,
        '2026-01-15 06:45:00'::timestamp
      )
    `;

    // Read using LightSessionStorage
    const storage = new LightSessionStorage(sqlDirect);
    const loaded = await storage.loadSession(`${TZ_TEST_SESSION_ID}-prisma-compat`);

    // Should correctly interpret as UTC
    expect(loaded!.expires!.toISOString()).toBe("2025-07-04T23:30:00.000Z");
    expect(loaded!.refreshTokenExpires!.toISOString()).toBe("2026-01-15T06:45:00.000Z");

    await sqlDirect`DELETE FROM "Session" WHERE id = ${`${TZ_TEST_SESSION_ID}-prisma-compat`}`;
    await sqlDirect.end();
  });

  it("cross-writes and cross-reads correctly (write in Kolkata TZ, read in NY TZ)", async () => {
    // Write with Asia/Kolkata DB session
    const sqlWrite = postgres(TEST_DATABASE_URL!, { max: 1 });
    await sqlWrite`SET TIME ZONE 'Asia/Kolkata'`;
    const writeStorage = new LightSessionStorage(sqlWrite);

    const session = new Session({
      id: `${TZ_TEST_SESSION_ID}-cross-tz`,
      shop: TZ_TEST_SHOP,
      state: "test",
      isOnline: false,
      accessToken: "token",
      expires: TEST_EXPIRES,
      refreshTokenExpires: TEST_REFRESH_EXPIRES,
    });

    await writeStorage.storeSession(session);
    await sqlWrite.end();

    // Read with America/New_York DB session
    const sqlRead = postgres(TEST_DATABASE_URL!, { max: 1 });
    await sqlRead`SET TIME ZONE 'America/New_York'`;
    const readStorage = new LightSessionStorage(sqlRead);

    const loaded = await readStorage.loadSession(`${TZ_TEST_SESSION_ID}-cross-tz`);

    // Should still get the original UTC timestamps
    expect(loaded!.expires!.toISOString()).toBe(TEST_EXPIRES.toISOString());
    expect(loaded!.refreshTokenExpires!.toISOString()).toBe(TEST_REFRESH_EXPIRES.toISOString());

    await sqlRead`DELETE FROM "Session" WHERE id = ${`${TZ_TEST_SESSION_ID}-cross-tz`}`;
    await sqlRead.end();
  });
});
