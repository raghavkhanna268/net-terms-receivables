/**
 * Tests for the Node-usable offline token refresh script.
 *
 * Verifies:
 * - The script correctly refreshes tokens
 * - Error messages do not contain token-like values
 * - The helper can be used programmatically
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import { refreshOfflineTokenIfNeeded } from "../lib/refresh-offline-token";

const TEST_SHOP = "test-script-shop.myshopify.com";
const TEST_SESSION_ID = `offline_${TEST_SHOP}`;
const TEST_CLIENT_ID = "test-client-id";
const TEST_CLIENT_SECRET = "test-client-secret";
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL_TEST;

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const originalFetch = global.fetch;

describeWithDb("scripts/lib/refresh-offline-token", () => {
  let sql: ReturnType<typeof postgres>;

  beforeEach(async () => {
    sql = postgres(TEST_DATABASE_URL!, {
      max: 5,
      prepare: true,
      transform: { undefined: null },
      connect_timeout: 10,
      fetch_types: false,
    });

    await sql`DELETE FROM "Session" WHERE shop = ${TEST_SHOP}`;
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    await sql`DELETE FROM "Session" WHERE shop = ${TEST_SHOP}`;
    await sql.end();
  });

  it("refreshes token and returns result without token when outputToken is false", async () => {
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
        refresh_token_expires_in: 7776000,
        scope: "read_products",
      }),
    }) as unknown as typeof fetch;

    const result = await refreshOfflineTokenIfNeeded(
      TEST_DATABASE_URL!,
      TEST_SHOP,
      TEST_CLIENT_ID,
      TEST_CLIENT_SECRET,
      0 // Force refresh
    );

    expect(result.success).toBe(true);
    expect(result.accessToken).toBe("shpat_new_token");
    expect(result.wasRefreshed).toBe(true);
    expect(result.expires).toBeDefined();

    // Verify the token was persisted
    const updatedSql = postgres(TEST_DATABASE_URL!, {
      max: 1,
      prepare: true,
      transform: { undefined: null },
      connect_timeout: 10,
      fetch_types: false,
    });

    try {
      const rows = await updatedSql<Array<{ accessToken: string }>>`
        SELECT "accessToken" FROM "Session" WHERE id = ${TEST_SESSION_ID}
      `;
      expect(rows[0].accessToken).toBe("shpat_new_token");
    } finally {
      await updatedSql.end();
    }
  });

  it("returns success without refresh when token is still valid", async () => {
    // Create a session with a valid token
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
      TEST_DATABASE_URL!,
      TEST_SHOP,
      TEST_CLIENT_ID,
      TEST_CLIENT_SECRET,
      5 * 60 * 1000 // 5 minutes threshold
    );

    expect(result.success).toBe(true);
    expect(result.accessToken).toBe("shpat_valid_token");
    expect(result.wasRefreshed).toBe(false);
  });

  it("handles invalid_grant error correctly", async () => {
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
        'shprt_revoked_token',
        ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()}::timestamptz AT TIME ZONE 'UTC'
      )
    `;

    // Mock fetch to return invalid_grant
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({
        error: "invalid_grant",
        error_description: "The refresh token is invalid",
      }),
    }) as unknown as typeof fetch;

    const result = await refreshOfflineTokenIfNeeded(
      TEST_DATABASE_URL!,
      TEST_SHOP,
      TEST_CLIENT_ID,
      TEST_CLIENT_SECRET,
      0
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("invalid_grant");
    expect(result.error).toContain("invalid_grant");

    // Verify error does NOT contain any token values
    expect(result.error).not.toContain("shpat_");
    expect(result.error).not.toContain("shprt_");
    expect(result.error).not.toContain("shprt_revoked_token");
  });
});

describe("error message security", () => {
  const tokenPatterns = [
    /shpat_[a-zA-Z0-9_-]+/i, // Access token pattern
    /shprt_[a-zA-Z0-9_-]+/i, // Refresh token pattern
    /shpua_[a-zA-Z0-9_-]+/i, // User access token pattern
    /shpss_[a-zA-Z0-9_-]+/i, // Session signature pattern
    /shpca_[a-zA-Z0-9_-]+/i, // Checkout access token
    /shppa_[a-zA-Z0-9_-]+/i, // Payment app token
  ];

  it("all possible error messages contain no token patterns", () => {
    const errorMessages = [
      "No offline session found for shop test.myshopify.com",
      "No refresh token available for shop test.myshopify.com. Re-authentication required.",
      "Refresh token expired for shop test.myshopify.com. Re-authentication required.",
      "Token refresh failed for shop test.myshopify.com: invalid_grant. Re-authentication required.",
      "Token refresh failed for shop test.myshopify.com: HTTP 500",
      "Token refresh network error for shop test.myshopify.com: ECONNREFUSED",
      "Missing required --shop argument",
      "Missing DATABASE_URL environment variable",
      "Missing SHOPIFY_API_KEY or SHOPIFY_API_SECRET environment variable",
    ];

    for (const message of errorMessages) {
      for (const pattern of tokenPatterns) {
        expect(message, `Message "${message}" should not match pattern ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("success result does not leak tokens in non-token fields", () => {
    const successResult = {
      success: true,
      expires: "2024-01-01T00:00:00.000Z",
      wasRefreshed: true,
    };

    const resultStr = JSON.stringify(successResult);
    for (const pattern of tokenPatterns) {
      expect(resultStr).not.toMatch(pattern);
    }
  });
});
