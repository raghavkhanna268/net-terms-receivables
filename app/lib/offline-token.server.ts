/**
 * Offline token refresh helper for expiring offline access tokens.
 *
 * This module provides token refresh functionality for all Admin API calls,
 * including queue processing, webhooks, and scripts.
 *
 * Token Refresh Flow:
 * 1. Check if token is within 5 minutes of expiry
 * 2. Read session (no lock)
 * 3. POST to https://{shop}/admin/oauth/access_token with grant_type=refresh_token
 * 4. Write new tokens with CAS (compare-and-swap): UPDATE WHERE accessToken = $old
 * 5. On CAS loss (0 rows updated), re-read and use winner's token
 *
 * Concurrency Safety (CAS):
 * Uses compare-and-swap instead of row-level locking. When updating, we check
 * that accessToken matches the value we read. If another process refreshed first:
 * - Our UPDATE affects 0 rows (CAS loss)
 * - We re-read the session and use the winner's refreshed token
 * - The refresh token is single-use, so the second refresh would fail anyway
 *
 * Re-auth Required:
 * When refresh fails with invalid_grant (token revoked or expired), we:
 * - Set needsReauth=true on the session
 * - Return a non-retryable error (queue should dead-letter, not loop)
 * - Log to console without tokens (Sentry picks up from there)
 *
 * @see https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens#token-refresh
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
 * Uses compare-and-swap (CAS) to safely handle concurrent refreshes.
 * If another caller wins the race, this function re-reads the row and
 * returns the winner's refreshed token.
 *
 * On invalid_grant error (refresh token revoked or expired):
 * - Sets needsReauth=true on the session
 * - Returns a non-retryable error for queue dead-lettering
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

  // Read session (no lock)
  const rows = await sql<
    Array<{
      id: string;
      accessToken: string;
      expires: Date | null;
      scope: string | null;
      refreshToken: string | null;
      refreshTokenExpires: Date | null;
      needsReauth: boolean;
    }>
  >`
    SELECT
      id,
      "accessToken",
      ("expires" AT TIME ZONE 'UTC') AS "expires",
      scope,
      "refreshToken",
      ("refreshTokenExpires" AT TIME ZONE 'UTC') AS "refreshTokenExpires",
      "needsReauth"
    FROM "Session"
    WHERE id = ${sessionId}
  `;

  if (rows.length === 0) {
    return {
      success: false,
      errorCode: "no_session",
      error: `No offline session found for shop ${shop}`,
    };
  }

  let session = rows[0];

  // If session is already marked as needing re-auth, fail immediately (non-retryable)
  if (session.needsReauth) {
    return {
      success: false,
      errorCode: "invalid_grant",
      error: `Session for shop ${shop} is marked as needing re-authentication.`,
    };
  }

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
    // Mark session as needing re-auth
    await markSessionNeedsReauth(sql, sessionId);
    console.error(`[offline-token] no_refresh_token shop=${shop}`);
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
    // Mark session as needing re-auth
    await markSessionNeedsReauth(sql, sessionId);
    console.error(`[offline-token] refresh_token_expired shop=${shop}`);
    return {
      success: false,
      errorCode: "invalid_grant",
      error: `Refresh token expired for shop ${shop}. Re-authentication required.`,
    };
  }

  // Store the old access token for CAS
  const oldAccessToken = session.accessToken;

  // Perform the token refresh
  const refreshResult = await performTokenRefresh(
    shop,
    session.refreshToken,
    clientId,
    clientSecret
  );

  if (!refreshResult.success) {
    // On invalid_grant, mark session as needing re-auth (non-retryable)
    if (refreshResult.errorCode === "invalid_grant") {
      await markSessionNeedsReauth(sql, sessionId);
      console.error(`[offline-token] invalid_grant shop=${shop}`);
    }
    return {
      success: false,
      errorCode: refreshResult.errorCode,
      error: refreshResult.error,
    };
  }

  // Validate access token from result
  const newAccessToken = refreshResult.accessToken;
  if (!newAccessToken) {
    return {
      success: false,
      errorCode: "invalid_response",
      error: `Token refresh returned empty access_token for shop ${shop}`,
    };
  }

  // Validate expires_in
  const expiresIn = refreshResult.expiresIn;
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return {
      success: false,
      errorCode: "invalid_response",
      error: `Invalid expires_in from Shopify for shop ${shop}`,
    };
  }

  const now = new Date();
  const newExpires = new Date(now.getTime() + expiresIn * 1000);

  // Refresh token expiry is optional
  let newRefreshTokenExpires: Date | null = null;
  const rtExpiresIn = refreshResult.refreshTokenExpiresIn;
  if (typeof rtExpiresIn === "number" && Number.isFinite(rtExpiresIn) && rtExpiresIn > 0) {
    newRefreshTokenExpires = new Date(now.getTime() + rtExpiresIn * 1000);
  }

  // Use new refresh token if provided, otherwise keep the old one
  const newRefreshToken = refreshResult.refreshToken ?? session.refreshToken;

  // Use new scope if provided, otherwise keep the old one
  const newScope = refreshResult.scope ?? session.scope;

  // CAS update: only update if accessToken hasn't changed
  const refreshTokenExpiresStr = newRefreshTokenExpires
    ? newRefreshTokenExpires.toISOString()
    : null;

  const updateResult = await sql`
    UPDATE "Session"
    SET
      "accessToken" = ${newAccessToken},
      expires = ${newExpires.toISOString()}::timestamptz AT TIME ZONE 'UTC',
      "refreshToken" = ${newRefreshToken},
      "refreshTokenExpires" = ${refreshTokenExpiresStr}::timestamptz AT TIME ZONE 'UTC',
      scope = ${newScope},
      "needsReauth" = false
    WHERE id = ${sessionId}
      AND "accessToken" = ${oldAccessToken}
  `;

  // CAS success: we updated the row
  if (updateResult.count > 0) {
    return {
      success: true,
      accessToken: newAccessToken,
      expires: newExpires,
      wasRefreshed: true,
    };
  }

  // CAS failure: another process refreshed first. Re-read and use winner's token.
  console.log(`[offline-token] CAS loss for shop=${shop}, re-reading winner's token`);
  const rereadRows = await sql<
    Array<{
      accessToken: string;
      expires: Date | null;
      needsReauth: boolean;
    }>
  >`
    SELECT
      "accessToken",
      ("expires" AT TIME ZONE 'UTC') AS "expires",
      "needsReauth"
    FROM "Session"
    WHERE id = ${sessionId}
  `;

  if (rereadRows.length === 0) {
    return {
      success: false,
      errorCode: "no_session",
      error: `Session disappeared for shop ${shop} during CAS retry`,
    };
  }

  session = { ...session, ...rereadRows[0] };

  // Check if winner marked it as needing re-auth
  if (session.needsReauth) {
    return {
      success: false,
      errorCode: "invalid_grant",
      error: `Session for shop ${shop} is marked as needing re-authentication.`,
    };
  }

  // Return the winner's token
  return {
    success: true,
    accessToken: session.accessToken,
    expires: session.expires ?? undefined,
    wasRefreshed: true,
  };
}

/**
 * Mark a session as needing re-authentication.
 * Called when refresh token is invalid, expired, or missing.
 */
async function markSessionNeedsReauth(sql: Sql, sessionId: string): Promise<void> {
  await sql`
    UPDATE "Session"
    SET "needsReauth" = true
    WHERE id = ${sessionId}
  `;
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
