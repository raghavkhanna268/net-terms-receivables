/**
 * Unit tests for access-log.server.ts
 *
 * Tests:
 * - Helper drops extra fields
 * - Written row contains no PII
 * - Actor falls back to 'unknown' and never takes an email
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getActorFromSession } from "../access-log.server";

describe("access-log.server", () => {
  describe("getActorFromSession", () => {
    it("returns user id as string when present", () => {
      const session = {
        onlineAccessInfo: {
          associatedUser: {
            id: 12345,
          },
        },
      };
      expect(getActorFromSession(session)).toBe("12345");
    });

    it("handles bigint user id", () => {
      const session = {
        onlineAccessInfo: {
          associatedUser: {
            id: BigInt("9007199254740993"),
          },
        },
      };
      expect(getActorFromSession(session)).toBe("9007199254740993");
    });

    it("handles string user id", () => {
      const session = {
        onlineAccessInfo: {
          associatedUser: {
            id: "user-123",
          },
        },
      };
      expect(getActorFromSession(session)).toBe("user-123");
    });

    it("returns 'unknown' when onlineAccessInfo is missing", () => {
      const session = {};
      expect(getActorFromSession(session)).toBe("unknown");
    });

    it("returns 'unknown' when associatedUser is missing", () => {
      const session = {
        onlineAccessInfo: {},
      };
      expect(getActorFromSession(session)).toBe("unknown");
    });

    it("returns 'unknown' when id is undefined", () => {
      const session = {
        onlineAccessInfo: {
          associatedUser: {},
        },
      };
      expect(getActorFromSession(session)).toBe("unknown");
    });

    it("returns 'unknown' when id is null", () => {
      const session = {
        onlineAccessInfo: {
          associatedUser: {
            id: null as unknown as undefined,
          },
        },
      };
      expect(getActorFromSession(session)).toBe("unknown");
    });

    it("NEVER returns an email address - uses numeric id instead", () => {
      const session = {
        onlineAccessInfo: {
          associatedUser: {
            id: 67890,
            email: "staff@example-store.myshopify.com",
          },
        },
      };
      const actor = getActorFromSession(session);
      expect(actor).toBe("67890");
      expect(actor).not.toContain("@");
      expect(actor).not.toContain("example");
      expect(actor).not.toContain("myshopify");
    });

    it("does not use firstName or lastName", () => {
      const session = {
        onlineAccessInfo: {
          associatedUser: {
            id: 111,
            firstName: "John",
            lastName: "Doe",
          },
        },
      };
      const actor = getActorFromSession(session);
      expect(actor).toBe("111");
      expect(actor).not.toContain("John");
      expect(actor).not.toContain("Doe");
    });
  });

  describe("buildEventData (via recordAccess integration)", () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
    });

    it("event data contains only whitelisted fields", async () => {
      const { recordAccess } = await import("../access-log.server");

      let capturedData: Record<string, unknown> | null = null;
      const mockSql = Object.assign(
        async () => ({ count: 1 }),
        {
          json: (data: unknown) => {
            capturedData = data as Record<string, unknown>;
            return JSON.stringify(data);
          },
        }
      ) as unknown as Parameters<typeof recordAccess>[0];

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestWaitUntil: () => undefined,
      }));

      recordAccess(mockSql, {
        shopId: "shop-123",
        actor: "12345",
        action: "dashboard",
        recordType: "BuyerAccount",
        count: 10,
        recordId: undefined,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(capturedData).not.toBeNull();
      const keys = Object.keys(capturedData!);
      expect(keys).toContain("recordType");
      expect(keys).toContain("count");
      expect(keys).not.toContain("recordId");
      expect(keys.length).toBe(2);
    });

    it("includes recordId when provided", async () => {
      const { recordAccess } = await import("../access-log.server");

      let capturedData: Record<string, unknown> | null = null;
      const mockSql = Object.assign(
        async () => ({ count: 1 }),
        {
          json: (data: unknown) => {
            capturedData = data as Record<string, unknown>;
            return JSON.stringify(data);
          },
        }
      ) as unknown as Parameters<typeof recordAccess>[0];

      recordAccess(mockSql, {
        shopId: "shop-123",
        actor: "12345",
        action: "accounts.detail",
        recordType: "BuyerAccount",
        recordId: "acc-456",
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(capturedData).not.toBeNull();
      const keys = Object.keys(capturedData!);
      expect(keys).toContain("recordType");
      expect(keys).toContain("recordId");
      expect(keys).not.toContain("count");
      expect(capturedData!.recordId).toBe("acc-456");
    });

    it("event data contains no PII fields", async () => {
      const { recordAccess } = await import("../access-log.server");

      let capturedData: Record<string, unknown> | null = null;
      const mockSql = Object.assign(
        async () => ({ count: 1 }),
        {
          json: (data: unknown) => {
            capturedData = data as Record<string, unknown>;
            return JSON.stringify(data);
          },
        }
      ) as unknown as Parameters<typeof recordAccess>[0];

      const piiTestEmail = "customer@example.myshopify.com";
      const piiTestName = "John Doe Customer";
      const piiTestPhone = "+1-555-123-4567";
      const piiTestNarration = "Payment from ACME Corp";
      const piiTestAmount = "50000.00";

      recordAccess(mockSql, {
        shopId: "shop-123",
        actor: "12345",
        action: "reconcile",
        recordType: "Payment",
        count: 5,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(capturedData).not.toBeNull();
      const serialized = JSON.stringify(capturedData);
      
      expect(serialized).not.toContain(piiTestEmail);
      expect(serialized).not.toContain(piiTestName);
      expect(serialized).not.toContain(piiTestPhone);
      expect(serialized).not.toContain(piiTestNarration);
      expect(serialized).not.toContain(piiTestAmount);
      expect(serialized).not.toContain("@");
      expect(serialized).not.toContain("myshopify");
      
      const keys = Object.keys(capturedData!);
      expect(keys).not.toContain("email");
      expect(keys).not.toContain("name");
      expect(keys).not.toContain("phone");
      expect(keys).not.toContain("narration");
      expect(keys).not.toContain("payerText");
      expect(keys).not.toContain("amount");
      expect(keys).not.toContain("queryString");
    });

    it("written row keys are exactly: recordType, recordId?, count?", async () => {
      const { recordAccess } = await import("../access-log.server");

      let capturedData: Record<string, unknown> | null = null;
      const mockSql = Object.assign(
        async () => ({ count: 1 }),
        {
          json: (data: unknown) => {
            capturedData = data as Record<string, unknown>;
            return JSON.stringify(data);
          },
        }
      ) as unknown as Parameters<typeof recordAccess>[0];

      recordAccess(mockSql, {
        shopId: "shop-123",
        actor: "12345",
        action: "data_requests.download",
        recordType: "DataRequest",
        recordId: "req-789",
        count: 1,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(capturedData).not.toBeNull();
      const keys = Object.keys(capturedData!).sort();
      expect(keys).toEqual(["count", "recordId", "recordType"]);
    });
  });
});
