import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Sql } from "~/lib/db-light.server";

const mockSqlResult = Object.assign([], { count: 0 });
const mockSql = Object.assign(
  vi.fn().mockResolvedValue(mockSqlResult),
  { json: vi.fn((v) => JSON.stringify(v)) }
) as unknown as Sql & ReturnType<typeof vi.fn>;

vi.mock("~/lib/db-light.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
}));

import {
  deleteShop,
  purgePgmqMessages,
  redactCustomer,
  generateCustomerDataExport,
  persistDataRequest,
  sendDataRequestNotification,
  minimiseInactiveCustomerPii,
  minimiseCustomerPiiIfInactive,
  markShopUninstalled,
  markDataRequestDownloaded,
} from "../compliance.server";

const mockFetch = vi.fn();

const originalFetch = globalThis.fetch;

describe("compliance.server", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockResolvedValue(mockSqlResult);
    globalThis.fetch = mockFetch;
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  describe("deleteShop", () => {
    it("deletes shop and returns deleted=true with shopId", async () => {
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);

      const result = await deleteShop(mockSql, "test-shop.myshopify.com");

      expect(result).toEqual({ deleted: true, shopId: "shop-123" });
      expect(mockSql).toHaveBeenCalled();
    });

    it("returns deleted=false when shop not found", async () => {
      mockSql.mockResolvedValueOnce([]);

      const result = await deleteShop(mockSql, "nonexistent.myshopify.com");

      expect(result).toEqual({ deleted: false, shopId: null });
    });
  });

  describe("purgePgmqMessages", () => {
    it("returns documented limitation (pgmq does not support per-shop deletion)", async () => {
      const result = await purgePgmqMessages(mockSql, "test-shop.myshopify.com");

      expect(result.purged).toBe(false);
      expect(result.reason).toContain("pgmq does not support per-shop message deletion");
    });
  });

  describe("redactCustomer", () => {
    it("deletes s8_tagged_customers, s8_draft_orders, and s22_data_requests", async () => {
      // 1. DELETE s8_tagged_customers
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 1 }));
      // 2. DELETE s8_draft_orders
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 2 }));
      // 3. DELETE s22_data_requests
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 1 }));
      // 4. SELECT buyerAccount
      mockSql.mockResolvedValueOnce([{ id: "ba-1" }]);
      // 5. UPDATE BuyerAccount
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 1 }));
      // 6. UPDATE Payment (via Match→Invoice→BuyerAccount)
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 3 }));

      const result = await redactCustomer(
        mockSql,
        "shop-123",
        "gid://shopify/Customer/456"
      );

      expect(result.taggedCustomersDeleted).toBe(1);
      expect(result.draftOrdersDeleted).toBe(2);
      expect(result.dataRequestsDeleted).toBe(1);
      expect(result.buyerAccountAnonymized).toBe(true);
      expect(result.paymentsRedacted).toBe(3);
    });

    it("redacts payments linked via Match→Invoice→BuyerAccount", async () => {
      // 1. DELETE s8_tagged_customers
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 1 }));
      // 2. DELETE s8_draft_orders
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 0 }));
      // 3. DELETE s22_data_requests
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 0 }));
      // 4. SELECT buyerAccount
      mockSql.mockResolvedValueOnce([{ id: "ba-1" }]);
      // 5. UPDATE BuyerAccount
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 1 }));
      // 6. UPDATE Payment (via Match→Invoice→BuyerAccount)
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 2 }));

      const result = await redactCustomer(
        mockSql,
        "shop-123",
        "gid://shopify/Customer/789"
      );

      expect(result.buyerAccountAnonymized).toBe(true);
      expect(result.paymentsRedacted).toBe(2);
    });

    it("handles customer with no data gracefully", async () => {
      // 1. DELETE s8_tagged_customers
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 0 }));
      // 2. DELETE s8_draft_orders
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 0 }));
      // 3. DELETE s22_data_requests
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 0 }));
      // 4. SELECT buyerAccount (not found)
      mockSql.mockResolvedValueOnce([]);

      const result = await redactCustomer(
        mockSql,
        "shop-123",
        "gid://shopify/Customer/unknown"
      );

      expect(result.taggedCustomersDeleted).toBe(0);
      expect(result.draftOrdersDeleted).toBe(0);
      expect(result.dataRequestsDeleted).toBe(0);
      expect(result.buyerAccountAnonymized).toBe(false);
      expect(result.paymentsRedacted).toBe(0);
    });

    it("deletes data requests for the customer", async () => {
      // 1. DELETE s8_tagged_customers
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 0 }));
      // 2. DELETE s8_draft_orders
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 0 }));
      // 3. DELETE s22_data_requests - 3 requests exist
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 3 }));
      // 4. SELECT buyerAccount (not found)
      mockSql.mockResolvedValueOnce([]);

      const result = await redactCustomer(
        mockSql,
        "shop-123",
        "gid://shopify/Customer/456"
      );

      expect(result.dataRequestsDeleted).toBe(3);
    });
  });

  describe("generateCustomerDataExport", () => {
    it("generates export for known customer with data", async () => {
      mockSql.mockResolvedValueOnce([{
        tags: ["net-terms"],
        tag_active: true,
        email: "test@example.com",
        display_name: "Test Customer",
        created_at: new Date("2026-01-01"),
      }]);
      mockSql.mockResolvedValueOnce([{
        id: "do-1",
        name: "#D1",
        total: "100.00",
        status: "open",
        created_at: new Date("2026-01-15"),
      }]);
      mockSql.mockResolvedValueOnce([{
        id: "ba-1",
        name: "Test Customer",
        kind: "TAGGED_CUSTOMER",
        creditLimit: "1000.00",
        defaultTermsDays: 30,
        holdState: "OK",
      }]);
      mockSql.mockResolvedValueOnce([{
        id: "inv-1",
        name: "#1001",
        total: "500.00",
        outstanding: "250.00",
        status: "open",
        issuedAt: new Date("2026-01-10"),
        dueAt: new Date("2026-02-10"),
      }]);

      const result = await generateCustomerDataExport(
        mockSql,
        "shop-123",
        "gid://shopify/Customer/456",
        "req-789"
      );

      expect(result.customerGid).toBe("gid://shopify/Customer/456");
      expect(result.requestId).toBe("req-789");
      expect(result.data.taggedCustomer).toBeTruthy();
      expect(result.data.taggedCustomer?.tagActive).toBe(true);
      expect(result.data.draftOrders).toHaveLength(1);
      expect(result.data.buyerAccount).toBeTruthy();
      expect(result.data.invoices).toHaveLength(1);
    });

    it("generates empty export for unknown customer", async () => {
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce([]);

      const result = await generateCustomerDataExport(
        mockSql,
        "shop-123",
        "gid://shopify/Customer/unknown",
        "req-empty"
      );

      expect(result.customerGid).toBe("gid://shopify/Customer/unknown");
      expect(result.requestId).toBe("req-empty");
      expect(result.data.taggedCustomer).toBeNull();
      expect(result.data.draftOrders).toHaveLength(0);
      expect(result.data.buyerAccount).toBeNull();
      expect(result.data.invoices).toHaveLength(0);
    });
  });

  describe("persistDataRequest", () => {
    it("creates new data request record", async () => {
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce([{ id: "dr-123" }]);

      const exportData = {
        customerGid: "gid://shopify/Customer/456",
        requestId: "req-789",
        requestedAt: new Date().toISOString(),
        data: { taggedCustomer: null, draftOrders: [], buyerAccount: null, invoices: [] },
      };

      const result = await persistDataRequest(
        mockSql,
        "shop-123",
        "gid://shopify/Customer/456",
        "req-789",
        exportData
      );

      expect(result.id).toBe("dr-123");
      expect(result.alreadyExists).toBe(false);
    });

    it("returns existing record on duplicate request_id", async () => {
      mockSql.mockResolvedValueOnce([{ id: "dr-existing" }]);

      const exportData = {
        customerGid: "gid://shopify/Customer/456",
        requestId: "req-duplicate",
        requestedAt: new Date().toISOString(),
        data: { taggedCustomer: null, draftOrders: [], buyerAccount: null, invoices: [] },
      };

      const result = await persistDataRequest(
        mockSql,
        "shop-123",
        "gid://shopify/Customer/456",
        "req-duplicate",
        exportData
      );

      expect(result.id).toBe("dr-existing");
      expect(result.alreadyExists).toBe(true);
    });
  });

  describe("minimiseInactiveCustomerPii", () => {
    it("nulls PII for inactive customers with no open invoices", async () => {
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 3 }));

      const result = await minimiseInactiveCustomerPii(mockSql, "shop-123");

      expect(result).toBe(3);
    });

    it("returns 0 when no customers to minimise", async () => {
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 0 }));

      const result = await minimiseInactiveCustomerPii(mockSql, "shop-123");

      expect(result).toBe(0);
    });
  });

  describe("minimiseCustomerPiiIfInactive", () => {
    it("nulls PII for specific inactive customer with no open invoices", async () => {
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 1 }));

      const result = await minimiseCustomerPiiIfInactive(
        mockSql,
        "shop-123",
        "gid://shopify/Customer/456"
      );

      expect(result).toBe(true);
    });

    it("returns false when customer has open invoices", async () => {
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 0 }));

      const result = await minimiseCustomerPiiIfInactive(
        mockSql,
        "shop-123",
        "gid://shopify/Customer/456"
      );

      expect(result).toBe(false);
    });
  });

  describe("markShopUninstalled", () => {
    it("marks shop as uninstalled and returns true", async () => {
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 1 }));

      const result = await markShopUninstalled(mockSql, "test-shop.myshopify.com");

      expect(result).toBe(true);
    });

    it("returns false when shop not found", async () => {
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 0 }));

      const result = await markShopUninstalled(mockSql, "unknown-shop.myshopify.com");

      expect(result).toBe(false);
    });
  });

  describe("sendDataRequestNotification", () => {
    it("skips email when RESEND_API_KEY is not set and logs correctly", async () => {
      delete process.env.RESEND_API_KEY;
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await sendDataRequestNotification(
        "test-shop.myshopify.com",
        "owner@shop.com",
        "req-123"
      );

      expect(result.sent).toBe(false);
      expect(result.skippedReason).toBe("no_api_key");
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("data_request_email_skipped")
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("shop=test-shop.myshopify.com")
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("request_id=req-123")
      );
      expect(mockFetch).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("skips email when RESEND_FROM is not set", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      delete process.env.RESEND_FROM;
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await sendDataRequestNotification(
        "test-shop.myshopify.com",
        "owner@shop.com",
        "req-123"
      );

      expect(result.sent).toBe(false);
      expect(result.skippedReason).toBe("no_sender");
      expect(mockFetch).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("sends email with NO customer PII in request body", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      process.env.RESEND_FROM = "noreply@example.com";

      // Mock Resend API call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "email-123" }),
      });

      const result = await sendDataRequestNotification(
        "test-shop.myshopify.com",
        "owner@shop.com",
        "req-123"
      );

      expect(result.sent).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify the Resend API call
      const resendCall = mockFetch.mock.calls[0];
      expect(resendCall[0]).toBe("https://api.resend.com/emails");

      const requestBody = JSON.parse(resendCall[1].body);

      // Verify NO customer PII in the email
      expect(requestBody.html).not.toContain("gid://shopify/Customer");
      expect(requestBody.html).not.toContain("customer@");
      expect(requestBody.html).not.toContain("displayName");
      expect(requestBody.html).not.toContain("tags");
      expect(requestBody.text).not.toContain("gid://shopify/Customer");
      expect(requestBody.text).not.toContain("customer@");

      // Verify the download link IS present
      expect(requestBody.html).toContain("admin.shopify.com/store/test-shop/apps");
      expect(requestBody.html).toContain("data-requests");
      expect(requestBody.text).toContain("admin.shopify.com/store/test-shop/apps");
    });

    it("returns error when Resend API fails but does not throw", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      process.env.RESEND_FROM = "noreply@example.com";
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      // Mock Resend API failure
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });

      const result = await sendDataRequestNotification(
        "test-shop.myshopify.com",
        "owner@shop.com",
        "req-123"
      );

      expect(result.sent).toBe(false);
      expect(result.error).toBe("resend_api_error_500");
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("data_request_email_failed")
      );
      consoleSpy.mockRestore();
    });

    it("handles fetch network errors gracefully", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      process.env.RESEND_FROM = "noreply@example.com";
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      // Mock network error
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await sendDataRequestNotification(
        "test-shop.myshopify.com",
        "owner@shop.com",
        "req-123"
      );

      expect(result.sent).toBe(false);
      expect(result.error).toBe("Network error");
      consoleSpy.mockRestore();
    });
  });

  describe("markDataRequestDownloaded", () => {
    it("updates the status to downloaded", async () => {
      mockSql.mockResolvedValueOnce(Object.assign([], { count: 1 }));

      await markDataRequestDownloaded(mockSql, "shop-123", "req-456");

      expect(mockSql).toHaveBeenCalled();
    });
  });
});
