/**
 * #292: DB integration tests for currency flip safety.
 *
 * Tests verify:
 * - hasFinancialRows detects Invoice, Payment, s8_draft_orders rows
 * - decideShopCurrencyUpdate blocks flip to INR when financial rows exist
 * - Fail-closed: XXX/NULL stored + INR live + rows → blocked
 * - Zero rows → flip allowed
 *
 * Requires a running PostgreSQL instance.
 * Run with: TEST_DATABASE_URL=postgresql://... npm test -- shop-currency-recovery-db
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import {
  hasFinancialRows,
  decideShopCurrencyUpdate,
} from "~/lib/shop-currency-guard.server";

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
    // Use TAGGED_CUSTOMER kind which doesn't require companyLocationId
    const BUYER_ID = `buyer-${TEST_SUFFIX}`;
    const CUSTOMER_ID = `gid://shopify/Customer/test-${TEST_SUFFIX}`;
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "customerId", name, "createdAt", "updatedAt")
      VALUES (${BUYER_ID}, ${SHOP_WITH_INVOICE}, 'TAGGED_CUSTOMER', ${CUSTOMER_ID}, 'Test Buyer', NOW(), NOW())
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

describe("decideShopCurrencyUpdate", () => {
  it("allows update when currencies match", () => {
    const decision = decideShopCurrencyUpdate({
      storedCurrency: "USD",
      liveCurrency: "USD",
      hasFinancialRows: true,
    });
    expect(decision).toEqual({
      allowUpdate: true,
      effectiveCurrency: "USD",
      blocked: false,
    });
  });

  it("allows switching away from INR to any currency", () => {
    const decision = decideShopCurrencyUpdate({
      storedCurrency: "INR",
      liveCurrency: "USD",
      hasFinancialRows: true,
    });
    expect(decision).toEqual({
      allowUpdate: true,
      effectiveCurrency: "USD",
      blocked: false,
    });
  });

  it("allows flip to INR when zero financial rows", () => {
    const decision = decideShopCurrencyUpdate({
      storedCurrency: "USD",
      liveCurrency: "INR",
      hasFinancialRows: false,
    });
    expect(decision).toEqual({
      allowUpdate: true,
      effectiveCurrency: "INR",
      blocked: false,
    });
  });

  it("blocks flip to INR when financial rows exist (USD stored)", () => {
    const decision = decideShopCurrencyUpdate({
      storedCurrency: "USD",
      liveCurrency: "INR",
      hasFinancialRows: true,
    });
    expect(decision).toEqual({
      allowUpdate: false,
      effectiveCurrency: "USD",
      blocked: true,
    });
  });

  it("blocks flip to INR when financial rows exist (EUR stored)", () => {
    const decision = decideShopCurrencyUpdate({
      storedCurrency: "EUR",
      liveCurrency: "INR",
      hasFinancialRows: true,
    });
    expect(decision).toEqual({
      allowUpdate: false,
      effectiveCurrency: "EUR",
      blocked: true,
    });
  });

  it("blocks flip to INR when financial rows exist (XXX stored) - fail closed", () => {
    const decision = decideShopCurrencyUpdate({
      storedCurrency: "XXX",
      liveCurrency: "INR",
      hasFinancialRows: true,
    });
    expect(decision).toEqual({
      allowUpdate: false,
      effectiveCurrency: "XXX",
      blocked: true,
    });
  });

  it("allows flip to INR from XXX when zero financial rows", () => {
    const decision = decideShopCurrencyUpdate({
      storedCurrency: "XXX",
      liveCurrency: "INR",
      hasFinancialRows: false,
    });
    expect(decision).toEqual({
      allowUpdate: true,
      effectiveCurrency: "INR",
      blocked: false,
    });
  });

  it("allows non-INR to non-INR changes with financial rows", () => {
    const decision = decideShopCurrencyUpdate({
      storedCurrency: "USD",
      liveCurrency: "EUR",
      hasFinancialRows: true,
    });
    expect(decision).toEqual({
      allowUpdate: true,
      effectiveCurrency: "EUR",
      blocked: false,
    });
  });
});
