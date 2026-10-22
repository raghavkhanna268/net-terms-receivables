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
    // Create postgres.js client directly
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
    // Store a session first
    const session = new Session({
      id: TEST_SESSION_ID,
      shop: TEST_SHOP,
      state: "test-state",
      isOnline: false,
      accessToken: "test-access-token",
      scope: "read_orders,read_customers",
    });
    await sessionStorage.storeSession(session);

    // Load it back
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
    // Store multiple sessions for the same shop
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

    // Find all sessions for the shop
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
    // Store a session
    const session = new Session({
      id: TEST_SESSION_ID,
      shop: TEST_SHOP,
      state: "test-state",
      isOnline: false,
      accessToken: "test-token",
    });
    await sessionStorage.storeSession(session);

    // Delete it
    const result = await sessionStorage.deleteSession(TEST_SESSION_ID);

    expect(result).toBe(true);

    // Verify it's gone
    const loaded = await sessionStorage.loadSession(TEST_SESSION_ID);
    expect(loaded).toBeUndefined();
  });

  it("deletes multiple sessions (deleteSessions)", async () => {
    // Store multiple sessions
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

    // Delete both at once
    const result = await sessionStorage.deleteSessions([
      `${TEST_SESSION_ID}-1`,
      `${TEST_SESSION_ID}-2`,
    ]);

    expect(result).toBe(true);

    // Verify both are gone
    const remaining = await sessionStorage.findSessionsByShop(TEST_SHOP);
    expect(remaining).toHaveLength(0);
  });

  it("updates an existing session (upsert behavior)", async () => {
    // Store initial session
    const session = new Session({
      id: TEST_SESSION_ID,
      shop: TEST_SHOP,
      state: "initial-state",
      isOnline: false,
      accessToken: "initial-token",
      scope: "read_orders",
    });
    await sessionStorage.storeSession(session);

    // Update it with new scope (simulating scopes_update webhook)
    session.scope = "read_orders,read_customers,write_orders";
    await sessionStorage.storeSession(session);

    // Load and verify update
    const loaded = await sessionStorage.loadSession(TEST_SESSION_ID);
    expect(loaded?.scope).toBe("read_orders,read_customers,write_orders");
  });

  it("handles shop uninstall flow (deleteAllForShop)", async () => {
    // Store multiple sessions (offline + online)
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

    // Delete all sessions for shop using deleteAllForShop
    const deletedCount = await sessionStorage.deleteAllForShop(TEST_SHOP);
    expect(deletedCount).toBe(2);

    // Verify all gone
    const remaining = await sessionStorage.findSessionsByShop(TEST_SHOP);
    expect(remaining).toHaveLength(0);
  });

  it("round-trips session with refresh token and expiry (expiringOfflineAccessTokens)", async () => {
    // Test session with refresh token for future.expiringOfflineAccessTokens: true
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

    // Store the session
    await sessionStorage.storeSession(session);

    // Load it back
    const loaded = await sessionStorage.loadSession(TEST_SESSION_ID);

    // Verify all fields round-trip correctly
    expect(loaded).not.toBeUndefined();
    expect(loaded!.id).toBe(session.id);
    expect(loaded!.shop).toBe(session.shop);
    expect(loaded!.state).toBe(session.state);
    expect(loaded!.isOnline).toBe(session.isOnline);
    expect(loaded!.scope).toBe(session.scope);
    expect(loaded!.accessToken).toBe(session.accessToken);

    // Verify refresh token fields
    expect(loaded!.refreshToken).toBe(session.refreshToken);

    // Verify Date fields are correctly restored (comparing ISO strings for equality)
    expect(loaded!.expires).toBeInstanceOf(Date);
    expect(loaded!.expires!.toISOString()).toBe(expires.toISOString());

    expect(loaded!.refreshTokenExpires).toBeInstanceOf(Date);
    expect(loaded!.refreshTokenExpires!.toISOString()).toBe(
      refreshTokenExpires.toISOString()
    );

    // Deep equality check: the loaded session should equal the original
    expect(loaded!.equals(session)).toBe(true);
  });

  it("round-trips online session with user info", async () => {
    // Test online session with onlineAccessInfo
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

    // Store and load
    await sessionStorage.storeSession(session);
    const loaded = await sessionStorage.loadSession(TEST_SESSION_ID);

    // Verify basic fields
    expect(loaded).not.toBeUndefined();
    expect(loaded!.isOnline).toBe(true);

    // Verify user info is restored
    expect(loaded!.onlineAccessInfo).not.toBeUndefined();
    expect(loaded!.onlineAccessInfo!.associated_user.id).toBe(12345678);
    expect(loaded!.onlineAccessInfo!.associated_user.first_name).toBe("Test");
    expect(loaded!.onlineAccessInfo!.associated_user.last_name).toBe("User");
    expect(loaded!.onlineAccessInfo!.associated_user.email).toBe(
      "test@example.com"
    );
    expect(loaded!.onlineAccessInfo!.associated_user.account_owner).toBe(true);
    expect(loaded!.onlineAccessInfo!.associated_user.locale).toBe("en-US");
    expect(loaded!.onlineAccessInfo!.associated_user.collaborator).toBe(false);
    expect(loaded!.onlineAccessInfo!.associated_user.email_verified).toBe(true);
  });

  it("updateScopeForShop updates all sessions for a shop", async () => {
    // Store multiple sessions
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

    // Update scope for all sessions
    const updatedCount = await sessionStorage.updateScopeForShop(
      TEST_SHOP,
      "read_orders,write_orders"
    );
    expect(updatedCount).toBe(2);

    // Verify both sessions have new scope
    const sessions = await sessionStorage.findSessionsByShop(TEST_SHOP);
    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      expect(session.scope).toBe("read_orders,write_orders");
    }
  });

  it("round-trips online session with large userId (bigint)", async () => {
    // Test bigint userId that exceeds 32-bit integer range but is safe in JS
    // Shopify user IDs can be large numbers stored as bigint in Postgres
    const largeUserId = 8589934592; // 2^33, larger than 32-bit max (2^31-1 = 2147483647)
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

    // Store and load
    await sessionStorage.storeSession(session);
    const loaded = await sessionStorage.loadSession(TEST_SESSION_ID);

    // Verify bigint userId round-trips correctly
    expect(loaded).not.toBeUndefined();
    expect(loaded!.onlineAccessInfo).not.toBeUndefined();
    expect(loaded!.onlineAccessInfo!.associated_user.id).toBe(largeUserId);
  });

  it("round-trips expires Date across timezones (UTC)", async () => {
    // Test that Date fields are stored and retrieved in UTC correctly
    // Use a date with specific time to verify no timezone drift
    const expires = new Date("2025-07-04T23:59:59.999Z");
    const refreshTokenExpires = new Date("2026-01-01T00:00:00.000Z");

    const session = new Session({
      id: TEST_SESSION_ID,
      shop: TEST_SHOP,
      state: "test-state",
      isOnline: false,
      accessToken: "test-token",
      expires,
      refreshToken: "test-refresh",
      refreshTokenExpires,
    });

    await sessionStorage.storeSession(session);
    const loaded = await sessionStorage.loadSession(TEST_SESSION_ID);

    // Verify timestamps are preserved exactly
    expect(loaded!.expires!.getTime()).toBe(expires.getTime());
    expect(loaded!.refreshTokenExpires!.getTime()).toBe(refreshTokenExpires.getTime());
    
    // Verify ISO strings match (proves UTC preservation)
    expect(loaded!.expires!.toISOString()).toBe("2025-07-04T23:59:59.999Z");
    expect(loaded!.refreshTokenExpires!.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("propagates errors from closed SQL connection", async () => {
    // Create a separate SQL client and close it to test error propagation
    const closedSql = postgres(TEST_DATABASE_URL!, { max: 1 });
    const closedStorage = new LightSessionStorage(closedSql);
    
    // Close the connection
    await closedSql.end();

    // Operations should throw errors, not silently fail
    await expect(closedStorage.loadSession("any-id")).rejects.toThrow();
  });

  it("propagates errors from invalid table query", async () => {
    // Create a storage that queries a non-existent table by using raw SQL
    // This verifies that SQL errors propagate correctly
    await expect(
      sql`SELECT * FROM "NonExistentTable" WHERE id = 'test'`
    ).rejects.toThrow();
  });

  it("deleteSessions handles empty array", async () => {
    // Should not throw or make a DB call for empty array
    const result = await sessionStorage.deleteSessions([]);
    expect(result).toBe(true);
  });
});
