/**
 * Shared fixture data for reviewer demo CSV matching tests.
 *
 * This module defines the synthetic company and order data used by:
 * - scripts/seed.ts (for the throwaway INR demo store only)
 * - tests/integration/review-csv-app-path.test.ts (unit tests)
 *
 * All data is FICTIONAL - no real company names, domains, or identifiers.
 * The company "Test Buyer Co" is designed to match the synthetic payer text
 * in tests/fixtures/banks/synthetic/hdfc-review-synthetic.csv.
 *
 * Amount window for candidate filtering in the app:
 * - MIN_FACTOR = 0.5x payment amount
 * - MAX_FACTOR = 2.0x payment amount
 *
 * CSV amounts: Row 1 = ₹10,000, Row 2 = ₹4,000, Row 3 = ₹2,500
 */

import type { InvoiceForScoring, BuyerForScoring } from "~/lib/matching/score.js";

/**
 * Seed key for the reviewer demo company.
 * Used by scripts/seed.ts to create/find this company idempotently.
 */
export const REVIEWER_DEMO_COMPANY_KEY = "company-reviewer-demo";

/**
 * Fictional company data for matching tests.
 * This matches the "TEST BUYER CO" payer text in the review CSV.
 */
export const REVIEWER_DEMO_COMPANY = {
  key: REVIEWER_DEMO_COMPANY_KEY,
  name: "Test Buyer Co",
  city: "Bengaluru",
  contact: {
    firstName: "Demo",
    lastName: "Reviewer",
    email: "demo.reviewer@test-buyer.example",
  },
} as const;

/**
 * Order definitions for the reviewer demo.
 * These create invoices that match the CSV payment amounts.
 *
 * Order names match the #XXXX pattern in the CSV narrations.
 * Amounts are chosen so that:
 * - Order #1001 exactly matches Row 1 (₹10,000)
 * - Order #1002 falls in the 0.5x-2x window for both Row 2 and Row 3
 *
 * Row 2 (₹4,000): window = ₹2,000 - ₹8,000
 * Row 3 (₹2,500): window = ₹1,250 - ₹5,000
 * Overlap: ₹2,000 - ₹5,000 → Order #1002 at ₹5,000 fits both
 */
export const REVIEWER_DEMO_ORDERS = [
  {
    orderKey: "reviewer-demo-1001",
    orderName: "#1001",
    amountInr: 10000, // ₹10,000.00 - exact match for Row 1
    dueInDays: 30,
  },
  {
    orderKey: "reviewer-demo-1002",
    orderName: "#1002",
    amountInr: 5000, // ₹5,000.00 - in window for Row 2 and Row 3
    dueInDays: 30,
  },
] as const;

/**
 * Build BuyerForScoring from the demo company data.
 * This is what the matcher receives from the database.
 *
 * IMPORTANT: The app path has NO pre-seeded aliases because aliases
 * are only learned when a merchant confirms a match. A fresh store
 * will have empty aliases.
 *
 * @param withAliases - If true, include aliases (for unit-level scoring tests)
 */
export function buildReviewerDemoBuyer(
  withAliases = false
): BuyerForScoring {
  return {
    id: `buyer-${REVIEWER_DEMO_COMPANY_KEY}`,
    name: REVIEWER_DEMO_COMPANY.name,
    aliases: withAliases ? ["test buyer co", "test buyer"] : [],
    email: REVIEWER_DEMO_COMPANY.contact.email,
  };
}

/**
 * Build InvoiceForScoring array from the demo order data.
 * This represents open orders as candidates for matching.
 *
 * @param buyerId - Buyer account ID to associate with invoices
 */
export function buildReviewerDemoInvoices(
  buyerId: string
): InvoiceForScoring[] {
  return REVIEWER_DEMO_ORDERS.map((order) => ({
    id: `invoice-${order.orderKey}`,
    name: order.orderName,
    orderId: `gid://shopify/Order/${order.orderName.replace("#", "")}`,
    outstandingPaise: BigInt(order.amountInr * 100),
    buyerAccountId: buyerId,
    dueAt: new Date(Date.now() + order.dueInDays * 24 * 60 * 60 * 1000),
  }));
}
