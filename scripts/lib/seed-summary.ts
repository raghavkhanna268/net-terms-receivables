/**
 * Seed summary counting helpers.
 * 
 * Provides functions to verify seed counts against actual DB state,
 * ensuring summary output reflects real results rather than operation counters.
 * 
 * @see https://github.com/raghavkhanna268/net-terms-receivables/issues/71
 */

import type { Sql } from "~/lib/db-light.server";

/**
 * Result of a DB upsert operation with create/update detection.
 * Uses xmax to determine if row was created (xmax=0) or updated (xmax>0).
 */
export interface UpsertResult {
  id: string;
  wasCreated: boolean;
}

/**
 * Tracks what was actually written to the DB during seeding.
 * Populated during seedDatabase() to enable accurate count verification.
 */
export interface SeedDbWriteTracker {
  shopId: string | null;
  tags: Set<string>;
  companyLocationIds: Set<string>;
  createdAccountSources: number;
  updatedAccountSources: number;
  createdBuyerAccounts: number;
  updatedBuyerAccounts: number;
}

/**
 * Create a new write tracker for a seed run.
 */
export function createSeedDbWriteTracker(): SeedDbWriteTracker {
  return {
    shopId: null,
    tags: new Set(),
    companyLocationIds: new Set(),
    createdAccountSources: 0,
    updatedAccountSources: 0,
    createdBuyerAccounts: 0,
    updatedBuyerAccounts: 0,
  };
}

/**
 * Counts of seed-created DB rows, scoped to specific shop and keys.
 */
export interface SeedDbCounts {
  shopExists: boolean;
  accountSourceCount: number;
  buyerAccountCount: number;
}

/**
 * Query actual DB row counts for records written by this seed run.
 * 
 * Uses the actual shopId and specific tags/companyLocationIds that were
 * written during seeding, rather than prefix matching. This handles cases
 * where existing rows have non-seed IDs but match on conflict keys.
 * 
 * @param sql - postgres.js connection
 * @param tracker - The write tracker populated during seeding
 * @returns Actual DB counts for seed-written rows
 */
export async function getSeedDbCounts(
  sql: Sql,
  tracker: SeedDbWriteTracker
): Promise<SeedDbCounts> {
  if (!tracker.shopId) {
    return { shopExists: false, accountSourceCount: 0, buyerAccountCount: 0 };
  }
  
  // Check if shop exists
  const shopResult = await sql`
    SELECT COUNT(*)::int as count
    FROM "Shop"
    WHERE id = ${tracker.shopId}
  `;
  const shopExists = (shopResult[0]?.count ?? 0) > 0;
  
  if (!shopExists) {
    return { shopExists: false, accountSourceCount: 0, buyerAccountCount: 0 };
  }
  
  // Count AccountSource rows by exact (shopId, tag) keys we wrote
  const tags = Array.from(tracker.tags);
  let accountSourceCount = 0;
  if (tags.length > 0) {
    const accountSourceResult = await sql`
      SELECT COUNT(*)::int as count
      FROM "AccountSource"
      WHERE "shopId" = ${tracker.shopId}
        AND tag IN ${sql(tags)}
    `;
    accountSourceCount = accountSourceResult[0]?.count ?? 0;
  }
  
  // Count BuyerAccount rows by exact (shopId, companyLocationId) keys we wrote
  const locationIds = Array.from(tracker.companyLocationIds);
  let buyerAccountCount = 0;
  if (locationIds.length > 0) {
    const buyerAccountResult = await sql`
      SELECT COUNT(*)::int as count
      FROM "BuyerAccount"
      WHERE "shopId" = ${tracker.shopId}
        AND "companyLocationId" IN ${sql(locationIds)}
    `;
    buyerAccountCount = buyerAccountResult[0]?.count ?? 0;
  }
  
  return {
    shopExists,
    accountSourceCount,
    buyerAccountCount,
  };
}

/**
 * Summary of what seedDatabase actually did, derived from RETURNING xmax.
 */
export interface SeedDbSummary {
  accountSourcesCreated: number;
  accountSourcesUpdated: number;
  buyerAccountsCreated: number;
  buyerAccountsUpdated: number;
  totalAccountSources: number;
  totalBuyerAccounts: number;
}

/**
 * Get summary from write tracker.
 */
export function getSeedDbSummary(tracker: SeedDbWriteTracker): SeedDbSummary {
  return {
    accountSourcesCreated: tracker.createdAccountSources,
    accountSourcesUpdated: tracker.updatedAccountSources,
    buyerAccountsCreated: tracker.createdBuyerAccounts,
    buyerAccountsUpdated: tracker.updatedBuyerAccounts,
    totalAccountSources: tracker.createdAccountSources + tracker.updatedAccountSources,
    totalBuyerAccounts: tracker.createdBuyerAccounts + tracker.updatedBuyerAccounts,
  };
}

/**
 * Patterns that indicate PII in output.
 * Used to verify summary output contains no sensitive information.
 */
export const PII_PATTERNS = {
  email: /@/,
  shopifyDomain: /\.myshopify\.com/i,
  currencyAmount: /(?:INR|USD|EUR|GBP|AUD|CAD|JPY|CNY)\s*\d+(?:,\d{3})*(?:\.\d{2})?/i,
} as const;

/**
 * Check if output contains PII.
 * 
 * @param output - Console output to check
 * @returns Object with hasPii boolean and matched patterns
 */
export function checkOutputForPii(output: string): {
  hasPii: boolean;
  matches: { pattern: keyof typeof PII_PATTERNS; match: string }[];
} {
  const matches: { pattern: keyof typeof PII_PATTERNS; match: string }[] = [];
  
  for (const [name, regex] of Object.entries(PII_PATTERNS)) {
    const match = output.match(regex);
    if (match) {
      matches.push({ pattern: name as keyof typeof PII_PATTERNS, match: match[0] });
    }
  }
  
  return {
    hasPii: matches.length > 0,
    matches,
  };
}
