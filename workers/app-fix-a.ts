/**
 * FIX A: Module-scoped Shopify app and Sentry initialization
 * 
 * This version caches the Shopify app instance at module scope so it's only
 * created once per isolate, not per request. The session storage uses a
 * request-scoped Prisma getter via AsyncLocalStorage.
 */
import { createRequestHandler } from "react-router";
import { wrapWithSentry } from "~/lib/sentry";
import type { PrismaClient } from "../app/lib/db.server";
import { createPrismaClient } from "../app/lib/db.server";
import { PrismaSessionStorage } from "../app/lib/session-storage.server";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import "@shopify/shopify-app-react-router/adapters/node";
import { parseScopes } from "~/lib/scopes";

// Module-scoped request handler (created once)
const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE
);

// AsyncLocalStorage for per-request Prisma client
const { AsyncLocalStorage } = await import("node:async_hooks");
const prismaStorage = new AsyncLocalStorage<{ getPrisma: () => PrismaClient }>();

/**
 * Request-scoped Prisma client getter.
 * Uses AsyncLocalStorage to get the correct Prisma instance for the current request.
 */
function getRequestPrisma(): PrismaClient {
  const store = prismaStorage.getStore();
  if (!store) {
    throw new Error("Prisma client accessed outside of request context");
  }
  return store.getPrisma();
}

// Module-scoped session storage using request-scoped Prisma getter
const sessionStorage = new PrismaSessionStorage(getRequestPrisma);

// Module-scoped Shopify app (created once per isolate)
const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET!,
  apiVersion: ApiVersion.October26,
  scopes: parseScopes(process.env.SCOPES ?? ""),
  appUrl: process.env.SHOPIFY_APP_URL!,
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

export default wrapWithSentry({
  async fetch(request, env, ctx) {
    // Per-request lazy Prisma client
    let prisma: PrismaClient | null = null;
    const getPrisma = (): PrismaClient => {
      if (!prisma) {
        prisma = createPrismaClient(env.HYPERDRIVE.connectionString);
      }
      return prisma;
    };

    // Run the request handler within AsyncLocalStorage context
    const response = await prismaStorage.run({ getPrisma }, async () => {
      return requestHandler(request, {
        cloudflare: { env, ctx },
        sessionStorage,
        shopify,
      });
    });

    // Cleanup Prisma connection after response
    if (prisma !== null) {
      ctx.waitUntil((prisma as PrismaClient).$disconnect());
    }

    return response;
  },
} satisfies ExportedHandler<Env>);
