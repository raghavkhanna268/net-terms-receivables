#!/usr/bin/env tsx
/**
 * Seed script for Net Terms Receivables dev store.
 *
 * Creates B2B companies and orders with payment terms for testing the app's
 * receivables tracking features.
 *
 * SCOPE REQUIREMENTS:
 * This script runs with the 11 PRODUCTION scopes only - no separate dev app needed:
 *   - read_companies, write_companies  - Create companies, set payment terms on locations
 *   - read_customers, write_customers  - Create test customers (for future use)
 *   - read_orders, write_orders        - Create orders via orderCreate
 *   - read_payment_terms               - Read payment terms templates
 *   - write_validations, write_payment_customizations, write_merchant_managed_fulfillment_orders
 *     (pre-granted for S12/S13, not used by seed)
 *
 * HOW PAYMENT TERMS WORK:
 * 1. Payment terms templates are configured on CompanyLocations via companyLocationUpdate
 *    with buyerExperienceConfiguration.paymentTermsTemplateId (requires write_companies)
 * 2. Orders created for B2B company locations inherit these payment terms
 * 3. Orders are created with financialStatus: PENDING to mark them as unpaid
 *
 * NO DRAFT ORDERS: This script uses orderCreate with custom line items instead of
 * draft orders, eliminating the need for write_draft_orders and read_products.
 *
 * Usage:
 *   npm run seed                              # Run seed against dev store
 *   npm run seed -- --dry-run                 # Preview what would be created
 *   npm run seed -- --reset                   # Delete seed data before seeding
 *
 * Environment:
 *   SHOP                 - Shop domain (must be net-terms-receivables.myshopify.com)
 *   SHOPIFY_ADMIN_TOKEN  - Admin API access token with production scopes
 *
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/orderCreate
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/companyLocationUpdate
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/BuyerExperienceConfigurationInput
 */

import { pathToFileURL } from "node:url";

// -- Types --

export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string }; locations?: Array<{ line: number; column: number }> }>;
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number;
      throttleStatus: {
        maximumAvailable: number;
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
  };
}

export interface UserError {
  field: string[] | null;
  message: string;
  code?: string;
}

export interface CompanyNode {
  id: string;
  name: string;
  externalId: string | null;
  locations: {
    edges: Array<{
      node: {
        id: string;
        name: string;
      };
    }>;
  };
  contacts: {
    edges: Array<{
      node: {
        id: string;
        customer: {
          id: string;
          email: string;
        };
      };
    }>;
  };
}

export interface PaymentTermsTemplate {
  id: string;
  name: string;
  paymentTermsType: "NET" | "FIXED" | "RECEIPT" | "FULFILLMENT";
  dueInDays: number | null;
}

export interface OrderNode {
  id: string;
  name: string;
  tags: string[];
}

export interface ShopInfo {
  plan: {
    partnerDevelopment: boolean;
  };
  currencyCode: string;
}

// -- Constants --

export const API_VERSION = "2026-10";
export const SEED_TAG = "ntr-seed";
export const SEED_PREFIX = "ntr-seed-";
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

// Security: hardcoded allowed dev store domain. Seed refuses to run on any other shop.
// This prevents accidental mutation of production data if someone misconfigures SHOP.
const ALLOWED_DEV_STORE = "net-terms-receivables.myshopify.com";

export const COMPANY_SEEDS = [
  { key: "company-1", name: "Acme Wholesale Pvt Ltd", contact: { firstName: "Raj", lastName: "Sharma", email: "raj.sharma@acme-wholesale.example" } },
  { key: "company-2", name: "Bharat Traders Co", contact: { firstName: "Priya", lastName: "Patel", email: "priya@bharat-traders.example" } },
  { key: "company-3", name: "Delhi Distributors LLP", contact: { firstName: "Amit", lastName: "Singh", email: "amit.singh@delhi-dist.example" } },
  { key: "company-4", name: "Mumbai Merchants Pvt Ltd", contact: { firstName: "Sneha", lastName: "Desai", email: "sneha@mumbai-merchants.example" } },
  { key: "company-5", name: "Kolkata Commerce House", contact: { firstName: "Arjun", lastName: "Das", email: "arjun.das@kolkata-commerce.example" } },
] as const;

// B2B order distribution - each company gets multiple orders with different payment terms
export const ORDER_DISTRIBUTION = COMPANY_SEEDS.flatMap((c, i) => [
  { entityKey: c.key, termsType: "NET" as const, dueInDays: 15, daysAgo: i * 5 + 2 },
  { entityKey: c.key, termsType: "NET" as const, dueInDays: 30, daysAgo: i * 3 + 10 },
  { entityKey: c.key, termsType: "NET" as const, dueInDays: 60, daysAgo: i * 2 + 5 },
  { entityKey: c.key, termsType: "FIXED" as const, fixedDaysFromNow: -10 + i * 5, daysAgo: 15 + i },
]);

const AMOUNT_RANGES_INR = [
  { min: 5000, max: 15000 },
  { min: 15000, max: 50000 },
  { min: 50000, max: 150000 },
  { min: 150000, max: 500000 },
];

// Sample product names for custom line items (no real products needed)
const SAMPLE_PRODUCTS = [
  "Industrial Fasteners - Bulk Pack",
  "Steel Pipes - 20ft Bundle",
  "Copper Wire - 500m Spool",
  "Safety Equipment Kit",
  "Hydraulic Components Set",
  "Electrical Panel Assembly",
  "Conveyor Belt Section",
  "Industrial Lubricants - 200L",
];

// -- State --

export interface SeedState {
  shop: string;
  token: string;
  dryRun: boolean;
  reset: boolean;
  currencyCode: string;
  companies: Map<string, { id: string; locationId: string; contactCustomerId: string }>;
  paymentTermsTemplates: PaymentTermsTemplate[];
  createdCount: { companies: number; orders: number };
  skippedCount: { companies: number; orders: number };
  deletedCount: { companies: number; orders: number };
  errors: string[];
}

// -- GraphQL Client with Retry --

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatCurrency(amount: number, currencyCode: string): string {
  return `${currencyCode} ${amount.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export interface GraphQLOptions {
  isMutation?: boolean;
}

export async function graphql<T>(
  state: SeedState,
  query: string,
  variables?: Record<string, unknown>,
  options?: GraphQLOptions
): Promise<GraphQLResponse<T>> {
  const url = `https://${state.shop}/admin/api/${API_VERSION}/graphql.json`;
  let lastError: Error | null = null;
  const isMutation = options?.isMutation ?? false;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": state.token,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (response.status === 429) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        console.log(`  ⏳ Rate limited (429), retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }

      if (!response.ok) {
        throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
      }

      const json = (await response.json()) as GraphQLResponse<T>;

      const throttledError = json.errors?.find((e) => e.extensions?.code === "THROTTLED");
      if (throttledError) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        console.log(`  ⏳ Throttled, retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }

      const cost = json.extensions?.cost;
      if (cost) {
        const { currentlyAvailable, restoreRate } = cost.throttleStatus;
        if (currentlyAvailable < 100) {
          const waitMs = Math.ceil((100 - currentlyAvailable) / restoreRate) * 1000;
          console.log(`  ⏳ Rate limit: waiting ${waitMs}ms for points to restore...`);
          await sleep(waitMs);
        }
      }

      return json;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (isMutation) {
        throw lastError;
      }
      
      if (attempt < MAX_RETRIES - 1) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        console.log(`  ⏳ Request failed, retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  throw lastError ?? new Error("GraphQL request failed after retries");
}

// -- Preflight Checks --

export async function checkDevStore(state: SeedState): Promise<boolean> {
  console.log("\n🏪 Checking store type...");

  const query = `
    query GetShopInfo {
      shop {
        plan {
          partnerDevelopment
        }
        currencyCode
      }
    }
  `;

  const result = await graphql<{ shop: ShopInfo }>(state, query);

  if (result.errors) {
    console.error("  ❌ Failed to get shop info:", result.errors.map((e) => e.message).join(", "));
    return false;
  }

  const shop = result.data?.shop;
  if (!shop) {
    console.error("  ❌ No shop info returned");
    return false;
  }

  state.currencyCode = shop.currencyCode;

  if (!shop.plan.partnerDevelopment) {
    console.error("  ❌ This is NOT a development store");
    console.error("     The seed script only runs on development stores.");
    return false;
  }

  console.log("  ✅ Development store confirmed");
  console.log(`     Currency: ${shop.currencyCode}`);
  return true;
}

export async function checkB2BSupport(state: SeedState): Promise<boolean> {
  console.log("\n🔍 Checking B2B support...");

  const query = `
    query CheckB2B {
      companies(first: 1) {
        edges {
          node {
            id
          }
        }
      }
    }
  `;

  try {
    const result = await graphql<{ companies: { edges: Array<{ node: { id: string } }> } }>(state, query);

    if (result.errors) {
      const b2bError = result.errors.find(
        (e) =>
          e.message.includes("does not have access") ||
          e.message.includes("B2B") ||
          e.message.includes("companies")
      );
      if (b2bError) {
        console.error("  ❌ B2B not available on this store");
        console.error(`     Error: ${b2bError.message}`);
        console.error("     B2B requires Shopify Plus or a dev store with B2B enabled.");
        return false;
      }
      console.error("  ❌ GraphQL errors:", result.errors.map((e) => e.message).join(", "));
      return false;
    }

    console.log("  ✅ B2B is available");
    return true;
  } catch (error) {
    console.error("  ❌ Failed to check B2B support:", error);
    return false;
  }
}

export async function fetchPaymentTermsTemplates(state: SeedState): Promise<boolean> {
  console.log("\n📋 Fetching payment terms templates...");

  const query = `
    query GetPaymentTermsTemplates {
      paymentTermsTemplates {
        id
        name
        paymentTermsType
        dueInDays
      }
    }
  `;

  const result = await graphql<{ paymentTermsTemplates: PaymentTermsTemplate[] }>(state, query);

  if (result.errors) {
    console.error("  ❌ Failed to fetch payment terms templates:", result.errors.map((e) => e.message).join(", "));
    return false;
  }

  state.paymentTermsTemplates = result.data?.paymentTermsTemplates ?? [];

  if (state.paymentTermsTemplates.length === 0) {
    console.error("  ❌ No payment terms templates available");
    return false;
  }

  console.log(`  ✅ Found ${state.paymentTermsTemplates.length} templates:`);
  for (const t of state.paymentTermsTemplates) {
    console.log(`     - ${t.name} (${t.paymentTermsType}${t.dueInDays ? `, ${t.dueInDays} days` : ""})`);
  }

  return true;
}

// -- Reset / Cleanup --

export async function resetSeedData(state: SeedState): Promise<void> {
  console.log("\n🗑️  Resetting seed data...");

  if (state.dryRun) {
    console.log("  [dry-run] Would delete all data tagged with:", SEED_TAG);
    return;
  }

  await deleteSeededOrders(state);
  await deleteSeededCompanies(state);

  console.log("\n  Reset summary:");
  console.log(`    Companies deleted: ${state.deletedCount.companies}`);
  console.log(`    Orders: ${state.deletedCount.orders} (cannot delete via API, tagged for identification)`);
}

async function deleteSeededOrders(state: SeedState): Promise<void> {
  console.log("  Searching for seeded orders...");

  const result = await graphql<{ orders: { nodes: OrderNode[] } }>(state, `
    query FindSeededOrders($query: String!) {
      orders(first: 50, query: $query) {
        nodes { id name tags }
      }
    }
  `, { query: `tag:${SEED_TAG}` });

  const orders = result.data?.orders.nodes ?? [];
  console.log(`  Found ${orders.length} seeded orders`);
  state.deletedCount.orders = orders.length;

  if (orders.length > 0) {
    console.log("  ⚠️  Orders cannot be deleted via API. They will remain tagged for identification.");
  }
}

async function deleteSeededCompanies(state: SeedState): Promise<void> {
  console.log("  Searching for seeded companies...");

  const result = await graphql<{ companies: { nodes: CompanyNode[] } }>(state, `
    query FindSeededCompanies($query: String!) {
      companies(first: 50, query: $query) {
        nodes { id name externalId }
      }
    }
  `, { query: `external_id:${SEED_PREFIX}*` });

  const companies = result.data?.companies.nodes ?? [];
  console.log(`  Found ${companies.length} seeded companies`);

  for (const company of companies) {
    const deleteResult = await graphql<{ companyDelete: { deletedCompanyId: string; userErrors: UserError[] } }>(
      state,
      `mutation DeleteCompany($id: ID!) {
        companyDelete(id: $id) {
          deletedCompanyId
          userErrors { field message }
        }
      }`,
      { id: company.id },
      { isMutation: true }
    );

    if (deleteResult.data?.companyDelete.userErrors.length) {
      console.log(`    ⚠️  Failed to delete ${company.name}: ${deleteResult.data.companyDelete.userErrors[0].message}`);
    } else if (deleteResult.data?.companyDelete.deletedCompanyId) {
      state.deletedCount.companies++;
    }
  }
}

// -- Seeding: Companies --

export async function seedCompanies(state: SeedState): Promise<void> {
  console.log("\n🏢 Seeding B2B companies...");

  for (const seed of COMPANY_SEEDS) {
    const externalId = `${SEED_PREFIX}${seed.key}`;
    const existing = await findCompanyByExternalId(state, externalId);

    if (existing) {
      console.log(`  ⏭️  ${seed.name} already exists (${externalId})`);
      state.companies.set(seed.key, {
        id: existing.id,
        locationId: existing.locations.edges[0]?.node.id ?? "",
        contactCustomerId: existing.contacts.edges[0]?.node.customer.id ?? "",
      });
      state.skippedCount.companies++;
      continue;
    }

    if (state.dryRun) {
      console.log(`  [dry-run] Would create: ${seed.name} (${externalId})`);
      state.companies.set(seed.key, {
        id: `dry-run-company-${seed.key}`,
        locationId: `dry-run-location-${seed.key}`,
        contactCustomerId: `dry-run-customer-${seed.key}`,
      });
      state.createdCount.companies++;
      continue;
    }

    const result = await createCompany(state, seed, externalId);
    if (result) {
      state.companies.set(seed.key, result);
      state.createdCount.companies++;
      console.log(`  ✅ Created: ${seed.name}`);
      
      // Set default payment terms on the company location.
      // Orders for this location will inherit these payment terms.
      const defaultTemplate = state.paymentTermsTemplates.find((t) => t.paymentTermsType === "NET" && t.dueInDays === 30)
        ?? state.paymentTermsTemplates.find((t) => t.paymentTermsType === "NET")
        ?? state.paymentTermsTemplates[0];
      if (defaultTemplate && result.locationId) {
        await updateCompanyLocationPaymentTerms(state, result.locationId, defaultTemplate.id);
      }
    } else {
      state.errors.push(`Failed to create company: ${seed.name}`);
    }
  }
}

export async function findCompanyByExternalId(
  state: SeedState,
  externalId: string
): Promise<CompanyNode | null> {
  const query = `
    query FindCompany($query: String!) {
      companies(first: 1, query: $query) {
        nodes {
          id
          name
          externalId
          locations(first: 1) {
            edges { node { id name } }
          }
          contacts(first: 1) {
            edges { node { id customer { id email } } }
          }
        }
      }
    }
  `;

  const result = await graphql<{ companies: { nodes: CompanyNode[] } }>(state, query, {
    query: `external_id:${externalId}`,
  });

  return result.data?.companies.nodes[0] ?? null;
}

export async function createCompany(
  state: SeedState,
  seed: (typeof COMPANY_SEEDS)[number],
  externalId: string
): Promise<{ id: string; locationId: string; contactCustomerId: string } | null> {
  const mutation = `
    mutation CreateCompany($input: CompanyCreateInput!) {
      companyCreate(input: $input) {
        company {
          id
          name
          locations(first: 1) {
            edges { node { id name } }
          }
          contacts(first: 1) {
            edges { node { id customer { id email } } }
          }
        }
        userErrors { field message code }
      }
    }
  `;

  const result = await graphql<{
    companyCreate: { company: CompanyNode | null; userErrors: UserError[] };
  }>(state, mutation, {
    input: {
      company: { name: seed.name, externalId },
      companyLocation: {
        name: `${seed.name} - Head Office`,
        shippingAddress: {
          firstName: seed.contact.firstName,
          lastName: seed.contact.lastName,
          address1: "123 Business Street",
          city: "Mumbai",
          countryCode: "IN",
          zip: "400001",
        },
        billingSameAsShipping: true,
      },
      companyContact: {
        email: seed.contact.email,
        firstName: seed.contact.firstName,
        lastName: seed.contact.lastName,
      },
    },
  }, { isMutation: true });

  if (result.data?.companyCreate.userErrors.length) {
    console.error(`    ❌ Error creating ${seed.name}:`, result.data.companyCreate.userErrors);
    return null;
  }

  const company = result.data?.companyCreate.company;
  if (!company) {
    console.error(`    ❌ No company returned for ${seed.name}`);
    return null;
  }

  return {
    id: company.id,
    locationId: company.locations.edges[0]?.node.id ?? "",
    contactCustomerId: company.contacts.edges[0]?.node.customer.id ?? "",
  };
}

/**
 * Update a company location's payment terms template.
 * 
 * This uses companyLocationUpdate with buyerExperienceConfiguration.paymentTermsTemplateId,
 * which requires write_companies (NOT write_payment_terms).
 * B2B orders for this location will inherit these payment terms.
 * 
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/companyLocationUpdate
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/BuyerExperienceConfigurationInput
 */
export async function updateCompanyLocationPaymentTerms(
  state: SeedState,
  locationId: string,
  paymentTermsTemplateId: string
): Promise<boolean> {
  const mutation = `
    mutation UpdateCompanyLocationPaymentTerms($companyLocationId: ID!, $input: CompanyLocationUpdateInput!) {
      companyLocationUpdate(companyLocationId: $companyLocationId, input: $input) {
        companyLocation {
          id
          buyerExperienceConfiguration {
            paymentTermsTemplate {
              id
              name
            }
          }
        }
        userErrors { field message code }
      }
    }
  `;

  const result = await graphql<{
    companyLocationUpdate: {
      companyLocation: { id: string; buyerExperienceConfiguration: { paymentTermsTemplate: { id: string; name: string } | null } } | null;
      userErrors: UserError[];
    };
  }>(state, mutation, {
    companyLocationId: locationId,
    input: {
      buyerExperienceConfiguration: {
        paymentTermsTemplateId,
      },
    },
  }, { isMutation: true });

  if (result.data?.companyLocationUpdate.userErrors.length) {
    console.error(`    ⚠️  Error setting payment terms:`, result.data.companyLocationUpdate.userErrors);
    return false;
  }

  const template = result.data?.companyLocationUpdate.companyLocation?.buyerExperienceConfiguration?.paymentTermsTemplate;
  if (template) {
    console.log(`    → Payment terms: ${template.name}`);
  }
  
  return true;
}

// -- Seeding: Orders --

export async function seedOrders(state: SeedState): Promise<void> {
  console.log("\n📝 Seeding B2B orders...");

  let orderIndex = 0;
  for (const orderSpec of ORDER_DISTRIBUTION) {
    orderIndex++;
    const orderKey = `${SEED_PREFIX}order-${orderIndex}`;

    // Check if order already exists (idempotency)
    const existingOrder = await findOrderByTag(state, orderKey);
    if (existingOrder) {
      console.log(`  ⏭️  Order ${orderIndex} already exists (${existingOrder.name})`);
      state.skippedCount.orders++;
      continue;
    }

    const company = state.companies.get(orderSpec.entityKey);
    if (!company) {
      console.error(`  ❌ Company ${orderSpec.entityKey} not found`);
      continue;
    }

    // Generate random amount
    const amountRange = AMOUNT_RANGES_INR[orderIndex % AMOUNT_RANGES_INR.length];
    const amount = Math.floor(Math.random() * (amountRange.max - amountRange.min) + amountRange.min);

    // Pick a sample product name for the custom line item
    const productTitle = SAMPLE_PRODUCTS[orderIndex % SAMPLE_PRODUCTS.length];

    if (state.dryRun) {
      console.log(
        `  [dry-run] Would create order ${orderIndex}: ${orderSpec.entityKey}, ` +
          `${orderSpec.termsType} ${orderSpec.termsType === "NET" ? orderSpec.dueInDays + " days" : "fixed"}, ` +
          formatCurrency(amount, state.currencyCode)
      );
      state.createdCount.orders++;
      continue;
    }

    // Create B2B order using orderCreate with custom line items
    const order = await createOrder(state, {
      orderKey,
      companyLocationId: company.locationId,
      customerId: company.contactCustomerId,
      productTitle,
      amount,
    });

    if (!order) {
      state.errors.push(`Failed to create order ${orderIndex}`);
      continue;
    }

    state.createdCount.orders++;
    console.log(
      `  ✅ Created ${order.name}: ${orderSpec.entityKey}, ` +
        `${orderSpec.termsType} ${orderSpec.termsType === "NET" ? orderSpec.dueInDays + " days" : "fixed"}, ` +
        formatCurrency(amount, state.currencyCode)
    );
  }
}

export async function findOrderByTag(state: SeedState, tag: string): Promise<OrderNode | null> {
  const result = await graphql<{ orders: { nodes: OrderNode[] } }>(state, `
    query FindOrder($query: String!) {
      orders(first: 1, query: $query) {
        nodes { id name tags }
      }
    }
  `, { query: `tag:'${tag}'` });

  return result.data?.orders.nodes[0] ?? null;
}

/**
 * Create a B2B order using orderCreate with custom line items.
 * 
 * Key features:
 * - Custom line items with title + priceSet (no product variants needed, no read_products required)
 * - companyLocationId for B2B association (order inherits payment terms from location)
 * - financialStatus: PENDING to mark as unpaid
 * - sendReceipt: false, sendFulfillmentReceipt: false to suppress customer emails
 * 
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/orderCreate
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/OrderCreateLineItemInput
 */
export async function createOrder(
  state: SeedState,
  options: {
    orderKey: string;
    companyLocationId: string;
    customerId: string;
    productTitle: string;
    amount: number;
  }
): Promise<{ id: string; name: string } | null> {
  const mutation = `
    mutation CreateOrder($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
      orderCreate(order: $order, options: $options) {
        order {
          id
          name
          financialStatus
          totalPriceSet {
            shopMoney { amount currencyCode }
          }
          paymentTerms {
            paymentTermsName
            dueInDays
          }
        }
        userErrors { field message code }
      }
    }
  `;

  const result = await graphql<{
    orderCreate: {
      order: {
        id: string;
        name: string;
        financialStatus: string;
        totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
        paymentTerms: { paymentTermsName: string; dueInDays: number | null } | null;
      } | null;
      userErrors: UserError[];
    };
  }>(state, mutation, {
    order: {
      tags: [SEED_TAG, options.orderKey],
      companyLocationId: options.companyLocationId,
      customer: { id: options.customerId },
      currency: state.currencyCode,
      financialStatus: "PENDING",
      lineItems: [{
        title: options.productTitle,
        quantity: 1,
        priceSet: {
          shopMoney: {
            amount: String(options.amount),
            currencyCode: state.currencyCode,
          },
        },
      }],
      billingAddress: {
        firstName: "B2B",
        lastName: "Billing",
        address1: "123 Business Street",
        city: "Mumbai",
        countryCode: "IN",
        zip: "400001",
      },
      shippingAddress: {
        firstName: "B2B",
        lastName: "Shipping",
        address1: "123 Business Street",
        city: "Mumbai",
        countryCode: "IN",
        zip: "400001",
      },
    },
    options: {
      sendReceipt: false,
      sendFulfillmentReceipt: false,
      inventoryBehaviour: "BYPASS",
    },
  }, { isMutation: true });

  if (result.errors) {
    console.error(`    ❌ GraphQL errors:`, result.errors);
    return null;
  }

  if (result.data?.orderCreate.userErrors.length) {
    console.error(`    ❌ Error creating order:`, result.data.orderCreate.userErrors);
    return null;
  }

  const order = result.data?.orderCreate.order;
  if (!order) {
    console.error(`    ❌ No order returned`);
    return null;
  }

  // Log payment terms if inherited from the company location
  if (order.paymentTerms) {
    console.log(`    → Payment terms: ${order.paymentTerms.paymentTermsName} (${order.paymentTerms.dueInDays ?? 0} days)`);
  }

  return {
    id: order.id,
    name: order.name,
  };
}

// -- Main --

function parseArgs(): { dryRun: boolean; reset: boolean } {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes("--dry-run"),
    reset: args.includes("--reset"),
  };
}

function validateEnv(): { shop: string; token: string } | null {
  const shop = process.env.SHOP;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;

  if (!shop) {
    console.error("❌ Missing SHOP environment variable");
    console.error("   Set it to your shop domain, e.g.: export SHOP=my-store.myshopify.com");
    return null;
  }

  // Security: enforce hardcoded dev store domain
  if (shop !== ALLOWED_DEV_STORE) {
    console.error(`❌ Security: seed script only runs on ${ALLOWED_DEV_STORE}`);
    console.error(`   Received SHOP=${shop}`);
    console.error("   This guard prevents accidental mutation of production data.");
    return null;
  }

  if (!token) {
    console.error("❌ Missing SHOPIFY_ADMIN_TOKEN environment variable");
    console.error("   Set it to the Admin API access token with production scopes.");
    return null;
  }

  return { shop, token };
}

export async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Net Terms Receivables - Dev Store Seed Script");
  console.log("  (Using orderCreate - no draft orders, no read_products)");
  console.log("═══════════════════════════════════════════════════════════════");

  const { dryRun, reset } = parseArgs();
  const env = validateEnv();

  if (!env) {
    process.exit(1);
  }

  const state: SeedState = {
    shop: env.shop,
    token: env.token,
    dryRun,
    reset,
    currencyCode: "",
    companies: new Map(),
    paymentTermsTemplates: [],
    createdCount: { companies: 0, orders: 0 },
    skippedCount: { companies: 0, orders: 0 },
    deletedCount: { companies: 0, orders: 0 },
    errors: [],
  };

  console.log(`\nShop: ${state.shop}`);
  console.log(`Mode: ${dryRun ? "DRY RUN (read-only lookups, no mutations)" : reset ? "RESET + SEED" : "SEED"}`);

  // Preflight checks
  const devStoreOk = await checkDevStore(state);
  if (!devStoreOk) {
    process.exit(1);
  }

  const b2bOk = await checkB2BSupport(state);
  if (!b2bOk) {
    console.error("\n❌ Preflight failed: B2B not available");
    process.exit(1);
  }

  const templatesOk = await fetchPaymentTermsTemplates(state);
  if (!templatesOk) {
    console.error("\n❌ Preflight failed: Payment terms templates not available");
    process.exit(1);
  }

  // Reset if requested
  if (reset) {
    await resetSeedData(state);
  }

  // Seed data
  await seedCompanies(state);
  await seedOrders(state);

  // Summary
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Summary");
  console.log("═══════════════════════════════════════════════════════════════");

  if (dryRun) {
    console.log("\n  [DRY RUN - No mutations performed]");
  }

  console.log("\n  Created:");
  console.log(`    Companies:    ${state.createdCount.companies}`);
  console.log(`    Orders:       ${state.createdCount.orders}`);

  console.log("\n  Skipped (already exist):");
  console.log(`    Companies:    ${state.skippedCount.companies}`);
  console.log(`    Orders:       ${state.skippedCount.orders}`);

  if (state.errors.length > 0) {
    console.log("\n  Errors:");
    for (const err of state.errors) {
      console.log(`    ❌ ${err}`);
    }
    process.exit(1);
  }

  console.log("\n✅ Seed complete!");
}

// Only run main() when executed directly (not when imported for testing)
const isMainModule = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error("\n❌ Fatal error:", err);
    process.exit(1);
  });
}
