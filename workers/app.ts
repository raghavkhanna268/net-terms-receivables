import { createRequestHandler } from "react-router";
import { wrapWithSentry } from "~/lib/sentry";
import type { PrismaClient } from "../app/lib/db.server";
import { createPrismaClient } from "../app/lib/db.server";
import { createSessionStorage, createShopifyApp } from "../app/shopify.server";

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

    // Session storage wraps lazy client getter - DB accessed only when session ops run
    const sessionStorage = createSessionStorage(getPrisma);

    // Shopify app instance for this request
    const shopify = createShopifyApp(sessionStorage);

    try {
      return await requestHandler(request, {
        cloudflare: { env, ctx },
        sessionStorage,
        shopify,
      });
    } finally {
      // $disconnect runs in ctx.waitUntil after the response is sent to the client.
      // This allows graceful connection cleanup without blocking the response.
      if (prisma !== null) {
        ctx.waitUntil((prisma as PrismaClient).$disconnect());
      }
    }
  },
} satisfies ExportedHandler<Env>);
