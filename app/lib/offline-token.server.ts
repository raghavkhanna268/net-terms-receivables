/**
 * Offline token refresh helper for expiring offline access tokens.
 *
 * This module provides token refresh functionality for code paths that operate
 * outside the @shopify/shopify-app-react-router library, such as:
 * - Node scripts (scripts/)
 * - CI workflows (.github/workflows/prod-diagnostics.yml)
 *
 * For in-app routes, the library's `unauthenticated.admin(shop)` and
 * `authenticate.*` methods already handle refresh automatically via
 * `ensureOfflineTokenIsNotExpired`. Use those paths instead of this helper
 * when possible.
 *
 * Token Refresh Flow:
 * 1. Check if token is within 5 minutes of expiry
 * 2. Acquire row lock via SELECT ... FOR UPDATE
 * 3. Re-check expiry (another caller may have refreshed)
 * 4. POST to https://{shop}/admin/oauth/access_token with grant_type=refresh_token
 * 5. Write new accessToken, expires, refreshToken, refreshTokenExpires to Session
 * 6. Return the refreshed session
 *
 * Concurrency Safety:
 * Uses row-level locking (SELECT ... FOR UPDATE) to prevent concurrent callers
 * of THIS helper from burning the single-use refresh token. A caller that loses
 * the race re-reads the row and gets the winner's refreshed token.
 *
 * IMPORTANT: This lock does NOT coordinate with the library's in-app refresh
 * (via `ensureOfflineTokenIsNotExpired`), which takes no lock. If a CI script
 * and an in-app request both attempt to refresh at the same moment, one will
 * succeed and the other will get `invalid_grant`. This is acceptable for CI
 * diagnostics - the probe can be re-run after the token settles.
 *
 * @see https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens#token-refresh
 * @see node_modules/@shopify/shopify-app-react-router/src/server/helpers/ensure-offline-token-is-not-expired.ts
 */

import type { Sql } from "./db-light.server";

/**
 * 5 minutes in milliseconds - matches the library's WITHIN_MILLISECONDS_OF_EXPIRY.
 * @see node_modules/@shopify/shopify-app-react-router/src/server/helpers/ensure-offline-token-is-not-expired.ts:8
 */
export const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Error codes for token refresh failures.
 */
export type RefreshErrorCode =
  | "no_session"
  | "no_refresh_token"
  | "invalid_grant"
  | "invalid_response"
  | "refresh_persist_failed"
  | "network_error"
  | "unknown";

/**
 * Result of a token refresh attempt.
 */
export interface RefreshResult {
  /** Whether the refresh was successful */
  success: boolean;
  /** The new access token (on success) */
  accessToken?: string;
  /** When the access token expires (on success) */
  expires?: Date;
  /** Whether the token was refreshed (false if it was already valid) */
  wasRefreshed?: boolean;
  /** Error code for failures */
  errorCode?: RefreshErrorCode;
  /** Error message (no secrets included) */
  error?: string;
}

/**
 * Response from Shopify's token refresh endpoint.
 * Per Shopify docs, access_token and expires_in are required.
 * refresh_token, refresh_token_expires_in, and scope may be missing in edge cases.
 * @see https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens#token-refresh
 */
interface TokenRefreshResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
}

/**
 * Error response from Shopify's token endpoint.
 */
interface TokenErrorResponse {
  error: string;
  error_description?: string;
}

/**
 * Internal result from performTokenRefresh with validated fields.
 */
interface TokenRefreshResult {
  success: boolean;
  accessToken?: string;
  expiresIn?: number;
  refreshToken?: string | null;
  refreshTokenExpiresIn?: number | null;
  scope?: string | null;
  errorCode?: RefreshErrorCode;
  error?: string;
}

/**
 * Check if a token is expired or near expiry.
 * Matches the library's logic in ensureOfflineTokenIsNotExpired.
 */
export function isTokenExpiredOrNearExpiry(
  expires: Date | null | undefined,
  thresholdMs: number = REFRESH_THRESHOLD_MS
): boolean {
  if (!expires) {
    return false;
  }
  return expires.getTime() - Date.now() <= thresholdMs;
}

/**
 * Refresh an offline access token if expired or near expiry.
 *
 * Uses row-level locking to prevent concurrent refreshes from burning
 * the single-use refresh token. If another caller wins the race, this
 * function re-reads the row and returns the winner's refreshed token.
 *
 * Note: This lock only coordinates callers of this helper. The library's
 * in-app refresh (ensureOfflineTokenIsNotExpired) does not take a lock,
 * so a race is possible between CI and in-app refreshes.
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain (e.g., "example.myshopify.com")
 * @param clientId - Shopify app's API key
 * @param clientSecret - Shopify app's API secret
 * @param thresholdMs - Milliseconds before expiry to trigger refresh (default: 5 min)
 * @returns RefreshResult with new token or error
 */
export async function refreshOfflineTokenIfNeeded(
  sql: Sql,
  shop: string,
  clientId: string,
  clientSecret: string,
  thresholdMs: number = REFRESH_THRESHOLD_MS
): Promise<RefreshResult> {
  const sessionId = `offline_${shop}`;

  // Use a transaction with row-level locking
  return await sql.begin(async (tx) => {
    // Acquire exclusive lock on the session row
    const lockedRows = await tx<
      Array<{
        id: string;
        accessToken: string;
        expires: Date | null;
        scope: string | null;
        refreshToken: string | null;
        refreshTokenExpires: Date | null;
      }>
    >`
      SELECT
        id,
        "accessToken",
        ("expires" AT TIME ZONE 'UTC') AS "expires",
        scope,
        "refreshToken",
        ("refreshTokenExpires" AT TIME ZONE 'UTC') AS "refreshTokenExpires"
      FROM "Session"
      WHERE id = ${sessionId}
      FOR UPDATE
    `;

    if (lockedRows.length === 0) {
      return {
        success: false,
        errorCode: "no_session",
        error: `No offline session found for shop ${shop}`,
      };
    }

    const session = lockedRows[0];

    // Check if refresh is needed
    if (!isTokenExpiredOrNearExpiry(session.expires, thresholdMs)) {
      // Token is still valid
      return {
        success: true,
        accessToken: session.accessToken,
        expires: session.expires ?? undefined,
        wasRefreshed: false,
      };
    }

    // Check if we have a refresh token
    if (!session.refreshToken) {
      return {
        success: false,
        errorCode: "no_refresh_token",
        error: `No refresh token available for shop ${shop}. Re-authentication required.`,
      };
    }

    // Check if refresh token itself is expired
    if (
      session.refreshTokenExpires &&
      session.refreshTokenExpires.getTime() < Date.now()
    ) {
      return {
        success: false,
        errorCode: "invalid_grant",
        error: `Refresh token expired for shop ${shop}. Re-authentication required.`,
      };
    }

    // Perform the token refresh
    const refreshResult = await performTokenRefresh(
      shop,
      session.refreshToken,
      clientId,
      clientSecret
    );

    if (!refreshResult.success) {
      return {
        success: false,
        errorCode: refreshResult.errorCode,
        error: refreshResult.error,
      };
    }

    // TypeScript doesn't narrow from success check, so validate accessToken
    const newAccessToken = refreshResult.accessToken;
    if (!newAccessToken) {
      return {
        success: false,
        errorCode: "invalid_response",
        error: `Token refresh returned empty access_token for shop ${shop}`,
      };
    }

    // Calculate new expiry times with validation
    const now = new Date();
    const expiresIn = refreshResult.expiresIn;
    if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      return {
        success: false,
        errorCode: "invalid_response",
        error: `Invalid expires_in from Shopify for shop ${shop}`,
      };
    }
    const newExpires = new Date(now.getTime() + expiresIn * 1000);

    // Refresh token expiry is optional - may be null
    let newRefreshTokenExpires: Date | null = null;
    const rtExpiresIn = refreshResult.refreshTokenExpiresIn;
    if (typeof rtExpiresIn === "number" && Number.isFinite(rtExpiresIn) && rtExpiresIn > 0) {
      newRefreshTokenExpires = new Date(now.getTime() + rtExpiresIn * 1000);
    }

    // Use new refresh token if provided, otherwise keep the old one
    const newRefreshToken = refreshResult.refreshToken ?? session.refreshToken;

    // Use new scope if provided, otherwise keep the old one
    const newScope = refreshResult.scope ?? session.scope;

    // Persist the refreshed tokens
    try {
      const refreshTokenExpiresStr = newRefreshTokenExpires
        ? newRefreshTokenExpires.toISOString()
        : null;

      await tx`
        UPDATE "Session"
        SET
          "accessToken" = ${newAccessToken},
          expires = ${newExpires.toISOString()}::timestamptz AT TIME ZONE 'UTC',
          "refreshToken" = ${newRefreshToken},
          "refreshTokenExpires" = ${refreshTokenExpiresStr}::timestamptz AT TIME ZONE 'UTC',
          scope = ${newScope}
        WHERE id = ${sessionId}
      `;
    } catch {
      // Log only shop and error code (no tokens)
      console.error(`[offline-token] refresh_persist_failed shop=${shop}`);
      return {
        success: false,
        errorCode: "refresh_persist_failed",
        error: `Failed to persist refreshed token for shop ${shop}. The refresh token may have been consumed.`,
      };
    }

    return {
      success: true,
      accessToken: newAccessToken,
      expires: newExpires,
      wasRefreshed: true,
    };
  });
}

/**
 * Perform the actual token refresh HTTP request.
 * Validates required fields (access_token, expires_in) before returning.
 *
 * @see https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens#token-refresh
 */
async function performTokenRefresh(
  shop: string,
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<TokenRefreshResult> {
  const url = `https://${shop}/admin/oauth/access_token`;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => ({}))) as TokenErrorResponse;

      // Handle invalid_grant specifically - refresh token was revoked or expired
      if (response.status === 400 && errorBody.error === "invalid_grant") {
        return {
          success: false,
          errorCode: "invalid_grant",
          error: `Token refresh failed for shop ${shop}: invalid_grant. Re-authentication required.`,
        };
      }

      return {
        success: false,
        errorCode: "unknown",
        error: `Token refresh failed for shop ${shop}: HTTP ${response.status}`,
      };
    }

    const data = (await response.json()) as TokenRefreshResponse;

    // Validate required fields
    if (typeof data.access_token !== "string" || data.access_token.length === 0) {
      return {
        success: false,
        errorCode: "invalid_response",
        error: `Token refresh returned invalid access_token for shop ${shop}`,
      };
    }

    if (typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
      return {
        success: false,
        errorCode: "invalid_response",
        error: `Token refresh returned invalid expires_in for shop ${shop}`,
      };
    }

    return {
      success: true,
      accessToken: data.access_token,
      expiresIn: data.expires_in,
      // Optional fields - may be missing
      refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
      refreshTokenExpiresIn: typeof data.refresh_token_expires_in === "number" ? data.refresh_token_expires_in : null,
      scope: typeof data.scope === "string" ? data.scope : null,
    };
  } catch (err) {
    return {
      success: false,
      errorCode: "network_error",
      error: `Token refresh network error for shop ${shop}: ${err instanceof Error ? err.message : "Unknown"}`,
    };
  }
}

/**
 * Get a valid offline access token for a shop, refreshing if necessary.
 *
 * This is a convenience wrapper around refreshOfflineTokenIfNeeded that
 * returns just the access token string, or throws on error.
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain
 * @param clientId - Shopify app's API key
 * @param clientSecret - Shopify app's API secret
 * @returns Valid access token
 * @throws Error if token cannot be obtained or refreshed
 */
export async function getValidOfflineToken(
  sql: Sql,
  shop: string,
  clientId: string,
  clientSecret: string
): Promise<string> {
  const result = await refreshOfflineTokenIfNeeded(sql, shop, clientId, clientSecret);

  if (!result.success || !result.accessToken) {
    throw new Error(result.error ?? "Failed to get valid offline token");
  }

  return result.accessToken;
}
