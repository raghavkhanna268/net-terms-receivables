import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

/**
 * Tests for app.onboarding route (S23).
 *
 * Tests verify:
 * 1. Dismiss action updates Shop.onboarding_dismissed_at
 * 2. Reopen action clears Shop.onboarding_dismissed_at
 * 3. Loader returns correct onboarding state
 * 4. S23-02: Registration status mapping (ok/missing/error)
 * 5. S23-02: Retry action calls only missing ensure* helpers
 * 6. S23-02: In-flight guard prevents double registration
 * 7. S23-02: safeLog with no PII
 */

const mockSql = Object.assign(vi.fn(), {
  unsafe: vi.fn((s) => s),
  json: vi.fn((obj) => JSON.stringify(obj)),
});

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
}));

const mockEnsureValidation = vi.fn();
const mockEnsurePaymentCustomization = vi.fn();
const mockEnsureMetafieldDefinitions = vi.fn();

vi.mock("~/lib/validation-registration.server", () => ({
  ensureValidation: mockEnsureValidation,
}));

vi.mock("~/lib/payment-customization-registration.server", () => ({
  ensurePaymentCustomization: mockEnsurePaymentCustomization,
}));

vi.mock("~/lib/metafield-definitions.server", () => ({
  ensureMetafieldDefinitions: mockEnsureMetafieldDefinitions,
  getMetafieldDefinitionSpecs: vi.fn(() => [{
    definition: { namespace: "$app", key: "credit_status", type: "json" },
    ownerTypes: ["COMPANY_LOCATION", "CUSTOMER"],
  }]),
}));

vi.mock("~/services/plan.server", () => ({
  resolvePlan: vi.fn().mockResolvedValue({
    plan: { key: "free" },
    subscriptionName: "Free",
    isTest: false,
  }),
}));

vi.mock("~/services/gating.server", () => ({
  getUsageStats: vi.fn().mockResolvedValue({
    companies: { current: 0, limit: 3 },
    importsThisMonth: { current: 0, limit: 1 },
  }),
  isGatingEnforced: vi.fn().mockReturnValue(false),
}));

vi.mock("~/lib/aging-queries.server", () => ({
  getShopAgingTotals: vi.fn().mockResolvedValue({
    totalByCurrency: {},
    buckets: {
      current: { byCurrency: {} },
      "1-30": { byCurrency: {} },
      "31-60": { byCurrency: {} },
      "61-90": { byCurrency: {} },
      "90+": { byCurrency: {} },
    },
    overdueByCurrency: {},
    oldestOverdueDays: null,
  }),
  getBuyerLedger: vi.fn().mockResolvedValue({ rows: [], totalCount: 0 }),
  getBuyerInvoices: vi.fn().mockResolvedValue({ rows: [], totalCount: 0 }),
}));

describe("app.onboarding", () => {
  const TEST_SHOP = "test-shop.myshopify.com";
  const TEST_SHOP_ID = "shop-123";

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureValidation.mockReset();
    mockEnsurePaymentCustomization.mockReset();
    mockEnsureMetafieldDefinitions.mockReset();
  });

  describe("action - dismiss", () => {
    it("updates Shop.onboarding_dismissed_at to NOW()", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id FROM")) {
          return Promise.resolve([{ id: TEST_SHOP_ID }]);
        }
        if (query.includes("UPDATE") && query.includes("onboarding_dismissed_at")) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      const { action } = await import("../app.onboarding");

      const formData = new FormData();
      formData.set("_action", "dismiss");

      const result = await action({
        request: new Request("https://example.com/app/onboarding", {
          method: "POST",
          body: formData,
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
              }),
            },
          },
        },
        params: {},
      } as unknown as ActionFunctionArgs);

      expect(result).toEqual({ success: true, action: "dismissed" });
      expect(mockSql).toHaveBeenCalledWith(
        expect.arrayContaining([expect.stringContaining("UPDATE")]),
        expect.anything()
      );
    });

    it("returns error when shop not found", async () => {
      mockSql.mockImplementation(() => Promise.resolve([]));

      const { action } = await import("../app.onboarding");

      const formData = new FormData();
      formData.set("_action", "dismiss");

      const result = await action({
        request: new Request("https://example.com/app/onboarding", {
          method: "POST",
          body: formData,
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
              }),
            },
          },
        },
        params: {},
      } as unknown as ActionFunctionArgs);

      expect(result).toEqual({ success: false, error: "Shop not found" });
    });
  });

  describe("action - reopen", () => {
    it("clears Shop.onboarding_dismissed_at", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id FROM")) {
          return Promise.resolve([{ id: TEST_SHOP_ID }]);
        }
        if (query.includes("UPDATE") && query.includes("onboarding_dismissed_at = NULL")) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      const { action } = await import("../app.onboarding");

      const formData = new FormData();
      formData.set("_action", "reopen");

      const result = await action({
        request: new Request("https://example.com/app/onboarding", {
          method: "POST",
          body: formData,
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
              }),
            },
          },
        },
        params: {},
      } as unknown as ActionFunctionArgs);

      expect(result).toEqual({ success: true, action: "reopened" });
    });
  });

  describe("action - unknown", () => {
    it("returns error for unknown action", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id FROM")) {
          return Promise.resolve([{ id: TEST_SHOP_ID }]);
        }
        return Promise.resolve([]);
      });

      const { action } = await import("../app.onboarding");

      const formData = new FormData();
      formData.set("_action", "invalid");

      const result = await action({
        request: new Request("https://example.com/app/onboarding", {
          method: "POST",
          body: formData,
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
              }),
            },
          },
        },
        params: {},
      } as unknown as ActionFunctionArgs);

      expect(result).toEqual({ success: false, error: "Unknown action" });
    });
  });

  describe("loader", () => {
    it("returns error when shop not found", async () => {
      mockSql.mockImplementation(() => Promise.resolve([]));

      const { loader } = await import("../app.onboarding");

      const result = await loader({
        request: new Request("https://example.com/app/onboarding"),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
                admin: {
                  graphql: vi.fn().mockResolvedValue({
                    json: () => Promise.resolve({ data: {} }),
                  }),
                },
              }),
            },
          },
        },
        params: {},
      } as unknown as LoaderFunctionArgs);

      expect(result.error).toBe("Shop not found");
      expect(result.state).toBeNull();
    });

    it("returns onboarding state with all steps", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id") && query.includes("defaultTermsDays")) {
          return Promise.resolve([{
            id: TEST_SHOP_ID,
            defaultTermsDays: 30,
            onboardingDismissedAt: null,
          }]);
        }
        if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
          return Promise.resolve([{ count: "5" }]);
        }
        if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
          return Promise.resolve([{ count: "2" }]);
        }
        return Promise.resolve([]);
      });

      const mockGraphql = vi.fn()
        .mockResolvedValueOnce({
          json: () => Promise.resolve({
            data: {
              validations: {
                edges: [{
                  node: {
                    id: "gid://shopify/Validation/123",
                    shopifyFunction: { handle: "credit-check-validation" },
                    title: "Net Terms Credit Check",
                    enabled: true,
                  },
                }],
              },
            },
          }),
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve({
            data: {
              paymentCustomizations: {
                edges: [{
                  node: {
                    id: "gid://shopify/PaymentCustomization/456",
                    shopifyFunction: { handle: "hide-terms-payment" },
                    title: "Net Terms Payment Hide",
                    enabled: true,
                  },
                }],
              },
            },
          }),
        })
        .mockResolvedValue({
          json: () => Promise.resolve({
            data: {
              metafieldDefinitions: {
                edges: [{
                  node: {
                    id: "gid://shopify/MetafieldDefinition/789",
                    namespace: "$app",
                    key: "credit_status",
                    ownerType: "COMPANY_LOCATION",
                  },
                }],
              },
            },
          }),
        });

      const { loader } = await import("../app.onboarding");

      const result = await loader({
        request: new Request("https://example.com/app/onboarding"),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
                admin: { graphql: mockGraphql },
              }),
            },
          },
        },
        params: {},
      } as unknown as LoaderFunctionArgs);

      expect(result.error).toBeNull();
      expect(result.state).not.toBeNull();
      expect(result.state?.steps).toHaveLength(5);
      expect(result.state?.isComplete).toBe(true);
      expect(result.shopId).toBe(TEST_SHOP_ID);
      expect(result.registrationStatus).not.toBeNull();
    });

    it("returns dismissed state when onboarding was dismissed", async () => {
      const dismissedDate = new Date("2026-10-24T10:00:00Z");
      
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id") && query.includes("defaultTermsDays")) {
          return Promise.resolve([{
            id: TEST_SHOP_ID,
            defaultTermsDays: null,
            onboardingDismissedAt: dismissedDate,
          }]);
        }
        if (query.includes("COUNT(*)")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      });

      const mockGraphql = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ data: {} }),
      });

      const { loader } = await import("../app.onboarding");

      const result = await loader({
        request: new Request("https://example.com/app/onboarding"),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
                admin: { graphql: mockGraphql },
              }),
            },
          },
        },
        params: {},
      } as unknown as LoaderFunctionArgs);

      expect(result.error).toBeNull();
      expect(result.state?.dismissedAt).toBe(dismissedDate.toISOString());
    });
  });

  describe("S23-02: registration status", () => {
    it("loader returns ok status when all registrations exist", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id") && query.includes("defaultTermsDays")) {
          return Promise.resolve([{
            id: TEST_SHOP_ID,
            defaultTermsDays: 30,
            onboardingDismissedAt: null,
          }]);
        }
        if (query.includes("COUNT(*)")) {
          return Promise.resolve([{ count: "1" }]);
        }
        return Promise.resolve([]);
      });

      const mockGraphql = vi.fn()
        .mockResolvedValueOnce({
          json: () => Promise.resolve({
            data: {
              validations: {
                edges: [{
                  node: {
                    id: "gid://shopify/Validation/123",
                    shopifyFunction: { handle: "credit-check-validation" },
                    title: "Test",
                    enabled: true,
                  },
                }],
              },
            },
          }),
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve({
            data: {
              paymentCustomizations: {
                edges: [{
                  node: {
                    id: "gid://shopify/PaymentCustomization/456",
                    shopifyFunction: { handle: "hide-terms-payment" },
                    title: "Test",
                    enabled: true,
                  },
                }],
              },
            },
          }),
        })
        .mockResolvedValue({
          json: () => Promise.resolve({
            data: {
              metafieldDefinitions: {
                edges: [{
                  node: {
                    id: "gid://shopify/MetafieldDefinition/789",
                    namespace: "$app",
                    key: "credit_status",
                    ownerType: "COMPANY_LOCATION",
                  },
                }],
              },
            },
          }),
        });

      const { loader } = await import("../app.onboarding");

      const result = await loader({
        request: new Request("https://example.com/app/onboarding"),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
                admin: { graphql: mockGraphql },
              }),
            },
          },
        },
        params: {},
      } as unknown as LoaderFunctionArgs);

      expect(result.registrationStatus).not.toBeNull();
      expect(result.registrationStatus?.validation.status).toBe("ok");
      expect(result.registrationStatus?.paymentCustomization.status).toBe("ok");
      expect(result.registrationStatus?.metafieldDefinitions.status).toBe("ok");
    });

    it("metafield check matches on key only with app--123 namespace", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id") && query.includes("defaultTermsDays")) {
          return Promise.resolve([{
            id: TEST_SHOP_ID,
            defaultTermsDays: 30,
            onboardingDismissedAt: null,
          }]);
        }
        if (query.includes("COUNT(*)")) {
          return Promise.resolve([{ count: "1" }]);
        }
        return Promise.resolve([]);
      });

      const mockGraphql = vi.fn()
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ data: { validations: { edges: [] } } }),
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ data: { paymentCustomizations: { edges: [] } } }),
        })
        .mockResolvedValue({
          json: () => Promise.resolve({
            data: {
              metafieldDefinitions: {
                edges: [{
                  node: {
                    id: "gid://shopify/MetafieldDefinition/789",
                    namespace: "app--123",
                    key: "credit_status",
                    ownerType: "COMPANY_LOCATION",
                  },
                }],
              },
            },
          }),
        });

      const { loader } = await import("../app.onboarding");

      const result = await loader({
        request: new Request("https://example.com/app/onboarding"),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
                admin: { graphql: mockGraphql },
              }),
            },
          },
        },
        params: {},
      } as unknown as LoaderFunctionArgs);

      expect(result.registrationStatus?.metafieldDefinitions.status).toBe("ok");
    });

    it("loader returns missing status when registrations not found", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id") && query.includes("defaultTermsDays")) {
          return Promise.resolve([{
            id: TEST_SHOP_ID,
            defaultTermsDays: 30,
            onboardingDismissedAt: null,
          }]);
        }
        if (query.includes("COUNT(*)")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      });

      const mockGraphql = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ data: {} }),
      });

      const { loader } = await import("../app.onboarding");

      const result = await loader({
        request: new Request("https://example.com/app/onboarding"),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
                admin: { graphql: mockGraphql },
              }),
            },
          },
        },
        params: {},
      } as unknown as LoaderFunctionArgs);

      expect(result.registrationStatus).not.toBeNull();
      expect(result.registrationStatus?.validation.status).toBe("missing");
      expect(result.registrationStatus?.paymentCustomization.status).toBe("missing");
      expect(result.registrationStatus?.metafieldDefinitions.status).toBe("missing");
    });

    it("loader returns error status when validation query returns GraphQL errors", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id") && query.includes("defaultTermsDays")) {
          return Promise.resolve([{
            id: TEST_SHOP_ID,
            defaultTermsDays: 30,
            onboardingDismissedAt: null,
          }]);
        }
        if (query.includes("COUNT(*)")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      });

      const mockGraphql = vi.fn()
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ errors: [{ message: "Validation access denied" }] }),
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ data: { paymentCustomizations: { edges: [] } } }),
        })
        .mockResolvedValue({
          json: () => Promise.resolve({ data: { metafieldDefinitions: { edges: [] } } }),
        });

      const { loader } = await import("../app.onboarding");

      const result = await loader({
        request: new Request("https://example.com/app/onboarding"),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
                admin: { graphql: mockGraphql },
              }),
            },
          },
        },
        params: {},
      } as unknown as LoaderFunctionArgs);

      expect(result.registrationStatus?.validation.status).toBe("error");
    });

    it("loader returns error status when payment customization query returns GraphQL errors", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id") && query.includes("defaultTermsDays")) {
          return Promise.resolve([{
            id: TEST_SHOP_ID,
            defaultTermsDays: 30,
            onboardingDismissedAt: null,
          }]);
        }
        if (query.includes("COUNT(*)")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      });

      const mockGraphql = vi.fn()
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ data: { validations: { edges: [] } } }),
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ errors: [{ message: "Payment access denied" }] }),
        })
        .mockResolvedValue({
          json: () => Promise.resolve({ data: { metafieldDefinitions: { edges: [] } } }),
        });

      const { loader } = await import("../app.onboarding");

      const result = await loader({
        request: new Request("https://example.com/app/onboarding"),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
                admin: { graphql: mockGraphql },
              }),
            },
          },
        },
        params: {},
      } as unknown as LoaderFunctionArgs);

      expect(result.registrationStatus?.paymentCustomization.status).toBe("error");
    });

    it("loader returns error status when metafield query returns GraphQL errors", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id") && query.includes("defaultTermsDays")) {
          return Promise.resolve([{
            id: TEST_SHOP_ID,
            defaultTermsDays: 30,
            onboardingDismissedAt: null,
          }]);
        }
        if (query.includes("COUNT(*)")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      });

      const mockGraphql = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ errors: [{ message: "Access denied" }] }),
      });

      const { loader } = await import("../app.onboarding");

      const result = await loader({
        request: new Request("https://example.com/app/onboarding"),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
                admin: { graphql: mockGraphql },
              }),
            },
          },
        },
        params: {},
      } as unknown as LoaderFunctionArgs);

      expect(result.registrationStatus).not.toBeNull();
      expect(result.registrationStatus?.metafieldDefinitions.status).toBe("error");
    });
  });

  describe("S23-02: retry action", () => {
    it("recomputes status server-side and calls only missing ensure* helpers", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id FROM")) {
          return Promise.resolve([{ id: TEST_SHOP_ID }]);
        }
        return Promise.resolve([]);
      });

      mockEnsureValidation.mockResolvedValue({ id: "gid://shopify/Validation/123", created: true });
      mockEnsureMetafieldDefinitions.mockResolvedValue([]);

      const { action } = await import("../app.onboarding");

      const formData = new FormData();
      formData.set("_action", "retry_registration");

      const mockGraphql = vi.fn()
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ data: { validations: { edges: [] } } }),
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve({
            data: {
              paymentCustomizations: {
                edges: [{
                  node: {
                    id: "gid://shopify/PaymentCustomization/456",
                    shopifyFunction: { handle: "hide-terms-payment" },
                    title: "Test",
                    enabled: true,
                  },
                }],
              },
            },
          }),
        })
        .mockResolvedValue({
          json: () => Promise.resolve({ data: { metafieldDefinitions: { edges: [] } } }),
        });

      const result = await action({
        request: new Request("https://example.com/app/onboarding", {
          method: "POST",
          body: formData,
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
                admin: { graphql: mockGraphql },
              }),
            },
          },
        },
        params: {},
      } as unknown as ActionFunctionArgs);

      expect(mockEnsureValidation).toHaveBeenCalledOnce();
      expect(mockEnsurePaymentCustomization).not.toHaveBeenCalled();
      expect(mockEnsureMetafieldDefinitions).toHaveBeenCalledOnce();
      expect(result).not.toBeInstanceOf(Response);
      const data = result as { action: string; success: boolean };
      expect(data.action).toBe("retry_registration");
      expect(data.success).toBe(true);
    });

    it("returns error status when ensure* helper fails", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id FROM")) {
          return Promise.resolve([{ id: TEST_SHOP_ID }]);
        }
        return Promise.resolve([]);
      });

      mockEnsureValidation.mockRejectedValue(new Error("Registration failed"));

      const { action } = await import("../app.onboarding");

      const formData = new FormData();
      formData.set("_action", "retry_registration");

      const mockGraphql = vi.fn()
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ data: { validations: { edges: [] } } }),
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve({
            data: {
              paymentCustomizations: {
                edges: [{
                  node: {
                    id: "gid://shopify/PaymentCustomization/456",
                    shopifyFunction: { handle: "hide-terms-payment" },
                    title: "Test",
                    enabled: true,
                  },
                }],
              },
            },
          }),
        })
        .mockResolvedValue({
          json: () => Promise.resolve({
            data: {
              metafieldDefinitions: {
                edges: [{
                  node: {
                    id: "gid://shopify/MetafieldDefinition/789",
                    namespace: "app--123",
                    key: "credit_status",
                    ownerType: "COMPANY_LOCATION",
                  },
                }],
              },
            },
          }),
        });

      const result = await action({
        request: new Request("https://example.com/app/onboarding", {
          method: "POST",
          body: formData,
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
                admin: { graphql: mockGraphql },
              }),
            },
          },
        },
        params: {},
      } as unknown as ActionFunctionArgs);

      expect(result).not.toBeInstanceOf(Response);
      const data = result as { action: string; success: boolean; registrationStatus?: { validation: { status: string } } };
      expect(data.action).toBe("retry_registration");
      expect(data.success).toBe(false);
      expect(data.registrationStatus?.validation.status).toBe("error");
    });

    it("in-flight guard prevents double registration", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id FROM")) {
          return Promise.resolve([{ id: TEST_SHOP_ID }]);
        }
        return Promise.resolve([]);
      });

      let resolveFirst: () => void;
      const firstCallPromise = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });

      mockEnsureValidation.mockImplementation(async () => {
        await firstCallPromise;
        return { id: "gid://shopify/Validation/123", created: true };
      });

      const { action } = await import("../app.onboarding");

      const formData = new FormData();
      formData.set("_action", "retry_registration");

      const mockGraphql = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ data: {} }),
      });

      const context = {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP },
              admin: { graphql: mockGraphql },
            }),
          },
        },
      };

      const firstRequest = action({
        request: new Request("https://example.com/app/onboarding", {
          method: "POST",
          body: formData,
        }),
        context,
        params: {},
      } as unknown as ActionFunctionArgs);

      await new Promise((r) => setTimeout(r, 10));

      const secondFormData = new FormData();
      secondFormData.set("_action", "retry_registration");

      const secondResult = await action({
        request: new Request("https://example.com/app/onboarding", {
          method: "POST",
          body: secondFormData,
        }),
        context,
        params: {},
      } as unknown as ActionFunctionArgs);

      expect(secondResult).not.toBeInstanceOf(Response);
      const data = secondResult as { success: boolean; error: string };
      expect(data.success).toBe(false);
      expect(data.error).toBe("Retry already in progress");

      resolveFirst!();
      await firstRequest;
    });

    it("empty body does not 500", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id FROM")) {
          return Promise.resolve([{ id: TEST_SHOP_ID }]);
        }
        return Promise.resolve([]);
      });

      const { action } = await import("../app.onboarding");

      const formData = new FormData();
      formData.set("_action", "retry_registration");

      const mockGraphql = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ data: {} }),
      });

      const result = await action({
        request: new Request("https://example.com/app/onboarding", {
          method: "POST",
          body: formData,
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
                admin: { graphql: mockGraphql },
              }),
            },
          },
        },
        params: {},
      } as unknown as ActionFunctionArgs);

      expect(result).not.toBeInstanceOf(Response);
      const data = result as { action: string; registrationStatus?: unknown };
      expect(data.action).toBe("retry_registration");
      expect(data.registrationStatus).toBeDefined();
    });
  });
});

describe("S23-04: initial sync", () => {
  const TEST_SHOP = "test-shop.myshopify.com";
  const TEST_SHOP_ID = "shop-123";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("loader sync state mapping", () => {
    const mockGraphql = vi.fn()
      .mockResolvedValueOnce({ json: () => Promise.resolve({ data: { validations: { edges: [] } } }) })
      .mockResolvedValueOnce({ json: () => Promise.resolve({ data: { paymentCustomizations: { edges: [] } } }) })
      .mockResolvedValue({ json: () => Promise.resolve({ data: { metafieldDefinitions: { edges: [] } } }) });

    it("returns not_started when no bulk operations exist", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id") && query.includes("defaultTermsDays")) {
          return Promise.resolve([{ id: TEST_SHOP_ID, defaultTermsDays: 30, onboardingDismissedAt: null }]);
        }
        if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
          return Promise.resolve([{ count: "0" }]);
        }
        if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
          return Promise.resolve([{ count: "0" }]);
        }
        if (query.includes("s6_bulk_operations")) {
          return Promise.resolve([]);
        }
        if (query.includes("s6_dead_letter")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      });

      const { loader } = await import("../app.onboarding");

      const result = await loader({
        request: new Request("https://example.com/app/onboarding"),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
                admin: { graphql: mockGraphql },
              }),
            },
          },
        },
        params: {},
      } as never);

      expect(result.initialSyncState).not.toBeNull();
      expect(result.initialSyncState?.status).toBe("not_started");
    });

    it("returns in_progress when bulk operations exist without completed_at", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id") && query.includes("defaultTermsDays")) {
          return Promise.resolve([{ id: TEST_SHOP_ID, defaultTermsDays: 30, onboardingDismissedAt: null }]);
        }
        if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
          return Promise.resolve([{ count: "0" }]);
        }
        if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
          return Promise.resolve([{ count: "0" }]);
        }
        if (query.includes("s6_bulk_operations")) {
          return Promise.resolve([
            { reconcile_stage: "companies", completed_at: null, failure_count: 0 },
          ]);
        }
        if (query.includes("s6_dead_letter")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      });

      const { loader } = await import("../app.onboarding");

      const result = await loader({
        request: new Request("https://example.com/app/onboarding"),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
                admin: { graphql: mockGraphql },
              }),
            },
          },
        },
        params: {},
      } as never);

      expect(result.initialSyncState?.status).toBe("in_progress");
    });

    it("returns done when both companies and orders are completed", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id") && query.includes("defaultTermsDays")) {
          return Promise.resolve([{ id: TEST_SHOP_ID, defaultTermsDays: 30, onboardingDismissedAt: null }]);
        }
        if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
          return Promise.resolve([{ count: "0" }]);
        }
        if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
          return Promise.resolve([{ count: "0" }]);
        }
        if (query.includes("s6_bulk_operations")) {
          return Promise.resolve([
            { reconcile_stage: "companies", completed_at: new Date(), failure_count: 0 },
            { reconcile_stage: "orders", completed_at: new Date(), failure_count: 0 },
          ]);
        }
        if (query.includes("s6_dead_letter")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      });

      const { loader } = await import("../app.onboarding");

      const result = await loader({
        request: new Request("https://example.com/app/onboarding"),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
                admin: { graphql: mockGraphql },
              }),
            },
          },
        },
        params: {},
      } as never);

      expect(result.initialSyncState?.status).toBe("done");
    });

    it("returns failed when failure_count >= 5", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id") && query.includes("defaultTermsDays")) {
          return Promise.resolve([{ id: TEST_SHOP_ID, defaultTermsDays: 30, onboardingDismissedAt: null }]);
        }
        if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
          return Promise.resolve([{ count: "0" }]);
        }
        if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
          return Promise.resolve([{ count: "0" }]);
        }
        if (query.includes("s6_bulk_operations")) {
          return Promise.resolve([
            { reconcile_stage: "companies", completed_at: null, failure_count: 5 },
          ]);
        }
        if (query.includes("s6_dead_letter")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      });

      const { loader } = await import("../app.onboarding");

      const result = await loader({
        request: new Request("https://example.com/app/onboarding"),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
                admin: { graphql: mockGraphql },
              }),
            },
          },
        },
        params: {},
      } as never);

      expect(result.initialSyncState?.status).toBe("failed");
    });

    it("returns failed when entries exist in DLQ", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id") && query.includes("defaultTermsDays")) {
          return Promise.resolve([{ id: TEST_SHOP_ID, defaultTermsDays: 30, onboardingDismissedAt: null }]);
        }
        if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
          return Promise.resolve([{ count: "0" }]);
        }
        if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
          return Promise.resolve([{ count: "0" }]);
        }
        if (query.includes("s6_bulk_operations")) {
          return Promise.resolve([]);
        }
        if (query.includes("s6_dead_letter")) {
          return Promise.resolve([{ count: "1" }]);
        }
        return Promise.resolve([]);
      });

      const { loader } = await import("../app.onboarding");

      const result = await loader({
        request: new Request("https://example.com/app/onboarding"),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
                admin: { graphql: mockGraphql },
              }),
            },
          },
        },
        params: {},
      } as never);

      expect(result.initialSyncState?.status).toBe("failed");
    });
  });

  describe("action start_sync", () => {
    it("enqueues sync when status is not_started", async () => {
      let enqueued = false;
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id FROM")) {
          return Promise.resolve([{ id: TEST_SHOP_ID }]);
        }
        if (query.includes("s6_bulk_operations") && query.includes("origin")) {
          return Promise.resolve([]);
        }
        if (query.includes("s6_dead_letter")) {
          return Promise.resolve([{ count: "0" }]);
        }
        if (query.includes("s6_processed_webhooks") && query.includes("webhook_id")) {
          return Promise.resolve([]);
        }
        if (query.includes("pgmq.q_s6_sync") && query.includes("webhookId")) {
          return Promise.resolve([]);
        }
        if (query.includes("pgmq.send")) {
          enqueued = true;
          return Promise.resolve([{ send: "1" }]);
        }
        return Promise.resolve([]);
      });

      const { action } = await import("../app.onboarding");

      const formData = new FormData();
      formData.set("_action", "start_sync");

      const result = await action({
        request: new Request("https://example.com/app/onboarding", {
          method: "POST",
          body: formData,
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
              }),
            },
          },
        },
        params: {},
      } as never);

      expect(result).not.toBeInstanceOf(Response);
      const data = result as { success: boolean; action: string; syncStatus: string };
      expect(data.success).toBe(true);
      expect(data.action).toBe("start_sync");
      expect(data.syncStatus).toBe("in_progress");
      expect(enqueued).toBe(true);
    });

    it("enqueues sync when status is failed", async () => {
      let enqueued = false;
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id FROM")) {
          return Promise.resolve([{ id: TEST_SHOP_ID }]);
        }
        if (query.includes("s6_bulk_operations") && query.includes("origin")) {
          return Promise.resolve([
            { reconcile_stage: "companies", completed_at: null, failure_count: 5 },
          ]);
        }
        if (query.includes("s6_dead_letter")) {
          return Promise.resolve([{ count: "0" }]);
        }
        if (query.includes("s6_processed_webhooks") && query.includes("webhook_id")) {
          return Promise.resolve([]);
        }
        if (query.includes("pgmq.q_s6_sync") && query.includes("webhookId")) {
          return Promise.resolve([]);
        }
        if (query.includes("pgmq.send")) {
          enqueued = true;
          return Promise.resolve([{ send: "1" }]);
        }
        return Promise.resolve([]);
      });

      const { action } = await import("../app.onboarding");

      const formData = new FormData();
      formData.set("_action", "start_sync");

      const result = await action({
        request: new Request("https://example.com/app/onboarding", {
          method: "POST",
          body: formData,
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
              }),
            },
          },
        },
        params: {},
      } as never);

      expect(result).not.toBeInstanceOf(Response);
      const data = result as { success: boolean; action: string };
      expect(data.success).toBe(true);
      expect(data.action).toBe("start_sync");
      expect(enqueued).toBe(true);
    });

    it("does not enqueue when status is in_progress", async () => {
      let enqueued = false;
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id FROM")) {
          return Promise.resolve([{ id: TEST_SHOP_ID }]);
        }
        if (query.includes("s6_bulk_operations") && query.includes("origin")) {
          return Promise.resolve([
            { reconcile_stage: "companies", completed_at: null, failure_count: 0 },
          ]);
        }
        if (query.includes("s6_dead_letter")) {
          return Promise.resolve([{ count: "0" }]);
        }
        if (query.includes("pgmq.send")) {
          enqueued = true;
          return Promise.resolve([{ send: "1" }]);
        }
        return Promise.resolve([]);
      });

      const { action } = await import("../app.onboarding");

      const formData = new FormData();
      formData.set("_action", "start_sync");

      const result = await action({
        request: new Request("https://example.com/app/onboarding", {
          method: "POST",
          body: formData,
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
              }),
            },
          },
        },
        params: {},
      } as never);

      expect(result).not.toBeInstanceOf(Response);
      const data = result as { success: boolean; error: string };
      expect(data.success).toBe(false);
      expect(data.error).toBe("Sync already in progress or complete");
      expect(enqueued).toBe(false);
    });

    it("does not enqueue when status is done", async () => {
      let enqueued = false;
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id FROM")) {
          return Promise.resolve([{ id: TEST_SHOP_ID }]);
        }
        if (query.includes("s6_bulk_operations") && query.includes("origin")) {
          return Promise.resolve([
            { reconcile_stage: "companies", completed_at: new Date(), failure_count: 0 },
            { reconcile_stage: "orders", completed_at: new Date(), failure_count: 0 },
          ]);
        }
        if (query.includes("s6_dead_letter")) {
          return Promise.resolve([{ count: "0" }]);
        }
        if (query.includes("pgmq.send")) {
          enqueued = true;
          return Promise.resolve([{ send: "1" }]);
        }
        return Promise.resolve([]);
      });

      const { action } = await import("../app.onboarding");

      const formData = new FormData();
      formData.set("_action", "start_sync");

      const result = await action({
        request: new Request("https://example.com/app/onboarding", {
          method: "POST",
          body: formData,
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
              }),
            },
          },
        },
        params: {},
      } as never);

      expect(result).not.toBeInstanceOf(Response);
      const data = result as { success: boolean; error: string };
      expect(data.success).toBe(false);
      expect(data.error).toBe("Sync already in progress or complete");
      expect(enqueued).toBe(false);
    });

    it("does not duplicate enqueue when already queued", async () => {
      let enqueueCount = 0;
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id FROM")) {
          return Promise.resolve([{ id: TEST_SHOP_ID }]);
        }
        if (query.includes("s6_bulk_operations") && query.includes("origin")) {
          return Promise.resolve([]);
        }
        if (query.includes("s6_dead_letter")) {
          return Promise.resolve([{ count: "0" }]);
        }
        if (query.includes("s6_processed_webhooks") && query.includes("webhook_id")) {
          return Promise.resolve([]);
        }
        if (query.includes("pgmq.q_s6_sync") && query.includes("webhookId")) {
          return Promise.resolve([{ msg_id: "123" }]);
        }
        if (query.includes("pgmq.send")) {
          enqueueCount++;
          return Promise.resolve([{ send: "1" }]);
        }
        return Promise.resolve([]);
      });

      const { action } = await import("../app.onboarding");

      const formData = new FormData();
      formData.set("_action", "start_sync");

      const result = await action({
        request: new Request("https://example.com/app/onboarding", {
          method: "POST",
          body: formData,
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
              }),
            },
          },
        },
        params: {},
      } as never);

      expect(result).not.toBeInstanceOf(Response);
      const data = result as { success: boolean; error: string };
      expect(data.success).toBe(false);
      expect(data.error).toContain("already queued");
      expect(enqueueCount).toBe(0);
    });

    it("returns 400 for empty JSON body {}", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id FROM")) {
          return Promise.resolve([{ id: TEST_SHOP_ID }]);
        }
        return Promise.resolve([]);
      });

      const { action } = await import("../app.onboarding");

      const result = await action({
        request: new Request("https://example.com/app/onboarding", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
              }),
            },
          },
        },
        params: {},
      } as never);

      expect(result).toBeInstanceOf(Response);
      const response = result as Response;
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Empty body");
    });

    it("returns 400 for empty string body", async () => {
      mockSql.mockImplementation(() => Promise.resolve([]));

      const { action } = await import("../app.onboarding");

      const result = await action({
        request: new Request("https://example.com/app/onboarding", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "",
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
              }),
            },
          },
        },
        params: {},
      } as never);

      expect(result).toBeInstanceOf(Response);
      const response = result as Response;
      expect(response.status).toBe(400);
    });

    it("start_sync logs use shopHash, not raw domain or ids", async () => {
      const consoleInfoSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id FROM")) {
          return Promise.resolve([{ id: TEST_SHOP_ID }]);
        }
        if (query.includes("s6_bulk_operations") && query.includes("origin")) {
          return Promise.resolve([]);
        }
        if (query.includes("s6_dead_letter")) {
          return Promise.resolve([{ count: "0" }]);
        }
        if (query.includes("s6_processed_webhooks") && query.includes("webhook_id")) {
          return Promise.resolve([]);
        }
        if (query.includes("pgmq.q_s6_sync") && query.includes("webhookId")) {
          return Promise.resolve([]);
        }
        if (query.includes("pgmq.send")) {
          return Promise.resolve([{ send: "1" }]);
        }
        return Promise.resolve([]);
      });

      const { action } = await import("../app.onboarding");

      const formData = new FormData();
      formData.set("_action", "start_sync");

      await action({
        request: new Request("https://example.com/app/onboarding", {
          method: "POST",
          body: formData,
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
              }),
            },
          },
        },
        params: {},
      } as never);

      const allLogs = consoleInfoSpy.mock.calls.map((c) => c.join(" ")).join("\n");

      expect(allLogs).toContain('"shopHash":');
      expect(allLogs).not.toContain(".myshopify.com");
      expect(allLogs).not.toContain(TEST_SHOP);
      expect(allLogs).not.toContain(TEST_SHOP_ID);

      consoleInfoSpy.mockRestore();
    });
  });
});

describe("P6: error logging uses safeLog JSON (no raw errors)", () => {
  const TEST_SHOP = "test-onboard-log.myshopify.com";
  const TEST_SHOP_ID = "shop-log-test";

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureValidation.mockReset();
    mockEnsurePaymentCustomization.mockReset();
    mockEnsureMetafieldDefinitions.mockReset();
  });

  it("fetchValidationInfo logs safeLog JSON with error code, not raw error", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const mockGraphql = vi.fn().mockRejectedValue(new Error("GraphQL network error"));

    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT id") && query.includes("defaultTermsDays")) {
        return Promise.resolve([{ id: TEST_SHOP_ID, defaultTermsDays: 30, onboardingDismissedAt: null }]);
      }
      if (query.includes("COUNT(*)")) {
        return Promise.resolve([{ count: "0" }]);
      }
      return Promise.resolve([]);
    });

    const { loader } = await import("../app.onboarding");

    await loader({
      request: new Request("https://example.com/app/onboarding"),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP },
              admin: { graphql: mockGraphql },
            }),
          },
        },
      },
      params: {},
    } as never);

    const allLogs = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allLogs).toContain('"event":"onboarding.fetch_validations_failed"');
    expect(allLogs).toContain('"err":');
    expect(allLogs).not.toContain("GraphQL network error");
    expect(allLogs).not.toContain(".myshopify.com");

    consoleSpy.mockRestore();
  });

  it("S23-02: retry action logs use shopHash, not raw domain or ids", async () => {
    const consoleInfoSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT id FROM")) {
        return Promise.resolve([{ id: TEST_SHOP_ID }]);
      }
      return Promise.resolve([]);
    });

    mockEnsureValidation.mockResolvedValue({ id: "gid://shopify/Validation/123", created: true });

    const { action } = await import("../app.onboarding");

    const currentStatus = {
      validation: { name: "Validation Function", status: "missing" },
      paymentCustomization: { name: "Payment Customization", status: "ok" },
      metafieldDefinitions: { name: "Metafield Definitions", status: "ok" },
    };

    const formData = new FormData();
    formData.set("_action", "retry_registration");
    formData.set("currentStatus", JSON.stringify(currentStatus));

    const mockGraphql = vi.fn();

    await action({
      request: new Request("https://example.com/app/onboarding", {
        method: "POST",
        body: formData,
      }),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP },
              admin: { graphql: mockGraphql },
            }),
          },
        },
      },
      params: {},
    } as unknown as ActionFunctionArgs);

    const allInfoLogs = consoleInfoSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    const allErrorLogs = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    const allLogs = allInfoLogs + allErrorLogs;

    expect(allLogs).toContain('"shopHash":');
    expect(allLogs).not.toContain(".myshopify.com");
    expect(allLogs).not.toContain(TEST_SHOP);
    expect(allLogs).not.toContain(TEST_SHOP_ID);

    consoleInfoSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});

describe("app._index redirect", () => {
  const TEST_SHOP = "test-shop.myshopify.com";
  const TEST_SHOP_ID = "shop-123";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not redirect when skipOnboarding=true is set (prevents redirect loop)", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT id, currency, timezone FROM")) {
        return Promise.resolve([
          { id: TEST_SHOP_ID, currency: "INR", timezone: "Asia/Kolkata" },
        ]);
      }
      if (query.includes("onboarding_dismissed_at")) {
        return Promise.resolve([{ onboarding_dismissed_at: null }]);
      }
      if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
        return Promise.resolve([{ count: "0" }]);
      }
      if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
        return Promise.resolve([{ count: "0" }]);
      }
      return Promise.resolve([]);
    });

    const { loader } = await import("../app._index");

    const result = await loader({
      request: new Request("https://example.com/app?skipOnboarding=true"),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP },
              redirect: vi.fn((url: string) => {
                throw new Response(null, { status: 302, headers: { Location: url } });
              }),
            }),
          },
        },
      },
      params: {},
    } as unknown as LoaderFunctionArgs);

    expect(result.shopDomain).toBe(TEST_SHOP);
  });

  it("redirects to onboarding when skipOnboarding is NOT set and conditions match", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT id, currency, timezone FROM")) {
        return Promise.resolve([
          { id: TEST_SHOP_ID, currency: "INR", timezone: "Asia/Kolkata" },
        ]);
      }
      if (query.includes("onboarding_dismissed_at")) {
        return Promise.resolve([{ onboarding_dismissed_at: null }]);
      }
      if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
        return Promise.resolve([{ count: "0" }]);
      }
      if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
        return Promise.resolve([{ count: "0" }]);
      }
      return Promise.resolve([]);
    });

    const { loader } = await import("../app._index");

    const mockRedirect = vi.fn((url: string) => {
      throw new Response(null, { status: 302, headers: { Location: url } });
    });

    await expect(
      loader({
        request: new Request("https://example.com/app"),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
                redirect: mockRedirect,
              }),
            },
          },
        },
        params: {},
      } as unknown as LoaderFunctionArgs)
    ).rejects.toThrow();

    expect(mockRedirect).toHaveBeenCalledWith("/app/onboarding");
  });

  it("does not redirect when onboarding is dismissed", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT id, currency, timezone FROM")) {
        return Promise.resolve([
          { id: TEST_SHOP_ID, currency: "INR", timezone: "Asia/Kolkata" },
        ]);
      }
      if (query.includes("onboarding_dismissed_at")) {
        return Promise.resolve([{ onboarding_dismissed_at: new Date() }]);
      }
      if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
        return Promise.resolve([{ count: "0" }]);
      }
      if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
        return Promise.resolve([{ count: "0" }]);
      }
      return Promise.resolve([]);
    });

    const { loader } = await import("../app._index");

    const result = await loader({
      request: new Request("https://example.com/app"),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP },
              redirect: vi.fn((url: string) => {
                throw new Response(null, { status: 302, headers: { Location: url } });
              }),
            }),
          },
        },
      },
      params: {},
    } as unknown as LoaderFunctionArgs);

    expect(result.shopDomain).toBe(TEST_SHOP);
  });

  it("does not redirect when buyer accounts exist", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT id, currency, timezone FROM")) {
        return Promise.resolve([
          { id: TEST_SHOP_ID, currency: "INR", timezone: "Asia/Kolkata" },
        ]);
      }
      if (query.includes("onboarding_dismissed_at")) {
        return Promise.resolve([{ onboarding_dismissed_at: null }]);
      }
      if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
        return Promise.resolve([{ count: "5" }]);
      }
      if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
        return Promise.resolve([{ count: "0" }]);
      }
      return Promise.resolve([]);
    });

    const { loader } = await import("../app._index");

    const result = await loader({
      request: new Request("https://example.com/app"),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP },
              redirect: vi.fn((url: string) => {
                throw new Response(null, { status: 302, headers: { Location: url } });
              }),
            }),
          },
        },
      },
      params: {},
    } as unknown as LoaderFunctionArgs);

    expect(result.shopDomain).toBe(TEST_SHOP);
  });
});
