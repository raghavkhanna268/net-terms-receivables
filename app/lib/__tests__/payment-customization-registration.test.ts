import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { ensurePaymentCustomization } from "../payment-customization-registration.server";

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
}

describe("payment-customization-registration", () => {
  let mockGraphql: Mock;
  let mockAdmin: AdminGraphqlClient;

  beforeEach(() => {
    mockGraphql = vi.fn();
    mockAdmin = { graphql: mockGraphql } as unknown as AdminGraphqlClient;
  });

  describe("ensurePaymentCustomization", () => {
    it("returns existing customization without creating (idempotent)", async () => {
      // Mock: existing customization found
      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          data: {
            paymentCustomizations: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/PaymentCustomization/123",
                    shopifyFunction: { handle: "hide-terms-payment" },
                    title: "Termwise Payment Hide",
                    enabled: true,
                  },
                },
              ],
            },
          },
        }),
      });

      const result = await ensurePaymentCustomization(mockAdmin);

      expect(result.id).toBe("gid://shopify/PaymentCustomization/123");
      expect(result.created).toBe(false);
      // Only one call (query), no create
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(1);
    });

    it("creates new customization when none exists", async () => {
      // Mock: no existing customization
      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          data: {
            paymentCustomizations: {
              edges: [],
            },
          },
        }),
      });

      // Mock: create succeeds
      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          data: {
            paymentCustomizationCreate: {
              paymentCustomization: {
                id: "gid://shopify/PaymentCustomization/456",
                shopifyFunction: { handle: "hide-terms-payment" },
                title: "Termwise Payment Hide",
                enabled: true,
              },
              userErrors: [],
            },
          },
        }),
      });

      const result = await ensurePaymentCustomization(mockAdmin);

      expect(result.id).toBe("gid://shopify/PaymentCustomization/456");
      expect(result.created).toBe(true);
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(2);
    });

    it("handles TAKEN error by re-querying (race condition)", async () => {
      // Mock: no existing customization on first query
      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          data: {
            paymentCustomizations: {
              edges: [],
            },
          },
        }),
      });

      // Mock: create fails with TAKEN (race condition)
      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          data: {
            paymentCustomizationCreate: {
              paymentCustomization: null,
              userErrors: [
                { code: "TAKEN", message: "Already exists" },
              ],
            },
          },
        }),
      });

      // Mock: re-query finds the customization
      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          data: {
            paymentCustomizations: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/PaymentCustomization/789",
                    shopifyFunction: { handle: "hide-terms-payment" },
                    title: "Termwise Payment Hide",
                    enabled: true,
                  },
                },
              ],
            },
          },
        }),
      });

      const result = await ensurePaymentCustomization(mockAdmin);

      expect(result.id).toBe("gid://shopify/PaymentCustomization/789");
      expect(result.created).toBe(false);
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(3);
    });

    it("throws on query error", async () => {
      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          errors: [{ message: "Access denied" }],
        }),
      });

      await expect(ensurePaymentCustomization(mockAdmin)).rejects.toThrow(
        "Failed to query payment customizations: Access denied",
      );
    });

    it("throws on create error (non-TAKEN)", async () => {
      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          data: {
            paymentCustomizations: { edges: [] },
          },
        }),
      });

      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          data: {
            paymentCustomizationCreate: {
              paymentCustomization: null,
              userErrors: [
                { code: "INVALID", message: "Invalid function handle" },
              ],
            },
          },
        }),
      });

      await expect(ensurePaymentCustomization(mockAdmin)).rejects.toThrow(
        "Payment customization creation failed: Invalid function handle",
      );
    });

    it("second call is no-op when already exists", async () => {
      // First call finds existing
      mockGraphql.mockResolvedValue({
        json: async () => ({
          data: {
            paymentCustomizations: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/PaymentCustomization/123",
                    shopifyFunction: { handle: "hide-terms-payment" },
                    title: "Termwise Payment Hide",
                    enabled: true,
                  },
                },
              ],
            },
          },
        }),
      });

      const result1 = await ensurePaymentCustomization(mockAdmin);
      const result2 = await ensurePaymentCustomization(mockAdmin);

      expect(result1.id).toBe(result2.id);
      expect(result1.created).toBe(false);
      expect(result2.created).toBe(false);
    });
  });
});
