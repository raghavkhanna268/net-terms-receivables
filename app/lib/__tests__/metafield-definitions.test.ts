import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ensureMetafieldDefinitions,
  getMetafieldDefinitionSpecs,
} from "../metafield-definitions.server";

describe("metafield-definitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getMetafieldDefinitionSpecs", () => {
    it("returns credit_status and hold definitions", () => {
      const specs = getMetafieldDefinitionSpecs();

      expect(specs).toHaveLength(2);

      const creditStatus = specs.find((s) => s.definition.key === "credit_status");
      expect(creditStatus).toBeDefined();
      expect(creditStatus?.definition.namespace).toBe("$app");
      expect(creditStatus?.definition.type).toBe("json");
      expect(creditStatus?.ownerTypes).toEqual(["COMPANY_LOCATION", "CUSTOMER"]);

      const hold = specs.find((s) => s.definition.key === "hold");
      expect(hold).toBeDefined();
      expect(hold?.definition.namespace).toBe("$app");
      expect(hold?.definition.type).toBe("boolean");
      expect(hold?.ownerTypes).toEqual(["COMPANY_LOCATION", "CUSTOMER"]);
    });
  });

  describe("ensureMetafieldDefinitions", () => {
    it("creates all definitions successfully", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      let callIndex = 0;

      const mockAdmin = {
        graphql: vi.fn().mockImplementation(() => {
          callIndex++;
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                data: {
                  metafieldDefinitionCreate: {
                    createdDefinition: {
                      id: `gid://shopify/MetafieldDefinition/${callIndex}`,
                    },
                    userErrors: [],
                  },
                },
              }),
          });
        }),
      };

      const results = await ensureMetafieldDefinitions(
        mockAdmin as Parameters<typeof ensureMetafieldDefinitions>[0],
      );

      expect(results).toHaveLength(4);
      expect(results.every((r) => r.created)).toBe(true);
      expect(results.every((r) => !r.alreadyExists)).toBe(true);
      expect(results.every((r) => !r.error)).toBe(true);

      expect(mockAdmin.graphql).toHaveBeenCalledTimes(4);

      const creditStatusCompanyLocation = results.find(
        (r) => r.key === "credit_status" && r.ownerType === "COMPANY_LOCATION",
      );
      expect(creditStatusCompanyLocation?.created).toBe(true);

      const creditStatusCustomer = results.find(
        (r) => r.key === "credit_status" && r.ownerType === "CUSTOMER",
      );
      expect(creditStatusCustomer?.created).toBe(true);

      const holdCompanyLocation = results.find(
        (r) => r.key === "hold" && r.ownerType === "COMPANY_LOCATION",
      );
      expect(holdCompanyLocation?.created).toBe(true);

      const holdCustomer = results.find(
        (r) => r.key === "hold" && r.ownerType === "CUSTOMER",
      );
      expect(holdCustomer?.created).toBe(true);

      consoleSpy.mockRestore();
    });

    it("treats TAKEN error as success (already-exists idempotency)", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: () =>
            Promise.resolve({
              data: {
                metafieldDefinitionCreate: {
                  createdDefinition: null,
                  userErrors: [
                    {
                      field: ["definition", "key"],
                      message:
                        "Key has already been taken for this namespace, owner type, and owner ID",
                      code: "TAKEN",
                    },
                  ],
                },
              },
            }),
        }),
      };

      const results = await ensureMetafieldDefinitions(
        mockAdmin as Parameters<typeof ensureMetafieldDefinitions>[0],
      );

      expect(results).toHaveLength(4);
      expect(results.every((r) => r.alreadyExists)).toBe(true);
      expect(results.every((r) => !r.created)).toBe(true);
      expect(results.every((r) => !r.error)).toBe(true);

      consoleSpy.mockRestore();
    });

    it("handles mixed success and already-exists", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      let callIndex = 0;

      const mockAdmin = {
        graphql: vi.fn().mockImplementation(() => {
          callIndex++;
          if (callIndex <= 2) {
            return Promise.resolve({
              json: () =>
                Promise.resolve({
                  data: {
                    metafieldDefinitionCreate: {
                      createdDefinition: {
                        id: `gid://shopify/MetafieldDefinition/${callIndex}`,
                      },
                      userErrors: [],
                    },
                  },
                }),
            });
          }
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                data: {
                  metafieldDefinitionCreate: {
                    createdDefinition: null,
                    userErrors: [
                      {
                        field: ["definition", "key"],
                        message: "Key has already been taken",
                        code: "TAKEN",
                      },
                    ],
                  },
                },
              }),
          });
        }),
      };

      const results = await ensureMetafieldDefinitions(
        mockAdmin as Parameters<typeof ensureMetafieldDefinitions>[0],
      );

      expect(results).toHaveLength(4);
      expect(results.filter((r) => r.created)).toHaveLength(2);
      expect(results.filter((r) => r.alreadyExists)).toHaveLength(2);
      expect(results.every((r) => !r.error)).toBe(true);

      consoleSpy.mockRestore();
    });

    it("throws on non-TAKEN userError", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: () =>
            Promise.resolve({
              data: {
                metafieldDefinitionCreate: {
                  createdDefinition: null,
                  userErrors: [
                    {
                      field: ["definition", "type"],
                      message: "Type is invalid",
                      code: "INVALID",
                    },
                  ],
                },
              },
            }),
        }),
      };

      await expect(
        ensureMetafieldDefinitions(
          mockAdmin as Parameters<typeof ensureMetafieldDefinitions>[0],
        ),
      ).rejects.toThrow("Failed to create metafield definitions");

      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it("logs userErrors without PII", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: () =>
            Promise.resolve({
              data: {
                metafieldDefinitionCreate: {
                  createdDefinition: null,
                  userErrors: [
                    {
                      field: ["definition", "namespace"],
                      message: "Some error message",
                      code: "NAMESPACE_INVALID",
                    },
                  ],
                },
              },
            }),
        }),
      };

      try {
        await ensureMetafieldDefinitions(
          mockAdmin as Parameters<typeof ensureMetafieldDefinitions>[0],
        );
      } catch {
        // Expected
      }

      const errorCall = consoleSpy.mock.calls[0];
      expect(errorCall[0]).toContain("[metafieldDefinitions]");
      expect(errorCall[0]).toContain("NAMESPACE_INVALID");
      expect(errorCall[0]).not.toContain("shop");
      expect(errorCall[0]).not.toContain("myshopify");

      consoleSpy.mockRestore();
    });

    it("throws on GraphQL errors", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: () =>
            Promise.resolve({
              errors: [{ message: "Access denied" }],
            }),
        }),
      };

      await expect(
        ensureMetafieldDefinitions(
          mockAdmin as Parameters<typeof ensureMetafieldDefinitions>[0],
        ),
      ).rejects.toThrow("Failed to create metafield definitions");

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("GraphQL errors: Access denied"),
      );

      consoleSpy.mockRestore();
    });

    it("handles network exceptions", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const mockAdmin = {
        graphql: vi.fn().mockRejectedValue(new Error("Network error")),
      };

      await expect(
        ensureMetafieldDefinitions(
          mockAdmin as Parameters<typeof ensureMetafieldDefinitions>[0],
        ),
      ).rejects.toThrow("Failed to create metafield definitions");

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Exception: Network error"),
      );

      consoleSpy.mockRestore();
    });

    it("passes correct variables to mutation", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: () =>
            Promise.resolve({
              data: {
                metafieldDefinitionCreate: {
                  createdDefinition: {
                    id: "gid://shopify/MetafieldDefinition/1",
                  },
                  userErrors: [],
                },
              },
            }),
        }),
      };

      await ensureMetafieldDefinitions(
        mockAdmin as Parameters<typeof ensureMetafieldDefinitions>[0],
      );

      const firstCall = mockAdmin.graphql.mock.calls[0];
      expect(firstCall[1]).toEqual({
        variables: {
          namespace: "$app",
          key: "credit_status",
          name: "Credit Status",
          description:
            "Net terms credit status including hold flag, limit, and exposure",
          type: "json",
          ownerType: "COMPANY_LOCATION",
        },
      });

      const thirdCall = mockAdmin.graphql.mock.calls[2];
      expect(thirdCall[1]).toEqual({
        variables: {
          namespace: "$app",
          key: "hold",
          name: "Hold Status",
          description:
            "Simple boolean flag indicating if the buyer is on hold for fulfillment",
          type: "boolean",
          ownerType: "COMPANY_LOCATION",
        },
      });

      consoleSpy.mockRestore();
    });

    it("allows retry after failure", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const consoleLogSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => {});

      let attempt = 0;
      const mockAdmin = {
        graphql: vi.fn().mockImplementation(() => {
          attempt++;
          if (attempt <= 4) {
            return Promise.resolve({
              json: () =>
                Promise.resolve({
                  errors: [{ message: "Temporary failure" }],
                }),
            });
          }
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                data: {
                  metafieldDefinitionCreate: {
                    createdDefinition: {
                      id: `gid://shopify/MetafieldDefinition/${attempt}`,
                    },
                    userErrors: [],
                  },
                },
              }),
          });
        }),
      };

      await expect(
        ensureMetafieldDefinitions(
          mockAdmin as Parameters<typeof ensureMetafieldDefinitions>[0],
        ),
      ).rejects.toThrow();

      expect(consoleSpy).toHaveBeenCalled();

      attempt = 4;
      const results = await ensureMetafieldDefinitions(
        mockAdmin as Parameters<typeof ensureMetafieldDefinitions>[0],
      );

      expect(results.every((r) => r.created)).toBe(true);

      consoleSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });
  });
});
