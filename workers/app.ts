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
    //
    // S21: Pass ctx.waitUntil via ALS for background tasks (e.g., stale plan
    // cache refresh). This avoids module-global state that could leak across
    // requests in long-lived isolates.
    // S8: Pass env for feature flags (e.g., CUSTOMER_PII_FIELDS for drain handlers).
    return requestContext.run({ getSql, waitUntil: (p) => ctx.waitUntil(p), env }, async () => {
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
   * IMPORTANT: Runs inside requestContext.run() so that:
   * 1. Session storage (LightSessionStorage) can access the SQL client
   * 2. unauthenticated.admin() can load and refresh offline sessions
   * 3. Token refresh persists back through session storage
   *
   * @param event - Cron trigger event with scheduled time
   * @param env - Worker environment bindings
   * @param ctx - Execution context for waitUntil
   */
  async scheduled(event, env, ctx) {
    let sql: Sql | null = null;
    const getSql = (): Sql => {
      if (!sql) {
        sql = createSql(env.HYPERDRIVE.connectionString);
      }
      return sql;
    };

    try {
      console.log(`[scheduled] cron trigger at ${new Date(event.scheduledTime).toISOString()}`);

      // Run inside ALS context so session storage works for unauthenticated.admin()
      // S8: Pass env for feature flags (e.g., CUSTOMER_PII_FIELDS for drain handlers).
      const result = await requestContext.run({ getSql, env }, async () => {
        return runDrain(getSql(), {
          batchSize: 10,
        });
      });

      console.log(
        `[scheduled] drain complete: processed=${result.processed} ` +
          `skipped=${result.skipped} failed=${result.failed} ` +
          `dlq=${result.deadLettered} noHandler=${result.noHandler} ` +
          `timedOut=${result.timedOut} elapsed=${result.elapsedMs}ms`
      );
    } catch (error) {
      // Log error class only, not raw error (J1)
      const errName = error instanceof Error ? error.name : "unknown";
      const errCode = error instanceof Error && "code" in error ? (error as { code: string }).code : undefined;
      console.error(`[scheduled] drain error: err=${errCode ?? errName}`);
    } finally {
      if (sql !== null) {
        // Use type assertion because TypeScript's flow analysis doesn't track
        // mutation in the closure (getSql assigns to sql)
        ctx.waitUntil((sql as Sql).end());
      }
    }
  },
} satisfies ExportedHandler<Env>);
