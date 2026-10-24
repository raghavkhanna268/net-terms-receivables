import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock shopify-client.server before importing backstop
vi.mock("../shopify-client.server", () => ({
  shopifyGraphQLRequest: vi.fn(),
}));

import {
  applyBackstop,
  CREDIT_HOLD_TAG,
  RetryableBackstopError,
  USE_PRE_ORDER_HOLD_STATE,
  type BackstopInput,
} from "../backstop.server";
import type { ShopifyClientResult } from "../shopify-client.server";

// Mock SQL client with pattern matching
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
    orderGid: "gid://shopify/Order/789",
    buyerAccountId: "buyer-abc",
    invoiceId: "inv-456",
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
      // Mock: backstop already completed
      // INSERT returns [] (conflict - already exists)
      mockSql._setResult("INSERT INTO backstop_processed_orders", []);
      // UPDATE for stale reclaim returns [] (not stale or not pending)
      mockSql._setResult("UPDATE backstop_processed_orders", []);
      // SELECT returns existing completed row
      mockSql._setResult("SELECT action, processed_at FROM backstop_processed_orders", [
        { action: "held", processed_at: new Date() },
      ]);

      const result = await applyBackstop(mockSql as never, baseInput);

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("Already processed");
    });

    it("skips when account is OK (not held)", async () => {
      // Mock: claim succeeds (INSERT returns the inserted row)
      mockSql._setResult("INSERT INTO backstop_processed_orders", [{ action: "pending" }]);
      // Mock: account is OK
      mockSql._setResult("BuyerAccount", [
        { holdState: "OK", bypass: false, creditLimit: "100000.00", manualHold: false, holdReasonCode: null },
      ]);
      // Mock hasOverdueInvoices - no overdue invoices
      mockSql._setResult('status = \'open\'$?$AND "dueDate"', []);
      // Mock exposure calculation - under limit
      mockSql._setResult("FROM \"Invoice\"", [{ total_paise: "0" }]);
      mockSql._setResult("s8_draft_orders", [{ total_paise: "0" }]);

      const result = await applyBackstop(mockSql as never, baseInput);

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(true);
      // With pre-order hold state calculation, reason indicates this order pushed over limit
      expect(result.skipReason).toContain("not held");
    });

    it("skips when account is NEAR_LIMIT (not held)", async () => {
      mockSql._setResult("INSERT INTO backstop_processed_orders", [{ action: "pending" }]);
      mockSql._setResult("BuyerAccount", [
        { holdState: "NEAR_LIMIT", bypass: false, creditLimit: "100000.00", manualHold: false, holdReasonCode: null },
      ]);
      // Mock hasOverdueInvoices - no overdue invoices
      mockSql._setResult('status = \'open\'$?$AND "dueDate"', []);
      // Mock exposure calculation - under limit (near but not over)
      mockSql._setResult("FROM \"Invoice\"", [{ total_paise: "9000000" }]); // 90% of 10M limit
      mockSql._setResult("s8_draft_orders", [{ total_paise: "0" }]);

      const result = await applyBackstop(mockSql as never, baseInput);

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(true);
      // With pre-order hold state calculation, reason indicates this order pushed over limit
      expect(result.skipReason).toContain("not held");
    });

    it("skips when account has bypass", async () => {
      mockSql._setResult("INSERT INTO backstop_processed_orders", [{ action: "pending" }]);
      mockSql._setResult("BuyerAccount", [
        { holdState: "HELD", bypass: true, creditLimit: "100000.00", manualHold: false },
      ]);

      const result = await applyBackstop(mockSql as never, baseInput);

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(true);
      // Bypass accounts are not held - reason is "Bypass active"
      expect(result.skipReason).toContain("Bypass active");
    });

    it("applies holds when account is HELD (manual hold) and not bypassed", async () => {
      mockSql._setResult("INSERT INTO backstop_processed_orders", [{ action: "pending" }]);
      mockSql._setResult("BuyerAccount", [
        { holdState: "HELD", bypass: false, creditLimit: "100000.00", manualHold: true },
      ]);

      // Mock: fulfillment orders query
      mockShopifyGraphQLRequest.mockResolvedValueOnce({
        success: true,
        data: {
          order: {
            fulfillmentOrders: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/FulfillmentOrder/1",
                    status: "OPEN",
                    assignedLocation: { location: { id: "loc-1" } },
                    supportedActions: [{ action: "HOLD" }],
                  },
                },
                {
                  node: {
                    id: "gid://shopify/FulfillmentOrder/2",
                    status: "OPEN",
                    assignedLocation: { location: { id: "loc-1" } },
                    supportedActions: [{ action: "HOLD" }],
                  },
                },
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

    it("throws RetryableBackstopError when 0 fulfillment orders found", async () => {
      mockSql._setResult("INSERT INTO backstop_processed_orders", [{ action: "pending" }]);
      mockSql._setResult("BuyerAccount", [
        { holdState: "HELD", bypass: false, creditLimit: "100000.00", manualHold: true },
      ]);

      // Mock: no fulfillment orders
      mockShopifyGraphQLRequest.mockResolvedValueOnce({
        success: true,
        data: {
          order: {
            fulfillmentOrders: {
              edges: [],
            },
          },
        },
      } as ShopifyClientResult<unknown>);

      await expect(applyBackstop(mockSql as never, baseInput)).rejects.toThrow(
        RetryableBackstopError,
      );
    });

    it("throws RetryableBackstopError on partial failure", async () => {
      mockSql._setResult("INSERT INTO backstop_processed_orders", [{ action: "pending" }]);
      mockSql._setResult("BuyerAccount", [
        { holdState: "HELD", bypass: false, creditLimit: "100000.00", manualHold: true },
      ]);

      // Mock: two holdable FOs
      mockShopifyGraphQLRequest.mockResolvedValueOnce({
        success: true,
        data: {
          order: {
            fulfillmentOrders: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/FulfillmentOrder/1",
                    status: "OPEN",
                    assignedLocation: { location: { id: "loc-1" } },
                    supportedActions: [{ action: "HOLD" }],
                  },
                },
                {
                  node: {
                    id: "gid://shopify/FulfillmentOrder/2",
                    status: "OPEN",
                    assignedLocation: { location: { id: "loc-1" } },
                    supportedActions: [{ action: "HOLD" }],
                  },
                },
              ],
            },
          },
        },
      } as ShopifyClientResult<unknown>);

      // First hold succeeds
      mockShopifyGraphQLRequest.mockResolvedValueOnce({
        success: true,
        data: {
          fulfillmentOrderHold: {
            fulfillmentOrder: { id: "gid://shopify/FulfillmentOrder/1", status: "ON_HOLD" },
            userErrors: [],
          },
        },
      } as ShopifyClientResult<unknown>);

      // Second hold fails
      mockShopifyGraphQLRequest.mockResolvedValueOnce({
        success: true,
        data: {
          fulfillmentOrderHold: {
            fulfillmentOrder: null,
            userErrors: [{ field: ["id"], message: "Some error", code: "INVALID" }],
          },
        },
      } as ShopifyClientResult<unknown>);

      await expect(applyBackstop(mockSql as never, baseInput)).rejects.toThrow(
        RetryableBackstopError,
      );
    });

    it("handles already-held fulfillment orders as success", async () => {
      mockSql._setResult("INSERT INTO backstop_processed_orders", [{ action: "pending" }]);
      mockSql._setResult("BuyerAccount", [
        { holdState: "HELD", bypass: false, creditLimit: "100000.00", manualHold: true },
      ]);

      mockShopifyGraphQLRequest.mockResolvedValueOnce({
        success: true,
        data: {
          order: {
            fulfillmentOrders: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/FulfillmentOrder/1",
                    status: "OPEN",
                    assignedLocation: { location: { id: "loc-1" } },
                    supportedActions: [{ action: "HOLD" }],
                  },
                },
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
      mockSql._setResult("INSERT INTO backstop_processed_orders", [{ action: "pending" }]);
      // Return empty array - account not found
      mockSql._setResult("BuyerAccount", []);

      const result = await applyBackstop(mockSql as never, baseInput);

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("Account not found");
    });

    it("skips non-merchant-managed fulfillment orders with audit note", async () => {
      mockSql._setResult("INSERT INTO backstop_processed_orders", [{ action: "pending" }]);
      mockSql._setResult("BuyerAccount", [
        { holdState: "HELD", bypass: false, creditLimit: "100000.00", manualHold: true },
      ]);

      // Mock: one holdable FO, one non-holdable (third-party)
      mockShopifyGraphQLRequest.mockResolvedValueOnce({
        success: true,
        data: {
          order: {
            fulfillmentOrders: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/FulfillmentOrder/1",
                    status: "OPEN",
                    assignedLocation: { location: { id: "loc-1" } },
                    supportedActions: [{ action: "HOLD" }], // Holdable
                  },
                },
                {
                  node: {
                    id: "gid://shopify/FulfillmentOrder/2",
                    status: "OPEN",
                    assignedLocation: { location: { id: "loc-2" } },
                    supportedActions: [], // Non-holdable (third-party)
                  },
                },
              ],
            },
          },
        },
      } as ShopifyClientResult<unknown>);

      // Mock: hold succeeds for the holdable one
      mockShopifyGraphQLRequest.mockResolvedValueOnce({
        success: true,
        data: {
          fulfillmentOrderHold: {
            fulfillmentOrder: { id: "gid://shopify/FulfillmentOrder/1", status: "ON_HOLD" },
            userErrors: [],
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
      expect(result.nonMerchantManagedSkipped).toBe(1);
    });

    describe("pre-order hold state", () => {
      it("USE_PRE_ORDER_HOLD_STATE constant is true", () => {
        expect(USE_PRE_ORDER_HOLD_STATE).toBe(true);
      });

      it("skips when order itself pushed account over limit (was OK before)", async () => {
        // This tests the pre-order hold state logic:
        // Account is currently HELD, but was OK before this order
        mockSql._setResult("INSERT INTO backstop_processed_orders", [{ action: "pending" }]);
        mockSql._setResult("BuyerAccount", [
          {
            holdState: "HELD", // Currently held
            bypass: false,
            creditLimit: "100000.00", // 100,000.00 = 10,000,000 paise
            manualHold: false, // Not manual, so auto-hold due to over limit
            holdReasonCode: null,
          },
        ]);
        // Mock hasOverdueInvoices - no overdue invoices
        mockSql._setResult('status = \'open\'$?$AND "dueDate"', []);
        // Exposure without this order is under limit (Invoice query returns 0)
        mockSql._setResult("FROM \"Invoice\"", [{ total_paise: "5000000" }]); // 50,000 paise
        // Draft orders also under limit
        mockSql._setResult("s8_draft_orders", [{ total_paise: "0" }]);

        const result = await applyBackstop(mockSql as never, baseInput);

        // Should skip because account wasn't held BEFORE this order
        expect(result.applied).toBe(false);
        expect(result.skipped).toBe(true);
        expect(result.skipReason).toContain("This order pushed account over limit");
      });

      it("applies hold when account was already held before this order", async () => {
        mockSql._setResult("INSERT INTO backstop_processed_orders", [{ action: "pending" }]);
        mockSql._setResult("BuyerAccount", [
          {
            holdState: "HELD",
            bypass: false,
            creditLimit: "100000.00", // 100,000.00 = 10,000,000 paise
            manualHold: false,
            holdReasonCode: null,
          },
        ]);
        // Mock hasOverdueInvoices - no overdue invoices
        mockSql._setResult('status = \'open\'$?$AND "dueDate"', []);
        // Exposure without this order is ALREADY over limit (15,000,000 paise > 10,000,000 limit)
        mockSql._setResult("FROM \"Invoice\"", [{ total_paise: "15000000" }]);
        // Draft orders return 0
        mockSql._setResult("s8_draft_orders", [{ total_paise: "0" }]);

        // Mock FOs query
        mockShopifyGraphQLRequest.mockResolvedValueOnce({
          success: true,
          data: {
            order: {
              fulfillmentOrders: {
                edges: [
                  {
                    node: {
                      id: "gid://shopify/FulfillmentOrder/1",
                      status: "OPEN",
                      assignedLocation: { location: { id: "loc-1" } },
                      supportedActions: [{ action: "HOLD" }],
                    },
                  },
                ],
              },
            },
          },
        } as ShopifyClientResult<unknown>);

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
            tagsAdd: { node: { id: baseInput.orderGid }, userErrors: [] },
          },
        } as ShopifyClientResult<unknown>);

        const result = await applyBackstop(mockSql as never, baseInput);

        expect(result.applied).toBe(true);
        expect(result.fulfillmentOrdersHeld).toBe(1);
      });

      it("always applies hold for manual holds (not affected by pre-order state)", async () => {
        mockSql._setResult("INSERT INTO backstop_processed_orders", [{ action: "pending" }]);
        mockSql._setResult("BuyerAccount", [
          {
            holdState: "HELD",
            bypass: false,
            creditLimit: "100000.00",
            manualHold: true, // Manual hold - always applies
          },
        ]);

        // Mock FOs query
        mockShopifyGraphQLRequest.mockResolvedValueOnce({
          success: true,
          data: {
            order: {
              fulfillmentOrders: {
                edges: [
                  {
                    node: {
                      id: "gid://shopify/FulfillmentOrder/1",
                      status: "OPEN",
                      assignedLocation: { location: { id: "loc-1" } },
                      supportedActions: [{ action: "HOLD" }],
                    },
                  },
                ],
              },
            },
          },
        } as ShopifyClientResult<unknown>);

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
            tagsAdd: { node: { id: baseInput.orderGid }, userErrors: [] },
          },
        } as ShopifyClientResult<unknown>);

        const result = await applyBackstop(mockSql as never, baseInput);

        // Manual hold always applies, regardless of pre-order state
        expect(result.applied).toBe(true);
      });
    });
  });
});
