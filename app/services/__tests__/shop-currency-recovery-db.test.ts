/**
 * #292: DB integration tests for currency flip safety.
 *
 * Tests verify:
 * - USD stored + INR live + Invoice row → blocked
 * - USD stored + INR live + Payment row → blocked
 * - USD stored + INR live + s8_draft_orders row → blocked
 * - USD stored + INR live + zero rows → flips as today
 * - INR stored → unchanged
 *
 * Requires a running PostgreSQL instance.
 * Run with: TEST_DATABASE_URL=postgresql://... npm test -- shop-currency-recovery-db
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import {
  hasFinancialRows,
  isKnownNonInrCurrency,
} from "../shop-currency-recovery.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("hasFinancialRows DB integration", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = `test-${Date.now().toString(36)}-cfs`;

  const SHOP_WITH_INVOICE = `shop-invoice-${TEST_SUFFIX}`;
  const SHOP_WITH_PAYMENT = `shop-payment-${TEST_SUFFIX}`;
  const SHOP_WITH_DRAFT = `shop-draft-${TEST_SUFFIX}`;
  const SHOP_EMPTY = `shop-empty-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shops (use example.com to satisfy logging allowlist)
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES
        (${SHOP_WITH_INVOICE}, ${SHOP_WITH_INVOICE + ".example.com"}, 'USD', NOW(), NOW()),
        (${SHOP_WITH_PAYMENT}, ${SHOP_WITH_PAYMENT + ".example.com"}, 'USD', NOW(), NOW()),
        (${SHOP_WITH_DRAFT}, ${SHOP_WITH_DRAFT + ".example.com"}, 'USD', NOW(), NOW()),
        (${SHOP_EMPTY}, ${SHOP_EMPTY + ".example.com"}, 'USD', NOW(), NOW())
    `;

    // Create a BuyerAccount for shops that need it
    const BUYER_ID = `buyer-${TEST_SUFFIX}`;
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, name, "createdAt", "updatedAt")
      VALUES (${BUYER_ID}, ${SHOP_WITH_INVOICE}, 'COMPANY', 'Test Buyer', NOW(), NOW())
    `;

    // Create an Invoice for SHOP_WITH_INVOICE
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", name, total, outstanding, "issuedAt", "createdAt", "updatedAt")
      VALUES (${`inv-${TEST_SUFFIX}`}, ${SHOP_WITH_INVOICE}, ${BUYER_ID}, '#1001', 1000, 1000, NOW(), NOW(), NOW())
    `;

    // Create a BankImport and Payment for SHOP_WITH_PAYMENT
    const IMPORT_ID = `import-${TEST_SUFFIX}`;
    await sql`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (${IMPORT_ID}, ${SHOP_WITH_PAYMENT}, 'hdfc', 'test.csv', 1, NOW())
    `;
    await sql`
      INSERT INTO "Payment" (id, "shopId", "importId", "valueDate", amount, narration, "createdAt", "updatedAt")
      VALUES (${`pmt-${TEST_SUFFIX}`}, ${SHOP_WITH_PAYMENT}, ${IMPORT_ID}, NOW(), 500, 'Test payment', NOW(), NOW())
    `;

    // Create a s8_draft_orders row for SHOP_WITH_DRAFT
    await sql`
      INSERT INTO s8_draft_orders (id, shop_id, draft_order_id, name, total, created_at, updated_at)
      VALUES (${`dft-${TEST_SUFFIX}`}, ${SHOP_WITH_DRAFT}, 'gid://shopify/DraftOrder/123', '#D1', 250.00, NOW(), NOW())
    `;
  });

  afterAll(async () => {
    // Clean up test data
    await sql`DELETE FROM "Invoice" WHERE id = ${`inv-${TEST_SUFFIX}`}`;
    await sql`DELETE FROM "Payment" WHERE id = ${`pmt-${TEST_SUFFIX}`}`;
    await sql`DELETE FROM "BankImport" WHERE id = ${`import-${TEST_SUFFIX}`}`;
    await sql`DELETE FROM s8_draft_orders WHERE id = ${`dft-${TEST_SUFFIX}`}`;
    await sql`DELETE FROM "BuyerAccount" WHERE id = ${`buyer-${TEST_SUFFIX}`}`;
    await sql`DELETE FROM "Shop" WHERE id IN (${SHOP_WITH_INVOICE}, ${SHOP_WITH_PAYMENT}, ${SHOP_WITH_DRAFT}, ${SHOP_EMPTY})`;
    await sql.end();
  });

  it("returns true when shop has Invoice rows", async () => {
    const result = await hasFinancialRows(sql, SHOP_WITH_INVOICE);
    expect(result).toBe(true);
  });

  it("returns true when shop has Payment rows", async () => {
    const result = await hasFinancialRows(sql, SHOP_WITH_PAYMENT);
    expect(result).toBe(true);
  });

  it("returns true when shop has s8_draft_orders rows", async () => {
    const result = await hasFinancialRows(sql, SHOP_WITH_DRAFT);
    expect(result).toBe(true);
  });

  it("returns false when shop has zero financial rows", async () => {
    const result = await hasFinancialRows(sql, SHOP_EMPTY);
    expect(result).toBe(false);
  });

  it("returns false for non-existent shop", async () => {
    const result = await hasFinancialRows(sql, "non-existent-shop-id");
    expect(result).toBe(false);
  });
});

describe("isKnownNonInrCurrency", () => {
  it("returns true for USD", () => {
    expect(isKnownNonInrCurrency("USD")).toBe(true);
  });

  it("returns true for EUR", () => {
    expect(isKnownNonInrCurrency("EUR")).toBe(true);
  });

  it("returns true for GBP", () => {
    expect(isKnownNonInrCurrency("GBP")).toBe(true);
  });

  it("returns false for INR (supported currency)", () => {
    expect(isKnownNonInrCurrency("INR")).toBe(false);
  });

  it("returns false for XXX (sentinel)", () => {
    expect(isKnownNonInrCurrency("XXX")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isKnownNonInrCurrency(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isKnownNonInrCurrency(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isKnownNonInrCurrency("")).toBe(false);
  });

  it("returns false for lowercase codes", () => {
    expect(isKnownNonInrCurrency("usd")).toBe(false);
  });

  it("returns false for invalid codes", () => {
    expect(isKnownNonInrCurrency("USDD")).toBe(false);
    expect(isKnownNonInrCurrency("U")).toBe(false);
    expect(isKnownNonInrCurrency("123")).toBe(false);
  });
});
