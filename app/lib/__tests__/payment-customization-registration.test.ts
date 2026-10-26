import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { ensurePaymentCustomization } from "../payment-customization-registration.server";
import * as logServer from "../log.server";

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
}

describe("payment-customization-registration", () => {
  let mockGraphql: Mock;
  let mockAdmin: AdminGraphqlClient;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let safeLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGraphql = vi.fn();
    mockAdmin = { graphql: mockGraphql } as unknown as AdminGraphqlClient;
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    safeLogSpy = vi.spyOn(logServer, "safeLog");
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    safeLogSpy.mockRestore();
  });

  describe("ensurePaymentCustomization", () => {
    it("returns existing customization without creating when title matches (idempotent)", async () => {
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
      expect(result.titleUpdate).toBe("skipped");
      expect(result.errCode).toBeUndefined();
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(1);
      expect(safeLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("updates title when existing customization has old title", async () => {
      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          data: {
            paymentCustomizations: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/PaymentCustomization/123",
                    shopifyFunction: { handle: "hide-terms-payment" },
                    title: "Old Title",
                    enabled: true,
                  },
                },
              ],
            },
          },
        }),
      });

      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          data: {
            paymentCustomizationUpdate: {
              paymentCustomization: {
                id: "gid://shopify/PaymentCustomization/123",
                title: "Termwise Payment Hide",
              },
              userErrors: [],
            },
          },
        }),
      });

      const result = await ensurePaymentCustomization(mockAdmin);

      expect(result.id).toBe("gid://shopify/PaymentCustomization/123");
      expect(result.created).toBe(false);
      expect(result.titleUpdate).toBe("updated");
      expect(result.errCode).toBeUndefined();
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(2);

      const updateCall = mockGraphql.mock.calls[1];
      expect(updateCall[0]).toContain("paymentCustomizationUpdate");
      expect(updateCall[1]).toEqual({
        variables: {
          id: "gid://shopify/PaymentCustomization/123",
          title: "Termwise Payment Hide",
        },
      });
      expect(safeLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("skips update when title already matches (0 update calls)", async () => {
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
      expect(result.titleUpdate).toBe("skipped");
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(1);
      expect(safeLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("returns failed with errCode when title update has userErrors with known code", async () => {
      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          data: {
            paymentCustomizations: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/PaymentCustomization/123",
                    shopifyFunction: { handle: "hide-terms-payment" },
                    title: "Old Title",
                    enabled: true,
                  },
                },
              ],
            },
          },
        }),
      });

      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          data: {
            paymentCustomizationUpdate: {
              paymentCustomization: null,
              userErrors: [
                { field: ["title"], message: "Title is invalid", code: "INVALID" },
              ],
            },
          },
        }),
      });

      const result = await ensurePaymentCustomization(mockAdmin);

      expect(result.id).toBe("gid://shopify/PaymentCustomization/123");
      expect(result.created).toBe(false);
      expect(result.titleUpdate).toBe("failed");
      expect(result.errCode).toBe("INVALID");
      expect(safeLogSpy).toHaveBeenCalledTimes(1);
      expect(safeLogSpy).toHaveBeenCalledWith(
        "warn",
        "payment_customization.title_update_failed",
        { err: "INVALID" },
      );
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("returns failed with errCode 'unknown' when title update has userErrors without code", async () => {
      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          data: {
            paymentCustomizations: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/PaymentCustomization/123",
                    shopifyFunction: { handle: "hide-terms-payment" },
                    title: "Old Title",
                    enabled: true,
                  },
                },
              ],
            },
          },
        }),
      });

      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          data: {
            paymentCustomizationUpdate: {
              paymentCustomization: null,
              userErrors: [
                { field: ["title"], message: "Title is invalid" },
              ],
            },
          },
        }),
      });

      const result = await ensurePaymentCustomization(mockAdmin);

      expect(result.id).toBe("gid://shopify/PaymentCustomization/123");
      expect(result.created).toBe(false);
      expect(result.titleUpdate).toBe("failed");
      expect(result.errCode).toBe("unknown");
      expect(safeLogSpy).toHaveBeenCalledTimes(1);
      expect(safeLogSpy).toHaveBeenCalledWith(
        "warn",
        "payment_customization.title_update_failed",
        { err: "unknown" },
      );
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("returns failed with errCode when title update has GraphQL errors with extensions.code", async () => {
      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          data: {
            paymentCustomizations: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/PaymentCustomization/123",
                    shopifyFunction: { handle: "hide-terms-payment" },
                    title: "Old Title",
                    enabled: true,
                  },
                },
              ],
            },
          },
        }),
      });

      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          errors: [{ message: "Internal server error", extensions: { code: "INTERNAL_ERROR" } }],
        }),
      });

      const result = await ensurePaymentCustomization(mockAdmin);

      expect(result.id).toBe("gid://shopify/PaymentCustomization/123");
      expect(result.created).toBe(false);
      expect(result.titleUpdate).toBe("failed");
      expect(result.errCode).toBe("INTERNAL_ERROR");
      expect(safeLogSpy).toHaveBeenCalledTimes(1);
      expect(safeLogSpy).toHaveBeenCalledWith(
        "warn",
        "payment_customization.title_update_failed",
        { err: "INTERNAL_ERROR" },
      );
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("returns failed with errCode 'unknown' when title update has GraphQL errors without extensions.code", async () => {
      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          data: {
            paymentCustomizations: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/PaymentCustomization/123",
                    shopifyFunction: { handle: "hide-terms-payment" },
                    title: "Old Title",
                    enabled: true,
                  },
                },
              ],
            },
          },
        }),
      });

      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          errors: [{ message: "Internal server error" }],
        }),
      });

      const result = await ensurePaymentCustomization(mockAdmin);

      expect(result.id).toBe("gid://shopify/PaymentCustomization/123");
      expect(result.created).toBe(false);
      expect(result.titleUpdate).toBe("failed");
      expect(result.errCode).toBe("unknown");
      expect(safeLogSpy).toHaveBeenCalledTimes(1);
      expect(safeLogSpy).toHaveBeenCalledWith(
        "warn",
        "payment_customization.title_update_failed",
        { err: "unknown" },
      );
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("returns failed with errCode 'error' when title update throws", async () => {
      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          data: {
            paymentCustomizations: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/PaymentCustomization/123",
                    shopifyFunction: { handle: "hide-terms-payment" },
                    title: "Old Title",
                    enabled: true,
                  },
                },
              ],
            },
          },
        }),
      });

      mockGraphql.mockRejectedValueOnce(new Error("Network error"));

      const result = await ensurePaymentCustomization(mockAdmin);

      expect(result.id).toBe("gid://shopify/PaymentCustomization/123");
      expect(result.created).toBe(false);
      expect(result.titleUpdate).toBe("failed");
      expect(result.errCode).toBe("error");
      expect(safeLogSpy).toHaveBeenCalledTimes(1);
      expect(safeLogSpy).toHaveBeenCalledWith(
        "warn",
        "payment_customization.title_update_failed",
        { err: "error" },
      );
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("creates new customization when none exists", async () => {
      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          data: {
            paymentCustomizations: {
              edges: [],
            },
          },
        }),
      });

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
      expect(result.titleUpdate).toBe("skipped");
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(2);
      expect(safeLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("handles TAKEN error by re-querying with matching title", async () => {
      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          data: {
            paymentCustomizations: {
              edges: [],
            },
          },
        }),
      });

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
      expect(result.titleUpdate).toBe("skipped");
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(3);
      expect(safeLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("handles TAKEN error by re-querying and updating old title", async () => {
      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          data: {
            paymentCustomizations: {
              edges: [],
            },
          },
        }),
      });

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

      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          data: {
            paymentCustomizations: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/PaymentCustomization/789",
                    shopifyFunction: { handle: "hide-terms-payment" },
                    title: "Old Title",
                    enabled: true,
                  },
                },
              ],
            },
          },
        }),
      });

      mockGraphql.mockResolvedValueOnce({
        json: async () => ({
          data: {
            paymentCustomizationUpdate: {
              paymentCustomization: {
                id: "gid://shopify/PaymentCustomization/789",
                title: "Termwise Payment Hide",
              },
              userErrors: [],
            },
          },
        }),
      });

      const result = await ensurePaymentCustomization(mockAdmin);

      expect(result.id).toBe("gid://shopify/PaymentCustomization/789");
      expect(result.created).toBe(false);
      expect(result.titleUpdate).toBe("updated");
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(4);

      const updateCall = mockGraphql.mock.calls[3];
      expect(updateCall[0]).toContain("paymentCustomizationUpdate");
      expect(updateCall[1]).toEqual({
        variables: {
          id: "gid://shopify/PaymentCustomization/789",
          title: "Termwise Payment Hide",
        },
      });
      expect(safeLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
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

    it("second call is no-op when already exists with matching title", async () => {
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
      expect(result1.titleUpdate).toBe("skipped");
      expect(result2.titleUpdate).toBe("skipped");
      expect(safeLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });
});
