import { AsyncLocalStorage } from "node:async_hooks";
import type { PrismaClient } from "~/generated/prisma/client";
import type { Sql } from "./db-light.server";

export type PrismaClientGetter = () => PrismaClient;
export type SqlGetter = () => Sql;

export interface RequestStore {
  getSql: SqlGetter;
  getPrisma?: PrismaClientGetter;
}

/**
 * AsyncLocalStorage for request-scoped database client access.
 *
 * Workers I/O objects (Hyperdrive connections) cannot cross request boundaries.
 * This ALS provides each request with its own lazy database client getters while
 * allowing module-scoped singletons (like LightSessionStorage) to access the
 * correct client for the current request.
 *
 * Pattern:
 * 1. workers/app.ts runs each request inside requestContext.run({ getSql, getPrisma? })
 * 2. Session storage calls getRequestSql() to get the current request's SQL client
 * 3. Business routes can call getRequestPrisma() for ORM features (lazy-loaded)
 * 4. No explicit sql.end(): clients are per-request and are not ended; Hyperdrive manages connection lifecycle (see workers/app.ts, PR #33)
 *
 * The lightweight SQL client (postgres.js) is used for session operations,
 * while Prisma is available for business logic that needs ORM features.
 */
export const requestContext = new AsyncLocalStorage<RequestStore>();

/**
 * Get the postgres.js SQL client for the current request.
 * Used by LightSessionStorage for session operations.
 *
 * @throws Error if called outside of a request context (requestContext.run)
 */
export function getRequestSql(): Sql {
  const store = requestContext.getStore();
  if (!store) {
    throw new Error(
      "getRequestSql() called outside of request context. " +
        "Ensure this is called within requestContext.run() in workers/app.ts."
    );
  }
  return store.getSql();
}

/**
 * Get the Prisma client for the current request.
 * Only available when getPrisma was provided in the store.
 *
 * @throws Error if called outside of a request context or Prisma not available
 */
export function getRequestPrisma(): PrismaClient {
  const store = requestContext.getStore();
  if (!store) {
    throw new Error(
      "getRequestPrisma() called outside of request context. " +
        "Ensure this is called within requestContext.run() in workers/app.ts."
    );
  }
  if (!store.getPrisma) {
    throw new Error(
      "Prisma client not available in this request context. " +
        "This request is using lightweight SQL only."
    );
  }
  return store.getPrisma();
}
