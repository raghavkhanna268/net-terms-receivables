/**
 * Unit tests for seed.ts mutation result helper and failure accounting.
 *
 * Tests the checkMutationResult helper and computeExitCode function to ensure
 * proper failure detection and exit code behavior for GraphQL mutations.
 *
 * Run: npm test -- tests/unit/seed-mutation-helper.test.ts
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  checkMutationResult,
  computeExitCode,
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

describe("failure accounting scenarios", () => {
  let state: SeedState;

  beforeEach(() => {
    state = createEmptyState();
  });

  describe("tagged customer path simulation", () => {
    it("should track failure when GraphQL returns undefinedField error", () => {
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

      const check = checkMutationResult(response, undefined, null);
      expect(check.ok).toBe(false);

      if (!check.ok) {
        state.errors.push("Failed to ensure tagged customer for Net 15");
      }

      expect(state.errors.length).toBe(1);
      expect(computeExitCode(state)).toBe(1);
    });

    it("should track order failure when customer is missing", () => {
      const customerMap = new Map<number, string>();

      const orderSpec = { customerTermsDays: 15 };
      const customerId = customerMap.get(orderSpec.customerTermsDays);

      if (!customerId) {
        state.failedCount.orders++;
        state.errors.push("No customer found for tagged order 1");
      }

      expect(state.failedCount.orders).toBe(1);
      expect(state.errors.length).toBe(1);
      expect(computeExitCode(state)).toBe(1);
    });

    it("happy path: successful mutation returns ok=true and exit code 0", () => {
      const response: GraphQLResponse<{ customerCreate: { customer: { id: string }; userErrors: UserError[] } }> = {
        data: {
          customerCreate: {
            customer: { id: "gid://shopify/Customer/123" },
            userErrors: [],
          },
        },
      };

      const check = checkMutationResult(
        response,
        response.data?.customerCreate.userErrors,
        response.data?.customerCreate.customer
      );

      expect(check.ok).toBe(true);
      expect(check.data).toEqual({ id: "gid://shopify/Customer/123" });

      state.createdCount.orders = 3;
      state.unchangedCount.orders = 2;

      expect(computeExitCode(state)).toBe(0);
    });
  });

  describe("summary output validation", () => {
    it("total failures calculation is correct", () => {
      state.failedCount.companies = 1;
      state.failedCount.locations = 2;
      state.failedCount.orders = 3;
      state.failedCount.roleAssignments = 1;
      state.failedCount.dbRows = 1;

      const totalFailures =
        state.failedCount.companies +
        state.failedCount.locations +
        state.failedCount.orders +
        state.failedCount.roleAssignments +
        state.failedCount.dbRows;

      expect(totalFailures).toBe(8);
      expect(computeExitCode(state)).toBe(1);
    });

    it("Failed 0 when all mutations succeed", () => {
      state.createdCount.companies = 5;
      state.createdCount.locations = 15;
      state.createdCount.orders = 20;

      const totalFailures =
        state.failedCount.companies +
        state.failedCount.locations +
        state.failedCount.orders +
        state.failedCount.roleAssignments +
        state.failedCount.dbRows;

      expect(totalFailures).toBe(0);
      expect(computeExitCode(state)).toBe(0);
    });
  });
});
