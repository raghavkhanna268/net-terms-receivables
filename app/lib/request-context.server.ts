import { AsyncLocalStorage } from "node:async_hooks";
import type { PrismaClient } from "~/generated/prisma/client";
import type { Sql } from "./db-light.server";

export type PrismaClientGetter = () => PrismaClient;
export type SqlGetter = () => Sql;
export type WaitUntilFn = (promise: Promise<unknown>) => void;

/**
 * Minimal Worker env interface for feature flags used by drain handlers.
 * Add fields as needed when handlers require env bindings.
 */
export interface WorkerEnv {
  CUSTOMER_PII_FIELDS?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
}

export interface RequestStore {
  getSql: SqlGetter;
  getPrisma?: PrismaClientGetter;
  /** ctx.waitUntil for background tasks that outlive the request response */
  waitUntil?: WaitUntilFn;
  /** Worker env bindings for feature flags (optional, used by drain handlers) */
  env?: WorkerEnv;
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

/**
 * Get the waitUntil function for the current request.
 * Used for background tasks that should outlive the response.
 *
 * Returns undefined if called outside request context or waitUntil not available.
 * This is intentional - callers should handle the case gracefully (e.g., skip
 * background refresh when waitUntil is not available).
 */
export function getRequestWaitUntil(): WaitUntilFn | undefined {
  const store = requestContext.getStore();
  return store?.waitUntil;
}

/**
 * Get the Worker env bindings for the current request.
 * Used by drain handlers that need feature flags (e.g., CUSTOMER_PII_FIELDS).
 *
 * Returns undefined if called outside request context or env not available.
 * Callers should fall back to process.env if needed.
 */
export function getRequestEnv(): WorkerEnv | undefined {
  const store = requestContext.getStore();
  return store?.env;
}
