import { createRequestHandler } from "react-router";
import { wrapWithSentry } from "~/lib/sentry";
import type { Sql } from "../app/lib/db-light.server";
import { createSql } from "../app/lib/db-light.server";
import { requestContext } from "../app/lib/request-context.server";
import { getShopifyApp, sessionStorage } from "../app/shopify.server";
import { runDrain } from "../app/services/drain/processor.server";

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
    // No explicit sql.end() needed: Hyperdrive automatically cleans up
    // Worker-to-edge connections when the request ends.
    // @see https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/
    return requestContext.run({ getSql }, async () => {
      return requestHandler(request, {
        cloudflare: { env, ctx },
        sessionStorage,
        shopify,
      });
    });
  },

  /**
   * Workers Cron scheduled handler (S10).
   *
   * Runs every 5 minutes as a keep-alive and fallback drain.
   * The primary drain is via pg_cron + pg_net every minute.
   * This provides redundancy in case pg_net requests fail.
   *
   * @param event - Cron trigger event with scheduled time
   * @param env - Worker environment bindings
   * @param ctx - Execution context for waitUntil
   */
  async scheduled(event, env, ctx) {
    const sql = createSql(env.HYPERDRIVE.connectionString);

    try {
      console.log(`[scheduled] cron trigger at ${new Date(event.scheduledTime).toISOString()}`);

      // Run the drain with generous batch size for cron
      // Time budget is 15s default (configurable in DrainConfig)
      const result = await runDrain(sql, {
        batchSize: 10,
      });

      console.log(
        `[scheduled] drain complete: processed=${result.processed} ` +
          `skipped=${result.skipped} failed=${result.failed} ` +
          `dlq=${result.deadLettered} noHandler=${result.noHandler} ` +
          `timedOut=${result.timedOut} elapsed=${result.elapsedMs}ms`
      );
    } catch (error) {
      console.error("[scheduled] drain error:", error);
    } finally {
      ctx.waitUntil(closeSql(sql));
    }
  },
} satisfies ExportedHandler<Env>);
