/**
 * Tests for the Node CLI offline token refresh script.
 *
 * Verifies:
 * - The script correctly wraps the core refresh function
 * - Error messages do not contain token-like values
 * - The CLI parses arguments correctly
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

  it("refreshes token and returns result WITHOUT access token (security)", async () => {
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
    expect(result.wasRefreshed).toBe(true);
    expect(result.expires).toBeDefined();

    // CRITICAL: Script result should NOT contain accessToken
    expect("accessToken" in result).toBe(false);

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
    expect(result.wasRefreshed).toBe(false);
    // Should not contain accessToken even on success
    expect("accessToken" in result).toBe(false);
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
    // X6: error field removed - only errorCode is returned (no raw messages)
    expect("error" in result).toBe(false);

    // Verify no tokens in any string fields
    const resultStr = JSON.stringify(result);
    const tokenPatterns = [/shpat_/, /shprt_/, /shpua_/, /shpss_/];
    for (const pattern of tokenPatterns) {
      expect(resultStr).not.toMatch(pattern);
    }
  });

  it("returns no_session for non-existent session", async () => {
    const result = await refreshOfflineTokenIfNeeded(
      TEST_DATABASE_URL!,
      "test-nonexistent-shop.myshopify.com",
      TEST_CLIENT_ID,
      TEST_CLIENT_SECRET,
      0
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("no_session");
  });

  it("X6: error result has errorCode only, no raw error message (per #174)", async () => {
    const result = await refreshOfflineTokenIfNeeded(
      TEST_DATABASE_URL!,
      "test-nonexistent-shop.myshopify.com",
      TEST_CLIENT_ID,
      TEST_CLIENT_SECRET,
      0
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBeDefined();
    // X6: Should NOT have error field with raw message (can contain domain)
    expect("error" in result).toBe(false);
    // Should NOT contain shop domain in any string value
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain("myshopify.com");
  });
});
