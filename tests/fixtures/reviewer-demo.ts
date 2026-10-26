/**
 * Test fixture data for reviewer demo CSV scoring tests.
 *
 * This module defines synthetic invoice/buyer data for testing the scorer
 * against the reviewer CSV (hdfc-review-synthetic.csv). These are HYPOTHETICAL
 * invoices used in unit tests - the actual Shopify orders are created by
 * scripts/seed.ts with its own constants (gated behind --reviewer-demo flag).
 *
 * All data is FICTIONAL - no real company names, domains, or identifiers.
 * The buyer name "Test Buyer Co" matches the payer text in the review CSV.
 *
 * Order names #1001 and #1002 are set explicitly via OrderCreateOrderInput.name.
 *
 * Amount window for candidate filtering in the app:
 * - MIN_FACTOR = 0.5x payment amount
 * - MAX_FACTOR = 2.0x payment amount
 *
 * CSV amounts (v3): Row 1 = ₹10,000, Row 2 = ₹5,000, Row 3 = ₹2,500
 */

import type { InvoiceForScoring, BuyerForScoring } from "~/lib/matching/score.js";

/**
 * Hypothetical buyer data for scoring tests.
 * Matches the "TEST BUYER CO" payer text in the review CSV.
 */
export const REVIEWER_DEMO_BUYER = {
  id: "buyer-reviewer-demo",
  name: "Test Buyer Co",
  email: "demo.reviewer@test-buyer.example",
} as const;

/**
 * Hypothetical invoice amounts for scoring tests.
 * These match the amounts that scripts/seed.ts creates.
 *
 * Amount selection rationale:
 * - ₹10,000: Exact match for CSV row 1
 * - ₹5,000: Exact match for CSV row 2, partial match for row 3
 *
 * Row 1 (₹10,000): Exact match to #1001 (₹10,000)
 * Row 2 (₹5,000): Exact match to #1002 (₹5,000)
 * Row 3 (₹2,500): Partial payment against #1002 (₹5,000)
 */
export const REVIEWER_DEMO_AMOUNTS = {
  order1: 10000, // ₹10,000 - exact match for row 1
  order2: 5000, // ₹5,000 - exact match for row 2, in window for row 3
} as const;

/**
 * Build BuyerForScoring for scoring tests.
 *
 * IMPORTANT: The app path has NO pre-seeded aliases because aliases
 * are only learned when a merchant confirms a match. A fresh store
 * will have empty aliases.
 *
 * @param withAliases - If true, include aliases (for unit-level scoring tests)
 */
export function buildReviewerDemoBuyer(withAliases = false): BuyerForScoring {
  return {
    id: REVIEWER_DEMO_BUYER.id,
    name: REVIEWER_DEMO_BUYER.name,
    aliases: withAliases ? ["test buyer co"] : [],
    email: REVIEWER_DEMO_BUYER.email,
  };
}

/**
 * Build invoices for scoring tests.
 *
 * @param buyerId - Buyer account ID to associate with invoices
 * @param orderNames - Optional order names (default: #1001/#1002)
 */
export function buildReviewerDemoInvoices(
  buyerId: string,
  orderNames: { order1: string; order2: string } = { order1: "#1001", order2: "#1002" }
): InvoiceForScoring[] {
  return [
    {
      id: "invoice-reviewer-demo-1",
      name: orderNames.order1,
      orderId: `gid://shopify/Order/${orderNames.order1.replace("#", "")}`,
      outstandingPaise: BigInt(REVIEWER_DEMO_AMOUNTS.order1 * 100),
      buyerAccountId: buyerId,
      dueAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
    {
      id: "invoice-reviewer-demo-2",
      name: orderNames.order2,
      orderId: `gid://shopify/Order/${orderNames.order2.replace("#", "")}`,
      outstandingPaise: BigInt(REVIEWER_DEMO_AMOUNTS.order2 * 100),
      buyerAccountId: buyerId,
      dueAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  ];
}
