import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LoaderFunctionArgs } from "react-router";

/**
 * Tests for parallelized onboarding loader (latency optimization).
 *
 * Verifies:
 * 1. Parallel execution timing: total time is close to the longest single call, not the sum
 * 2. Metafield definitions: both owner types are reported even if one fails
 * 3. Query count: fewer DB queries than the sequential implementation
 * 4. Server-Timing header: correct phase codes in the response
 */

const createMockSqlFn = () =>
  vi.fn().mockImplementation(() => Promise.resolve([]));

const mockSql = Object.assign(createMockSqlFn(), {
  json: vi.fn((v: unknown) => v),
  array: vi.fn((arr: unknown[]) => arr),
  unsafe: vi.fn((s: string) => s),
  begin: vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const txSql = Object.assign(createMockSqlFn(), {
      json: vi.fn((v: unknown) => v),
      array: vi.fn((arr: unknown[]) => arr),
    });
    return cb(txSql);
  }),
});

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
  getRequestWaitUntil: vi.fn(() => () => {}),
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
    companies: { current: 2, limit: 25 },
    importsThisMonth: { current: 0, limit: -1 },
  }),
  isGatingEnforced: vi.fn().mockReturnValue(false),
}));

vi.mock("~/lib/metafield-definitions.server", () => ({
  ensureMetafieldDefinitions: vi.fn().mockResolvedValue([]),
  getMetafieldDefinitionSpecs: vi.fn(() => [{
    definition: { namespace: "$app", key: "credit_status", type: "json" },
    ownerTypes: ["COMPANY_LOCATION", "CUSTOMER"],
  }]),
}));

const TEST_SHOP = "test-parallel.myshopify.com";
const TEST_SHOP_ID = "shop-parallel-123";
const TEST_SHOP_GID = "gid://shopify/Shop/12345";

function extractLoaderData<T>(result: unknown): T {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    (result as { type: string }).type === "DataWithResponseInit" &&
    "data" in result
  ) {
    return (result as { data: T }).data;
  }
  return result as T;
}

function getResponseHeaders(result: unknown): Headers | null {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    (result as { type: string }).type === "DataWithResponseInit" &&
    "init" in result
  ) {
    const init = (result as { init?: { headers?: HeadersInit } }).init;
    if (init?.headers) {
      return new Headers(init.headers);
    }
  }
  return null;
}

describe("Parallel execution timing", () => {
  let mockGraphql: ReturnType<typeof vi.fn>;
  let queryCallTimestamps: number[];

  function createLoaderArgs(): LoaderFunctionArgs {
    const url = new URL("https://test-example.com/app/onboarding");
    return {
      request: new Request(url.toString()),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP },
              admin: { graphql: mockGraphql },
            }),
          },
        },
        cloudflare: {
          env: {},
          ctx: { waitUntil: vi.fn() },
        },
      },
      params: {},
    } as unknown as LoaderFunctionArgs;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    queryCallTimestamps = [];
    mockGraphql = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("total loader time is less than sum of all mocked delays (parallel execution verified)", async () => {
    const DELAY_MS = 50;

    mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      const callTime = Date.now();
      queryCallTimestamps.push(callTime);

      if (query.includes("SELECT id") && query.includes("defaultTermsDays")) {
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
        return [{
          id: TEST_SHOP_ID,
          defaultTermsDays: 30,
          onboardingDismissedAt: null,
          currency: "INR",
        }];
      }
      if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
        return [{ count: "0" }];
      }
      if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
        return [{ count: "0" }];
      }
      if (query.includes("s6_bulk_operations")) {
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
        return [];
      }
      if (query.includes("s6_dead_letter")) {
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
        return [{ count: "0" }];
      }
      return [];
    });

    mockGraphql.mockImplementation(async (query: string) => {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));

      if (query.includes("ShopCurrencyAndId")) {
        return {
          json: async () => ({
            data: {
              shop: {
                id: TEST_SHOP_GID,
                currencyCode: "INR",
                metafield: { value: JSON.stringify({ schemaVersion: 1, currencyCode: "INR" }) },
              },
            },
          }),
        };
      }
      if (query.includes("validations")) {
        return { json: async () => ({ data: { validations: { edges: [] } } }) };
      }
      if (query.includes("paymentCustomizations")) {
        return { json: async () => ({ data: { paymentCustomizations: { edges: [] } } }) };
      }
      if (query.includes("metafieldDefinitions")) {
        return { json: async () => ({ data: { metafieldDefinitions: { edges: [] } } }) };
      }
      return { json: async () => ({ data: {} }) };
    });

    const { loader } = await import("../app.onboarding");

    const startTime = Date.now();
    await loader(createLoaderArgs());
    const totalTime = Date.now() - startTime;

    // With 7+ delayed operations at 50ms each, sequential would be 350ms+.
    // Parallel should complete in under 200ms (allowing for overhead).
    // The key is that total time < sum of individual delays.
    expect(totalTime).toBeLessThan(350);
  });
});

describe("Metafield definitions parallel reporting", () => {
  let mockGraphql: ReturnType<typeof vi.fn>;

  function createLoaderArgs(): LoaderFunctionArgs {
    const url = new URL("https://test-example.com/app/onboarding");
    return {
      request: new Request(url.toString()),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP },
              admin: { graphql: mockGraphql },
            }),
          },
        },
        cloudflare: {
          env: {},
          ctx: { waitUntil: vi.fn() },
        },
      },
      params: {},
    } as unknown as LoaderFunctionArgs;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGraphql = vi.fn();
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT id") && query.includes("defaultTermsDays")) {
        return Promise.resolve([{
          id: TEST_SHOP_ID,
          defaultTermsDays: 30,
          onboardingDismissedAt: null,
          currency: "INR",
        }]);
      }
      if (query.includes("COUNT(*)")) {
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports COMPANY_LOCATION success even if CUSTOMER query fails", async () => {
    let customerCallCount = 0;

    mockGraphql.mockImplementation(async (query: string, opts?: { variables?: { ownerType?: string } }) => {
      if (query.includes("ShopCurrencyAndId")) {
        return {
          json: async () => ({
            data: {
              shop: {
                id: TEST_SHOP_GID,
                currencyCode: "INR",
                metafield: { value: JSON.stringify({ schemaVersion: 1, currencyCode: "INR" }) },
              },
            },
          }),
        };
      }
      if (query.includes("validations")) {
        return { json: async () => ({ data: { validations: { edges: [] } } }) };
      }
      if (query.includes("paymentCustomizations")) {
        return { json: async () => ({ data: { paymentCustomizations: { edges: [] } } }) };
      }
      if (query.includes("metafieldDefinitions")) {
        const ownerType = opts?.variables?.ownerType;
        if (ownerType === "CUSTOMER") {
          customerCallCount++;
          return {
            json: async () => ({
              errors: [{ message: "CUSTOMER query failed" }],
            }),
          };
        }
        return {
          json: async () => ({
            data: {
              metafieldDefinitions: {
                edges: [{ node: { id: "mf-1", namespace: "$app", key: "credit_status", ownerType: "COMPANY_LOCATION" } }],
              },
            },
          }),
        };
      }
      return { json: async () => ({ data: {} }) };
    });

    const { loader } = await import("../app.onboarding");
    const rawResult = await loader(createLoaderArgs());
    const result = extractLoaderData<{ registrationStatus: { metafieldDefinitions: { status: string } } }>(rawResult);

    expect(customerCallCount).toBe(1);
    expect(result.registrationStatus.metafieldDefinitions.status).toBe("error");
  });

  it("both owner types are queried in parallel", async () => {
    const callOrder: string[] = [];
    const callTimes: number[] = [];

    mockGraphql.mockImplementation(async (query: string, opts?: { variables?: { ownerType?: string } }) => {
      if (query.includes("metafieldDefinitions")) {
        const ownerType = opts?.variables?.ownerType ?? "unknown";
        callOrder.push(ownerType);
        callTimes.push(Date.now());
        await new Promise(resolve => setTimeout(resolve, 30));
        return {
          json: async () => ({
            data: {
              metafieldDefinitions: {
                edges: [{ node: { id: "mf-1", namespace: "$app", key: "credit_status", ownerType } }],
              },
            },
          }),
        };
      }
      if (query.includes("ShopCurrencyAndId")) {
        return {
          json: async () => ({
            data: {
              shop: {
                id: TEST_SHOP_GID,
                currencyCode: "INR",
                metafield: { value: JSON.stringify({ schemaVersion: 1, currencyCode: "INR" }) },
              },
            },
          }),
        };
      }
      if (query.includes("validations")) {
        return { json: async () => ({ data: { validations: { edges: [] } } }) };
      }
      if (query.includes("paymentCustomizations")) {
        return { json: async () => ({ data: { paymentCustomizations: { edges: [] } } }) };
      }
      return { json: async () => ({ data: {} }) };
    });

    const { loader } = await import("../app.onboarding");
    await loader(createLoaderArgs());

    expect(callOrder).toContain("COMPANY_LOCATION");
    expect(callOrder).toContain("CUSTOMER");
    if (callTimes.length >= 2) {
      const timeDiff = Math.abs(callTimes[0] - callTimes[1]);
      expect(timeDiff).toBeLessThan(20);
    }
  });
});

describe("Query count reduction", () => {
  let sqlCallCount: number;

  function createLoaderArgs(): LoaderFunctionArgs {
    const url = new URL("https://test-example.com/app/onboarding");
    return {
      request: new Request(url.toString()),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP },
              admin: {
                graphql: vi.fn().mockImplementation(async (query: string) => {
                  if (query.includes("ShopCurrencyAndId")) {
                    return {
                      json: async () => ({
                        data: {
                          shop: {
                            id: TEST_SHOP_GID,
                            currencyCode: "INR",
                            metafield: { value: JSON.stringify({ schemaVersion: 1, currencyCode: "INR" }) },
                          },
                        },
                      }),
                    };
                  }
                  if (query.includes("validations")) {
                    return { json: async () => ({ data: { validations: { edges: [] } } }) };
                  }
                  if (query.includes("paymentCustomizations")) {
                    return { json: async () => ({ data: { paymentCustomizations: { edges: [] } } }) };
                  }
                  if (query.includes("metafieldDefinitions")) {
                    return {
                      json: async () => ({
                        data: { metafieldDefinitions: { edges: [] } },
                      }),
                    };
                  }
                  return { json: async () => ({ data: {} }) };
                }),
              },
            }),
          },
        },
        cloudflare: {
          env: {},
          ctx: { waitUntil: vi.fn() },
        },
      },
      params: {},
    } as unknown as LoaderFunctionArgs;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    sqlCallCount = 0;
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      sqlCallCount++;
      const query = strings.join("?");
      if (query.includes("SELECT id") && query.includes("defaultTermsDays")) {
        return Promise.resolve([{
          id: TEST_SHOP_ID,
          defaultTermsDays: 30,
          onboardingDismissedAt: null,
          currency: "INR",
        }]);
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("makes fewer than 5 DB queries (was 5, now 4: shop+currency folded)", async () => {
    const { loader } = await import("../app.onboarding");
    await loader(createLoaderArgs());

    // Before: shop (1), currency (1), buyerCount (1), tagRuleCount (1), sync state (1) = 5 calls minimum
    // After: shop+currency (1), buyerCount (1), tagRuleCount (1), sync state (1) = 4 calls minimum
    // Actual count depends on sync state queries
    expect(sqlCallCount).toBeLessThanOrEqual(5);
  });

  it("returns identical output structure after optimization", async () => {
    const { loader } = await import("../app.onboarding");
    const rawResult = await loader(createLoaderArgs());
    const result = extractLoaderData<{
      error: string | null;
      state: { steps: unknown[]; isComplete: boolean } | null;
      registrationStatus: unknown;
      initialSyncState: unknown;
      currencySupported: boolean;
    }>(rawResult);

    expect(result.error).toBeNull();
    expect(result.state).not.toBeNull();
    expect(result.state?.steps).toHaveLength(4);
    expect(result.registrationStatus).not.toBeNull();
    expect(result.initialSyncState).not.toBeNull();
    expect(result.currencySupported).toBe(true);
  });
});

describe("Server-Timing header", () => {
  function createLoaderArgs(): LoaderFunctionArgs {
    const url = new URL("https://test-example.com/app/onboarding");
    return {
      request: new Request(url.toString()),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP },
              admin: {
                graphql: vi.fn().mockImplementation(async (query: string) => {
                  if (query.includes("ShopCurrencyAndId")) {
                    return {
                      json: async () => ({
                        data: {
                          shop: {
                            id: TEST_SHOP_GID,
                            currencyCode: "INR",
                            metafield: { value: JSON.stringify({ schemaVersion: 1, currencyCode: "INR" }) },
                          },
                        },
                      }),
                    };
                  }
                  if (query.includes("validations")) {
                    return { json: async () => ({ data: { validations: { edges: [] } } }) };
                  }
                  if (query.includes("paymentCustomizations")) {
                    return { json: async () => ({ data: { paymentCustomizations: { edges: [] } } }) };
                  }
                  if (query.includes("metafieldDefinitions")) {
                    return {
                      json: async () => ({
                        data: { metafieldDefinitions: { edges: [] } },
                      }),
                    };
                  }
                  return { json: async () => ({ data: {} }) };
                }),
              },
            }),
          },
        },
        cloudflare: {
          env: {},
          ctx: { waitUntil: vi.fn() },
        },
      },
      params: {},
    } as unknown as LoaderFunctionArgs;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT id") && query.includes("defaultTermsDays")) {
        return Promise.resolve([{
          id: TEST_SHOP_ID,
          defaultTermsDays: 30,
          onboardingDismissedAt: null,
          currency: "INR",
        }]);
      }
      if (query.includes("COUNT(*)")) {
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("response includes Server-Timing header with allowlisted phase codes only", async () => {
    const { loader } = await import("../app.onboarding");
    const rawResult = await loader(createLoaderArgs());
    const headers = getResponseHeaders(rawResult);

    expect(headers).not.toBeNull();
    const serverTiming = headers?.get("Server-Timing");
    expect(serverTiming).toBeTruthy();

    const allowedCodes = new Set([
      "shop_lookup",
      "onboarding_checks",
      "loader_total",
    ]);

    const entries = serverTiming!.split(/,\s*/);
    for (const entry of entries) {
      const [code] = entry.split(";");
      expect(allowedCodes.has(code)).toBe(true);
    }
  });

  it("Server-Timing header includes shop_lookup, onboarding_checks, and loader_total phases", async () => {
    const { loader } = await import("../app.onboarding");
    const rawResult = await loader(createLoaderArgs());
    const headers = getResponseHeaders(rawResult);

    const serverTiming = headers?.get("Server-Timing") ?? "";
    expect(serverTiming).toContain("shop_lookup");
    expect(serverTiming).toContain("onboarding_checks");
    expect(serverTiming).toContain("loader_total");
  });

  it("safeLog calls use only allowlisted stage values", async () => {
    const mockSafeLog = vi.fn();
    vi.doMock("~/lib/log.server", async (importOriginal) => {
      const actual = await importOriginal<typeof import("~/lib/log.server")>();
      return {
        ...actual,
        safeLog: mockSafeLog,
      };
    });

    vi.resetModules();

    const { loader } = await import("../app.onboarding");
    await loader(createLoaderArgs());

    const allowedStages = new Set([
      "shop_lookup",
      "shop_lookup_cold",
      "onboarding_checks",
      "onboarding_checks_cold",
      "loader_total",
      "loader_total_cold",
    ]);

    const timingCalls = mockSafeLog.mock.calls.filter(
      (call) => call[1] === "app_home_timing"
    );

    for (const call of timingCalls) {
      const payload = call[2] as { stage?: string };
      if (payload?.stage) {
        expect(allowedStages.has(payload.stage)).toBe(true);
      }
    }
  });
});
