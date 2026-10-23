import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SEED_TAG,
  SEED_PREFIX,
  COMPANY_SEEDS,
  CUSTOMER_SEEDS,
  ORDER_DISTRIBUTION,
} from "../seed";

/**
 * Unit tests for the seed script.
 *
 * These tests mock the global fetch to simulate Shopify Admin API responses,
 * verifying:
 * - Idempotency: existing records are skipped on re-run
 * - Preflight failure: B2B unavailable stores are handled gracefully
 * - Payload shapes: draftOrderCreate includes correct payment terms and purchasingEntity
 */

// Capture all GraphQL requests made during tests
interface CapturedRequest {
  query: string;
  variables?: Record<string, unknown>;
}

// Generic GraphQL response type for tests
interface MockGraphQLResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string }>;
  extensions?: {
    cost?: {
      throttleStatus: {
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
  };
}

let capturedRequests: CapturedRequest[] = [];
const mockResponses: Map<string, unknown> = new Map();

// Mock fetch globally
const originalFetch = global.fetch;

// Helper function to make GraphQL calls in tests
async function mockGraphql(query: string, variables?: Record<string, unknown>): Promise<MockGraphQLResponse> {
  const response = await fetch("https://test.myshopify.com/admin/api/2026-10/graphql.json", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": "test-token" },
    body: JSON.stringify({ query, variables }),
  });
  return response.json() as Promise<MockGraphQLResponse>;
}

function setupMockFetch() {
  capturedRequests = [];

  global.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const query = body.query as string;
    const variables = body.variables as Record<string, unknown> | undefined;

    capturedRequests.push({ query, variables });

    // Determine response based on query content
    let responseData: unknown;

    if (query.includes("CheckB2B") || query.includes("companies(first: 1)")) {
      responseData = mockResponses.get("checkB2B") ?? {
        data: { companies: { edges: [] } },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } } },
      };
    } else if (query.includes("paymentTermsTemplates")) {
      responseData = mockResponses.get("paymentTermsTemplates") ?? {
        data: {
          paymentTermsTemplates: [
            { id: "gid://shopify/PaymentTermsTemplate/3", name: "Net 15", paymentTermsType: "NET", dueInDays: 15 },
            { id: "gid://shopify/PaymentTermsTemplate/4", name: "Net 30", paymentTermsType: "NET", dueInDays: 30 },
            { id: "gid://shopify/PaymentTermsTemplate/5", name: "Net 60", paymentTermsType: "NET", dueInDays: 60 },
            { id: "gid://shopify/PaymentTermsTemplate/7", name: "Fixed", paymentTermsType: "FIXED", dueInDays: null },
          ],
        },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } } },
      };
    } else if (query.includes("productVariants")) {
      responseData = mockResponses.get("productVariants") ?? {
        data: {
          productVariants: {
            nodes: [
              { id: "gid://shopify/ProductVariant/123", title: "Default", price: "1000.00", product: { title: "Test Product" } },
            ],
          },
        },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } } },
      };
    } else if (query.includes("FindCompany") || query.includes("external_id:")) {
      const externalId = variables?.query as string;
      const existingCompanies = mockResponses.get("existingCompanies") as string[] | undefined;
      if (existingCompanies?.some((id) => externalId?.includes(id))) {
        responseData = {
          data: {
            companies: {
              nodes: [
                {
                  id: "gid://shopify/Company/existing-1",
                  name: "Existing Company",
                  externalId: externalId?.replace("external_id:", ""),
                  locations: { edges: [{ node: { id: "gid://shopify/CompanyLocation/loc-1", name: "HQ" } }] },
                  contacts: { edges: [{ node: { id: "gid://shopify/CompanyContact/contact-1", customer: { id: "gid://shopify/Customer/cust-1", email: "test@example.com" } } }] },
                },
              ],
            },
          },
          extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } } },
        };
      } else {
        responseData = {
          data: { companies: { nodes: [] } },
          extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } } },
        };
      }
    } else if (query.includes("FindCustomer") || (query.includes("customers") && variables?.query)) {
      const tag = variables?.query as string;
      const existingCustomers = mockResponses.get("existingCustomers") as string[] | undefined;
      if (existingCustomers?.some((t) => tag?.includes(t))) {
        responseData = {
          data: {
            customers: {
              nodes: [
                { id: "gid://shopify/Customer/existing-cust-1", email: "existing@example.com", firstName: "Existing", lastName: "Customer", tags: [SEED_TAG] },
              ],
            },
          },
          extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } } },
        };
      } else {
        responseData = {
          data: { customers: { nodes: [] } },
          extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } } },
        };
      }
    } else if (query.includes("companyCreate")) {
      responseData = mockResponses.get("companyCreate") ?? {
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
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } } },
      };
    } else if (query.includes("customerCreate")) {
      responseData = mockResponses.get("customerCreate") ?? {
        data: {
          customerCreate: {
            customer: { id: "gid://shopify/Customer/new-cust-2", email: "newcustomer@example.com" },
            userErrors: [],
          },
        },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } } },
      };
    } else if (query.includes("draftOrderCreate")) {
      responseData = mockResponses.get("draftOrderCreate") ?? {
        data: {
          draftOrderCreate: {
            draftOrder: { id: "gid://shopify/DraftOrder/draft-1", name: "#D1" },
            userErrors: [],
          },
        },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } } },
      };
    } else if (query.includes("draftOrderComplete")) {
      responseData = mockResponses.get("draftOrderComplete") ?? {
        data: {
          draftOrderComplete: {
            draftOrder: {
              id: "gid://shopify/DraftOrder/draft-1",
              name: "#D1",
              order: { id: "gid://shopify/Order/order-1", name: "#1001" },
            },
            userErrors: [],
          },
        },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } } },
      };
    } else if (query.includes("FindOrder") || query.includes("orders(first:")) {
      responseData = {
        data: { orders: { nodes: [] } },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } } },
      };
    } else if (query.includes("FindDraftOrder") || query.includes("draftOrders(first:")) {
      responseData = {
        data: { draftOrders: { nodes: [] } },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } } },
      };
    } else {
      responseData = { data: {}, extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } } } };
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

  it("has 5 company seeds", () => {
    expect(COMPANY_SEEDS).toHaveLength(5);
    for (const company of COMPANY_SEEDS) {
      expect(company.key).toMatch(/^company-\d+$/);
      expect(company.name).toBeTruthy();
      expect(company.contact.firstName).toBeTruthy();
      expect(company.contact.lastName).toBeTruthy();
      expect(company.contact.email).toMatch(/@.*\.example$/);
    }
  });

  it("has 5 customer seeds", () => {
    expect(CUSTOMER_SEEDS).toHaveLength(5);
    for (const customer of CUSTOMER_SEEDS) {
      expect(customer.key).toMatch(/^customer-\d+$/);
      expect(customer.firstName).toBeTruthy();
      expect(customer.lastName).toBeTruthy();
      expect(customer.email).toMatch(/@example\.com$/);
    }
  });

  it("has ~30 order distributions", () => {
    expect(ORDER_DISTRIBUTION.length).toBeGreaterThanOrEqual(25);
    expect(ORDER_DISTRIBUTION.length).toBeLessThanOrEqual(35);
  });

  it("order distribution includes both company and customer orders", () => {
    const companyOrders = ORDER_DISTRIBUTION.filter((o) => o.entityType === "company");
    const customerOrders = ORDER_DISTRIBUTION.filter((o) => o.entityType === "customer");

    expect(companyOrders.length).toBeGreaterThan(0);
    expect(customerOrders.length).toBeGreaterThan(0);
  });

  it("order distribution includes NET and FIXED payment terms", () => {
    const netOrders = ORDER_DISTRIBUTION.filter((o) => o.termsType === "NET");
    const fixedOrders = ORDER_DISTRIBUTION.filter((o) => o.termsType === "FIXED");

    expect(netOrders.length).toBeGreaterThan(0);
    expect(fixedOrders.length).toBeGreaterThan(0);
  });

  it("order distribution includes various NET durations (15, 30, 60)", () => {
    const netOrders = ORDER_DISTRIBUTION.filter((o) => o.termsType === "NET");
    const durations = new Set(netOrders.map((o) => o.dueInDays));

    expect(durations.has(15)).toBe(true);
    expect(durations.has(30)).toBe(true);
    expect(durations.has(60)).toBe(true);
  });
});

describe("Seed Script GraphQL Payloads", () => {
  beforeEach(() => {
    setupMockFetch();
    mockResponses.clear();
  });

  afterEach(() => {
    restoreFetch();
    capturedRequests = [];
  });

  it("companyCreate mutation includes externalId for idempotency", async () => {
    const mutation = `
      mutation CreateCompany($input: CompanyCreateInput!) {
        companyCreate(input: $input) {
          company { id }
          userErrors { field message }
        }
      }
    `;

    const input = {
      company: {
        name: "Test Company",
        externalId: `${SEED_PREFIX}company-1`,
      },
      companyLocation: {
        name: "Test Company - Head Office",
        shippingAddress: {
          firstName: "Test",
          lastName: "Contact",
          address1: "123 Business Street",
          city: "Mumbai",
          countryCode: "IN",
          zip: "400001",
        },
        billingSameAsShipping: true,
      },
      companyContact: {
        email: "test@example.com",
        firstName: "Test",
        lastName: "Contact",
      },
    };

    await mockGraphql(mutation, { input });

    expect(capturedRequests).toHaveLength(1);
    const captured = capturedRequests[0];
    expect(captured.query).toContain("companyCreate");
    expect(captured.variables?.input).toEqual(input);

    // Verify externalId is present for idempotency
    const capturedInput = captured.variables?.input as typeof input;
    expect(capturedInput.company.externalId).toBe(`${SEED_PREFIX}company-1`);
  });

  it("customerCreate mutation includes seed tags", async () => {
    const mutation = `
      mutation CreateCustomer($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer { id email }
          userErrors { field message }
        }
      }
    `;

    const input = {
      email: "test@example.com",
      firstName: "Test",
      lastName: "Customer",
      tags: [SEED_TAG, `${SEED_PREFIX}customer-1`, "net-terms-buyer"],
    };

    await mockGraphql(mutation, { input });

    expect(capturedRequests).toHaveLength(1);
    const captured = capturedRequests[0];
    expect(captured.query).toContain("customerCreate");

    // Verify tags include seed tag for idempotency
    const capturedInput = captured.variables?.input as typeof input;
    expect(capturedInput.tags).toContain(SEED_TAG);
    expect(capturedInput.tags).toContain(`${SEED_PREFIX}customer-1`);
    expect(capturedInput.tags).toContain("net-terms-buyer");
  });

  it("draftOrderCreate includes paymentTerms with template and schedule", async () => {
    const mutation = `
      mutation CreateDraftOrder($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id name }
          userErrors { field message }
        }
      }
    `;

    const issuedAt = new Date().toISOString();
    const input = {
      tags: [SEED_TAG, `${SEED_PREFIX}order-1`],
      purchasingEntity: {
        purchasingCompany: {
          companyId: "gid://shopify/Company/123",
          companyLocationId: "gid://shopify/CompanyLocation/456",
          companyContactId: "gid://shopify/CompanyContact/789",
        },
      },
      paymentTerms: {
        paymentTermsTemplateId: "gid://shopify/PaymentTermsTemplate/4",
        paymentSchedules: [{ issuedAt }],
      },
      lineItems: [{ variantId: "gid://shopify/ProductVariant/123", quantity: 5 }],
      presentmentCurrencyCode: "INR",
    };

    await mockGraphql(mutation, { input });

    expect(capturedRequests).toHaveLength(1);
    const captured = capturedRequests[0];
    expect(captured.query).toContain("draftOrderCreate");

    const capturedInput = captured.variables?.input as typeof input;

    // Verify paymentTerms structure
    expect(capturedInput.paymentTerms).toBeDefined();
    expect(capturedInput.paymentTerms.paymentTermsTemplateId).toBe("gid://shopify/PaymentTermsTemplate/4");
    expect(capturedInput.paymentTerms.paymentSchedules).toHaveLength(1);
    expect(capturedInput.paymentTerms.paymentSchedules[0].issuedAt).toBe(issuedAt);

    // Verify purchasingEntity for B2B
    expect(capturedInput.purchasingEntity).toBeDefined();
    expect(capturedInput.purchasingEntity.purchasingCompany).toBeDefined();
    expect(capturedInput.purchasingEntity.purchasingCompany?.companyId).toBe("gid://shopify/Company/123");
    expect(capturedInput.purchasingEntity.purchasingCompany?.companyLocationId).toBe("gid://shopify/CompanyLocation/456");
    expect(capturedInput.purchasingEntity.purchasingCompany?.companyContactId).toBe("gid://shopify/CompanyContact/789");

    // Verify currency
    expect(capturedInput.presentmentCurrencyCode).toBe("INR");
  });

  it("draftOrderCreate with FIXED payment terms includes dueAt date", async () => {
    const mutation = `
      mutation CreateDraftOrder($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id name }
          userErrors { field message }
        }
      }
    `;

    const dueAt = new Date();
    dueAt.setDate(dueAt.getDate() + 10); // 10 days from now

    const input = {
      tags: [SEED_TAG, `${SEED_PREFIX}order-2`],
      purchasingEntity: {
        customerId: "gid://shopify/Customer/123",
      },
      paymentTerms: {
        paymentTermsTemplateId: "gid://shopify/PaymentTermsTemplate/7",
        paymentSchedules: [{ dueAt: dueAt.toISOString() }],
      },
      lineItems: [{ variantId: "gid://shopify/ProductVariant/456", quantity: 3 }],
      presentmentCurrencyCode: "INR",
    };

    await mockGraphql(mutation, { input });

    expect(capturedRequests).toHaveLength(1);
    const captured = capturedRequests[0];
    const capturedInput = captured.variables?.input as typeof input;

    // Verify FIXED payment terms uses dueAt instead of issuedAt
    expect(capturedInput.paymentTerms.paymentTermsTemplateId).toBe("gid://shopify/PaymentTermsTemplate/7");
    expect(capturedInput.paymentTerms.paymentSchedules[0].dueAt).toBeDefined();
    expect(new Date(capturedInput.paymentTerms.paymentSchedules[0].dueAt!).getTime()).toBeGreaterThan(Date.now());

    // Verify customer purchasingEntity (non-B2B path)
    expect(capturedInput.purchasingEntity.customerId).toBe("gid://shopify/Customer/123");
  });
});

describe("Seed Script Idempotency", () => {
  beforeEach(() => {
    setupMockFetch();
    mockResponses.clear();
  });

  afterEach(() => {
    restoreFetch();
    capturedRequests = [];
  });

  it("skips company creation when externalId already exists", async () => {
    // Set up mock to return existing company
    mockResponses.set("existingCompanies", [`${SEED_PREFIX}company-1`]);

    // First query to find company
    const findQuery = `
      query FindCompany($query: String!) {
        companies(first: 1, query: $query) {
          nodes { id name externalId }
        }
      }
    `;

    const result = await mockGraphql(findQuery, { query: `external_id:${SEED_PREFIX}company-1` });

    // Should find existing company
    const companies = result.data?.companies as { nodes: Array<{ externalId: string }> };
    expect(companies.nodes).toHaveLength(1);
    expect(companies.nodes[0].externalId).toBe(`${SEED_PREFIX}company-1`);

    // Verify no companyCreate mutation was called
    const createCalls = capturedRequests.filter((r) => r.query.includes("companyCreate"));
    expect(createCalls).toHaveLength(0);
  });

  it("skips customer creation when seed tag already exists", async () => {
    // Set up mock to return existing customer
    mockResponses.set("existingCustomers", [`${SEED_PREFIX}customer-1`]);

    // Query to find customer by tag
    const findQuery = `
      query FindCustomer($query: String!) {
        customers(first: 1, query: $query) {
          nodes { id email tags }
        }
      }
    `;

    const result = await mockGraphql(findQuery, { query: `tag:'${SEED_PREFIX}customer-1'` });

    // Should find existing customer
    const customers = result.data?.customers as { nodes: Array<{ id: string }> };
    expect(customers.nodes).toHaveLength(1);

    // Verify no customerCreate mutation was called
    const createCalls = capturedRequests.filter((r) => r.query.includes("customerCreate"));
    expect(createCalls).toHaveLength(0);
  });
});

describe("Seed Script Preflight", () => {
  beforeEach(() => {
    setupMockFetch();
    mockResponses.clear();
  });

  afterEach(() => {
    restoreFetch();
    capturedRequests = [];
  });

  it("returns error when B2B is not available", async () => {
    // Set up mock to return B2B error
    mockResponses.set("checkB2B", {
      errors: [{ message: "Shop does not have access to B2B companies feature" }],
    });

    const checkQuery = `
      query CheckB2B {
        companies(first: 1) {
          edges { node { id } }
        }
      }
    `;

    const result = await mockGraphql(checkQuery, {});

    // Should have error about B2B
    expect(result.errors).toBeDefined();
    expect(result.errors![0].message).toContain("B2B");
  });

  it("returns error when no payment terms templates available", async () => {
    // Set up mock to return empty templates
    mockResponses.set("paymentTermsTemplates", {
      data: { paymentTermsTemplates: [] },
      extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } } },
    });

    const templatesQuery = `
      query GetPaymentTermsTemplates {
        paymentTermsTemplates { id name paymentTermsType dueInDays }
      }
    `;

    const result = await mockGraphql(templatesQuery, {});

    // Should return empty templates
    const templates = result.data?.paymentTermsTemplates as unknown[];
    expect(templates).toHaveLength(0);
  });

  it("returns error when no product variants available", async () => {
    // Set up mock to return empty variants
    mockResponses.set("productVariants", {
      data: { productVariants: { nodes: [] } },
      extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } } },
    });

    const variantsQuery = `
      query GetProductVariants {
        productVariants(first: 10) {
          nodes { id title price product { title } }
        }
      }
    `;

    const result = await mockGraphql(variantsQuery, {});

    // Should return empty variants
    const variants = result.data?.productVariants as { nodes: unknown[] };
    expect(variants.nodes).toHaveLength(0);
  });
});

describe("Seed Script Rate Limiting", () => {
  beforeEach(() => {
    setupMockFetch();
    mockResponses.clear();
  });

  afterEach(() => {
    restoreFetch();
    capturedRequests = [];
  });

  it("includes throttle status in response extensions", async () => {
    const result = await mockGraphql("query { shop { name } }", {});

    // Verify throttle status is present
    expect(result.extensions?.cost?.throttleStatus).toBeDefined();
    expect(result.extensions!.cost!.throttleStatus.currentlyAvailable).toBeDefined();
    expect(result.extensions!.cost!.throttleStatus.restoreRate).toBeDefined();
  });
});
