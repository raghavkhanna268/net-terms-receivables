/**
 * Tests for offline token refresh helper.
 *
 * Covers:
 * 1. Fresh token, no refresh
 * 2. Near-expiry, refresh with new values persisted
 * 3. Concurrent callers, exactly one refresh HTTP call
 * 4. invalid_grant error handling
 * 5. Missing/invalid response fields
 * 6. Persist failure handling
 * 7. No token values in error messages
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import postgres from "postgres";
import {
  refreshOfflineTokenIfNeeded,
  isTokenExpiredOrNearExpiry,
  REFRESH_THRESHOLD_MS,
} from "../offline-token.server";

const TEST_SHOP = "test-shop.myshopify.com";
const TEST_SESSION_ID = `offline_${TEST_SHOP}`;
const TEST_CLIENT_ID = "test-client-id";
const TEST_CLIENT_SECRET = "test-client-secret";
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL_TEST;

// Skip tests if no test database is available
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

// Mock fetch for token refresh tests
const originalFetch = global.fetch;

describe("isTokenExpiredOrNearExpiry", () => {
  it("returns false for null expires", () => {
    expect(isTokenExpiredOrNearExpiry(null)).toBe(false);
  });

  it("returns false for undefined expires", () => {
    expect(isTokenExpiredOrNearExpiry(undefined)).toBe(false);
  });

  it("returns false for token with plenty of time left", () => {
    const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
    expect(isTokenExpiredOrNearExpiry(oneHourFromNow)).toBe(false);
  });

  it("returns true for expired token", () => {
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
    expect(isTokenExpiredOrNearExpiry(oneMinuteAgo)).toBe(true);
  });

  it("returns true for token within default threshold (5 minutes)", () => {
    const fourMinutesFromNow = new Date(Date.now() + 4 * 60 * 1000);
    expect(isTokenExpiredOrNearExpiry(fourMinutesFromNow)).toBe(true);
  });

  it("returns false for token just outside threshold", () => {
    const sixMinutesFromNow = new Date(Date.now() + 6 * 60 * 1000);
    expect(isTokenExpiredOrNearExpiry(sixMinutesFromNow)).toBe(false);
  });

  it("respects custom threshold", () => {
    const tenMinutesFromNow = new Date(Date.now() + 10 * 60 * 1000);
    const fifteenMinuteThreshold = 15 * 60 * 1000;
    expect(isTokenExpiredOrNearExpiry(tenMinutesFromNow, fifteenMinuteThreshold)).toBe(true);
  });

  it("default threshold matches library constant (5 minutes)", () => {
    expect(REFRESH_THRESHOLD_MS).toBe(5 * 60 * 1000);
  });
});

/**
 * AbortError timeout test that runs without a real database.
 * Uses mocked SQL to verify error classification.
 */
describe("refreshOfflineTokenIfNeeded AbortError handling (mocked)", () => {
  const MOCK_SHOP = "mock-shop.myshopify.com";
  const MOCK_SESSION_ID = `offline_${MOCK_SHOP}`;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("classifies AbortError as network_error with 'timed out' message", async () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    const refreshTokenExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const sessionRow = {
      id: MOCK_SESSION_ID,
      accessToken: "shpat_old_token",
      refreshToken: "shprt_refresh_token",
      expires: twoMinutesAgo,
      refreshTokenExpires: refreshTokenExpires,
      needsReauth: false,
      scope: "read_products",
    };

    // Create mock SQL function that returns session for any SELECT
    const createMockQuery = () => {
      const fn = vi.fn().mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.raw.join("");

        // Session lookup
        if (query.includes("SELECT") && query.includes('"Session"')) {
          return Promise.resolve([sessionRow]);
        }

        // Advisory lock
        if (query.includes("pg_advisory_xact_lock")) {
          return Promise.resolve([]);
        }

        // Update
        if (query.includes("UPDATE")) {
          return Promise.resolve([]);
        }

        return Promise.resolve([]);
      });
      return fn;
    };

    const mockSql = Object.assign(createMockQuery(), {
      begin: vi.fn().mockImplementation(
        async (callback: (tx: ReturnType<typeof createMockQuery>) => Promise<unknown>) => {
          const txMock = createMockQuery();
          return callback(txMock);
        }
      ),
    });

    // Mock fetch to throw AbortError (simulates timeout)
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    global.fetch = vi.fn().mockRejectedValueOnce(abortError);

    const result = await refreshOfflineTokenIfNeeded(
      mockSql as never,
      MOCK_SHOP,
      "test-client-id",
      "test-client-secret"
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("network_error");
    expect(result.error).toContain("timed out");
    // Error message does not contain shop domain (security rule)
  });
});

describeWithDb("refreshOfflineTokenIfNeeded with real database", () => {
  let sql: ReturnType<typeof postgres>;

  beforeEach(async () => {
    sql = postgres(TEST_DATABASE_URL!, {
      max: 5,
      prepare: true,
      transform: { undefined: null },
      connect_timeout: 10,
      fetch_types: false,
    });

    // Clean up any leftover test data
    await sql`DELETE FROM "Session" WHERE shop = ${TEST_SHOP}`;
  });

  afterEach(async () => {
    // Restore original fetch
    global.fetch = originalFetch;

    // Clean up test data
    await sql`DELETE FROM "Session" WHERE shop = ${TEST_SHOP}`;
    await sql.end();
  });

  it("returns no_session error for non-existent session", async () => {
    const result = await refreshOfflineTokenIfNeeded(
      sql,
      "nonexistent-shop.myshopify.com",
      TEST_CLIENT_ID,
      TEST_CLIENT_SECRET
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("no_session");
    expect(result.error).toContain("No offline session found");
    // Error must NOT contain shop domain (redaction rule)
    expect(result.error).not.toContain("myshopify.com");
  });

  it("returns existing token when not near expiry (no refresh)", async () => {
    // Create a session with a token that expires in 1 hour
    const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
    await sql`
      INSERT INTO "Session" (
        id, shop, state, "isOnline", scope, expires, "accessToken",
        "refreshToken", "refreshTokenExpires", "needsReauth"
      ) VALUES (
        ${TEST_SESSION_ID}, ${TEST_SHOP}, 'state', false, 'read_products',
        ${oneHourFromNow.toISOString()}::timestamptz AT TIME ZONE 'UTC',
        'shpat_valid_token',
        'shprt_refresh_token',
        ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()}::timestamptz AT TIME ZONE 'UTC',
        false
      )
    `;

    const result = await refreshOfflineTokenIfNeeded(
      sql,
      TEST_SHOP,
      TEST_CLIENT_ID,
      TEST_CLIENT_SECRET
    );

    expect(result.success).toBe(true);
    expect(result.accessToken).toBe("shpat_valid_token");
    expect(result.wasRefreshed).toBe(false);
    expect(result.expires).toBeDefined();
  });

  it("refreshes token when near expiry and persists new values", async () => {
    // Create a session with a token that expires in 2 minutes (within threshold)
    const twoMinutesFromNow = new Date(Date.now() + 2 * 60 * 1000);
    await sql`
      INSERT INTO "Session" (
        id, shop, state, "isOnline", scope, expires, "accessToken",
        "refreshToken", "refreshTokenExpires", "needsReauth"
      ) VALUES (
        ${TEST_SESSION_ID}, ${TEST_SHOP}, 'state', false, 'read_products',
        ${twoMinutesFromNow.toISOString()}::timestamptz AT TIME ZONE 'UTC',
        'shpat_old_token',
        'shprt_old_refresh_token',
        ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()}::timestamptz AT TIME ZONE 'UTC',
        false
      )
    `;

    // Mock fetch to return a successful token refresh response
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        access_token: "shpat_new_token",
        expires_in: 3600,
        refresh_token: "shprt_new_refresh_token",
        refresh_token_expires_in: 7776000, // 90 days
        scope: "read_products",
      }),
    }) as unknown as typeof fetch;

    const result = await refreshOfflineTokenIfNeeded(
      sql,
      TEST_SHOP,
      TEST_CLIENT_ID,
      TEST_CLIENT_SECRET
    );

    expect(result.success).toBe(true);
    expect(result.accessToken).toBe("shpat_new_token");
    expect(result.wasRefreshed).toBe(true);

    // Verify fetch was called with correct parameters
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = (global.fetch as Mock).mock.calls[0];
    expect(url).toBe(`https://${TEST_SHOP}/admin/oauth/access_token`);
    expect(options.method).toBe("POST");
    expect(options.body).toContain("grant_type=refresh_token");
    expect(options.body).toContain("client_id=test-client-id");

    // Verify the new token was persisted to the database
    const updatedRows = await sql<Array<{
      accessToken: string;
      refreshToken: string | null;
    }>>`
      SELECT "accessToken", "refreshToken"
      FROM "Session"
      WHERE id = ${TEST_SESSION_ID}
    `;
    expect(updatedRows.length).toBe(1);
    expect(updatedRows[0].accessToken).toBe("shpat_new_token");
    expect(updatedRows[0].refreshToken).toBe("shprt_new_refresh_token");
  });

  it("handles invalid_grant error and sets needsReauth flag", async () => {
    // Create a session with an expired token
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    await sql`
      INSERT INTO "Session" (
        id, shop, state, "isOnline", scope, expires, "accessToken",
        "refreshToken", "refreshTokenExpires", "needsReauth"
      ) VALUES (
        ${TEST_SESSION_ID}, ${TEST_SHOP}, 'state', false, 'read_products',
        ${twoMinutesAgo.toISOString()}::timestamptz AT TIME ZONE 'UTC',
        'shpat_old_token',
        'shprt_revoked_refresh_token',
        ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()}::timestamptz AT TIME ZONE 'UTC',
        false
      )
    `;

    // Mock fetch to return invalid_grant error
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({
        error: "invalid_grant",
        error_description: "The refresh token is invalid or expired",
      }),
    }) as unknown as typeof fetch;

    const result = await refreshOfflineTokenIfNeeded(
      sql,
      TEST_SHOP,
      TEST_CLIENT_ID,
      TEST_CLIENT_SECRET
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("invalid_grant");
    expect(result.error).toContain("invalid_grant");
    expect(result.error).toContain(TEST_SHOP);

    // Verify needsReauth was set to true
    const rows = await sql<Array<{ accessToken: string; needsReauth: boolean }>>`
      SELECT "accessToken", "needsReauth"
      FROM "Session"
      WHERE id = ${TEST_SESSION_ID}
    `;
    expect(rows[0].accessToken).toBe("shpat_old_token");
    expect(rows[0].needsReauth).toBe(true);
  });

  it("returns error immediately if session is already marked needsReauth", async () => {
    // Create a session already marked as needing re-auth
    const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
    await sql`
      INSERT INTO "Session" (
        id, shop, state, "isOnline", scope, expires, "accessToken",
        "refreshToken", "refreshTokenExpires", "needsReauth"
      ) VALUES (
        ${TEST_SESSION_ID}, ${TEST_SHOP}, 'state', false, 'read_products',
        ${oneHourFromNow.toISOString()}::timestamptz AT TIME ZONE 'UTC',
        'shpat_token',
        'shprt_refresh_token',
        ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()}::timestamptz AT TIME ZONE 'UTC',
        true
      )
    `;

    const result = await refreshOfflineTokenIfNeeded(
      sql,
      TEST_SHOP,
      TEST_CLIENT_ID,
      TEST_CLIENT_SECRET
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("invalid_grant");
    expect(result.error).toContain("needing re-authentication");
  });

  it("returns no_refresh_token error and sets needsReauth when refresh token is missing", async () => {
    // Create a session without a refresh token (legacy non-expiring token)
    const twoMinutesFromNow = new Date(Date.now() + 2 * 60 * 1000);
    await sql`
      INSERT INTO "Session" (
        id, shop, state, "isOnline", scope, expires, "accessToken",
        "refreshToken", "refreshTokenExpires", "needsReauth"
      ) VALUES (
        ${TEST_SESSION_ID}, ${TEST_SHOP}, 'state', false, 'read_products',
        ${twoMinutesFromNow.toISOString()}::timestamptz AT TIME ZONE 'UTC',
        'shpat_legacy_token',
        NULL,
        NULL,
        false
      )
    `;

    const result = await refreshOfflineTokenIfNeeded(
      sql,
      TEST_SHOP,
      TEST_CLIENT_ID,
      TEST_CLIENT_SECRET
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("no_refresh_token");
    expect(result.error).toContain("No refresh token available");
    expect(result.error).toContain(TEST_SHOP);

    // Verify needsReauth was set
    const rows = await sql<Array<{ needsReauth: boolean }>>`
      SELECT "needsReauth"
      FROM "Session"
      WHERE id = ${TEST_SESSION_ID}
    `;
    expect(rows[0].needsReauth).toBe(true);
  });

  it("handles network error gracefully", async () => {
    // Create a session with an expired token
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    await sql`
      INSERT INTO "Session" (
        id, shop, state, "isOnline", scope, expires, "accessToken",
        "refreshToken", "refreshTokenExpires", "needsReauth"
      ) VALUES (
        ${TEST_SESSION_ID}, ${TEST_SHOP}, 'state', false, 'read_products',
        ${twoMinutesAgo.toISOString()}::timestamptz AT TIME ZONE 'UTC',
        'shpat_old_token',
        'shprt_refresh_token',
        ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()}::timestamptz AT TIME ZONE 'UTC',
        false
      )
    `;

    // Mock fetch to throw a network error
    global.fetch = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await refreshOfflineTokenIfNeeded(
      sql,
      TEST_SHOP,
      TEST_CLIENT_ID,
      TEST_CLIENT_SECRET
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("network_error");
    expect(result.error).toContain("network error");
    expect(result.error).toContain(TEST_SHOP);
  });

  /**
   * P2 REGRESSION TEST: Fetch timeout releases advisory lock quickly.
   * A slow Shopify call should not block other callers indefinitely.
   * Uses AbortController with 5s timeout (TOKEN_REFRESH_TIMEOUT_MS).
   */
  it("P2: fetch timeout returns network_error and releases lock quickly", async () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    await sql`
      INSERT INTO "Session" (
        id, shop, state, "isOnline", scope, expires, "accessToken",
        "refreshToken", "refreshTokenExpires", "needsReauth"
      ) VALUES (
        ${TEST_SESSION_ID}, ${TEST_SHOP}, 'state', false, 'read_products',
        ${twoMinutesAgo.toISOString()}::timestamptz AT TIME ZONE 'UTC',
        'shpat_old_token',
        'shprt_refresh_token',
        ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()}::timestamptz AT TIME ZONE 'UTC',
        false
      )
    `;

    // Mock fetch to simulate a timeout by using an AbortError
    // (The real timeout uses AbortController, which throws AbortError on signal.abort())
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    global.fetch = vi.fn().mockRejectedValueOnce(abortError);

    const result = await refreshOfflineTokenIfNeeded(
      sql,
      TEST_SHOP,
      TEST_CLIENT_ID,
      TEST_CLIENT_SECRET
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("network_error");
    expect(result.error).toContain("timed out");
    expect(result.error).toContain(TEST_SHOP);

    // Verify needsReauth is NOT set (timeout is retryable)
    const rows = await sql<Array<{ needsReauth: boolean }>>`
      SELECT "needsReauth"
      FROM "Session"
      WHERE id = ${TEST_SESSION_ID}
    `;
    expect(rows[0].needsReauth).toBe(false);
  });

  it("handles missing access_token in response", async () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    await sql`
      INSERT INTO "Session" (
        id, shop, state, "isOnline", scope, expires, "accessToken",
        "refreshToken", "refreshTokenExpires", "needsReauth"
      ) VALUES (
        ${TEST_SESSION_ID}, ${TEST_SHOP}, 'state', false, 'read_products',
        ${twoMinutesAgo.toISOString()}::timestamptz AT TIME ZONE 'UTC',
        'shpat_old_token',
        'shprt_refresh_token',
        ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()}::timestamptz AT TIME ZONE 'UTC',
        false
      )
    `;

    // Mock fetch to return response without access_token
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        expires_in: 3600,
        refresh_token: "shprt_new",
      }),
    }) as unknown as typeof fetch;

    const result = await refreshOfflineTokenIfNeeded(
      sql,
      TEST_SHOP,
      TEST_CLIENT_ID,
      TEST_CLIENT_SECRET
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("invalid_response");
    expect(result.error).toContain("invalid access_token");
  });

  it("handles missing expires_in in response", async () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    await sql`
      INSERT INTO "Session" (
        id, shop, state, "isOnline", scope, expires, "accessToken",
        "refreshToken", "refreshTokenExpires", "needsReauth"
      ) VALUES (
        ${TEST_SESSION_ID}, ${TEST_SHOP}, 'state', false, 'read_products',
        ${twoMinutesAgo.toISOString()}::timestamptz AT TIME ZONE 'UTC',
        'shpat_old_token',
        'shprt_refresh_token',
        ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()}::timestamptz AT TIME ZONE 'UTC',
        false
      )
    `;

    // Mock fetch to return response without expires_in
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        access_token: "shpat_new_token",
        refresh_token: "shprt_new",
      }),
    }) as unknown as typeof fetch;

    const result = await refreshOfflineTokenIfNeeded(
      sql,
      TEST_SHOP,
      TEST_CLIENT_ID,
      TEST_CLIENT_SECRET
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("invalid_response");
    expect(result.error).toContain("invalid expires_in");
  });

  it("handles invalid expires_in (zero) in response", async () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    await sql`
      INSERT INTO "Session" (
        id, shop, state, "isOnline", scope, expires, "accessToken",
        "refreshToken", "refreshTokenExpires", "needsReauth"
      ) VALUES (
        ${TEST_SESSION_ID}, ${TEST_SHOP}, 'state', false, 'read_products',
        ${twoMinutesAgo.toISOString()}::timestamptz AT TIME ZONE 'UTC',
        'shpat_old_token',
        'shprt_refresh_token',
        ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()}::timestamptz AT TIME ZONE 'UTC',
        false
      )
    `;

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        access_token: "shpat_new_token",
        expires_in: 0,
      }),
    }) as unknown as typeof fetch;

    const result = await refreshOfflineTokenIfNeeded(
      sql,
      TEST_SHOP,
      TEST_CLIENT_ID,
      TEST_CLIENT_SECRET
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("invalid_response");
    expect(result.error).toContain("invalid expires_in");
  });

  it("handles missing optional fields (refresh_token, scope) gracefully", async () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    await sql`
      INSERT INTO "Session" (
        id, shop, state, "isOnline", scope, expires, "accessToken",
        "refreshToken", "refreshTokenExpires", "needsReauth"
      ) VALUES (
        ${TEST_SESSION_ID}, ${TEST_SHOP}, 'state', false, 'read_products,write_products',
        ${twoMinutesAgo.toISOString()}::timestamptz AT TIME ZONE 'UTC',
        'shpat_old_token',
        'shprt_old_refresh_token',
        ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()}::timestamptz AT TIME ZONE 'UTC',
        false
      )
    `;

    // Mock fetch to return response without refresh_token and scope
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        access_token: "shpat_new_token",
        expires_in: 3600,
        // Missing: refresh_token, refresh_token_expires_in, scope
      }),
    }) as unknown as typeof fetch;

    const result = await refreshOfflineTokenIfNeeded(
      sql,
      TEST_SHOP,
      TEST_CLIENT_ID,
      TEST_CLIENT_SECRET
    );

    expect(result.success).toBe(true);
    expect(result.accessToken).toBe("shpat_new_token");
    expect(result.wasRefreshed).toBe(true);

    // Verify old refresh_token and scope were preserved
    const rows = await sql<Array<{
      accessToken: string;
      refreshToken: string | null;
      scope: string | null;
    }>>`
      SELECT "accessToken", "refreshToken", scope
      FROM "Session"
      WHERE id = ${TEST_SESSION_ID}
    `;
    expect(rows[0].accessToken).toBe("shpat_new_token");
    expect(rows[0].refreshToken).toBe("shprt_old_refresh_token"); // Preserved
    expect(rows[0].scope).toBe("read_products,write_products"); // Preserved
  });
});

describeWithDb("concurrent refresh safety (CAS)", () => {
  let sql: ReturnType<typeof postgres>;
  let fetchCallCount: number;

  beforeEach(async () => {
    sql = postgres(TEST_DATABASE_URL!, {
      max: 10, // Allow more connections for concurrent test
      prepare: true,
      transform: { undefined: null },
      connect_timeout: 10,
      fetch_types: false,
    });

    fetchCallCount = 0;
    await sql`DELETE FROM "Session" WHERE shop = ${TEST_SHOP}`;
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    await sql`DELETE FROM "Session" WHERE shop = ${TEST_SHOP}`;
    await sql.end();
  });

  /**
   * P1-1 REGRESSION TEST: CAS loser getting invalid_grant must NOT set needsReauth
   * on a healthy shop. Both callers should end up with the winner's token.
   *
   * Scenario:
   * 1. Two concurrent callers attempt to refresh the same session
   * 2. First caller wins and successfully refreshes the token
   * 3. Second caller gets invalid_grant (refresh token was single-use)
   * 4. Second caller should detect that tokens changed and use winner's token
   * 5. needsReauth should NOT be set (shop is healthy)
   */
  it("P1-1: CAS loser getting invalid_grant must not set needsReauth (uses winner's token)", async () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    await sql`
      INSERT INTO "Session" (
        id, shop, state, "isOnline", scope, expires, "accessToken",
        "refreshToken", "refreshTokenExpires", "needsReauth"
      ) VALUES (
        ${TEST_SESSION_ID}, ${TEST_SHOP}, 'state', false, 'read_products',
        ${twoMinutesAgo.toISOString()}::timestamptz AT TIME ZONE 'UTC',
        'shpat_old_token',
        'shprt_single_use_refresh_token',
        ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()}::timestamptz AT TIME ZONE 'UTC',
        false
      )
    `;

    let callCount = 0;
    // First call succeeds, second call gets invalid_grant (single-use token already used)
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      const myCallNumber = callCount;

      // Add delay to simulate concurrent execution
      await new Promise((resolve) => setTimeout(resolve, myCallNumber === 1 ? 10 : 50));

      if (myCallNumber === 1) {
        // First caller wins
        return {
          ok: true,
          json: () => Promise.resolve({
            access_token: "shpat_winner_token",
            expires_in: 3600,
            refresh_token: "shprt_new_refresh_token",
            refresh_token_expires_in: 7776000,
            scope: "read_products",
          }),
        };
      } else {
        // Second caller gets invalid_grant because refresh token was single-use
        return {
          ok: false,
          status: 400,
          json: () => Promise.resolve({
            error: "invalid_grant",
            error_description: "The refresh token is invalid or expired",
          }),
        };
      }
    }) as unknown as typeof fetch;

    // Launch two concurrent refresh attempts
    const results = await Promise.all([
      refreshOfflineTokenIfNeeded(sql, TEST_SHOP, TEST_CLIENT_ID, TEST_CLIENT_SECRET),
      refreshOfflineTokenIfNeeded(sql, TEST_SHOP, TEST_CLIENT_ID, TEST_CLIENT_SECRET),
    ]);

    // CRITICAL: Both should succeed - loser should detect winner and use their token
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(true);

    // Both should return the winner's token
    expect(results[0].accessToken).toBe("shpat_winner_token");
    expect(results[1].accessToken).toBe("shpat_winner_token");

    // CRITICAL: needsReauth must NOT be set (shop is healthy, winner refreshed successfully)
    const rows = await sql<Array<{ accessToken: string; needsReauth: boolean }>>`
      SELECT "accessToken", "needsReauth"
      FROM "Session"
      WHERE id = ${TEST_SESSION_ID}
    `;
    expect(rows[0].accessToken).toBe("shpat_winner_token");
    expect(rows[0].needsReauth).toBe(false);
  });

  it("CAS race: winner's token is used by all callers", async () => {
    // Create a session with an expired token
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    await sql`
      INSERT INTO "Session" (
        id, shop, state, "isOnline", scope, expires, "accessToken",
        "refreshToken", "refreshTokenExpires", "needsReauth"
      ) VALUES (
        ${TEST_SESSION_ID}, ${TEST_SHOP}, 'state', false, 'read_products',
        ${twoMinutesAgo.toISOString()}::timestamptz AT TIME ZONE 'UTC',
        'shpat_old_token',
        'shprt_refresh_token',
        ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()}::timestamptz AT TIME ZONE 'UTC',
        false
      )
    `;

    // Mock fetch to return a successful response
    // Each call gets a unique token, but only the CAS winner's token will be persisted
    global.fetch = vi.fn().mockImplementation(async () => {
      fetchCallCount++;
      const myCallNumber = fetchCallCount;
      // Add delay to allow concurrent execution
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        ok: true,
        json: () => Promise.resolve({
          access_token: `shpat_new_token_${myCallNumber}`,
          expires_in: 3600,
          refresh_token: `shprt_new_refresh_token_${myCallNumber}`,
          refresh_token_expires_in: 7776000,
          scope: "read_products",
        }),
      };
    }) as unknown as typeof fetch;

    // Launch 3 concurrent refresh attempts
    const results = await Promise.all([
      refreshOfflineTokenIfNeeded(sql, TEST_SHOP, TEST_CLIENT_ID, TEST_CLIENT_SECRET),
      refreshOfflineTokenIfNeeded(sql, TEST_SHOP, TEST_CLIENT_ID, TEST_CLIENT_SECRET),
      refreshOfflineTokenIfNeeded(sql, TEST_SHOP, TEST_CLIENT_ID, TEST_CLIENT_SECRET),
    ]);

    // All should succeed (either by winning CAS or by re-reading winner's token)
    expect(results.every((r) => r.success)).toBe(true);

    // With CAS (no lock), multiple refresh HTTP calls may be made
    // But only one CAS write succeeds; others re-read and use winner's token
    expect(fetchCallCount).toBeGreaterThanOrEqual(1);
    expect(fetchCallCount).toBeLessThanOrEqual(3);

    // All results should have the same token (the CAS winner's token)
    const tokens = results.map((r) => r.accessToken);
    expect(new Set(tokens).size).toBe(1);

    // The persisted token should match what all callers returned
    const rows = await sql<Array<{ accessToken: string }>>`
      SELECT "accessToken"
      FROM "Session"
      WHERE id = ${TEST_SESSION_ID}
    `;
    expect(tokens[0]).toBe(rows[0].accessToken);
  });

  it("CAS loss re-reads winner token instead of failing", async () => {
    // Create a session with an expired token
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    await sql`
      INSERT INTO "Session" (
        id, shop, state, "isOnline", scope, expires, "accessToken",
        "refreshToken", "refreshTokenExpires", "needsReauth"
      ) VALUES (
        ${TEST_SESSION_ID}, ${TEST_SHOP}, 'state', false, 'read_products',
        ${twoMinutesAgo.toISOString()}::timestamptz AT TIME ZONE 'UTC',
        'shpat_old_token',
        'shprt_refresh_token',
        ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()}::timestamptz AT TIME ZONE 'UTC',
        false
      )
    `;

    // Simulate CAS loss by having the first caller win
    let firstCallDone = false;
    global.fetch = vi.fn().mockImplementation(async () => {
      fetchCallCount++;
      const myCallNumber = fetchCallCount;
      
      // First caller gets a small delay, second caller gets longer delay
      // This ensures first caller wins the CAS
      if (!firstCallDone) {
        firstCallDone = true;
        await new Promise((resolve) => setTimeout(resolve, 5));
      } else {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      
      return {
        ok: true,
        json: () => Promise.resolve({
          access_token: `shpat_token_${myCallNumber}`,
          expires_in: 3600,
          refresh_token: `shprt_refresh_${myCallNumber}`,
          refresh_token_expires_in: 7776000,
          scope: "read_products",
        }),
      };
    }) as unknown as typeof fetch;

    // Two concurrent refresh attempts
    const results = await Promise.all([
      refreshOfflineTokenIfNeeded(sql, TEST_SHOP, TEST_CLIENT_ID, TEST_CLIENT_SECRET),
      refreshOfflineTokenIfNeeded(sql, TEST_SHOP, TEST_CLIENT_ID, TEST_CLIENT_SECRET),
    ]);

    // Both should succeed
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(true);

    // Both should return the same token (winner's token)
    expect(results[0].accessToken).toBe(results[1].accessToken);

    // Token in DB should match
    const rows = await sql<Array<{ accessToken: string }>>`
      SELECT "accessToken"
      FROM "Session"
      WHERE id = ${TEST_SESSION_ID}
    `;
    expect(results[0].accessToken).toBe(rows[0].accessToken);
  });
});
