import { describe, it, expect, vi, beforeEach } from "vitest";
import { requestContext, getRequestPrisma, getRequestWaitUntil, type PrismaClientGetter, type RequestStore } from "../../lib/request-context.server";
import { PrismaSessionStorage } from "../../lib/session-storage.server";
import type { PrismaClient } from "~/generated/prisma/client";
import type { Sql } from "../../lib/db-light.server";

/**
 * Tests for AsyncLocalStorage-based request isolation.
 *
 * This verifies that:
 * 1. Concurrent requests get isolated Prisma clients (no cross-request leakage)
 * 2. Session storage uses the correct client for each request context
 * 3. Clients are only created when actually used (lazy initialization)
 * 4. Accessing getRequestPrisma outside of context throws
 *
 * These tests simulate the pattern used in workers/app.ts without
 * requiring a real database or Cloudflare environment.
 */

interface MockPrismaClient {
  id: string;
  session: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  $disconnect: ReturnType<typeof vi.fn>;
}

function createMockPrismaClient(id: string): MockPrismaClient {
  return {
    id,
    session: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

function asPrismaGetter(mock: MockPrismaClient): PrismaClientGetter {
  return () => mock as unknown as PrismaClient;
}

// Mock SQL client for the request store (required field)
function createMockSql(): Sql {
  const mockSql = vi.fn() as unknown as Sql;
  (mockSql as unknown as { end: () => Promise<void> }).end = vi.fn().mockResolvedValue(undefined);
  return mockSql;
}

function createStore(mock: MockPrismaClient): RequestStore {
  return {
    getSql: () => createMockSql(),
    getPrisma: asPrismaGetter(mock),
  };
}

function createStoreWithSqlOnly(): RequestStore {
  return {
    getSql: () => createMockSql(),
  };
}

describe("AsyncLocalStorage Request Isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getRequestPrisma()", () => {
    it("throws when called outside of request context", () => {
      expect(() => getRequestPrisma()).toThrow(
        "getRequestPrisma() called outside of request context"
      );
    });

    it("returns the Prisma client from the current request context", async () => {
      const mockClient = createMockPrismaClient("test-client");

      const result = await requestContext.run(createStore(mockClient), () => {
        return getRequestPrisma();
      });

      expect(result).toEqual(mockClient);
    });

    it("returns the same client within a single request context", async () => {
      const mockClient = createMockPrismaClient("test-client");
      const getPrismaFn = vi.fn(asPrismaGetter(mockClient));

      await requestContext.run({ getSql: () => createMockSql(), getPrisma: getPrismaFn }, async () => {
        const client1 = getRequestPrisma();
        const client2 = getRequestPrisma();

        expect(client1).toEqual(client2);
        expect(client1).toEqual(mockClient);
      });
    });

    it("throws when getPrisma is not provided", async () => {
      await requestContext.run(createStoreWithSqlOnly(), async () => {
        expect(() => getRequestPrisma()).toThrow(
          "Prisma client not available in this request context"
        );
      });
    });
  });

  describe("Concurrent request isolation", () => {
    it("isolates Prisma clients between concurrent requests", async () => {
      const client1 = createMockPrismaClient("request-1-client");
      const client2 = createMockPrismaClient("request-2-client");

      const seenClients: string[] = [];

      const request1 = requestContext.run(createStore(client1), async () => {
        await new Promise((r) => setTimeout(r, 10));
        const client = getRequestPrisma() as unknown as MockPrismaClient;
        seenClients.push(client.id);
        return client.id;
      });

      const request2 = requestContext.run(createStore(client2), async () => {
        await new Promise((r) => setTimeout(r, 5));
        const client = getRequestPrisma() as unknown as MockPrismaClient;
        seenClients.push(client.id);
        return client.id;
      });

      const [result1, result2] = await Promise.all([request1, request2]);

      expect(result1).toBe("request-1-client");
      expect(result2).toBe("request-2-client");
      expect(seenClients).toContain("request-1-client");
      expect(seenClients).toContain("request-2-client");
    });

    it("prevents client leakage across interleaved async operations", async () => {
      const client1 = createMockPrismaClient("client-A");
      const client2 = createMockPrismaClient("client-B");
      const client3 = createMockPrismaClient("client-C");

      const clientsPerRequest: Map<number, string[]> = new Map([
        [1, []],
        [2, []],
        [3, []],
      ]);

      const simulateRequest = (
        requestId: number,
        client: MockPrismaClient,
        delays: number[]
      ) => {
        return requestContext.run(createStore(client), async () => {
          for (const delay of delays) {
            await new Promise((r) => setTimeout(r, delay));
            const currentClient = getRequestPrisma() as unknown as MockPrismaClient;
            clientsPerRequest.get(requestId)!.push(currentClient.id);
          }
          return requestId;
        });
      };

      await Promise.all([
        simulateRequest(1, client1, [5, 15, 25]),
        simulateRequest(2, client2, [3, 12, 22]),
        simulateRequest(3, client3, [1, 8, 18]),
      ]);

      expect(clientsPerRequest.get(1)).toEqual(["client-A", "client-A", "client-A"]);
      expect(clientsPerRequest.get(2)).toEqual(["client-B", "client-B", "client-B"]);
      expect(clientsPerRequest.get(3)).toEqual(["client-C", "client-C", "client-C"]);
    });
  });

  describe("PrismaSessionStorage with ALS", () => {
    it("uses the request-scoped client when constructed without args", async () => {
      const mockClient = createMockPrismaClient("als-client");
      mockClient.session.findUnique.mockResolvedValue({
        id: "test-session",
        shop: "test.myshopify.com",
        state: "active",
        isOnline: false,
        accessToken: "token",
        scope: null,
        expires: null,
        userId: null,
        firstName: null,
        lastName: null,
        email: null,
        accountOwner: false,
        locale: null,
        collaborator: false,
        emailVerified: false,
        refreshToken: null,
        refreshTokenExpires: null,
      });

      const storage = new PrismaSessionStorage();

      await requestContext.run(createStore(mockClient), async () => {
        const session = await storage.loadSession("test-session");
        expect(session).toBeDefined();
        expect(session?.id).toBe("test-session");
        expect(mockClient.session.findUnique).toHaveBeenCalledWith({
          where: { id: "test-session" },
        });
      });
    });

    it("isolates storage operations between concurrent requests", async () => {
      const client1 = createMockPrismaClient("storage-client-1");
      const client2 = createMockPrismaClient("storage-client-2");

      client1.session.deleteMany.mockResolvedValue({ count: 3 });
      client2.session.deleteMany.mockResolvedValue({ count: 7 });

      const storage = new PrismaSessionStorage();

      const [count1, count2] = await Promise.all([
        requestContext.run(createStore(client1), async () => {
          return storage.deleteAllForShop("shop1.myshopify.com");
        }),
        requestContext.run(createStore(client2), async () => {
          return storage.deleteAllForShop("shop2.myshopify.com");
        }),
      ]);

      expect(count1).toBe(3);
      expect(count2).toBe(7);

      expect(client1.session.deleteMany).toHaveBeenCalledWith({
        where: { shop: "shop1.myshopify.com" },
      });
      expect(client2.session.deleteMany).toHaveBeenCalledWith({
        where: { shop: "shop2.myshopify.com" },
      });

      expect(client1.session.deleteMany).not.toHaveBeenCalledWith({
        where: { shop: "shop2.myshopify.com" },
      });
      expect(client2.session.deleteMany).not.toHaveBeenCalledWith({
        where: { shop: "shop1.myshopify.com" },
      });
    });

    it("still accepts direct client injection for tests", async () => {
      const directClient = createMockPrismaClient("direct-client");
      directClient.session.findUnique.mockResolvedValue({
        id: "direct-session",
        shop: "direct.myshopify.com",
        state: "active",
        isOnline: false,
        accessToken: "direct-token",
        scope: null,
        expires: null,
        userId: null,
        firstName: null,
        lastName: null,
        email: null,
        accountOwner: false,
        locale: null,
        collaborator: false,
        emailVerified: false,
        refreshToken: null,
        refreshTokenExpires: null,
      });

      const storage = new PrismaSessionStorage(directClient as unknown as PrismaClient);

      const session = await storage.loadSession("direct-session");

      expect(session).toBeDefined();
      expect(session?.id).toBe("direct-session");
      expect(directClient.session.findUnique).toHaveBeenCalled();
    });
  });

  describe("Lazy client creation", () => {
    it("does not create client until getPrisma is called", async () => {
      const mockClient = createMockPrismaClient("lazy-client");
      const factory = vi.fn(asPrismaGetter(mockClient));

      await requestContext.run({ getSql: () => createMockSql(), getPrisma: factory }, async () => {
        expect(factory).not.toHaveBeenCalled();

        getRequestPrisma();
        expect(factory).toHaveBeenCalledTimes(1);

        getRequestPrisma();
        expect(factory).toHaveBeenCalledTimes(2);
      });
    });

    it("simulates workers/app.ts lazy pattern (create once, access many)", async () => {
      let client: MockPrismaClient | null = null;
      const createCount = { value: 0 };

      const getPrisma = (): PrismaClient => {
        if (!client) {
          createCount.value++;
          client = createMockPrismaClient(`lazy-${createCount.value}`);
        }
        return client as unknown as PrismaClient;
      };

      await requestContext.run({ getSql: () => createMockSql(), getPrisma }, async () => {
        const c1 = getRequestPrisma();
        const c2 = getRequestPrisma();
        const c3 = getRequestPrisma();

        expect(c1).toBe(c2);
        expect(c2).toBe(c3);
        expect(createCount.value).toBe(1);
        expect((c1 as unknown as MockPrismaClient).id).toBe("lazy-1");
      });
    });
  });

  describe("waitUntil isolation (S21 plan refresh)", () => {
    it("returns undefined when waitUntil is not provided", async () => {
      await requestContext.run(createStoreWithSqlOnly(), async () => {
        const waitUntil = getRequestWaitUntil();
        expect(waitUntil).toBeUndefined();
      });
    });

    it("returns the waitUntil function from the current request context", async () => {
      const mockWaitUntil = vi.fn();
      const store: RequestStore = {
        getSql: () => createMockSql(),
        waitUntil: mockWaitUntil,
      };

      await requestContext.run(store, async () => {
        const waitUntil = getRequestWaitUntil();
        expect(waitUntil).toBeDefined();
        expect(waitUntil).toBe(mockWaitUntil);
      });
    });

    it("isolates waitUntil between overlapping requests", async () => {
      const waitUntil1Calls: Promise<unknown>[] = [];
      const waitUntil2Calls: Promise<unknown>[] = [];

      const store1: RequestStore = {
        getSql: () => createMockSql(),
        waitUntil: (p) => waitUntil1Calls.push(p),
      };
      const store2: RequestStore = {
        getSql: () => createMockSql(),
        waitUntil: (p) => waitUntil2Calls.push(p),
      };

      // Simulate overlapping requests where both trigger background tasks
      const request1 = requestContext.run(store1, async () => {
        await new Promise((r) => setTimeout(r, 5));
        const waitUntil = getRequestWaitUntil();
        waitUntil?.(Promise.resolve("task-1a"));
        await new Promise((r) => setTimeout(r, 10));
        waitUntil?.(Promise.resolve("task-1b"));
        return "request-1";
      });

      const request2 = requestContext.run(store2, async () => {
        await new Promise((r) => setTimeout(r, 3));
        const waitUntil = getRequestWaitUntil();
        waitUntil?.(Promise.resolve("task-2a"));
        await new Promise((r) => setTimeout(r, 15));
        waitUntil?.(Promise.resolve("task-2b"));
        return "request-2";
      });

      const [result1, result2] = await Promise.all([request1, request2]);

      expect(result1).toBe("request-1");
      expect(result2).toBe("request-2");

      // Each request's waitUntil should only have its own tasks
      expect(waitUntil1Calls).toHaveLength(2);
      expect(waitUntil2Calls).toHaveLength(2);

      // Verify no cross-contamination
      const resolved1 = await Promise.all(waitUntil1Calls);
      const resolved2 = await Promise.all(waitUntil2Calls);
      expect(resolved1).toEqual(["task-1a", "task-1b"]);
      expect(resolved2).toEqual(["task-2a", "task-2b"]);
    });

    it("prevents waitUntil leakage when requests have different lifetimes", async () => {
      const shortRequestCalls: Promise<unknown>[] = [];
      const longRequestCalls: Promise<unknown>[] = [];

      const shortStore: RequestStore = {
        getSql: () => createMockSql(),
        waitUntil: (p) => shortRequestCalls.push(p),
      };
      const longStore: RequestStore = {
        getSql: () => createMockSql(),
        waitUntil: (p) => longRequestCalls.push(p),
      };

      // Short request completes first
      const shortRequest = requestContext.run(shortStore, async () => {
        const waitUntil = getRequestWaitUntil();
        waitUntil?.(Promise.resolve("short-task"));
        return "short-done";
      });

      // Long request spans the entire test
      const longRequest = requestContext.run(longStore, async () => {
        const waitUntil = getRequestWaitUntil();
        waitUntil?.(Promise.resolve("long-task-1"));
        await new Promise((r) => setTimeout(r, 20));
        waitUntil?.(Promise.resolve("long-task-2"));
        return "long-done";
      });

      // Short request finishes
      const shortResult = await shortRequest;
      expect(shortResult).toBe("short-done");
      expect(shortRequestCalls).toHaveLength(1);

      // Long request continues and adds another task
      const longResult = await longRequest;
      expect(longResult).toBe("long-done");
      expect(longRequestCalls).toHaveLength(2);

      // Verify isolation - short request didn't receive long request's tasks
      expect(shortRequestCalls).toHaveLength(1);
      const shortResolved = await Promise.all(shortRequestCalls);
      expect(shortResolved).toEqual(["short-task"]);
    });
  });

  describe("Error handling and cleanup", () => {
    it("schedules $disconnect even when handler throws (try/finally pattern)", async () => {
      const disconnectFn = vi.fn().mockResolvedValue(undefined);
      const mockClient = {
        ...createMockPrismaClient("error-client"),
        $disconnect: disconnectFn,
      };
      let prisma: typeof mockClient | null = null;
      const waitUntilCalls: Promise<void>[] = [];

      const getPrisma = (): PrismaClient => {
        if (!prisma) {
          prisma = mockClient;
        }
        return prisma as unknown as PrismaClient;
      };

      const mockCtx = {
        waitUntil: (p: Promise<void>) => {
          waitUntilCalls.push(p);
        },
      };

      const throwingHandler = async () => {
        getRequestPrisma();
        throw new Error("Simulated handler error");
      };

      try {
        await requestContext.run({ getSql: () => createMockSql(), getPrisma }, async () => {
          try {
            await throwingHandler();
          } finally {
            if (prisma !== null) {
              mockCtx.waitUntil(Promise.resolve(prisma.$disconnect()));
            }
          }
        });
      } catch {
        // Expected error
      }

      expect(prisma).not.toBeNull();
      expect(waitUntilCalls).toHaveLength(1);
      expect(disconnectFn).toHaveBeenCalledTimes(1);
    });

    it("does not call $disconnect if Prisma client was never created", async () => {
      const disconnectFn = vi.fn().mockResolvedValue(undefined);
      const mockClient = {
        ...createMockPrismaClient("unused-client"),
        $disconnect: disconnectFn,
      };
      let prisma: typeof mockClient | null = null;
      const waitUntilCalls: Promise<void>[] = [];

      const getPrisma = (): PrismaClient => {
        if (!prisma) {
          prisma = mockClient;
        }
        return prisma as unknown as PrismaClient;
      };

      const mockCtx = {
        waitUntil: (p: Promise<void>) => {
          waitUntilCalls.push(p);
        },
      };

      await requestContext.run({ getSql: () => createMockSql(), getPrisma }, async () => {
        try {
          // Handler that doesn't use the database
          return "no-db-access";
        } finally {
          if (prisma !== null) {
            mockCtx.waitUntil(Promise.resolve(prisma.$disconnect()));
          }
        }
      });

      expect(prisma).toBeNull();
      expect(waitUntilCalls).toHaveLength(0);
      expect(disconnectFn).not.toHaveBeenCalled();
    });
  });
});
