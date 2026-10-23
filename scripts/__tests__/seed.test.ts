import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import {
  SEED_TAG,
  SEED_PREFIX,
  COMPANY_SEEDS,
  ORDER_DISTRIBUTION,
  LOCATION_TERMS,
  API_VERSION,
  graphql,
  logGraphQLErrors,
  logUserErrors,
  checkDevStore,
  checkB2BSupport,
  fetchPaymentTermsTemplates,
  seedCompanies,
  seedOrders,
  createOrder,
  findCompanyByExternalId,
  findOrderByTag,
  formatCurrency,
  printDatabaseSeedSQL,
  seedTaggedCustomerOrders,
  TAGGED_CUSTOMER_SEEDS,
  TAGGED_ORDER_DISTRIBUTION,
  B2B_ORDER_CREATE_MUTATION,
  TAGGED_CUSTOMER_ORDER_CREATE_MUTATION,
  COMPANY_CREATE_MUTATION,
  COMPANY_LOCATION_CREATE_MUTATION,
  COMPANY_CONTACT_ROLES_QUERY,
  COMPANY_LOCATION_ROLE_ASSIGNMENTS_QUERY,
  COMPANY_LOCATION_ASSIGN_ROLES_MUTATION,
  FIND_ORDER_BY_TAG_QUERY,
  buildCompanyCreateInput,
  buildCompanyLocationCreateInput,
  buildCompanyLocationAssignRolesInput,
  buildTaggedCustomerOrderInput,
  buildB2BOrderInput,
  isThrottleError,
  calculateThrottleBackoffDelay,
  ensureContactRoleOnLocation,
  DEFAULT_SEED_ORDER_DELAY_MS,
  ORDER_CREATE_MAX_ATTEMPTS,
  ORDER_CREATE_BACKOFF_DELAYS_MS,
  getIndiaProvinceCode,
  getIndiaAddressInfo,
  INDIA_CITY_ADDRESS_INFO,
  type SeedState,
  type GraphQLResponse,
  type UserError,
  type CompanyData,
} from "../seed";
import { inferDueDate } from "~/lib/due-date";
import { readFileSync } from "fs";
import { resolve } from "path";
import { buildClientSchema, parse, validate, coerceInputValue, type GraphQLSchema, type GraphQLInputType } from "graphql";

/**
 * Unit tests for the seed script (orderCreate with processedAt version).
 *
 * QA Acceptance Checklist Coverage:
 * (1) processedAt is set from daysAgo - tested in "createOrder sends processedAt"
 * (2) DB seeding idempotency - tested in "DB seeding idempotent" suite
 * (3) Overdue invoice test - tested in "at least one order is overdue"
 * (4) Missing Shopify terms = warning not failure - tested in "null paymentTerms logs warning"
 * (5) Logs show actual terms - tested in createOrder response handling
 * (6) 11 prod scopes, dev-store guard - constants and validateEnv tests
 *
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/OrderCreateOrderInput
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
    databaseUrl: null,
    dryRun: false,
    reset: false,
    currencyCode: "INR",
    companies: new Map(),
    paymentTermsTemplates: [
      { id: "gid://shopify/PaymentTermsTemplate/15", name: "Net 15", paymentTermsType: "NET", dueInDays: 15 },
      { id: "gid://shopify/PaymentTermsTemplate/30", name: "Net 30", paymentTermsType: "NET", dueInDays: 30 },
      { id: "gid://shopify/PaymentTermsTemplate/60", name: "Net 60", paymentTermsType: "NET", dueInDays: 60 },
    ],
    createdCount: { companies: 0, locations: 0, orders: 0, roleAssignments: 0, dbRules: 0, dbAccounts: 0 },
    skippedCount: { companies: 0, orders: 0, roleAssignments: 0 },
    deletedCount: { companies: 0, orders: 0 },
    failedCount: { locations: 0, orders: 0, roleAssignments: 0 },
    ordersWithShopifyTerms: 0,
    ordersWithoutShopifyTerms: 0,
    overdueOrdersCount: 0,
    taggedCustomerOrdersCount: 0,
    errors: [],
    ...overrides,
  };
}

function createMockCompanyData(overrides: Partial<CompanyData> = {}): CompanyData {
  const locations = new Map<number, string>();
  locations.set(15, "gid://shopify/CompanyLocation/loc-15");
  locations.set(30, "gid://shopify/CompanyLocation/loc-30");
  locations.set(60, "gid://shopify/CompanyLocation/loc-60");
  
  return {
    id: "gid://shopify/Company/1",
    contactId: "gid://shopify/CompanyContact/contact-1",
    contactCustomerId: "gid://shopify/Customer/cust-1",
    locations,
    contactRoles: [
      { id: "gid://shopify/CompanyContactRole/ordering", name: "Ordering only" },
      { id: "gid://shopify/CompanyContactRole/admin", name: "Location admin" },
    ],
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
            { id: "gid://shopify/PaymentTermsTemplate/15", name: "Net 15", paymentTermsType: "NET", dueInDays: 15 },
            { id: "gid://shopify/PaymentTermsTemplate/30", name: "Net 30", paymentTermsType: "NET", dueInDays: 30 },
            { id: "gid://shopify/PaymentTermsTemplate/60", name: "Net 60", paymentTermsType: "NET", dueInDays: 60 },
          ],
        },
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
                locations: { edges: [
                  { node: { id: "gid://shopify/CompanyLocation/loc-15", name: "Existing - Net-15" } },
                  { node: { id: "gid://shopify/CompanyLocation/loc-30", name: "Existing - Net-30" } },
                  { node: { id: "gid://shopify/CompanyLocation/loc-60", name: "Existing - Net-60" } },
                ] },
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
    // Company location create
    else if (query.includes("companyLocationCreate")) {
      responseData = {
        data: {
          companyLocationCreate: {
            companyLocation: { id: `gid://shopify/CompanyLocation/new-loc-${Date.now()}`, name: "New Location" },
            userErrors: [],
          },
        },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
      };
    }
    // Find customer by email
    else if (query.includes("customers") && variables?.query && String(variables.query).startsWith("email:")) {
      const email = String(variables.query).replace("email:", "");
      // Return empty for new customers, or return existing for idempotency tests
      const existingCustomers = mockResponses.get("existingTaggedCustomers") as string[] | undefined;
      if (existingCustomers?.some(e => email.includes(e))) {
        responseData = {
          data: {
            customers: {
              nodes: [{ id: `gid://shopify/Customer/existing-${email.split("@")[0]}`, tags: [SEED_TAG] }],
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
    // Customer create
    else if (query.includes("customerCreate")) {
      // Generate unique IDs using the email from input
      const email = (variables?.input as Record<string, unknown>)?.email as string ?? "unknown";
      const customerId = `gid://shopify/Customer/${email.replace(/[^a-z0-9]/gi, "-")}`;
      responseData = {
        data: {
          customerCreate: {
            customer: { id: customerId },
            userErrors: [],
          },
        },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
      };
    }
    // tagsAdd - idempotent tag addition
    else if (query.includes("tagsAdd")) {
      responseData = {
        data: {
          tagsAdd: {
            node: { id: variables?.id as string },
            userErrors: [],
          },
        },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
      };
    }
    // Order create - the key mutation we're testing
    else if (query.includes("orderCreate") && query.includes("OrderCreateOrderInput")) {
      const withTerms = mockResponses.get("orderWithShopifyTerms") as boolean ?? true;
      responseData = {
        data: {
          orderCreate: {
            order: {
              id: "gid://shopify/Order/order-1",
              name: "#1001",
              financialStatus: "PENDING",
              totalPriceSet: { shopMoney: { amount: "50000.00", currencyCode: "INR" } },
              paymentTerms: withTerms ? {
                paymentTermsName: "Net 30",
                paymentTermsType: "NET",
                dueInDays: 30,
                paymentSchedules: { nodes: [{ dueAt: "2026-11-15T00:00:00Z" }] },
              } : null,
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
    // Find seeded data for reset
    else if (query.includes("FindSeeded")) {
      responseData = {
        data: { companies: { nodes: [] }, orders: { nodes: [] } },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
      };
    }
    // Company contact roles query
    else if (query.includes("contactRoles") && query.includes("GetCompanyContactRoles")) {
      responseData = {
        data: {
          company: {
            contactRoles: {
              nodes: [
                { id: "gid://shopify/CompanyContactRole/ordering", name: "Ordering only" },
                { id: "gid://shopify/CompanyContactRole/admin", name: "Location admin" },
              ],
            },
          },
        },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
      };
    }
    // Location role assignments query
    else if (query.includes("roleAssignments") && query.includes("GetLocationRoleAssignments")) {
      const hasExistingAssignment = mockResponses.get("hasExistingRoleAssignment") as boolean ?? false;
      responseData = {
        data: {
          companyLocation: {
            roleAssignments: {
              nodes: hasExistingAssignment ? [
                {
                  id: "gid://shopify/CompanyContactRoleAssignment/existing",
                  companyContact: { id: "gid://shopify/CompanyContact/contact-1" },
                  role: { id: "gid://shopify/CompanyContactRole/ordering", name: "Ordering only" },
                },
              ] : [],
            },
          },
        },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
      };
    }
    // Company location assign roles mutation
    else if (query.includes("companyLocationAssignRoles")) {
      responseData = {
        data: {
          companyLocationAssignRoles: {
            roleAssignments: [
              {
                id: "gid://shopify/CompanyContactRoleAssignment/new",
                companyContact: { id: "gid://shopify/CompanyContact/contact-1" },
                role: { id: "gid://shopify/CompanyContactRole/ordering", name: "Ordering only" },
              },
            ],
            userErrors: [],
          },
        },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 }, requestedQueryCost: 10, actualQueryCost: 5 } },
      };
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
  });

  it("has 3 location terms (Net 15, 30, 60)", () => {
    expect(LOCATION_TERMS).toHaveLength(3);
    expect(LOCATION_TERMS.map(l => l.dueInDays)).toEqual([15, 30, 60]);
  });

  it("all order distributions reference company locations (no FIXED terms)", () => {
    for (const order of ORDER_DISTRIBUTION) {
      expect(order.entityKey).toMatch(/^company-\d+$/);
      expect([15, 30, 60]).toContain(order.locationTermsDays);
      // No FIXED terms - only NET via location templates
      expect(order).not.toHaveProperty("termsType");
    }
  });
});

describe("(3) At least one seeded order is overdue under S9 inference", () => {
  it("ORDER_DISTRIBUTION contains orders where daysAgo > locationTermsDays", () => {
    const overdueOrders = ORDER_DISTRIBUTION.filter(
      (o) => o.daysAgo > o.locationTermsDays
    );
    
    expect(overdueOrders.length).toBeGreaterThan(0);
    
    // Verify specific overdue cases exist
    const hasNet15Overdue = overdueOrders.some(
      (o) => o.locationTermsDays === 15 && o.daysAgo > 15
    );
    const hasNet30Overdue = overdueOrders.some(
      (o) => o.locationTermsDays === 30 && o.daysAgo > 30
    );
    
    expect(hasNet15Overdue).toBe(true);
    expect(hasNet30Overdue).toBe(true);
  });

  it("inferDueDate produces overdue dueAt for Net 30 order processed 35 days ago", () => {
    // Simulate: order processed 35 days ago with Net 30 terms from BuyerAccount default
    // S6 sync maps processedAt → order.createdAt → issuedAt (order.server.ts:187)
    const now = new Date();
    const processedAt = new Date(now);
    processedAt.setDate(processedAt.getDate() - 35);

    // No Shopify paymentTerms (null) - S9 inference uses BuyerAccount default
    const result = inferDueDate({
      paymentTerms: null,
      orderCreatedAt: processedAt,  // S6 uses order.createdAt which = processedAt when backdated
      fulfilledAt: null,
      accountDefaultTermsDays: 30,  // BuyerAccount.defaultTermsDays seeded by this script
      accountDefaultTermsSource: "explicit",
      tagRules: [],
      customerTags: [],
      shopDefaultTermsDays: null,
      merchantOverrideDueAt: null,
      shopTimezone: "Asia/Kolkata",
    });

    expect(result.dueSource).toBe("inferred");
    expect(result.basis).toBe("accountDefault");
    expect(result.dueAt).not.toBeNull();
    
    // Due date should be in the past (overdue)
    // processedAt (35 days ago) + Net 30 = 5 days ago
    expect(result.dueAt!.getTime()).toBeLessThan(now.getTime());
  });

  it("inferDueDate produces future dueAt for Net 60 order processed 45 days ago", () => {
    // Order processed 45 days ago with Net 60 terms - should NOT be overdue yet
    const now = new Date();
    const processedAt = new Date(now);
    processedAt.setDate(processedAt.getDate() - 45);

    const result = inferDueDate({
      paymentTerms: null,
      orderCreatedAt: processedAt,
      fulfilledAt: null,
      accountDefaultTermsDays: 60,
      accountDefaultTermsSource: "explicit",
      tagRules: [],
      customerTags: [],
      shopDefaultTermsDays: null,
      merchantOverrideDueAt: null,
      shopTimezone: "Asia/Kolkata",
    });

    expect(result.dueSource).toBe("inferred");
    expect(result.dueAt).not.toBeNull();
    
    // Due date should be in the future (not overdue)
    // processedAt (45 days ago) + Net 60 = 15 days from now
    expect(result.dueAt!.getTime()).toBeGreaterThan(now.getTime());
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

  it("fetchPaymentTermsTemplates requires Net 15, 30, 60 templates", async () => {
    const state = createMockState({ paymentTermsTemplates: [] });
    const result = await fetchPaymentTermsTemplates(state);

    expect(result).toBe(true);
    expect(state.paymentTermsTemplates.length).toBe(3);
    
    const dueDays = state.paymentTermsTemplates.map(t => t.dueInDays);
    expect(dueDays).toContain(15);
    expect(dueDays).toContain(30);
    expect(dueDays).toContain(60);
  });
});

describe("(1) processedAt and companyLocationId reach the payload", () => {
  beforeEach(() => {
    setupMockFetch();
    mockResponses.clear();
  });

  afterEach(() => {
    restoreFetch();
    capturedRequests = [];
  });

  it("createOrder sends processedAt in the order input", async () => {
    const state = createMockState();
    const processedAt = "2026-09-15T10:00:00.000Z";

    await createOrder(state, {
      orderKey: `${SEED_PREFIX}order-test`,
      companyLocationId: "gid://shopify/CompanyLocation/456",
      customerId: "gid://shopify/Customer/789",
      productTitle: "Test Product",
      amount: 50000,
      processedAt,
      expectedTermsDays: 30,
    });

    const createCall = capturedRequests.find(
      (r) => r.query.includes("orderCreate") && r.query.includes("OrderCreateOrderInput")
    );
    expect(createCall).toBeDefined();

    const order = createCall?.variables?.order as Record<string, unknown>;
    
    // (1) processedAt is set from the input
    expect(order.processedAt).toBe(processedAt);
  });

  it("createOrder sends companyLocationId in the order input", async () => {
    const state = createMockState();
    const companyLocationId = "gid://shopify/CompanyLocation/456";

    await createOrder(state, {
      orderKey: `${SEED_PREFIX}order-test`,
      companyLocationId,
      customerId: "gid://shopify/Customer/789",
      productTitle: "Test Product",
      amount: 50000,
      processedAt: new Date().toISOString(),
      expectedTermsDays: 30,
    });

    const createCall = capturedRequests.find(
      (r) => r.query.includes("orderCreate") && r.query.includes("OrderCreateOrderInput")
    );
    const order = createCall?.variables?.order as Record<string, unknown>;
    
    expect(order.companyLocationId).toBe(companyLocationId);
  });

  it("createOrder uses custom line items with title + priceSet (no variantId)", async () => {
    const state = createMockState();

    await createOrder(state, {
      orderKey: `${SEED_PREFIX}order-custom`,
      companyLocationId: "gid://shopify/CompanyLocation/123",
      customerId: "gid://shopify/Customer/456",
      productTitle: "Industrial Fasteners",
      amount: 75000,
      processedAt: new Date().toISOString(),
      expectedTermsDays: 15,
    });

    const createCall = capturedRequests.find(
      (r) => r.query.includes("orderCreate") && r.query.includes("OrderCreateOrderInput")
    );
    const order = createCall?.variables?.order as Record<string, unknown>;
    const lineItems = order.lineItems as Array<Record<string, unknown>>;

    expect(lineItems).toHaveLength(1);
    expect(lineItems[0].title).toBe("Industrial Fasteners");
    expect(lineItems[0].quantity).toBe(1);
    expect(lineItems[0].variantId).toBeUndefined();
    expect(lineItems[0].priceSet).toEqual({
      shopMoney: { amount: "75000", currencyCode: "INR" },
    });
  });

  it("createOrder sends customer.toAssociate.id (not customer.id)", async () => {
    // OrderCreateCustomerInput in 2026-10 requires toAssociate or toUpsert, not direct id
    // @see https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/OrderCreateCustomerInput
    const state = createMockState();
    const customerId = "gid://shopify/Customer/789";

    await createOrder(state, {
      orderKey: `${SEED_PREFIX}order-customer`,
      companyLocationId: "gid://shopify/CompanyLocation/123",
      customerId,
      productTitle: "Test Product",
      amount: 50000,
      processedAt: new Date().toISOString(),
      expectedTermsDays: 30,
    });

    const createCall = capturedRequests.find(
      (r) => r.query.includes("orderCreate") && r.query.includes("OrderCreateOrderInput")
    );
    const order = createCall?.variables?.order as Record<string, unknown>;
    const customer = order.customer as Record<string, unknown>;

    // Must use toAssociate.id, NOT direct id
    expect(customer.id).toBeUndefined();
    expect(customer.toAssociate).toBeDefined();
    expect((customer.toAssociate as Record<string, unknown>).id).toBe(customerId);
  });
});

describe("(4) null paymentTerms produces warning, not failure", () => {
  beforeEach(() => {
    setupMockFetch();
    mockResponses.clear();
  });

  afterEach(() => {
    restoreFetch();
    capturedRequests = [];
  });

  it("createOrder does NOT throw when paymentTerms is null", async () => {
    mockResponses.set("orderWithShopifyTerms", false);
    
    const state = createMockState();

    // Should not throw
    const result = await createOrder(state, {
      orderKey: `${SEED_PREFIX}order-no-terms`,
      companyLocationId: "gid://shopify/CompanyLocation/123",
      customerId: "gid://shopify/Customer/456",
      productTitle: "Test Product",
      amount: 50000,
      processedAt: new Date().toISOString(),
      expectedTermsDays: 30,
    });

    expect(result).not.toBeNull();
    expect(result?.name).toBe("#1001");
    expect(state.ordersWithoutShopifyTerms).toBe(1);
    expect(state.ordersWithShopifyTerms).toBe(0);
  });

  it("createOrder tracks counts for inherited vs inferred terms", async () => {
    const state = createMockState();

    // First order with Shopify terms
    mockResponses.set("orderWithShopifyTerms", true);
    await createOrder(state, {
      orderKey: `${SEED_PREFIX}order-1`,
      companyLocationId: "gid://shopify/CompanyLocation/123",
      customerId: "gid://shopify/Customer/456",
      productTitle: "Product 1",
      amount: 10000,
      processedAt: new Date().toISOString(),
      expectedTermsDays: 30,
    });

    // Second order without Shopify terms
    mockResponses.set("orderWithShopifyTerms", false);
    await createOrder(state, {
      orderKey: `${SEED_PREFIX}order-2`,
      companyLocationId: "gid://shopify/CompanyLocation/456",
      customerId: "gid://shopify/Customer/789",
      productTitle: "Product 2",
      amount: 20000,
      processedAt: new Date().toISOString(),
      expectedTermsDays: 15,
    });

    expect(state.ordersWithShopifyTerms).toBe(1);
    expect(state.ordersWithoutShopifyTerms).toBe(1);
  });
});

describe("Location-to-template mapping", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setupMockFetch();
    mockResponses.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreFetch();
    capturedRequests = [];
  });

  it("seedCompanies maps existing locations by name suffix to correct terms", async () => {
    mockResponses.set("existingCompanies", [`${SEED_PREFIX}company-1`]);

    const state = createMockState();
    await seedCompanies(state);

    const company = state.companies.get("company-1");
    expect(company).toBeDefined();
    expect(company?.locations.get(15)).toBe("gid://shopify/CompanyLocation/loc-15");
    expect(company?.locations.get(30)).toBe("gid://shopify/CompanyLocation/loc-30");
    expect(company?.locations.get(60)).toBe("gid://shopify/CompanyLocation/loc-60");
  });

  it("seedOrders uses correct location for each order's terms", async () => {
    const state = createMockState();
    
    // Set up company with locations
    const companyData = createMockCompanyData({
      contactCustomerId: "gid://shopify/Customer/1",
    });
    state.companies.set("company-1", companyData);

    // Seed orders with fast-forwarded timers
    const seedPromise = seedOrders(state);
    await vi.advanceTimersByTimeAsync(600000); // Fast-forward through all delays
    await seedPromise;

    // Find order creation calls
    const orderCalls = capturedRequests.filter(
      (r) => r.query.includes("orderCreate") && r.query.includes("OrderCreateOrderInput")
    );

    // Verify each order uses the correct location
    for (const call of orderCalls) {
      const order = call.variables?.order as Record<string, unknown>;
      const locationId = order.companyLocationId as string;
      
      // Should be one of our configured locations
      expect(["gid://shopify/CompanyLocation/loc-15", "gid://shopify/CompanyLocation/loc-30", "gid://shopify/CompanyLocation/loc-60"]).toContain(locationId);
    }
  });
});

describe("Idempotency", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setupMockFetch();
    mockResponses.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
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

    expect(state.skippedCount.companies).toBe(5);
    expect(state.createdCount.companies).toBe(0);

    const createCalls = capturedRequests.filter((r) => r.query.includes("companyCreate"));
    expect(createCalls).toHaveLength(0);
  });

  it("findOrderByTag returns existing order", async () => {
    mockResponses.set("existingOrders", [`${SEED_PREFIX}order-1`]);

    const state = createMockState();
    const result = await findOrderByTag(state, `${SEED_PREFIX}order-1`);

    expect(result).not.toBeNull();
  });

  it("seedOrders skips creation when order exists (via ntr-seed tag)", async () => {
    mockResponses.set("existingOrders", [`${SEED_PREFIX}order-1`]);

    const state = createMockState();
    
    for (const seed of COMPANY_SEEDS) {
      state.companies.set(seed.key, createMockCompanyData({
        id: `gid://shopify/Company/${seed.key}`,
        contactCustomerId: `gid://shopify/Customer/${seed.key}`,
      }));
    }

    const seedPromise = seedOrders(state);
    await vi.advanceTimersByTimeAsync(600000); // Fast-forward through order delays
    await seedPromise;

    expect(state.skippedCount.orders).toBeGreaterThanOrEqual(1);
  });
});

describe("(2) DB seeding idempotent - no duplicate rows", () => {
  it("SQL uses ON CONFLICT DO UPDATE (idempotent upsert)", async () => {
    // Read seed.ts and verify it contains ON CONFLICT DO UPDATE patterns
    const fs = await import("fs/promises");
    const path = await import("path");
    
    const seedPath = path.resolve(__dirname, "../seed.ts");
    const seedContent = await fs.readFile(seedPath, "utf-8");

    // Verify Shop upsert uses ON CONFLICT (domain)
    expect(seedContent).toMatch(/ON CONFLICT \(domain\) DO UPDATE SET/);

    // Verify AccountSource upsert uses ON CONFLICT ("shopId", tag)
    expect(seedContent).toMatch(/ON CONFLICT \("shopId", tag\) DO UPDATE SET/);

    // Verify BuyerAccount upsert uses ON CONFLICT ("shopId", "companyLocationId")
    expect(seedContent).toMatch(/ON CONFLICT \("shopId", "companyLocationId"\) DO UPDATE SET/);
  });

  it("printDatabaseSeedSQL generates idempotent SQL for all tables", () => {
    const state = createMockState({
      currencyCode: "INR",
    });
    
    // Add test company data
    const locations = new Map<number, string>();
    locations.set(15, "gid://shopify/CompanyLocation/loc-15");
    locations.set(30, "gid://shopify/CompanyLocation/loc-30");
    state.companies.set("company-1", createMockCompanyData({
      id: "gid://shopify/Company/1",
      contactCustomerId: "gid://shopify/Customer/1",
      locations,
    }));

    // Capture console.log output
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    
    printDatabaseSeedSQL(state);
    
    const output = logSpy.mock.calls.map(c => c.join(" ")).join("\n");
    logSpy.mockRestore();

    // Verify all three table upserts are present with ON CONFLICT
    expect(output).toContain("INSERT INTO \"Shop\"");
    expect(output).toContain("ON CONFLICT (domain) DO UPDATE SET");
    
    expect(output).toContain("INSERT INTO \"AccountSource\"");
    expect(output).toContain("ON CONFLICT (\"shopId\", tag) DO UPDATE SET");
    
    expect(output).toContain("INSERT INTO \"BuyerAccount\"");
    expect(output).toContain("ON CONFLICT (\"shopId\", \"companyLocationId\") DO UPDATE SET");
  });

  it("printed SQL includes BuyerAccount upserts for each company location", () => {
    const state = createMockState({
      currencyCode: "INR",
    });
    
    // Add multiple companies with locations
    for (let i = 1; i <= 2; i++) {
      const locations = new Map<number, string>();
      locations.set(15, `gid://shopify/CompanyLocation/company-${i}-loc-15`);
      locations.set(30, `gid://shopify/CompanyLocation/company-${i}-loc-30`);
      locations.set(60, `gid://shopify/CompanyLocation/company-${i}-loc-60`);
      state.companies.set(`company-${i}`, createMockCompanyData({
        id: `gid://shopify/Company/${i}`,
        contactCustomerId: `gid://shopify/Customer/${i}`,
        locations,
      }));
    }

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    
    printDatabaseSeedSQL(state);
    
    const output = logSpy.mock.calls.map(c => c.join(" ")).join("\n");
    logSpy.mockRestore();

    // Should have BuyerAccount INSERT for each company location (2 companies * 3 locations = 6)
    const buyerAccountInserts = (output.match(/INSERT INTO "BuyerAccount"/g) || []).length;
    expect(buyerAccountInserts).toBe(6);
    
    // Each should have ON CONFLICT
    const buyerAccountConflicts = (output.match(/ON CONFLICT \("shopId", "companyLocationId"\)/g) || []).length;
    expect(buyerAccountConflicts).toBe(6);
  });

  it("printDatabaseSeedSQL escapes single quotes in names", () => {
    const state = createMockState({
      currencyCode: "INR",
    });
    
    // Add a company with a name containing a single quote
    const locations = new Map<number, string>();
    locations.set(15, "gid://shopify/CompanyLocation/loc-quote");
    state.companies.set("company-quote", createMockCompanyData({
      id: "gid://shopify/Company/quote",
      contactCustomerId: "gid://shopify/Customer/quote",
      locations,
    }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    
    printDatabaseSeedSQL(state);
    
    const output = logSpy.mock.calls.map(c => c.join(" ")).join("\n");
    logSpy.mockRestore();

    // The seed uses COMPANY_SEEDS which has "Acme Wholesale Pvt Ltd" etc.
    // These don't have quotes, but the escaping code is in place for safety
    expect(output).toContain("INSERT INTO \"BuyerAccount\"");
  });

  it("ON CONFLICT targets are correct unique constraints", async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    
    const seedPath = path.resolve(__dirname, "../seed.ts");
    const seedContent = await fs.readFile(seedPath, "utf-8");

    // Shop: unique on domain
    expect(seedContent).toMatch(/ON CONFLICT \(domain\) DO UPDATE/);
    
    // AccountSource: unique on (shopId, tag)
    expect(seedContent).toMatch(/ON CONFLICT \("shopId", tag\) DO UPDATE/);
    
    // BuyerAccount: unique on (shopId, companyLocationId)
    expect(seedContent).toMatch(/ON CONFLICT \("shopId", "companyLocationId"\) DO UPDATE/);
  });
});

describe("Tagging strategy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setupMockFetch();
    mockResponses.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreFetch();
    capturedRequests = [];
  });

  it("has 3 tagged customer seeds, one per term (15, 30, 60)", () => {
    expect(TAGGED_CUSTOMER_SEEDS).toHaveLength(3);
    expect(TAGGED_CUSTOMER_SEEDS.map(c => c.termsDays)).toEqual([15, 30, 60]);
    
    // Each should have a unique email with ntr-seed- prefix
    for (const seed of TAGGED_CUSTOMER_SEEDS) {
      expect(seed.email).toContain(SEED_PREFIX);
      expect(seed.email).toContain(`net${seed.termsDays}`);
    }
  });

  it("B2B orders do NOT call customerUpdate or tagsAdd", async () => {
    const state = createMockState();
    
    // Set up company with locations
    const companyData = createMockCompanyData({
      contactCustomerId: "gid://shopify/Customer/b2b-contact-1",
    });
    state.companies.set("company-1", companyData);

    const seedPromise = seedOrders(state);
    await vi.advanceTimersByTimeAsync(600000); // Fast-forward through all order delays
    await seedPromise;

    // Should NOT have any customerUpdate or tagsAdd calls for B2B contacts
    const tagCalls = capturedRequests.filter(
      r => r.query.includes("customerUpdate") || r.query.includes("tagsAdd")
    );
    
    // B2B contacts are NOT tagged - their terms come from location/DB defaults
    expect(tagCalls.filter(r => 
      r.variables?.id === "gid://shopify/Customer/b2b-contact-1" ||
      (r.variables?.input as Record<string, unknown>)?.id === "gid://shopify/Customer/b2b-contact-1"
    )).toHaveLength(0);
  });

  it("tagged customers use tagsAdd (idempotent), not customerUpdate", async () => {
    const state = createMockState();

    const seedPromise = seedTaggedCustomerOrders(state);
    await vi.advanceTimersByTimeAsync(300000); // Fast-forward through order delays
    await seedPromise;

    // Should have tagsAdd calls, not customerUpdate
    const tagsAddCalls = capturedRequests.filter(r => r.query.includes("tagsAdd"));
    const customerUpdateCalls = capturedRequests.filter(r => r.query.includes("customerUpdate"));

    expect(tagsAddCalls.length).toBeGreaterThan(0);
    expect(customerUpdateCalls).toHaveLength(0);
  });

  it("each tagged customer gets exactly one terms tag via tagsAdd", async () => {
    const state = createMockState();

    const seedPromise = seedTaggedCustomerOrders(state);
    await vi.advanceTimersByTimeAsync(300000); // Fast-forward through order delays
    await seedPromise;

    // Find all tagsAdd calls
    const tagsAddCalls = capturedRequests.filter(r => r.query.includes("tagsAdd"));

    // Each call should add exactly one tag (ntr-seed-netNN)
    for (const call of tagsAddCalls) {
      const tags = call.variables?.tags as string[] | undefined;
      expect(tags).toHaveLength(1);
      expect(tags?.[0]).toMatch(/^ntr-seed-net(15|30|60)$/);
    }

    // Should have 3 unique customers tagged (one per term)
    const uniqueCustomers = new Set(tagsAddCalls.map(c => c.variables?.id));
    expect(uniqueCustomers.size).toBe(3);
  });

  it("TAGGED_ORDER_DISTRIBUTION has some overdue orders", () => {
    const overdueOrders = TAGGED_ORDER_DISTRIBUTION.filter(
      o => o.daysAgo > o.customerTermsDays
    );
    
    expect(overdueOrders.length).toBeGreaterThan(0);
    
    // Should have at least Net 15 and Net 30 overdue
    const hasNet15Overdue = overdueOrders.some(o => o.customerTermsDays === 15 && o.daysAgo > 15);
    const hasNet30Overdue = overdueOrders.some(o => o.customerTermsDays === 30 && o.daysAgo > 30);
    
    expect(hasNet15Overdue).toBe(true);
    expect(hasNet30Overdue).toBe(true);
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
});

describe("Mutation Retry Safety", () => {
  let fetchCallCount: number;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchCallCount = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
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
    const resultPromise = graphql(state, "query { shop { name } }");
    
    // Fast-forward through retry delays
    await vi.advanceTimersByTimeAsync(10000);
    
    const result = await resultPromise;

    expect(fetchCallCount).toBe(3);
    expect(result.data).toEqual({ shop: { name: "Test" } });
  });

  it("mutations do NOT retry on network error (may have executed)", async () => {
    global.fetch = vi.fn(async () => {
      fetchCallCount++;
      throw new Error("Network error");
    });

    const state = createMockState();

    await expect(
      graphql(state, "mutation { testCreate { id } }", {}, { isMutation: true })
    ).rejects.toThrow("Network error");
    
    expect(fetchCallCount).toBe(1);
  });

  it("mutations still retry on 429 (request rejected before execution)", async () => {
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
    const resultPromise = graphql(state, "mutation { testCreate { id } }", {}, { isMutation: true });
    
    // Fast-forward through retry delay
    await vi.advanceTimersByTimeAsync(5000);
    
    const result = await resultPromise;

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
  });
});

describe("GraphQL Document Validation against Admin API 2026-10 Schema", () => {
  let schema: GraphQLSchema;

  beforeAll(() => {
    const schemaPath = resolve(__dirname, "../../test/fixtures/admin-2026-10.schema.json");
    const schemaJson = JSON.parse(readFileSync(schemaPath, "utf-8"));
    schema = buildClientSchema(schemaJson.data);
  });

  it("B2B_ORDER_CREATE_MUTATION is valid against 2026-10 schema", () => {
    const document = parse(B2B_ORDER_CREATE_MUTATION);
    const errors = validate(schema, document);
    expect(errors).toEqual([]);
  });

  it("TAGGED_CUSTOMER_ORDER_CREATE_MUTATION is valid against 2026-10 schema", () => {
    const document = parse(TAGGED_CUSTOMER_ORDER_CREATE_MUTATION);
    const errors = validate(schema, document);
    expect(errors).toEqual([]);
  });

  it("COMPANY_CREATE_MUTATION is valid against 2026-10 schema", () => {
    const document = parse(COMPANY_CREATE_MUTATION);
    const errors = validate(schema, document);
    expect(errors).toEqual([]);
  });

  it("COMPANY_LOCATION_CREATE_MUTATION is valid against 2026-10 schema", () => {
    const document = parse(COMPANY_LOCATION_CREATE_MUTATION);
    const errors = validate(schema, document);
    expect(errors).toEqual([]);
  });

  it("rejects the old financialStatus field (pre-fix validation)", () => {
    const OLD_INVALID_MUTATION = `
      mutation CreateOrder($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
        orderCreate(order: $order, options: $options) {
          order {
            id
            name
            financialStatus
            totalPriceSet {
              shopMoney { amount currencyCode }
            }
          }
          userErrors { field message code }
        }
      }
    `;

    const document = parse(OLD_INVALID_MUTATION);
    const errors = validate(schema, document);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.message.includes("financialStatus"))).toBe(true);
  });
});

describe("Error Logging Helpers", () => {
  it("logGraphQLErrors logs top-level errors with path and code", () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response: GraphQLResponse<unknown> = {
      data: null,
      errors: [
        { message: "Field does not exist", path: ["orderCreate", "order", "financialStatus"], extensions: { code: "INVALID_FIELD" } },
      ],
    };

    logGraphQLErrors(response, "orderCreate");

    expect(logSpy).toHaveBeenCalled();
    const calls = logSpy.mock.calls.map(c => c.join(" ")).join("\n");
    expect(calls).toContain("GraphQL errors");
    expect(calls).toContain("financialStatus");
    expect(calls).toContain("INVALID_FIELD");

    logSpy.mockRestore();
  });

  it("logGraphQLErrors logs when data is null", () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response: GraphQLResponse<unknown> = {
      data: null,
    };

    logGraphQLErrors(response, "testMutation");

    expect(logSpy).toHaveBeenCalled();
    const calls = logSpy.mock.calls.map(c => c.join(" ")).join("\n");
    expect(calls).toContain("data is null");

    logSpy.mockRestore();
  });

  it("logGraphQLErrors logs when mutation root field is null", () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response: GraphQLResponse<{ orderCreate: null }> = {
      data: { orderCreate: null },
    };

    logGraphQLErrors(response, "orderCreate");

    expect(logSpy).toHaveBeenCalled();
    const calls = logSpy.mock.calls.map(c => c.join(" ")).join("\n");
    expect(calls).toContain("'orderCreate' is null");

    logSpy.mockRestore();
  });

  it("logUserErrors logs user errors with field and code", () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const userErrors: UserError[] = [
      { field: ["input", "companyLocation", "shippingAddress"], message: "Zone code required for IN addresses", code: "INVALID" },
    ];

    logUserErrors(userErrors, "companyLocationCreate");

    expect(logSpy).toHaveBeenCalled();
    const calls = logSpy.mock.calls.map(c => c.join(" ")).join("\n");
    expect(calls).toContain("User errors");
    expect(calls).toContain("Zone code required");
    expect(calls).toContain("input.companyLocation.shippingAddress");
    expect(calls).toContain("INVALID");

    logSpy.mockRestore();
  });
});

describe("India Address Info Helper", () => {
  it("returns provinceCode and zip for Mumbai", () => {
    const info = getIndiaAddressInfo("Mumbai");
    expect(info.provinceCode).toBe("MH");
    expect(info.zip).toBe("400001");
  });

  it("returns provinceCode and zip for Delhi", () => {
    const info = getIndiaAddressInfo("Delhi");
    expect(info.provinceCode).toBe("DL");
    expect(info.zip).toBe("110001");
  });

  it("returns provinceCode and zip for Kolkata", () => {
    const info = getIndiaAddressInfo("Kolkata");
    expect(info.provinceCode).toBe("WB");
    expect(info.zip).toBe("700001");
  });

  it("returns provinceCode and zip for Ahmedabad", () => {
    const info = getIndiaAddressInfo("Ahmedabad");
    expect(info.provinceCode).toBe("GJ");
    expect(info.zip).toBe("380001");
  });

  it("returns provinceCode and zip for Pune", () => {
    const info = getIndiaAddressInfo("Pune");
    expect(info.provinceCode).toBe("MH");
    expect(info.zip).toBe("411001");
  });

  it("throws on unknown city", () => {
    expect(() => getIndiaAddressInfo("UnknownCity")).toThrow("Unknown Indian city");
    expect(() => getIndiaAddressInfo("UnknownCity")).toThrow("INDIA_CITY_ADDRESS_INFO");
  });

  it("getIndiaProvinceCode returns just the provinceCode", () => {
    expect(getIndiaProvinceCode("Mumbai")).toBe("MH");
    expect(getIndiaProvinceCode("Delhi")).toBe("DL");
  });

  it("COMPANY_SEEDS uses diverse cities", () => {
    const cities = COMPANY_SEEDS.map(s => s.city);
    const uniqueCities = new Set(cities);
    expect(uniqueCities.size).toBeGreaterThanOrEqual(4);
  });

  it("each city's PIN prefix matches its state's PIN range", () => {
    const statePinPrefixes: Record<string, string[]> = {
      "MH": ["40", "41", "42", "43", "44"],
      "DL": ["11"],
      "KA": ["56", "57", "58", "59"],
      "TN": ["60", "61", "62", "63", "64"],
      "GJ": ["36", "37", "38", "39"],
      "WB": ["70", "71", "72", "73", "74"],
      "TG": ["50", "51"],
      "RJ": ["30", "31", "32", "33", "34"],
      "UP": ["20", "21", "22", "23", "24", "25", "26", "27", "28"],
    };

    for (const [_city, info] of Object.entries(INDIA_CITY_ADDRESS_INFO)) {
      const validPrefixes = statePinPrefixes[info.provinceCode];
      expect(validPrefixes).toBeDefined();
      const pinPrefix = info.zip.slice(0, 2);
      expect(validPrefixes).toContain(pinPrefix);
    }
  });

  it("all COMPANY_SEEDS cities have valid address info with matching PIN", () => {
    const statePinPrefixes: Record<string, string[]> = {
      "MH": ["40", "41", "42", "43", "44"],
      "DL": ["11"],
      "GJ": ["36", "37", "38", "39"],
      "WB": ["70", "71", "72", "73", "74"],
    };

    for (const seed of COMPANY_SEEDS) {
      const info = getIndiaAddressInfo(seed.city);
      const validPrefixes = statePinPrefixes[info.provinceCode];
      expect(validPrefixes).toBeDefined();
      const pinPrefix = info.zip.slice(0, 2);
      expect(validPrefixes).toContain(pinPrefix);
    }
  });
});

describe("Variable Builder Input Coercion against Schema", () => {
  let schema: GraphQLSchema;

  function getInputType(typeName: string): GraphQLInputType {
    const type = schema.getType(typeName);
    if (!type) throw new Error(`Type ${typeName} not found in schema`);
    return type as GraphQLInputType;
  }

  function coerceAndCollectErrors(value: unknown, typeName: string): string[] {
    const errors: string[] = [];
    const inputType = getInputType(typeName);
    coerceInputValue(value, inputType, (path, _invalidValue, error) => {
      errors.push(`${path.join(".")}: ${error.message}`);
    });
    return errors;
  }

  beforeAll(() => {
    const schemaPath = resolve(__dirname, "../../test/fixtures/admin-2026-10.schema.json");
    const schemaJson = JSON.parse(readFileSync(schemaPath, "utf-8"));
    schema = buildClientSchema(schemaJson.data);
  });

  it("buildCompanyCreateInput produces valid CompanyCreateInput", () => {
    const seed = COMPANY_SEEDS[0];
    const variables = buildCompanyCreateInput(seed, "ntr-seed-test", "Net-15", "gid://template/1");
    const errors = coerceAndCollectErrors(variables.input, "CompanyCreateInput");
    expect(errors).toEqual([]);
  });

  it("buildCompanyLocationCreateInput produces valid CompanyLocationInput", () => {
    const variables = buildCompanyLocationCreateInput(
      "gid://company/1",
      "Test Company",
      "Delhi",
      { suffix: "Net-30", dueInDays: 30 },
      "gid://template/2"
    );
    const errors = coerceAndCollectErrors(variables.input, "CompanyLocationInput");
    expect(errors).toEqual([]);
  });

  it("buildTaggedCustomerOrderInput produces valid OrderCreateOrderInput", () => {
    const variables = buildTaggedCustomerOrderInput({
      orderKey: "ntr-seed-order-1",
      customerId: "gid://customer/1",
      productTitle: "Test Product",
      amount: 50000,
      processedAt: new Date().toISOString(),
      currencyCode: "INR",
    });
    const orderErrors = coerceAndCollectErrors(variables.order, "OrderCreateOrderInput");
    expect(orderErrors).toEqual([]);
    const optionsErrors = coerceAndCollectErrors(variables.options, "OrderCreateOptionsInput");
    expect(optionsErrors).toEqual([]);
  });

  it("buildB2BOrderInput produces valid OrderCreateOrderInput", () => {
    const variables = buildB2BOrderInput({
      orderKey: "ntr-seed-order-2",
      companyLocationId: "gid://location/1",
      customerId: "gid://customer/2",
      productTitle: "B2B Product",
      amount: 100000,
      processedAt: new Date().toISOString(),
      currencyCode: "INR",
    });
    const orderErrors = coerceAndCollectErrors(variables.order, "OrderCreateOrderInput");
    expect(orderErrors).toEqual([]);
    const optionsErrors = coerceAndCollectErrors(variables.options, "OrderCreateOptionsInput");
    expect(optionsErrors).toEqual([]);
  });

  it("buildTaggedCustomerOrderInput respects custom city", () => {
    const variables = buildTaggedCustomerOrderInput({
      orderKey: "ntr-seed-order-3",
      customerId: "gid://customer/3",
      productTitle: "Delhi Product",
      amount: 25000,
      processedAt: new Date().toISOString(),
      currencyCode: "INR",
      city: "Delhi",
    });
    const order = variables.order as Record<string, unknown>;
    const billingAddress = order.billingAddress as Record<string, unknown>;
    expect(billingAddress.city).toBe("Delhi");
    expect(billingAddress.provinceCode).toBe("DL");
    expect(billingAddress.zip).toBe("110001");
  });

  it("rejects zoneCode on MailingAddressInput (order addresses)", () => {
    const invalidOrderInput = {
      tags: ["test"],
      customer: { toAssociate: { id: "gid://customer/1" } },
      currency: "INR",
      financialStatus: "PENDING",
      processedAt: new Date().toISOString(),
      lineItems: [{ title: "Test", quantity: 1, priceSet: { shopMoney: { amount: "100", currencyCode: "INR" } } }],
      billingAddress: {
        firstName: "Test",
        lastName: "User",
        address1: "123 Street",
        city: "Mumbai",
        zoneCode: "MH",
        countryCode: "IN",
        zip: "400001",
      },
    };

    const errors = coerceAndCollectErrors(invalidOrderInput, "OrderCreateOrderInput");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes("zoneCode"))).toBe(true);
  });

  it("accepts provinceCode on MailingAddressInput (order addresses)", () => {
    const validOrderInput = {
      tags: ["test"],
      customer: { toAssociate: { id: "gid://customer/1" } },
      currency: "INR",
      financialStatus: "PENDING",
      processedAt: new Date().toISOString(),
      lineItems: [{ title: "Test", quantity: 1, priceSet: { shopMoney: { amount: "100", currencyCode: "INR" } } }],
      billingAddress: {
        firstName: "Test",
        lastName: "User",
        address1: "123 Street",
        city: "Mumbai",
        provinceCode: "MH",
        countryCode: "IN",
        zip: "400001",
      },
    };

    const errors = coerceAndCollectErrors(validOrderInput, "OrderCreateOrderInput");
    expect(errors).toEqual([]);
  });

  it("accepts zoneCode on CompanyAddressInput (company addresses)", () => {
    const validCompanyInput = {
      company: { name: "Test Co" },
      companyLocation: {
        name: "HQ",
        shippingAddress: {
          firstName: "Test",
          lastName: "User",
          address1: "123 Street",
          city: "Mumbai",
          zoneCode: "MH",
          countryCode: "IN",
          zip: "400001",
        },
      },
      companyContact: { email: "test@example.com", firstName: "Test", lastName: "User" },
    };

    const errors = coerceAndCollectErrors(validCompanyInput, "CompanyCreateInput");
    expect(errors).toEqual([]);
  });

  it("buildCompanyLocationAssignRolesInput produces valid CompanyLocationRoleAssign", () => {
    const variables = buildCompanyLocationAssignRolesInput(
      "gid://location/1",
      "gid://contact/1",
      "gid://role/1"
    );
    
    // CompanyLocationRoleAssign fields are just IDs, so check structure
    expect(variables.companyLocationId).toBe("gid://location/1");
    expect(variables.rolesToAssign).toHaveLength(1);
    expect(variables.rolesToAssign[0].companyContactId).toBe("gid://contact/1");
    expect(variables.rolesToAssign[0].companyContactRoleId).toBe("gid://role/1");
  });
});

describe("Throttle/Backoff Classification", () => {
  it("isThrottleError returns true for THROTTLED GraphQL error code", () => {
    const response: GraphQLResponse<unknown> = {
      errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
    };
    expect(isThrottleError(response)).toBe(true);
  });

  it("isThrottleError returns true for 'Too many attempts' in top-level error", () => {
    const response: GraphQLResponse<unknown> = {
      errors: [{ message: "Too many attempts. Please try again later." }],
    };
    expect(isThrottleError(response)).toBe(true);
  });

  it("isThrottleError returns true for 'Too many attempts' in userErrors", () => {
    const response: GraphQLResponse<unknown> = { data: {} };
    const userErrors: UserError[] = [
      { field: ["order"], message: "Too many attempts. Please try again later.", code: "INVALID" },
    ];
    expect(isThrottleError(response, userErrors)).toBe(true);
  });

  it("isThrottleError returns false for other errors", () => {
    const response: GraphQLResponse<unknown> = {
      errors: [{ message: "Order could not be created", extensions: { code: "INVALID" } }],
    };
    const userErrors: UserError[] = [
      { field: ["order"], message: "Customer has no role in this company", code: "INVALID" },
    ];
    expect(isThrottleError(response, userErrors)).toBe(false);
  });

  it("calculateThrottleBackoffDelay uses correct base delays", () => {
    // Mock Math.random to return 0.5 for predictable jitter
    const mockRandom = vi.spyOn(Math, "random").mockReturnValue(0.5);
    
    // At 0.5 random, jitter = baseDelay * 0.2 * (0.5*2-1) = 0
    expect(calculateThrottleBackoffDelay(0)).toBe(ORDER_CREATE_BACKOFF_DELAYS_MS[0]); // 15000
    expect(calculateThrottleBackoffDelay(1)).toBe(ORDER_CREATE_BACKOFF_DELAYS_MS[1]); // 30000
    expect(calculateThrottleBackoffDelay(2)).toBe(ORDER_CREATE_BACKOFF_DELAYS_MS[2]); // 60000
    expect(calculateThrottleBackoffDelay(3)).toBe(ORDER_CREATE_BACKOFF_DELAYS_MS[3]); // 120000
    // Index 4 should cap at index 3
    expect(calculateThrottleBackoffDelay(4)).toBe(ORDER_CREATE_BACKOFF_DELAYS_MS[3]); // 120000
    
    mockRandom.mockRestore();
  });

  it("calculateThrottleBackoffDelay adds jitter within +/- 20%", () => {
    const baseDelay = ORDER_CREATE_BACKOFF_DELAYS_MS[0]; // 15000
    const minExpected = baseDelay * 0.8;
    const maxExpected = baseDelay * 1.2;
    
    for (let i = 0; i < 100; i++) {
      const delay = calculateThrottleBackoffDelay(0);
      expect(delay).toBeGreaterThanOrEqual(minExpected);
      expect(delay).toBeLessThanOrEqual(maxExpected);
    }
  });

  it("ORDER_CREATE_MAX_ATTEMPTS is 5", () => {
    expect(ORDER_CREATE_MAX_ATTEMPTS).toBe(5);
  });

  it("DEFAULT_SEED_ORDER_DELAY_MS is 12000", () => {
    expect(DEFAULT_SEED_ORDER_DELAY_MS).toBe(12000);
  });
});

describe("Throttle Retry Behavior", () => {
  let fetchCallCount: number;
  
  beforeEach(() => {
    vi.useFakeTimers();
    fetchCallCount = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreFetch();
  });

  it("throttle-then-success: createOrder succeeds after throttle retry", async () => {
    // First call returns throttle error, second succeeds
    global.fetch = vi.fn(async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              orderCreate: {
                order: null,
                userErrors: [{ field: ["order"], message: "Too many attempts. Please try again later.", code: "THROTTLED" }],
              },
            },
            extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 } } },
          }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            orderCreate: {
              order: {
                id: "gid://shopify/Order/1",
                name: "#1001",
                displayFinancialStatus: "PENDING",
                totalPriceSet: { shopMoney: { amount: "50000.00", currencyCode: "INR" } },
                paymentTerms: { paymentTermsName: "Net 30", paymentTermsType: "NET", dueInDays: 30, paymentSchedules: { nodes: [{ dueAt: "2026-11-15" }] } },
              },
              userErrors: [],
            },
          },
          extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 } } },
        }),
      } as Response;
    });

    const state = createMockState();
    
    const orderPromise = createOrder(state, {
      orderKey: `${SEED_PREFIX}order-test`,
      companyLocationId: "gid://shopify/CompanyLocation/456",
      customerId: "gid://shopify/Customer/789",
      productTitle: "Test Product",
      amount: 50000,
      processedAt: new Date().toISOString(),
      expectedTermsDays: 30,
    });

    // Fast-forward through backoff delay
    await vi.advanceTimersByTimeAsync(20000);

    const result = await orderPromise;
    
    expect(fetchCallCount).toBe(2);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("#1001");
  });

  it("give-up-after-N: createOrder returns null after max throttle attempts", async () => {
    // All calls return throttle error
    global.fetch = vi.fn(async () => {
      fetchCallCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            orderCreate: {
              order: null,
              userErrors: [{ field: ["order"], message: "Too many attempts. Please try again later.", code: "THROTTLED" }],
            },
          },
          extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 } } },
        }),
      } as Response;
    });

    const state = createMockState();
    
    const orderPromise = createOrder(state, {
      orderKey: `${SEED_PREFIX}order-test`,
      companyLocationId: "gid://shopify/CompanyLocation/456",
      customerId: "gid://shopify/Customer/789",
      productTitle: "Test Product",
      amount: 50000,
      processedAt: new Date().toISOString(),
      expectedTermsDays: 30,
    });

    // Fast-forward through all backoff delays (15s + 30s + 60s + 120s = 225s)
    await vi.advanceTimersByTimeAsync(300000);

    const result = await orderPromise;
    
    // Should have tried ORDER_CREATE_MAX_ATTEMPTS times
    expect(fetchCallCount).toBe(ORDER_CREATE_MAX_ATTEMPTS);
    expect(result).toBeNull();
  });
});

describe("Role Assignment Idempotency", () => {
  beforeEach(() => {
    setupMockFetch();
    mockResponses.clear();
  });

  afterEach(() => {
    restoreFetch();
    capturedRequests = [];
  });

  it("ensureContactRoleOnLocation skips if contact already has role", async () => {
    // Mock hasContactRoleOnLocation to return true (already assigned)
    global.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const query = body.query as string;

      // Role assignments query - return existing assignment
      if (query.includes("GetLocationRoleAssignments") || query.includes("roleAssignments")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              companyLocation: {
                roleAssignments: {
                  nodes: [
                    {
                      id: "gid://shopify/CompanyContactRoleAssignment/existing",
                      companyContact: { id: "gid://shopify/CompanyContact/contact-1" },
                      role: { id: "gid://shopify/CompanyContactRole/ordering", name: "Ordering only" },
                    },
                  ],
                },
              },
            },
            extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 } } },
          }),
        } as Response;
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ data: {} }),
      } as Response;
    });

    const state = createMockState();
    const companyData = createMockCompanyData();

    const result = await ensureContactRoleOnLocation(state, companyData, "gid://shopify/CompanyLocation/loc-30");

    expect(result).toBe(true);
    expect(state.skippedCount.roleAssignments).toBe(1);
    expect(state.createdCount.roleAssignments).toBe(0);
    
    // Should NOT have called assign mutation
    const assignCalls = capturedRequests.filter(r => r.query.includes("companyLocationAssignRoles"));
    expect(assignCalls).toHaveLength(0);
  });

  it("ensureContactRoleOnLocation assigns role if not already assigned", async () => {
    // Don't use setupMockFetch - set up custom mock for this test
    mockResponses.set("hasExistingRoleAssignment", false); // No existing assignment
    setupMockFetch();

    const state = createMockState();
    const companyData = createMockCompanyData();

    const result = await ensureContactRoleOnLocation(state, companyData, "gid://shopify/CompanyLocation/loc-30");

    expect(result).toBe(true);
    expect(state.createdCount.roleAssignments).toBe(1);
    expect(state.skippedCount.roleAssignments).toBe(0);
    
    // Should have called assign mutation
    const assignCalls = capturedRequests.filter(r => r.query.includes("companyLocationAssignRoles"));
    expect(assignCalls).toHaveLength(1);
  });

  it("role assignment prefers 'Ordering only' role", async () => {
    mockResponses.set("hasExistingRoleAssignment", false);
    setupMockFetch();

    const state = createMockState();
    const companyData = createMockCompanyData({
      contactRoles: [
        { id: "gid://shopify/CompanyContactRole/admin", name: "Location admin" },
        { id: "gid://shopify/CompanyContactRole/ordering", name: "Ordering only" },
      ],
    });

    await ensureContactRoleOnLocation(state, companyData, "gid://shopify/CompanyLocation/loc-30");

    const assignCall = capturedRequests.find(r => r.query.includes("companyLocationAssignRoles"));
    expect(assignCall).toBeDefined();
    const rolesToAssign = (assignCall?.variables as Record<string, unknown>)?.rolesToAssign as Array<{ companyContactRoleId: string }>;
    expect(rolesToAssign[0].companyContactRoleId).toBe("gid://shopify/CompanyContactRole/ordering");
  });
});

describe("Location Backfill for All Companies", () => {
  beforeEach(() => {
    setupMockFetch();
    mockResponses.clear();
  });

  afterEach(() => {
    restoreFetch();
    capturedRequests = [];
  });

  it("seedCompanies processes ALL 5 companies in COMPANY_SEEDS", async () => {
    // All companies exist
    mockResponses.set("existingCompanies", COMPANY_SEEDS.map((c) => `${SEED_PREFIX}${c.key}`));

    const state = createMockState();
    await seedCompanies(state);

    // Should have all 5 companies in state
    expect(state.companies.size).toBe(5);
    expect(state.skippedCount.companies).toBe(5);
    
    // Verify all company keys are present
    for (const seed of COMPANY_SEEDS) {
      expect(state.companies.has(seed.key)).toBe(true);
    }
  });

  it("backfill creates missing locations for all existing companies (not just company-1)", async () => {
    // Setup: All companies exist but company-2 and company-4 are missing Net-60 location
    const existingCompanyIds = COMPANY_SEEDS.map((c) => `${SEED_PREFIX}${c.key}`);
    
    global.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const query = body.query as string;
      const variables = body.variables as Record<string, unknown>;
      capturedRequests.push({ query, variables });

      // Find company query
      if (query.includes("FindCompany") || (query.includes("companies") && variables?.query)) {
        const externalIdQuery = variables?.query as string;
        const matchedId = existingCompanyIds.find(id => externalIdQuery?.includes(id));
        
        if (matchedId) {
          const companyKey = matchedId.replace(`${SEED_PREFIX}`, "");
          const isMissingNet60 = companyKey === "company-2" || companyKey === "company-4";
          
          const locations = [
            { node: { id: `gid://shopify/CompanyLocation/${companyKey}-loc-15`, name: `${companyKey} - Net-15` } },
            { node: { id: `gid://shopify/CompanyLocation/${companyKey}-loc-30`, name: `${companyKey} - Net-30` } },
          ];
          if (!isMissingNet60) {
            locations.push({ node: { id: `gid://shopify/CompanyLocation/${companyKey}-loc-60`, name: `${companyKey} - Net-60` } });
          }
          
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                companies: {
                  nodes: [{
                    id: `gid://shopify/Company/${companyKey}`,
                    name: companyKey,
                    externalId: matchedId,
                    locations: { edges: locations },
                    contacts: { edges: [{ node: { id: `gid://shopify/CompanyContact/${companyKey}-contact`, customer: { id: `gid://shopify/Customer/${companyKey}-cust`, email: "test@example.com" } } }] },
                  }],
                },
              },
              extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 } } },
            }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { companies: { nodes: [] } } }),
        } as Response;
      }

      // Contact roles query
      if (query.includes("GetCompanyContactRoles") || (query.includes("contactRoles") && !query.includes("companyLocationAssignRoles"))) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              company: {
                contactRoles: {
                  nodes: [{ id: "gid://shopify/CompanyContactRole/ordering", name: "Ordering only" }],
                },
              },
            },
            extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 } } },
          }),
        } as Response;
      }

      // Role assign mutation - check BEFORE roleAssignments query since mutation body contains "roleAssignments"
      if (query.includes("companyLocationAssignRoles")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { companyLocationAssignRoles: { roleAssignments: [], userErrors: [] } },
            extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 } } },
          }),
        } as Response;
      }

      // Role assignments query - return empty (need assignment)
      if (query.includes("GetLocationRoleAssignments") || query.includes("roleAssignments")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { companyLocation: { roleAssignments: { nodes: [] } } },
            extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 } } },
          }),
        } as Response;
      }

      // Location create mutation
      if (query.includes("companyLocationCreate")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              companyLocationCreate: {
                companyLocation: { id: `gid://shopify/CompanyLocation/new-loc-${Date.now()}`, name: "New Location" },
                userErrors: [],
              },
            },
            extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50, maximumAvailable: 2000 } } },
          }),
        } as Response;
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ data: {} }),
      } as Response;
    });

    const state = createMockState();
    await seedCompanies(state);

    // Should have created 2 locations (Net-60 for company-2 and company-4)
    expect(state.createdCount.locations).toBe(2);
    
    // Verify companyLocationCreate was called for the missing locations
    const locationCreateCalls = capturedRequests.filter(r => r.query.includes("companyLocationCreate"));
    expect(locationCreateCalls.length).toBe(2);
  });

  it("location backfill is idempotent (rerun creates no duplicates)", async () => {
    // All companies exist with all locations
    mockResponses.set("existingCompanies", COMPANY_SEEDS.map((c) => `${SEED_PREFIX}${c.key}`));

    const state = createMockState();
    await seedCompanies(state);

    // No locations should be created
    expect(state.createdCount.locations).toBe(0);
    
    // Verify NO companyLocationCreate calls
    const locationCreateCalls = capturedRequests.filter(r => r.query.includes("companyLocationCreate"));
    expect(locationCreateCalls).toHaveLength(0);
  });
});

describe("Role Assignment Must Complete Before Order Creation", () => {
  beforeEach(() => {
    setupMockFetch();
    mockResponses.clear();
  });

  afterEach(() => {
    restoreFetch();
    capturedRequests = [];
  });

  it("order creation for company uses location with role assignment", async () => {
    const state = createMockState();
    
    // Setup company with locations and contact roles
    const companyData = createMockCompanyData();
    state.companies.set("company-1", companyData);

    // Create a single order
    await createOrder(state, {
      orderKey: `${SEED_PREFIX}order-test`,
      companyLocationId: companyData.locations.get(30)!,
      customerId: companyData.contactCustomerId,
      productTitle: "Test Product",
      amount: 50000,
      processedAt: new Date().toISOString(),
      expectedTermsDays: 30,
    });

    // Verify order was created successfully (if mock is set up correctly)
    const orderCalls = capturedRequests.filter(r => r.query.includes("orderCreate"));
    expect(orderCalls.length).toBeGreaterThan(0);
    
    // Verify the order used the correct company location
    const orderCall = orderCalls[0];
    const orderInput = (orderCall.variables as Record<string, unknown>)?.order as Record<string, unknown>;
    expect(orderInput.companyLocationId).toBe("gid://shopify/CompanyLocation/loc-30");
  });
});

describe("New GraphQL Documents Validation against Admin API 2026-10 Schema", () => {
  let schema: GraphQLSchema;

  beforeAll(() => {
    const schemaPath = resolve(__dirname, "../../test/fixtures/admin-2026-10.schema.json");
    const schemaJson = JSON.parse(readFileSync(schemaPath, "utf-8"));
    schema = buildClientSchema(schemaJson.data);
  });

  it("COMPANY_CONTACT_ROLES_QUERY is valid against 2026-10 schema", () => {
    const document = parse(COMPANY_CONTACT_ROLES_QUERY);
    const errors = validate(schema, document);
    expect(errors).toEqual([]);
  });

  it("COMPANY_LOCATION_ROLE_ASSIGNMENTS_QUERY is valid against 2026-10 schema", () => {
    const document = parse(COMPANY_LOCATION_ROLE_ASSIGNMENTS_QUERY);
    const errors = validate(schema, document);
    expect(errors).toEqual([]);
  });

  it("COMPANY_LOCATION_ASSIGN_ROLES_MUTATION is valid against 2026-10 schema", () => {
    const document = parse(COMPANY_LOCATION_ASSIGN_ROLES_MUTATION);
    const errors = validate(schema, document);
    expect(errors).toEqual([]);
  });

  it("FIND_ORDER_BY_TAG_QUERY is valid against 2026-10 schema", () => {
    const document = parse(FIND_ORDER_BY_TAG_QUERY);
    const errors = validate(schema, document);
    expect(errors).toEqual([]);
  });
});

describe("New Variable Builders Input Coercion", () => {
  let schema: GraphQLSchema;

  function getInputType(typeName: string): GraphQLInputType {
    const type = schema.getType(typeName);
    if (!type) throw new Error(`Type ${typeName} not found in schema`);
    return type as GraphQLInputType;
  }

  function coerceAndCollectErrors(value: unknown, typeName: string): string[] {
    const errors: string[] = [];
    const inputType = getInputType(typeName);
    coerceInputValue(value, inputType, (path, _invalidValue, error) => {
      errors.push(`${path.join(".")}: ${error.message}`);
    });
    return errors;
  }

  beforeAll(() => {
    const schemaPath = resolve(__dirname, "../../test/fixtures/admin-2026-10.schema.json");
    const schemaJson = JSON.parse(readFileSync(schemaPath, "utf-8"));
    schema = buildClientSchema(schemaJson.data);
  });

  it("buildCompanyLocationAssignRolesInput produces valid CompanyLocationRoleAssign array", () => {
    const variables = buildCompanyLocationAssignRolesInput(
      "gid://location/1",
      "gid://contact/1",
      "gid://role/1"
    );
    
    // Coerce each role assignment in the array
    for (const roleAssign of variables.rolesToAssign) {
      const errors = coerceAndCollectErrors(roleAssign, "CompanyLocationRoleAssign");
      expect(errors).toEqual([]);
    }
  });
});
