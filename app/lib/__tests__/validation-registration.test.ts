import { describe, it, expect, vi } from "vitest";
import { ensureValidation } from "../validation-registration.server";

describe("validation-registration", () => {
  describe("ensureValidation", () => {
    it("returns existing validation when already registered", async () => {
      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: () =>
            Promise.resolve({
              data: {
                validations: {
                  edges: [
                    {
                      node: {
                        id: "gid://shopify/Validation/123",
                        shopifyFunction: {
                          handle: "credit-check-validation",
                        },
                        title: "Net Terms Credit Check",
                        enabled: true,
                      },
                    },
                  ],
                },
              },
            }),
        }),
      };

      const result = await ensureValidation(
        mockAdmin as Parameters<typeof ensureValidation>[0],
      );

      expect(result.id).toBe("gid://shopify/Validation/123");
      expect(result.created).toBe(false);
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(1);
    });

    it("creates validation when not found", async () => {
      const mockAdmin = {
        graphql: vi
          .fn()
          .mockResolvedValueOnce({
            json: () =>
              Promise.resolve({
                data: {
                  validations: {
                    edges: [],
                  },
                },
              }),
          })
          .mockResolvedValueOnce({
            json: () =>
              Promise.resolve({
                data: {
                  validationCreate: {
                    validation: {
                      id: "gid://shopify/Validation/456",
                      shopifyFunction: {
                        handle: "credit-check-validation",
                      },
                      title: "Net Terms Credit Check",
                      enabled: true,
                    },
                    userErrors: [],
                  },
                },
              }),
          }),
      };

      const result = await ensureValidation(
        mockAdmin as Parameters<typeof ensureValidation>[0],
      );

      expect(result.id).toBe("gid://shopify/Validation/456");
      expect(result.created).toBe(true);
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(2);

      const createCall = mockAdmin.graphql.mock.calls[1];
      expect(createCall[1]).toEqual({
        variables: {
          functionHandle: "credit-check-validation",
          title: "Net Terms Credit Check",
        },
      });
    });

    it("throws on query error", async () => {
      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: () =>
            Promise.resolve({
              errors: [{ message: "Access denied" }],
            }),
        }),
      };

      await expect(
        ensureValidation(mockAdmin as Parameters<typeof ensureValidation>[0]),
      ).rejects.toThrow("Failed to query validations: Access denied");
    });

    it("throws on mutation user error", async () => {
      const mockAdmin = {
        graphql: vi
          .fn()
          .mockResolvedValueOnce({
            json: () =>
              Promise.resolve({
                data: {
                  validations: {
                    edges: [],
                  },
                },
              }),
          })
          .mockResolvedValueOnce({
            json: () =>
              Promise.resolve({
                data: {
                  validationCreate: {
                    validation: null,
                    userErrors: [
                      {
                        field: ["functionHandle"],
                        message: "Function not found",
                      },
                    ],
                  },
                },
              }),
          }),
      };

      await expect(
        ensureValidation(mockAdmin as Parameters<typeof ensureValidation>[0]),
      ).rejects.toThrow("Validation creation failed: Function not found");
    });

    it("throws on mutation GraphQL error", async () => {
      const mockAdmin = {
        graphql: vi
          .fn()
          .mockResolvedValueOnce({
            json: () =>
              Promise.resolve({
                data: {
                  validations: {
                    edges: [],
                  },
                },
              }),
          })
          .mockResolvedValueOnce({
            json: () =>
              Promise.resolve({
                errors: [{ message: "Internal error" }],
              }),
          }),
      };

      await expect(
        ensureValidation(mockAdmin as Parameters<typeof ensureValidation>[0]),
      ).rejects.toThrow("Failed to create validation: Internal error");
    });

    it("creates validation when different function handle exists", async () => {
      const mockAdmin = {
        graphql: vi
          .fn()
          .mockResolvedValueOnce({
            json: () =>
              Promise.resolve({
                data: {
                  validations: {
                    edges: [
                      {
                        node: {
                          id: "gid://shopify/Validation/999",
                          shopifyFunction: {
                            handle: "other-function",
                          },
                          title: "Other Validation",
                          enabled: true,
                        },
                      },
                    ],
                  },
                },
              }),
          })
          .mockResolvedValueOnce({
            json: () =>
              Promise.resolve({
                data: {
                  validationCreate: {
                    validation: {
                      id: "gid://shopify/Validation/456",
                      shopifyFunction: {
                        handle: "credit-check-validation",
                      },
                      title: "Net Terms Credit Check",
                      enabled: true,
                    },
                    userErrors: [],
                  },
                },
              }),
          }),
      };

      const result = await ensureValidation(
        mockAdmin as Parameters<typeof ensureValidation>[0],
      );

      expect(result.id).toBe("gid://shopify/Validation/456");
      expect(result.created).toBe(true);
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(2);
    });
  });
});
