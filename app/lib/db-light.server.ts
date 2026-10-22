/**
 * Lightweight postgres.js database client for Cloudflare Workers.
 *
 * postgres.js is ~45KB gzipped vs ~1.1MB for Prisma WASM, making it ideal
 * for Workers where bundle size affects cold start time.
 *
 * Features:
 * - Fully typed SQL template literals
 * - Connection pooling via Hyperdrive (no client-side pool needed)
 * - Tagged template literals prevent SQL injection
 * - No WASM, no query compilation overhead
 */

import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

/**
 * Session row type matching the Prisma schema.
 * Keep in sync with prisma/schema.prisma Session model.
 */
export interface SessionRow {
  id: string;
  shop: string;
  state: string;
  isOnline: boolean;
  scope: string | null;
  expires: Date | null;
  accessToken: string;
  userId: bigint | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  accountOwner: boolean;
  locale: string | null;
  collaborator: boolean;
  emailVerified: boolean;
  refreshToken: string | null;
  refreshTokenExpires: Date | null;
}

/**
 * Creates a postgres.js SQL client for Cloudflare Workers with Hyperdrive.
 *
 * @param connectionString - The Hyperdrive connection string from env.HYPERDRIVE.connectionString
 * @returns A configured postgres.js SQL instance
 */
export function createSql(connectionString: string): Sql {
  return postgres(connectionString, {
    // Hyperdrive handles pooling, so we only need 1 connection per request
    max: 1,
    // Transform column names from snake_case to camelCase
    // Our schema uses camelCase (Prisma convention), so disable this
    transform: { undefined: null },
    // Connection settings optimized for Workers
    idle_timeout: 0, // Don't hold idle connections
    connect_timeout: 10, // 10 second timeout
  });
}

/**
 * Closes the SQL client connection.
 * Call this in ctx.waitUntil after the response.
 */
export async function closeSql(sql: Sql): Promise<void> {
  await sql.end();
}
