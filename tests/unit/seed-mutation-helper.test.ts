/**
 * Unit tests for seed.ts mutation result helper and failure accounting.
 *
 * Tests the checkMutationResult helper and computeExitCode function to ensure
 * proper failure detection and exit code behavior for GraphQL mutations.
 *
 * Also tests the real ensureTaggedCustomer path with mocked fetch to verify
 * that GraphQL errors propagate to failure accounting and non-zero exit code.
 *
 * Run: npm test -- tests/unit/seed-mutation-helper.test.ts
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  checkMutationResult,
  computeExitCode,
  ensureTaggedCustomer,
  seedTaggedCustomerOrders,
  type GraphQLResponse,
  type UserError,
  type SeedState,
} from "../../scripts/seed";

function createEmptyState(): SeedState {
  return {
    shop: "test.myshopify.com",
    token: "test-token",
    databaseUrl: null,
    dryRun: false,
    reset: false,
    resetApply: false,
    reportDuplicates: false,
    reviewerDemo: false,
    currencyCode: "INR",
    companies: new Map(),
    paymentTermsTemplates: [],
    createdCount: { companies: 0, locations: 0, orders: 0, roleAssignments: 0, dbRules: 0, dbAccounts: 0 },
    unchangedCount: { companies: 0, locations: 0, orders: 0, roleAssignments: 0 },
    adoptedCount: { companies: 0 },
    driftedCount: { companies: 0 },
    skippedCount: { companies: 0, orders: 0, roleAssignments: 0 },
    skippedReasons: [],
    deletedCount: { companies: 0, orders: 0 },
    failedCount: { companies: 0, locations: 0, orders: 0, roleAssignments: 0, dbRows: 0 },
    ordersWithShopifyTerms: 0,
    ordersWithoutShopifyTerms: 0,
    overdueOrdersCount: 0,
    taggedCustomerOrdersCount: 0,
    errors: [],
  };
}

describe("checkMutationResult", () => {
  it("returns ok=true for successful mutation with result", () => {
    const response: GraphQLResponse<{ test: { data: string } }> = {
      data: { test: { data: "success" } },
    };
    const userErrors: UserError[] = [];
    const result = { data: "success" };

    const check = checkMutationResult(response, userErrors, result);

    expect(check.ok).toBe(true);
    expect(check.data).toEqual(result);
    expect(check.failureReason).toBeNull();
  });

  it("returns ok=false with graphql_errors for top-level errors (undefinedField)", () => {
    const response: GraphQLResponse<unknown> = {
      data: null,
      errors: [
        {
          message: "Field 'code' doesn't exist on type 'UserError'",
          path: ["customerCreate", "userErrors", "code"],
          extensions: { code: "undefinedField" },
        },
      ],
    };
    const userErrors: UserError[] = [];
    const result = null;

    const check = checkMutationResult(response, userErrors, result);

    expect(check.ok).toBe(false);
    expect(check.data).toBeNull();
    expect(check.failureReason).toBe("graphql_errors");
  });

  it("returns ok=false with user_errors for non-empty userErrors", () => {
    const response: GraphQLResponse<{ customerCreate: { customer: null; userErrors: UserError[] } }> = {
      data: {
        customerCreate: {
          customer: null,
          userErrors: [{ field: ["email"], message: "Email has already been taken" }],
        },
      },
    };
    const userErrors: UserError[] = [{ field: ["email"], message: "Email has already been taken" }];
    const result = null;

    const check = checkMutationResult(response, userErrors, result);

    expect(check.ok).toBe(false);
    expect(check.data).toBeNull();
    expect(check.failureReason).toBe("user_errors");
  });

  it("returns ok=false with null_result for null result object", () => {
    const response: GraphQLResponse<{ customerCreate: { customer: null; userErrors: UserError[] } }> = {
      data: {
        customerCreate: {
          customer: null,
          userErrors: [],
        },
      },
    };
    const userErrors: UserError[] = [];
    const result = null;

    const check = checkMutationResult(response, userErrors, result);

    expect(check.ok).toBe(false);
    expect(check.data).toBeNull();
    expect(check.failureReason).toBe("null_result");
  });

  it("returns ok=false with null_result for undefined result object", () => {
    const response: GraphQLResponse<{ customerCreate: { userErrors: UserError[] } }> = {
      data: {
        customerCreate: {
          userErrors: [],
        },
      },
    };
    const userErrors: UserError[] = [];
    const result = undefined;

    const check = checkMutationResult(response, userErrors, result);

    expect(check.ok).toBe(false);
    expect(check.data).toBeNull();
    expect(check.failureReason).toBe("null_result");
  });

  it("prioritizes graphql_errors over user_errors", () => {
    const response: GraphQLResponse<unknown> = {
      data: null,
      errors: [{ message: "Internal error" }],
    };
    const userErrors: UserError[] = [{ field: null, message: "Some error" }];
    const result = null;

    const check = checkMutationResult(response, userErrors, result);

    expect(check.ok).toBe(false);
    expect(check.failureReason).toBe("graphql_errors");
  });

  it("prioritizes user_errors over null_result", () => {
    const response: GraphQLResponse<unknown> = {
      data: { mutation: { result: null, userErrors: [{ field: null, message: "Error" }] } },
    };
    const userErrors: UserError[] = [{ field: null, message: "Error" }];
    const result = null;

    const check = checkMutationResult(response, userErrors, result);

    expect(check.ok).toBe(false);
    expect(check.failureReason).toBe("user_errors");
  });
});

describe("computeExitCode", () => {
  let state: SeedState;

  beforeEach(() => {
    state = createEmptyState();
  });

  it("returns 0 when no failures or errors", () => {
    expect(computeExitCode(state)).toBe(0);
  });

  it("returns 1 when companies failed", () => {
    state.failedCount.companies = 1;
    expect(computeExitCode(state)).toBe(1);
  });

  it("returns 1 when locations failed", () => {
    state.failedCount.locations = 1;
    expect(computeExitCode(state)).toBe(1);
  });

  it("returns 1 when orders failed", () => {
    state.failedCount.orders = 1;
    expect(computeExitCode(state)).toBe(1);
  });

  it("returns 1 when roleAssignments failed", () => {
    state.failedCount.roleAssignments = 1;
    expect(computeExitCode(state)).toBe(1);
  });

  it("returns 1 when dbRows failed", () => {
    state.failedCount.dbRows = 1;
    expect(computeExitCode(state)).toBe(1);
  });

  it("returns 1 when errors array has entries", () => {
    state.errors.push("Failed to ensure tagged customer for Net 15");
    expect(computeExitCode(state)).toBe(1);
  });

  it("returns 1 when multiple failures exist", () => {
    state.failedCount.companies = 2;
    state.failedCount.orders = 3;
    state.errors.push("Error 1", "Error 2");
    expect(computeExitCode(state)).toBe(1);
  });

  it("returns 0 when only created/unchanged counts are positive", () => {
    state.createdCount.companies = 5;
    state.createdCount.orders = 10;
    state.unchangedCount.companies = 2;
    expect(computeExitCode(state)).toBe(0);
  });
});


describe("ensureTaggedCustomer integration with mocked fetch", () => {
  let state: SeedState;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    state = createEmptyState();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns null when customerCreate returns top-level GraphQL errors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: null,
        errors: [
          {
            message: "Field 'code' doesn't exist on type 'UserError'",
            path: ["customerCreate", "userErrors", "code"],
            extensions: { code: "undefinedField" },
          },
        ],
      }),
    });

    const result = await ensureTaggedCustomer(state, "test@example.com", 15);

    expect(result).toBeNull();
  });

  it("returns null when customerCreate returns userErrors", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            customers: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            customerCreate: {
              customer: null,
              userErrors: [{ field: ["email"], message: "Email is invalid" }],
            },
          },
        }),
      });

    const result = await ensureTaggedCustomer(state, "invalid@example.com", 15);

    expect(result).toBeNull();
  });

  it("returns null when tagsAdd returns top-level GraphQL errors", async () => {
    const customerId = "gid://shopify/Customer/123456";
    
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            customers: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            customerCreate: {
              customer: { id: customerId },
              userErrors: [],
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: null,
          errors: [{ message: "Internal server error" }],
        }),
      });

    const result = await ensureTaggedCustomer(state, "test@example.com", 15);

    expect(result).toBeNull();
  });

  it("returns null when tagsAdd returns userErrors", async () => {
    const customerId = "gid://shopify/Customer/123456";
    
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            customers: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            customerCreate: {
              customer: { id: customerId },
              userErrors: [],
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            tagsAdd: {
              node: null,
              userErrors: [{ field: ["tags"], message: "Invalid tag format" }],
            },
          },
        }),
      });

    const result = await ensureTaggedCustomer(state, "test@example.com", 15);

    expect(result).toBeNull();
  });

  it("returns null when tagsAdd returns null node", async () => {
    const customerId = "gid://shopify/Customer/123456";
    
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            customers: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            customerCreate: {
              customer: { id: customerId },
              userErrors: [],
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            tagsAdd: {
              node: null,
              userErrors: [],
            },
          },
        }),
      });

    const result = await ensureTaggedCustomer(state, "test@example.com", 15);

    expect(result).toBeNull();
  });

  it("returns customer ID on successful creation and tagging", async () => {
    const customerId = "gid://shopify/Customer/123456";
    
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            customers: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            customerCreate: {
              customer: { id: customerId },
              userErrors: [],
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            tagsAdd: {
              node: { id: customerId },
              userErrors: [],
            },
          },
        }),
      });

    const result = await ensureTaggedCustomer(state, "test@example.com", 15);

    expect(result).toBe(customerId);
  });
});

describe("seedTaggedCustomerOrders integration with mocked fetch", () => {
  let state: SeedState;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    state = createEmptyState();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function createQueryDetectingMock(options: {
    customerCreateResponse?: () => unknown;
    tagsAddResponse?: () => unknown;
  }) {
    const customerId = "gid://shopify/Customer/123456";
    
    return vi.fn().mockImplementation(async (_url: string, init: { body?: string }) => {
      const body = init?.body ?? "";
      
      if (body.includes("customers(") || body.includes("customers {")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              customers: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          }),
        };
      }
      
      if (body.includes("orders(") || body.includes("orders {")) {
        return {
          ok: true,
          json: async () => ({
            data: {
              orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          }),
        };
      }
      
      if (body.includes("customerCreate")) {
        if (options.customerCreateResponse) {
          return { ok: true, json: options.customerCreateResponse };
        }
        return {
          ok: true,
          json: async () => ({
            data: {
              customerCreate: {
                customer: { id: customerId },
                userErrors: [],
              },
            },
          }),
        };
      }
      
      if (body.includes("tagsAdd")) {
        if (options.tagsAddResponse) {
          return { ok: true, json: options.tagsAddResponse };
        }
        return {
          ok: true,
          json: async () => ({
            data: {
              tagsAdd: {
                node: { id: customerId },
                userErrors: [],
              },
            },
          }),
        };
      }
      
      return { ok: true, json: async () => ({ data: null }) };
    });
  }

  it("tracks failures and exit code 1 when customerCreate returns top-level GraphQL errors", async () => {
    globalThis.fetch = createQueryDetectingMock({
      customerCreateResponse: async () => ({
        data: null,
        errors: [
          {
            message: "Field 'code' doesn't exist on type 'UserError'",
            path: ["customerCreate", "userErrors", "code"],
            extensions: { code: "undefinedField" },
          },
        ],
      }),
    });

    await seedTaggedCustomerOrders(state);

    expect(state.errors.length).toBeGreaterThan(0);
    expect(state.errors.some(e => e.includes("Failed to ensure tagged customer"))).toBe(true);
    expect(state.failedCount.orders).toBeGreaterThan(0);
    expect(computeExitCode(state)).toBe(1);
  });

  it("tracks failures and exit code 1 when customerCreate returns userErrors", async () => {
    globalThis.fetch = createQueryDetectingMock({
      customerCreateResponse: async () => ({
        data: {
          customerCreate: {
            customer: null,
            userErrors: [{ field: ["email"], message: "Email is invalid" }],
          },
        },
      }),
    });

    await seedTaggedCustomerOrders(state);

    expect(state.errors.length).toBeGreaterThan(0);
    expect(state.errors.some(e => e.includes("Failed to ensure tagged customer"))).toBe(true);
    expect(state.failedCount.orders).toBeGreaterThan(0);
    expect(computeExitCode(state)).toBe(1);
  });

  it("tracks failures and exit code 1 when tagsAdd returns top-level GraphQL errors", async () => {
    globalThis.fetch = createQueryDetectingMock({
      tagsAddResponse: async () => ({
        data: null,
        errors: [{ message: "Internal server error" }],
      }),
    });

    await seedTaggedCustomerOrders(state);

    expect(state.errors.length).toBeGreaterThan(0);
    expect(state.errors.some(e => e.includes("Failed to ensure tagged customer"))).toBe(true);
    expect(state.failedCount.orders).toBeGreaterThan(0);
    expect(computeExitCode(state)).toBe(1);
  });

  it("tracks failures and exit code 1 when tagsAdd returns userErrors", async () => {
    globalThis.fetch = createQueryDetectingMock({
      tagsAddResponse: async () => ({
        data: {
          tagsAdd: {
            node: null,
            userErrors: [{ field: ["tags"], message: "Invalid tag" }],
          },
        },
      }),
    });

    await seedTaggedCustomerOrders(state);

    expect(state.errors.length).toBeGreaterThan(0);
    expect(state.errors.some(e => e.includes("Failed to ensure tagged customer"))).toBe(true);
    expect(state.failedCount.orders).toBeGreaterThan(0);
    expect(computeExitCode(state)).toBe(1);
  });
});

describe("seed module import safety", () => {
  it("importing scripts/seed does not trigger main()", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    await expect(import("../../scripts/seed")).resolves.toBeDefined();

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("exports main() function but does not auto-execute it", async () => {
    const seed = await import("../../scripts/seed");
    
    expect(typeof seed.main).toBe("function");
    expect(typeof seed.ensureTaggedCustomer).toBe("function");
    expect(typeof seed.seedTaggedCustomerOrders).toBe("function");
    expect(typeof seed.checkMutationResult).toBe("function");
    expect(typeof seed.computeExitCode).toBe("function");
  });
});
