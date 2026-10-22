import { describe, it, expect, vi, beforeEach } from "vitest";
import { requestContext, getRequestPrisma, type PrismaClientGetter } from "../../lib/request-context.server";
import { PrismaSessionStorage } from "../../lib/session-storage.server";
import type { PrismaClient } from "~/generated/prisma/client";

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

      const result = await requestContext.run({ getPrisma: asPrismaGetter(mockClient) }, () => {
        return getRequestPrisma();
      });

      expect(result).toEqual(mockClient);
    });

    it("returns the same client within a single request context", async () => {
      const mockClient = createMockPrismaClient("test-client");
      const getPrismaFn = vi.fn(asPrismaGetter(mockClient));

      await requestContext.run({ getPrisma: getPrismaFn }, async () => {
        const client1 = getRequestPrisma();
        const client2 = getRequestPrisma();

        expect(client1).toEqual(client2);
        expect(client1).toEqual(mockClient);
      });
    });
  });

  describe("Concurrent request isolation", () => {
    it("isolates Prisma clients between concurrent requests", async () => {
      const client1 = createMockPrismaClient("request-1-client");
      const client2 = createMockPrismaClient("request-2-client");

      const seenClients: string[] = [];

      const request1 = requestContext.run({ getPrisma: asPrismaGetter(client1) }, async () => {
        await new Promise((r) => setTimeout(r, 10));
        const client = getRequestPrisma() as unknown as MockPrismaClient;
        seenClients.push(client.id);
        return client.id;
      });

      const request2 = requestContext.run({ getPrisma: asPrismaGetter(client2) }, async () => {
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
        return requestContext.run({ getPrisma: asPrismaGetter(client) }, async () => {
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

      await requestContext.run({ getPrisma: asPrismaGetter(mockClient) }, async () => {
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
        requestContext.run({ getPrisma: asPrismaGetter(client1) }, async () => {
          return storage.deleteAllForShop("shop1.myshopify.com");
        }),
        requestContext.run({ getPrisma: asPrismaGetter(client2) }, async () => {
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

      await requestContext.run({ getPrisma: factory }, async () => {
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

      await requestContext.run({ getPrisma }, async () => {
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
});
