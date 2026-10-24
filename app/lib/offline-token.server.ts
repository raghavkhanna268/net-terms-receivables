/**
 * Offline token refresh helper for expiring offline access tokens.
 *
 * This module provides token refresh functionality for all Admin API calls,
 * including queue processing, webhooks, and scripts.
 *
 * Token Refresh Flow:
 * 1. Acquire advisory lock per shop (serializes refreshes)
 * 2. Re-check expiry (another caller may have refreshed)
 * 3. POST to https://{shop}/admin/oauth/access_token with grant_type=refresh_token
 * 4. Write new tokens with guarded UPDATE (check refreshToken matches)
 * 5. On invalid_grant, re-read to see if another process won; if not, mark needsReauth
 *
 * Concurrency Safety:
 * Uses pg_advisory_xact_lock(hashtext(shop)) in a short transaction to serialize
 * refresh attempts per shop. After acquiring the lock, we re-check if refresh is
 * still needed (another caller may have already refreshed).
 *
 * Re-auth Required:
 * When refresh fails with invalid_grant AND no concurrent winner:
 * - Set needsReauth=true with guarded UPDATE (WHERE refreshToken=$usedToken)
 * - Return a non-retryable error (queue should dead-letter, not loop)
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
 * Timeout for token refresh HTTP request in milliseconds.
 * Prevents slow Shopify calls from holding the advisory lock.
 * On timeout, the error is treated as retryable (network_error).
 */
export const TOKEN_REFRESH_TIMEOUT_MS = 5000;

/**
 * Error codes for token refresh failures.
 *
 * Note: Missing credentials are handled upstream in shopify-client.server.ts
 * before calling refreshOfflineTokenIfNeeded, so no "missing_credentials" code
 * is needed here.
 */
export type RefreshErrorCode =
  | "no_session"
  | "no_refresh_token"
  | "invalid_grant"
  | "invalid_response"
  | "refresh_persist_failed"
  | "network_error"
  | "http_error"
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
 * Session row type for refresh operations.
 */
interface SessionForRefresh {
  id: string;
  accessToken: string;
  expires: Date | null;
  scope: string | null;
  refreshToken: string | null;
  refreshTokenExpires: Date | null;
  needsReauth: boolean;
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
 * Read a session by ID.
 */
async function readSession(
  sql: Sql,
  sessionId: string
): Promise<SessionForRefresh | null> {
  const rows = await sql<SessionForRefresh[]>`
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
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Refresh an offline access token if expired or near expiry.
 *
 * Uses pg_advisory_xact_lock to serialize refresh attempts per shop.
 * This prevents concurrent callers from burning single-use refresh tokens.
 *
 * On invalid_grant error, checks if another process already refreshed.
 * Only marks needsReauth if the refresh token we used is still current.
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

  // Quick check without lock first (optimization)
  const initialSession = await readSession(sql, sessionId);

  if (!initialSession) {
    return {
      success: false,
      errorCode: "no_session",
      error: "No offline session found",
    };
  }

  // If session is already marked as needing re-auth, fail immediately
  if (initialSession.needsReauth) {
    return {
      success: false,
      errorCode: "invalid_grant",
      error: "Session needs re-authentication",
    };
  }

  // If token is still valid, return it without acquiring lock
  if (!isTokenExpiredOrNearExpiry(initialSession.expires, thresholdMs)) {
    return {
      success: true,
      accessToken: initialSession.accessToken,
      expires: initialSession.expires ?? undefined,
      wasRefreshed: false,
    };
  }

  // Token needs refresh - use transaction with advisory lock
  return await sql.begin(async (tx) => {
    // Acquire advisory lock per shop (serializes refreshes)
    await tx`SELECT pg_advisory_xact_lock(hashtext(${shop}))`;

    // Re-read session after acquiring lock (another caller may have refreshed)
    const session = await readSessionInTx(tx, sessionId);

    if (!session) {
      return {
        success: false,
        errorCode: "no_session",
        error: "No offline session found",
      };
    }

    // Check if another caller already refreshed while we waited for lock
    if (!isTokenExpiredOrNearExpiry(session.expires, thresholdMs)) {
      return {
        success: true,
        accessToken: session.accessToken,
        expires: session.expires ?? undefined,
        wasRefreshed: false,
      };
    }

    // Re-check needsReauth after lock
    if (session.needsReauth) {
      return {
        success: false,
        errorCode: "invalid_grant",
        error: "Session needs re-authentication",
      };
    }

    // Store the refresh token we're about to use (for guarded updates)
    const usedRefreshToken = session.refreshToken;

    // Check if we have a refresh token
    if (!usedRefreshToken) {
      // Mark session as needing re-auth with guarded update
      await markSessionNeedsReauthGuarded(tx, sessionId, null);
      return {
        success: false,
        errorCode: "no_refresh_token",
        error: "No refresh token available",
      };
    }

    // Check if refresh token itself is expired
    if (
      session.refreshTokenExpires &&
      session.refreshTokenExpires.getTime() < Date.now()
    ) {
      // Mark session as needing re-auth with guarded update
      await markSessionNeedsReauthGuarded(tx, sessionId, usedRefreshToken);
      return {
        success: false,
        errorCode: "invalid_grant",
        error: "Refresh token expired",
      };
    }

    // Perform the token refresh
    const refreshResult = await performTokenRefresh(
      shop,
      usedRefreshToken,
      clientId,
      clientSecret
    );

    if (!refreshResult.success) {
      // On invalid_grant, check if another process already refreshed
      if (refreshResult.errorCode === "invalid_grant") {
        // Re-read session to see if tokens changed
        const currentSession = await readSessionInTx(tx, sessionId);

        if (currentSession) {
          // If tokens changed, another process won - use their token
          if (
            currentSession.accessToken !== session.accessToken ||
            currentSession.refreshToken !== usedRefreshToken
          ) {
            // Another process refreshed successfully - use winner's token
            if (!currentSession.needsReauth) {
              return {
                success: true,
                accessToken: currentSession.accessToken,
                expires: currentSession.expires ?? undefined,
                wasRefreshed: true,
              };
            }
          }
        }

        // No concurrent winner - mark session as needing re-auth
        // Use guarded update to only mark if our refresh token is still current
        await markSessionNeedsReauthGuarded(tx, sessionId, usedRefreshToken);
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
        error: "Token refresh returned empty access_token",
      };
    }

    // Validate expires_in
    const expiresIn = refreshResult.expiresIn;
    if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      return {
        success: false,
        errorCode: "invalid_response",
        error: "Invalid expires_in from Shopify",
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
    const newRefreshToken = refreshResult.refreshToken ?? usedRefreshToken;

    // Use new scope if provided, otherwise keep the old one
    const newScope = refreshResult.scope ?? session.scope;

    // Write new tokens with guarded update (check refreshToken matches)
    const refreshTokenExpiresStr = newRefreshTokenExpires
      ? newRefreshTokenExpires.toISOString()
      : null;

    const updateResult = await tx`
      UPDATE "Session"
      SET
        "accessToken" = ${newAccessToken},
        expires = ${newExpires.toISOString()}::timestamptz AT TIME ZONE 'UTC',
        "refreshToken" = ${newRefreshToken},
        "refreshTokenExpires" = ${refreshTokenExpiresStr}::timestamptz AT TIME ZONE 'UTC',
        scope = ${newScope},
        "needsReauth" = false
      WHERE id = ${sessionId}
        AND "refreshToken" = ${usedRefreshToken}
    `;

    if (updateResult.count > 0) {
      return {
        success: true,
        accessToken: newAccessToken,
        expires: newExpires,
        wasRefreshed: true,
      };
    }

    // Guard failed - another process updated the refresh token
    // This shouldn't happen with advisory lock, but handle defensively
    const finalSession = await readSessionInTx(tx, sessionId);

    if (!finalSession) {
      return {
        success: false,
        errorCode: "no_session",
        error: "Session disappeared during refresh",
      };
    }

    if (finalSession.needsReauth) {
      return {
        success: false,
        errorCode: "invalid_grant",
        error: "Session needs re-authentication",
      };
    }

    return {
      success: true,
      accessToken: finalSession.accessToken,
      expires: finalSession.expires ?? undefined,
      wasRefreshed: true,
    };
  });
}

/**
 * Read a session within a transaction.
 */
async function readSessionInTx(
  tx: Sql,
  sessionId: string
): Promise<SessionForRefresh | null> {
  const rows = await tx<SessionForRefresh[]>`
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
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Mark a session as needing re-authentication with guarded update.
 * Only marks if the refresh token matches (prevents poisoning winner's token).
 *
 * @param sql - SQL client (can be transaction)
 * @param sessionId - Session ID
 * @param usedRefreshToken - The refresh token that was used (null to skip guard)
 */
async function markSessionNeedsReauthGuarded(
  sql: Sql,
  sessionId: string,
  usedRefreshToken: string | null
): Promise<void> {
  if (usedRefreshToken === null) {
    // No guard needed - session has no refresh token
    await sql`
      UPDATE "Session"
      SET "needsReauth" = true
      WHERE id = ${sessionId}
        AND "refreshToken" IS NULL
    `;
  } else {
    // Guard: only mark if refresh token hasn't changed
    await sql`
      UPDATE "Session"
      SET "needsReauth" = true
      WHERE id = ${sessionId}
        AND "refreshToken" = ${usedRefreshToken}
    `;
  }
}

/**
 * Perform the actual token refresh HTTP request with timeout.
 * Validates required fields (access_token, expires_in) before returning.
 *
 * Uses AbortController to enforce TOKEN_REFRESH_TIMEOUT_MS timeout.
 * On timeout, returns network_error (retryable) to release the advisory lock
 * quickly instead of blocking other callers.
 *
 * @see https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens#token-refresh
 */
async function performTokenRefresh(
  shop: string,
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  timeoutMs: number = TOKEN_REFRESH_TIMEOUT_MS
): Promise<TokenRefreshResult> {
  const url = `https://${shop}/admin/oauth/access_token`;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => ({}))) as TokenErrorResponse;

      // Handle invalid_grant specifically - refresh token was revoked or expired
      if (response.status === 400 && errorBody.error === "invalid_grant") {
        return {
          success: false,
          errorCode: "invalid_grant",
          error: "Token refresh failed: invalid_grant",
        };
      }

      return {
        success: false,
        errorCode: "http_error",
        error: `Token refresh failed: HTTP ${response.status}`,
      };
    }

    const data = (await response.json()) as TokenRefreshResponse;

    // Validate required fields
    if (typeof data.access_token !== "string" || data.access_token.length === 0) {
      return {
        success: false,
        errorCode: "invalid_response",
        error: "Token refresh returned invalid access_token",
      };
    }

    if (typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
      return {
        success: false,
        errorCode: "invalid_response",
        error: "Token refresh returned invalid expires_in",
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
    clearTimeout(timeoutId);

    // Check if this was an abort (timeout)
    if (err instanceof Error && err.name === "AbortError") {
      return {
        success: false,
        errorCode: "network_error",
        error: "Token refresh timed out",
      };
    }

    return {
      success: false,
      errorCode: "network_error",
      error: "Token refresh network error",
    };
  }
}

/**
 * Error thrown when offline token operations fail.
 * Carries only the error code, never the shop domain or raw messages.
 */
export class OfflineTokenError extends Error {
  constructor(
    public readonly code: RefreshErrorCode,
    message?: string
  ) {
    super(message ?? `Offline token error: ${code}`);
    this.name = "OfflineTokenError";
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
 * @throws OfflineTokenError if token cannot be obtained or refreshed
 */
export async function getValidOfflineToken(
  sql: Sql,
  shop: string,
  clientId: string,
  clientSecret: string
): Promise<string> {
  const result = await refreshOfflineTokenIfNeeded(sql, shop, clientId, clientSecret);

  if (!result.success || !result.accessToken) {
    throw new OfflineTokenError(result.errorCode ?? "unknown");
  }

  return result.accessToken;
}
