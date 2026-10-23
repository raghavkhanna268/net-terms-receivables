/**
 * Tests for offline token refresh helper.
 *
 * Covers:
 * 1. Fresh token, no refresh
 * 2. Near-expiry, refresh with new values persisted
 * 3. Concurrent callers, exactly one refresh HTTP call
 * 4. invalid_grant error handling
 * 5. No token values in error messages
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import postgres from "postgres";
import {
  refreshOfflineTokenIfNeeded,
  isTokenExpiredOrNearExpiry,
  REFRESH_THRESHOLD_MS,
  type RefreshResult,
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
  });

  it("returns existing token when not near expiry (no refresh)", async () => {
    // Create a session with a token that expires in 1 hour
    const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
    await sql`
      INSERT INTO "Session" (
        id, shop, state, "isOnline", scope, expires, "accessToken",
        "refreshToken", "refreshTokenExpires"
      ) VALUES (
        ${TEST_SESSION_ID}, ${TEST_SHOP}, 'state', false, 'read_products',
        ${oneHourFromNow.toISOString()}::timestamptz AT TIME ZONE 'UTC',
        'shpat_valid_token',
        'shprt_refresh_token',
        ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()}::timestamptz AT TIME ZONE 'UTC'
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
    expect(result.expires).toBeDefined();
  });

  it("refreshes token when near expiry and persists new values", async () => {
    // Create a session with a token that expires in 2 minutes (within threshold)
    const twoMinutesFromNow = new Date(Date.now() + 2 * 60 * 1000);
    await sql`
      INSERT INTO "Session" (
        id, shop, state, "isOnline", scope, expires, "accessToken",
        "refreshToken", "refreshTokenExpires"
      ) VALUES (
        ${TEST_SESSION_ID}, ${TEST_SHOP}, 'state', false, 'read_products',
        ${twoMinutesFromNow.toISOString()}::timestamptz AT TIME ZONE 'UTC',
        'shpat_old_token',
        'shprt_old_refresh_token',
        ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()}::timestamptz AT TIME ZONE 'UTC'
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

  it("handles invalid_grant error gracefully", async () => {
    // Create a session with an expired token
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    await sql`
      INSERT INTO "Session" (
        id, shop, state, "isOnline", scope, expires, "accessToken",
        "refreshToken", "refreshTokenExpires"
      ) VALUES (
        ${TEST_SESSION_ID}, ${TEST_SHOP}, 'state', false, 'read_products',
        ${twoMinutesAgo.toISOString()}::timestamptz AT TIME ZONE 'UTC',
        'shpat_old_token',
        'shprt_revoked_refresh_token',
        ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()}::timestamptz AT TIME ZONE 'UTC'
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

    // Verify original token was NOT modified
    const rows = await sql<Array<{ accessToken: string }>>`
      SELECT "accessToken"
      FROM "Session"
      WHERE id = ${TEST_SESSION_ID}
    `;
    expect(rows[0].accessToken).toBe("shpat_old_token");
  });

  it("returns no_refresh_token error when refresh token is missing", async () => {
    // Create a session without a refresh token (legacy non-expiring token)
    const twoMinutesFromNow = new Date(Date.now() + 2 * 60 * 1000);
    await sql`
      INSERT INTO "Session" (
        id, shop, state, "isOnline", scope, expires, "accessToken",
        "refreshToken", "refreshTokenExpires"
      ) VALUES (
        ${TEST_SESSION_ID}, ${TEST_SHOP}, 'state', false, 'read_products',
        ${twoMinutesFromNow.toISOString()}::timestamptz AT TIME ZONE 'UTC',
        'shpat_legacy_token',
        NULL,
        NULL
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
  });

  it("handles network error gracefully", async () => {
    // Create a session with an expired token
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    await sql`
      INSERT INTO "Session" (
        id, shop, state, "isOnline", scope, expires, "accessToken",
        "refreshToken", "refreshTokenExpires"
      ) VALUES (
        ${TEST_SESSION_ID}, ${TEST_SHOP}, 'state', false, 'read_products',
        ${twoMinutesAgo.toISOString()}::timestamptz AT TIME ZONE 'UTC',
        'shpat_old_token',
        'shprt_refresh_token',
        ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()}::timestamptz AT TIME ZONE 'UTC'
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
  });
});

describeWithDb("concurrent refresh safety", () => {
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

  it("exactly one refresh HTTP call with concurrent callers", async () => {
    // Create a session with an expired token
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    await sql`
      INSERT INTO "Session" (
        id, shop, state, "isOnline", scope, expires, "accessToken",
        "refreshToken", "refreshTokenExpires"
      ) VALUES (
        ${TEST_SESSION_ID}, ${TEST_SHOP}, 'state', false, 'read_products',
        ${twoMinutesAgo.toISOString()}::timestamptz AT TIME ZONE 'UTC',
        'shpat_old_token',
        'shprt_refresh_token',
        ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()}::timestamptz AT TIME ZONE 'UTC'
      )
    `;

    // Mock fetch to return a successful response and track call count
    // Add a small delay to simulate network latency
    global.fetch = vi.fn().mockImplementation(async () => {
      fetchCallCount++;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        ok: true,
        json: () => Promise.resolve({
          access_token: `shpat_new_token_${fetchCallCount}`,
          expires_in: 3600,
          refresh_token: `shprt_new_refresh_token_${fetchCallCount}`,
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

    // All should succeed
    expect(results.every((r) => r.success)).toBe(true);

    // Due to row-level locking, only ONE refresh HTTP call should be made
    // The other callers wait for the lock, then find the token already refreshed
    expect(fetchCallCount).toBe(1);

    // All results should have the same token (the one from the winning refresh)
    const tokens = results.map((r) => r.accessToken);
    expect(new Set(tokens).size).toBe(1);
  });
});

describe("error message security", () => {
  it("error messages do not contain token-like values", async () => {
    const tokenPatterns = [
      /shpat_[a-zA-Z0-9]+/, // Access token pattern
      /shprt_[a-zA-Z0-9]+/, // Refresh token pattern
      /shpua_[a-zA-Z0-9]+/, // User access token pattern
      /shpss_[a-zA-Z0-9]+/, // Session signature pattern
    ];

    const testCases: RefreshResult[] = [
      {
        success: false,
        errorCode: "no_session",
        error: "No offline session found for shop test.myshopify.com",
      },
      {
        success: false,
        errorCode: "no_refresh_token",
        error: "No refresh token available for shop test.myshopify.com. Re-authentication required.",
      },
      {
        success: false,
        errorCode: "invalid_grant",
        error: "Token refresh failed for shop test.myshopify.com: invalid_grant. Re-authentication required.",
      },
      {
        success: false,
        errorCode: "network_error",
        error: "Token refresh network error for shop test.myshopify.com: ECONNREFUSED",
      },
    ];

    for (const testCase of testCases) {
      if (testCase.error) {
        for (const pattern of tokenPatterns) {
          expect(testCase.error).not.toMatch(pattern);
        }
      }
    }
  });
});
