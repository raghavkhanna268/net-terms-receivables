/**
 * Invoice Eligibility Logic (S9 Refs)
 *
 * Determines whether a Shopify order should become an Invoice in our system.
 * This is the single source of truth for eligibility, used by:
 * - Order webhooks (orders/create, orders/updated)
 * - Drain handler (re-fetch processing)
 * - Bulk operation parser (S10b reconcile)
 *
 * An order becomes an Invoice when:
 * 1. displayFinancialStatus is in (PENDING, PARTIALLY_PAID, AUTHORIZED)
 *    - Never PAID, REFUNDED, VOIDED, etc. (those update existing invoices)
 * 2. AND any of:
 *    a) Order has Shopify paymentTerms
 *    b) purchasingEntity is a Company whose CompanyLocation maps to an active
 *       BuyerAccount with explicit defaultTermsDays
 *    c) Customer matches a configured tag rule (AccountSource)
 *
 * Due dates use S9 inference (app/lib/due-date.ts) with precedence:
 * schedule > override > accountDefault > tagRule > shopDefault > none
 */

import type { Sql } from "~/lib/db-light.server";
import type { ShopifyOrder } from "~/services/sync/types";
import { activeAccountFragment } from "~/services/gating.server";
import {
  inferDueDate,
  type InferDueDateInput,
  type InferDueDateResult,
  type TagRule,
} from "./due-date";

/**
 * Financial statuses that qualify an order for Invoice creation.
 * Orders with these statuses can become new Invoices.
 */
export const ELIGIBLE_FINANCIAL_STATUSES = [
  "PENDING",
  "PARTIALLY_PAID",
  "AUTHORIZED",
] as const;

export type EligibleFinancialStatus = (typeof ELIGIBLE_FINANCIAL_STATUSES)[number];

/**
 * Financial statuses that indicate an order should update an existing Invoice.
 * These never create new Invoices but may update status to paid/cancelled.
 */
export const TERMINAL_FINANCIAL_STATUSES = [
  "PAID",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "VOIDED",
] as const;

export type TerminalFinancialStatus = (typeof TERMINAL_FINANCIAL_STATUSES)[number];

/**
 * Eligibility reason codes for tracking how an order qualified.
 */
export type EligibilityReason =
  | "shopify_payment_terms"      // (a) Order has Shopify paymentTerms
  | "company_account_terms"      // (b) CompanyLocation has active account with terms
  | "tagged_customer"            // (c) Customer matches a tag rule
  | "ineligible_status"          // Financial status not in eligible list
  | "terminal_status"            // Financial status indicates paid/refunded
  | "no_buyer_account"           // No matching buyer account found
  | "retail_order";              // None of (a), (b), (c) matched

/**
 * Result of checking order eligibility for Invoice creation.
 */
export interface EligibilityResult {
  /** Whether the order should become an Invoice */
  eligible: boolean;
  /** Why the order is eligible or ineligible */
  reason: EligibilityReason;
  /** Human-readable explanation */
  explanation: string;
  /**
   * Whether this ineligible result is retryable.
   * true = transient failure (no_buyer_account) - retry may succeed later
   * false/undefined = permanent (retail, ineligible status) - skip
   */
  retryable?: boolean;
  /** Buyer account ID if found (for eligible orders) */
  buyerAccountId?: string;
  /** For eligible orders, the due date inference result */
  dueDate?: InferDueDateResult;
  /** Account's default terms days (for conditions b/c) */
  accountDefaultTermsDays?: number;
  /** Source of account default terms */
  accountDefaultTermsSource?: "explicit" | "tag" | null;
  /** Matched tag rule (for condition c) */
  matchedTagRule?: TagRule;
  /** Customer tags from the order */
  customerTags?: string[];
}

/**
 * Data needed for eligibility check, fetched from database.
 */
export interface EligibilityContext {
  shopId: string;
  shopTimezone: string;
  shopDefaultTermsDays: number | null;
  tagRules: TagRule[];
}

/**
 * Check if a financial status is eligible for Invoice creation.
 */
export function isEligibleFinancialStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return (ELIGIBLE_FINANCIAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Check if a financial status indicates a terminal state (paid/refunded).
 */
export function isTerminalFinancialStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return (TERMINAL_FINANCIAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Fetch the eligibility context for a shop.
 * Call once per shop and reuse for multiple orders.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Internal shop ID
 */
export async function getEligibilityContext(
  sql: Sql,
  shopId: string
): Promise<EligibilityContext | null> {
  const [shop] = await sql<{
    id: string;
    timezone: string;
    defaultTermsDays: number | null;
  }[]>`
    SELECT id, timezone, "defaultTermsDays"
    FROM "Shop"
    WHERE id = ${shopId}
  `;

  if (!shop) return null;

  const tagRules = await sql<{ tag: string; defaultTermsDays: number }[]>`
    SELECT tag, "defaultTermsDays"
    FROM "AccountSource"
    WHERE "shopId" = ${shopId}
  `;

  return {
    shopId: shop.id,
    shopTimezone: shop.timezone,
    shopDefaultTermsDays: shop.defaultTermsDays,
    tagRules: tagRules.map((r) => ({
      tag: r.tag,
      defaultTermsDays: r.defaultTermsDays,
    })),
  };
}

/**
 * Fetch eligibility context by shop domain.
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain (e.g., "example.myshopify.com")
 */
export async function getEligibilityContextByDomain(
  sql: Sql,
  shopDomain: string
): Promise<{ context: EligibilityContext; shopId: string } | null> {
  const [shop] = await sql<{
    id: string;
    timezone: string;
    defaultTermsDays: number | null;
  }[]>`
    SELECT id, timezone, "defaultTermsDays"
    FROM "Shop"
    WHERE domain = ${shopDomain}
  `;

  if (!shop) return null;

  const tagRules = await sql<{ tag: string; defaultTermsDays: number }[]>`
    SELECT tag, "defaultTermsDays"
    FROM "AccountSource"
    WHERE "shopId" = ${shop.id}
  `;

  return {
    shopId: shop.id,
    context: {
      shopId: shop.id,
      shopTimezone: shop.timezone,
      shopDefaultTermsDays: shop.defaultTermsDays,
      tagRules: tagRules.map((r) => ({
        tag: r.tag,
        defaultTermsDays: r.defaultTermsDays,
      })),
    },
  };
}

/**
 * Result of looking up a BuyerAccount by CompanyLocation.
 */
type CompanyAccountLookupResult =
  | { found: false; reason: "no_account" }
  | { found: false; reason: "no_explicit_terms"; accountId: string }
  | {
      found: true;
      accountId: string;
      defaultTermsDays: number;
      defaultTermsSource: "explicit" | "tag" | null;
    };

/**
 * Find a buyer account by CompanyLocation for condition (b).
 * Returns a discriminated result to distinguish:
 * - No account exists (location not synced yet) → retryable
 * - Account exists but no explicit terms → permanent skip (retail)
 * - Account exists with explicit terms → eligible
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Internal shop ID
 * @param companyLocationId - Shopify CompanyLocation GID
 */
async function findCompanyAccountWithTerms(
  sql: Sql,
  shopId: string,
  companyLocationId: string
): Promise<CompanyAccountLookupResult> {
  const [account] = await sql<{
    id: string;
    defaultTermsDays: number | null;
    defaultTermsSource: string | null;
  }[]>`
    SELECT id, "defaultTermsDays", "defaultTermsSource"
    FROM "BuyerAccount"
    WHERE "shopId" = ${shopId}
      AND "companyLocationId" = ${companyLocationId}
      AND ${activeAccountFragment(sql)}
  `;

  if (!account) {
    return { found: false, reason: "no_account" };
  }

  if (
    account.defaultTermsDays === null ||
    account.defaultTermsSource !== "explicit"
  ) {
    return { found: false, reason: "no_explicit_terms", accountId: account.id };
  }

  return {
    found: true,
    accountId: account.id,
    defaultTermsDays: account.defaultTermsDays,
    defaultTermsSource: account.defaultTermsSource as "explicit" | "tag" | null,
  };
}

/**
 * Find a buyer account by Company (any location) for condition (b) fallback.
 * Only returns a result if there is EXACTLY ONE active account with explicit terms
 * for this company. If there are multiple, returns null to avoid ambiguity
 * (different locations may have different terms/credit limits).
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Internal shop ID
 * @param companyId - Shopify Company GID
 */
async function findCompanyAccountByCompanyWithTerms(
  sql: Sql,
  shopId: string,
  companyId: string
): Promise<{
  id: string;
  defaultTermsDays: number;
  defaultTermsSource: "explicit" | "tag" | null;
} | null> {
  // Query for ALL active accounts with explicit terms for this company
  const accounts = await sql<{
    id: string;
    defaultTermsDays: number | null;
    defaultTermsSource: string | null;
  }[]>`
    SELECT id, "defaultTermsDays", "defaultTermsSource"
    FROM "BuyerAccount"
    WHERE "shopId" = ${shopId}
      AND "companyId" = ${companyId}
      AND "defaultTermsDays" IS NOT NULL
      AND "defaultTermsSource" = 'explicit'
      AND ${activeAccountFragment(sql)}
    ORDER BY id
  `;

  // Only use fallback if exactly one account exists (no ambiguity)
  if (accounts.length !== 1) return null;

  const account = accounts[0];
  return {
    id: account.id,
    defaultTermsDays: account.defaultTermsDays!,
    defaultTermsSource: account.defaultTermsSource as "explicit" | "tag" | null,
  };
}

/**
 * Find a buyer account by Customer for condition (b) or (c).
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Internal shop ID
 * @param customerId - Shopify Customer GID
 */
async function findCustomerAccount(
  sql: Sql,
  shopId: string,
  customerId: string
): Promise<{
  id: string;
  defaultTermsDays: number | null;
  defaultTermsSource: "explicit" | "tag" | null;
} | null> {
  const [account] = await sql<{
    id: string;
    defaultTermsDays: number | null;
    defaultTermsSource: string | null;
  }[]>`
    SELECT id, "defaultTermsDays", "defaultTermsSource"
    FROM "BuyerAccount"
    WHERE "shopId" = ${shopId}
      AND "customerId" = ${customerId}
      AND ${activeAccountFragment(sql)}
  `;

  if (!account) return null;

  return {
    id: account.id,
    defaultTermsDays: account.defaultTermsDays,
    defaultTermsSource: account.defaultTermsSource as "explicit" | "tag" | null,
  };
}

/**
 * Get customer tags from s8_tagged_customers table.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Internal shop ID
 * @param customerId - Shopify Customer GID
 */
async function getCustomerTags(
  sql: Sql,
  shopId: string,
  customerId: string
): Promise<string[]> {
  const [row] = await sql<{ tags: string[] }[]>`
    SELECT tags
    FROM s8_tagged_customers
    WHERE shop_id = ${shopId}
      AND customer_id = ${customerId}
      AND tag_active = true
  `;

  return row?.tags ?? [];
}

/**
 * Check if a tag rule matches any customer tags.
 */
function findMatchingTagRule(
  customerTags: string[],
  tagRules: TagRule[]
): TagRule | undefined {
  if (customerTags.length === 0 || tagRules.length === 0) return undefined;

  const normalizedTags = customerTags.map((t) => t.toLowerCase().trim());

  return tagRules.find((rule) =>
    normalizedTags.includes(rule.tag.toLowerCase().trim())
  );
}

/**
 * Compute due date using S9 inference.
 */
function computeDueDate(
  order: ShopifyOrder,
  context: EligibilityContext,
  accountDefaultTermsDays: number | null,
  accountDefaultTermsSource: "explicit" | "tag" | null,
  customerTags: string[]
): InferDueDateResult {
  const input: InferDueDateInput = {
    paymentTerms: order.paymentTerms
      ? {
          type: order.paymentTerms.paymentTermsType as "NET" | "FIXED" | "FULFILLMENT" | "RECEIPT",
          dueInDays: order.paymentTerms.dueInDays ?? null,
          schedules:
            order.paymentTerms.paymentSchedules?.edges.map((e) => ({
              dueAt: e.node.dueAt ? new Date(e.node.dueAt) : null,
              completedAt: e.node.completedAt ? new Date(e.node.completedAt) : null,
            })) ?? [],
        }
      : null,
    orderCreatedAt: new Date(order.processedAt ?? order.createdAt),
    fulfilledAt: null, // TODO: Get from order if needed for FULFILLMENT terms
    accountDefaultTermsDays,
    accountDefaultTermsSource,
    tagRules: context.tagRules,
    customerTags,
    shopDefaultTermsDays: context.shopDefaultTermsDays,
    merchantOverrideDueAt: null,
    shopTimezone: context.shopTimezone,
  };

  return inferDueDate(input);
}

/**
 * Check if an order is eligible to become an Invoice.
 *
 * This is the main eligibility check function. Call it for every order
 * to determine if it should create/update an Invoice.
 *
 * @param sql - postgres.js SQL client
 * @param order - Shopify order data
 * @param context - Eligibility context (from getEligibilityContext)
 */
export async function checkOrderEligibility(
  sql: Sql,
  order: ShopifyOrder,
  context: EligibilityContext
): Promise<EligibilityResult> {
  const { shopId, tagRules } = context;
  const status = order.displayFinancialStatus;

  // Check for terminal status first (paid/refunded orders update existing invoices)
  if (isTerminalFinancialStatus(status)) {
    return {
      eligible: false,
      reason: "terminal_status",
      explanation: `Order has terminal status '${status}' - updates existing Invoice if present`,
    };
  }

  // Check for eligible financial status
  if (!isEligibleFinancialStatus(status)) {
    return {
      eligible: false,
      reason: "ineligible_status",
      explanation: `Order has status '${status ?? "null"}' - not eligible (requires PENDING, PARTIALLY_PAID, or AUTHORIZED)`,
    };
  }

  // Condition (a): Order has Shopify paymentTerms
  if (order.paymentTerms) {
    // Still need to find a buyer account for the invoice
    const buyerAccountId = await resolveBuyerAccount(sql, shopId, order);

    if (!buyerAccountId) {
      return {
        eligible: false,
        reason: "no_buyer_account",
        explanation: "Order has payment terms but no matching BuyerAccount found",
        retryable: true,
      };
    }

    // Get account details for due date calculation
    const [account] = await sql<{
      defaultTermsDays: number | null;
      defaultTermsSource: string | null;
    }[]>`
      SELECT "defaultTermsDays", "defaultTermsSource"
      FROM "BuyerAccount"
      WHERE id = ${buyerAccountId}
    `;

    const customerTags = order.customer?.id
      ? await getCustomerTags(sql, shopId, order.customer.id)
      : [];

    const dueDate = computeDueDate(
      order,
      context,
      account?.defaultTermsDays ?? null,
      account?.defaultTermsSource as "explicit" | "tag" | null,
      customerTags
    );

    return {
      eligible: true,
      reason: "shopify_payment_terms",
      explanation: `Order has Shopify payment terms: ${order.paymentTerms.paymentTermsName}`,
      buyerAccountId,
      dueDate,
      accountDefaultTermsDays: account?.defaultTermsDays ?? undefined,
      accountDefaultTermsSource: account?.defaultTermsSource as "explicit" | "tag" | null,
      customerTags,
    };
  }

  // Condition (b): purchasingEntity is a Company with active account having explicit terms
  const purchasingEntity = order.purchasingEntity;

  // Track if we found a B2B location that hasn't synced yet (for retryable failure)
  let unsyncedB2BLocation = false;

  if (purchasingEntity?.location?.id) {
    // Condition (b): CompanyLocation has active account with explicit terms
    const accountResult = await findCompanyAccountWithTerms(
      sql,
      shopId,
      purchasingEntity.location.id
    );

    if (accountResult.found) {
      // Account exists with explicit terms - eligible
      const dueDate = computeDueDate(
        order,
        context,
        accountResult.defaultTermsDays,
        accountResult.defaultTermsSource,
        []
      );

      return {
        eligible: true,
        reason: "company_account_terms",
        explanation: `CompanyLocation account has explicit default terms: Net ${accountResult.defaultTermsDays} days`,
        buyerAccountId: accountResult.accountId,
        dueDate,
        accountDefaultTermsDays: accountResult.defaultTermsDays,
        accountDefaultTermsSource: accountResult.defaultTermsSource,
      };
    } else if (accountResult.reason === "no_account") {
      // Location exists but no BuyerAccount yet - track for potential retryable failure
      unsyncedB2BLocation = true;
    }
    // If reason === "no_explicit_terms", account exists but no explicit terms
    // This is a permanent condition (not retryable), continue to check tag rules
    // Do NOT fall back to company level (that would leak another location's terms/credit)
  } else if (purchasingEntity?.company?.id) {
    // No location but has company - try company-wide fallback (only if exactly one account)
    const companyAccount = await findCompanyAccountByCompanyWithTerms(
      sql,
      shopId,
      purchasingEntity.company.id
    );

    if (companyAccount && companyAccount.defaultTermsSource === "explicit") {
      const dueDate = computeDueDate(
        order,
        context,
        companyAccount.defaultTermsDays,
        companyAccount.defaultTermsSource,
        []
      );

      return {
        eligible: true,
        reason: "company_account_terms",
        explanation: `Company account has explicit default terms: Net ${companyAccount.defaultTermsDays} days (single location)`,
        buyerAccountId: companyAccount.id,
        dueDate,
        accountDefaultTermsDays: companyAccount.defaultTermsDays,
        accountDefaultTermsSource: companyAccount.defaultTermsSource,
      };
    }
  }

  // Condition (c): Customer matches a configured tag rule
  if (order.customer?.id) {
    const customerTags = await getCustomerTags(sql, shopId, order.customer.id);
    const matchedRule = findMatchingTagRule(customerTags, tagRules);

    if (matchedRule) {
      // Find or check for existing customer account
      const customerAccount = await findCustomerAccount(
        sql,
        shopId,
        order.customer.id
      );

      if (customerAccount) {
        const dueDate = computeDueDate(
          order,
          context,
          customerAccount.defaultTermsDays,
          customerAccount.defaultTermsSource,
          customerTags
        );

        return {
          eligible: true,
          reason: "tagged_customer",
          explanation: `Customer matches tag rule '${matchedRule.tag}': Net ${matchedRule.defaultTermsDays} days`,
          buyerAccountId: customerAccount.id,
          dueDate,
          accountDefaultTermsDays: customerAccount.defaultTermsDays ?? matchedRule.defaultTermsDays,
          accountDefaultTermsSource: customerAccount.defaultTermsSource,
          matchedTagRule: matchedRule,
          customerTags,
        };
      }

      // Customer matches tag rule but no BuyerAccount exists yet
      // This shouldn't happen if customer sync is working, but handle gracefully
      // Return retryable so the order can be processed once customer is synced
      return {
        eligible: false,
        reason: "no_buyer_account",
        explanation: `Customer matches tag rule '${matchedRule.tag}' but no BuyerAccount found - customer may not be synced yet`,
        retryable: true,
        matchedTagRule: matchedRule,
        customerTags,
      };
    }
  }

  // None of the conditions matched
  // If this was a B2B order (has location) but no account synced yet, return retryable
  if (unsyncedB2BLocation) {
    return {
      eligible: false,
      reason: "no_buyer_account",
      explanation: "CompanyLocation exists but no BuyerAccount synced yet - company may not be synced",
      retryable: true,
    };
  }

  // Otherwise this is a retail order (permanent skip)
  return {
    eligible: false,
    reason: "retail_order",
    explanation: "Retail order: no payment terms, no company account with explicit terms, and customer does not match any tag rule",
  };
}

/**
 * Resolve buyer account from order (for orders with Shopify paymentTerms).
 * Uses the same resolution order as the original order.server.ts.
 */
async function resolveBuyerAccount(
  sql: Sql,
  shopId: string,
  order: ShopifyOrder
): Promise<string | null> {
  const purchasingEntity = order.purchasingEntity;

  // Try CompanyLocation first (most specific)
  if (purchasingEntity?.location?.id) {
    const [account] = await sql<{ id: string }[]>`
      SELECT id FROM "BuyerAccount"
      WHERE "shopId" = ${shopId}
        AND "companyLocationId" = ${purchasingEntity.location.id}
        AND ${activeAccountFragment(sql)}
    `;
    if (account) return account.id;
  }

  // Try Company (any location for that company)
  if (purchasingEntity?.company?.id) {
    const [account] = await sql<{ id: string }[]>`
      SELECT id FROM "BuyerAccount"
      WHERE "shopId" = ${shopId}
        AND "companyId" = ${purchasingEntity.company.id}
        AND ${activeAccountFragment(sql)}
      LIMIT 1
    `;
    if (account) return account.id;
  }

  // Try customer (for tagged customers)
  if (order.customer?.id) {
    const [account] = await sql<{ id: string }[]>`
      SELECT id FROM "BuyerAccount"
      WHERE "shopId" = ${shopId}
        AND "customerId" = ${order.customer.id}
        AND ${activeAccountFragment(sql)}
    `;
    if (account) return account.id;
  }

  return null;
}

/**
 * Check eligibility for a batch of orders (for bulk processing).
 * More efficient than calling checkOrderEligibility for each order individually.
 *
 * @param sql - postgres.js SQL client
 * @param orders - Array of Shopify orders
 * @param context - Eligibility context
 */
export async function checkOrdersEligibility(
  sql: Sql,
  orders: ShopifyOrder[],
  context: EligibilityContext
): Promise<Map<string, EligibilityResult>> {
  const results = new Map<string, EligibilityResult>();

  for (const order of orders) {
    const result = await checkOrderEligibility(sql, order, context);
    results.set(order.id, result);
  }

  return results;
}
