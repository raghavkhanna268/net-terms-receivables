#!/usr/bin/env tsx
/**
 * Seed script for Net Terms Receivables dev store.
 *
 * Creates B2B companies and orders with payment terms for testing the app's
 * receivables tracking features. Also seeds the database with tag rules and
 * buyer account defaults so S9 inference can compute due dates.
 *
 * SCOPE REQUIREMENTS:
 * This script runs with the 8 PRODUCTION scopes only - no separate dev app needed.
 * Uses only the dev-store token (SHOPIFY_ADMIN_TOKEN env var).
 *   - write_companies  - Create companies, set payment terms on locations (implies read_companies)
 *   - write_customers  - Create test customers (implies read_customers)
 *   - write_orders     - Create orders via orderCreate (implies read_orders)
 *   - read_payment_terms - Read payment terms templates
 *   - read_draft_orders  - Draft order payment terms
 *   - write_validations, write_payment_customizations, write_merchant_managed_fulfillment_orders
 *     (pre-granted for S12/S13, not used by seed)
 * Per https://shopify.dev/docs/api/usage/access-scopes: write_* scopes imply read_* access.
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
 *   SHOP                 - Shop domain (SHOP must equal ALLOWED_DEV_STORE)
 *   ALLOWED_DEV_STORE    - Dev-store domain the seed may run against (required; fails closed if unset)
 *   SHOPIFY_ADMIN_TOKEN  - Admin API access token with production scopes
 *   DATABASE_URL         - Direct Postgres connection for DB seeding (optional)
 *
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/orderCreate
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/OrderCreateOrderInput
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/companyLocationUpdate
 */

import { pathToFileURL } from "node:url";
import postgres from "postgres";
import {
  getSeedDbCounts,
  getSeedDbSummary,
  createSeedDbWriteTracker,
} from "./lib/seed-summary";
import {
  HELD_FIXTURE_ID_PREFIX,
  HELD_FIXTURE_MAX,
  HELD_FIXTURE_METAFIELDS_QUERY,
  HELD_FIXTURE_METAFIELDS_SET_MUTATION,
  reseedHeldFixtureCurrency,
  type HeldFixtureRow,
  type OwnerMetafield,
} from "./lib/held-fixture-currency";

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

/**
 * Reserved email domain for fixture customers (RFC 2606).
 * Using example.com instead of .example TLD which Shopify rejects as invalid.
 */
export const SEED_EMAIL_DOMAIN = "example.com";

/**
 * Generate a fixture customer email in the format ntr-seed-<key>@example.com.
 * All fixture customer emails must be generated through this helper to ensure
 * consistency and use of the reserved domain.
 */
export function seedEmail(key: string): string {
  return `${SEED_PREFIX}${key}@${SEED_EMAIL_DOMAIN}`;
}

/**
 * Legacy email patterns that need migration to the new format.
 * Maps from seed key to the old email that may exist on Shopify.
 */
export const LEGACY_SEED_EMAILS: Record<string, string> = {
  "company-1": "raj.sharma@acme-wholesale.example",
  "company-2": "priya@bharat-traders.example",
  "company-3": "amit.singh@delhi-dist.example",
  "company-4": "sneha@mumbai-merchants.example",
  "company-5": "arjun.das@kolkata-commerce.example",
  "company-reviewer-demo": "demo.reviewer@test-buyer.example",
};
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

// Order creation pacing to avoid dev store throttling (configurable via env)
// Default 12s is safe for dev stores; Shopify returns "Too many attempts" on fast orderCreate
export const DEFAULT_SEED_ORDER_DELAY_MS = 12000;
export const SEED_ORDER_DELAY_MS = parseInt(process.env.SEED_ORDER_DELAY_MS ?? String(DEFAULT_SEED_ORDER_DELAY_MS), 10);

// Retry configuration for orderCreate throttle errors
export const ORDER_CREATE_MAX_ATTEMPTS = 5;
export const ORDER_CREATE_BACKOFF_DELAYS_MS = [15000, 30000, 60000, 120000]; // After first failure: 15s, 30s, 60s, 120s

// Security: the allowed dev-store domain comes from the ALLOWED_DEV_STORE env var
// (a GitHub Actions secret in CI; never committed, #190 F1). Seed refuses to run
// on any other shop, and refuses to run at all if ALLOWED_DEV_STORE is unset or
// malformed (fail closed). This prevents accidental mutation of production data
// if someone misconfigures SHOP.
const DEV_STORE_DOMAIN_RE = /^[a-z0-9-]+\.myshopify\.com$/;

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
  { key: "company-1", name: "Acme Wholesale Pvt Ltd", city: "Mumbai", contact: { firstName: "Raj", lastName: "Sharma", email: seedEmail("company-1") } },
  { key: "company-2", name: "Bharat Traders Co", city: "Ahmedabad", contact: { firstName: "Priya", lastName: "Patel", email: seedEmail("company-2") } },
  { key: "company-3", name: "Delhi Distributors LLP", city: "Delhi", contact: { firstName: "Amit", lastName: "Singh", email: seedEmail("company-3") } },
  { key: "company-4", name: "Mumbai Merchants Pvt Ltd", city: "Pune", contact: { firstName: "Sneha", lastName: "Desai", email: seedEmail("company-4") } },
  { key: "company-5", name: "Kolkata Commerce House", city: "Kolkata", contact: { firstName: "Arjun", lastName: "Das", email: seedEmail("company-5") } },
] as const;

/**
 * Reviewer demo company seed data.
 *
 * FOR THE THROWAWAY INR DEMO STORE ONLY - never the main dev store.
 *
 * This company "Test Buyer Co" matches the payer text in the synthetic
 * reviewer CSV (tests/fixtures/banks/synthetic/hdfc-review-synthetic.csv).
 * The orders created have specific amounts that match the CSV payment amounts
 * for testing the matching flow.
 *
 * This is NOT included in COMPANY_SEEDS to avoid modifying the existing
 * 5-company test data. It's seeded separately via seedReviewerDemoCompany().
 *
 * All data is FICTIONAL - no real company names, domains, or identifiers.
 */
export const REVIEWER_DEMO_COMPANY_SEED = {
  key: "company-reviewer-demo",
  name: "Test Buyer Co",
  city: "Bengaluru",
  contact: {
    firstName: "Demo",
    lastName: "Reviewer",
    email: seedEmail("company-reviewer-demo"),
  },
} as const;

/**
 * Reviewer demo order seeds.
 *
 * FOR THE THROWAWAY INR DEMO STORE ONLY - never the main dev store.
 * Enabled via --reviewer-demo flag or SEED_REVIEWER_DEMO=1 env var.
 *
 * These orders have specific amounts matching the synthetic reviewer CSV:
 * - Order #1001: ₹10,000 - exact match for CSV row 1 (NEFT, ₹10,000)
 * - Order #1002: ₹5,000 - exact match for CSV row 2, partial for row 3
 *
 * Order names are set explicitly via OrderCreateOrderInput.name:
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/OrderCreateOrderInput
 * "name: The name of the order. Can also be set by the API to be any string value."
 */
export const REVIEWER_DEMO_ORDERS = [
  {
    orderKey: "reviewer-demo-1001",
    orderName: "#1001",
    amountInr: 10000,
    productTitle: "Reviewer Demo Product A",
    daysAgo: 5,
    locationTermsDays: 30,
  },
  {
    orderKey: "reviewer-demo-1002",
    orderName: "#1002",
    amountInr: 5000,
    productTitle: "Reviewer Demo Product B",
    daysAgo: 5,
    locationTermsDays: 30,
  },
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
  resetApply: boolean;
  reportDuplicates: boolean;
  reviewerDemo: boolean;
  currencyCode: string;
  companies: Map<string, CompanyData>;
  paymentTermsTemplates: PaymentTermsTemplate[];
  createdCount: { companies: number; locations: number; orders: number; roleAssignments: number; dbRules: number; dbAccounts: number; customers: number };
  unchangedCount: { companies: number; locations: number; orders: number; roleAssignments: number; customers: number };
  updatedCount: { customers: number };
  adoptedCount: { companies: number };
  driftedCount: { companies: number };
  skippedCount: { companies: number; orders: number; roleAssignments: number };
  skippedReasons: string[];
  deletedCount: { companies: number; orders: number };
  failedCount: { companies: number; locations: number; orders: number; roleAssignments: number; dbRows: number; customers: number };
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
    console.error(`  ❌ GraphQL errors${mutationName ? ` in ${mutationName}` : ""}: ${response.errors.length} error(s)`);
    for (const err of response.errors) {
      const pathStr = err.path?.join(".") ?? "";
      const code = err.extensions?.code ?? "UNKNOWN";
      console.error(`     - [${code}]${pathStr ? ` (path: ${pathStr})` : ""}`);
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
    console.error(`  ❌ User errors${context ? ` in ${context}` : ""}: ${userErrors.length} error(s)`);
    for (const err of userErrors) {
      const fieldStr = err.field?.join(".") ?? "";
      const code = err.code ?? "UNKNOWN";
      console.error(`     - [${code}]${fieldStr ? ` (field: ${fieldStr})` : ""}`);
    }
  }
}

/**
 * Result of a mutation operation with consistent failure detection.
 */
export interface MutationResult<T> {
  ok: boolean;
  data: T | null;
  failureReason: "graphql_errors" | "user_errors" | "null_result" | null;
}

/**
 * Check a mutation response for failure conditions.
 * A mutation is considered FAILED when:
 * - The response has top-level GraphQL errors
 * - The response has non-empty userErrors
 * - The result object is null or missing
 *
 * @param response - The GraphQL response
 * @param userErrors - The userErrors array from the mutation payload
 * @param result - The result object (e.g., customer, order) from the mutation payload
 * @returns MutationResult with ok=true if successful, ok=false with failureReason otherwise
 */
export function checkMutationResult<T>(
  response: GraphQLResponse<unknown>,
  userErrors: UserError[] | undefined,
  result: T | null | undefined
): MutationResult<T> {
  if (response.errors && response.errors.length > 0) {
    return { ok: false, data: null, failureReason: "graphql_errors" };
  }
  if (userErrors && userErrors.length > 0) {
    return { ok: false, data: null, failureReason: "user_errors" };
  }
  if (result === null || result === undefined) {
    return { ok: false, data: null, failureReason: "null_result" };
  }
  return { ok: true, data: result, failureReason: null };
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
    console.error(`  ❌ Failed to get shop info: ${result.errors.length} GraphQL error(s)`);
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
        console.error("     B2B requires Shopify Plus or a dev store with B2B enabled.");
        return false;
      }
      console.error(`  ❌ GraphQL errors: ${result.errors.length} error(s)`);
      return false;
    }

    console.log("  ✅ B2B is available");
    return true;
  } catch (error) {
    const errType = error instanceof Error ? error.constructor.name : typeof error;
    console.error(`  ❌ Failed to check B2B support: [${errType}]`);
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
    console.error(`  ❌ Failed to fetch payment terms templates: ${result.errors.length} GraphQL error(s)`);
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

/**
 * Query to find seeded orders by tag.
 */
export const FIND_SEEDED_ORDERS_QUERY = `
  query FindSeededOrders($query: String!) {
    orders(first: 50, query: $query) {
      nodes { id name tags }
    }
  }
`;

/**
 * Query to find seeded companies by externalId prefix with locations.
 */
export const FIND_SEEDED_COMPANIES_BY_EXTERNAL_ID_QUERY = `
  query FindSeededCompaniesByExternalId($query: String!) {
    companies(first: 50, query: $query) {
      nodes {
        id
        externalId
        locations(first: 10) {
          edges {
            node {
              id
              name
              buyerExperienceConfiguration {
                paymentTermsTemplate { dueInDays }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Query to find companies by name (for reset - finds companies without externalId).
 */
export const FIND_COMPANIES_BY_NAME_FOR_RESET_QUERY = `
  query FindCompaniesByNameForReset($query: String!) {
    companies(first: 10, query: $query) {
      nodes {
        id
        externalId
        locations(first: 10) {
          edges {
            node {
              id
              name
              buyerExperienceConfiguration {
                paymentTermsTemplate { dueInDays }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Query to find seeded customers by tag.
 */
export const FIND_SEEDED_CUSTOMERS_QUERY = `
  query FindSeededCustomers($query: String!) {
    customers(first: 50, query: $query) {
      nodes { id tags }
    }
  }
`;

/**
 * Mutation to delete a company.
 */
export const COMPANY_DELETE_MUTATION = `
  mutation DeleteCompany($id: ID!) {
    companyDelete(id: $id) {
      deletedCompanyId
      userErrors { field message code }
    }
  }
`;

/**
 * Result of reset discovery phase.
 */
interface ResetDiscovery {
  // Seed-marked records (safe to delete)
  markedCompanies: Array<{ id: string; externalId: string | null }>;
  markedLocations: Array<{ id: string; companyId: string; dueInDays: number | null }>;
  markedOrders: Array<{ id: string }>;
  markedCustomers: Array<{ id: string }>;
  markedDbAccounts: Array<{ id: string; companyLocationId: string | null; termsDays: number | null }>;
  
  // Suspect records (match by name/email but no marker - NOT deleted)
  suspectCompanies: Array<{ id: string }>;
  
  // Counts by terms bucket
  locationsByTerms: { net15: number; net30: number; net60: number; other: number };
  dbAccountsByTerms: { net15: number; net30: number; net60: number; other: number };
}

interface ResetStats {
  companiesDeleted: number;
  companiesSkipped: number;
  companiesStillPresent: number;
  ordersSkipped: number;
  customersSkipped: number;
  dbAccountsDeleted: number;
  dbAccountsFailed: number;
  skipReasons: string[];
  deletedCompanyIds: Set<string>;
}

/**
 * Reset seed data. By default (dry-run), discovers and lists leftover records.
 * With --apply flag (and not --dry-run), actually deletes seed-marked records and verifies.
 * 
 * Only deletes records with seed markers (externalId prefix ntr-seed- or tag ntr-seed).
 * Records matching by name without markers are listed as 'suspect'.
 * 
 * @returns true if reset completed successfully (or was dry-run), false if verification failed
 */
export async function resetSeedData(state: SeedState): Promise<boolean> {
  console.log("\n🗑️  Reset: Discovering seed data...");
  
  const discovery = await discoverSeedRecords(state);
  
  // Print discovery results (IDs only, no PII)
  printDiscoveryResults(discovery);
  
  // If not applying OR dry-run mode, stop here (dry-run takes precedence)
  if (!state.resetApply || state.dryRun) {
    const reason = state.dryRun ? "--dry-run prevents mutations" : "use --reset --apply to delete";
    console.log(`\n  [dry-run] No mutations performed. ${reason}`);
    return true;
  }
  
  console.log("\n  Applying deletions...");
  
  const stats: ResetStats = {
    companiesDeleted: 0,
    companiesSkipped: 0,
    companiesStillPresent: 0,
    ordersSkipped: discovery.markedOrders.length,
    customersSkipped: discovery.markedCustomers.length,
    dbAccountsDeleted: 0,
    dbAccountsFailed: 0,
    skipReasons: [],
    deletedCompanyIds: new Set<string>(),
  };
  
  // Delete seed-marked companies only
  await deleteMarkedCompanies(state, discovery.markedCompanies, stats);
  
  // Delete DB BuyerAccount rows ONLY for companies that were actually deleted
  // and scope to this shop's shopId
  if (state.databaseUrl) {
    const deletedLocationIds = discovery.markedLocations
      .filter(loc => stats.deletedCompanyIds.has(loc.companyId))
      .map(loc => loc.id);
    
    if (deletedLocationIds.length > 0) {
      await deleteMarkedDbAccounts(state, deletedLocationIds, stats);
    }
  }
  
  // Update state counts
  state.deletedCount.companies = stats.companiesDeleted;
  state.deletedCount.orders = stats.ordersSkipped;
  state.skippedCount.companies += stats.companiesSkipped;
  state.skippedReasons.push(...stats.skipReasons);
  state.failedCount.dbRows += stats.dbAccountsFailed;
  
  // Verify no seed-marked records remain (only count what we actually delete: companies and DB rows)
  console.log("\n  Verifying no seed-marked records remain...");
  const postVerify = await discoverSeedRecords(state);
  const remainingMarked = postVerify.markedCompanies.length + postVerify.markedDbAccounts.length;
  
  console.log("\n  Reset summary:");
  console.log(`    Companies deleted:       ${stats.companiesDeleted}`);
  console.log(`    Companies skipped:       ${stats.companiesSkipped}`);
  console.log(`    Orders skipped:          ${stats.ordersSkipped} (cannot delete via API)`);
  console.log(`    Customers skipped:       ${stats.customersSkipped} (just tagged, not deleted)`);
  console.log(`    DB accounts deleted:     ${stats.dbAccountsDeleted}`);
  if (stats.dbAccountsFailed > 0) {
    console.log(`    DB accounts failed:      ${stats.dbAccountsFailed}`);
  }
  console.log(`    Suspect (not deleted):   ${discovery.suspectCompanies.length}`);
  
  if (stats.skipReasons.length > 0) {
    console.log("\n  Skip reasons:");
    for (const reason of stats.skipReasons) {
      console.log(`    - ${reason}`);
    }
  }
  
  // Check for failures: remaining marked records OR DB delete failures
  const hasFailures = remainingMarked > 0 || stats.dbAccountsFailed > 0;
  
  if (remainingMarked > 0) {
    console.log(`\n  ❌ Verification failed: ${remainingMarked} seed-marked records still present`);
    state.failedCount.companies += postVerify.markedCompanies.length;
  }
  
  if (hasFailures) {
    return false;
  }
  
  console.log("\n  ✅ Verification passed: No seed-marked records remain");
  return true;
}

/**
 * Discover all seed records in Shopify and DB.
 */
async function discoverSeedRecords(state: SeedState): Promise<ResetDiscovery> {
  const discovery: ResetDiscovery = {
    markedCompanies: [],
    markedLocations: [],
    markedOrders: [],
    markedCustomers: [],
    markedDbAccounts: [],
    suspectCompanies: [],
    locationsByTerms: { net15: 0, net30: 0, net60: 0, other: 0 },
    dbAccountsByTerms: { net15: 0, net30: 0, net60: 0, other: 0 },
  };
  
  // 1. Find seed-marked companies by externalId prefix
  const byExternalId = await graphql<{
    companies: {
      nodes: Array<{
        id: string;
        externalId: string | null;
        locations: { edges: Array<{ node: { id: string; name: string; buyerExperienceConfiguration?: { paymentTermsTemplate?: { dueInDays: number | null } } } }> };
      }>;
    };
  }>(state, FIND_SEEDED_COMPANIES_BY_EXTERNAL_ID_QUERY, { query: `external_id:${SEED_PREFIX}*` });
  
  for (const company of byExternalId.data?.companies.nodes ?? []) {
    if (company.externalId?.startsWith(SEED_PREFIX)) {
      discovery.markedCompanies.push({ id: company.id, externalId: company.externalId });
      
      // Count locations by terms
      for (const edge of company.locations.edges) {
        const loc = edge.node;
        const dueInDays = loc.buyerExperienceConfiguration?.paymentTermsTemplate?.dueInDays ?? null;
        discovery.markedLocations.push({ id: loc.id, companyId: company.id, dueInDays });
        
        if (dueInDays === 15) discovery.locationsByTerms.net15++;
        else if (dueInDays === 30) discovery.locationsByTerms.net30++;
        else if (dueInDays === 60) discovery.locationsByTerms.net60++;
        else discovery.locationsByTerms.other++;
      }
    }
  }
  
  // 2. Find suspect companies (match by name but no externalId marker)
  const markedIds = new Set(discovery.markedCompanies.map(c => c.id));
  for (const seed of COMPANY_SEEDS) {
    const byName = await graphql<{
      companies: {
        nodes: Array<{
          id: string;
          externalId: string | null;
          locations: { edges: Array<{ node: { id: string; name: string; buyerExperienceConfiguration?: { paymentTermsTemplate?: { dueInDays: number | null } } } }> };
        }>;
      };
    }>(state, FIND_COMPANIES_BY_NAME_FOR_RESET_QUERY, { query: `name:'${seed.name}'` });
    
    for (const company of byName.data?.companies.nodes ?? []) {
      if (!markedIds.has(company.id)) {
        // No externalId marker - this is a suspect
        if (!company.externalId?.startsWith(SEED_PREFIX)) {
          discovery.suspectCompanies.push({ id: company.id });
        }
      }
    }
  }
  
  // 3. Find seed-marked orders by tag
  const orderResult = await graphql<{ orders: { nodes: Array<{ id: string; tags: string[] }> } }>(
    state,
    FIND_SEEDED_ORDERS_QUERY,
    { query: `tag:'${SEED_TAG}'` }
  );
  for (const order of orderResult.data?.orders.nodes ?? []) {
    if (order.tags.includes(SEED_TAG)) {
      discovery.markedOrders.push({ id: order.id });
    }
  }
  
  // 4. Find seed-marked customers by tag
  const customerResult = await graphql<{ customers: { nodes: Array<{ id: string; tags: string[] }> } }>(
    state,
    FIND_SEEDED_CUSTOMERS_QUERY,
    { query: `tag:'${SEED_TAG}'` }
  );
  for (const customer of customerResult.data?.customers.nodes ?? []) {
    if (customer.tags.includes(SEED_TAG)) {
      discovery.markedCustomers.push({ id: customer.id });
    }
  }
  
  // 5. Find seed-marked DB BuyerAccount rows (by companyLocationId matching seed locations)
  if (state.databaseUrl) {
    const sql = (await import("postgres")).default;
    const db = sql(state.databaseUrl);
    try {
      // Get all BuyerAccounts for seed company locations
      const locationIds = discovery.markedLocations.map(l => l.id);
      if (locationIds.length > 0) {
        const accounts = await db<Array<{ id: string; companyLocationId: string | null; defaultTermsDays: number | null }>>`
          SELECT id, "companyLocationId", "defaultTermsDays"
          FROM "BuyerAccount"
          WHERE "companyLocationId" = ANY(${locationIds})
        `;
        for (const account of accounts) {
          discovery.markedDbAccounts.push({
            id: account.id,
            companyLocationId: account.companyLocationId,
            termsDays: account.defaultTermsDays,
          });
          
          if (account.defaultTermsDays === 15) discovery.dbAccountsByTerms.net15++;
          else if (account.defaultTermsDays === 30) discovery.dbAccountsByTerms.net30++;
          else if (account.defaultTermsDays === 60) discovery.dbAccountsByTerms.net60++;
          else discovery.dbAccountsByTerms.other++;
        }
      }
    } finally {
      await db.end();
    }
  }
  
  return discovery;
}

/**
 * Print discovery results (IDs only, no PII).
 */
function printDiscoveryResults(discovery: ResetDiscovery): void {
  const expectedPerBucket = COMPANY_SEEDS.length; // 5
  
  console.log("\n  Seed-marked records found:");
  console.log(`    Companies:  ${discovery.markedCompanies.length}`);
  for (const c of discovery.markedCompanies) {
    console.log(`      - ${c.id} [${c.externalId}]`);
  }
  
  console.log(`\n    Locations by terms (expected ${expectedPerBucket}/${expectedPerBucket}/${expectedPerBucket}):`);
  console.log(`      Net-15: ${discovery.locationsByTerms.net15}`);
  console.log(`      Net-30: ${discovery.locationsByTerms.net30}`);
  console.log(`      Net-60: ${discovery.locationsByTerms.net60}`);
  if (discovery.locationsByTerms.other > 0) {
    console.log(`      Other:  ${discovery.locationsByTerms.other}`);
  }
  
  console.log(`\n    Orders (tagged): ${discovery.markedOrders.length}`);
  for (const o of discovery.markedOrders) {
    console.log(`      - ${o.id}`);
  }
  
  console.log(`\n    Customers (tagged): ${discovery.markedCustomers.length}`);
  for (const c of discovery.markedCustomers) {
    console.log(`      - ${c.id}`);
  }
  
  if (discovery.markedDbAccounts.length > 0) {
    console.log(`\n    DB BuyerAccounts by terms (expected ${expectedPerBucket}/${expectedPerBucket}/${expectedPerBucket}):`);
    console.log(`      Net-15: ${discovery.dbAccountsByTerms.net15}`);
    console.log(`      Net-30: ${discovery.dbAccountsByTerms.net30}`);
    console.log(`      Net-60: ${discovery.dbAccountsByTerms.net60}`);
    if (discovery.dbAccountsByTerms.other > 0) {
      console.log(`      Other:  ${discovery.dbAccountsByTerms.other}`);
    }
    for (const a of discovery.markedDbAccounts) {
      console.log(`      - ${a.id} [loc: ${a.companyLocationId}, terms: ${a.termsDays}]`);
    }
  }
  
  if (discovery.suspectCompanies.length > 0) {
    console.log(`\n  ⚠️  Suspect companies (name match, no marker - NOT deleted): ${discovery.suspectCompanies.length}`);
    for (const c of discovery.suspectCompanies) {
      console.log(`      - ${c.id}`);
    }
  }
}

/**
 * Delete seed-marked companies only.
 * Tracks which companies were actually deleted for downstream DB cleanup.
 */
async function deleteMarkedCompanies(
  state: SeedState,
  companies: Array<{ id: string; externalId: string | null }>,
  stats: ResetStats
): Promise<void> {
  console.log(`  Deleting ${companies.length} seed-marked companies...`);
  
  for (const company of companies) {
    const deleteResult = await graphql<{
      companyDelete: { deletedCompanyId: string | null; userErrors: UserError[] };
    }>(state, COMPANY_DELETE_MUTATION, { id: company.id }, { isMutation: true });
    
    const userErrors = deleteResult.data?.companyDelete.userErrors ?? [];
    const deletedId = deleteResult.data?.companyDelete.deletedCompanyId;
    
    if (userErrors.length > 0) {
      const error = userErrors[0];
      const code = error.code ?? "UNKNOWN";
      const reason = `${company.id}: [${code}]`;
      stats.skipReasons.push(reason);
      stats.companiesSkipped++;
      console.log(`    ⚠️  Skipped ${company.id}: [${code}]`);
    } else if (deletedId) {
      stats.companiesDeleted++;
      stats.deletedCompanyIds.add(company.id);
      console.log(`    ✓ Deleted ${company.id}`);
    } else {
      const reason = `${company.id}: No deletedCompanyId returned and no userErrors`;
      stats.skipReasons.push(reason);
      stats.companiesSkipped++;
      console.log(`    ⚠️  Skipped ${company.id}: No deletedCompanyId returned`);
    }
  }
}

/**
 * Delete DB BuyerAccount rows for the given location IDs.
 * Only deletes rows for locations that belong to companies that were actually deleted.
 * Scoped to the current shop's shopId for safety.
 */
async function deleteMarkedDbAccounts(
  state: SeedState,
  locationIds: string[],
  stats: ResetStats
): Promise<void> {
  if (!state.databaseUrl || locationIds.length === 0) return;
  
  console.log(`  Deleting DB BuyerAccount rows for ${locationIds.length} locations...`);
  
  const sql = (await import("postgres")).default;
  const db = sql(state.databaseUrl);
  try {
    // First get shopId for this shop domain
    const [shop] = await db<Array<{ id: string }>>`
      SELECT id FROM "Shop" WHERE domain = ${state.shop} LIMIT 1
    `;
    
    if (!shop) {
      console.log(`    ⚠️  Shop row not found`);
      stats.skipReasons.push(`Shop row not found`);
      stats.dbAccountsFailed++;
      return;
    }
    
    // Delete BuyerAccount rows scoped to this shop and the given location IDs
    const result = await db`
      DELETE FROM "BuyerAccount"
      WHERE "shopId" = ${shop.id}
        AND "companyLocationId" = ANY(${locationIds})
    `;
    stats.dbAccountsDeleted = result.count;
    console.log(`    ✓ Deleted ${result.count} BuyerAccount rows`);
  } catch (err) {
    const errType = err instanceof Error ? err.constructor.name : "UnknownError";
    stats.skipReasons.push(`DB delete failed: [${errType}]`);
    stats.dbAccountsFailed++;
    console.log(`    ⚠️  DB delete failed: [${errType}]`);
  } finally {
    await db.end();
  }
}

// -- Seeding: Companies --

export async function seedCompanies(state: SeedState): Promise<void> {
  console.log("\n🏢 Seeding B2B companies with multiple locations...");

  for (const seed of COMPANY_SEEDS) {
    const externalId = `${SEED_PREFIX}${seed.key}`;
    let existing = await findCompanyByExternalId(state, externalId);
    let wasAdopted = false;

    // If no externalId match, try adoption via contact email or name
    // Also try legacy email for migration from .example to @example.com
    if (!existing && !state.dryRun) {
      const legacyEmail = LEGACY_SEED_EMAILS[seed.key];
      const adoptionResult = await findCompanyForAdoption(state, seed, legacyEmail);
      
      if (adoptionResult && "ambiguous" in adoptionResult) {
        // Multiple candidates - skip and log
        const reason = `Ambiguous match for ${externalId}: ${adoptionResult.candidates.length} candidates`;
        console.log(`  ⚠️  Skipped ${externalId}: ${reason}`);
        console.log(`      Candidates: ${adoptionResult.candidates.map(c => c.id).join(", ")}`);
        state.skippedCount.companies++;
        state.skippedReasons.push(reason);
        continue;
      }
      
      if (adoptionResult && "company" in adoptionResult) {
        const candidate = adoptionResult.company;
        
        // P1: Check if candidate has a conflicting externalId (non-null and different from target)
        if (candidate.externalId !== null && candidate.externalId !== externalId) {
          const reason = `${candidate.id} already has externalId '${candidate.externalId}', cannot adopt as '${externalId}'`;
          console.log(`  ⚠️  Skipped ${externalId}: ${reason}`);
          state.skippedCount.companies++;
          state.skippedReasons.push(reason);
          continue;
        }
        
        // Single match - adopt it by setting externalId
        if (state.dryRun) {
          // P3a: Dry-run preview of adoption
          console.log(`  [dry-run] Would adopt ${candidate.id} as ${externalId} (matched by ${adoptionResult.matchType})`);
          // For dry-run, we can't continue with this company since we don't have real data
          continue;
        }
        
        console.log(`  📎 Found existing company ${candidate.id} for ${externalId} (matched by ${adoptionResult.matchType})`);
        console.log(`     Adopting by setting externalId...`);
        
        const adopted = await adoptCompany(state, candidate.id, externalId);
        if (adopted) {
          existing = adopted;
          wasAdopted = true;
          state.adoptedCount.companies++;
          console.log(`  ✅ Adopted: ${externalId}`);
        } else {
          state.errors.push(`Failed to adopt ${candidate.id} as ${externalId}`);
        }
      }
    }

    if (existing) {
      // Fetch contact roles for role assignment
      const contactRoles = await fetchCompanyContactRoles(state, existing.id);
      const contactId = existing.contacts.edges[0]?.node.id ?? "";
      const existingEmail = existing.contacts.edges[0]?.node.customer.email ?? "";
      
      // Compare fixture fields with existing values
      const nameMatches = existing.name === seed.name;
      const emailMatches = existingEmail.toLowerCase() === seed.contact.email.toLowerCase();
      const fixtureMatches = nameMatches && emailMatches;
      
      if (wasAdopted) {
        // Already logged as adopted
      } else if (fixtureMatches) {
        console.log(`  ✓ ${externalId} unchanged`);
        state.unchangedCount.companies++;
      } else {
        console.log(`  ⚠️  ${externalId} drifted from fixture`);
        if (!nameMatches) console.log(`      Name differs`);
        if (!emailMatches) console.log(`      Email differs`);
        state.driftedCount.companies++;
      }
      
      // Build locations map from existing data
      const locations = new Map<number, string>();
      let existingLocationCount = 0;
      for (const edge of existing.locations.edges) {
        for (const loc of LOCATION_TERMS) {
          if (edge.node.name.includes(loc.suffix)) {
            locations.set(loc.dueInDays, edge.node.id);
            existingLocationCount++;
          }
        }
      }
      
      // Count existing locations as unchanged
      state.unchangedCount.locations += existingLocationCount;
      
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
              state.errors.push(`Failed to create location ${loc.suffix} for ${externalId}`);
            }
          }
        }
      }
      
      state.companies.set(seed.key, companyData);
      continue;
    }

    if (state.dryRun) {
      console.log(`  [dry-run] Would create: ${externalId} with 3 locations`);
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
      console.log(`  ✅ Created: ${externalId} with ${result.locations.size} locations`);
    } else {
      state.errors.push(`Failed to create company: ${externalId}`);
    }
  }
}

/**
 * Find a company by exact externalId match.
 * 
 * IMPORTANT: Shopify's `companies(query: "external_id:...")` uses fuzzy, tokenised search.
 * A search for "ntr-seed-company-1" can return "ntr-seed-company-10" or other partial matches.
 * We paginate up to MAX_SEARCH_PAGES and filter client-side for exact match.
 * 
 * @returns The company with exact externalId match, or null if not found
 */
interface CompaniesSearchResult {
  companies: {
    nodes: CompanyNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export async function findCompanyByExternalId(
  state: SeedState,
  externalId: string
): Promise<CompanyNode | null> {
  let cursor: string | undefined = undefined;
  
  for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
    const variables: { query: string; after?: string } = { query: `external_id:'${externalId}'` };
    if (cursor) variables.after = cursor;
    
    const response: GraphQLResponse<CompaniesSearchResult> = await graphql<CompaniesSearchResult>(
      state,
      FIND_COMPANY_BY_EXTERNAL_ID_QUERY,
      variables
    );

    const companies = response.data?.companies.nodes ?? [];
    
    // Strict match: return if externalId matches exactly
    const exactMatch = companies.find((c: CompanyNode) => c.externalId === externalId);
    if (exactMatch) {
      return exactMatch;
    }
    
    const hasNextPage = response.data?.companies.pageInfo?.hasNextPage ?? false;
    if (!hasNextPage) {
      return null;
    }
    cursor = response.data?.companies.pageInfo?.endCursor ?? undefined;
  }
  
  console.log(`  ⚠️  Search for company with externalId "${externalId}" exceeded ${MAX_SEARCH_PAGES} pages`);
  return null;
}

/**
 * Minimal company info for adoption/duplicate detection.
 */
export interface CompanyCandidate {
  id: string;
  name: string;
  externalId: string | null;
  contactEmail: string | null;
  /** All contact emails for this company (used for name-based matching) */
  _allContactEmails?: string[];
}

/**
 * Find all companies whose main contact's customer email matches the given email.
 * Used for adoption fallback when no externalId match is found.
 * 
 * NOTE: Shopify doesn't have a direct "companies by contact email" search.
 * We search customers by email, then look up their company associations.
 * This is a multi-step process using available scopes.
 * 
 * @returns Array of matching companies (may be empty)
 */
export async function findCompaniesByContactEmail(
  state: SeedState,
  contactEmail: string
): Promise<CompanyCandidate[]> {
  const candidates: CompanyCandidate[] = [];
  
  // Step 1: Find the customer by email
  let customerCursor: string | undefined = undefined;
  let customerId: string | null = null;
  
  for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
    const variables: { query: string; after?: string } = { query: `email:'${contactEmail}'` };
    if (customerCursor) variables.after = customerCursor;
    
    const response = await graphql<{
      customers: {
        nodes: Array<{ id: string; email: string | null }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>(state, FIND_CUSTOMER_BY_EMAIL_QUERY, variables);
    
    const customers = response.data?.customers.nodes ?? [];
    const exactMatch = customers.find(c => c.email?.toLowerCase() === contactEmail.toLowerCase());
    if (exactMatch) {
      customerId = exactMatch.id;
      break;
    }
    
    if (!response.data?.customers.pageInfo?.hasNextPage) break;
    customerCursor = response.data?.customers.pageInfo?.endCursor ?? undefined;
  }
  
  if (!customerId) {
    return candidates;
  }
  
  // Step 2: Find companies that have this customer as a contact
  // Search all companies and filter by contact email (no direct query available)
  let companyCursor: string | undefined = undefined;
  
  for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
    const variables: { after?: string } = {};
    if (companyCursor) variables.after = companyCursor;
    
    const response = await graphql<{
      companies: {
        nodes: Array<{
          id: string;
          name: string;
          externalId: string | null;
          contacts: { edges: Array<{ node: { customer: { id: string; email: string } } }> };
        }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>(state, FIND_COMPANIES_WITH_CONTACTS_QUERY, variables);
    
    const companies = response.data?.companies.nodes ?? [];
    for (const company of companies) {
      const hasMatchingContact = company.contacts.edges.some(
        e => e.node.customer.email?.toLowerCase() === contactEmail.toLowerCase()
      );
      if (hasMatchingContact) {
        candidates.push({
          id: company.id,
          name: company.name,
          externalId: company.externalId,
          contactEmail: contactEmail,
        });
      }
    }
    
    if (!response.data?.companies.pageInfo?.hasNextPage) break;
    companyCursor = response.data?.companies.pageInfo?.endCursor ?? undefined;
  }
  
  return candidates;
}

/**
 * Find all companies with the given exact name.
 * Used for adoption fallback (only if company has the seed's contact).
 * 
 * @returns Array of matching companies (may be empty)
 */
export async function findCompaniesByName(
  state: SeedState,
  name: string
): Promise<CompanyCandidate[]> {
  const candidates: CompanyCandidate[] = [];
  let cursor: string | undefined = undefined;
  
  for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
    const variables: { query: string; after?: string } = { query: `name:'${name}'` };
    if (cursor) variables.after = cursor;
    
    const response = await graphql<{
      companies: {
        nodes: Array<{
          id: string;
          name: string;
          externalId: string | null;
          contacts: { edges: Array<{ node: { customer: { email: string } } }> };
        }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>(state, FIND_COMPANIES_BY_NAME_QUERY, variables);
    
    const companies = response.data?.companies.nodes ?? [];
    for (const company of companies) {
      // Strict name match
      if (company.name === name) {
        // P3b: Collect ALL contact emails, not just contacts[0]
        const contactEmails = company.contacts.edges
          .map(e => e.node.customer.email)
          .filter((email): email is string => email != null);
        
        // Return the first contact email for backward compatibility, but store all for matching
        candidates.push({
          id: company.id,
          name: company.name,
          externalId: company.externalId,
          contactEmail: contactEmails[0] ?? null,
          // Store all emails for matching in findCompanyForAdoption
          _allContactEmails: contactEmails,
        });
      }
    }
    
    if (!response.data?.companies.pageInfo?.hasNextPage) break;
    cursor = response.data?.companies.pageInfo?.endCursor ?? undefined;
  }
  
  return candidates;
}

/**
 * Adopt an existing company by setting the seed externalId on it.
 * Returns the updated company data for seeding, or null on failure.
 */
export async function adoptCompany(
  state: SeedState,
  companyId: string,
  externalId: string
): Promise<CompanyNode | null> {
  const result = await graphql<{
    companyUpdate: {
      company: CompanyNode | null;
      userErrors: UserError[];
    };
  }>(state, COMPANY_UPDATE_MUTATION, {
    companyId: companyId,
    input: { externalId },
  }, { isMutation: true, mutationName: "companyUpdate" });
  
  if (result.errors) {
    console.error(`    ❌ Failed to adopt company: GraphQL errors`);
    return null;
  }
  
  if (result.data?.companyUpdate.userErrors.length) {
    logUserErrors(result.data.companyUpdate.userErrors, "adoptCompany");
    return null;
  }
  
  return result.data?.companyUpdate.company ?? null;
}

/**
 * Try to find an existing company for adoption using fallback matching:
 * 1. First by contact email (new format)
 * 2. Then by legacy contact email (if provided, for migration)
 * 3. Then by exact name (only if that company has the seed's contact)
 * 
 * Returns:
 * - { company, matchType } if exactly one match found
 * - { ambiguous: true, candidates } if multiple matches found (should skip)
 * - null if no match found
 */
export async function findCompanyForAdoption(
  state: SeedState,
  seed: { name: string; contact: { email: string } },
  legacyEmail?: string
): Promise<
  | { company: CompanyCandidate; matchType: "email" | "name" | "legacy_email" }
  | { ambiguous: true; candidates: CompanyCandidate[] }
  | null
> {
  // Try contact email first (new format)
  const emailMatches = await findCompaniesByContactEmail(state, seed.contact.email);
  
  if (emailMatches.length === 1) {
    return { company: emailMatches[0], matchType: "email" };
  }
  
  if (emailMatches.length > 1) {
    return { ambiguous: true, candidates: emailMatches };
  }
  
  // Try legacy email if provided (for migration from .example to @example.com)
  if (legacyEmail) {
    const legacyMatches = await findCompaniesByContactEmail(state, legacyEmail);
    
    if (legacyMatches.length === 1) {
      return { company: legacyMatches[0], matchType: "legacy_email" };
    }
    
    if (legacyMatches.length > 1) {
      return { ambiguous: true, candidates: legacyMatches };
    }
  }
  
  // Fall back to name match (only if company has the seed's contact or legacy email)
  const nameMatches = await findCompaniesByName(state, seed.name);
  
  // P3b: Filter to only companies that have the seed's contact email (check ALL contacts)
  // Also accept legacy email for migration
  const seedEmailLower = seed.contact.email.toLowerCase();
  const legacyEmailLower = legacyEmail?.toLowerCase();
  const nameMatchesWithContact = nameMatches.filter(c => {
    const emails = c._allContactEmails ?? (c.contactEmail ? [c.contactEmail] : []);
    return emails.some(email => {
      const emailLower = email.toLowerCase();
      return emailLower === seedEmailLower || (legacyEmailLower && emailLower === legacyEmailLower);
    });
  });
  
  if (nameMatchesWithContact.length === 1) {
    return { company: nameMatchesWithContact[0], matchType: "name" };
  }
  
  if (nameMatchesWithContact.length > 1) {
    return { ambiguous: true, candidates: nameMatchesWithContact };
  }
  
  return null;
}

/**
 * Result of customer email lookup.
 */
export type CustomerLookupResult = 
  | { customer: { id: string; email: string }; ambiguous?: false }
  | { ambiguous: true; customerIds: string[] }
  | null;

/**
 * Find all customers with the given exact email.
 * Used to detect if we can reuse an existing customer for company creation.
 * 
 * @returns CustomerLookupResult:
 *   - { customer } if exactly one match
 *   - { ambiguous: true, customerIds } if multiple matches
 *   - null if no match
 */
export async function findCustomersByEmail(
  state: SeedState,
  email: string
): Promise<CustomerLookupResult> {
  const matches: Array<{ id: string; email: string }> = [];
  let cursor: string | undefined = undefined;
  
  for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
    const variables: { query: string; after?: string } = { query: `email:'${email}'` };
    if (cursor) variables.after = cursor;
    
    const response = await graphql<{
      customers: {
        nodes: Array<{ id: string; email: string | null }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>(state, FIND_CUSTOMER_BY_EMAIL_QUERY, variables);
    
    const customers = response.data?.customers.nodes ?? [];
    for (const customer of customers) {
      if (customer.email?.toLowerCase() === email.toLowerCase()) {
        matches.push({ id: customer.id, email: customer.email });
      }
    }
    
    if (!response.data?.customers.pageInfo?.hasNextPage) break;
    cursor = response.data?.customers.pageInfo?.endCursor ?? undefined;
  }
  
  if (matches.length === 0) {
    return null;
  }
  
  if (matches.length === 1) {
    return { customer: matches[0] };
  }
  
  return { ambiguous: true, customerIds: matches.map(m => m.id) };
}

/**
 * Assign an existing customer as a contact on a company.
 * Returns the created CompanyContact ID, or null on failure.
 */
async function assignCustomerAsContact(
  state: SeedState,
  companyId: string,
  customerId: string
): Promise<{ contactId: string; customerId: string; email: string } | null> {
  const result = await graphql<{
    companyAssignCustomerAsContact: {
      companyContact: { id: string; customer: { id: string; email: string } } | null;
      userErrors: UserError[];
    };
  }>(state, COMPANY_ASSIGN_CUSTOMER_AS_CONTACT_MUTATION, {
    companyId,
    customerId,
  }, { isMutation: true, mutationName: "companyAssignCustomerAsContact" });
  
  if (result.errors) {
    console.error(`    ❌ Failed to assign customer as contact: GraphQL errors`);
    return null;
  }
  
  const userErrors = result.data?.companyAssignCustomerAsContact.userErrors ?? [];
  if (userErrors.length) {
    logUserErrors(userErrors, "assignCustomerAsContact");
    return null;
  }
  
  const contact = result.data?.companyAssignCustomerAsContact.companyContact;
  if (!contact) {
    console.error(`    ❌ No contact returned from companyAssignCustomerAsContact`);
    return null;
  }
  
  return {
    contactId: contact.id,
    customerId: contact.customer.id,
    email: contact.customer.email,
  };
}

/**
 * Set a contact as the main contact on a company.
 */
async function setMainContact(
  state: SeedState,
  companyId: string,
  contactId: string
): Promise<boolean> {
  const result = await graphql<{
    companyAssignMainContact: {
      company: { id: string } | null;
      userErrors: UserError[];
    };
  }>(state, COMPANY_ASSIGN_MAIN_CONTACT_MUTATION, {
    companyId,
    companyContactId: contactId,
  }, { isMutation: true, mutationName: "companyAssignMainContact" });
  
  if (result.errors) {
    console.error(`    ❌ Failed to set main contact: GraphQL errors`);
    return false;
  }
  
  const userErrors = result.data?.companyAssignMainContact.userErrors ?? [];
  if (userErrors.length) {
    logUserErrors(userErrors, "setMainContact");
    return false;
  }
  
  return result.data?.companyAssignMainContact.company != null;
}

/**
 * Continue seeding an existing/adopted company with locations.
 * Creates any missing Net-XX locations.
 */
async function continueWithExistingCompany(
  state: SeedState,
  company: CompanyNode,
  seed: CompanySeed,
  externalId: string
): Promise<CompanyData | null> {
  const contactRoles = await fetchCompanyContactRoles(state, company.id);
  const contactId = company.contacts.edges[0]?.node.id ?? "";
  
  const locations = new Map<number, string>();
  
  // Map existing locations
  for (const edge of company.locations.edges) {
    for (const loc of LOCATION_TERMS) {
      if (edge.node.name.includes(loc.suffix)) {
        locations.set(loc.dueInDays, edge.node.id);
      }
    }
  }
  
  const companyData: CompanyData = {
    id: company.id,
    contactId,
    contactCustomerId: company.contacts.edges[0]?.node.customer.id ?? "",
    locations,
    contactRoles,
  };
  
  // Create any missing Net-XX locations
  for (const loc of LOCATION_TERMS) {
    if (!locations.has(loc.dueInDays)) {
      console.log(`    → Creating missing location ${loc.suffix}...`);
      const template = state.paymentTermsTemplates.find(
        (t) => t.paymentTermsType === "NET" && t.dueInDays === loc.dueInDays
      );
      
      const locationId = await createCompanyLocation(state, company.id, seed.name, seed.city, loc, template?.id);
      if (locationId) {
        locations.set(loc.dueInDays, locationId);
        console.log(`    ✅ Created location ${loc.suffix}`);
        state.createdCount.locations++;
        // Assign role on the newly created location
        if (contactId && contactRoles.length > 0) {
          await ensureContactRoleOnLocation(state, companyData, locationId);
        }
      } else {
        state.failedCount.locations++;
        state.errors.push(`Failed to create location ${loc.suffix} for ${externalId}`);
      }
    } else {
      // Ensure role on existing location
      if (contactId && contactRoles.length > 0) {
        await ensureContactRoleOnLocation(state, companyData, locations.get(loc.dueInDays)!);
      }
    }
  }
  
  return companyData;
}

/**
 * Report potential duplicates for each seed company.
 * Lists companies with the same name or same contact email.
 * Read-only mode - no mutations.
 */
export async function reportDuplicates(state: SeedState): Promise<void> {
  console.log("\n🔍 Checking for potential duplicates...");
  console.log("   (Read-only mode - no changes will be made)\n");
  
  for (const seed of COMPANY_SEEDS) {
    const externalId = `${SEED_PREFIX}${seed.key}`;
    console.log(`  ${externalId}:`);
    
    // Check for existing company with seed externalId
    const existing = await findCompanyByExternalId(state, externalId);
    if (existing) {
      console.log(`    ✓ Found by externalId: ${existing.id}`);
    } else {
      console.log(`    ○ No company with externalId: ${externalId}`);
    }
    
    // Find companies with same name
    const nameMatches = await findCompaniesByName(state, seed.name);
    if (nameMatches.length > 0) {
      console.log(`    Companies with same name (${nameMatches.length}):`);
      for (const match of nameMatches) {
        const externalIdStr = match.externalId ? ` [externalId: ${match.externalId}]` : " [no externalId]";
        console.log(`      - ${match.id}${externalIdStr}`);
      }
    } else {
      console.log(`    ○ No companies with matching name`);
    }
    
    // Find companies with same contact email
    const emailMatches = await findCompaniesByContactEmail(state, seed.contact.email);
    if (emailMatches.length > 0) {
      console.log(`    Companies with same contact email (${emailMatches.length}):`);
      for (const match of emailMatches) {
        const externalIdStr = match.externalId ? ` [externalId: ${match.externalId}]` : " [no externalId]";
        console.log(`      - ${match.id}${externalIdStr}`);
      }
    } else {
      console.log(`    ○ No companies with matching contact email`);
    }
    
    // Find customers with same email (may cause TAKEN error even if no company exists)
    const customerLookup = await findCustomersByEmail(state, seed.contact.email);
    if (customerLookup) {
      if (customerLookup.ambiguous === true) {
        console.log(`    ⚠️  Multiple customers with matching email (${customerLookup.customerIds.length}):`);
        for (const customerId of customerLookup.customerIds) {
          console.log(`      - ${customerId}`);
        }
      } else {
        console.log(`    Customers with matching email (1):`);
        console.log(`      - ${customerLookup.customer.id}`);
      }
    } else {
      console.log(`    ○ No customers with matching email`);
    }
    
    console.log();
  }
  
  console.log("  Duplicate check complete. Review the output above.");
  console.log("  To clean up duplicates, use Shopify Admin or the API manually.");
  console.log("  Never delete automatically - always verify first.");
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

/**
 * Build CompanyCreateInput WITHOUT companyContact.
 * Used when an existing customer will be attached via companyAssignCustomerAsContact.
 * Exported for schema validation testing.
 */
export function buildCompanyCreateInputWithoutContact(
  seed: { name: string; city: string },
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
          firstName: "Branch",
          lastName: locationSuffix,
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
      // No companyContact - existing customer will be attached separately
    },
  };
}

/** Shape of a company seed (COMPANY_SEEDS or REVIEWER_DEMO_COMPANY_SEED) */
export interface CompanySeed {
  key: string;
  name: string;
  city: string;
  contact: {
    firstName: string;
    lastName: string;
    email: string;
  };
}

export async function createCompanyWithLocations(
  state: SeedState,
  seed: CompanySeed,
  externalId: string
): Promise<CompanyData | null> {
  const firstLoc = LOCATION_TERMS[0];
  const firstTemplate = state.paymentTermsTemplates.find(
    (t) => t.paymentTermsType === "NET" && t.dueInDays === firstLoc.dueInDays
  );

  // Check if a customer with this email already exists (from a prior seed run)
  const customerLookup = await findCustomersByEmail(state, seed.contact.email);
  
  if (customerLookup?.ambiguous === true) {
    // Multiple customers with same email - skip
    const reason = `Multiple customers with matching email for ${externalId}: ${customerLookup.customerIds.join(", ")}`;
    console.log(`  ⚠️  Skipped ${externalId}: ${reason}`);
    state.skippedCount.companies++;
    state.skippedReasons.push(reason);
    return null;
  }
  
  const existingCustomer = customerLookup && !customerLookup.ambiguous ? customerLookup.customer : null;
  
  // Choose mutation input based on whether customer exists
  const variables = existingCustomer
    ? buildCompanyCreateInputWithoutContact(seed, externalId, firstLoc.suffix, firstTemplate?.id)
    : buildCompanyCreateInput(seed, externalId, firstLoc.suffix, firstTemplate?.id);
  
  if (existingCustomer) {
    console.log(`    📎 Found existing customer ${existingCustomer.id}, will attach after company creation`);
  }

  const createResult = await graphql<{
    companyCreate: { company: CompanyNode | null; userErrors: UserError[] };
  }>(state, COMPANY_CREATE_MUTATION, variables, { isMutation: true, mutationName: "companyCreate" });

  if (createResult.errors) {
    console.error(`    ❌ Failed to create ${externalId}: GraphQL errors`);
    return null;
  }

  const userErrors = createResult.data?.companyCreate.userErrors ?? [];
  
  // Handle TAKEN error: email already exists, try to adopt the existing company
  const takenError = userErrors.find(e => 
    e.message.includes("already been taken") || 
    e.code === "TAKEN"
  );
  
  if (takenError) {
    console.log(`    ⚠️  Contact email already taken for ${externalId}, attempting recovery...`);
    
    // Find company by contact email and adopt it
    // Also try legacy email for migration from .example to @example.com
    const legacyEmail = LEGACY_SEED_EMAILS[seed.key];
    const adoptionResult = await findCompanyForAdoption(state, seed, legacyEmail);
    
    if (adoptionResult && "ambiguous" in adoptionResult) {
      console.error(`    ❌ Cannot recover: multiple companies with same contact email`);
      logUserErrors(userErrors, `createCompanyWithLocations(${externalId})`);
      return null;
    }
    
    if (adoptionResult && "company" in adoptionResult) {
      const candidate = adoptionResult.company;
      
      // P1: Check if candidate has a conflicting externalId (non-null and different from target)
      if (candidate.externalId !== null && candidate.externalId !== externalId) {
        const reason = `${candidate.id} already has externalId '${candidate.externalId}', cannot adopt as '${externalId}'`;
        console.error(`    ❌ Cannot recover: ${reason}`);
        state.skippedCount.companies++;
        state.skippedReasons.push(reason);
        return null;
      }
      
      console.log(`    📎 Found existing company by ${adoptionResult.matchType}, adopting...`);
      const adopted = await adoptCompany(state, candidate.id, externalId);
      if (adopted) {
        console.log(`    ✅ Recovered by adopting ${adopted.id}`);
        state.adoptedCount.companies++;
        
        // Continue with the adopted company (will create missing locations below)
        return await continueWithExistingCompany(state, adopted, seed, externalId);
      } else {
        console.error(`    ❌ Failed to adopt company during TAKEN recovery`);
        return null;
      }
    }
    
    // No company found - try customer path: create company without contact, attach customer
    const takenCustomerLookup = await findCustomersByEmail(state, seed.contact.email);
    
    if (takenCustomerLookup?.ambiguous === true) {
      const reason = `Multiple customers with email ${seed.contact.email}: ${takenCustomerLookup.customerIds.join(", ")}`;
      console.error(`    ❌ Cannot recover: ${reason}`);
      state.skippedCount.companies++;
      state.skippedReasons.push(reason);
      return null;
    }
    
    const takenCustomer = takenCustomerLookup && !takenCustomerLookup.ambiguous ? takenCustomerLookup.customer : null;
    if (takenCustomer) {
      console.log(`    📎 Found existing customer ${takenCustomer.id}, creating company without contact...`);
      
      const recoveryVars = buildCompanyCreateInputWithoutContact(seed, externalId, firstLoc.suffix, firstTemplate?.id);
      const recoveryResult = await graphql<{
        companyCreate: { company: CompanyNode | null; userErrors: UserError[] };
      }>(state, COMPANY_CREATE_MUTATION, recoveryVars, { isMutation: true, mutationName: "companyCreate" });
      
      if (recoveryResult.errors || recoveryResult.data?.companyCreate.userErrors.length) {
        console.error(`    ❌ Recovery companyCreate failed`);
        if (recoveryResult.data?.companyCreate.userErrors.length) {
          logUserErrors(recoveryResult.data.companyCreate.userErrors, "TAKEN recovery companyCreate");
        }
        return null;
      }
      
      const recoveredCompany = recoveryResult.data?.companyCreate.company;
      if (!recoveredCompany) {
        console.error(`    ❌ Recovery companyCreate returned null`);
        return null;
      }
      
      // Attach the existing customer
      const attachedContact = await assignCustomerAsContact(state, recoveredCompany.id, takenCustomer.id);
      if (!attachedContact) {
        console.error(`    ❌ Failed to attach customer to recovered company`);
        return null;
      }
      
      // Set as main contact
      await setMainContact(state, recoveredCompany.id, attachedContact.contactId);
      console.log(`    ✅ Recovered: created company and attached existing customer`);
      state.createdCount.companies++;
      
      // Build company data and continue with locations
      const contactRoles = await fetchCompanyContactRoles(state, recoveredCompany.id);
      const locations = new Map<number, string>();
      const firstLocationId = recoveredCompany.locations.edges[0]?.node.id;
      
      const companyData: CompanyData = {
        id: recoveredCompany.id,
        contactId: attachedContact.contactId,
        contactCustomerId: attachedContact.customerId,
        locations,
        contactRoles,
      };
      
      if (firstLocationId) {
        locations.set(firstLoc.dueInDays, firstLocationId);
        console.log(`    → Location ${firstLoc.suffix}: created`);
        state.createdCount.locations++;
        if (attachedContact.contactId && contactRoles.length > 0) {
          await ensureContactRoleOnLocation(state, companyData, firstLocationId);
        }
      }
      
      // Create remaining locations
      for (let i = 1; i < LOCATION_TERMS.length; i++) {
        const loc = LOCATION_TERMS[i];
        const template = state.paymentTermsTemplates.find(
          (t) => t.paymentTermsType === "NET" && t.dueInDays === loc.dueInDays
        );
        const locationId = await createCompanyLocation(state, recoveredCompany.id, seed.name, seed.city, loc, template?.id);
        if (locationId) {
          locations.set(loc.dueInDays, locationId);
          console.log(`    → Location ${loc.suffix}: created`);
          state.createdCount.locations++;
          if (attachedContact.contactId && contactRoles.length > 0) {
            await ensureContactRoleOnLocation(state, companyData, locationId);
          }
        } else {
          state.failedCount.locations++;
          state.errors.push(`Failed to create location ${loc.suffix} for ${externalId}`);
        }
      }
      
      return companyData;
    }
    
    // No company AND no customer found - log original error
    console.error(`    ❌ TAKEN error but no company or customer found with contact email`);
    logUserErrors(userErrors, `createCompanyWithLocations(${externalId})`);
    return null;
  }

  if (userErrors.length) {
    logUserErrors(userErrors, `createCompanyWithLocations(${externalId})`);
    return null;
  }

  const company = createResult.data?.companyCreate.company;
  if (!company) {
    console.error(`    ❌ No company returned for ${externalId} (companyCreate returned null)`);
    return null;
  }

  // If we created company without contact (because customer existed), attach the customer now
  let contactId = company.contacts.edges[0]?.node.id ?? "";
  let contactCustomerId = company.contacts.edges[0]?.node.customer.id ?? "";
  
  if (existingCustomer && !contactId) {
    console.log(`    → Attaching existing customer ${existingCustomer.id}...`);
    const attachedContact = await assignCustomerAsContact(state, company.id, existingCustomer.id);
    if (attachedContact) {
      contactId = attachedContact.contactId;
      contactCustomerId = attachedContact.customerId;
      await setMainContact(state, company.id, contactId);
      console.log(`    ✅ Attached customer as main contact`);
    } else {
      console.error(`    ⚠️  Failed to attach existing customer, company created without contact`);
    }
  }

  // Fetch contact roles for role assignment
  const contactRoles = await fetchCompanyContactRoles(state, company.id);

  const locations = new Map<number, string>();
  const firstLocationId = company.locations.edges[0]?.node.id;
  
  // Build partial company data for role assignment
  const companyData: CompanyData = {
    id: company.id,
    contactId,
    contactCustomerId,
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
      state.errors.push(`Failed to create location ${loc.suffix} for ${externalId}`);
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
 * Query to find a company by externalId.
 * 
 * NOTE: Shopify's `companies(query: "external_id:...")` uses fuzzy, tokenised search.
 * A search for "ntr-seed-company-1" can return "ntr-seed-company-10".
 * We paginate up to MAX_SEARCH_PAGES and filter client-side for exact match.
 */
export const FIND_COMPANY_BY_EXTERNAL_ID_QUERY = `
  query FindCompany($query: String!, $after: String) {
    companies(first: 10, query: $query, after: $after) {
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
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/**
 * Query to find companies by name.
 * Used for adoption fallback and duplicate reporting.
 * 
 * NOTE: Shopify's `companies(query: "name:...")` uses fuzzy search.
 * We paginate and filter client-side for exact name match.
 */
export const FIND_COMPANIES_BY_NAME_QUERY = `
  query FindCompaniesByName($query: String!, $after: String) {
    companies(first: 20, query: $query, after: $after) {
      nodes {
        id
        name
        externalId
        contacts(first: 5) {
          edges { node { id customer { id email } } }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/**
 * Query to find companies with their contacts.
 * Used for adoption by contact email matching.
 * 
 * NOTE: No direct "companies by contact email" query exists.
 * We fetch all companies and filter client-side for matching contact email.
 */
export const FIND_COMPANIES_WITH_CONTACTS_QUERY = `
  query FindCompaniesWithContacts($after: String) {
    companies(first: 50, after: $after) {
      nodes {
        id
        name
        externalId
        contacts(first: 5) {
          edges { node { customer { id email } } }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/**
 * Mutation to update a company's externalId (for adoption).
 */
export const COMPANY_UPDATE_MUTATION = `
  mutation UpdateCompany($companyId: ID!, $input: CompanyInput!) {
    companyUpdate(companyId: $companyId, input: $input) {
      company {
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
      userErrors { field message code }
    }
  }
`;

/**
 * Query to find an order by tag.
 * 
 * NOTE: Shopify's `orders(query: "tag:...")` uses fuzzy, tokenised search.
 * We paginate up to MAX_SEARCH_PAGES and filter client-side for exact tag match.
 */
export const FIND_ORDER_BY_TAG_QUERY = `
  query FindOrder($query: String!, $after: String) {
    orders(first: 10, query: $query, after: $after) {
      nodes { id name tags }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/**
 * Query to find a customer by email.
 * 
 * NOTE: Shopify's `customers(query: "email:...")` uses fuzzy search.
 * We paginate up to MAX_SEARCH_PAGES and filter for exact email match.
 */
export const FIND_CUSTOMER_BY_EMAIL_QUERY = `
  query FindCustomer($query: String!, $after: String) {
    customers(first: 10, query: $query, after: $after) {
      nodes { id email tags }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/**
 * Mutation to update a customer's email.
 * 
 * NOTE: Admin API 2026-10 customerUpdate uses plain UserError (field, message only).
 * Do NOT select `code` on userErrors - it doesn't exist on this type.
 */
export const CUSTOMER_UPDATE_MUTATION = `
  mutation CustomerUpdate($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer { id email }
      userErrors { field message }
    }
  }
`;

/**
 * Mutation to assign an existing customer as a contact on a company.
 * Used when a customer already exists (from a previous seed run) and we want
 * to attach them to a new company instead of getting a TAKEN error.
 */
export const COMPANY_ASSIGN_CUSTOMER_AS_CONTACT_MUTATION = `
  mutation CompanyAssignCustomerAsContact($companyId: ID!, $customerId: ID!) {
    companyAssignCustomerAsContact(companyId: $companyId, customerId: $customerId) {
      companyContact {
        id
        customer { id email }
      }
      userErrors { field message code }
    }
  }
`;

/**
 * Mutation to set a company contact as the main contact.
 */
export const COMPANY_ASSIGN_MAIN_CONTACT_MUTATION = `
  mutation CompanyAssignMainContact($companyId: ID!, $companyContactId: ID!) {
    companyAssignMainContact(companyId: $companyId, companyContactId: $companyContactId) {
      company { id }
      userErrors { field message code }
    }
  }
`;

/** Maximum pages to fetch when searching for exact matches (prevents runaway pagination) */
export const MAX_SEARCH_PAGES = 10;

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
export async function assignRoleToContactOnLocation(
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
    const code = payload.userErrors[0].code ?? "UNKNOWN";
    console.error(`    ❌ Failed to assign role: [${code}]`);
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
    state.unchangedCount.roleAssignments++;
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
      console.log(`  ✓ [${orderIndex}/${totalOrders}] Order unchanged (${existingOrder.name})`);
      state.unchangedCount.orders++;
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

interface OrdersSearchResult {
  orders: {
    nodes: OrderNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

/**
 * Find an order by exact tag match.
 * 
 * IMPORTANT: Shopify's `orders(query: "tag:...")` uses fuzzy, tokenised search.
 * We paginate up to MAX_SEARCH_PAGES and filter client-side for exact tag match.
 * 
 * @returns The order with exact tag match, or null if not found
 */
export async function findOrderByTag(state: SeedState, tag: string): Promise<OrderNode | null> {
  let cursor: string | undefined = undefined;
  
  for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
    const variables: { query: string; after?: string } = { query: `tag:'${tag}'` };
    if (cursor) variables.after = cursor;
    
    const response: GraphQLResponse<OrdersSearchResult> = await graphql<OrdersSearchResult>(
      state,
      FIND_ORDER_BY_TAG_QUERY,
      variables
    );
    const orders = response.data?.orders.nodes ?? [];
    
    // Strict match: return if tags array includes the exact tag
    const exactMatch = orders.find((o: OrderNode) => o.tags.includes(tag));
    if (exactMatch) {
      return exactMatch;
    }
    
    const hasNextPage = response.data?.orders.pageInfo?.hasNextPage ?? false;
    if (!hasNextPage) {
      return null;
    }
    cursor = response.data?.orders.pageInfo?.endCursor ?? undefined;
  }
  
  console.log(`  ⚠️  Search for order with tag "${tag}" exceeded ${MAX_SEARCH_PAGES} pages`);
  return null;
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

interface CustomerSearchNode {
  id: string;
  email: string | null;
  tags: string[];
}

interface CustomersSearchResult {
  customers: {
    nodes: CustomerSearchNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

/**
 * Migrate legacy seed customer emails from .example TLD to @example.com domain.
 * 
 * Shopify rejects .example TLD as invalid ("Email contains an invalid domain name").
 * This function finds existing customers via company externalId (the stable key for
 * fixture company contacts) and updates their email in place using customerUpdate.
 * 
 * Lookup is by company externalId (ntr-seed-company-*), then the contact customer.
 * 
 * Idempotent:
 * - If the contact customer's email is already @example.com, count as unchanged.
 * - If the contact customer's email is legacy (.example), update it.
 * - If no company or contact exists, nothing to migrate (create path handles it).
 * 
 * The create path cannot duplicate because companyCreate with a taken email fails
 * with TAKEN error, which triggers adoption of the existing company.
 * 
 * @returns void - counts are tracked in state
 */
export async function migrateCustomerEmails(state: SeedState): Promise<void> {
  if (state.dryRun) {
    return;
  }
  
  for (const [seedKey, legacyEmail] of Object.entries(LEGACY_SEED_EMAILS)) {
    const companyExternalId = `${SEED_PREFIX}${seedKey}`;
    const newEmail = seedEmail(seedKey);
    
    // Find company by externalId (stable key)
    const company = await findCompanyByExternalId(state, companyExternalId);
    if (!company) {
      continue;
    }
    
    // Get the contact customer
    const contactCustomer = company.contacts.edges[0]?.node?.customer;
    if (!contactCustomer) {
      continue;
    }
    
    const currentEmail = contactCustomer.email?.toLowerCase() ?? "";
    const newEmailLower = newEmail.toLowerCase();
    const legacyEmailLower = legacyEmail.toLowerCase();
    
    // Already migrated
    if (currentEmail === newEmailLower) {
      state.unchangedCount.customers++;
      continue;
    }
    
    // Not the legacy email we're looking for (possibly manual change)
    if (currentEmail !== legacyEmailLower) {
      continue;
    }
    
    // Update the customer's email
    const updated = await updateCustomerEmail(state, contactCustomer.id, newEmail);
    if (updated) {
      state.updatedCount.customers++;
    } else {
      state.failedCount.customers++;
    }
  }
}

/**
 * Update a customer's email using customerUpdate mutation.
 * Returns true on success, false on failure.
 */
async function updateCustomerEmail(
  state: SeedState,
  customerId: string,
  newEmail: string
): Promise<boolean> {
  const result = await graphql<{
    customerUpdate: {
      customer: { id: string; email: string } | null;
      userErrors: UserError[];
    };
  }>(state, CUSTOMER_UPDATE_MUTATION, {
    input: {
      id: customerId,
      email: newEmail,
    },
  }, { isMutation: true, mutationName: "customerUpdate" });
  
  const check = checkMutationResult(
    result,
    result.data?.customerUpdate?.userErrors,
    result.data?.customerUpdate?.customer
  );
  
  return check.ok;
}

/**
 * Find or create a tagged customer, then tag with tagsAdd (idempotent).
 * Does NOT tag B2B contacts - their terms come from location/DB defaults.
 * 
 * IMPORTANT: Shopify's `customers(query: "email:...")` uses fuzzy search.
 * We paginate up to MAX_SEARCH_PAGES and filter for exact email match.
 *
 * @returns Customer ID or null on failure
 */
export async function ensureTaggedCustomer(
  state: SeedState,
  email: string,
  termsDays: number
): Promise<string | null> {
  const tag = `${SEED_TAG}-net${termsDays}`;

  // Try to find existing customer by email with pagination (strict match)
  let cursor: string | undefined = undefined;
  let customerId: string | undefined;
  
  for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
    const variables: { query: string; after?: string } = { query: `email:'${email}'` };
    if (cursor) variables.after = cursor;
    
    const response: GraphQLResponse<CustomersSearchResult> = await graphql<CustomersSearchResult>(
      state,
      FIND_CUSTOMER_BY_EMAIL_QUERY,
      variables
    );

    if (response.errors) {
      console.log(`    ⚠️  GraphQL error finding customer: ${response.errors.length} error(s)`);
      return null;
    }

    // Strict match: find customer with exact email
    const customers = response.data?.customers.nodes ?? [];
    const exactMatch = customers.find((c: CustomerSearchNode) => c.email?.toLowerCase() === email.toLowerCase());
    if (exactMatch) {
      customerId = exactMatch.id;
      break;
    }
    
    const hasNextPage = response.data?.customers.pageInfo?.hasNextPage ?? false;
    if (!hasNextPage) {
      break;
    }
    cursor = response.data?.customers.pageInfo?.endCursor ?? undefined;
    
    if (page === MAX_SEARCH_PAGES - 1) {
      console.log(`    ⚠️  Customer search exceeded ${MAX_SEARCH_PAGES} pages`);
    }
  }

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

    const createCheck = checkMutationResult(
      createResult,
      createResult.data?.customerCreate?.userErrors,
      createResult.data?.customerCreate?.customer
    );

    if (!createCheck.ok) {
      console.log(`    ⚠️  Failed to create customer: ${createCheck.failureReason}`);
      return null;
    }

    customerId = createCheck.data?.id;
    if (!customerId) {
      console.log(`    ⚠️  No customer ID returned`);
      return null;
    }
    console.log(`    → Created customer: ${customerId}`);
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

  const tagCheck = checkMutationResult(
    tagResult,
    tagResult.data?.tagsAdd?.userErrors,
    tagResult.data?.tagsAdd?.node
  );

  if (!tagCheck.ok) {
    console.log(`    ⚠️  Failed to tag customer: ${tagCheck.failureReason}`);
    return null;
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
    } else {
      state.errors.push(`Failed to ensure tagged customer for Net ${seed.termsDays}`);
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
      console.log(`  ✓ [${orderIndex}/${totalTaggedOrders}] Tagged order unchanged (${existingOrder.name})`);
      state.unchangedCount.orders++;
      continue;
    }

    const customerId = customerMap.get(orderSpec.customerTermsDays);
    if (!customerId) {
      console.error(`  ❌ [${orderIndex}/${totalTaggedOrders}] No customer found for Net ${orderSpec.customerTermsDays}`);
      state.failedCount.orders++;
      state.errors.push(`No customer found for tagged order ${orderIndex}`);
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
    name?: string;
  }
): { order: Record<string, unknown>; options: Record<string, unknown> } {
  const city = options.city ?? DEFAULT_ORDER_CITY;
  const addressInfo = getIndiaAddressInfo(city);
  return {
    order: {
      tags: [SEED_TAG, options.orderKey],
      companyLocationId: options.companyLocationId,
      ...(options.name && { name: options.name }),
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
    name?: string;
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
    name: options.name,
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

// -- Reviewer Demo Seeding --

/**
 * Seed the reviewer demo company and orders.
 *
 * FOR THE THROWAWAY INR DEMO STORE ONLY - never the main dev store.
 *
 * This creates a company "Test Buyer Co" with specific orders that match
 * the synthetic reviewer CSV (hdfc-review-synthetic.csv). The orders have
 * specific amounts and names (#1001, #1002) to test the matching flow.
 *
 * This function is:
 * - ADDITIVE: Does not modify the existing 5 COMPANY_SEEDS companies
 * - IDEMPOTENT: Re-running creates no duplicates (uses externalId)
 *
 * The company and orders match the fixture data in:
 * - tests/fixtures/reviewer-demo.ts
 */
export async function seedReviewerDemoCompany(state: SeedState): Promise<void> {
  console.log("\n🎬 Seeding reviewer demo company...");
  console.log("   (FOR THROWAWAY INR DEMO STORE ONLY - not main dev store)");

  const seed = REVIEWER_DEMO_COMPANY_SEED;
  const externalId = `${SEED_PREFIX}${seed.key}`;

  // Check if company already exists
  const existing = await findCompanyByExternalId(state, externalId);
  
  if (existing) {
    console.log(`  ✅ Reviewer demo company already exists: ${existing.id}`);
    
    // Store in state for order creation
    const contactRoles = await fetchCompanyContactRoles(state, existing.id);
    const locations = new Map<number, string>();
    for (const edge of existing.locations.edges) {
      for (const loc of LOCATION_TERMS) {
        const locName = edge.node.name;
        if (locName.includes(loc.suffix)) {
          locations.set(loc.dueInDays, edge.node.id);
        }
      }
    }
    
    state.companies.set(seed.key, {
      id: existing.id,
      contactId: existing.contacts.edges[0]?.node.id ?? "",
      contactCustomerId: existing.contacts.edges[0]?.node.customer.id ?? "",
      locations,
      contactRoles,
    });
    state.unchangedCount.companies++;
  } else if (state.dryRun) {
    console.log(`  [dry-run] Would create reviewer demo company (${externalId})`);
    state.createdCount.companies++;
    return;
  } else {
    // Create the company
    const companyData = await createCompanyWithLocations(state, seed, externalId);
    if (!companyData) {
      state.failedCount.companies++;
      state.errors.push(`Failed to create reviewer demo company: ${externalId}`);
      return;
    }
    state.companies.set(seed.key, companyData);
    console.log(`  ✅ Created reviewer demo company: ${companyData.id}`);
  }

  // Seed the reviewer demo orders
  await seedReviewerDemoOrders(state);
}

/**
 * Seed the specific orders for the reviewer demo.
 * These have specific amounts matching the synthetic reviewer CSV.
 * Order names are assigned by Shopify and logged for verification.
 */
async function seedReviewerDemoOrders(state: SeedState): Promise<void> {
  console.log("\n📝 Seeding reviewer demo orders...");
  console.log("   (Order names are Shopify-assigned; logged below for reference)");

  const companyData = state.companies.get(REVIEWER_DEMO_COMPANY_SEED.key);
  if (!companyData) {
    console.log("  ⚠️  Skipping: reviewer demo company not found in state");
    return;
  }

  for (const orderSpec of REVIEWER_DEMO_ORDERS) {
    // Use SEED_PREFIX (like regular orders) so findOrderByTag matches correctly
    // buildB2BOrderInput creates tags: [SEED_TAG, orderKey], so the full key
    // must be passed for the lookup to find the second tag element
    const orderKey = `${SEED_PREFIX}${orderSpec.orderKey}`;
    
    // Check if order already exists (idempotency)
    const existingOrder = await findOrderByTag(state, orderKey);
    if (existingOrder) {
      console.log(`  ✅ Order ${orderSpec.orderKey} already exists`);
      state.unchangedCount.orders++;
      continue;
    }

    const locationId = companyData.locations.get(orderSpec.locationTermsDays);
    if (!locationId) {
      console.log(`  ⚠️  Skipping ${orderSpec.orderKey}: no Net-${orderSpec.locationTermsDays} location`);
      state.skippedCount.orders++;
      continue;
    }

    const processedAt = new Date();
    processedAt.setDate(processedAt.getDate() - orderSpec.daysAgo);

    if (state.dryRun) {
      console.log(
        `  [dry-run] Would create reviewer demo order ${orderSpec.orderName}: ` +
        formatCurrency(orderSpec.amountInr, state.currencyCode)
      );
      state.createdCount.orders++;
      continue;
    }

    // Create the order with explicit name via OrderCreateOrderInput.name
    const order = await createOrder(state, {
      orderKey: orderKey,
      companyLocationId: locationId,
      customerId: companyData.contactCustomerId,
      productTitle: orderSpec.productTitle,
      amount: orderSpec.amountInr,
      processedAt: processedAt.toISOString(),
      expectedTermsDays: orderSpec.locationTermsDays,
      name: orderSpec.orderName,
    });

    if (!order) {
      state.failedCount.orders++;
      state.errors.push(`Failed to create reviewer demo order ${orderSpec.orderName}`);
      continue;
    }

    // Verify API accepted the requested order name
    const nameMatches = order.name === orderSpec.orderName;
    if (!nameMatches) {
      state.failedCount.orders++;
      state.errors.push(`Order name mismatch for ${orderSpec.orderKey}: expected ${orderSpec.orderName}, nameMatches=${nameMatches}`);
      continue;
    }

    console.log(
      `  ✅ Created reviewer demo order ${orderSpec.orderKey}: ` +
      `nameMatches=${nameMatches}, ` +
      formatCurrency(orderSpec.amountInr, state.currencyCode)
    );
    state.createdCount.orders++;
  }
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
  const tracker = createSeedDbWriteTracker();

  try {
    // Upsert Shop record - RETURNING id and xmax to detect create vs update
    // xmax = 0 means row was inserted, xmax > 0 means row was updated
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
      RETURNING id, xmax::text
    `;
    const shopId = shopResult[0]?.id;
    const shopWasCreated = shopResult[0]?.xmax === "0";
    tracker.shopId = shopId;
    console.log(`  ✅ Shop record ${shopWasCreated ? "created" : "updated"}`);

    // Upsert AccountSource tag rules for Net 15/30/60
    // Note: We don't specify id in INSERT - let ON CONFLICT use existing id or generate new one
    // This handles both fresh installs (new rows) and existing installs (updates existing rows)
    for (const loc of LOCATION_TERMS) {
      const tag = `${SEED_TAG}-net${loc.dueInDays}`;
      tracker.tags.add(tag);
      
      // Use a shop-scoped id to avoid conflicts across different shops
      const sourceId = `seed-source-${shopId}-${tag}`;
      
      const result = await sql`
        INSERT INTO "AccountSource" (id, "shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
        VALUES (
          ${sourceId},
          ${shopId},
          ${tag},
          ${loc.dueInDays},
          NOW(),
          NOW()
        )
        ON CONFLICT ("shopId", tag) DO UPDATE SET
          "defaultTermsDays" = EXCLUDED."defaultTermsDays",
          "updatedAt" = NOW()
        RETURNING xmax::text
      `;
      const wasCreated = result[0]?.xmax === "0";
      if (wasCreated) {
        tracker.createdAccountSources++;
      } else {
        tracker.updatedAccountSources++;
      }
      console.log(`  ✅ Tag rule: ${tag} → Net ${loc.dueInDays} (${wasCreated ? "created" : "updated"})`);
    }

    // Upsert BuyerAccount records for each company location
    // Use shop-scoped id to avoid conflicts across different shops
    for (const [companyKey, company] of state.companies) {
      for (const [dueInDays, locationId] of company.locations) {
        tracker.companyLocationIds.add(locationId);
        const accountName = `${COMPANY_SEEDS.find(c => c.key === companyKey)?.name ?? companyKey} - Net ${dueInDays}`;
        const accountId = `seed-account-${shopId}-${locationId}`;
        
        const result = await sql`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "companyId", "companyLocationId", name,
            "defaultTermsDays", "defaultTermsSource", "holdState", "createdAt", "updatedAt"
          )
          VALUES (
            ${accountId},
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
          RETURNING xmax::text
        `;
        const wasCreated = result[0]?.xmax === "0";
        if (wasCreated) {
          tracker.createdBuyerAccounts++;
        } else {
          tracker.updatedBuyerAccounts++;
        }
      }
    }

    // Get summary from tracker
    const summary = getSeedDbSummary(tracker);
    state.createdCount.dbRules = summary.totalAccountSources;
    state.createdCount.dbAccounts = summary.totalBuyerAccounts;
    
    const rulesMsg = summary.accountSourcesCreated > 0 && summary.accountSourcesUpdated > 0
      ? `${summary.accountSourcesCreated} created, ${summary.accountSourcesUpdated} updated`
      : summary.accountSourcesCreated > 0
        ? `${summary.accountSourcesCreated} created`
        : `${summary.accountSourcesUpdated} updated`;
    
    const accountsMsg = summary.buyerAccountsCreated > 0 && summary.buyerAccountsUpdated > 0
      ? `${summary.buyerAccountsCreated} created, ${summary.buyerAccountsUpdated} updated`
      : summary.buyerAccountsCreated > 0
        ? `${summary.buyerAccountsCreated} created`
        : `${summary.buyerAccountsUpdated} updated`;
    
    console.log(`  ✅ AccountSources: ${summary.totalAccountSources} (${rulesMsg})`);
    console.log(`  ✅ BuyerAccounts: ${summary.totalBuyerAccounts} (${accountsMsg})`);

    // Verify counts against actual DB state using exact keys we wrote
    const actualCounts = await getSeedDbCounts(sql, tracker);
    let hasMismatch = false;
    
    if (actualCounts.accountSourceCount !== summary.totalAccountSources) {
      console.log(`  ⚠️  AccountSource count mismatch: tracker=${summary.totalAccountSources}, DB=${actualCounts.accountSourceCount}`);
      state.createdCount.dbRules = actualCounts.accountSourceCount;
      hasMismatch = true;
    }
    
    if (actualCounts.buyerAccountCount !== summary.totalBuyerAccounts) {
      console.log(`  ⚠️  BuyerAccount count mismatch: tracker=${summary.totalBuyerAccounts}, DB=${actualCounts.buyerAccountCount}`);
      state.createdCount.dbAccounts = actualCounts.buyerAccountCount;
      hasMismatch = true;
    }

    if (hasMismatch) {
      state.failedCount.dbRows++;
    }

  } finally {
    await sql.end();
  }
}

export function printDatabaseSeedSQL(state: SeedState): void {
  const shopId = `seed-shop-placeholder`;
  const shopDomain = "<YOUR_SHOP_DOMAIN>";
  
  console.log(`-- Upsert Shop (replace <YOUR_SHOP_DOMAIN> with actual domain)`);
  console.log(`INSERT INTO "Shop" (id, domain, currency, plan, "defaultTermsDays", timezone, "createdAt", "updatedAt")`);
  console.log(`VALUES ('${shopId}', '${shopDomain}', '${state.currencyCode || "INR"}', 'development', 30, 'Asia/Kolkata', NOW(), NOW())`);
  console.log(`ON CONFLICT (domain) DO UPDATE SET currency = EXCLUDED.currency, "updatedAt" = NOW();`);
  console.log();

  console.log(`-- Upsert AccountSource tag rules (IDs are shop-scoped to avoid cross-shop conflicts)`);
  for (const loc of LOCATION_TERMS) {
    const tag = `${SEED_TAG}-net${loc.dueInDays}`;
    const sourceId = `seed-source-${shopId}-${tag}`;
    console.log(`INSERT INTO "AccountSource" (id, "shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")`);
    console.log(`VALUES ('${sourceId}', '${shopId}', '${tag}', ${loc.dueInDays}, NOW(), NOW())`);
    console.log(`ON CONFLICT ("shopId", tag) DO UPDATE SET "defaultTermsDays" = EXCLUDED."defaultTermsDays", "updatedAt" = NOW();`);
  }
  console.log();

  console.log(`-- Upsert BuyerAccount records for each company location (IDs are shop-scoped)`);
  for (const [companyKey, company] of state.companies) {
    for (const [dueInDays, locationId] of company.locations) {
      // Use externalId for account name (PII-free)
      const externalId = `${SEED_PREFIX}${companyKey}`;
      const accountName = `${externalId} - Net ${dueInDays}`;
      const accountId = `seed-account-${shopId}-${locationId}`;
      console.log(`INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "defaultTermsDays", "defaultTermsSource", "holdState", "createdAt", "updatedAt")`);
      console.log(`VALUES ('${accountId}', '${shopId}', 'COMPANY', '${company.id}', '${locationId}', '${accountName}', ${dueInDays}, 'explicit', 'OK', NOW(), NOW())`);
      console.log(`ON CONFLICT ("shopId", "companyLocationId") DO UPDATE SET "defaultTermsDays" = EXCLUDED."defaultTermsDays", "defaultTermsSource" = EXCLUDED."defaultTermsSource", "updatedAt" = NOW();`);
    }
  }
}

// -- Main --

/**
 * Check if the reviewer demo seed is enabled.
 * Exported for testing. Used by parseArgs().
 *
 * @param argv - Command line arguments (e.g., process.argv.slice(2))
 * @param env - Environment variables (e.g., process.env)
 */
export function isReviewerDemoEnabled(argv: string[], env: Record<string, string | undefined>): boolean {
  if (argv.includes("--reviewer-demo")) return true;
  if (env.SEED_REVIEWER_DEMO === "1") return true;
  if (env.SEED_REVIEWER_DEMO === "0") return false;
  return false;
}

function parseArgs(): { dryRun: boolean; reset: boolean; resetApply: boolean; reportDuplicatesMode: boolean; reseedHeldCurrencyMode: boolean; reviewerDemo: boolean } {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes("--dry-run"),
    reset: args.includes("--reset"),
    resetApply: args.includes("--apply"),
    reportDuplicatesMode: args.includes("--report-duplicates"),
    reseedHeldCurrencyMode: args.includes("--reseed-held-currency"),
    reviewerDemo: isReviewerDemoEnabled(args, process.env),
  };
}

/**
 * --reseed-held-currency: update the existing credit_status metafield on the held
 * seed fixtures to the shop currency (INR) in place. DB access is READ ONLY; the
 * only writes are metafieldsSet on those fixtures' owners. Counts/enums only.
 */
export async function runReseedHeldCurrency(state: SeedState): Promise<boolean> {
  console.log("\n🔒 Re-seeding held fixtures' credit_status currency...");
  if (!state.databaseUrl) {
    console.error("  ❌ held_fixture_currency: refused (reason=no_database)");
    return false;
  }
  const sql = postgres(state.databaseUrl, { max: 1 });
  try {
    const result = await reseedHeldFixtureCurrency({
      shopCurrency: state.currencyCode,
      dryRun: state.dryRun,
      loadHeldFixtures: async () =>
        sql.begin("READ ONLY", async (tx) => {
          const rows = await tx<HeldFixtureRow[]>`
            SELECT ba.id, ba."companyLocationId", ba."customerId"
            FROM "BuyerAccount" ba
            JOIN "Shop" s ON s.id = ba."shopId"
            WHERE s.domain = ${state.shop}
              AND ba.id LIKE ${HELD_FIXTURE_ID_PREFIX + "%"}
              AND (ba."holdState" = 'HELD' OR ba."manualHold" = true)
            ORDER BY ba.id
            LIMIT ${HELD_FIXTURE_MAX + 1}
          `;
          return [...rows];
        }),
      readMetafields: async (ownerIds) => {
        const res = await graphql<{ nodes: Array<{ id?: string; metafield?: OwnerMetafield | null } | null> }>(
          state,
          HELD_FIXTURE_METAFIELDS_QUERY,
          { ids: ownerIds }
        );
        if (res.errors && res.errors.length > 0) {
          throw new Error("held_fixture_read_failed");
        }
        const map = new Map<string, OwnerMetafield | null>();
        for (const node of res.data?.nodes ?? []) {
          if (node && typeof node.id === "string") map.set(node.id, node.metafield ?? null);
        }
        return map;
      },
      writeMetafield: async (ownerId, value, compareDigest) => {
        const res = await graphql<{ metafieldsSet: { userErrors: Array<{ field: string[] | null; code: string | null }> } }>(
          state,
          HELD_FIXTURE_METAFIELDS_SET_MUTATION,
          {
            metafields: [
              { ownerId, namespace: "$app", key: "credit_status", type: "json", value, compareDigest },
            ],
          },
          { isMutation: true, mutationName: "metafieldsSet" }
        );
        if (res.errors && res.errors.length > 0) return false;
        const userErrors = res.data?.metafieldsSet?.userErrors ?? [];
        if (userErrors.length > 0) {
          const codes = userErrors.map((e) => (e.code && /^[A-Z_]{1,40}$/.test(e.code) ? e.code : "OTHER"));
          console.error(`  ❌ metafieldsSet userErrors: count=${userErrors.length} codes=[${codes.join(",")}]`);
          return false;
        }
        return true;
      },
    });
    if (!result.ok) {
      console.error(`  ❌ held_fixture_currency: failed (reason=${result.reason})`);
      return false;
    }
    console.log("  ✅ held_fixture_currency: ok");
    return true;
  } finally {
    await sql.end();
  }
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

  // Security: enforce the configured dev store domain (fail closed if unset)
  const allowedDevStore = process.env.ALLOWED_DEV_STORE?.trim();
  if (!allowedDevStore) {
    console.error("❌ Missing ALLOWED_DEV_STORE environment variable");
    console.error("   Set it to the dev-store domain the seed may run against. Seed refuses to run without it.");
    return null;
  }
  if (!DEV_STORE_DOMAIN_RE.test(allowedDevStore)) {
    console.error("❌ Security: ALLOWED_DEV_STORE is not a valid Shopify store domain");
    return null;
  }
  if (shop !== allowedDevStore) {
    console.error("❌ Security: SHOP is not a valid dev-store domain");
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

  const { dryRun, reset, resetApply, reportDuplicatesMode, reseedHeldCurrencyMode, reviewerDemo } = parseArgs();
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
    resetApply,
    reportDuplicates: reportDuplicatesMode,
    reviewerDemo,
    currencyCode: "",
    companies: new Map(),
    paymentTermsTemplates: [],
    createdCount: { companies: 0, locations: 0, orders: 0, roleAssignments: 0, dbRules: 0, dbAccounts: 0, customers: 0 },
    unchangedCount: { companies: 0, locations: 0, orders: 0, roleAssignments: 0, customers: 0 },
    updatedCount: { customers: 0 },
    adoptedCount: { companies: 0 },
    driftedCount: { companies: 0 },
    skippedCount: { companies: 0, orders: 0, roleAssignments: 0 },
    skippedReasons: [],
    deletedCount: { companies: 0, orders: 0 },
    failedCount: { companies: 0, locations: 0, orders: 0, roleAssignments: 0, dbRows: 0, customers: 0 },
    ordersWithShopifyTerms: 0,
    ordersWithoutShopifyTerms: 0,
    overdueOrdersCount: 0,
    taggedCustomerOrdersCount: 0,
    errors: [],
  };

  console.log(`\nShop: [configured]`);
  const modeStr = reportDuplicatesMode ? "REPORT DUPLICATES (read-only)" 
    : reseedHeldCurrencyMode ? (dryRun ? "RESEED HELD CURRENCY (dry-run)" : "RESEED HELD CURRENCY")
    : dryRun ? "DRY RUN (read-only lookups, no mutations)" 
    : reset ? (resetApply ? "RESET + APPLY (will delete)" : "RESET (dry-run, use --apply to delete)") 
    : "SEED";
  console.log(`Mode: ${modeStr}`);
  if (reviewerDemo) {
    console.log(`Reviewer Demo: ENABLED (--reviewer-demo or SEED_REVIEWER_DEMO=1)`);
  }
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

  // Report duplicates mode (read-only)
  if (reportDuplicatesMode) {
    await reportDuplicates(state);
    console.log("\n✅ Duplicate report complete!");
    process.exit(0);
  }

  // Held fixtures currency re-seed (in-place metafield update only, then exit)
  if (reseedHeldCurrencyMode) {
    const ok = await runReseedHeldCurrency(state);
    process.exit(ok ? 0 : 1);
  }

  // Reset if requested
  if (reset) {
    const resetOk = await resetSeedData(state);
    if (!resetOk) {
      // Verification failed or DB errors occurred
      process.exit(1);
    }
    // If --reset without --apply, exit after discovery (don't fall through to seeding)
    if (!resetApply || dryRun) {
      process.exit(0);
    }
    // --reset --apply succeeded, continue to seeding
  }

  // Migrate legacy fixture customer emails (idempotent)
  await migrateCustomerEmails(state);

  // Seed Shopify data
  await seedCompanies(state);
  await seedOrders(state);
  
  // Seed orders for tagged (non-B2B) customers
  await seedTaggedCustomerOrders(state);

  // Seed reviewer demo company and orders (opt-in via --reviewer-demo or SEED_REVIEWER_DEMO=1)
  if (state.reviewerDemo) {
    await seedReviewerDemoCompany(state);
  }

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

  console.log("\n  Shopify Results:");
  console.log("    Created:");
  console.log(`      Companies:        ${state.createdCount.companies}`);
  console.log(`      Locations:        ${state.createdCount.locations}`);
  console.log(`      Role assignments: ${state.createdCount.roleAssignments}`);
  console.log(`      Orders:           ${state.createdCount.orders}`);

  if (state.updatedCount.customers > 0) {
    console.log("    Updated:");
    console.log(`      Customers:        ${state.updatedCount.customers}`);
  }

  if (state.adoptedCount.companies > 0) {
    console.log("    Adopted (existing company, externalId set):");
    console.log(`      Companies:        ${state.adoptedCount.companies}`);
  }

  const hasUnchanged = state.unchangedCount.companies > 0 || state.unchangedCount.locations > 0 ||
                       state.unchangedCount.orders > 0 || state.unchangedCount.roleAssignments > 0 ||
                       state.unchangedCount.customers > 0;
  if (hasUnchanged) {
    console.log("    Unchanged:");
    console.log(`      Companies:        ${state.unchangedCount.companies}`);
    console.log(`      Locations:        ${state.unchangedCount.locations}`);
    console.log(`      Role assignments: ${state.unchangedCount.roleAssignments}`);
    console.log(`      Orders:           ${state.unchangedCount.orders}`);
    console.log(`      Customers:        ${state.unchangedCount.customers}`);
  }

  if (state.driftedCount.companies > 0) {
    console.log("    Drifted (not modified, run --reset to recreate):");
    console.log(`      Companies:        ${state.driftedCount.companies}`);
  }

  if (state.deletedCount.companies > 0 || state.deletedCount.orders > 0) {
    console.log("    Deleted:");
    console.log(`      Companies:        ${state.deletedCount.companies}`);
    console.log(`      Orders:           ${state.deletedCount.orders}`);
  }

  const hasSkipped = state.skippedCount.companies > 0 || state.skippedCount.orders > 0 ||
                      state.skippedCount.roleAssignments > 0;
  if (hasSkipped) {
    console.log("    Skipped (ambiguous or missing prerequisites):");
    if (state.skippedCount.companies > 0) console.log(`      Companies:        ${state.skippedCount.companies}`);
    if (state.skippedCount.roleAssignments > 0) console.log(`      Role assignments: ${state.skippedCount.roleAssignments}`);
    if (state.skippedCount.orders > 0) console.log(`      Orders:           ${state.skippedCount.orders}`);
    if (state.skippedReasons.length > 0) {
      console.log("    Skip reasons:");
      for (const reason of state.skippedReasons) {
        console.log(`      - ${reason}`);
      }
    }
  }

  // Always print explicit failed counts for every category
  const totalFailures = state.failedCount.companies + state.failedCount.locations + 
                        state.failedCount.orders + state.failedCount.roleAssignments + 
                        state.failedCount.dbRows + state.failedCount.customers;
  console.log("    Failed:");
  console.log(`      Companies:        ${state.failedCount.companies}`);
  console.log(`      Locations:        ${state.failedCount.locations}`);
  console.log(`      Role assignments: ${state.failedCount.roleAssignments}`);
  console.log(`      Orders:           ${state.failedCount.orders}`);
  console.log(`      Customers:        ${state.failedCount.customers}`);
  console.log(`      DB rows:          ${state.failedCount.dbRows}`);

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
  const exitCode = computeExitCode(state);
  if (exitCode !== 0) {
    console.log(`\n❌ Seed completed with ${totalFailures} failure(s) and ${state.errors.length} error(s)`);
    process.exit(exitCode);
  }

  console.log("\n✅ Seed complete!");
}

/**
 * Compute the exit code for the seed script based on failure counts.
 * Returns 1 if any failures or errors occurred, 0 otherwise.
 * 
 * This is the single source of truth for the exit decision - main() calls this.
 */
export function computeExitCode(state: SeedState): number {
  const totalFailures = state.failedCount.companies + state.failedCount.locations + 
                        state.failedCount.orders + state.failedCount.roleAssignments + 
                        state.failedCount.dbRows + state.failedCount.customers;
  return (totalFailures > 0 || state.errors.length > 0) ? 1 : 0;
}

/**
 * Format a fatal error for logging without exposing message/stack.
 * Only returns the error type (constructor name or typeof).
 */
export function formatFatal(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}

// Only run main() when executed directly (not when imported for testing)
const isMainModule = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error(`\n❌ Fatal error: [${formatFatal(err)}]`);
    process.exit(1);
  });
}
