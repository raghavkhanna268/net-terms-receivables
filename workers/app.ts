import { createRequestHandler } from "react-router";
import { wrapWithSentry } from "~/lib/sentry";
import { createPrismaClient } from "../app/lib/db.server";
import { createSessionStorage, createShopifyApp } from "../app/shopify.server";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE
);

export default wrapWithSentry({
  async fetch(request, env, ctx) {
    // Create per-request database client using Hyperdrive connection pooling
    // This is required in Workers: module-level clients would share mutable state
    // across concurrent requests in the same isolate
    const prisma = createPrismaClient(env.HYPERDRIVE.connectionString);

    // Create per-request session storage backed by Prisma
    const sessionStorage = createSessionStorage(prisma);

    // Create per-request Shopify app instance with the session storage
    const shopify = createShopifyApp(sessionStorage);

    return requestHandler(request, {
      cloudflare: { env, ctx },
      // Inject per-request instances for routes to use
      prisma,
      sessionStorage,
      shopify,
    });
  },
} satisfies ExportedHandler<Env>);
