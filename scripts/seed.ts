#!/usr/bin/env tsx
/**
 * Seed script for Net Terms Receivables dev store.
 *
 * Creates B2B companies, customers, and orders with payment terms for
 * testing the app's receivables tracking features.
 *
 * Usage:
 *   npm run seed                              # Run seed against dev store
 *   npm run seed -- --dry-run                 # Preview what would be created
 *   npm run seed -- --reset                   # Delete seed data before seeding
 *   npm run seed -- --allow-non-dev-store     # Override dev store safety check
 *
 * Environment:
 *   SHOP                 - Shop domain (must be net-terms-receivables.myshopify.com)
 *   SHOPIFY_ADMIN_TOKEN  - Admin API access token from a Dev Dashboard app
 *
 * IMPORTANT: The token must come from an app created in the Dev Dashboard and
 * installed on your dev store — NOT from the production Net Terms Receivables app.
 * The production app does NOT have write_draft_orders or write_payment_terms.
 *
 * Required Admin API scopes for the Dev Dashboard app:
 *   read_companies, write_companies    - Create companies, set payment terms on locations
 *   read_customers, write_customers    - Create test customers
 *   read_draft_orders, write_draft_orders - Create draft orders for non-B2B customers
 *   read_products                      - Get product variants for line items
 *   read_payment_terms                 - Read payment terms templates
 *
 * Note: write_payment_terms is NOT required. B2B company locations get payment terms
 * via companyLocationUpdate (under write_companies), and orders inherit from the location.
 * Customer (non-B2B) orders use draft orders, which also set payment terms automatically.
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

export interface CustomerNode {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  tags: string[];
}

export interface PaymentTermsTemplate {
  id: string;
  name: string;
  paymentTermsType: "NET" | "FIXED" | "RECEIPT" | "FULFILLMENT";
  dueInDays: number | null;
}

export interface ProductVariantNode {
  id: string;
  title: string;
  price: string;
  product: {
    title: string;
  };
}

export interface DraftOrderNode {
  id: string;
  name: string;
  tags: string[];
  status: string;
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

export const CUSTOMER_SEEDS = [
  { key: "customer-1", firstName: "Vikram", lastName: "Reddy", email: "vikram.reddy@example.com" },
  { key: "customer-2", firstName: "Meera", lastName: "Nair", email: "meera.nair@example.com" },
  { key: "customer-3", firstName: "Sanjay", lastName: "Gupta", email: "sanjay.gupta@example.com" },
  { key: "customer-4", firstName: "Anita", lastName: "Joshi", email: "anita.joshi@example.com" },
  { key: "customer-5", firstName: "Rahul", lastName: "Verma", email: "rahul.verma@example.com" },
] as const;

export const ORDER_DISTRIBUTION = [
  ...COMPANY_SEEDS.flatMap((c, i) => [
    { entityType: "company" as const, entityKey: c.key, termsType: "NET" as const, dueInDays: 15, daysAgo: i * 5 + 2 },
    { entityType: "company" as const, entityKey: c.key, termsType: "NET" as const, dueInDays: 30, daysAgo: i * 3 + 10 },
    { entityType: "company" as const, entityKey: c.key, termsType: "NET" as const, dueInDays: 60, daysAgo: i * 2 + 5 },
    { entityType: "company" as const, entityKey: c.key, termsType: "FIXED" as const, fixedDaysFromNow: -10 + i * 5, daysAgo: 15 + i },
  ]),
  ...CUSTOMER_SEEDS.flatMap((c, i) => [
    { entityType: "customer" as const, entityKey: c.key, termsType: "NET" as const, dueInDays: 15, daysAgo: i * 4 + 3 },
    ...(i % 2 === 0 ? [{ entityType: "customer" as const, entityKey: c.key, termsType: "NET" as const, dueInDays: 30, daysAgo: i * 2 + 8 }] : []),
  ]),
];

const AMOUNT_RANGES_INR = [
  { min: 5000, max: 15000 },
  { min: 15000, max: 50000 },
  { min: 50000, max: 150000 },
  { min: 150000, max: 500000 },
];

// -- State --

export interface SeedState {
  shop: string;
  token: string;
  dryRun: boolean;
  reset: boolean;
  allowNonDevStore: boolean;
  currencyCode: string;
  companies: Map<string, { id: string; locationId: string; contactId: string; contactCustomerId: string }>;
  customers: Map<string, { id: string }>;
  paymentTermsTemplates: PaymentTermsTemplate[];
  productVariants: ProductVariantNode[];
  createdCount: { companies: number; customers: number; draftOrders: number; orders: number };
  skippedCount: { companies: number; customers: number; orders: number };
  deletedCount: { companies: number; customers: number; draftOrders: number; orders: number };
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

      // Retry on 429 with exponential backoff (safe for mutations: request was throttled, not executed)
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

      // Retry on THROTTLED (safe for mutations: request was throttled, not executed)
      const throttledError = json.errors?.find((e) => e.extensions?.code === "THROTTLED");
      if (throttledError) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        console.log(`  ⏳ Throttled, retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }

      // Handle cost-based rate limiting
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
      
      // For mutations, do NOT auto-retry on network errors: the first request may have
      // succeeded, and retrying could create duplicates. Callers should re-check existence.
      if (isMutation) {
        throw lastError;
      }
      
      // For queries, retry with exponential backoff
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

  // Store the currency code for use in order creation
  state.currencyCode = shop.currencyCode;

  if (!shop.plan.partnerDevelopment) {
    if (state.allowNonDevStore) {
      console.log("  ⚠️  This is NOT a development store, but --allow-non-dev-store was passed");
      return true;
    }
    console.error("  ❌ This is NOT a development store");
    console.error("     The seed script only runs on development stores by default.");
    console.error("     Pass --allow-non-dev-store to override (use with caution!).");
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

export async function fetchProductVariants(state: SeedState): Promise<boolean> {
  console.log("\n📦 Fetching product variants for orders...");

  const query = `
    query GetProductVariants {
      productVariants(first: 10) {
        nodes {
          id
          title
          price
          product {
            title
          }
        }
      }
    }
  `;

  const result = await graphql<{ productVariants: { nodes: ProductVariantNode[] } }>(state, query);

  if (result.errors) {
    console.error("  ❌ Failed to fetch product variants:", result.errors.map((e) => e.message).join(", "));
    return false;
  }

  state.productVariants = result.data?.productVariants.nodes ?? [];

  if (state.productVariants.length === 0) {
    console.error("  ❌ No product variants available. Please add products to the store first.");
    return false;
  }

  console.log(`  ✅ Found ${state.productVariants.length} variants`);
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
  await deleteSeededDraftOrders(state);
  await deleteSeededCustomers(state);
  await deleteSeededCompanies(state);

  console.log("\n  Reset summary:");
  console.log(`    Companies deleted: ${state.deletedCount.companies}`);
  console.log(`    Customers deleted: ${state.deletedCount.customers}`);
  console.log(`    Draft orders deleted: ${state.deletedCount.draftOrders}`);
  console.log(`    Orders deleted: ${state.deletedCount.orders}`);
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

  if (orders.length > 0) {
    console.log("  ⚠️  Orders cannot be deleted via API. They will remain tagged for identification.");
  }
}

async function deleteSeededDraftOrders(state: SeedState): Promise<void> {
  console.log("  Searching for seeded draft orders...");

  const result = await graphql<{ draftOrders: { nodes: DraftOrderNode[] } }>(state, `
    query FindSeededDraftOrders($query: String!) {
      draftOrders(first: 100, query: $query) {
        nodes { id name tags status }
      }
    }
  `, { query: `tag:${SEED_TAG}` });

  const draftOrders = result.data?.draftOrders.nodes ?? [];
  console.log(`  Found ${draftOrders.length} seeded draft orders`);

  for (const draft of draftOrders) {
    if (draft.status !== "COMPLETED") {
      const deleteResult = await graphql<{ draftOrderDelete: { deletedId: string; userErrors: UserError[] } }>(
        state,
        `mutation DeleteDraftOrder($input: DraftOrderDeleteInput!) {
          draftOrderDelete(input: $input) {
            deletedId
            userErrors { field message }
          }
        }`,
        { input: { id: draft.id } },
        { isMutation: true }
      );

      if (deleteResult.data?.draftOrderDelete.userErrors.length) {
        console.log(`    ⚠️  Failed to delete ${draft.name}: ${deleteResult.data.draftOrderDelete.userErrors[0].message}`);
      } else if (deleteResult.data?.draftOrderDelete.deletedId) {
        state.deletedCount.draftOrders++;
      }
    }
  }
}

async function deleteSeededCustomers(state: SeedState): Promise<void> {
  console.log("  Searching for seeded customers...");

  const result = await graphql<{ customers: { nodes: CustomerNode[] } }>(state, `
    query FindSeededCustomers($query: String!) {
      customers(first: 50, query: $query) {
        nodes { id email tags }
      }
    }
  `, { query: `tag:${SEED_TAG}` });

  const customers = result.data?.customers.nodes ?? [];
  console.log(`  Found ${customers.length} seeded customers`);

  for (const customer of customers) {
    const deleteResult = await graphql<{ customerDelete: { deletedCustomerId: string; userErrors: UserError[] } }>(
      state,
      `mutation DeleteCustomer($input: CustomerDeleteInput!) {
        customerDelete(input: $input) {
          deletedCustomerId
          userErrors { field message }
        }
      }`,
      { input: { id: customer.id } },
      { isMutation: true }
    );

    if (deleteResult.data?.customerDelete.userErrors.length) {
      const err = deleteResult.data.customerDelete.userErrors[0];
      if (!err.message.includes("orders")) {
        console.log(`    ⚠️  Failed to delete ${customer.email}: ${err.message}`);
      }
    } else if (deleteResult.data?.customerDelete.deletedCustomerId) {
      state.deletedCount.customers++;
    }
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
        contactId: existing.contacts.edges[0]?.node.id ?? "",
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
        contactId: `dry-run-contact-${seed.key}`,
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
      
      // Set default payment terms on the company location using companyLocationUpdate.
      // This requires only write_companies (NOT write_payment_terms).
      // Orders for this location will inherit these payment terms automatically.
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
): Promise<{ id: string; locationId: string; contactId: string; contactCustomerId: string } | null> {
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

  const locationId = company.locations.edges[0]?.node.id ?? "";
  
  return {
    id: company.id,
    locationId,
    contactId: company.contacts.edges[0]?.node.id ?? "",
    contactCustomerId: company.contacts.edges[0]?.node.customer.id ?? "",
  };
}

/**
 * Update a company location's payment terms template.
 * 
 * This uses companyLocationUpdate with buyerExperienceConfiguration.paymentTermsTemplateId,
 * which only requires write_companies (or write_customers) - NOT write_payment_terms.
 * Orders created for this location will inherit the payment terms automatically.
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

// -- Seeding: Customers --

export async function seedCustomers(state: SeedState): Promise<void> {
  console.log("\n👤 Seeding net-terms customers...");

  for (const seed of CUSTOMER_SEEDS) {
    const seedKey = `${SEED_PREFIX}${seed.key}`;
    const existing = await findCustomerByTag(state, seedKey);

    if (existing) {
      console.log(`  ⏭️  ${seed.firstName} ${seed.lastName} already exists`);
      state.customers.set(seed.key, { id: existing.id });
      state.skippedCount.customers++;
      continue;
    }

    if (state.dryRun) {
      console.log(`  [dry-run] Would create: ${seed.firstName} ${seed.lastName}`);
      state.customers.set(seed.key, { id: `dry-run-customer-${seed.key}` });
      state.createdCount.customers++;
      continue;
    }

    const result = await createCustomer(state, seed, seedKey);
    if (result) {
      state.customers.set(seed.key, result);
      state.createdCount.customers++;
      console.log(`  ✅ Created: ${seed.firstName} ${seed.lastName}`);
    } else {
      state.errors.push(`Failed to create customer: ${seed.firstName} ${seed.lastName}`);
    }
  }
}

export async function findCustomerByTag(state: SeedState, tag: string): Promise<CustomerNode | null> {
  const query = `
    query FindCustomer($query: String!) {
      customers(first: 1, query: $query) {
        nodes { id email firstName lastName tags }
      }
    }
  `;

  const result = await graphql<{ customers: { nodes: CustomerNode[] } }>(state, query, {
    query: `tag:'${tag}'`,
  });

  return result.data?.customers.nodes[0] ?? null;
}

export async function createCustomer(
  state: SeedState,
  seed: (typeof CUSTOMER_SEEDS)[number],
  seedKey: string
): Promise<{ id: string } | null> {
  const mutation = `
    mutation CreateCustomer($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer { id email }
        userErrors { field message }
      }
    }
  `;

  const result = await graphql<{
    customerCreate: { customer: { id: string; email: string } | null; userErrors: UserError[] };
  }>(state, mutation, {
    input: {
      email: seed.email,
      firstName: seed.firstName,
      lastName: seed.lastName,
      tags: [SEED_TAG, seedKey, "net-terms-buyer"],
      addresses: [{
        firstName: seed.firstName,
        lastName: seed.lastName,
        address1: "456 Customer Lane",
        city: "Delhi",
        countryCode: "IN",
        zip: "110001",
      }],
    },
  }, { isMutation: true });

  if (result.data?.customerCreate.userErrors.length) {
    console.error(`    ❌ Error creating ${seed.email}:`, result.data.customerCreate.userErrors);
    return null;
  }

  return result.data?.customerCreate.customer ? { id: result.data.customerCreate.customer.id } : null;
}

// -- Seeding: Orders with Payment Terms --

export async function seedOrders(state: SeedState): Promise<void> {
  console.log("\n📝 Seeding orders with payment terms...");

  const netTemplates = state.paymentTermsTemplates.filter((t) => t.paymentTermsType === "NET");
  const fixedTemplate = state.paymentTermsTemplates.find((t) => t.paymentTermsType === "FIXED");

  if (netTemplates.length === 0) {
    console.error("  ❌ No NET payment terms templates available");
    return;
  }

  let orderIndex = 0;
  for (const orderSpec of ORDER_DISTRIBUTION) {
    orderIndex++;
    const orderKey = `${SEED_PREFIX}order-${orderIndex}`;

    // Check if order already exists (perform lookup even in dry-run for accurate preview)
    const existingOrder = await findOrderByTag(state, orderKey);
    if (existingOrder) {
      console.log(`  ⏭️  Order ${orderIndex} already exists`);
      state.skippedCount.orders++;
      continue;
    }

    const existingDraft = await findDraftOrderByTag(state, orderKey);
    if (existingDraft) {
      console.log(`  ⏭️  Draft order ${orderIndex} already exists`);
      state.skippedCount.orders++;
      continue;
    }

    // Determine payment terms
    let paymentTermsInput: Record<string, unknown>;
    const issuedAt = new Date();
    issuedAt.setDate(issuedAt.getDate() - orderSpec.daysAgo);

    if (orderSpec.termsType === "NET") {
      const template = netTemplates.find((t) => t.dueInDays === orderSpec.dueInDays) ?? netTemplates[0];
      paymentTermsInput = {
        paymentTermsTemplateId: template.id,
        paymentSchedules: [{ issuedAt: issuedAt.toISOString() }],
      };
    } else if (fixedTemplate && "fixedDaysFromNow" in orderSpec) {
      const dueAt = new Date();
      dueAt.setDate(dueAt.getDate() + orderSpec.fixedDaysFromNow);
      paymentTermsInput = {
        paymentTermsTemplateId: fixedTemplate.id,
        paymentSchedules: [{ dueAt: dueAt.toISOString() }],
      };
    } else {
      const template = netTemplates.find((t) => t.dueInDays === 30) ?? netTemplates[0];
      paymentTermsInput = {
        paymentTermsTemplateId: template.id,
        paymentSchedules: [{ issuedAt: issuedAt.toISOString() }],
      };
    }

    // Get entity info
    let purchasingEntity: Record<string, unknown>;
    let billingAddress: Record<string, unknown>;

    if (orderSpec.entityType === "company") {
      const company = state.companies.get(orderSpec.entityKey);
      if (!company) {
        console.error(`  ❌ Company ${orderSpec.entityKey} not found`);
        continue;
      }
      purchasingEntity = {
        purchasingCompany: {
          companyId: company.id,
          companyLocationId: company.locationId,
          companyContactId: company.contactId,
        },
      };
      billingAddress = {
        firstName: "Billing",
        lastName: "Contact",
        address1: "123 Business Street",
        city: "Mumbai",
        countryCode: "IN",
        zip: "400001",
      };
    } else {
      const customer = state.customers.get(orderSpec.entityKey);
      if (!customer) {
        console.error(`  ❌ Customer ${orderSpec.entityKey} not found`);
        continue;
      }
      purchasingEntity = { customerId: customer.id };
      billingAddress = {
        firstName: "Customer",
        lastName: "Billing",
        address1: "456 Customer Lane",
        city: "Delhi",
        countryCode: "IN",
        zip: "110001",
      };
    }

    // Generate random amount in INR
    const amountRange = AMOUNT_RANGES_INR[orderIndex % AMOUNT_RANGES_INR.length];
    const amount = Math.floor(Math.random() * (amountRange.max - amountRange.min) + amountRange.min);

    // Pick a product variant for line item (we'll override its price)
    const variant = state.productVariants[orderIndex % state.productVariants.length];

    if (state.dryRun) {
      console.log(
        `  [dry-run] Would create order ${orderIndex}: ${orderSpec.entityType} ${orderSpec.entityKey}, ` +
          `${orderSpec.termsType} ${orderSpec.termsType === "NET" ? orderSpec.dueInDays + " days" : "fixed"}, ` +
          formatCurrency(amount, state.currencyCode)
      );
      state.createdCount.draftOrders++;
      continue;
    }

    // Create draft order with price override so total equals intended amount
    const draftOrder = await createDraftOrder(state, {
      orderKey,
      purchasingEntity,
      paymentTermsInput,
      billingAddress,
      variantId: variant.id,
      amount,
    });

    if (!draftOrder) {
      state.errors.push(`Failed to create draft order ${orderIndex}`);
      continue;
    }

    state.createdCount.draftOrders++;
    console.log(
      `  ✅ Created draft ${draftOrder.name}: ${orderSpec.entityType} ${orderSpec.entityKey}, ` +
        `${orderSpec.termsType} ${orderSpec.termsType === "NET" ? orderSpec.dueInDays + " days" : "fixed"}, ` +
        formatCurrency(draftOrder.totalPrice, state.currencyCode)
    );

    // Complete draft order - payment terms automatically create it as payment pending
    // Per Shopify docs: "Set the order as payment pending using payment terms"
    // When a draft has payment terms, draftOrderComplete creates the order with balance due
    const completed = await completeDraftOrder(state, draftOrder.id);
    if (completed) {
      state.createdCount.orders++;
      console.log(`    → Completed as order ${completed.name} (total: ${formatCurrency(completed.totalPrice, state.currencyCode)})`);
    }
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

export async function findDraftOrderByTag(state: SeedState, tag: string): Promise<DraftOrderNode | null> {
  const result = await graphql<{ draftOrders: { nodes: DraftOrderNode[] } }>(state, `
    query FindDraftOrder($query: String!) {
      draftOrders(first: 1, query: $query) {
        nodes { id name tags status }
      }
    }
  `, { query: `tag:'${tag}'` });

  return result.data?.draftOrders.nodes[0] ?? null;
}

export async function createDraftOrder(
  state: SeedState,
  options: {
    orderKey: string;
    purchasingEntity: Record<string, unknown>;
    paymentTermsInput: Record<string, unknown>;
    billingAddress: Record<string, unknown>;
    variantId: string;
    amount: number;
  }
): Promise<{ id: string; name: string; totalPrice: number } | null> {
  // Use price override to set exact order total (quantity 1, price = amount)
  const mutation = `
    mutation CreateDraftOrder($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          name
          totalPriceSet {
            shopMoney { amount }
          }
        }
        userErrors { field message code }
      }
    }
  `;

  const result = await graphql<{
    draftOrderCreate: {
      draftOrder: { id: string; name: string; totalPriceSet: { shopMoney: { amount: string } } } | null;
      userErrors: UserError[];
    };
  }>(state, mutation, {
    input: {
      tags: [SEED_TAG, options.orderKey],
      purchasingEntity: options.purchasingEntity,
      paymentTerms: options.paymentTermsInput,
      billingAddress: options.billingAddress,
      shippingAddress: options.billingAddress,
      lineItems: [{
        variantId: options.variantId,
        quantity: 1,
        priceOverride: {
          amount: String(options.amount),
          currencyCode: state.currencyCode,
        },
      }],
      presentmentCurrencyCode: state.currencyCode,
    },
  }, { isMutation: true });

  if (result.data?.draftOrderCreate.userErrors.length) {
    console.error(`    ❌ Error creating draft order:`, result.data.draftOrderCreate.userErrors);
    return null;
  }

  const draft = result.data?.draftOrderCreate.draftOrder;
  if (!draft) return null;

  return {
    id: draft.id,
    name: draft.name,
    totalPrice: parseFloat(draft.totalPriceSet.shopMoney.amount),
  };
}

export async function completeDraftOrder(
  state: SeedState,
  draftOrderId: string
): Promise<{ id: string; name: string; totalPrice: number } | null> {
  // Per Shopify 2026-10 docs, draftOrderComplete with payment terms creates order as payment pending.
  // The paymentPending argument is deprecated; payment terms automatically determine payment status.
  const mutation = `
    mutation CompleteDraftOrder($id: ID!) {
      draftOrderComplete(id: $id) {
        draftOrder {
          id
          name
          order {
            id
            name
            totalPriceSet {
              shopMoney { amount }
            }
          }
        }
        userErrors { field message }
      }
    }
  `;

  const result = await graphql<{
    draftOrderComplete: {
      draftOrder: {
        id: string;
        name: string;
        order: { id: string; name: string; totalPriceSet: { shopMoney: { amount: string } } } | null;
      } | null;
      userErrors: UserError[];
    };
  }>(state, mutation, { id: draftOrderId }, { isMutation: true });

  if (result.data?.draftOrderComplete.userErrors.length) {
    console.error(`    ⚠️  Error completing draft order:`, result.data.draftOrderComplete.userErrors);
    return null;
  }

  const order = result.data?.draftOrderComplete.draftOrder?.order;
  if (!order) return null;

  return {
    id: order.id,
    name: order.name,
    totalPrice: parseFloat(order.totalPriceSet.shopMoney.amount),
  };
}

// -- Main --

function parseArgs(): { dryRun: boolean; reset: boolean; allowNonDevStore: boolean } {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes("--dry-run"),
    reset: args.includes("--reset"),
    allowNonDevStore: args.includes("--allow-non-dev-store"),
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
    console.error("   Set it to the Admin API access token from a Dev Dashboard app.");
    console.error("   See README for setup instructions.");
    return null;
  }

  return { shop, token };
}

export async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Net Terms Receivables - Dev Store Seed Script");
  console.log("═══════════════════════════════════════════════════════════════");

  const { dryRun, reset, allowNonDevStore } = parseArgs();
  const env = validateEnv();

  if (!env) {
    process.exit(1);
  }

  const state: SeedState = {
    shop: env.shop,
    token: env.token,
    dryRun,
    reset,
    allowNonDevStore,
    currencyCode: "", // Set by checkDevStore()
    companies: new Map(),
    customers: new Map(),
    paymentTermsTemplates: [],
    productVariants: [],
    createdCount: { companies: 0, customers: 0, draftOrders: 0, orders: 0 },
    skippedCount: { companies: 0, customers: 0, orders: 0 },
    deletedCount: { companies: 0, customers: 0, draftOrders: 0, orders: 0 },
    errors: [],
  };

  console.log(`\nShop: ${state.shop}`);
  console.log(`Mode: ${dryRun ? "DRY RUN (read-only lookups, no mutations)" : reset ? "RESET + SEED" : "SEED"}`);

  // Preflight checks (always run, even in dry-run)
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

  const variantsOk = await fetchProductVariants(state);
  if (!variantsOk) {
    console.error("\n❌ Preflight failed: No product variants available");
    process.exit(1);
  }

  // Reset if requested
  if (reset) {
    await resetSeedData(state);
  }

  // Seed data
  await seedCompanies(state);
  await seedCustomers(state);
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
  console.log(`    Customers:    ${state.createdCount.customers}`);
  console.log(`    Draft Orders: ${state.createdCount.draftOrders}`);
  console.log(`    Orders:       ${state.createdCount.orders}`);

  console.log("\n  Skipped (already exist):");
  console.log(`    Companies:    ${state.skippedCount.companies}`);
  console.log(`    Customers:    ${state.skippedCount.customers}`);
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
