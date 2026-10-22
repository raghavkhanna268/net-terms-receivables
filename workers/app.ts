import { createRequestHandler } from "react-router";
import { wrapWithSentry } from "~/lib/sentry";
import type { Sql } from "../app/lib/db-light.server";
import { createSql, closeSql } from "../app/lib/db-light.server";
import { requestContext } from "../app/lib/request-context.server";
import { getShopifyApp, sessionStorage } from "../app/shopify.server";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE
);

export default wrapWithSentry({
  async fetch(request, env, ctx) {
    // Lazy SQL client: only created when a route actually touches the DB.
    // Uses postgres.js (~45KB) instead of Prisma (~1.1MB WASM) for session
    // operations, significantly reducing cold start time.
    // Requests that don't need the database (static assets, health checks)
    // never open a connection. Hyperdrive handles pooling at the network level.
    let sql: Sql | null = null;
    const getSql = (): Sql => {
      if (!sql) {
        sql = createSql(env.HYPERDRIVE.connectionString);
      }
      return sql;
    };

    // Get the module-scoped Shopify app singleton (created once per isolate).
    // Session storage uses AsyncLocalStorage internally to get the correct
    // SQL client for this request.
    const shopify = getShopifyApp();

    // Run the request inside AsyncLocalStorage context so session storage
    // can access this request's SQL client getter.
    try {
      return await requestContext.run({ getSql }, async () => {
        return requestHandler(request, {
          cloudflare: { env, ctx },
          sessionStorage,
          shopify,
        });
      });
    } finally {
      // Close SQL connection in ctx.waitUntil after the response is sent.
      // This allows graceful cleanup without blocking the response.
      // Only closes if the SQL client was actually created during this request.
      // Using finally ensures cleanup even when the handler throws.
      if (sql !== null) {
        ctx.waitUntil(closeSql(sql));
      }
    }
  },
} satisfies ExportedHandler<Env>);
