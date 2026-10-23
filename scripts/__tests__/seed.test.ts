import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SEED_TAG,
  SEED_PREFIX,
  COMPANY_SEEDS,
  CUSTOMER_SEEDS,
  ORDER_DISTRIBUTION,
  API_VERSION,
  graphql,
  checkDevStore,
  checkB2BSupport,
  fetchPaymentTermsTemplates,
  fetchProductVariants,
  seedCompanies,
  seedCustomers,
  seedOrders,
  createDraftOrder,
  findCompanyByExternalId,
  findCustomerByTag,
  resetSeedData,
  type SeedState,
  type GraphQLResponse,
} from "../seed";

/**
 * Unit tests for the seed script.
 *
 * These tests mock global.fetch to simulate Shopify Admin API responses,
 * testing the real seed.ts functions for:
 * - Idempotency: existing records are skipped on re-run
 * - Preflight failure: B2B unavailable stores are handled gracefully
 * - Payload shapes: draftOrderCreate includes correct payment terms and purchasingEntity
 */

// Capture all GraphQL requests made during tests
interface CapturedRequest {
  query: string;
  variables?: Record<string, unknown>;
}

let capturedRequests: CapturedRequest[] = [];
const mockResponses: Map<string, unknown> = new Map();

const originalFetch = global.fetch;

function createMockState(overrides: Partial<SeedState> = {}): SeedState {
  return {
    shop: "test-store.myshopify.com",
    token: "shpat_test_token",
    dryRun: false,
    reset: false,
    allowNonDevStore: false,
    companies: new Map(),
    customers: new Map(),
    paymentTermsTemplates: [
      { id: "gid://shopify/PaymentTermsTemplate/3", name: "Net 15", paymentTermsType: "NET", dueInDays: 15 },
      { id: "gid://shopify/PaymentTermsTemplate/4", name: "Net 30", paymentTermsType: "NET", dueInDays: 30 },
      { id: "gid://shopify/PaymentTermsTemplate/5", name: "Net 60", paymentTermsType: "NET", dueInDays: 60 },
      { id: "gid://shopify/PaymentTermsTemplate/7", name: "Fixed", paymentTermsType: "FIXED", dueInDays: null },
    ],
    productVariants: [
      { id: "gid://shopify/ProductVariant/123", title: "Default", price: "1000.00", product: { title: "Test Product" } },
    ],
    createdCount: { companies: 0, customers: 0, draftOrders: 0, orders: 0 },
    skippedCount: { companies: 0, customers: 0, orders: 0 },
    deletedCount: { companies: 0, customers: 0, draftOrders: 0, orders: 0 },
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
    // Product variants
    else if (query.includes("productVariants")) {
      responseData = mockResponses.get("productVariants") as GraphQLResponse<unknown> ?? {
        data: {
          productVariants: {
            nodes: [
              { id: "gid://shopify/ProductVariant/123", title: "Default", price: "1000.00", product: { title: "Test Product" } },
            ],
          },
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
    // Find customer by tag
    else if (query.includes("FindCustomer") || (query.includes("customers") && variables?.query)) {
      const tag = variables?.query as string;
      const existingCustomers = mockResponses.get("existingCustomers") as string[] | undefined;
      if (existingCustomers?.some((t) => tag?.includes(t))) {
        responseData = {
          data: {
            customers: {
              nodes: [{ id: "gid://shopify/Customer/existing-cust-1", email: "existing@example.com", firstName: "Existing", lastName: "Customer", tags: [SEED_TAG] }],
            },
          },
          extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
        };
      } else {
        responseData = {
          data: { customers: { nodes: [] } },
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
    // Customer create
    else if (query.includes("customerCreate")) {
      responseData = mockResponses.get("customerCreate") as GraphQLResponse<unknown> ?? {
        data: {
          customerCreate: {
            customer: { id: "gid://shopify/Customer/new-cust-2", email: "newcustomer@example.com" },
            userErrors: [],
          },
        },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
      };
    }
    // Draft order create
    else if (query.includes("draftOrderCreate")) {
      responseData = mockResponses.get("draftOrderCreate") as GraphQLResponse<unknown> ?? {
        data: {
          draftOrderCreate: {
            draftOrder: {
              id: "gid://shopify/DraftOrder/draft-1",
              name: "#D1",
              totalPriceSet: { shopMoney: { amount: "50000.00" } },
            },
            userErrors: [],
          },
        },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
      };
    }
    // Draft order complete
    else if (query.includes("draftOrderComplete")) {
      responseData = mockResponses.get("draftOrderComplete") as GraphQLResponse<unknown> ?? {
        data: {
          draftOrderComplete: {
            draftOrder: {
              id: "gid://shopify/DraftOrder/draft-1",
              name: "#D1",
              order: {
                id: "gid://shopify/Order/order-1",
                name: "#1001",
                totalPriceSet: { shopMoney: { amount: "50000.00" } },
              },
            },
            userErrors: [],
          },
        },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
      };
    }
    // Find order
    else if (query.includes("FindOrder") || query.includes("orders(first:")) {
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
    // Find draft order
    else if (query.includes("FindDraftOrder") || query.includes("draftOrders(first:")) {
      responseData = {
        data: { draftOrders: { nodes: [] } },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
      };
    }
    // Delete mutations
    else if (query.includes("draftOrderDelete")) {
      responseData = {
        data: { draftOrderDelete: { deletedId: "gid://shopify/DraftOrder/1", userErrors: [] } },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
      };
    }
    else if (query.includes("customerDelete")) {
      responseData = {
        data: { customerDelete: { deletedCustomerId: "gid://shopify/Customer/1", userErrors: [] } },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
      };
    }
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

  it("has 5 customer seeds", () => {
    expect(CUSTOMER_SEEDS).toHaveLength(5);
    for (const customer of CUSTOMER_SEEDS) {
      expect(customer.key).toMatch(/^customer-\d+$/);
      expect(customer.email).toMatch(/@example\.com$/);
    }
  });

  it("has ~30 order distributions with both NET and FIXED terms", () => {
    expect(ORDER_DISTRIBUTION.length).toBeGreaterThanOrEqual(25);
    expect(ORDER_DISTRIBUTION.length).toBeLessThanOrEqual(35);

    const netOrders = ORDER_DISTRIBUTION.filter((o) => o.termsType === "NET");
    const fixedOrders = ORDER_DISTRIBUTION.filter((o) => o.termsType === "FIXED");
    expect(netOrders.length).toBeGreaterThan(0);
    expect(fixedOrders.length).toBeGreaterThan(0);

    const durations = new Set(netOrders.map((o) => o.dueInDays));
    expect(durations.has(15)).toBe(true);
    expect(durations.has(30)).toBe(true);
    expect(durations.has(60)).toBe(true);
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

  it("checkDevStore returns true for non-dev store with override flag", async () => {
    mockResponses.set("shopInfo", {
      data: { shop: { plan: { partnerDevelopment: false }, currencyCode: "USD" } },
      extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
    });

    const state = createMockState({ allowNonDevStore: true });
    const result = await checkDevStore(state);
    expect(result).toBe(true);
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

  it("fetchProductVariants populates state and returns true", async () => {
    const state = createMockState({ productVariants: [] });
    const result = await fetchProductVariants(state);

    expect(result).toBe(true);
    expect(state.productVariants.length).toBeGreaterThan(0);
  });

  it("fetchProductVariants returns false when no variants", async () => {
    mockResponses.set("productVariants", {
      data: { productVariants: { nodes: [] } },
      extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
    });

    const state = createMockState({ productVariants: [] });
    const result = await fetchProductVariants(state);
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

  it("findCustomerByTag returns existing customer", async () => {
    mockResponses.set("existingCustomers", [`${SEED_PREFIX}customer-1`]);

    const state = createMockState();
    const result = await findCustomerByTag(state, `${SEED_PREFIX}customer-1`);

    expect(result).not.toBeNull();
    expect(result?.id).toBe("gid://shopify/Customer/existing-cust-1");
  });

  it("seedCustomers skips creation when customer exists", async () => {
    mockResponses.set("existingCustomers", CUSTOMER_SEEDS.map((c) => `${SEED_PREFIX}${c.key}`));

    const state = createMockState();
    await seedCustomers(state);

    expect(state.skippedCount.customers).toBe(5);
    expect(state.createdCount.customers).toBe(0);

    const createCalls = capturedRequests.filter((r) => r.query.includes("customerCreate"));
    expect(createCalls).toHaveLength(0);
  });

  it("seedOrders skips creation when order exists", async () => {
    // Mark first order as existing
    mockResponses.set("existingOrders", [`${SEED_PREFIX}order-1`]);

    const state = createMockState();
    // Add companies and customers to state so order creation can proceed for others
    for (const seed of COMPANY_SEEDS) {
      state.companies.set(seed.key, {
        id: `gid://shopify/Company/${seed.key}`,
        locationId: `gid://shopify/CompanyLocation/${seed.key}`,
        contactId: `gid://shopify/CompanyContact/${seed.key}`,
        contactCustomerId: `gid://shopify/Customer/${seed.key}`,
      });
    }
    for (const seed of CUSTOMER_SEEDS) {
      state.customers.set(seed.key, { id: `gid://shopify/Customer/${seed.key}` });
    }

    await seedOrders(state);

    // First order should be skipped
    expect(state.skippedCount.orders).toBeGreaterThanOrEqual(1);
  });
});

describe("Draft Order Create - Payload Structure", () => {
  beforeEach(() => {
    setupMockFetch();
    mockResponses.clear();
  });

  afterEach(() => {
    restoreFetch();
    capturedRequests = [];
  });

  it("createDraftOrder sends correct payload with price override for exact amount", async () => {
    const state = createMockState();
    const amount = 75000;

    await createDraftOrder(state, {
      orderKey: `${SEED_PREFIX}order-test`,
      purchasingEntity: {
        purchasingCompany: {
          companyId: "gid://shopify/Company/123",
          companyLocationId: "gid://shopify/CompanyLocation/456",
          companyContactId: "gid://shopify/CompanyContact/789",
        },
      },
      paymentTermsInput: {
        paymentTermsTemplateId: "gid://shopify/PaymentTermsTemplate/4",
        paymentSchedules: [{ issuedAt: new Date().toISOString() }],
      },
      billingAddress: { firstName: "Test", lastName: "User", address1: "123 St", city: "Mumbai", countryCode: "IN", zip: "400001" },
      variantId: "gid://shopify/ProductVariant/123",
      amount,
    });

    const createCall = capturedRequests.find((r) => r.query.includes("draftOrderCreate"));
    expect(createCall).toBeDefined();

    const input = createCall?.variables?.input as Record<string, unknown>;

    // Verify tags
    expect(input.tags).toContain(SEED_TAG);
    expect(input.tags).toContain(`${SEED_PREFIX}order-test`);

    // Verify paymentTerms
    expect(input.paymentTerms).toBeDefined();
    const paymentTerms = input.paymentTerms as Record<string, unknown>;
    expect(paymentTerms.paymentTermsTemplateId).toBe("gid://shopify/PaymentTermsTemplate/4");
    expect(paymentTerms.paymentSchedules).toHaveLength(1);
    expect((paymentTerms.paymentSchedules as Array<{ issuedAt?: string }>)[0].issuedAt).toBeDefined();

    // Verify purchasingEntity for B2B company order
    expect(input.purchasingEntity).toBeDefined();
    const purchasingEntity = input.purchasingEntity as Record<string, unknown>;
    expect(purchasingEntity.purchasingCompany).toBeDefined();
    const company = purchasingEntity.purchasingCompany as Record<string, unknown>;
    expect(company.companyId).toBe("gid://shopify/Company/123");
    expect(company.companyLocationId).toBe("gid://shopify/CompanyLocation/456");
    expect(company.companyContactId).toBe("gid://shopify/CompanyContact/789");

    // Verify line item with price override
    expect(input.lineItems).toBeDefined();
    const lineItems = input.lineItems as Array<Record<string, unknown>>;
    expect(lineItems).toHaveLength(1);
    expect(lineItems[0].variantId).toBe("gid://shopify/ProductVariant/123");
    expect(lineItems[0].quantity).toBe(1);
    expect(lineItems[0].priceOverride).toEqual({ amount: String(amount), currencyCode: "INR" });

    // Verify currency
    expect(input.presentmentCurrencyCode).toBe("INR");
  });

  it("createDraftOrder sends FIXED payment terms with dueAt", async () => {
    const state = createMockState();
    const dueAt = new Date();
    dueAt.setDate(dueAt.getDate() + 15);

    await createDraftOrder(state, {
      orderKey: `${SEED_PREFIX}order-fixed`,
      purchasingEntity: { customerId: "gid://shopify/Customer/123" },
      paymentTermsInput: {
        paymentTermsTemplateId: "gid://shopify/PaymentTermsTemplate/7",
        paymentSchedules: [{ dueAt: dueAt.toISOString() }],
      },
      billingAddress: { firstName: "Test", lastName: "User", address1: "456 St", city: "Delhi", countryCode: "IN", zip: "110001" },
      variantId: "gid://shopify/ProductVariant/456",
      amount: 25000,
    });

    const createCall = capturedRequests.find((r) => r.query.includes("draftOrderCreate"));
    expect(createCall).toBeDefined();

    const input = createCall?.variables?.input as Record<string, unknown>;

    // Verify FIXED payment terms uses dueAt
    const paymentTerms = input.paymentTerms as Record<string, unknown>;
    expect(paymentTerms.paymentTermsTemplateId).toBe("gid://shopify/PaymentTermsTemplate/7");
    const schedules = paymentTerms.paymentSchedules as Array<{ dueAt?: string; issuedAt?: string }>;
    expect(schedules[0].dueAt).toBeDefined();
    expect(schedules[0].issuedAt).toBeUndefined();

    // Verify customer purchasingEntity (non-B2B path)
    const purchasingEntity = input.purchasingEntity as Record<string, unknown>;
    expect(purchasingEntity.customerId).toBe("gid://shopify/Customer/123");
    expect(purchasingEntity.purchasingCompany).toBeUndefined();
  });

  it("createDraftOrder returns totalPrice from API response", async () => {
    const state = createMockState();

    const result = await createDraftOrder(state, {
      orderKey: `${SEED_PREFIX}order-total`,
      purchasingEntity: { customerId: "gid://shopify/Customer/123" },
      paymentTermsInput: { paymentTermsTemplateId: "gid://shopify/PaymentTermsTemplate/4", paymentSchedules: [{ issuedAt: new Date().toISOString() }] },
      billingAddress: { firstName: "Test", lastName: "User", address1: "789 St", city: "Chennai", countryCode: "IN", zip: "600001" },
      variantId: "gid://shopify/ProductVariant/789",
      amount: 100000,
    });

    expect(result).not.toBeNull();
    expect(result?.totalPrice).toBe(50000); // From mock response
    expect(result?.name).toBe("#D1");
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

    // Should have queried for orders, draft orders, customers, and companies
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
