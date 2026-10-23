/**
 * Node-usable offline token refresh helper.
 *
 * This script provides token refresh functionality for:
 * - CI workflows (e.g., .github/workflows/prod-diagnostics.yml)
 * - Node scripts that need to use the app's offline access token
 *
 * For in-app routes on Cloudflare Workers, use the library's
 * `unauthenticated.admin(shop)` or `authenticate.*` methods instead,
 * which handle refresh automatically.
 *
 * Usage:
 *   npx tsx scripts/lib/refresh-offline-token.ts \
 *     --shop example.myshopify.com \
 *     --threshold-minutes 5
 *
 * Environment Variables:
 *   DATABASE_URL          - Postgres connection string (SESSION pooler for writes)
 *   SHOPIFY_API_KEY       - App's API key (client_id)
 *   SHOPIFY_API_SECRET    - App's API secret (client_secret)
 *
 * Output (JSON on stdout):
 *   { "success": true, "accessToken": "shpat_...", "expires": "2024-..." }
 *   { "success": false, "errorCode": "...", "error": "..." }
 *
 * Exit codes:
 *   0 - Success (token valid or refreshed)
 *   1 - Error (see JSON output for details)
 *
 * SECURITY:
 * - Access tokens are output only when --output-token is passed
 * - Without --output-token, only success/failure status is output
 * - Tokens are NEVER logged to stderr
 *
 * @see https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens#token-refresh
 */

import postgres, { type Options } from "postgres";
import { pathToFileURL } from "node:url";

/**
 * 5 minutes in milliseconds - matches the library's WITHIN_MILLISECONDS_OF_EXPIRY.
 */
const DEFAULT_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Shared postgres.js options for Node scripts.
 * Matches app/lib/db-light.server.ts sqlOptions.
 */
const sqlOptions: Options<Record<string, never>> = {
  max: 5,
  prepare: true,
  transform: { undefined: null },
  connect_timeout: 10,
  fetch_types: false,
};

interface RefreshResult {
  success: boolean;
  accessToken?: string;
  expires?: string;
  errorCode?: "no_session" | "no_refresh_token" | "invalid_grant" | "network_error" | "unknown" | "config_error";
  error?: string;
  wasRefreshed?: boolean;
}

interface TokenRefreshResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
  scope: string;
}

interface TokenErrorResponse {
  error: string;
  error_description?: string;
}

/**
 * Check if a token is expired or near expiry.
 */
function isTokenExpiredOrNearExpiry(
  expires: Date | null,
  thresholdMs: number
): boolean {
  if (!expires) {
    return false;
  }
  return expires.getTime() - Date.now() <= thresholdMs;
}

/**
 * Perform the token refresh HTTP request.
 */
async function performTokenRefresh(
  shop: string,
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<{
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  refreshTokenExpiresIn?: number;
  scope?: string;
  errorCode?: RefreshResult["errorCode"];
  error?: string;
}> {
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

    return {
      success: true,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      refreshTokenExpiresIn: data.refresh_token_expires_in,
      scope: data.scope,
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
 * Refresh an offline access token if expired or near expiry.
 *
 * Uses row-level locking (SELECT ... FOR UPDATE) to prevent concurrent
 * refreshes from burning the single-use refresh token.
 */
export async function refreshOfflineTokenIfNeeded(
  databaseUrl: string,
  shop: string,
  clientId: string,
  clientSecret: string,
  thresholdMs: number = DEFAULT_REFRESH_THRESHOLD_MS
): Promise<RefreshResult> {
  const sql = postgres(databaseUrl, sqlOptions);
  const sessionId = `offline_${shop}`;

  try {
    return await sql.begin(async (tx) => {
      // Acquire exclusive lock on the session row
      const lockedRows = await tx<
        Array<{
          id: string;
          accessToken: string;
          expires: Date | null;
          refreshToken: string | null;
          refreshTokenExpires: Date | null;
        }>
      >`
        SELECT
          id,
          "accessToken",
          ("expires" AT TIME ZONE 'UTC') AS "expires",
          "refreshToken",
          ("refreshTokenExpires" AT TIME ZONE 'UTC') AS "refreshTokenExpires"
        FROM "Session"
        WHERE id = ${sessionId}
        FOR UPDATE
      `;

      if (lockedRows.length === 0) {
        return {
          success: false,
          errorCode: "no_session" as const,
          error: `No offline session found for shop ${shop}`,
        };
      }

      const session = lockedRows[0];

      // Check if refresh is needed
      if (!isTokenExpiredOrNearExpiry(session.expires, thresholdMs)) {
        return {
          success: true,
          accessToken: session.accessToken,
          expires: session.expires?.toISOString(),
          wasRefreshed: false,
        };
      }

      // Check if we have a refresh token
      if (!session.refreshToken) {
        return {
          success: false,
          errorCode: "no_refresh_token" as const,
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
          errorCode: "invalid_grant" as const,
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

      // Calculate new expiry times
      const now = new Date();
      const newExpires = new Date(now.getTime() + refreshResult.expiresIn! * 1000);
      const newRefreshTokenExpires = new Date(
        now.getTime() + refreshResult.refreshTokenExpiresIn! * 1000
      );

      // Update the session with new tokens
      await tx`
        UPDATE "Session"
        SET
          "accessToken" = ${refreshResult.accessToken!},
          expires = ${newExpires.toISOString()}::timestamptz AT TIME ZONE 'UTC',
          "refreshToken" = ${refreshResult.refreshToken!},
          "refreshTokenExpires" = ${newRefreshTokenExpires.toISOString()}::timestamptz AT TIME ZONE 'UTC',
          scope = ${refreshResult.scope!}
        WHERE id = ${sessionId}
      `;

      return {
        success: true,
        accessToken: refreshResult.accessToken,
        expires: newExpires.toISOString(),
        wasRefreshed: true,
      };
    });
  } finally {
    await sql.end();
  }
}

/**
 * Parse command line arguments.
 */
function parseArgs(): {
  shop: string;
  thresholdMinutes: number;
  outputToken: boolean;
  help: boolean;
} {
  const args = process.argv.slice(2);
  let shop = "";
  let thresholdMinutes = 5;
  let outputToken = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--shop" || arg === "-s") {
      shop = args[++i] || "";
    } else if (arg === "--threshold-minutes" || arg === "-t") {
      thresholdMinutes = parseInt(args[++i] || "5", 10);
    } else if (arg === "--output-token") {
      outputToken = true;
    }
  }

  return { shop, thresholdMinutes, outputToken, help };
}

function printHelp(): void {
  console.log(`
Usage: npx tsx scripts/lib/refresh-offline-token.ts [options]

Options:
  --shop, -s <domain>        Shop domain (e.g., example.myshopify.com)
  --threshold-minutes, -t    Minutes before expiry to trigger refresh (default: 5)
  --output-token             Include access token in output (SECURITY: use with care)
  --help, -h                 Show this help message

Environment Variables:
  DATABASE_URL               Postgres connection string (SESSION pooler for writes)
  SHOPIFY_API_KEY            App's API key (client_id)
  SHOPIFY_API_SECRET         App's API secret (client_secret)

Output (JSON on stdout):
  Success: { "success": true, "wasRefreshed": true|false, "expires": "..." }
  Error:   { "success": false, "errorCode": "...", "error": "..." }

Exit codes:
  0 - Success (token valid or refreshed)
  1 - Error (see JSON output for details)
`);
}

async function main(): Promise<void> {
  const { shop, thresholdMinutes, outputToken, help } = parseArgs();

  if (help) {
    printHelp();
    process.exit(0);
  }

  if (!shop) {
    console.log(JSON.stringify({
      success: false,
      errorCode: "config_error",
      error: "Missing required --shop argument",
    }));
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  const clientId = process.env.SHOPIFY_API_KEY;
  const clientSecret = process.env.SHOPIFY_API_SECRET;

  if (!databaseUrl) {
    console.log(JSON.stringify({
      success: false,
      errorCode: "config_error",
      error: "Missing DATABASE_URL environment variable",
    }));
    process.exit(1);
  }

  if (!clientId || !clientSecret) {
    console.log(JSON.stringify({
      success: false,
      errorCode: "config_error",
      error: "Missing SHOPIFY_API_KEY or SHOPIFY_API_SECRET environment variable",
    }));
    process.exit(1);
  }

  const thresholdMs = thresholdMinutes * 60 * 1000;
  const result = await refreshOfflineTokenIfNeeded(
    databaseUrl,
    shop,
    clientId,
    clientSecret,
    thresholdMs
  );

  // Output result (optionally excluding access token for security)
  const output: Record<string, unknown> = {
    success: result.success,
  };

  if (result.success) {
    if (outputToken && result.accessToken) {
      output.accessToken = result.accessToken;
    }
    output.expires = result.expires;
    output.wasRefreshed = result.wasRefreshed;
  } else {
    output.errorCode = result.errorCode;
    output.error = result.error;
  }

  console.log(JSON.stringify(output));
  process.exit(result.success ? 0 : 1);
}

// Only run main() when executed directly
const isMainModule = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.log(JSON.stringify({
      success: false,
      errorCode: "unknown",
      error: err instanceof Error ? err.message : "Unknown error",
    }));
    process.exit(1);
  });
}
