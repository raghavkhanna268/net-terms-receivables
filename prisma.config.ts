import { defineConfig } from "prisma/config";

/**
 * Prisma 7 configuration.
 *
 * This file must be at the repository root for Prisma CLI to find it.
 * The Worker connects through Hyperdrive binding, not these URLs.
 *
 * In CI, set DATABASE_URL via env: from the DATABASE_URL_MIGRATIONS secret.
 * For local dev, set DATABASE_URL in environment or .dev.vars.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
});
