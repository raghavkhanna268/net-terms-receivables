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
 *
 * Note: postgres.js returns bigint (int8) columns as strings to avoid
 * JavaScript number precision loss. The userId field is typed as string.
 */
export interface SessionRow {
  id: string;
  shop: string;
  state: string;
  isOnline: boolean;
  scope: string | null;
  expires: Date | null;
  accessToken: string;
  userId: string | null; // postgres.js returns int8 as string
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
    // Hyperdrive handles pooling at the network level, so we use a single
    // connection per request. The client is created lazily and closed in
    // ctx.waitUntil after the response.
    max: 1,
    // Null handling for undefined values in parameters
    transform: { undefined: null },
    // Connection timeout in seconds
    connect_timeout: 10,
    // Skip type-lookup query on new connections (saves a round trip).
    // Required for Hyperdrive per Cloudflare docs. Side effect: array literal
    // syntax like `${ids}::text[]` fails; use `ANY(${ids})` or `IN ${sql(ids)}`
    // instead. Date/boolean/bigint parsing still works via postgres.js defaults.
    fetch_types: false,
  });
}

/**
 * Closes the SQL client connection.
 * Call this in ctx.waitUntil after the response.
 */
export async function closeSql(sql: Sql): Promise<void> {
  await sql.end();
}
