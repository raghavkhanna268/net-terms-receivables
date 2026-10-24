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
 * Counts of seed-created DB rows, scoped to a specific shop.
 */
export interface SeedDbCounts {
  shopExists: boolean;
  accountSourceCount: number;
  buyerAccountCount: number;
}

/**
 * Query actual DB row counts for seed-created records.
 * 
 * Counts are scoped to the seed's shop ID pattern (seed-shop-*).
 * Only counts rows with seed-prefixed IDs to avoid counting
 * non-seed data.
 * 
 * @param sql - postgres.js connection
 * @param shopDomain - The shop domain used for seeding
 * @returns Actual DB counts for seed-created rows
 */
export async function getSeedDbCounts(
  sql: Sql,
  shopDomain: string
): Promise<SeedDbCounts> {
  const shopId = `seed-shop-${shopDomain}`;
  
  // Check if shop exists
  const shopResult = await sql`
    SELECT COUNT(*)::int as count
    FROM "Shop"
    WHERE id = ${shopId}
  `;
  const shopExists = (shopResult[0]?.count ?? 0) > 0;
  
  if (!shopExists) {
    return { shopExists: false, accountSourceCount: 0, buyerAccountCount: 0 };
  }
  
  // Count AccountSource rows with seed prefix
  const accountSourceResult = await sql`
    SELECT COUNT(*)::int as count
    FROM "AccountSource"
    WHERE "shopId" = ${shopId}
      AND id LIKE 'seed-source-%'
  `;
  const accountSourceCount = accountSourceResult[0]?.count ?? 0;
  
  // Count BuyerAccount rows with seed prefix
  const buyerAccountResult = await sql`
    SELECT COUNT(*)::int as count
    FROM "BuyerAccount"
    WHERE "shopId" = ${shopId}
      AND id LIKE 'seed-account-%'
  `;
  const buyerAccountCount = buyerAccountResult[0]?.count ?? 0;
  
  return {
    shopExists,
    accountSourceCount,
    buyerAccountCount,
  };
}

/**
 * Verify that reported counts match actual DB state.
 * 
 * Returns a verification result with any discrepancies.
 * 
 * @param reportedRules - Count of rules reported by seed
 * @param reportedAccounts - Count of accounts reported by seed
 * @param actualCounts - Actual DB counts from getSeedDbCounts
 * @returns Verification result with discrepancies if any
 */
export function verifySeedCounts(
  reportedRules: number,
  reportedAccounts: number,
  actualCounts: SeedDbCounts
): { valid: boolean; discrepancies: string[] } {
  const discrepancies: string[] = [];
  
  if (!actualCounts.shopExists) {
    discrepancies.push("Shop record not found in database");
    return { valid: false, discrepancies };
  }
  
  if (reportedRules !== actualCounts.accountSourceCount) {
    discrepancies.push(
      `AccountSource mismatch: reported ${reportedRules}, actual ${actualCounts.accountSourceCount}`
    );
  }
  
  if (reportedAccounts !== actualCounts.buyerAccountCount) {
    discrepancies.push(
      `BuyerAccount mismatch: reported ${reportedAccounts}, actual ${actualCounts.buyerAccountCount}`
    );
  }
  
  return {
    valid: discrepancies.length === 0,
    discrepancies,
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
