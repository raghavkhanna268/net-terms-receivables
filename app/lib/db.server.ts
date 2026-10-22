import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "~/generated/prisma/client";

/**
 * Creates a PrismaClient configured for Cloudflare Workers with Hyperdrive.
 *
 * IMPORTANT: This must be called per-request in Workers to avoid connection issues.
 * Workers isolates can handle concurrent requests, and module-level clients would
 * share mutable state across requests. Hyperdrive provides connection pooling at
 * the network level, so per-request client creation is efficient.
 *
 * @param connectionString - The Hyperdrive connection string from env.HYPERDRIVE.connectionString
 * @returns A configured PrismaClient instance
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

export type { PrismaClient };
