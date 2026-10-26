/**
 * Tests for offline-admin.server.ts
 *
 * DB-backed tests that verify:
 * 1. Two concurrent callers for the same shop with an expiring token cause exactly ONE refresh
 * 2. An expired token is refreshed before the admin client is used
 * 3. Non-retryable failures (invalid_grant, no_refresh_token, no_session) set needsReauth
 * 4. Guard test: no raw unauthenticated.admin( outside explicit allowlist
 *
 * Uses real Postgres with advisory locks to test concurrency behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import fs from "fs";
import path from "path";

const TEST_SHOP = "test-offline-admin.myshopify.com";
const TEST_SESSION_ID = `offline_${TEST_SHOP}`;
const TEST_CLIENT_ID = "test-client-id";
const TEST_CLIENT_SECRET = "test-client-secret";
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL_TEST;

// Skip tests if no test database is available
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

// Mock fetch for token refresh tests
const originalFetch = global.fetch;

// Mock shopify.server module with controllable unauthenticated.admin
const mockAdmin = {
  graphql: vi.fn(),
};

// Hoist the mock function so it can be controlled per-test
const mockUnauthenticatedAdmin = vi.hoisted(() => vi.fn());

vi.mock("~/shopify.server", () => ({
  getShopifyApp: () => ({
    unauthenticated: {
      admin: mockUnauthenticatedAdmin,
    },
  }),
}));

// Reset mock to default success behavior
function resetUnauthenticatedAdminMock() {
  mockUnauthenticatedAdmin.mockReset();
  mockUnauthenticatedAdmin.mockResolvedValue({ admin: mockAdmin });
}

// Track fetch calls for concurrency test
let fetchCallCount = 0;
let fetchCallTimestamps: number[] = [];

describeWithDb("getOfflineAdminContext (DB-backed)", () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(() => {
    sql = postgres(TEST_DATABASE_URL!, {
      max: 10,
      idle_timeout: 5,
    });
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    fetchCallCount = 0;
    fetchCallTimestamps = [];
    resetUnauthenticatedAdminMock();

    // Clean up test session
    await sql`DELETE FROM "Session" WHERE id = ${TEST_SESSION_ID}`;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  /**
   * Helper to create a test session with specified expiry.
   */
  async function createTestSession(opts: {
    accessToken?: string;
    refreshToken?: string;
    expiresInMs?: number;
    needsReauth?: boolean;
    refreshTokenExpiresInMs?: number;
  }) {
    const {
      accessToken = "shpat_old_token",
      refreshToken = "shprt_refresh_token",
      expiresInMs = -60 * 1000, // Expired by default
      needsReauth = false,
      refreshTokenExpiresInMs = 30 * 24 * 60 * 60 * 1000, // 30 days
    } = opts;

    const expires = new Date(Date.now() + expiresInMs);
    const refreshTokenExpires = new Date(Date.now() + refreshTokenExpiresInMs);

    await sql`
      INSERT INTO "Session" (
        id, shop, state, "isOnline", scope,
        "accessToken", expires, "refreshToken", "refreshTokenExpires", "needsReauth"
      ) VALUES (
        ${TEST_SESSION_ID},
        ${TEST_SHOP},
        'test-state',
        false,
        'read_products',
        ${accessToken},
        ${expires.toISOString()}::timestamptz,
        ${refreshToken},
        ${refreshTokenExpires.toISOString()}::timestamptz,
        ${needsReauth}
      )
    `;
  }

  /**
   * Mock fetch that simulates Shopify token refresh endpoint with delay.
   */
  function mockFetchWithDelay(delayMs: number) {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();

      if (urlStr.includes("/admin/oauth/access_token")) {
        fetchCallCount++;
        fetchCallTimestamps.push(Date.now());

        // Simulate network delay
        await new Promise((r) => setTimeout(r, delayMs));

        return new Response(
          JSON.stringify({
            access_token: `shpat_new_token_${fetchCallCount}`,
            expires_in: 3600,
            refresh_token: `shprt_new_refresh_${fetchCallCount}`,
            refresh_token_expires_in: 30 * 24 * 60 * 60,
            scope: "read_products",
          }),
          { status: 200 }
        );
      }

      return new Response(null, { status: 404 });
    });
  }

  /**
   * Mock fetch that simulates invalid_grant error.
   */
  function mockFetchInvalidGrant() {
    global.fetch = vi.fn(async () => {
      fetchCallCount++;
      return new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Token has been revoked",
        }),
        { status: 400 }
      );
    });
  }

  describe("Concurrent callers - exactly one refresh", () => {
    it("two concurrent callers for the same shop with an expiring token cause exactly ONE refresh", async () => {
      // Create session with expired token
      await createTestSession({
        accessToken: "shpat_expired",
        expiresInMs: -60 * 1000, // Expired 1 minute ago
      });

      // Mock fetch with 100ms delay to simulate network latency
      mockFetchWithDelay(100);

      const { getOfflineAdminContext } = await import("../offline-admin.server");

      // Start two concurrent calls
      const [result1, result2] = await Promise.all([
        getOfflineAdminContext(sql, TEST_SHOP, TEST_CLIENT_ID, TEST_CLIENT_SECRET),
        getOfflineAdminContext(sql, TEST_SHOP, TEST_CLIENT_ID, TEST_CLIENT_SECRET),
      ]);

      // Both should succeed
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      // Exactly ONE fetch call should have been made
      // The advisory lock serializes refreshes, second caller sees fresh token
      expect(fetchCallCount).toBe(1);

      // Verify the session was updated
      const [session] = await sql<{ accessToken: string }[]>`
        SELECT "accessToken" FROM "Session" WHERE id = ${TEST_SESSION_ID}
      `;
      expect(session.accessToken).toMatch(/^shpat_new_token/);
    });
  });

  describe("Expired token refresh", () => {
    it("refreshes an expired token before returning the admin client", async () => {
      // Create session with expired token
      await createTestSession({
        accessToken: "shpat_expired",
        expiresInMs: -60 * 1000, // Expired 1 minute ago
      });

      // Mock successful refresh
      mockFetchWithDelay(10);

      const { getOfflineAdminContext } = await import("../offline-admin.server");

      const result = await getOfflineAdminContext(
        sql,
        TEST_SHOP,
        TEST_CLIENT_ID,
        TEST_CLIENT_SECRET
      );

      expect(result.success).toBe(true);
      expect(result.admin).toBeDefined();

      // Verify token was refreshed
      expect(fetchCallCount).toBe(1);

      // Verify session has new token
      const [session] = await sql<{ accessToken: string }[]>`
        SELECT "accessToken" FROM "Session" WHERE id = ${TEST_SESSION_ID}
      `;
      expect(session.accessToken).toMatch(/^shpat_new_token/);
    });

    it("returns fresh admin without refresh when token is still valid", async () => {
      // Create session with fresh token (1 hour to expiry)
      await createTestSession({
        accessToken: "shpat_still_valid",
        expiresInMs: 60 * 60 * 1000, // Valid for 1 hour
      });

      mockFetchWithDelay(10);

      const { getOfflineAdminContext } = await import("../offline-admin.server");

      const result = await getOfflineAdminContext(
        sql,
        TEST_SHOP,
        TEST_CLIENT_ID,
        TEST_CLIENT_SECRET
      );

      expect(result.success).toBe(true);
      expect(result.admin).toBeDefined();

      // No refresh should have been made
      expect(fetchCallCount).toBe(0);
    });
  });

  describe("Non-retryable failures set needsReauth", () => {
    it("invalid_grant sets needsReauth and returns typed failure", async () => {
      // Create session with expired token
      await createTestSession({
        accessToken: "shpat_expired",
        expiresInMs: -60 * 1000,
      });

      // Mock invalid_grant response
      mockFetchInvalidGrant();

      const { getOfflineAdminContext } = await import("../offline-admin.server");

      const result = await getOfflineAdminContext(
        sql,
        TEST_SHOP,
        TEST_CLIENT_ID,
        TEST_CLIENT_SECRET
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("invalid_grant");
      expect(result.retryable).toBe(false);
      expect(result.needsReauth).toBe(true);

      // Verify session was marked needsReauth
      const [session] = await sql<{ needsReauth: boolean }[]>`
        SELECT "needsReauth" FROM "Session" WHERE id = ${TEST_SESSION_ID}
      `;
      expect(session.needsReauth).toBe(true);
    });

    it("no_refresh_token returns typed failure with needsReauth", async () => {
      // Create session with expired token but no refresh token
      await sql`
        INSERT INTO "Session" (
          id, shop, state, "isOnline", scope,
          "accessToken", expires, "refreshToken", "needsReauth"
        ) VALUES (
          ${TEST_SESSION_ID},
          ${TEST_SHOP},
          'test-state',
          false,
          'read_products',
          'shpat_expired',
          ${new Date(Date.now() - 60 * 1000).toISOString()}::timestamptz,
          NULL,
          false
        )
      `;

      const { getOfflineAdminContext } = await import("../offline-admin.server");

      const result = await getOfflineAdminContext(
        sql,
        TEST_SHOP,
        TEST_CLIENT_ID,
        TEST_CLIENT_SECRET
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("no_refresh_token");
      expect(result.retryable).toBe(false);
      expect(result.needsReauth).toBe(true);

      // Verify session was marked needsReauth
      const [session] = await sql<{ needsReauth: boolean }[]>`
        SELECT "needsReauth" FROM "Session" WHERE id = ${TEST_SESSION_ID}
      `;
      expect(session.needsReauth).toBe(true);
    });

    it("no_session returns typed failure with needsReauth", async () => {
      // Don't create any session - simulate shop never installed

      const { getOfflineAdminContext } = await import("../offline-admin.server");

      const result = await getOfflineAdminContext(
        sql,
        TEST_SHOP,
        TEST_CLIENT_ID,
        TEST_CLIENT_SECRET
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("no_session");
      expect(result.retryable).toBe(false);
      expect(result.needsReauth).toBe(true);
    });

    it("session already marked needsReauth returns typed failure immediately", async () => {
      // Create session already marked as needing re-auth
      await createTestSession({
        accessToken: "shpat_stale",
        expiresInMs: -60 * 1000,
        needsReauth: true,
      });

      const { getOfflineAdminContext } = await import("../offline-admin.server");

      const result = await getOfflineAdminContext(
        sql,
        TEST_SHOP,
        TEST_CLIENT_ID,
        TEST_CLIENT_SECRET
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("invalid_grant");
      expect(result.retryable).toBe(false);
      expect(result.needsReauth).toBe(true);

      // No fetch call should be made
      expect(fetchCallCount).toBe(0);
    });

    /**
     * Issue #310: 401 invalid_request must be treated as invalid_grant.
     */
    it("401 invalid_request sets needsReauth and returns non-retryable failure", async () => {
      // Create session with expired token
      await createTestSession({
        accessToken: "shpat_expired",
        expiresInMs: -60 * 1000,
      });

      // Mock 401 invalid_request response (Shopify returns this for dead refresh tokens)
      global.fetch = vi.fn(async () => {
        fetchCallCount++;
        return new Response(
          JSON.stringify({
            error: "invalid_request",
            error_description: "This request requires an active refresh_token",
          }),
          { status: 401 }
        );
      });

      const { getOfflineAdminContext } = await import("../offline-admin.server");

      const result = await getOfflineAdminContext(
        sql,
        TEST_SHOP,
        TEST_CLIENT_ID,
        TEST_CLIENT_SECRET
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("invalid_grant");
      expect(result.retryable).toBe(false);
      expect(result.needsReauth).toBe(true);

      // Verify session was marked needsReauth
      const [session] = await sql<{ needsReauth: boolean }[]>`
        SELECT "needsReauth" FROM "Session" WHERE id = ${TEST_SESSION_ID}
      `;
      expect(session.needsReauth).toBe(true);
    });

    it("5xx errors (503) are retryable and do NOT set needsReauth", async () => {
      // Create session with expired token
      await createTestSession({
        accessToken: "shpat_expired",
        expiresInMs: -60 * 1000,
      });

      // Mock 503 Service Unavailable
      global.fetch = vi.fn(async () => {
        fetchCallCount++;
        return new Response(
          JSON.stringify({
            error: "service_unavailable",
          }),
          { status: 503 }
        );
      });

      const { getOfflineAdminContext } = await import("../offline-admin.server");

      const result = await getOfflineAdminContext(
        sql,
        TEST_SHOP,
        TEST_CLIENT_ID,
        TEST_CLIENT_SECRET
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("http_error");
      expect(result.retryable).toBe(true);
      expect(result.needsReauth).toBe(false);

      // Verify needsReauth was NOT set
      const [session] = await sql<{ needsReauth: boolean }[]>`
        SELECT "needsReauth" FROM "Session" WHERE id = ${TEST_SESSION_ID}
      `;
      expect(session.needsReauth).toBe(false);
    });

    it("429 rate limit errors are retryable and do NOT set needsReauth", async () => {
      // Create session with expired token
      await createTestSession({
        accessToken: "shpat_expired",
        expiresInMs: -60 * 1000,
      });

      // Mock 429 Too Many Requests
      global.fetch = vi.fn(async () => {
        fetchCallCount++;
        return new Response(
          JSON.stringify({
            error: "too_many_requests",
          }),
          { status: 429 }
        );
      });

      const { getOfflineAdminContext } = await import("../offline-admin.server");

      const result = await getOfflineAdminContext(
        sql,
        TEST_SHOP,
        TEST_CLIENT_ID,
        TEST_CLIENT_SECRET
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("http_error");
      expect(result.retryable).toBe(true);
      expect(result.needsReauth).toBe(false);

      // Verify needsReauth was NOT set
      const [session] = await sql<{ needsReauth: boolean }[]>`
        SELECT "needsReauth" FROM "Session" WHERE id = ${TEST_SESSION_ID}
      `;
      expect(session.needsReauth).toBe(false);
    });
  });

  describe("Session error from unauthenticated.admin", () => {
    it("returns admin_session_error when unauthenticated.admin throws with 'session' in message", async () => {
      // Create session with fresh token so refresh succeeds
      await createTestSession({
        accessToken: "shpat_valid",
        expiresInMs: 60 * 60 * 1000, // Valid for 1 hour
      });

      // Make unauthenticated.admin throw a session error
      mockUnauthenticatedAdmin.mockRejectedValueOnce(new Error("session expired"));

      const { getOfflineAdminContext } = await import("../offline-admin.server");

      const result = await getOfflineAdminContext(
        sql,
        TEST_SHOP,
        TEST_CLIENT_ID,
        TEST_CLIENT_SECRET
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("admin_session_error");
      expect(result.error).toBe("Session error");
      expect(result.retryable).toBe(true);
      expect(result.needsReauth).toBe(false);
    });

    it("returns admin_session_error for various session error messages (case insensitive)", async () => {
      // Create session with fresh token
      await createTestSession({
        accessToken: "shpat_valid",
        expiresInMs: 60 * 60 * 1000,
      });

      // Test with different session error messages
      mockUnauthenticatedAdmin.mockRejectedValueOnce(new Error("Session has expired"));

      const { getOfflineAdminContext } = await import("../offline-admin.server");

      const result = await getOfflineAdminContext(
        sql,
        TEST_SHOP,
        TEST_CLIENT_ID,
        TEST_CLIENT_SECRET
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("admin_session_error");
      expect(result.retryable).toBe(true);
    });

    it("re-throws non-session errors from unauthenticated.admin", async () => {
      // Create session with fresh token
      await createTestSession({
        accessToken: "shpat_valid",
        expiresInMs: 60 * 60 * 1000,
      });

      // Make unauthenticated.admin throw a non-session error
      mockUnauthenticatedAdmin.mockRejectedValueOnce(new Error("Network timeout"));

      const { getOfflineAdminContext } = await import("../offline-admin.server");

      await expect(
        getOfflineAdminContext(sql, TEST_SHOP, TEST_CLIENT_ID, TEST_CLIENT_SECRET)
      ).rejects.toThrow("Network timeout");
    });
  });
});

describe("Guard test: no raw unauthenticated.admin( outside allowlist", () => {
  /**
   * Allowlist of files that are deferred to PR #353.
   * These files are changed by PR #353 and should not be edited in this PR.
   * TODO: Migrate these after #353 merges.
   */
  const DEFERRED_ALLOWLIST: string[] = [
    // PR #353 files that would need migration after it merges:
    // (Currently none - all PR #353 files use shopifyGraphQL which goes through getOfflineAdminContext)
  ];

  it("no raw unauthenticated.admin( calls outside the helper file and tests", () => {
    const appDir = path.join(__dirname, "../..");
    const violations: string[] = [];

    function scanDir(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Skip node_modules and test directories
          if (entry.name === "node_modules" || entry.name === "__tests__") {
            continue;
          }
          scanDir(fullPath);
        } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
          // Skip the helper file itself
          if (entry.name === "offline-admin.server.ts") {
            continue;
          }

          const content = fs.readFileSync(fullPath, "utf-8");
          const relativePath = path.relative(appDir, fullPath);

          // Search for raw unauthenticated.admin( calls
          if (content.includes("unauthenticated.admin(")) {
            // Check if it's in the allowlist
            if (!DEFERRED_ALLOWLIST.some((allowed) => relativePath.includes(allowed))) {
              violations.push(relativePath);
            }
          }
        }
      }
    }

    scanDir(appDir);

    if (violations.length > 0) {
      throw new Error(
        `Found raw unauthenticated.admin( calls outside allowlist:\n` +
          violations.map((v) => `  - ${v}`).join("\n") +
          `\n\nThese should use getOfflineAdminContext from ~/lib/offline-admin.server.ts instead.` +
          `\nIf this is a PR #353 deferred file, add it to DEFERRED_ALLOWLIST with a TODO comment.`
      );
    }
  });
});
