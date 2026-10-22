import { defineConfig } from "prisma/config";

/**
 * Prisma 7 configuration for datasource URLs.
 *
 * These URLs are used by Prisma CLI commands (migrate, db push, etc).
 * The Worker connects through Hyperdrive binding, not these URLs.
 *
 * In CI, set DATABASE_URL via env: from the DATABASE_URL_MIGRATIONS secret.
 * For local dev, set these in .dev.vars or environment.
 */
export default defineConfig({
  datasources: {
    db: {
      // URL for migrations and CLI operations (Supabase SESSION pooler, port 5432)
      url: process.env.DATABASE_URL,
      // Direct URL bypasses pooler for schema changes (optional, falls back to url)
      directUrl: process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL,
    },
  },
});
