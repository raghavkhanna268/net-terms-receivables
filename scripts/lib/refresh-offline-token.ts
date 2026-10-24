#!/usr/bin/env tsx
/**
 * Node CLI for offline token refresh.
 *
 * This script wraps app/lib/offline-token.server.ts for use in:
 * - CI workflows (e.g., .github/workflows/prod-diagnostics.yml)
 * - Node scripts that need to refresh the app's offline access token
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
 *   { "success": true, "wasRefreshed": true|false, "expires": "..." }
 *   { "success": false, "errorCode": "...", "error": "..." }
 *
 * Exit codes:
 *   0 - Success (token valid or refreshed)
 *   1 - Error (see JSON output for details)
 *
 * SECURITY:
 * - Access tokens are NEVER output or logged
 * - Only success/failure status is emitted
 *
 * @see https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens#token-refresh
 */

import postgres, { type Options } from "postgres";
import { pathToFileURL } from "node:url";
import {
  refreshOfflineTokenIfNeeded as coreRefresh,
  type RefreshResult,
  type RefreshErrorCode,
} from "../../app/lib/offline-token.server";

// Re-export types for consumers
export type { RefreshResult, RefreshErrorCode };

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

/**
 * Script-specific result that includes wasRefreshed and ISO string expires.
 * Never includes raw error messages for security (X6).
 */
export interface ScriptRefreshResult {
  success: boolean;
  wasRefreshed?: boolean;
  expires?: string;
  errorCode?: RefreshErrorCode | "config_error" | string;
}

/**
 * Refresh an offline access token if expired or near expiry.
 *
 * This is a Node-friendly wrapper around the core refresh function that:
 * - Creates and cleans up its own postgres connection
 * - Converts Date to ISO string for JSON output
 * - Never returns the access token (for security)
 *
 * @param databaseUrl - Postgres connection string (SESSION pooler for writes)
 * @param shop - Shop domain (e.g., "example.myshopify.com")
 * @param clientId - Shopify app's API key
 * @param clientSecret - Shopify app's API secret
 * @param thresholdMs - Milliseconds before expiry to trigger refresh (default: 5 min)
 */
export async function refreshOfflineTokenIfNeeded(
  databaseUrl: string,
  shop: string,
  clientId: string,
  clientSecret: string,
  thresholdMs: number = 5 * 60 * 1000
): Promise<ScriptRefreshResult> {
  const sql = postgres(databaseUrl, sqlOptions);

  try {
    const result = await coreRefresh(sql, shop, clientId, clientSecret, thresholdMs);

    if (result.success) {
      return {
        success: true,
        wasRefreshed: result.wasRefreshed ?? false,
        expires: result.expires?.toISOString(),
      };
    } else {
      // Return errorCode only, not raw error message (X6)
      return {
        success: false,
        errorCode: result.errorCode,
      };
    }
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
  help: boolean;
} {
  const args = process.argv.slice(2);
  let shop = "";
  let thresholdMinutes = 5;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--shop" || arg === "-s") {
      shop = args[++i] || "";
    } else if (arg === "--threshold-minutes" || arg === "-t") {
      thresholdMinutes = parseInt(args[++i] || "5", 10);
    }
    // Note: --output-token is intentionally not supported for security
  }

  return { shop, thresholdMinutes, help };
}

function printHelp(): void {
  console.log(`
Usage: npx tsx scripts/lib/refresh-offline-token.ts [options]

Options:
  --shop, -s <domain>        Shop domain (e.g., example.myshopify.com)
  --threshold-minutes, -t    Minutes before expiry to trigger refresh (default: 5)
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

SECURITY: Access tokens are never output. The probe step re-reads from the database.
`);
}

async function main(): Promise<void> {
  const { shop, thresholdMinutes, help } = parseArgs();

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

  // Output result (never includes access token)
  console.log(JSON.stringify(result));
  process.exit(result.success ? 0 : 1);
}

// Only run main() when executed directly
const isMainModule = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    // Return errorCode only, not raw error message (X6)
    const errCode = err instanceof Error && "code" in err ? (err as { code: string }).code : undefined;
    console.log(JSON.stringify({
      success: false,
      errorCode: errCode ?? (err instanceof Error ? err.name : "unknown"),
    }));
    process.exit(1);
  });
}
