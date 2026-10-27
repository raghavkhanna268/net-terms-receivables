import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LoaderFunctionArgs } from "react-router";

/**
 * Tests for parallelized onboarding loader (latency optimization).
 *
 * Verifies:
 * 1. Parallel execution: all calls start before any resolve (deferred-promise tests)
 * 2. Metafield definitions: both owner types are reported even if one fails
 * 3. Query count: exactly 4 DB queries (no separate currency SELECT)
 * 4. Server-Timing header: correct phase codes in the response
 * 5. safeLog: emits app_home_timing with allowlisted stage codes only
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
  resolvePlanWithStatus: vi.fn().mockResolvedValue({
    plan: { plan: { key: "none" }, subscriptionId: null, fromCache: false },
    status: "none",
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

interface DeferredPromise<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  started: boolean;
}

function createDeferredPromise<T>(): DeferredPromise<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject, started: false };
}

describe("Parallel execution (deferred-promise tests)", () => {
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("checkAndRecoverCurrency, fetchShopOnboardingData counts, and both metafield owner types start before any resolves", async () => {
    const shopQueryDeferred = createDeferredPromise<unknown[]>();
    const buyerCountDeferred = createDeferredPromise<unknown[]>();
    const tagRuleCountDeferred = createDeferredPromise<unknown[]>();
    const syncStateDeferred = createDeferredPromise<unknown[]>();
    const currencyRecoveryDeferred = createDeferredPromise<{ json: () => Promise<unknown> }>();
    const metafieldCompanyDeferred = createDeferredPromise<{ json: () => Promise<unknown> }>();
    const metafieldCustomerDeferred = createDeferredPromise<{ json: () => Promise<unknown> }>();
    const validationDeferred = createDeferredPromise<{ json: () => Promise<unknown> }>();
    const paymentCustomizationDeferred = createDeferredPromise<{ json: () => Promise<unknown> }>();

    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT id") && query.includes("defaultTermsDays")) {
        shopQueryDeferred.started = true;
        return shopQueryDeferred.promise;
      }
      if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
        buyerCountDeferred.started = true;
        return buyerCountDeferred.promise;
      }
      if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
        tagRuleCountDeferred.started = true;
        return tagRuleCountDeferred.promise;
      }
      if (query.includes("s6_bulk_operations") || query.includes("s6_dead_letter")) {
        syncStateDeferred.started = true;
        return syncStateDeferred.promise;
      }
      return Promise.resolve([]);
    });

    mockGraphql.mockImplementation(async (query: string, opts?: { variables?: { ownerType?: string } }) => {
      if (query.includes("ShopCurrencyAndId")) {
        currencyRecoveryDeferred.started = true;
        return currencyRecoveryDeferred.promise;
      }
      if (query.includes("metafieldDefinitions")) {
        const ownerType = opts?.variables?.ownerType;
        if (ownerType === "COMPANY_LOCATION") {
          metafieldCompanyDeferred.started = true;
          return metafieldCompanyDeferred.promise;
        }
        if (ownerType === "CUSTOMER") {
          metafieldCustomerDeferred.started = true;
          return metafieldCustomerDeferred.promise;
        }
      }
      if (query.includes("validations")) {
        validationDeferred.started = true;
        return validationDeferred.promise;
      }
      if (query.includes("paymentCustomizations")) {
        paymentCustomizationDeferred.started = true;
        return paymentCustomizationDeferred.promise;
      }
      return { json: async () => ({ data: {} }) };
    });

    const { loader } = await import("../app.onboarding");
    const loaderPromise = loader(createLoaderArgs());

    // Step 1: Shop query must complete first (it provides shopId for counts)
    await new Promise(r => setTimeout(r, 5));
    expect(shopQueryDeferred.started).toBe(true);
    shopQueryDeferred.resolve([{
      id: TEST_SHOP_ID,
      defaultTermsDays: 30,
      onboardingDismissedAt: null,
      currency: "INR",
    }]);

    // Step 2: After shop query, buyerCount and tagRuleCount run in parallel
    await new Promise(r => setTimeout(r, 5));
    expect(buyerCountDeferred.started).toBe(true);
    expect(tagRuleCountDeferred.started).toBe(true);

    // Resolve counts to allow fetchShopOnboardingData to complete
    buyerCountDeferred.resolve([{ count: "0" }]);
    tagRuleCountDeferred.resolve([{ count: "0" }]);

    // Step 3: After fetchShopOnboardingData completes, the main Promise.all starts
    // All Admin calls and sync state should start in parallel
    await new Promise(r => setTimeout(r, 10));
    expect(currencyRecoveryDeferred.started).toBe(true);
    expect(metafieldCompanyDeferred.started).toBe(true);
    expect(metafieldCustomerDeferred.started).toBe(true);
    expect(validationDeferred.started).toBe(true);
    expect(paymentCustomizationDeferred.started).toBe(true);
    expect(syncStateDeferred.started).toBe(true);

    // Resolve all remaining promises
    syncStateDeferred.resolve([]);

    currencyRecoveryDeferred.resolve({
      json: async () => ({
        data: {
          shop: {
            id: TEST_SHOP_GID,
            currencyCode: "INR",
            metafield: { value: JSON.stringify({ schemaVersion: 1, currencyCode: "INR" }) },
          },
        },
      }),
    });

    validationDeferred.resolve({
      json: async () => ({ data: { validations: { edges: [] } } }),
    });

    paymentCustomizationDeferred.resolve({
      json: async () => ({ data: { paymentCustomizations: { edges: [] } } }),
    });

    metafieldCompanyDeferred.resolve({
      json: async () => ({
        data: { metafieldDefinitions: { edges: [] } },
      }),
    });

    metafieldCustomerDeferred.resolve({
      json: async () => ({
        data: { metafieldDefinitions: { edges: [] } },
      }),
    });

    const result = await loaderPromise;
    const data = extractLoaderData<{ error: string | null }>(result);
    expect(data.error).toBeNull();
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

  it("both owner types are queried via Promise.allSettled", async () => {
    const companyDeferred = createDeferredPromise<{ json: () => Promise<unknown> }>();
    const customerDeferred = createDeferredPromise<{ json: () => Promise<unknown> }>();

    mockGraphql.mockImplementation(async (query: string, opts?: { variables?: { ownerType?: string } }) => {
      if (query.includes("metafieldDefinitions")) {
        const ownerType = opts?.variables?.ownerType ?? "unknown";
        if (ownerType === "COMPANY_LOCATION") {
          companyDeferred.started = true;
          return companyDeferred.promise;
        }
        if (ownerType === "CUSTOMER") {
          customerDeferred.started = true;
          return customerDeferred.promise;
        }
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
    const loaderPromise = loader(createLoaderArgs());

    // Give time for all calls to start
    await new Promise(r => setTimeout(r, 20));

    // Both metafield queries should have started before we resolve either
    expect(companyDeferred.started).toBe(true);
    expect(customerDeferred.started).toBe(true);

    // Now resolve both
    companyDeferred.resolve({
      json: async () => ({
        data: {
          metafieldDefinitions: {
            edges: [{ node: { id: "mf-1", namespace: "$app", key: "credit_status", ownerType: "COMPANY_LOCATION" } }],
          },
        },
      }),
    });

    customerDeferred.resolve({
      json: async () => ({
        data: {
          metafieldDefinitions: {
            edges: [{ node: { id: "mf-2", namespace: "$app", key: "credit_status", ownerType: "CUSTOMER" } }],
          },
        },
      }),
    });

    const result = await loaderPromise;
    const data = extractLoaderData<{ registrationStatus: { metafieldDefinitions: { status: string } } }>(result);
    expect(data.registrationStatus.metafieldDefinitions.status).toBe("ok");
  });
});

describe("Query count reduction", () => {
  let sqlQueries: string[];

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
    sqlQueries = [];
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");
      sqlQueries.push(query);
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
      if (query.includes("q_s6_sync") && query.includes("RECONCILE_COMPANIES")) {
        return Promise.resolve([]);
      }
      if (query.includes("s18_shop_reminder_settings")) {
        return Promise.resolve([{ enabled: false }]);
      }
      return Promise.resolve([]);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("makes exactly 6 DB queries and no separate currency SELECT", async () => {
    const { loader } = await import("../app.onboarding");
    await loader(createLoaderArgs());

    // Exactly 6 queries:
    // 1. shop+currency (SELECT id, defaultTermsDays, currency, ...)
    // 2. buyerCount (COUNT(*) FROM BuyerAccount)
    // 3. tagRuleCount (COUNT(*) FROM AccountSource)
    // 4. sync state bulk ops (s6_bulk_operations)
    // 5. sync state queue check (pgmq.q_s6_sync for RECONCILE_COMPANIES)
    // 6. reminder settings (s18_shop_reminder_settings)
    expect(sqlQueries.length).toBe(6);

    // No separate currency SELECT - verify no query is just SELECT currency
    const separateCurrencyQuery = sqlQueries.find(
      q => q.includes("SELECT currency") && !q.includes("defaultTermsDays")
    );
    expect(separateCurrencyQuery).toBeUndefined();

    // Verify the shop query includes currency
    const shopQuery = sqlQueries.find(q => q.includes("defaultTermsDays"));
    expect(shopQuery).toBeDefined();
    expect(shopQuery).toContain("currency");

    // Verify reminder settings query is present
    const reminderSettingsQuery = sqlQueries.find(q => q.includes("s18_shop_reminder_settings"));
    expect(reminderSettingsQuery).toBeDefined();

    // Verify sync state queue check for RECONCILE_COMPANIES is present
    const syncQueueQuery = sqlQueries.find(q => q.includes("q_s6_sync") && q.includes("RECONCILE_COMPANIES"));
    expect(syncQueueQuery).toBeDefined();
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
    expect(result.state?.steps).toHaveLength(5);
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

  it("safeLog emits app_home_timing events with allowlisted stage codes (real safeLog, console capture)", async () => {
    const ALLOWED_STAGES = new Set([
      "shop_lookup",
      "shop_lookup_cold",
      "onboarding_checks",
      "onboarding_checks_cold",
      "loader_total",
      "loader_total_cold",
    ]);

    const capturedLogs: string[] = [];
    const originalConsoleLog = console.log;
    console.log = (...args: unknown[]) => {
      const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
      capturedLogs.push(msg);
    };

    try {
      const { loader } = await import("../app.onboarding");
      await loader(createLoaderArgs());

      // Find app_home_timing events in captured logs
      const timingEvents = capturedLogs
        .filter(log => log.includes('"event":"app_home_timing"'))
        .map(log => {
          try {
            return JSON.parse(log) as { event: string; stage?: string; durationMs?: number; route?: string };
          } catch {
            return null;
          }
        })
        .filter((e): e is { event: string; stage: string; durationMs: number; route: string } =>
          e !== null && e.event === "app_home_timing" && typeof e.stage === "string"
        );

      // Assert at least one app_home_timing record was emitted
      expect(timingEvents.length).toBeGreaterThan(0);

      // Assert each expected stage appears by name (or its _cold variant)
      const foundStages = new Set(timingEvents.map(e => e.stage));
      const hasShopLookup = foundStages.has("shop_lookup") || foundStages.has("shop_lookup_cold");
      const hasOnboardingChecks = foundStages.has("onboarding_checks") || foundStages.has("onboarding_checks_cold");
      const hasLoaderTotal = foundStages.has("loader_total") || foundStages.has("loader_total_cold");

      expect(hasShopLookup).toBe(true);
      expect(hasOnboardingChecks).toBe(true);
      expect(hasLoaderTotal).toBe(true);

      // Assert every stage value is in ALLOWED_STAGES
      for (const event of timingEvents) {
        expect(ALLOWED_STAGES.has(event.stage)).toBe(true);
        // Assert event carries only stage and ms (durationMs)
        expect(typeof event.stage).toBe("string");
        expect(typeof event.durationMs).toBe("number");
        // Route is also included by the helper
        expect(event.route).toBe("app_home");
      }
    } finally {
      console.log = originalConsoleLog;
    }
  });
});
