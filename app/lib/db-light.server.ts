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

import postgres, { type Options } from "postgres";

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
 * Shared postgres.js options for both production and test clients.
 *
 * Key behaviors:
 * - fetch_types: false - Required for Hyperdrive, skips type-lookup query
 * - Decimal/numeric columns return as strings (no precision loss)
 * - TIMESTAMPTZ returns as Date objects
 * - Bigint (int8) returns as strings
 * - JSON/JSONB columns are parsed as objects (built-in for oids 114/3802)
 *
 * For JSON writes, use sql.json(obj) to serialize correctly.
 * Use this for all postgres() clients to ensure consistent type handling.
 */
export const sqlOptions: Options<Record<string, never>> = {
  // Hyperdrive handles pooling at the network level, so we use a single
  // connection per request. The client is created lazily and closed in
  // ctx.waitUntil after the response.
  max: 1,
  // Null handling for undefined values in parameters
  transform: { undefined: null },
  // Connection timeout in seconds
  connect_timeout: 10,
  // Skip type-lookup query on new connections (saves a round trip).
  // Required for Hyperdrive per Cloudflare docs. Side effect: array params
  // need explicit handling - use `IN ${sql(ids)}` instead of `ANY(${ids})`
  // because ANY() needs type info to serialize arrays correctly.
  // JSON/JSONB parsing still works (built-in for oids 114/3802).
  fetch_types: false,
};

/**
 * Creates a postgres.js SQL client for Cloudflare Workers with Hyperdrive.
 *
 * @param connectionString - The Hyperdrive connection string from env.HYPERDRIVE.connectionString
 * @returns A configured postgres.js SQL instance
 */
export function createSql(connectionString: string): Sql {
  return postgres(connectionString, sqlOptions);
}

/**
 * Closes the SQL client connection.
 * Call this in ctx.waitUntil after the response.
 */
export async function closeSql(sql: Sql): Promise<void> {
  await sql.end();
}
