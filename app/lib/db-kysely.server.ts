/**
 * Kysely database client for Cloudflare Workers
 * 
 * This is an EXPERIMENTAL alternative to Prisma for session storage.
 * Benefits:
 * - ~50KB bundle vs ~4.4MB for Prisma
 * - No WASM instantiation overhead
 * - Direct SQL with TypeScript types
 * 
 * Tradeoffs:
 * - Manual type definitions (no Prisma generate)
 * - Keep using Prisma for migrations
 */

import { Kysely, PostgresDialect, Generated, ColumnType } from 'kysely';
import { Pool } from 'pg';

export interface SessionTable {
  id: string;
  shop: string;
  state: string;
  isOnline: boolean;
  scope: string | null;
  expires: ColumnType<Date | null, string | Date | null, string | Date | null>;
  accessToken: string;
  userId: Generated<bigint | null>;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  accountOwner: boolean;
  locale: string | null;
  collaborator: boolean;
  emailVerified: boolean;
  refreshToken: string | null;
  refreshTokenExpires: ColumnType<Date | null, string | Date | null, string | Date | null>;
}

export interface Database {
  Session: SessionTable;
}

export type KyselyDb = Kysely<Database>;

/**
 * Creates a Kysely database client for Cloudflare Workers with Hyperdrive.
 * 
 * @param connectionString - The Hyperdrive connection string
 * @returns A configured Kysely instance
 */
export function createKyselyDb(connectionString: string): KyselyDb {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString,
        max: 1, // Single connection per request in Workers
      }),
    }),
  });
}

export async function destroyKyselyDb(db: KyselyDb): Promise<void> {
  await db.destroy();
}
