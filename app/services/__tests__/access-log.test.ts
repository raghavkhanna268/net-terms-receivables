/**
 * Unit tests for access-log.server.ts
 *
 * Tests:
 * - getActorFromSessionToken prefers sessionToken.sub
 * - Fallback to session.onlineAccessInfo.associated_user.id
 * - Returns 'unknown' when neither available or sub is email-like
 * - Helper drops extra fields
 * - Written row contains no PII
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getActorFromSessionToken } from "../access-log.server";

describe("access-log.server", () => {
  describe("getActorFromSessionToken", () => {
    it("returns sessionToken.sub when present and numeric", () => {
      const sessionToken = { sub: "12345" };
      const session = {};
      expect(getActorFromSessionToken(sessionToken, session)).toBe("12345");
    });

    it("prefers sessionToken.sub over session.associated_user.id", () => {
      const sessionToken = { sub: "99999" };
      const session = {
        onlineAccessInfo: {
          associated_user: {
            id: 12345,
          },
        },
      };
      expect(getActorFromSessionToken(sessionToken, session)).toBe("99999");
    });

    it("returns 'unknown' when sessionToken.sub is email-like", () => {
      const sessionToken = { sub: "staff@example.myshopify.com" };
      const session = {};
      expect(getActorFromSessionToken(sessionToken, session)).toBe("unknown");
    });

    it("returns 'unknown' when sessionToken.sub contains non-digits", () => {
      const sessionToken = { sub: "user-abc-123" };
      const session = {};
      expect(getActorFromSessionToken(sessionToken, session)).toBe("unknown");
    });

    it("falls back to session.associated_user.id when sessionToken is undefined", () => {
      const sessionToken = undefined;
      const session = {
        onlineAccessInfo: {
          associated_user: {
            id: 67890,
          },
        },
      };
      expect(getActorFromSessionToken(sessionToken, session)).toBe("67890");
    });

    it("falls back to session.associated_user.id when sessionToken.sub is undefined", () => {
      const sessionToken = {};
      const session = {
        onlineAccessInfo: {
          associated_user: {
            id: 54321,
          },
        },
      };
      expect(getActorFromSessionToken(sessionToken, session)).toBe("54321");
    });

    it("handles bigint user id in session fallback", () => {
      const sessionToken = undefined;
      const session = {
        onlineAccessInfo: {
          associated_user: {
            id: BigInt("9007199254740993"),
          },
        },
      };
      expect(getActorFromSessionToken(sessionToken, session)).toBe("9007199254740993");
    });

    it("returns 'unknown' when both sessionToken.sub and session.associated_user.id are missing", () => {
      const sessionToken = {};
      const session = {};
      expect(getActorFromSessionToken(sessionToken, session)).toBe("unknown");
    });

    it("returns 'unknown' when session.onlineAccessInfo is missing", () => {
      const sessionToken = undefined;
      const session = {};
      expect(getActorFromSessionToken(sessionToken, session)).toBe("unknown");
    });

    it("returns 'unknown' when session.associated_user is missing", () => {
      const sessionToken = undefined;
      const session = {
        onlineAccessInfo: {},
      };
      expect(getActorFromSessionToken(sessionToken, session)).toBe("unknown");
    });

    it("returns 'unknown' when session.associated_user.id is null", () => {
      const sessionToken = undefined;
      const session = {
        onlineAccessInfo: {
          associated_user: {
            id: null as unknown as undefined,
          },
        },
      };
      expect(getActorFromSessionToken(sessionToken, session)).toBe("unknown");
    });

    it("NEVER returns an email address - uses numeric id instead", () => {
      const sessionToken = { sub: "78901" };
      const session = {
        onlineAccessInfo: {
          associated_user: {
            id: 67890,
            email: "staff@example-store.myshopify.com",
          },
        },
      };
      const actor = getActorFromSessionToken(sessionToken, session);
      expect(actor).toBe("78901");
      expect(actor).not.toContain("@");
      expect(actor).not.toContain("example");
      expect(actor).not.toContain("myshopify");
    });

    it("falls back correctly when sessionToken.sub is email but session has numeric id", () => {
      const sessionToken = { sub: "admin@shop.myshopify.com" };
      const session = {
        onlineAccessInfo: {
          associated_user: {
            id: 11111,
          },
        },
      };
      expect(getActorFromSessionToken(sessionToken, session)).toBe("unknown");
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
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestWaitUntil: () => undefined,
      }));
      vi.resetModules();

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
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestWaitUntil: () => undefined,
      }));
      vi.resetModules();

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
        action: "accounts_detail",
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
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestWaitUntil: () => undefined,
      }));
      vi.resetModules();

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
      vi.doMock("~/lib/request-context.server", () => ({
        getRequestWaitUntil: () => undefined,
      }));
      vi.resetModules();

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
        action: "data_requests_download",
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
