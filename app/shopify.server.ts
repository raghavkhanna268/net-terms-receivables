import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  LogSeverity,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "./lib/session-storage.server";
import { parseScopes } from "./lib/scopes";

/**
 * Fail fast on missing required environment variables.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `For local dev, set it in .dev.vars. For production, use 'wrangler secret put ${name}'.`
    );
  }
  return value;
}

/**
 * Module-scoped session storage singleton.
 *
 * Uses AsyncLocalStorage internally to get the correct Prisma client for
 * each request. Safe to share across requests because it delegates to
 * getRequestPrisma() which returns the request-scoped client.
 */
export const sessionStorage = new PrismaSessionStorage();

/**
 * Cached Shopify app instance - created lazily on first access.
 * Creating shopifyApp() is expensive (~4ms) because it initializes
 * auth flows, validates config, creates client factories, etc.
 *
 * Safe to share across requests because session storage uses ALS internally.
 */
let cachedShopifyApp: ReturnType<typeof shopifyApp> | null = null;

/**
 * Get the Shopify app singleton, creating it lazily on first access.
 *
 * This function creates the shopifyApp instance once per isolate rather than
 * once per request. The session storage uses AsyncLocalStorage internally,
 * so each request automatically gets the correct Prisma client.
 *
 * CPU savings: ~4ms per warm request by avoiding repeated shopifyApp() calls.
 */
export function getShopifyApp(): ReturnType<typeof shopifyApp> {
  if (cachedShopifyApp) {
    return cachedShopifyApp;
  }

  const apiKey = requireEnv("SHOPIFY_API_KEY");
  const apiSecretKey = requireEnv("SHOPIFY_API_SECRET");
  const appUrl = requireEnv("SHOPIFY_APP_URL");
  const scopesEnv = process.env.SCOPES ?? "";
  const scopes = parseScopes(scopesEnv);

  const isProduction = process.env.NODE_ENV === "production";

  cachedShopifyApp = shopifyApp({
    apiKey,
    apiSecretKey,
    apiVersion: ApiVersion.October26,
    scopes,
    appUrl,
    authPathPrefix: "/auth",
    sessionStorage,
    distribution: AppDistribution.AppStore,
    future: {
      expiringOfflineAccessTokens: true,
    },
    logger: {
      level: isProduction ? LogSeverity.Warning : LogSeverity.Info,
    },
    ...(process.env.SHOP_CUSTOM_DOMAIN
      ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
      : {}),
  });

  return cachedShopifyApp;
}

export const apiVersion = ApiVersion.October26;

// Re-export types and session storage for routes
export type { PrismaSessionStorage };
export type ShopifyApp = ReturnType<typeof shopifyApp>;

/**
 * Reset the cached Shopify app - only for testing purposes.
 * @internal
 */
export function _resetShopifyAppForTesting(): void {
  cachedShopifyApp = null;
}
