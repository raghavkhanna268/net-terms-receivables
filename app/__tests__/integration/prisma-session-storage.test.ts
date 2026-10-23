import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
// Use Node.js runtime generator for testing (cloudflare runtime doesn't run in Node.js)
import { PrismaClient } from "~/generated/prisma-node/client";
import { PrismaSessionStorage } from "~/lib/session-storage.server";
import { Session } from "@shopify/shopify-api";

/**
 * Integration test for Prisma session storage with a real PostgreSQL database.
 *
 * This test verifies the complete data path that the Worker uses:
 * 1. PrismaClient with @prisma/adapter-pg driver adapter
 * 2. Custom PrismaSessionStorage from app/lib/session-storage.server.ts
 * 3. Full CRUD operations: store, load, findSessionsByShop, deleteAllForShop
 *
 * The test uses the same adapter configuration that workers/app.ts uses,
 * proving the Hyperdrive connection path works end-to-end.
 *
 * Skips cleanly when TEST_DATABASE_URL is not set (CI stays secret-free).
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("Prisma Session Storage Integration", () => {
  let prisma: PrismaClient;
  let sessionStorage: PrismaSessionStorage;

  const TEST_SHOP = "test-integration-shop.myshopify.com";
  const TEST_SESSION_ID = "test-session-id-" + Date.now();

  beforeAll(async () => {
    // Create PrismaClient using the same adapter pattern as workers/app.ts
    const adapter = new PrismaPg({ connectionString: TEST_DATABASE_URL! });
    // Type assertion: Node.js generator types differ slightly from cloudflare
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma = new PrismaClient({ adapter }) as any;

    // Create session storage the same way shopify.server.ts does
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sessionStorage = new PrismaSessionStorage(prisma as any);

    // Clean up any leftover test data
    await prisma.session.deleteMany({
      where: { shop: TEST_SHOP },
    });
  });

  afterAll(async () => {
    // Clean up test data
    await prisma.session.deleteMany({
      where: { shop: TEST_SHOP },
    });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Clean up before each test for isolation
    await prisma.session.deleteMany({
      where: { shop: TEST_SHOP },
    });
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
    const dbSession = await prisma.session.findUnique({
      where: { id: TEST_SESSION_ID },
    });
    expect(dbSession).not.toBeNull();
    expect(dbSession?.shop).toBe(TEST_SHOP);
    expect(dbSession?.accessToken).toBe("test-access-token");
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

  it("handles shop uninstall flow (find all + delete all)", async () => {
    // This simulates the exact flow in webhooks.app.uninstalled.tsx
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

    // Find all sessions for shop (as webhooks.app.uninstalled.tsx does)
    const sessions = await sessionStorage.findSessionsByShop(TEST_SHOP);
    expect(sessions.length).toBeGreaterThan(0);

    // Delete all sessions (as webhooks.app.uninstalled.tsx does)
    const sessionIds = sessions.map((s: Session) => s.id);
    await sessionStorage.deleteSessions(sessionIds);

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

  /**
   * P1-2 REGRESSION TEST: storeSession must clear needsReauth flag.
   *
   * When a session is stored (upsert), needsReauth should always be reset to false.
   * This prevents a stale needsReauth=true flag from persisting after a successful
   * token refresh or session update.
   *
   * Scenario:
   * 1. Create a session in the database with needsReauth=true (simulating previous
   *    invalid_grant that marked the shop as needing re-auth)
   * 2. Call storeSession (simulating a successful OAuth flow or token update)
   * 3. Verify needsReauth is cleared to false
   */
  it("P1-2: storeSession clears needsReauth flag (Prisma storage)", async () => {
    // First, insert a session directly with needsReauth=true
    await prisma.session.create({
      data: {
        id: TEST_SESSION_ID,
        shop: TEST_SHOP,
        state: "test-state",
        isOnline: false,
        scope: "read_products",
        accessToken: "shpat_old_token",
        accountOwner: false,
        collaborator: false,
        emailVerified: false,
        needsReauth: true,
      },
    });

    // Verify needsReauth is true
    const beforeSession = await prisma.session.findUnique({
      where: { id: TEST_SESSION_ID },
      select: { needsReauth: true },
    });
    expect(beforeSession?.needsReauth).toBe(true);

    // Create a Session object and call storeSession (upsert)
    const session = new Session({
      id: TEST_SESSION_ID,
      shop: TEST_SHOP,
      state: "updated-state",
      isOnline: false,
      accessToken: "shpat_new_token",
      scope: "read_products",
    });

    await sessionStorage.storeSession(session);

    // CRITICAL: needsReauth must be cleared to false
    const afterSession = await prisma.session.findUnique({
      where: { id: TEST_SESSION_ID },
      select: { needsReauth: true, accessToken: true },
    });
    expect(afterSession?.needsReauth).toBe(false);
    expect(afterSession?.accessToken).toBe("shpat_new_token");
  });
});
