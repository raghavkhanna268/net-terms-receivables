import { AsyncLocalStorage } from "node:async_hooks";
import type { PrismaClient } from "~/generated/prisma/client";

export type PrismaClientGetter = () => PrismaClient;

interface RequestStore {
  getPrisma: PrismaClientGetter;
}

/**
 * AsyncLocalStorage for request-scoped Prisma client access.
 *
 * Workers I/O objects (Hyperdrive connections) cannot cross request boundaries.
 * This ALS provides each request with its own lazy Prisma client getter while
 * allowing module-scoped singletons (like PrismaSessionStorage) to access the
 * correct client for the current request.
 *
 * Pattern:
 * 1. workers/app.ts runs each request inside requestContext.run({ getPrisma })
 * 2. Session storage calls getRequestPrisma() to get the current request's client
 * 3. The Prisma client is created lazily (only when actually used)
 * 4. ctx.waitUntil disconnects the client after the response, if it was created
 */
export const requestContext = new AsyncLocalStorage<RequestStore>();

/**
 * Get the Prisma client for the current request.
 *
 * @throws Error if called outside of a request context (requestContext.run)
 */
export function getRequestPrisma(): PrismaClient {
  const store = requestContext.getStore();
  if (!store) {
    throw new Error(
      "getRequestPrisma() called outside of request context. " +
        "Ensure this is called within requestContext.run() in workers/app.ts."
    );
  }
  return store.getPrisma();
}
