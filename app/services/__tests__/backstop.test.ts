import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock shopify-client.server before importing backstop
vi.mock("../shopify-client.server", () => ({
  shopifyGraphQLRequest: vi.fn(),
}));

import { applyBackstop, CREDIT_HOLD_TAG, type BackstopInput } from "../backstop.server";
import type { ShopifyClientResult } from "../shopify-client.server";

// Mock SQL client
function createMockSql() {
  const calls: Array<{ template: string; values: unknown[] }> = [];
  const mockPatterns: Map<string, unknown[]> = new Map();

  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const template = strings.join("$?$");
      calls.push({ template, values });
      // Pattern match: find the first pattern that the template contains
      for (const [pattern, result] of mockPatterns.entries()) {
        if (template.includes(pattern)) {
          return result;
        }
      }
      return [];
    },
    {
      json: (obj: unknown) => JSON.stringify(obj),
      _calls: calls,
      _setResult: (pattern: string, result: unknown[]) => {
        mockPatterns.set(pattern, result);
      },
      _reset: () => {
        calls.length = 0;
        mockPatterns.clear();
      },
    },
  );

  return sql;
}

describe("backstop.server", () => {
  let mockSql: ReturnType<typeof createMockSql>;
  let mockShopifyGraphQLRequest: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockSql = createMockSql();
    const shopifyClient = await import("../shopify-client.server");
    mockShopifyGraphQLRequest = shopifyClient.shopifyGraphQLRequest as ReturnType<typeof vi.fn>;
    mockShopifyGraphQLRequest.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const baseInput: BackstopInput = {
    shopDomain: "test.myshopify.com",
    shopId: "shop-123",
    orderId: "inv-456",
    orderGid: "gid://shopify/Order/789",
    buyerAccountId: "buyer-abc",
  };

  describe("applyBackstop", () => {
    it("skips when no buyer account", async () => {
      const result = await applyBackstop(mockSql as never, {
        ...baseInput,
        buyerAccountId: null,
      });

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("No buyer account");
    });

    it("skips when already processed (idempotent)", async () => {
      // Mock: backstop already processed
      mockSql._setResult("backstop_processed_orders", [{ exists: true }]);

      const result = await applyBackstop(mockSql as never, baseInput);

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("Already processed");
    });

    it("skips when account is OK (not held)", async () => {
      // Mock: not processed
      mockSql._setResult("backstop_processed_orders", [{ exists: false }]);
      // Mock: account is OK
      mockSql._setResult("BuyerAccount", [{ holdState: "OK", bypass: false }]);

      const result = await applyBackstop(mockSql as never, baseInput);

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("not held");
    });

    it("skips when account is NEAR_LIMIT (not held)", async () => {
      mockSql._setResult("backstop_processed_orders", [{ exists: false }]);
      mockSql._setResult("BuyerAccount", [{ holdState: "NEAR_LIMIT", bypass: false }]);

      const result = await applyBackstop(mockSql as never, baseInput);

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("not held");
    });

    it("skips when account has bypass", async () => {
      mockSql._setResult("backstop_processed_orders", [{ exists: false }]);
      mockSql._setResult("BuyerAccount", [{ holdState: "HELD", bypass: true }]);

      const result = await applyBackstop(mockSql as never, baseInput);

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("bypass");
    });

    it("applies holds when account is HELD and not bypassed", async () => {
      mockSql._setResult("backstop_processed_orders", [{ exists: false }]);
      mockSql._setResult("BuyerAccount", [{ holdState: "HELD", bypass: false }]);

      // Mock: fulfillment orders query
      mockShopifyGraphQLRequest.mockResolvedValueOnce({
        success: true,
        data: {
          order: {
            fulfillmentOrders: {
              edges: [
                { node: { id: "gid://shopify/FulfillmentOrder/1", status: "OPEN" } },
                { node: { id: "gid://shopify/FulfillmentOrder/2", status: "OPEN" } },
              ],
            },
          },
        },
      } as ShopifyClientResult<unknown>);

      // Mock: fulfillment order hold mutations
      mockShopifyGraphQLRequest.mockResolvedValueOnce({
        success: true,
        data: {
          fulfillmentOrderHold: {
            fulfillmentOrder: { id: "gid://shopify/FulfillmentOrder/1", status: "ON_HOLD" },
            userErrors: [],
          },
        },
      } as ShopifyClientResult<unknown>);

      mockShopifyGraphQLRequest.mockResolvedValueOnce({
        success: true,
        data: {
          fulfillmentOrderHold: {
            fulfillmentOrder: { id: "gid://shopify/FulfillmentOrder/2", status: "ON_HOLD" },
            userErrors: [],
          },
        },
      } as ShopifyClientResult<unknown>);

      // Mock: tags add
      mockShopifyGraphQLRequest.mockResolvedValueOnce({
        success: true,
        data: {
          tagsAdd: {
            node: { id: baseInput.orderGid },
            userErrors: [],
          },
        },
      } as ShopifyClientResult<unknown>);

      const result = await applyBackstop(mockSql as never, baseInput);

      expect(result.applied).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.fulfillmentOrdersHeld).toBe(2);
      expect(result.tagged).toBe(true);

      // Verify hold mutation was called with correct params
      expect(mockShopifyGraphQLRequest).toHaveBeenCalledWith(
        baseInput.shopDomain,
        expect.stringContaining("FulfillmentOrderHold"),
        expect.objectContaining({
          reason: "OTHER",
          handle: "ntr-credit-hold",
        }),
      );

      // Verify tag mutation was called
      expect(mockShopifyGraphQLRequest).toHaveBeenCalledWith(
        baseInput.shopDomain,
        expect.stringContaining("TagsAdd"),
        expect.objectContaining({
          tags: [CREDIT_HOLD_TAG],
        }),
      );
    });

    it("handles fulfillmentOrderHold userErrors gracefully", async () => {
      mockSql._setResult("backstop_processed_orders", [{ exists: false }]);
      mockSql._setResult("BuyerAccount", [{ holdState: "HELD", bypass: false }]);

      mockShopifyGraphQLRequest.mockResolvedValueOnce({
        success: true,
        data: {
          order: {
            fulfillmentOrders: {
              edges: [
                { node: { id: "gid://shopify/FulfillmentOrder/1", status: "OPEN" } },
              ],
            },
          },
        },
      } as ShopifyClientResult<unknown>);

      // Mock: hold mutation returns user error
      mockShopifyGraphQLRequest.mockResolvedValueOnce({
        success: true,
        data: {
          fulfillmentOrderHold: {
            fulfillmentOrder: null,
            userErrors: [
              { field: ["id"], message: "Some error", code: "INVALID" },
            ],
          },
        },
      } as ShopifyClientResult<unknown>);

      const result = await applyBackstop(mockSql as never, baseInput);

      expect(result.applied).toBe(false);
      expect(result.error).toContain("Failed to hold");
    });

    it("handles already-held fulfillment orders as success", async () => {
      mockSql._setResult("backstop_processed_orders", [{ exists: false }]);
      mockSql._setResult("BuyerAccount", [{ holdState: "HELD", bypass: false }]);

      mockShopifyGraphQLRequest.mockResolvedValueOnce({
        success: true,
        data: {
          order: {
            fulfillmentOrders: {
              edges: [
                { node: { id: "gid://shopify/FulfillmentOrder/1", status: "OPEN" } },
              ],
            },
          },
        },
      } as ShopifyClientResult<unknown>);

      // Mock: hold mutation returns ALREADY_EXISTS (idempotent)
      mockShopifyGraphQLRequest.mockResolvedValueOnce({
        success: true,
        data: {
          fulfillmentOrderHold: {
            fulfillmentOrder: null,
            userErrors: [
              { field: ["id"], message: "Hold already exists", code: "ALREADY_EXISTS" },
            ],
          },
        },
      } as ShopifyClientResult<unknown>);

      // Mock: tags add
      mockShopifyGraphQLRequest.mockResolvedValueOnce({
        success: true,
        data: {
          tagsAdd: { node: { id: baseInput.orderGid }, userErrors: [] },
        },
      } as ShopifyClientResult<unknown>);

      const result = await applyBackstop(mockSql as never, baseInput);

      expect(result.applied).toBe(true);
      expect(result.fulfillmentOrdersHeld).toBe(1);
    });

    it("handles unknown buyer account", async () => {
      mockSql._setResult("backstop_processed_orders", [{ exists: false }]);
      // Return empty array - account not found
      mockSql._setResult("BuyerAccount", []);

      const result = await applyBackstop(mockSql as never, baseInput);

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("not held");
    });

    it("handles no open fulfillment orders", async () => {
      mockSql._setResult("backstop_processed_orders", [{ exists: false }]);
      mockSql._setResult("BuyerAccount", [{ holdState: "HELD", bypass: false }]);

      // Mock: no open fulfillment orders
      mockShopifyGraphQLRequest.mockResolvedValueOnce({
        success: true,
        data: {
          order: {
            fulfillmentOrders: {
              edges: [
                { node: { id: "gid://shopify/FulfillmentOrder/1", status: "CLOSED" } },
              ],
            },
          },
        },
      } as ShopifyClientResult<unknown>);

      // Mock: tags add
      mockShopifyGraphQLRequest.mockResolvedValueOnce({
        success: true,
        data: {
          tagsAdd: { node: { id: baseInput.orderGid }, userErrors: [] },
        },
      } as ShopifyClientResult<unknown>);

      const result = await applyBackstop(mockSql as never, baseInput);

      expect(result.applied).toBe(true);
      expect(result.fulfillmentOrdersHeld).toBe(0);
    });
  });
});
