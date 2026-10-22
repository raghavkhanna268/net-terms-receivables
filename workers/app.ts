import { createRequestHandler } from "react-router";
import { wrapWithSentry } from "~/lib/sentry";
import type { PrismaClient } from "../app/lib/db.server";
import { createPrismaClient } from "../app/lib/db.server";
import { requestContext } from "../app/lib/request-context.server";
import { getShopifyApp, sessionStorage } from "../app/shopify.server";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE
);

export default wrapWithSentry({
  async fetch(request, env, ctx) {
    // Lazy Prisma client: only created when a route actually touches the DB.
    // Requests that don't need the database (static assets, health checks)
    // never open a connection. Hyperdrive handles pooling at the network level.
    let prisma: PrismaClient | null = null;
    const getPrisma = (): PrismaClient => {
      if (!prisma) {
        prisma = createPrismaClient(env.HYPERDRIVE.connectionString);
      }
      return prisma;
    };

    // Get the module-scoped Shopify app singleton (created once per isolate).
    // Session storage uses AsyncLocalStorage internally to get the correct
    // Prisma client for this request.
    const shopify = getShopifyApp();

    // Run the request inside AsyncLocalStorage context so session storage
    // can access this request's Prisma client getter.
    try {
      return await requestContext.run({ getPrisma }, async () => {
        return requestHandler(request, {
          cloudflare: { env, ctx },
          sessionStorage,
          shopify,
        });
      });
    } finally {
      // $disconnect runs in ctx.waitUntil after the response is sent to the client.
      // This allows graceful connection cleanup without blocking the response.
      // Only disconnects if the Prisma client was actually created during this request.
      // Using finally ensures cleanup even when the handler throws.
      if (prisma !== null) {
        ctx.waitUntil((prisma as PrismaClient).$disconnect());
      }
    }
  },
} satisfies ExportedHandler<Env>);
