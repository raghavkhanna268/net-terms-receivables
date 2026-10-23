#!/usr/bin/env tsx
/**
 * Seed script for Net Terms Receivables dev store.
 *
 * Creates B2B companies and orders with payment terms for testing the app's
 * receivables tracking features. Also seeds the database with tag rules and
 * buyer account defaults so S9 inference can compute due dates.
 *
 * SCOPE REQUIREMENTS:
 * This script runs with the 11 PRODUCTION scopes only - no separate dev app needed.
 * Uses only the dev-store token (SHOPIFY_ADMIN_TOKEN env var).
 *   - read_companies, write_companies  - Create companies, set payment terms on locations
 *   - read_customers, write_customers  - Create test customers (for future use)
 *   - read_orders, write_orders        - Create orders via orderCreate
 *   - read_payment_terms               - Read payment terms templates
 *   - write_validations, write_payment_customizations, write_merchant_managed_fulfillment_orders
 *     (pre-granted for S12/S13, not used by seed)
 *
 * HOW PAYMENT TERMS WORK:
 * 1. Each company has 3 locations with Net 15, Net 30, Net 60 via buyerExperienceConfiguration
 *    on companyCreate/companyLocationCreate (paymentTermsTemplateId)
 * 2. Orders use processedAt to backdate, creating overdue invoices for testing
 *    @see https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/OrderCreateOrderInput
 *    "processedAt: The date and time when the order was created."
 * 3. S6 order sync maps processedAt ?? createdAt to issuedAt
 *    @see app/services/sync/order.server.ts:188 - const issuedAt = new Date(order.processedAt ?? order.createdAt);
 * 4. If Shopify returns paymentTerms on the order, those are used (inherited path)
 * 5. If Shopify returns null paymentTerms, S9 inference uses DB defaults (inferred path):
 *    - BuyerAccount.defaultTermsDays (explicit) from company location sync
 *    - AccountSource tag rules for tagged customers
 *    - Shop.defaultTermsDays as fallback
 *
 * TAGGING STRATEGY:
 * - B2B contacts are NOT tagged; their terms come from location buyerExperienceConfiguration
 *   and DB defaults (BuyerAccount.defaultTermsDays).
 * - For tagged-customer path testing, we create 3 dedicated non-B2B seed customers
 *   (ntr-seed-net15, ntr-seed-net30, ntr-seed-net60), each tagged exactly once with tagsAdd
 *   (idempotent), and place a few non-B2B orders for them.
 *
 * SHOPIFY TERMS INHERITANCE (WARNING, NOT FAILURE):
 * OrderCreateOrderInput does NOT have a paymentTerms field. We rely on Shopify
 * inheriting terms from companyLocationId. If this doesn't work, orders get
 * null paymentTerms and we log a warning. S9 inference handles due dates via
 * DB defaults seeded by this script.
 * 
 * NO write_payment_terms: Team Lead scope decision - we do NOT use paymentTermsCreate.
 *
 * FIXED TERMS NOT SUPPORTED:
 * FIXED payment terms require a specific dueAt date per order, which can't be
 * expressed through location templates. This seed only creates NET terms orders.
 *
 * Usage:
 *   npm run seed                              # Run seed against dev store
 *   npm run seed -- --dry-run                 # Preview what would be created
 *   npm run seed -- --reset                   # Delete seed data before seeding
 *
 * Environment:
 *   SHOP                 - Shop domain (must be net-terms-receivables.myshopify.com)
 *   SHOPIFY_ADMIN_TOKEN  - Admin API access token with production scopes
 *   DATABASE_URL         - Direct Postgres connection for DB seeding (optional)
 *
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/orderCreate
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/OrderCreateOrderInput
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/companyLocationUpdate
 */

import { pathToFileURL } from "node:url";
import postgres from "postgres";

// -- Types --

export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{
    message: string;
    path?: Array<string | number>;
    extensions?: { code?: string };
    locations?: Array<{ line: number; column: number }>;
  }>;
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

export interface CompanyContactRole {
  id: string;
  name: string;
}

export interface CompanyContactRoleAssignment {
  id: string;
  companyContact: { id: string };
  role: { id: string; name: string };
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
  contactRoles?: {
    nodes: CompanyContactRole[];
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

export interface OrderPaymentTerms {
  paymentTermsName: string;
  paymentTermsType: string;
  dueInDays: number | null;
  paymentSchedules: {
    nodes: Array<{
      dueAt: string | null;
    }>;
  };
}

// -- Constants --

export const API_VERSION = "2026-10";
export const SEED_TAG = "ntr-seed";
export const SEED_PREFIX = "ntr-seed-";
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

// Order creation pacing to avoid dev store throttling (configurable via env)
// Default 12s is safe for dev stores; Shopify returns "Too many attempts" on fast orderCreate
export const DEFAULT_SEED_ORDER_DELAY_MS = 12000;
export const SEED_ORDER_DELAY_MS = parseInt(process.env.SEED_ORDER_DELAY_MS ?? String(DEFAULT_SEED_ORDER_DELAY_MS), 10);

// Retry configuration for orderCreate throttle errors
export const ORDER_CREATE_MAX_ATTEMPTS = 5;
export const ORDER_CREATE_BACKOFF_DELAYS_MS = [15000, 30000, 60000, 120000]; // After first failure: 15s, 30s, 60s, 120s

// Security: hardcoded allowed dev store domain. Seed refuses to run on any other shop.
// This prevents accidental mutation of production data if someone misconfigures SHOP.
const ALLOWED_DEV_STORE = "net-terms-receivables.myshopify.com";

// Location suffixes for different payment terms (Net 15, Net 30, Net 60)
export const LOCATION_TERMS: { suffix: string; dueInDays: number }[] = [
  { suffix: "Net-15", dueInDays: 15 },
  { suffix: "Net-30", dueInDays: 30 },
  { suffix: "Net-60", dueInDays: 60 },
];

/**
 * Indian city address data: ISO 3166-2:IN zone/province code and PIN code prefix.
 * @see https://en.wikipedia.org/wiki/ISO_3166-2:IN
 * @see https://en.wikipedia.org/wiki/Postal_Index_Number
 * 
 * Used by:
 * - CompanyAddressInput.zoneCode (company/location addresses)
 * - MailingAddressInput.provinceCode (order billing/shipping addresses)
 * 
 * Both fields use the same ISO 3166-2:IN codes (e.g., MH, DL, KA).
 * PIN codes are 6 digits; we store a valid prefix for each city.
 */
export interface IndiaAddressInfo {
  provinceCode: string;
  zip: string;
}

export const INDIA_CITY_ADDRESS_INFO: Record<string, IndiaAddressInfo> = {
  // Maharashtra (MH) - PIN 40xxxx-44xxxx
  "Mumbai": { provinceCode: "MH", zip: "400001" },
  "Pune": { provinceCode: "MH", zip: "411001" },
  "Nagpur": { provinceCode: "MH", zip: "440001" },
  // Delhi (DL) - PIN 11xxxx
  "Delhi": { provinceCode: "DL", zip: "110001" },
  "New Delhi": { provinceCode: "DL", zip: "110001" },
  // Karnataka (KA) - PIN 56xxxx-59xxxx
  "Bengaluru": { provinceCode: "KA", zip: "560001" },
  "Bangalore": { provinceCode: "KA", zip: "560001" },
  "Mysuru": { provinceCode: "KA", zip: "570001" },
  // Tamil Nadu (TN) - PIN 60xxxx-64xxxx
  "Chennai": { provinceCode: "TN", zip: "600001" },
  "Coimbatore": { provinceCode: "TN", zip: "641001" },
  // Gujarat (GJ) - PIN 36xxxx-39xxxx
  "Ahmedabad": { provinceCode: "GJ", zip: "380001" },
  "Surat": { provinceCode: "GJ", zip: "395001" },
  // West Bengal (WB) - PIN 70xxxx-74xxxx
  "Kolkata": { provinceCode: "WB", zip: "700001" },
  // Telangana (TG) - PIN 50xxxx-51xxxx
  "Hyderabad": { provinceCode: "TG", zip: "500001" },
  // Rajasthan (RJ) - PIN 30xxxx-34xxxx
  "Jaipur": { provinceCode: "RJ", zip: "302001" },
  // Uttar Pradesh (UP) - PIN 20xxxx-28xxxx
  "Lucknow": { provinceCode: "UP", zip: "226001" },
  "Noida": { provinceCode: "UP", zip: "201301" },
};

/**
 * Get address info (province/zone code and ZIP) for an Indian city.
 * Throws if the city is not in the mapping - add it to INDIA_CITY_ADDRESS_INFO.
 * 
 * @returns Object with provinceCode (e.g., "MH") and zip (e.g., "400001")
 */
export function getIndiaAddressInfo(city: string): IndiaAddressInfo {
  const info = INDIA_CITY_ADDRESS_INFO[city];
  if (!info) {
    throw new Error(
      `Unknown Indian city "${city}" - add it to INDIA_CITY_ADDRESS_INFO in scripts/seed.ts. ` +
      `See https://en.wikipedia.org/wiki/ISO_3166-2:IN for province codes and ` +
      `https://en.wikipedia.org/wiki/Postal_Index_Number for PIN codes.`
    );
  }
  return info;
}

/**
 * Get the ISO 3166-2:IN subdivision code for an Indian city.
 * @deprecated Use getIndiaAddressInfo() to get both provinceCode and zip together.
 */
export function getIndiaProvinceCode(city: string): string {
  return getIndiaAddressInfo(city).provinceCode;
}

export const COMPANY_SEEDS = [
  { key: "company-1", name: "Acme Wholesale Pvt Ltd", city: "Mumbai", contact: { firstName: "Raj", lastName: "Sharma", email: "raj.sharma@acme-wholesale.example" } },
  { key: "company-2", name: "Bharat Traders Co", city: "Ahmedabad", contact: { firstName: "Priya", lastName: "Patel", email: "priya@bharat-traders.example" } },
  { key: "company-3", name: "Delhi Distributors LLP", city: "Delhi", contact: { firstName: "Amit", lastName: "Singh", email: "amit.singh@delhi-dist.example" } },
  { key: "company-4", name: "Mumbai Merchants Pvt Ltd", city: "Pune", contact: { firstName: "Sneha", lastName: "Desai", email: "sneha@mumbai-merchants.example" } },
  { key: "company-5", name: "Kolkata Commerce House", city: "Kolkata", contact: { firstName: "Arjun", lastName: "Das", email: "arjun.das@kolkata-commerce.example" } },
] as const;

// B2B order distribution - each company gets orders from different locations (different terms)
// daysAgo creates backdated orders via processedAt, some will be overdue
// locationTermsDays determines which location (and thus which payment terms) to use
export const ORDER_DISTRIBUTION = COMPANY_SEEDS.flatMap((c, i) => [
  // Net 15 orders - some overdue (daysAgo > 15)
  { entityKey: c.key, locationTermsDays: 15, daysAgo: 20 + i * 2 },  // Overdue
  { entityKey: c.key, locationTermsDays: 15, daysAgo: 10 + i },       // Not yet due
  // Net 30 orders - some overdue (daysAgo > 30)
  { entityKey: c.key, locationTermsDays: 30, daysAgo: 35 + i * 3 },  // Overdue
  { entityKey: c.key, locationTermsDays: 30, daysAgo: 15 + i * 2 },  // Not yet due
  // Net 60 orders - none overdue yet
  { entityKey: c.key, locationTermsDays: 60, daysAgo: 45 + i },      // Not yet due
  { entityKey: c.key, locationTermsDays: 60, daysAgo: 20 + i * 2 },  // Not yet due
]);

const AMOUNT_RANGES_INR = [
  { min: 5000, max: 15000 },
  { min: 15000, max: 50000 },
  { min: 50000, max: 150000 },
  { min: 150000, max: 500000 },
];

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

export interface CompanyData {
  id: string;
  contactId: string;  // CompanyContact ID (for role assignments)
  contactCustomerId: string;  // Customer ID (for order association)
  locations: Map<number, string>;  // dueInDays -> locationId
  contactRoles: CompanyContactRole[];  // Available roles on this company
}

export interface SeedState {
  shop: string;
  token: string;
  databaseUrl: string | null;
  dryRun: boolean;
  reset: boolean;
  currencyCode: string;
  companies: Map<string, CompanyData>;
  paymentTermsTemplates: PaymentTermsTemplate[];
  createdCount: { companies: number; locations: number; orders: number; roleAssignments: number; dbRules: number; dbAccounts: number };
  skippedCount: { companies: number; orders: number; roleAssignments: number };
  deletedCount: { companies: number; orders: number };
  failedCount: { locations: number; orders: number; roleAssignments: number };
  ordersWithShopifyTerms: number;
  ordersWithoutShopifyTerms: number;
  overdueOrdersCount: number;
  taggedCustomerOrdersCount: number;
  errors: string[];
}

// -- GraphQL Client with Retry --

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Classify whether an error response is a throttle error that should be retried.
 * Returns true for:
 * - Top-level errors with THROTTLED code
 * - userErrors containing "Too many attempts"
 * - Top-level errors containing "Too many attempts"
 */
export function isThrottleError<T>(
  response: GraphQLResponse<T>,
  userErrors?: UserError[]
): boolean {
  // Check top-level GraphQL errors for THROTTLED code
  if (response.errors?.some(e => e.extensions?.code === "THROTTLED")) {
    return true;
  }
  // Check top-level errors for "Too many attempts" message
  if (response.errors?.some(e => e.message.includes("Too many attempts"))) {
    return true;
  }
  // Check userErrors for "Too many attempts" message
  if (userErrors?.some(e => e.message.includes("Too many attempts"))) {
    return true;
  }
  return false;
}

/**
 * Calculate retry delay with jitter for throttle backoff.
 * Base delays: 15s, 30s, 60s, 120s (capped at index 3)
 * Jitter: +/- 20% random variation
 */
export function calculateThrottleBackoffDelay(attemptIndex: number): number {
  const baseDelay = ORDER_CREATE_BACKOFF_DELAYS_MS[Math.min(attemptIndex, ORDER_CREATE_BACKOFF_DELAYS_MS.length - 1)];
  // Add jitter: +/- 20%
  const jitter = baseDelay * 0.2 * (Math.random() * 2 - 1);
  return Math.round(baseDelay + jitter);
}

export function formatCurrency(amount: number, currencyCode: string): string {
  return `${currencyCode} ${amount.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}


export interface GraphQLHelperOptions {
  isMutation?: boolean;
  mutationName?: string;
}

export function logGraphQLErrors<T>(
  response: GraphQLResponse<T>,
  mutationName?: string
): void {
  if (response.errors && response.errors.length > 0) {
    console.error(`  ❌ GraphQL errors${mutationName ? ` in ${mutationName}` : ""}:`);
    for (const err of response.errors) {
      const pathStr = err.path?.join(".") ?? "";
      const codeStr = err.extensions?.code ? ` [${err.extensions.code}]` : "";
      console.error(`     - ${err.message}${pathStr ? ` (path: ${pathStr})` : ""}${codeStr}`);
    }
  }

  if (response.data === null || response.data === undefined) {
    console.error(`  ❌ GraphQL response data is null${mutationName ? ` for ${mutationName}` : ""}`);
  } else if (mutationName && typeof response.data === "object") {
    const data = response.data as Record<string, unknown>;
    if (data[mutationName] === null || data[mutationName] === undefined) {
      console.error(`  ❌ Mutation root field '${mutationName}' is null`);
    }
  }
}

export function logUserErrors(userErrors: UserError[], context?: string): void {
  if (userErrors.length > 0) {
    console.error(`  ❌ User errors${context ? ` in ${context}` : ""}:`);
    for (const err of userErrors) {
      const fieldStr = err.field?.join(".") ?? "";
      const codeStr = err.code ? ` [${err.code}]` : "";
      console.error(`     - ${err.message}${fieldStr ? ` (field: ${fieldStr})` : ""}${codeStr}`);
    }
  }
}

export async function graphql<T>(
  state: SeedState,
  query: string,
  variables?: Record<string, unknown>,
  options?: GraphQLHelperOptions
): Promise<GraphQLResponse<T>> {
  const url = `https://${state.shop}/admin/api/${API_VERSION}/graphql.json`;
  let lastError: Error | null = null;
  const isMutation = options?.isMutation ?? false;
  const mutationName = options?.mutationName;

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

      // 429 is safe to retry: the request was rejected before execution
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

      // THROTTLED error is safe to retry: the request was rejected before execution
      const throttledError = json.errors?.find((e) => e.extensions?.code === "THROTTLED");
      if (throttledError) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        console.log(`  ⏳ Throttled, retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }

      // Log errors and data issues for better debugging
      logGraphQLErrors(json, mutationName);

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
      
      // Mutations must NOT retry on network errors: the request may have executed.
      // Only 429/THROTTLED are safe to retry (request rejected before execution).
      if (isMutation) {
        throw lastError;
      }
      
      // Queries can safely retry on network errors
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

  // Verify we have the required NET templates
  for (const loc of LOCATION_TERMS) {
    const template = state.paymentTermsTemplates.find(
      (t) => t.paymentTermsType === "NET" && t.dueInDays === loc.dueInDays
    );
    if (!template) {
      console.error(`  ❌ Missing required template: NET ${loc.dueInDays} days`);
      return false;
    }
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
  console.log(`    Orders found: ${state.deletedCount.orders} (cannot delete via API, remain tagged)`);
  
  if (state.deletedCount.orders > 0 && state.deletedCount.companies === 0) {
    console.log("\n  ⚠️  Note: companyDelete fails while orders exist for that company.");
    console.log("     To fully reset, cancel the seeded orders in Shopify Admin first,");
    console.log("     or manually delete companies after orders are archived.");
  }
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
  // Note: orders cannot be deleted via Admin API
  state.deletedCount.orders = orders.length;

  if (orders.length > 0) {
    console.log("  ⚠️  Orders cannot be deleted via API. They remain tagged for identification.");
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
    // Mutations must not retry on network errors (may have executed)
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
  console.log("\n🏢 Seeding B2B companies with multiple locations...");

  for (const seed of COMPANY_SEEDS) {
    const externalId = `${SEED_PREFIX}${seed.key}`;
    const existing = await findCompanyByExternalId(state, externalId);

    if (existing) {
      console.log(`  ⏭️  ${seed.name} already exists (${externalId})`);
      
      // Fetch contact roles for role assignment
      const contactRoles = await fetchCompanyContactRoles(state, existing.id);
      const contactId = existing.contacts.edges[0]?.node.id ?? "";
      
      // Build locations map from existing data
      const locations = new Map<number, string>();
      for (const edge of existing.locations.edges) {
        for (const loc of LOCATION_TERMS) {
          if (edge.node.name.includes(loc.suffix)) {
            locations.set(loc.dueInDays, edge.node.id);
          }
        }
      }
      
      // Store company data early for role assignment
      const companyData: CompanyData = {
        id: existing.id,
        contactId,
        contactCustomerId: existing.contacts.edges[0]?.node.customer.id ?? "",
        locations,
        contactRoles,
      };
      
      // Ensure role assignments on existing locations (idempotent)
      for (const [_dueInDays, locationId] of locations) {
        if (contactId && contactRoles.length > 0) {
          await ensureContactRoleOnLocation(state, companyData, locationId);
        }
      }
      
      // Create any missing Net-XX locations idempotently
      for (const loc of LOCATION_TERMS) {
        if (!locations.has(loc.dueInDays)) {
          console.log(`    → Creating missing location ${loc.suffix}...`);
          const template = state.paymentTermsTemplates.find(
            (t) => t.paymentTermsType === "NET" && t.dueInDays === loc.dueInDays
          );
          if (state.dryRun) {
            const dryRunLocationId = `dry-run-location-${seed.key}-${loc.dueInDays}`;
            locations.set(loc.dueInDays, dryRunLocationId);
            state.createdCount.locations++;
            // Dry-run role assignment
            await ensureContactRoleOnLocation(state, companyData, dryRunLocationId);
          } else {
            const locationId = await createCompanyLocation(state, existing.id, seed.name, seed.city, loc, template?.id);
            if (locationId) {
              locations.set(loc.dueInDays, locationId);
              console.log(`    ✅ Created location ${loc.suffix}`);
              state.createdCount.locations++;
              // Assign role on the newly created location (required for orders)
              if (contactId && contactRoles.length > 0) {
                await ensureContactRoleOnLocation(state, companyData, locationId);
              }
            } else {
              state.failedCount.locations++;
              state.errors.push(`Failed to create location ${loc.suffix} for ${seed.name}`);
            }
          }
        }
      }
      
      state.companies.set(seed.key, companyData);
      state.skippedCount.companies++;
      continue;
    }

    if (state.dryRun) {
      console.log(`  [dry-run] Would create: ${seed.name} (${externalId}) with 3 locations`);
      const locations = new Map<number, string>();
      for (const loc of LOCATION_TERMS) {
        locations.set(loc.dueInDays, `dry-run-location-${seed.key}-${loc.dueInDays}`);
      }
      state.companies.set(seed.key, {
        id: `dry-run-company-${seed.key}`,
        contactId: `dry-run-contact-${seed.key}`,
        contactCustomerId: `dry-run-customer-${seed.key}`,
        locations,
        contactRoles: [{ id: `dry-run-role-${seed.key}`, name: "Ordering only" }],
      });
      state.createdCount.companies++;
      state.createdCount.roleAssignments += 3; // 3 locations
      continue;
    }

    const result = await createCompanyWithLocations(state, seed, externalId);
    if (result) {
      state.companies.set(seed.key, result);
      state.createdCount.companies++;
      console.log(`  ✅ Created: ${seed.name} with ${result.locations.size} locations`);
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
          locations(first: 10) {
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

/**
 * Company creation mutation.
 * Note: India addresses require zoneCode (state code like MH for Maharashtra).
 */
export const COMPANY_CREATE_MUTATION = `
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

/**
 * Build CompanyCreateInput variables for the companyCreate mutation.
 * Exported for schema validation testing.
 */
export function buildCompanyCreateInput(
  seed: { name: string; city: string; contact: { firstName: string; lastName: string; email: string } },
  externalId: string,
  locationSuffix: string,
  paymentTermsTemplateId?: string
): { input: Record<string, unknown> } {
  const addressInfo = getIndiaAddressInfo(seed.city);
  return {
    input: {
      company: { name: seed.name, externalId },
      companyLocation: {
        name: `${seed.name} - ${locationSuffix}`,
        shippingAddress: {
          firstName: seed.contact.firstName,
          lastName: seed.contact.lastName,
          address1: "123 Business Street",
          city: seed.city,
          zoneCode: addressInfo.provinceCode,
          countryCode: "IN",
          zip: addressInfo.zip,
        },
        billingSameAsShipping: true,
        buyerExperienceConfiguration: paymentTermsTemplateId ? {
          paymentTermsTemplateId,
        } : undefined,
      },
      companyContact: {
        email: seed.contact.email,
        firstName: seed.contact.firstName,
        lastName: seed.contact.lastName,
      },
    },
  };
}

export async function createCompanyWithLocations(
  state: SeedState,
  seed: (typeof COMPANY_SEEDS)[number],
  externalId: string
): Promise<CompanyData | null> {
  const firstLoc = LOCATION_TERMS[0];
  const firstTemplate = state.paymentTermsTemplates.find(
    (t) => t.paymentTermsType === "NET" && t.dueInDays === firstLoc.dueInDays
  );

  const variables = buildCompanyCreateInput(seed, externalId, firstLoc.suffix, firstTemplate?.id);

  const createResult = await graphql<{
    companyCreate: { company: CompanyNode | null; userErrors: UserError[] };
  }>(state, COMPANY_CREATE_MUTATION, variables, { isMutation: true, mutationName: "companyCreate" });

  if (createResult.errors) {
    console.error(`    ❌ Failed to create company ${seed.name}: GraphQL errors`);
    return null;
  }

  if (createResult.data?.companyCreate.userErrors.length) {
    logUserErrors(createResult.data.companyCreate.userErrors, `createCompanyWithLocations(${seed.name})`);
    return null;
  }

  const company = createResult.data?.companyCreate.company;
  if (!company) {
    console.error(`    ❌ No company returned for ${seed.name} (companyCreate returned null)`);
    return null;
  }

  // Fetch contact roles for role assignment
  const contactRoles = await fetchCompanyContactRoles(state, company.id);
  const contactId = company.contacts.edges[0]?.node.id ?? "";

  const locations = new Map<number, string>();
  const firstLocationId = company.locations.edges[0]?.node.id;
  
  // Build partial company data for role assignment
  const companyData: CompanyData = {
    id: company.id,
    contactId,
    contactCustomerId: company.contacts.edges[0]?.node.customer.id ?? "",
    locations,
    contactRoles,
  };
  
  if (firstLocationId) {
    locations.set(firstLoc.dueInDays, firstLocationId);
    console.log(`    → Location ${firstLoc.suffix}: created`);
    state.createdCount.locations++;
    // Assign role on the first location (required for orders)
    if (contactId && contactRoles.length > 0) {
      await ensureContactRoleOnLocation(state, companyData, firstLocationId);
    }
  }

  // Create additional locations for remaining terms
  for (let i = 1; i < LOCATION_TERMS.length; i++) {
    const loc = LOCATION_TERMS[i];
    const template = state.paymentTermsTemplates.find(
      (t) => t.paymentTermsType === "NET" && t.dueInDays === loc.dueInDays
    );

    const locationId = await createCompanyLocation(state, company.id, seed.name, seed.city, loc, template?.id);
    if (locationId) {
      locations.set(loc.dueInDays, locationId);
      console.log(`    → Location ${loc.suffix}: created`);
      state.createdCount.locations++;
      // Assign role on each new location (required for orders)
      if (contactId && contactRoles.length > 0) {
        await ensureContactRoleOnLocation(state, companyData, locationId);
      }
    } else {
      state.failedCount.locations++;
      state.errors.push(`Failed to create location ${loc.suffix} for ${seed.name}`);
    }
  }

  return companyData;
}

/**
 * Company location creation mutation.
 * Note: India addresses require zoneCode (state code like MH for Maharashtra).
 */
export const COMPANY_LOCATION_CREATE_MUTATION = `
  mutation CreateCompanyLocation($companyId: ID!, $input: CompanyLocationInput!) {
    companyLocationCreate(companyId: $companyId, input: $input) {
      companyLocation {
        id
        name
      }
      userErrors { field message code }
    }
  }
`;

/**
 * Build CompanyLocationInput variables for the companyLocationCreate mutation.
 * Exported for schema validation testing.
 */
export function buildCompanyLocationCreateInput(
  companyId: string,
  companyName: string,
  city: string,
  loc: { suffix: string; dueInDays: number },
  paymentTermsTemplateId?: string
): { companyId: string; input: Record<string, unknown> } {
  const addressInfo = getIndiaAddressInfo(city);
  return {
    companyId,
    input: {
      name: `${companyName} - ${loc.suffix}`,
      shippingAddress: {
        firstName: "Branch",
        lastName: loc.suffix,
        address1: `${loc.dueInDays} Payment Lane`,
        city: city,
        zoneCode: addressInfo.provinceCode,
        countryCode: "IN",
        zip: addressInfo.zip,
      },
      billingSameAsShipping: true,
      buyerExperienceConfiguration: paymentTermsTemplateId ? {
        paymentTermsTemplateId,
      } : undefined,
    },
  };
}

async function createCompanyLocation(
  state: SeedState,
  companyId: string,
  companyName: string,
  city: string,
  loc: { suffix: string; dueInDays: number },
  paymentTermsTemplateId?: string
): Promise<string | null> {
  const variables = buildCompanyLocationCreateInput(companyId, companyName, city, loc, paymentTermsTemplateId);

  const result = await graphql<{
    companyLocationCreate: {
      companyLocation: { id: string; name: string } | null;
      userErrors: UserError[];
    };
  }>(state, COMPANY_LOCATION_CREATE_MUTATION, variables, { isMutation: true, mutationName: "companyLocationCreate" });

  if (result.errors) {
    console.error(`    ❌ Failed to create location ${loc.suffix}: GraphQL errors`);
    return null;
  }

  if (result.data?.companyLocationCreate.userErrors.length) {
    logUserErrors(result.data.companyLocationCreate.userErrors, `createCompanyLocation(${loc.suffix})`);
    return null;
  }

  const location = result.data?.companyLocationCreate.companyLocation;
  if (!location) {
    console.error(`    ❌ No location returned for ${loc.suffix} (companyLocationCreate returned null)`);
    return null;
  }

  return location.id;
}

// -- Role Assignment --

/**
 * Query to fetch contact roles available on a company.
 */
export const COMPANY_CONTACT_ROLES_QUERY = `
  query GetCompanyContactRoles($companyId: ID!) {
    company(id: $companyId) {
      contactRoles(first: 10) {
        nodes {
          id
          name
        }
      }
    }
  }
`;

/**
 * Query to check existing role assignments on a company location.
 */
export const COMPANY_LOCATION_ROLE_ASSIGNMENTS_QUERY = `
  query GetLocationRoleAssignments($locationId: ID!) {
    companyLocation(id: $locationId) {
      roleAssignments(first: 50) {
        nodes {
          id
          companyContact { id }
          role { id name }
        }
      }
    }
  }
`;

/**
 * Mutation to assign roles on a company location.
 */
export const COMPANY_LOCATION_ASSIGN_ROLES_MUTATION = `
  mutation AssignRolesToLocation($companyLocationId: ID!, $rolesToAssign: [CompanyLocationRoleAssign!]!) {
    companyLocationAssignRoles(companyLocationId: $companyLocationId, rolesToAssign: $rolesToAssign) {
      roleAssignments {
        id
        companyContact { id }
        role { id name }
      }
      userErrors { field message code }
    }
  }
`;

/**
 * Build variables for companyLocationAssignRoles mutation.
 * Exported for schema validation testing.
 */
export function buildCompanyLocationAssignRolesInput(
  companyLocationId: string,
  companyContactId: string,
  companyContactRoleId: string
): { companyLocationId: string; rolesToAssign: Array<{ companyContactRoleId: string; companyContactId: string }> } {
  return {
    companyLocationId,
    rolesToAssign: [{
      companyContactRoleId,
      companyContactId,
    }],
  };
}

/**
 * Fetch available contact roles for a company.
 */
export async function fetchCompanyContactRoles(
  state: SeedState,
  companyId: string
): Promise<CompanyContactRole[]> {
  const result = await graphql<{
    company: { contactRoles: { nodes: CompanyContactRole[] } } | null;
  }>(state, COMPANY_CONTACT_ROLES_QUERY, { companyId });

  return result.data?.company?.contactRoles.nodes ?? [];
}

/**
 * Check if a contact already has a role assignment on a location.
 * Returns true if the contact already has ANY role on this location.
 */
export async function hasContactRoleOnLocation(
  state: SeedState,
  locationId: string,
  contactId: string
): Promise<boolean> {
  const result = await graphql<{
    companyLocation: { roleAssignments: { nodes: CompanyContactRoleAssignment[] } } | null;
  }>(state, COMPANY_LOCATION_ROLE_ASSIGNMENTS_QUERY, { locationId });

  const assignments = result.data?.companyLocation?.roleAssignments.nodes ?? [];
  return assignments.some(a => a.companyContact.id === contactId);
}

/**
 * Assign a role to a contact on a company location.
 * Returns true if successful, false on failure.
 */
async function assignRoleToContactOnLocation(
  state: SeedState,
  locationId: string,
  contactId: string,
  roleId: string,
  roleName: string
): Promise<boolean> {
  const variables = buildCompanyLocationAssignRolesInput(locationId, contactId, roleId);

  const result = await graphql<{
    companyLocationAssignRoles: {
      roleAssignments: CompanyContactRoleAssignment[] | null;
      userErrors: Array<{ field: string[] | null; message: string; code?: string }>;
    };
  }>(state, COMPANY_LOCATION_ASSIGN_ROLES_MUTATION, variables, { isMutation: true, mutationName: "companyLocationAssignRoles" });

  if (result.errors) {
    console.error(`    ❌ Failed to assign role: GraphQL errors`);
    return false;
  }

  const payload = result.data?.companyLocationAssignRoles;
  if (!payload) {
    console.error(`    ❌ Failed to assign role: no response payload`);
    return false;
  }

  if (payload.userErrors.length) {
    console.error(`    ❌ Failed to assign role: ${payload.userErrors[0].message}${payload.userErrors[0].code ? ` [${payload.userErrors[0].code}]` : ""}`);
    return false;
  }

  console.log(`    → Assigned role "${roleName}" to contact on location`);
  return true;
}

/**
 * Ensure the company's main contact has a role on the specified location.
 * Idempotent: checks existing assignments first.
 * Prefers "Ordering only" role, falls back to the first available role.
 * 
 * @returns true if role is assigned (or was already assigned), false on failure
 */
export async function ensureContactRoleOnLocation(
  state: SeedState,
  companyData: CompanyData,
  locationId: string
): Promise<boolean> {
  // Check if contact already has a role on this location
  const alreadyAssigned = await hasContactRoleOnLocation(state, locationId, companyData.contactId);
  if (alreadyAssigned) {
    state.skippedCount.roleAssignments++;
    return true;
  }

  // Get available roles (prefer "Ordering only", else first)
  const roles = companyData.contactRoles;
  if (roles.length === 0) {
    console.error(`    ❌ No contact roles available on company`);
    state.failedCount.roleAssignments++;
    state.errors.push(`No contact roles available for role assignment`);
    return false;
  }

  const preferredRole = roles.find(r => r.name === "Ordering only") ?? roles[0];

  if (state.dryRun) {
    console.log(`    [dry-run] Would assign role "${preferredRole.name}" to contact on location`);
    state.createdCount.roleAssignments++;
    return true;
  }

  const success = await assignRoleToContactOnLocation(
    state,
    locationId,
    companyData.contactId,
    preferredRole.id,
    preferredRole.name
  );

  if (success) {
    state.createdCount.roleAssignments++;
  } else {
    state.failedCount.roleAssignments++;
    state.errors.push(`Failed to assign role on location`);
  }

  return success;
}

// -- Seeding: Orders --

export async function seedOrders(state: SeedState): Promise<void> {
  console.log("\n📝 Seeding B2B orders with backdated processedAt...");
  console.log("   (processedAt per OrderCreateOrderInput: 'The date and time when the order was created')");
  console.log(`   (Pacing: ${SEED_ORDER_DELAY_MS}ms between orders to avoid dev store throttling)`);

  const totalOrders = ORDER_DISTRIBUTION.length;
  let orderIndex = 0;
  let isFirstOrder = true;
  
  for (const orderSpec of ORDER_DISTRIBUTION) {
    orderIndex++;
    const orderKey = `${SEED_PREFIX}order-${orderIndex}`;

    // Check if order already exists (idempotency)
    const existingOrder = await findOrderByTag(state, orderKey);
    if (existingOrder) {
      console.log(`  ⏭️  [${orderIndex}/${totalOrders}] Order already exists (${existingOrder.name})`);
      state.skippedCount.orders++;
      continue;
    }

    const company = state.companies.get(orderSpec.entityKey);
    if (!company) {
      console.error(`  ❌ [${orderIndex}/${totalOrders}] Company ${orderSpec.entityKey} not found`);
      state.errors.push(`Company ${orderSpec.entityKey} not found for order ${orderIndex}`);
      continue;
    }

    // Get the location for the specified payment terms
    const locationId = company.locations.get(orderSpec.locationTermsDays);
    if (!locationId) {
      console.error(`  ❌ [${orderIndex}/${totalOrders}] Location for Net ${orderSpec.locationTermsDays} not found for ${orderSpec.entityKey}`);
      state.errors.push(`Location Net ${orderSpec.locationTermsDays} not found for ${orderSpec.entityKey}`);
      continue;
    }

    // Guard against empty or missing contactCustomerId
    if (!company.contactCustomerId) {
      console.log(`  ⚠️  [${orderIndex}/${totalOrders}] Skipping: no contactCustomerId for ${orderSpec.entityKey}`);
      continue;
    }

    // Add pacing delay between orders (skip for first order)
    if (!isFirstOrder && !state.dryRun) {
      console.log(`  ⏳ Waiting ${SEED_ORDER_DELAY_MS}ms before next order...`);
      await sleep(SEED_ORDER_DELAY_MS);
    }
    isFirstOrder = false;

    // Generate random amount
    const amountRange = AMOUNT_RANGES_INR[orderIndex % AMOUNT_RANGES_INR.length];
    const amount = Math.floor(Math.random() * (amountRange.max - amountRange.min) + amountRange.min);

    // Pick a sample product name for the custom line item
    const productTitle = SAMPLE_PRODUCTS[orderIndex % SAMPLE_PRODUCTS.length];

    // Calculate processedAt date (backdated)
    const processedAt = new Date();
    processedAt.setDate(processedAt.getDate() - orderSpec.daysAgo);

    if (state.dryRun) {
      const isOverdue = orderSpec.daysAgo > orderSpec.locationTermsDays;
      if (isOverdue) {
        state.overdueOrdersCount++;
      }
      console.log(
        `  [dry-run] [${orderIndex}/${totalOrders}] Would create order: ${orderSpec.entityKey}, ` +
          `Net ${orderSpec.locationTermsDays}, ${orderSpec.daysAgo} days ago${isOverdue ? " (OVERDUE)" : ""}, ` +
          formatCurrency(amount, state.currencyCode)
      );
      state.createdCount.orders++;
      continue;
    }

    // Create B2B order using orderCreate with custom line items
    const order = await createOrder(state, {
      orderKey,
      companyLocationId: locationId,
      customerId: company.contactCustomerId,
      productTitle,
      amount,
      processedAt: processedAt.toISOString(),
      expectedTermsDays: orderSpec.locationTermsDays,
    });

    if (!order) {
      state.failedCount.orders++;
      state.errors.push(`Failed to create order ${orderIndex}`);
      continue;
    }

    state.createdCount.orders++;
    const isOverdue = orderSpec.daysAgo > orderSpec.locationTermsDays;
    if (isOverdue) {
      state.overdueOrdersCount++;
    }
    console.log(
      `  ✅ [${orderIndex}/${totalOrders}] Created ${order.name}: ` +
        `Net ${orderSpec.locationTermsDays}, ${orderSpec.daysAgo} days ago${isOverdue ? " (OVERDUE)" : ""}, ` +
        formatCurrency(amount, state.currencyCode)
    );
  }
}

/**
 * Query to find an order by tag (used for idempotency check).
 */
export const FIND_ORDER_BY_TAG_QUERY = `
  query FindOrder($query: String!) {
    orders(first: 1, query: $query) {
      nodes { id name tags }
    }
  }
`;

export async function findOrderByTag(state: SeedState, tag: string): Promise<OrderNode | null> {
  const result = await graphql<{ orders: { nodes: OrderNode[] } }>(state, FIND_ORDER_BY_TAG_QUERY, { query: `tag:'${tag}'` });
  return result.data?.orders.nodes[0] ?? null;
}

// Tagged customer seeds - one per term (Net 15, 30, 60)
// These are non-B2B customers used to test the tagged-customer path of S9 inference
export const TAGGED_CUSTOMER_SEEDS = [
  { email: `${SEED_PREFIX}net15@example.com`, termsDays: 15 },
  { email: `${SEED_PREFIX}net30@example.com`, termsDays: 30 },
  { email: `${SEED_PREFIX}net60@example.com`, termsDays: 60 },
] as const;

// Non-B2B order distribution for tagged customers
// daysAgo creates backdated orders, some will be overdue
export const TAGGED_ORDER_DISTRIBUTION = [
  // Net 15 orders
  { customerTermsDays: 15, daysAgo: 20 },  // Overdue (20 > 15)
  { customerTermsDays: 15, daysAgo: 10 },  // Not yet due
  // Net 30 orders
  { customerTermsDays: 30, daysAgo: 35 },  // Overdue (35 > 30)
  { customerTermsDays: 30, daysAgo: 15 },  // Not yet due
  // Net 60 orders
  { customerTermsDays: 60, daysAgo: 45 },  // Not yet due
] as const;

/**
 * Find or create a tagged customer, then tag with tagsAdd (idempotent).
 * Does NOT tag B2B contacts - their terms come from location/DB defaults.
 *
 * @returns Customer ID or null on failure
 */
async function ensureTaggedCustomer(
  state: SeedState,
  email: string,
  termsDays: number
): Promise<string | null> {
  const tag = `${SEED_TAG}-net${termsDays}`;

  // First, try to find existing customer by email
  const findResult = await graphql<{
    customers: { nodes: Array<{ id: string; tags: string[] }> };
  }>(state, `
    query FindCustomer($query: String!) {
      customers(first: 1, query: $query) {
        nodes { id tags }
      }
    }
  `, { query: `email:${email}` });

  if (findResult.errors) {
    console.log(`    ⚠️  GraphQL error finding customer: ${findResult.errors.map(e => e.message).join(", ")}`);
    return null;
  }

  let customerId = findResult.data?.customers.nodes[0]?.id;

  // If not found, create new customer
  if (!customerId) {
    const createResult = await graphql<{
      customerCreate: {
        customer: { id: string } | null;
        userErrors: UserError[];
      };
    }>(state, `
      mutation CreateCustomer($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer { id }
          userErrors { field message }
        }
      }
    `, {
      input: {
        email,
        tags: [SEED_TAG],
      },
    }, { isMutation: true });

    if (createResult.errors) {
      console.log(`    ⚠️  GraphQL error creating customer: ${createResult.errors.map(e => e.message).join(", ")}`);
      return null;
    }

    if (createResult.data?.customerCreate.userErrors.length) {
      console.log(`    ⚠️  Failed to create customer: ${createResult.data.customerCreate.userErrors[0].message}`);
      return null;
    }

    customerId = createResult.data?.customerCreate.customer?.id;
    if (!customerId) {
      console.log(`    ⚠️  No customer ID returned`);
      return null;
    }
    console.log(`    → Created customer: ${email}`);
  }

  // Use tagsAdd to add the terms tag (idempotent - won't duplicate)
  const tagResult = await graphql<{
    tagsAdd: {
      node: { id: string } | null;
      userErrors: UserError[];
    };
  }>(state, `
    mutation TagCustomer($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        node { ... on Customer { id } }
        userErrors { field message }
      }
    }
  `, {
    id: customerId,
    tags: [tag],
  }, { isMutation: true });

  if (tagResult.errors) {
    console.log(`    ⚠️  GraphQL error tagging customer: ${tagResult.errors.map(e => e.message).join(", ")}`);
  }

  if (tagResult.data?.tagsAdd.userErrors.length) {
    console.log(`    ⚠️  Failed to tag customer: ${tagResult.data.tagsAdd.userErrors[0].message}`);
  }

  return customerId;
}

/**
 * Seed orders for tagged (non-B2B) customers.
 * Creates customers with tagsAdd (idempotent) and places orders.
 */
export async function seedTaggedCustomerOrders(state: SeedState): Promise<void> {
  console.log("\n📝 Seeding orders for tagged (non-B2B) customers...");
  console.log("   (These test the AccountSource tag rules path of S9 inference)");
  console.log(`   (Pacing: ${SEED_ORDER_DELAY_MS}ms between orders to avoid dev store throttling)`);

  // Build customer map: termsDays -> customerId
  const customerMap = new Map<number, string>();

  for (const seed of TAGGED_CUSTOMER_SEEDS) {
    if (state.dryRun) {
      console.log(`  [dry-run] Would create/tag customer for Net ${seed.termsDays}`);
      customerMap.set(seed.termsDays, `dry-run-customer-${seed.termsDays}`);
      continue;
    }

    const customerId = await ensureTaggedCustomer(state, seed.email, seed.termsDays);
    if (customerId) {
      customerMap.set(seed.termsDays, customerId);
      console.log(`  ✅ Customer tagged with ${SEED_TAG}-net${seed.termsDays}`);
    }
  }

  // Place orders for tagged customers (no B2B, no companyLocationId)
  const totalTaggedOrders = TAGGED_ORDER_DISTRIBUTION.length;
  let orderIndex = 0;
  let isFirstOrder = true;
  
  for (const orderSpec of TAGGED_ORDER_DISTRIBUTION) {
    orderIndex++;
    const orderKey = `${SEED_PREFIX}tagged-order-${orderIndex}`;

    const existingOrder = await findOrderByTag(state, orderKey);
    if (existingOrder) {
      console.log(`  ⏭️  [${orderIndex}/${totalTaggedOrders}] Tagged order already exists (${existingOrder.name})`);
      state.skippedCount.orders++;
      continue;
    }

    const customerId = customerMap.get(orderSpec.customerTermsDays);
    if (!customerId) {
      console.error(`  ❌ [${orderIndex}/${totalTaggedOrders}] No customer found for Net ${orderSpec.customerTermsDays}`);
      continue;
    }

    // Add pacing delay between orders (skip for first order)
    if (!isFirstOrder && !state.dryRun) {
      console.log(`  ⏳ Waiting ${SEED_ORDER_DELAY_MS}ms before next order...`);
      await sleep(SEED_ORDER_DELAY_MS);
    }
    isFirstOrder = false;

    const amountRange = AMOUNT_RANGES_INR[orderIndex % AMOUNT_RANGES_INR.length];
    const amount = Math.floor(Math.random() * (amountRange.max - amountRange.min) + amountRange.min);
    const productTitle = SAMPLE_PRODUCTS[orderIndex % SAMPLE_PRODUCTS.length];

    const processedAt = new Date();
    processedAt.setDate(processedAt.getDate() - orderSpec.daysAgo);

    if (state.dryRun) {
      const isOverdue = orderSpec.daysAgo > orderSpec.customerTermsDays;
      if (isOverdue) state.overdueOrdersCount++;
      console.log(
        `  [dry-run] [${orderIndex}/${totalTaggedOrders}] Would create tagged order: ` +
          `Net ${orderSpec.customerTermsDays}, ${orderSpec.daysAgo} days ago${isOverdue ? " (OVERDUE)" : ""}, ` +
          formatCurrency(amount, state.currencyCode)
      );
      state.createdCount.orders++;
      state.taggedCustomerOrdersCount++;
      continue;
    }

    // Create non-B2B order (no companyLocationId)
    const order = await createTaggedCustomerOrder(state, {
      orderKey,
      customerId,
      productTitle,
      amount,
      processedAt: processedAt.toISOString(),
      expectedTermsDays: orderSpec.customerTermsDays,
    });

    if (!order) {
      state.failedCount.orders++;
      state.errors.push(`Failed to create tagged order ${orderIndex}`);
      continue;
    }

    state.createdCount.orders++;
    state.taggedCustomerOrdersCount++;
    const isOverdue = orderSpec.daysAgo > orderSpec.customerTermsDays;
    if (isOverdue) state.overdueOrdersCount++;
    console.log(
      `  ✅ [${orderIndex}/${totalTaggedOrders}] Created ${order.name}: tagged customer, ` +
        `Net ${orderSpec.customerTermsDays}, ${orderSpec.daysAgo} days ago${isOverdue ? " (OVERDUE)" : ""}, ` +
        formatCurrency(amount, state.currencyCode)
    );
  }
}

/**
 * Create an order for a tagged (non-B2B) customer.
 * Similar to createOrder but without companyLocationId.
 */
export const TAGGED_CUSTOMER_ORDER_CREATE_MUTATION = `
  mutation CreateOrder($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      order {
        id
        name
        displayFinancialStatus
        totalPriceSet {
          shopMoney { amount currencyCode }
        }
      }
      userErrors { field message code }
    }
  }
`;

/**
 * Default city for orders without company association (tagged customer orders).
 */
const DEFAULT_ORDER_CITY = "Mumbai";

/**
 * Build OrderCreateOrderInput variables for tagged customer orders.
 * Uses MailingAddressInput which has provinceCode (not zoneCode).
 * Exported for schema validation testing.
 */
export function buildTaggedCustomerOrderInput(
  options: {
    orderKey: string;
    customerId: string;
    productTitle: string;
    amount: number;
    processedAt: string;
    currencyCode: string;
    city?: string;
  }
): { order: Record<string, unknown>; options: Record<string, unknown> } {
  const city = options.city ?? DEFAULT_ORDER_CITY;
  const addressInfo = getIndiaAddressInfo(city);
  return {
    order: {
      tags: [SEED_TAG, options.orderKey],
      customer: { toAssociate: { id: options.customerId } },
      currency: options.currencyCode,
      financialStatus: "PENDING",
      processedAt: options.processedAt,
      lineItems: [{
        title: options.productTitle,
        quantity: 1,
        priceSet: {
          shopMoney: {
            amount: String(options.amount),
            currencyCode: options.currencyCode,
          },
        },
      }],
      billingAddress: {
        firstName: "Tagged",
        lastName: "Customer",
        address1: "123 Test Street",
        city: city,
        provinceCode: addressInfo.provinceCode,
        countryCode: "IN",
        zip: addressInfo.zip,
      },
      shippingAddress: {
        firstName: "Tagged",
        lastName: "Customer",
        address1: "123 Test Street",
        city: city,
        provinceCode: addressInfo.provinceCode,
        countryCode: "IN",
        zip: addressInfo.zip,
      },
    },
    options: {
      sendReceipt: false,
      sendFulfillmentReceipt: false,
      inventoryBehaviour: "BYPASS",
    },
  };
}

async function createTaggedCustomerOrder(
  state: SeedState,
  options: {
    orderKey: string;
    customerId: string;
    productTitle: string;
    amount: number;
    processedAt: string;
    expectedTermsDays: number;
  }
): Promise<{ id: string; name: string } | null> {
  const variables = buildTaggedCustomerOrderInput({
    orderKey: options.orderKey,
    customerId: options.customerId,
    productTitle: options.productTitle,
    amount: options.amount,
    processedAt: options.processedAt,
    currencyCode: state.currencyCode,
  });

  // Retry loop with exponential backoff for throttle errors
  for (let attempt = 0; attempt < ORDER_CREATE_MAX_ATTEMPTS; attempt++) {
    const result = await graphql<{
      orderCreate: {
        order: {
          id: string;
          name: string;
          displayFinancialStatus: string;
          totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
        } | null;
        userErrors: UserError[];
      };
    }>(state, TAGGED_CUSTOMER_ORDER_CREATE_MUTATION, variables, { isMutation: true, mutationName: "orderCreate" });

    const userErrors = result.data?.orderCreate.userErrors ?? [];

    // Check for throttle errors - retry if detected
    if (isThrottleError(result, userErrors)) {
      if (attempt < ORDER_CREATE_MAX_ATTEMPTS - 1) {
        const delay = calculateThrottleBackoffDelay(attempt);
        console.log(`    ⏳ Throttled (attempt ${attempt + 1}/${ORDER_CREATE_MAX_ATTEMPTS}), retrying in ${Math.round(delay / 1000)}s...`);
        await sleep(delay);
        continue;
      } else {
        console.error(`    ❌ Throttle limit reached after ${ORDER_CREATE_MAX_ATTEMPTS} attempts`);
        return null;
      }
    }

    // Handle non-throttle errors
    if (result.errors) {
      return null;
    }

    if (userErrors.length) {
      logUserErrors(userErrors, "createTaggedCustomerOrder");
      return null;
    }

    const order = result.data?.orderCreate.order;
    if (!order) {
      console.error(`    ❌ No order returned from createTaggedCustomerOrder`);
      return null;
    }

    // No Shopify terms for non-B2B orders - S9 inference will use tag rules
    state.ordersWithoutShopifyTerms++;
    console.log(`    → No Shopify terms (will use tag rule: Net ${options.expectedTermsDays})`);

    return {
      id: order.id,
      name: order.name,
    };
  }

  // Should not reach here, but safety return
  return null;
}

/**
 * B2B order creation mutation.
 * Uses displayFinancialStatus (2026-10 schema) instead of financialStatus.
 */
export const B2B_ORDER_CREATE_MUTATION = `
  mutation CreateOrder($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      order {
        id
        name
        displayFinancialStatus
        totalPriceSet {
          shopMoney { amount currencyCode }
        }
        paymentTerms {
          paymentTermsName
          paymentTermsType
          dueInDays
          paymentSchedules(first: 1) {
            nodes {
              dueAt
            }
          }
        }
      }
      userErrors { field message code }
    }
  }
`;

/**
 * Build OrderCreateOrderInput variables for B2B orders.
 * Uses MailingAddressInput which has provinceCode (not zoneCode).
 * Exported for schema validation testing.
 */
export function buildB2BOrderInput(
  options: {
    orderKey: string;
    companyLocationId: string;
    customerId: string;
    productTitle: string;
    amount: number;
    processedAt: string;
    currencyCode: string;
    city?: string;
  }
): { order: Record<string, unknown>; options: Record<string, unknown> } {
  const city = options.city ?? DEFAULT_ORDER_CITY;
  const addressInfo = getIndiaAddressInfo(city);
  return {
    order: {
      tags: [SEED_TAG, options.orderKey],
      companyLocationId: options.companyLocationId,
      customer: { toAssociate: { id: options.customerId } },
      currency: options.currencyCode,
      financialStatus: "PENDING",
      processedAt: options.processedAt,
      lineItems: [{
        title: options.productTitle,
        quantity: 1,
        priceSet: {
          shopMoney: {
            amount: String(options.amount),
            currencyCode: options.currencyCode,
          },
        },
      }],
      billingAddress: {
        firstName: "B2B",
        lastName: "Billing",
        address1: "123 Business Street",
        city: city,
        provinceCode: addressInfo.provinceCode,
        countryCode: "IN",
        zip: addressInfo.zip,
      },
      shippingAddress: {
        firstName: "B2B",
        lastName: "Shipping",
        address1: "123 Business Street",
        city: city,
        provinceCode: addressInfo.provinceCode,
        countryCode: "IN",
        zip: addressInfo.zip,
      },
    },
    options: {
      sendReceipt: false,
      sendFulfillmentReceipt: false,
      inventoryBehaviour: "BYPASS",
    },
  };
}

/**
 * Create a B2B order using orderCreate with custom line items.
 * 
 * Key features:
 * - Custom line items with title + priceSet (no product variants needed)
 * - companyLocationId for B2B association
 * - financialStatus: PENDING to mark as unpaid
 * - processedAt for backdating orders
 *   @see https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/OrderCreateOrderInput
 *   "processedAt: The date and time when the order was created."
 * - sendReceipt: false to suppress customer emails
 * - Retry with exponential backoff on throttle errors ("Too many attempts")
 * 
 * If Shopify returns null paymentTerms, logs a warning but does not fail.
 * S9 inference will use DB defaults instead.
 */
export async function createOrder(
  state: SeedState,
  options: {
    orderKey: string;
    companyLocationId: string;
    customerId: string;
    productTitle: string;
    amount: number;
    processedAt: string;
    expectedTermsDays: number;
  }
): Promise<{ id: string; name: string } | null> {
  const variables = buildB2BOrderInput({
    orderKey: options.orderKey,
    companyLocationId: options.companyLocationId,
    customerId: options.customerId,
    productTitle: options.productTitle,
    amount: options.amount,
    processedAt: options.processedAt,
    currencyCode: state.currencyCode,
  });

  // Retry loop with exponential backoff for throttle errors
  for (let attempt = 0; attempt < ORDER_CREATE_MAX_ATTEMPTS; attempt++) {
    const result = await graphql<{
      orderCreate: {
        order: {
          id: string;
          name: string;
          displayFinancialStatus: string;
          totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
          paymentTerms: OrderPaymentTerms | null;
        } | null;
        userErrors: UserError[];
      };
    }>(state, B2B_ORDER_CREATE_MUTATION, variables, { isMutation: true, mutationName: "orderCreate" });

    const userErrors = result.data?.orderCreate.userErrors ?? [];

    // Check for throttle errors - retry if detected
    if (isThrottleError(result, userErrors)) {
      if (attempt < ORDER_CREATE_MAX_ATTEMPTS - 1) {
        const delay = calculateThrottleBackoffDelay(attempt);
        console.log(`    ⏳ Throttled (attempt ${attempt + 1}/${ORDER_CREATE_MAX_ATTEMPTS}), retrying in ${Math.round(delay / 1000)}s...`);
        await sleep(delay);
        continue;
      } else {
        console.error(`    ❌ Throttle limit reached after ${ORDER_CREATE_MAX_ATTEMPTS} attempts`);
        return null;
      }
    }

    // Handle non-throttle errors
    if (result.errors) {
      return null;
    }

    if (userErrors.length) {
      logUserErrors(userErrors, "createOrder");
      return null;
    }

    const order = result.data?.orderCreate.order;
    if (!order) {
      console.error(`    ❌ No order returned from createOrder`);
      return null;
    }

    // Log the actual terms from the response (not the spec)
    if (order.paymentTerms) {
      state.ordersWithShopifyTerms++;
      const terms = order.paymentTerms;
      const dueAt = terms.paymentSchedules.nodes[0]?.dueAt;
      console.log(
        `    → Shopify terms: ${terms.paymentTermsName} ` +
        `(${terms.paymentTermsType}, ${terms.dueInDays ?? 0} days` +
        `${dueAt ? `, due ${dueAt.split("T")[0]}` : ""})`
      );
    } else {
      state.ordersWithoutShopifyTerms++;
      console.log(
        `    → No Shopify terms (will use DB default: Net ${options.expectedTermsDays})`
      );
    }

    return {
      id: order.id,
      name: order.name,
    };
  }

  // Should not reach here, but safety return
  return null;
}

// -- Database Seeding --

/**
 * Seed the database with tag rules and buyer account defaults.
 * This enables S9 inference to compute due dates even when Shopify
 * doesn't return paymentTerms on orders.
 * 
 * Creates (idempotently):
 * - Shop record with default terms
 * - AccountSource tag rules for Net 15/30/60
 * - BuyerAccount records with explicit defaultTermsDays
 */
export async function seedDatabase(state: SeedState): Promise<void> {
  if (!state.databaseUrl) {
    console.log("\n💾 Database seeding skipped (DATABASE_URL not set)");
    console.log("   To enable S9 inference for orders without Shopify terms, run:");
    console.log("   export DATABASE_URL=postgres://...");
    console.log("   ");
    console.log("   Or manually run this SQL:");
    console.log("   ---");
    printDatabaseSeedSQL(state);
    console.log("   ---");
    return;
  }

  console.log("\n💾 Seeding database for S9 inference...");

  if (state.dryRun) {
    console.log("  [dry-run] Would seed Shop, AccountSource, and BuyerAccount records");
    return;
  }

  const sql = postgres(state.databaseUrl, { max: 1 });

  try {
    // Upsert Shop record
    const shopResult = await sql`
      INSERT INTO "Shop" (id, domain, currency, plan, "defaultTermsDays", timezone, "createdAt", "updatedAt")
      VALUES (
        ${`seed-shop-${state.shop}`},
        ${state.shop},
        ${state.currencyCode},
        'development',
        30,
        'Asia/Kolkata',
        NOW(),
        NOW()
      )
      ON CONFLICT (domain) DO UPDATE SET
        currency = EXCLUDED.currency,
        "updatedAt" = NOW()
      RETURNING id
    `;
    const shopId = shopResult[0]?.id;
    console.log(`  ✅ Shop record: ${state.shop}`);

    // Upsert AccountSource tag rules for Net 15/30/60
    for (const loc of LOCATION_TERMS) {
      const tag = `${SEED_TAG}-net${loc.dueInDays}`;
      await sql`
        INSERT INTO "AccountSource" (id, "shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
        VALUES (
          ${`seed-source-${tag}`},
          ${shopId},
          ${tag},
          ${loc.dueInDays},
          NOW(),
          NOW()
        )
        ON CONFLICT ("shopId", tag) DO UPDATE SET
          "defaultTermsDays" = EXCLUDED."defaultTermsDays",
          "updatedAt" = NOW()
      `;
      state.createdCount.dbRules++;
      console.log(`  ✅ Tag rule: ${tag} → Net ${loc.dueInDays}`);
    }

    // Upsert BuyerAccount records for each company location
    for (const [companyKey, company] of state.companies) {
      for (const [dueInDays, locationId] of company.locations) {
        const accountName = `${COMPANY_SEEDS.find(c => c.key === companyKey)?.name ?? companyKey} - Net ${dueInDays}`;
        await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "companyId", "companyLocationId", name,
            "defaultTermsDays", "defaultTermsSource", "holdState", "createdAt", "updatedAt"
          )
          VALUES (
            ${`seed-account-${locationId}`},
            ${shopId},
            'COMPANY',
            ${company.id},
            ${locationId},
            ${accountName},
            ${dueInDays},
            'explicit',
            'OK',
            NOW(),
            NOW()
          )
          ON CONFLICT ("shopId", "companyLocationId") DO UPDATE SET
            "defaultTermsDays" = EXCLUDED."defaultTermsDays",
            "defaultTermsSource" = EXCLUDED."defaultTermsSource",
            "updatedAt" = NOW()
        `;
        state.createdCount.dbAccounts++;
      }
    }
    console.log(`  ✅ BuyerAccounts: ${state.createdCount.dbAccounts} with explicit default terms`);

  } finally {
    await sql.end();
  }
}

export function printDatabaseSeedSQL(state: SeedState): void {
  const shopId = `seed-shop-${state.shop}`;
  
  console.log(`-- Upsert Shop`);
  console.log(`INSERT INTO "Shop" (id, domain, currency, plan, "defaultTermsDays", timezone, "createdAt", "updatedAt")`);
  console.log(`VALUES ('${shopId}', '${state.shop}', '${state.currencyCode || "INR"}', 'development', 30, 'Asia/Kolkata', NOW(), NOW())`);
  console.log(`ON CONFLICT (domain) DO UPDATE SET currency = EXCLUDED.currency, "updatedAt" = NOW();`);
  console.log();

  console.log(`-- Upsert AccountSource tag rules`);
  for (const loc of LOCATION_TERMS) {
    const tag = `${SEED_TAG}-net${loc.dueInDays}`;
    console.log(`INSERT INTO "AccountSource" (id, "shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")`);
    console.log(`VALUES ('seed-source-${tag}', '${shopId}', '${tag}', ${loc.dueInDays}, NOW(), NOW())`);
    console.log(`ON CONFLICT ("shopId", tag) DO UPDATE SET "defaultTermsDays" = EXCLUDED."defaultTermsDays", "updatedAt" = NOW();`);
  }
  console.log();

  console.log(`-- Upsert BuyerAccount records for each company location`);
  for (const [companyKey, company] of state.companies) {
    for (const [dueInDays, locationId] of company.locations) {
      const rawName = `${COMPANY_SEEDS.find(c => c.key === companyKey)?.name ?? companyKey} - Net ${dueInDays}`;
      // Escape single quotes for SQL (double them)
      const accountName = rawName.replace(/'/g, "''");
      console.log(`INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "defaultTermsDays", "defaultTermsSource", "holdState", "createdAt", "updatedAt")`);
      console.log(`VALUES ('seed-account-${locationId}', '${shopId}', 'COMPANY', '${company.id}', '${locationId}', '${accountName}', ${dueInDays}, 'explicit', 'OK', NOW(), NOW())`);
      console.log(`ON CONFLICT ("shopId", "companyLocationId") DO UPDATE SET "defaultTermsDays" = EXCLUDED."defaultTermsDays", "defaultTermsSource" = EXCLUDED."defaultTermsSource", "updatedAt" = NOW();`);
    }
  }
}

// -- Main --

function parseArgs(): { dryRun: boolean; reset: boolean } {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes("--dry-run"),
    reset: args.includes("--reset"),
  };
}

function validateEnv(): { shop: string; token: string; databaseUrl: string | null } | null {
  const shop = process.env.SHOP;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  const databaseUrl = process.env.DATABASE_URL ?? null;

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

  // Security: never log the token value
  return { shop, token, databaseUrl };
}

export async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Net Terms Receivables - Dev Store Seed Script");
  console.log("  (Using orderCreate with processedAt - no draft orders)");
  console.log("═══════════════════════════════════════════════════════════════");

  const { dryRun, reset } = parseArgs();
  const env = validateEnv();

  if (!env) {
    process.exit(1);
  }

  const state: SeedState = {
    shop: env.shop,
    token: env.token,
    databaseUrl: env.databaseUrl,
    dryRun,
    reset,
    currencyCode: "",
    companies: new Map(),
    paymentTermsTemplates: [],
    createdCount: { companies: 0, locations: 0, orders: 0, roleAssignments: 0, dbRules: 0, dbAccounts: 0 },
    skippedCount: { companies: 0, orders: 0, roleAssignments: 0 },
    deletedCount: { companies: 0, orders: 0 },
    failedCount: { locations: 0, orders: 0, roleAssignments: 0 },
    ordersWithShopifyTerms: 0,
    ordersWithoutShopifyTerms: 0,
    overdueOrdersCount: 0,
    taggedCustomerOrdersCount: 0,
    errors: [],
  };

  console.log(`\nShop: ${state.shop}`);
  console.log(`Mode: ${dryRun ? "DRY RUN (read-only lookups, no mutations)" : reset ? "RESET + SEED" : "SEED"}`);
  console.log(`Database: ${env.databaseUrl ? "Connected" : "Not configured (will print SQL)"}`);

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

  // Seed Shopify data
  await seedCompanies(state);
  await seedOrders(state);
  
  // Seed orders for tagged (non-B2B) customers
  await seedTaggedCustomerOrders(state);

  // Seed database for S9 inference
  await seedDatabase(state);

  // Summary - counts and booleans only, no PII (names, emails, phones, addresses)
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Summary (counts only, no PII)");
  console.log("═══════════════════════════════════════════════════════════════");

  if (dryRun) {
    console.log("\n  [DRY RUN - No mutations performed]");
    console.log(`\n  Would create ${state.overdueOrdersCount} overdue orders (daysAgo > termsDays)`);
    if (state.overdueOrdersCount === 0) {
      console.log(`  ⚠️  WARNING: No orders would have effective due date in past!`);
    }
  }

  // Per-company location counts with terms
  console.log("\n  Companies with Locations:");
  let companiesWithAllLocations = 0;
  for (const [companyKey, company] of state.companies) {
    const net15 = company.locations.has(15);
    const net30 = company.locations.has(30);
    const net60 = company.locations.has(60);
    const locationCount = company.locations.size;
    console.log(`    ${companyKey}: ${locationCount} locations (Net-15: ${net15}, Net-30: ${net30}, Net-60: ${net60})`);
    if (net15 && net30 && net60) companiesWithAllLocations++;
  }
  console.log(`  Total companies with all 3 locations: ${companiesWithAllLocations}/${state.companies.size}`);

  console.log("\n  Shopify Created:");
  console.log(`    Companies:        ${state.createdCount.companies}`);
  console.log(`    Locations:        ${state.createdCount.locations}`);
  console.log(`    Role assignments: ${state.createdCount.roleAssignments}`);
  console.log(`    Orders (total):   ${state.createdCount.orders}`);

  console.log("\n  Skipped (already exist):");
  console.log(`    Companies:        ${state.skippedCount.companies}`);
  console.log(`    Role assignments: ${state.skippedCount.roleAssignments}`);
  console.log(`    Orders:           ${state.skippedCount.orders}`);

  const totalFailures = state.failedCount.locations + state.failedCount.orders + state.failedCount.roleAssignments;
  if (totalFailures > 0) {
    console.log("\n  ❌ Failed:");
    console.log(`    Locations:        ${state.failedCount.locations}`);
    console.log(`    Role assignments: ${state.failedCount.roleAssignments}`);
    console.log(`    Orders:           ${state.failedCount.orders}`);
  }

  // Order breakdown
  const b2bOrdersCount = state.createdCount.orders - state.taggedCustomerOrdersCount;
  console.log("\n  Order Breakdown:");
  console.log(`    B2B orders:             ${b2bOrdersCount}`);
  console.log(`    Tagged customer orders: ${state.taggedCustomerOrdersCount}`);
  console.log(`    Orders with payment terms (from Shopify): ${state.ordersWithShopifyTerms}`);
  console.log(`    Orders without payment terms (use DB):    ${state.ordersWithoutShopifyTerms}`);
  console.log(`    Overdue orders:         ${state.overdueOrdersCount}`);
  console.log(`    Has overdue orders:     ${state.overdueOrdersCount > 0}`);
    
  if (state.overdueOrdersCount === 0 && !dryRun) {
    console.log(`\n  ⚠️  WARNING: No orders have effective due date in the past!`);
    console.log("     Expected at least some Net 15/30 orders with daysAgo > termsDays.");
  }

  // Database seeding
  if (state.databaseUrl && !dryRun) {
    console.log("\n  Database Seeded:");
    console.log(`    Tag rules:      ${state.createdCount.dbRules}`);
    console.log(`    BuyerAccounts:  ${state.createdCount.dbAccounts}`);
  } else if (!dryRun) {
    console.log("\n  Database Sync:");
    console.log("    n/a (no DB access)");
  }

  // Error summary (without PII)
  if (state.errors.length > 0) {
    console.log("\n  Errors:");
    console.log(`    Error count: ${state.errors.length}`);
    console.log(`    Has errors:  true`);
  }

  // Exit non-zero if any failures occurred
  if (totalFailures > 0 || state.errors.length > 0) {
    console.log(`\n❌ Seed completed with ${totalFailures} failure(s) and ${state.errors.length} error(s)`);
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
