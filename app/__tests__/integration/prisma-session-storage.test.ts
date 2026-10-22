import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { Session } from "@shopify/shopify-api";

/**
 * Integration test for Prisma session storage with a real PostgreSQL database.
 *
 * This test verifies the complete data path that the Worker uses:
 * 1. PrismaClient with @prisma/adapter-pg driver adapter
 * 2. PrismaSessionStorage from @shopify/shopify-app-session-storage-prisma
 * 3. Full CRUD operations: store, load, findSessionsByShop, deleteSessions
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
  let sessionStorage: PrismaSessionStorage<PrismaClient>;

  const TEST_SHOP = "test-integration-shop.myshopify.com";
  const TEST_SESSION_ID = "test-session-id-" + Date.now();

  beforeAll(async () => {
    // Create PrismaClient using the same adapter pattern as workers/app.ts
    // This proves the @prisma/adapter-pg path works with real Postgres
    const adapter = new PrismaPg({ connectionString: TEST_DATABASE_URL! });
    prisma = new PrismaClient({ adapter });

    // Create session storage the same way shopify.server.ts does
    sessionStorage = new PrismaSessionStorage(prisma);

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
});
