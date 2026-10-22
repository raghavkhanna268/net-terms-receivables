/**
 * EXPERIMENTAL: Kysely-based Worker Entry
 * 
 * This worker uses Kysely instead of Prisma for database operations.
 * Bundle size comparison:
 * - With Prisma: ~5MB (3.4MB WASM + 1.5MB runtime)
 * - With Kysely: ~800KB (no WASM)
 * 
 * To test: Update vite.config.ts to use this entry point
 * Or create a separate build config
 */
import { createRequestHandler } from "react-router";
import { wrapWithSentry } from "~/lib/sentry";
import { createKyselyDb, destroyKyselyDb, type KyselyDb } from "~/lib/db-kysely.server";
import { KyselySessionStorage } from "~/lib/session-storage-kysely.server";
import { createShopifyApp } from "../app/shopify.server";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE
);

export default wrapWithSentry({
  async fetch(request, env, ctx) {
    let db: KyselyDb | null = null;
    
    const getDb = (): KyselyDb => {
      if (!db) {
        db = createKyselyDb(env.HYPERDRIVE.connectionString);
      }
      return db;
    };

    const sessionStorage = new KyselySessionStorage(getDb);
    const shopify = createShopifyApp(sessionStorage as any); // Type coercion needed

    try {
      return await requestHandler(request, {
        cloudflare: { env, ctx },
        sessionStorage,
        shopify,
      });
    } finally {
      if (db !== null) {
        ctx.waitUntil(destroyKyselyDb(db));
      }
    }
  },
} satisfies ExportedHandler<Env>);
