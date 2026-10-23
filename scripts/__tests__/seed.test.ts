import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SEED_TAG,
  SEED_PREFIX,
  COMPANY_SEEDS,
  ORDER_DISTRIBUTION,
  API_VERSION,
  graphql,
  checkDevStore,
  checkB2BSupport,
  fetchPaymentTermsTemplates,
  seedCompanies,
  seedOrders,
  createOrder,
  findCompanyByExternalId,
  findOrderByTag,
  updateCompanyLocationPaymentTerms,
  resetSeedData,
  formatCurrency,
  type SeedState,
  type GraphQLResponse,
} from "../seed";

/**
 * Unit tests for the seed script (orderCreate version).
 *
 * These tests mock global.fetch to simulate Shopify Admin API responses,
 * testing the real seed.ts functions for:
 * - Idempotency: existing records are skipped on re-run (via ntr-seed tag)
 * - Preflight failure: B2B unavailable stores are handled gracefully
 * - orderCreate payloads: custom line items (title + priceSet), companyLocationId, financialStatus PENDING
 * - No product IDs: orders use custom line items, not variantId
 * - Payment terms: set on CompanyLocation via companyLocationUpdate, inherited by orders
 * 
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/orderCreate
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/companyLocationUpdate
 */

interface CapturedRequest {
  query: string;
  variables?: Record<string, unknown>;
}

let capturedRequests: CapturedRequest[] = [];
const mockResponses: Map<string, unknown> = new Map();

const originalFetch = global.fetch;

function createMockState(overrides: Partial<SeedState> = {}): SeedState {
  return {
    shop: "net-terms-receivables.myshopify.com",
    token: "shpat_test_token",
    dryRun: false,
    reset: false,
    currencyCode: "INR",
    companies: new Map(),
    paymentTermsTemplates: [
      { id: "gid://shopify/PaymentTermsTemplate/3", name: "Net 15", paymentTermsType: "NET", dueInDays: 15 },
      { id: "gid://shopify/PaymentTermsTemplate/4", name: "Net 30", paymentTermsType: "NET", dueInDays: 30 },
      { id: "gid://shopify/PaymentTermsTemplate/5", name: "Net 60", paymentTermsType: "NET", dueInDays: 60 },
      { id: "gid://shopify/PaymentTermsTemplate/7", name: "Fixed", paymentTermsType: "FIXED", dueInDays: null },
    ],
    createdCount: { companies: 0, orders: 0 },
    skippedCount: { companies: 0, orders: 0 },
    deletedCount: { companies: 0, orders: 0 },
    errors: [],
    ...overrides,
  };
}

function setupMockFetch() {
  capturedRequests = [];

  global.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const query = body.query as string;
    const variables = body.variables as Record<string, unknown> | undefined;

    capturedRequests.push({ query, variables });

    let responseData: GraphQLResponse<unknown>;

    // Dev store check
    if (query.includes("GetShopInfo") || query.includes("plan {")) {
      responseData = mockResponses.get("shopInfo") as GraphQLResponse<unknown> ?? {
        data: { shop: { plan: { partnerDevelopment: true }, currencyCode: "INR" } },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
      };
    }
    // B2B check
    else if (query.includes("CheckB2B") || (query.includes("companies(first: 1)") && !query.includes("query:"))) {
      responseData = mockResponses.get("checkB2B") as GraphQLResponse<unknown> ?? {
        data: { companies: { edges: [] } },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
      };
    }
    // Payment terms templates
    else if (query.includes("paymentTermsTemplates")) {
      responseData = mockResponses.get("paymentTermsTemplates") as GraphQLResponse<unknown> ?? {
        data: {
          paymentTermsTemplates: [
            { id: "gid://shopify/PaymentTermsTemplate/3", name: "Net 15", paymentTermsType: "NET", dueInDays: 15 },
            { id: "gid://shopify/PaymentTermsTemplate/4", name: "Net 30", paymentTermsType: "NET", dueInDays: 30 },
            { id: "gid://shopify/PaymentTermsTemplate/5", name: "Net 60", paymentTermsType: "NET", dueInDays: 60 },
            { id: "gid://shopify/PaymentTermsTemplate/7", name: "Fixed", paymentTermsType: "FIXED", dueInDays: null },
          ],
        },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
      };
    }
    // Find seeded companies for reset
    else if (query.includes("FindSeededCompanies")) {
      responseData = {
        data: { companies: { nodes: [] } },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
      };
    }
    // Find company by external ID
    else if (query.includes("FindCompany") || (query.includes("companies") && variables?.query)) {
      const externalIdQuery = variables?.query as string;
      const existingCompanies = mockResponses.get("existingCompanies") as string[] | undefined;
      if (existingCompanies?.some((id) => externalIdQuery?.includes(id))) {
        responseData = {
          data: {
            companies: {
              nodes: [{
                id: "gid://shopify/Company/existing-1",
                name: "Existing Company",
                externalId: externalIdQuery?.replace("external_id:", ""),
                locations: { edges: [{ node: { id: "gid://shopify/CompanyLocation/loc-1", name: "HQ" } }] },
                contacts: { edges: [{ node: { id: "gid://shopify/CompanyContact/contact-1", customer: { id: "gid://shopify/Customer/cust-1", email: "test@example.com" } } }] },
              }],
            },
          },
          extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
        };
      } else {
        responseData = {
          data: { companies: { nodes: [] } },
          extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
        };
      }
    }
    // Company create
    else if (query.includes("companyCreate")) {
      responseData = mockResponses.get("companyCreate") as GraphQLResponse<unknown> ?? {
        data: {
          companyCreate: {
            company: {
              id: "gid://shopify/Company/new-1",
              name: "New Company",
              locations: { edges: [{ node: { id: "gid://shopify/CompanyLocation/new-loc-1", name: "New HQ" } }] },
              contacts: { edges: [{ node: { id: "gid://shopify/CompanyContact/new-contact-1", customer: { id: "gid://shopify/Customer/new-cust-1", email: "new@example.com" } } }] },
            },
            userErrors: [],
          },
        },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
      };
    }
    // Company location update (payment terms)
    else if (query.includes("companyLocationUpdate")) {
      responseData = mockResponses.get("companyLocationUpdate") as GraphQLResponse<unknown> ?? {
        data: {
          companyLocationUpdate: {
            companyLocation: {
              id: "gid://shopify/CompanyLocation/loc-1",
              buyerExperienceConfiguration: {
                paymentTermsTemplate: { id: "gid://shopify/PaymentTermsTemplate/4", name: "Net 30" },
              },
            },
            userErrors: [],
          },
        },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
      };
    }
    // Order create (new orderCreate mutation)
    else if (query.includes("orderCreate") && query.includes("OrderCreateOrderInput")) {
      responseData = mockResponses.get("orderCreate") as GraphQLResponse<unknown> ?? {
        data: {
          orderCreate: {
            order: {
              id: "gid://shopify/Order/order-1",
              name: "#1001",
              financialStatus: "PENDING",
              totalPriceSet: { shopMoney: { amount: "50000.00", currencyCode: "INR" } },
              paymentTerms: { paymentTermsName: "Net 30", dueInDays: 30 },
            },
            userErrors: [],
          },
        },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
      };
    }
    // Find order by tag (idempotency check)
    else if (query.includes("FindOrder") || (query.includes("orders(first:") && variables?.query)) {
      const existingOrders = mockResponses.get("existingOrders") as string[] | undefined;
      const tag = variables?.query as string;
      if (existingOrders?.some((t) => tag?.includes(t))) {
        responseData = {
          data: { orders: { nodes: [{ id: "gid://shopify/Order/existing-1", name: "#1001", tags: [SEED_TAG] }] } },
          extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
        };
      } else {
        responseData = {
          data: { orders: { nodes: [] } },
          extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
        };
      }
    }
    // Delete mutations
    else if (query.includes("companyDelete")) {
      responseData = {
        data: { companyDelete: { deletedCompanyId: "gid://shopify/Company/1", userErrors: [] } },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
      };
    }
    else {
      responseData = {
        data: {},
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => responseData,
    } as Response;
  });
}

function restoreFetch() {
  global.fetch = originalFetch;
}

describe("Seed Script Constants", () => {
  it("has correct seed tag", () => {
    expect(SEED_TAG).toBe("ntr-seed");
  });

  it("has correct seed prefix", () => {
    expect(SEED_PREFIX).toBe("ntr-seed-");
  });

  it("uses correct API version", () => {
    expect(API_VERSION).toBe("2026-10");
  });

  it("has 5 company seeds", () => {
    expect(COMPANY_SEEDS).toHaveLength(5);
    for (const company of COMPANY_SEEDS) {
      expect(company.key).toMatch(/^company-\d+$/);
      expect(company.name).toBeTruthy();
      expect(company.contact.email).toMatch(/@.*\.example$/);
    }
  });

  it("has ~20 B2B order distributions with both NET and FIXED terms", () => {
    expect(ORDER_DISTRIBUTION.length).toBeGreaterThanOrEqual(15);
    expect(ORDER_DISTRIBUTION.length).toBeLessThanOrEqual(25);

    const netOrders = ORDER_DISTRIBUTION.filter((o) => o.termsType === "NET");
    const fixedOrders = ORDER_DISTRIBUTION.filter((o) => o.termsType === "FIXED");
    expect(netOrders.length).toBeGreaterThan(0);
    expect(fixedOrders.length).toBeGreaterThan(0);

    const durations = new Set(netOrders.map((o) => o.dueInDays));
    expect(durations.has(15)).toBe(true);
    expect(durations.has(30)).toBe(true);
    expect(durations.has(60)).toBe(true);
  });

  it("all order distributions reference B2B companies (no customer orders)", () => {
    for (const order of ORDER_DISTRIBUTION) {
      expect(order.entityKey).toMatch(/^company-\d+$/);
    }
  });
});

describe("Preflight Checks", () => {
  beforeEach(() => {
    setupMockFetch();
    mockResponses.clear();
  });

  afterEach(() => {
    restoreFetch();
    capturedRequests = [];
  });

  it("checkDevStore returns true for development stores", async () => {
    const state = createMockState();
    const result = await checkDevStore(state);
    expect(result).toBe(true);
  });

  it("checkDevStore returns false for non-development stores", async () => {
    mockResponses.set("shopInfo", {
      data: { shop: { plan: { partnerDevelopment: false }, currencyCode: "USD" } },
      extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
    });

    const state = createMockState();
    const result = await checkDevStore(state);
    expect(result).toBe(false);
  });

  it("checkB2BSupport returns true when B2B is available", async () => {
    const state = createMockState();
    const result = await checkB2BSupport(state);
    expect(result).toBe(true);
  });

  it("checkB2BSupport returns false when B2B error", async () => {
    mockResponses.set("checkB2B", {
      errors: [{ message: "Shop does not have access to B2B companies feature" }],
    });

    const state = createMockState();
    const result = await checkB2BSupport(state);
    expect(result).toBe(false);
  });

  it("fetchPaymentTermsTemplates populates state and returns true", async () => {
    const state = createMockState({ paymentTermsTemplates: [] });
    const result = await fetchPaymentTermsTemplates(state);

    expect(result).toBe(true);
    expect(state.paymentTermsTemplates.length).toBe(4);
    expect(state.paymentTermsTemplates.find((t) => t.name === "Net 30")).toBeDefined();
  });

  it("fetchPaymentTermsTemplates returns false when no templates", async () => {
    mockResponses.set("paymentTermsTemplates", {
      data: { paymentTermsTemplates: [] },
      extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
    });

    const state = createMockState({ paymentTermsTemplates: [] });
    const result = await fetchPaymentTermsTemplates(state);
    expect(result).toBe(false);
  });
});

describe("Idempotency - No Create When Records Exist", () => {
  beforeEach(() => {
    setupMockFetch();
    mockResponses.clear();
  });

  afterEach(() => {
    restoreFetch();
    capturedRequests = [];
  });

  it("findCompanyByExternalId returns existing company", async () => {
    mockResponses.set("existingCompanies", [`${SEED_PREFIX}company-1`]);

    const state = createMockState();
    const result = await findCompanyByExternalId(state, `${SEED_PREFIX}company-1`);

    expect(result).not.toBeNull();
    expect(result?.externalId).toBe(`${SEED_PREFIX}company-1`);
  });

  it("seedCompanies skips creation when company exists", async () => {
    mockResponses.set("existingCompanies", COMPANY_SEEDS.map((c) => `${SEED_PREFIX}${c.key}`));

    const state = createMockState();
    await seedCompanies(state);

    // All companies should be skipped
    expect(state.skippedCount.companies).toBe(5);
    expect(state.createdCount.companies).toBe(0);

    // No companyCreate mutations should have been called
    const createCalls = capturedRequests.filter((r) => r.query.includes("companyCreate"));
    expect(createCalls).toHaveLength(0);
  });

  it("findOrderByTag returns existing order", async () => {
    mockResponses.set("existingOrders", [`${SEED_PREFIX}order-1`]);

    const state = createMockState();
    const result = await findOrderByTag(state, `${SEED_PREFIX}order-1`);

    expect(result).not.toBeNull();
    expect(result?.id).toBe("gid://shopify/Order/existing-1");
  });

  it("seedOrders skips creation when order exists (idempotency via ntr-seed tag)", async () => {
    // Mark first order as existing
    mockResponses.set("existingOrders", [`${SEED_PREFIX}order-1`]);

    const state = createMockState();
    // Add companies to state so order creation can proceed for others
    for (const seed of COMPANY_SEEDS) {
      state.companies.set(seed.key, {
        id: `gid://shopify/Company/${seed.key}`,
        locationId: `gid://shopify/CompanyLocation/${seed.key}`,
        contactCustomerId: `gid://shopify/Customer/${seed.key}`,
      });
    }

    await seedOrders(state);

    // First order should be skipped
    expect(state.skippedCount.orders).toBeGreaterThanOrEqual(1);
  });
});

describe("orderCreate - Payload Structure", () => {
  beforeEach(() => {
    setupMockFetch();
    mockResponses.clear();
  });

  afterEach(() => {
    restoreFetch();
    capturedRequests = [];
  });

  it("createOrder sends correct payload with custom line items (no variantId)", async () => {
    const state = createMockState();
    const amount = 75000;
    const productTitle = "Test Industrial Product";

    await createOrder(state, {
      orderKey: `${SEED_PREFIX}order-test`,
      companyLocationId: "gid://shopify/CompanyLocation/456",
      customerId: "gid://shopify/Customer/789",
      productTitle,
      amount,
    });

    const createCall = capturedRequests.find((r) => r.query.includes("orderCreate") && r.query.includes("OrderCreateOrderInput"));
    expect(createCall).toBeDefined();

    const order = createCall?.variables?.order as Record<string, unknown>;

    // Verify tags include seed tag and order key
    expect(order.tags).toContain(SEED_TAG);
    expect(order.tags).toContain(`${SEED_PREFIX}order-test`);

    // Verify companyLocationId for B2B association
    expect(order.companyLocationId).toBe("gid://shopify/CompanyLocation/456");

    // Verify customer
    const customer = order.customer as Record<string, unknown>;
    expect(customer.id).toBe("gid://shopify/Customer/789");

    // Verify financialStatus is PENDING (unpaid)
    expect(order.financialStatus).toBe("PENDING");

    // Verify line items use custom line items (title + priceSet), NOT variantId
    const lineItems = order.lineItems as Array<Record<string, unknown>>;
    expect(lineItems).toHaveLength(1);
    expect(lineItems[0].title).toBe(productTitle);
    expect(lineItems[0].quantity).toBe(1);
    expect(lineItems[0].variantId).toBeUndefined(); // No product ID!
    expect(lineItems[0].priceSet).toEqual({
      shopMoney: { amount: String(amount), currencyCode: "INR" },
    });
  });

  it("createOrder sends options with sendReceipt: false to suppress emails", async () => {
    const state = createMockState();

    await createOrder(state, {
      orderKey: `${SEED_PREFIX}order-no-email`,
      companyLocationId: "gid://shopify/CompanyLocation/123",
      customerId: "gid://shopify/Customer/456",
      productTitle: "Test Product",
      amount: 50000,
    });

    const createCall = capturedRequests.find((r) => r.query.includes("orderCreate") && r.query.includes("OrderCreateOrderInput"));
    expect(createCall).toBeDefined();

    const options = createCall?.variables?.options as Record<string, unknown>;
    expect(options.sendReceipt).toBe(false);
    expect(options.sendFulfillmentReceipt).toBe(false);
    expect(options.inventoryBehaviour).toBe("BYPASS");
  });

  it("createOrder returns order with payment terms inherited from location", async () => {
    const state = createMockState();

    const result = await createOrder(state, {
      orderKey: `${SEED_PREFIX}order-terms`,
      companyLocationId: "gid://shopify/CompanyLocation/456",
      customerId: "gid://shopify/Customer/789",
      productTitle: "Test Product",
      amount: 100000,
    });

    expect(result).not.toBeNull();
    expect(result?.name).toBe("#1001");
  });

  it("createOrder uses state.currencyCode in priceSet", async () => {
    const state = createMockState({ currencyCode: "USD" });

    await createOrder(state, {
      orderKey: `${SEED_PREFIX}order-currency`,
      companyLocationId: "gid://shopify/CompanyLocation/123",
      customerId: "gid://shopify/Customer/456",
      productTitle: "Test Product",
      amount: 50000,
    });

    const createCall = capturedRequests.find((r) => r.query.includes("orderCreate") && r.query.includes("OrderCreateOrderInput"));
    const order = createCall?.variables?.order as Record<string, unknown>;

    expect(order.currency).toBe("USD");

    const lineItems = order.lineItems as Array<Record<string, unknown>>;
    const priceSet = lineItems[0].priceSet as Record<string, unknown>;
    const shopMoney = priceSet.shopMoney as Record<string, unknown>;
    expect(shopMoney.currencyCode).toBe("USD");
  });
});

describe("Payment Terms - Set on CompanyLocation", () => {
  beforeEach(() => {
    setupMockFetch();
    mockResponses.clear();
  });

  afterEach(() => {
    restoreFetch();
    capturedRequests = [];
  });

  it("updateCompanyLocationPaymentTerms sends correct mutation with buyerExperienceConfiguration", async () => {
    const state = createMockState();

    await updateCompanyLocationPaymentTerms(
      state,
      "gid://shopify/CompanyLocation/loc-1",
      "gid://shopify/PaymentTermsTemplate/4"
    );

    const updateCall = capturedRequests.find((r) => r.query.includes("companyLocationUpdate"));
    expect(updateCall).toBeDefined();

    expect(updateCall?.variables?.companyLocationId).toBe("gid://shopify/CompanyLocation/loc-1");

    const input = updateCall?.variables?.input as Record<string, unknown>;
    const buyerExperience = input.buyerExperienceConfiguration as Record<string, unknown>;
    expect(buyerExperience.paymentTermsTemplateId).toBe("gid://shopify/PaymentTermsTemplate/4");
  });

  it("seedCompanies sets payment terms on location after company creation", async () => {
    const state = createMockState();
    await seedCompanies(state);

    // Should have called companyLocationUpdate after companyCreate
    const locationUpdateCalls = capturedRequests.filter((r) => r.query.includes("companyLocationUpdate"));
    
    // Each created company should have its location payment terms set
    expect(locationUpdateCalls.length).toBeGreaterThan(0);
  });
});

describe("Reset Seed Data", () => {
  beforeEach(() => {
    setupMockFetch();
    mockResponses.clear();
  });

  afterEach(() => {
    restoreFetch();
    capturedRequests = [];
  });

  it("resetSeedData queries for seeded data and attempts deletion", async () => {
    const state = createMockState();
    await resetSeedData(state);

    // Should have queried for orders and companies
    const queries = capturedRequests.filter((r) => r.query.includes("query"));
    expect(queries.length).toBeGreaterThan(0);

    // Verify queries included seed tag search
    const orderQuery = capturedRequests.find((r) => r.query.includes("FindSeededOrders"));
    expect(orderQuery?.variables?.query).toContain(SEED_TAG);

    const companyQuery = capturedRequests.find((r) => r.query.includes("FindSeededCompanies"));
    expect(companyQuery?.variables?.query).toContain(SEED_PREFIX);
  });

  it("resetSeedData in dry-run mode does not call delete mutations", async () => {
    const state = createMockState({ dryRun: true });
    await resetSeedData(state);

    const deleteCalls = capturedRequests.filter((r) =>
      r.query.includes("Delete") || r.query.includes("delete")
    );
    expect(deleteCalls).toHaveLength(0);
  });
});

describe("GraphQL Client", () => {
  beforeEach(() => {
    setupMockFetch();
    mockResponses.clear();
  });

  afterEach(() => {
    restoreFetch();
    capturedRequests = [];
  });

  it("graphql sends request with correct headers", async () => {
    const state = createMockState();
    await graphql(state, "query { shop { name } }");

    expect(global.fetch).toHaveBeenCalledWith(
      `https://${state.shop}/admin/api/${API_VERSION}/graphql.json`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": state.token,
        }),
      })
    );
  });

  it("graphql includes throttle status in response", async () => {
    const state = createMockState();
    const result = await graphql(state, "query { shop { name } }");

    expect(result.extensions?.cost?.throttleStatus).toBeDefined();
    expect(result.extensions?.cost?.throttleStatus.currentlyAvailable).toBeDefined();
  });
});

describe("Mutation Retry Safety", () => {
  let fetchCallCount: number;

  beforeEach(() => {
    fetchCallCount = 0;
  });

  afterEach(() => {
    restoreFetch();
  });

  it("queries retry on network error", async () => {
    global.fetch = vi.fn(async () => {
      fetchCallCount++;
      if (fetchCallCount < 3) {
        throw new Error("Network error");
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { shop: { name: "Test" } } }),
      } as Response;
    });

    const state = createMockState();
    const result = await graphql(state, "query { shop { name } }");

    expect(fetchCallCount).toBe(3);
    expect(result.data).toEqual({ shop: { name: "Test" } });
  });

  it("mutations do NOT retry on network error", async () => {
    global.fetch = vi.fn(async () => {
      fetchCallCount++;
      throw new Error("Network error");
    });

    const state = createMockState();
    const mutation = "mutation CreateTest { testCreate { id } }";

    await expect(graphql(state, mutation, {}, { isMutation: true })).rejects.toThrow("Network error");
    expect(fetchCallCount).toBe(1);
  });

  it("mutations still retry on 429 throttle (safe because request wasn't executed)", async () => {
    global.fetch = vi.fn(async () => {
      fetchCallCount++;
      if (fetchCallCount < 2) {
        return {
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { testCreate: { id: "123" } },
          extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 } } },
        }),
      } as Response;
    });

    const state = createMockState();
    const result = await graphql(state, "mutation { testCreate { id } }", {}, { isMutation: true });

    expect(fetchCallCount).toBe(2);
    expect(result.data).toEqual({ testCreate: { id: "123" } });
  });
});

describe("Dynamic Currency", () => {
  beforeEach(() => {
    setupMockFetch();
    mockResponses.clear();
  });

  afterEach(() => {
    restoreFetch();
    capturedRequests = [];
  });

  it("checkDevStore stores currencyCode in state", async () => {
    mockResponses.set("shopInfo", {
      data: { shop: { plan: { partnerDevelopment: true }, currencyCode: "USD" } },
      extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 } } },
    });

    const state = createMockState({ currencyCode: "" });
    await checkDevStore(state);

    expect(state.currencyCode).toBe("USD");
  });

  it("formatCurrency formats amounts with currency code", () => {
    expect(formatCurrency(50000, "USD")).toBe("USD 50,000");
    expect(formatCurrency(100000, "INR")).toBe("INR 100,000");
    expect(formatCurrency(1234567, "EUR")).toBe("EUR 1,234,567");
  });
});
