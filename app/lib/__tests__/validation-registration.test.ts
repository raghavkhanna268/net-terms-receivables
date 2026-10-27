import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ensureValidation } from "../validation-registration.server";
import * as logServer from "../log.server";

describe("validation-registration", () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let safeLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
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
                        blockOnFailure: false,
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
      expect(result.titleUpdate).toBe("skipped");
      expect(result.errCode).toBeUndefined();
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(1);
      expect(safeLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
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
                          blockOnFailure: false,
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
      expect(result.titleUpdate).toBe("updated");
      expect(result.errCode).toBeUndefined();
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(2);

      const queryCall = mockAdmin.graphql.mock.calls[0];
      expect(queryCall[0]).toContain("blockOnFailure");

      const updateCall = mockAdmin.graphql.mock.calls[1];
      expect(updateCall[0]).toContain("validationUpdate");
      expect(updateCall[1]).toEqual({
        variables: {
          id: "gid://shopify/Validation/123",
          title: "Termwise Credit Check",
          enable: true,
          blockOnFailure: false,
        },
      });
      expect(safeLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
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
                        blockOnFailure: false,
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
      expect(result.titleUpdate).toBe("skipped");
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(1);
      expect(safeLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("returns failed with errCode when title update has userErrors with known code", async () => {
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
                          blockOnFailure: false,
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
                      { field: ["title"], message: "Title is invalid", code: "INVALID" },
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
      expect(result.titleUpdate).toBe("failed");
      expect(result.errCode).toBe("INVALID");
      expect(safeLogSpy).toHaveBeenCalledTimes(1);
      expect(safeLogSpy).toHaveBeenCalledWith(
        "warn",
        "validation.title_update_failed",
        { err: "INVALID" },
      );
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("returns failed with errCode 'unknown' when title update has userErrors without code", async () => {
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
                          blockOnFailure: false,
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
      expect(result.titleUpdate).toBe("failed");
      expect(result.errCode).toBe("unknown");
      expect(safeLogSpy).toHaveBeenCalledTimes(1);
      expect(safeLogSpy).toHaveBeenCalledWith(
        "warn",
        "validation.title_update_failed",
        { err: "unknown" },
      );
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("returns failed with errCode when title update has GraphQL errors with extensions.code", async () => {
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
                          blockOnFailure: false,
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
                errors: [{ message: "Internal server error", extensions: { code: "INTERNAL_ERROR" } }],
              }),
          }),
      };

      const result = await ensureValidation(
        mockAdmin as Parameters<typeof ensureValidation>[0],
      );

      expect(result.id).toBe("gid://shopify/Validation/123");
      expect(result.created).toBe(false);
      expect(result.titleUpdate).toBe("failed");
      expect(result.errCode).toBe("INTERNAL_ERROR");
      expect(safeLogSpy).toHaveBeenCalledTimes(1);
      expect(safeLogSpy).toHaveBeenCalledWith(
        "warn",
        "validation.title_update_failed",
        { err: "INTERNAL_ERROR" },
      );
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("returns failed with errCode 'unknown' when title update has GraphQL errors without extensions.code", async () => {
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
                          blockOnFailure: false,
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
                errors: [{ message: "Internal server error" }],
              }),
          }),
      };

      const result = await ensureValidation(
        mockAdmin as Parameters<typeof ensureValidation>[0],
      );

      expect(result.id).toBe("gid://shopify/Validation/123");
      expect(result.created).toBe(false);
      expect(result.titleUpdate).toBe("failed");
      expect(result.errCode).toBe("unknown");
      expect(safeLogSpy).toHaveBeenCalledTimes(1);
      expect(safeLogSpy).toHaveBeenCalledWith(
        "warn",
        "validation.title_update_failed",
        { err: "unknown" },
      );
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("returns failed with errCode 'error' when title update throws", async () => {
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
                          blockOnFailure: false,
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
      expect(result.titleUpdate).toBe("failed");
      expect(result.errCode).toBe("error");
      expect(safeLogSpy).toHaveBeenCalledTimes(1);
      expect(safeLogSpy).toHaveBeenCalledWith(
        "warn",
        "validation.title_update_failed",
        { err: "error" },
      );
      expect(consoleErrorSpy).not.toHaveBeenCalled();
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
      expect(result.titleUpdate).toBe("skipped");
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(2);

      const createCall = mockAdmin.graphql.mock.calls[1];
      expect(createCall[1]).toEqual({
        variables: {
          functionHandle: "credit-check-validation",
          title: "Termwise Credit Check",
        },
      });
      expect(safeLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
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
                          blockOnFailure: false,
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
      expect(result.titleUpdate).toBe("skipped");
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(2);
      expect(safeLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("T1: rename keeps an enabled rule enabled", async () => {
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
                          id: "test-validation-t1",
                          shopifyFunction: {
                            handle: "credit-check-validation",
                          },
                          title: "Old Title",
                          enabled: true,
                          blockOnFailure: false,
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
                      id: "test-validation-t1",
                      title: "Termwise Credit Check",
                    },
                    userErrors: [],
                  },
                },
              }),
          }),
      };

      await ensureValidation(
        mockAdmin as Parameters<typeof ensureValidation>[0],
      );

      const queryCall = mockAdmin.graphql.mock.calls[0];
      expect(queryCall[0]).toContain("blockOnFailure");

      const updateCall = mockAdmin.graphql.mock.calls[1];
      expect(updateCall[0]).toContain("enable: $enable");
      expect(updateCall[1]).toEqual({
        variables: {
          id: "test-validation-t1",
          title: "Termwise Credit Check",
          enable: true,
          blockOnFailure: false,
        },
      });
    });

    it("T2: rename keeps a merchant-disabled rule disabled", async () => {
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
                          id: "test-validation-t2",
                          shopifyFunction: {
                            handle: "credit-check-validation",
                          },
                          title: "Old Title",
                          enabled: false,
                          blockOnFailure: false,
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
                      id: "test-validation-t2",
                      title: "Termwise Credit Check",
                    },
                    userErrors: [],
                  },
                },
              }),
          }),
      };

      await ensureValidation(
        mockAdmin as Parameters<typeof ensureValidation>[0],
      );

      const updateCall = mockAdmin.graphql.mock.calls[1];
      expect(updateCall[1]).toEqual({
        variables: {
          id: "test-validation-t2",
          title: "Termwise Credit Check",
          enable: false,
          blockOnFailure: false,
        },
      });
    });

    it("T3: rename keeps blockOnFailure: true", async () => {
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
                          id: "test-validation-t3",
                          shopifyFunction: {
                            handle: "credit-check-validation",
                          },
                          title: "Old Title",
                          enabled: true,
                          blockOnFailure: true,
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
                      id: "test-validation-t3",
                      title: "Termwise Credit Check",
                    },
                    userErrors: [],
                  },
                },
              }),
          }),
      };

      await ensureValidation(
        mockAdmin as Parameters<typeof ensureValidation>[0],
      );

      const updateCall = mockAdmin.graphql.mock.calls[1];
      expect(updateCall[0]).toContain("blockOnFailure: $blockOnFailure");
      expect(updateCall[1]).toEqual({
        variables: {
          id: "test-validation-t3",
          title: "Termwise Credit Check",
          enable: true,
          blockOnFailure: true,
        },
      });
    });

    it("T4: schema guard - when ValidationUpdateInput.enable defaults to false, mutation must set both enable and blockOnFailure", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const schemaPath = path.resolve(
        import.meta.dirname,
        "../../../test/fixtures/admin-2026-10.schema.json",
      );
      const schemaJson = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));

      const validationUpdateInput = schemaJson.data.__schema.types.find(
        (t: { name: string }) => t.name === "ValidationUpdateInput",
      );
      const enableField = validationUpdateInput.inputFields.find(
        (f: { name: string }) => f.name === "enable",
      );

      expect(enableField.defaultValue).toBe("false");

      const { VALIDATION_UPDATE_MUTATION } = await import(
        "../validation-registration.server"
      );
      expect(VALIDATION_UPDATE_MUTATION).toContain("$enable: Boolean!");
      expect(VALIDATION_UPDATE_MUTATION).toContain("$blockOnFailure: Boolean!");
      expect(VALIDATION_UPDATE_MUTATION).toContain("enable: $enable");
      expect(VALIDATION_UPDATE_MUTATION).toContain("blockOnFailure: $blockOnFailure");
    });

    it("T5: matching title means 0 update calls, create path sends enable: true", async () => {
      const mockAdminSkip = {
        graphql: vi.fn().mockResolvedValueOnce({
          json: () =>
            Promise.resolve({
              data: {
                validations: {
                  edges: [
                    {
                      node: {
                        id: "test-validation-t5-skip",
                        shopifyFunction: {
                          handle: "credit-check-validation",
                        },
                        title: "Termwise Credit Check",
                        enabled: true,
                        blockOnFailure: false,
                      },
                    },
                  ],
                },
              },
            }),
        }),
      };

      const resultSkip = await ensureValidation(
        mockAdminSkip as Parameters<typeof ensureValidation>[0],
      );

      expect(resultSkip.titleUpdate).toBe("skipped");
      expect(mockAdminSkip.graphql).toHaveBeenCalledTimes(1);

      const mockAdminCreate = {
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
                      id: "test-validation-t5-create",
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

      await ensureValidation(
        mockAdminCreate as Parameters<typeof ensureValidation>[0],
      );

      const createCall = mockAdminCreate.graphql.mock.calls[1];
      expect(createCall[0]).toContain("enable: true");
      expect(createCall[0]).toContain("blockOnFailure: false");
    });
  });
});
