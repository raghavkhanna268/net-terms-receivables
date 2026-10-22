import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import type { PrismaClient } from "~/generated/prisma/client";
import {
  PrismaSessionStorage,
  type PrismaClientGetter,
} from "./lib/session-storage.server";
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

const apiKey = requireEnv("SHOPIFY_API_KEY");
const apiSecretKey = requireEnv("SHOPIFY_API_SECRET");
const appUrl = requireEnv("SHOPIFY_APP_URL");
const scopesEnv = process.env.SCOPES ?? "";
const scopes = parseScopes(scopesEnv);

/**
 * Creates a PrismaSessionStorage instance for Shopify session management.
 *
 * This factory function is called per-request in the Worker entry point,
 * ensuring each request gets its own session storage instance backed by
 * a per-request PrismaClient (required for Cloudflare Workers with Hyperdrive).
 *
 * @param prismaOrGetter - A PrismaClient instance or getter for lazy creation
 * @returns A PrismaSessionStorage instance
 */
export function createSessionStorage(
  prismaOrGetter: PrismaClient | PrismaClientGetter
): PrismaSessionStorage {
  return new PrismaSessionStorage(prismaOrGetter);
}

/**
 * Creates the Shopify app configuration with the provided session storage.
 *
 * This factory function is called per-request to ensure proper isolation
 * in Workers environments where concurrent requests share the same isolate.
 *
 * @param sessionStorage - A session storage instance for this request
 * @returns Configured Shopify app instance
 */
export function createShopifyApp(sessionStorage: PrismaSessionStorage) {
  return shopifyApp({
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
    ...(process.env.SHOP_CUSTOM_DOMAIN
      ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
      : {}),
  });
}

export const apiVersion = ApiVersion.October26;

// Re-export types needed by routes
export type { PrismaSessionStorage };
