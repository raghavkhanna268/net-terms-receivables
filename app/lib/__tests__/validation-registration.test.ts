import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ensureValidation } from "../validation-registration.server";

describe("validation-registration", () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  describe("ensureValidation", () => {
    it("returns existing validation when already registered with matching title", async () => {
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
                        title: "Termwise Credit Check",
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
      expect(result.titleUpdateCount).toBe(0);
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(1);
    });

    it("updates title when existing validation has old title", async () => {
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
                          id: "gid://shopify/Validation/123",
                          shopifyFunction: {
                            handle: "credit-check-validation",
                          },
                          title: "Old Title",
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
                  validationUpdate: {
                    validation: {
                      id: "gid://shopify/Validation/123",
                      title: "Termwise Credit Check",
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

      expect(result.id).toBe("gid://shopify/Validation/123");
      expect(result.created).toBe(false);
      expect(result.titleUpdateCount).toBe(1);
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(2);

      const updateCall = mockAdmin.graphql.mock.calls[1];
      expect(updateCall[0]).toContain("validationUpdate");
      expect(updateCall[1]).toEqual({
        variables: {
          id: "gid://shopify/Validation/123",
          title: "Termwise Credit Check",
        },
      });
    });

    it("skips update when title already matches (0 update calls)", async () => {
      const mockAdmin = {
        graphql: vi.fn().mockResolvedValueOnce({
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
                        title: "Termwise Credit Check",
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
      expect(result.titleUpdateCount).toBe(0);
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(1);
    });

    it("does not block when title update fails (logs error code without title or GID)", async () => {
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
                          id: "gid://shopify/Validation/123",
                          shopifyFunction: {
                            handle: "credit-check-validation",
                          },
                          title: "Old Title",
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
                  validationUpdate: {
                    validation: null,
                    userErrors: [
                      { field: ["title"], message: "Title is invalid" },
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
      expect(result.titleUpdateCount).toBe(0);

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      const warnCall = consoleWarnSpy.mock.calls[0][0];
      expect(warnCall).toContain("[validation] title_update err=");
      expect(warnCall).not.toContain("Old Title");
      expect(warnCall).not.toContain("Termwise Credit Check");
      expect(warnCall).not.toContain("gid://shopify/Validation/123");
    });

    it("does not block when title update throws (logs error code without title or GID)", async () => {
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
                          id: "gid://shopify/Validation/123",
                          shopifyFunction: {
                            handle: "credit-check-validation",
                          },
                          title: "Old Title",
                          enabled: true,
                        },
                      },
                    ],
                  },
                },
              }),
          })
          .mockRejectedValueOnce(new Error("Network error")),
      };

      const result = await ensureValidation(
        mockAdmin as Parameters<typeof ensureValidation>[0],
      );

      expect(result.id).toBe("gid://shopify/Validation/123");
      expect(result.created).toBe(false);
      expect(result.titleUpdateCount).toBe(0);

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      const warnCall = consoleWarnSpy.mock.calls[0][0];
      expect(warnCall).toContain("[validation] title_update err=");
      expect(warnCall).not.toContain("Old Title");
      expect(warnCall).not.toContain("gid://shopify/Validation/123");
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
                      title: "Termwise Credit Check",
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
      expect(result.titleUpdateCount).toBe(0);
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(2);

      const createCall = mockAdmin.graphql.mock.calls[1];
      expect(createCall[1]).toEqual({
        variables: {
          functionHandle: "credit-check-validation",
          title: "Termwise Credit Check",
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
                      title: "Termwise Credit Check",
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
      expect(result.titleUpdateCount).toBe(0);
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(2);
    });
  });
});
