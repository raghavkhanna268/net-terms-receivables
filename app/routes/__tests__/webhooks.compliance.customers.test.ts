/**
 * Customer compliance webhook coverage tests (Sequential DB).
 *
 * These tests verify CURRENT behaviour using real database operations:
 * - customers/data_request: export contains only Protected Customer Data (Name, Email)
 * - customers/redact: end-to-end route with valid HMAC against real DB
 * - Redacted rows excluded from reinstall reset sync (#416)
 *
 * What this file adds over existing tests:
 * - webhooks.compliance.test.ts mocks generateCustomerDataExport and redactCustomer
 * - webhooks.compliance.unmocked.test.ts tests HMAC but mocks compliance services
 * - redact-customer-db.test.ts calls redactCustomer directly, not through the route
 *
 * This file:
 * - Tests generateCustomerDataExport with real DB rows containing bank-statement
 *   data (narration, remitter names) and verifies they're NOT in the export
 * - Tests customers/redact end-to-end through the route handler with valid HMAC
 *   against real seeded DB rows, asserting DB state after
 * - Tests bad-HMAC returns 401 and leaves DB byte-for-byte untouched
 * - Tests reinstall reset excludes redacted accounts (#416)
 *
 * Tests only, no source changes. Uses synthetic data only.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach, type MockInstance } from "vitest";
import postgres from "postgres";
import crypto from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { sqlOptions } from "~/lib/db-light.server";
import { generateCustomerDataExport } from "~/services/compliance/compliance.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const SYNTHETIC_TEST_SECRET = "synthetic-test-secret-custcomp-e2e";

function buildCustomerGid(numericId: number): string {
  return `gid://shopify/Customer/${numericId}`;
}

function generateShopifyHmac(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

describeWithDb("Sequential DB: Customer Compliance Webhook Coverage", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-custcomp";

  const SHOP_A_ID = `shop-a-${TEST_SUFFIX}`;
  const SHOP_A_DOMAIN = `test-custcomp-a-${TEST_SUFFIX}.myshopify.com`;
  const SHOP_B_ID = `shop-b-${TEST_SUFFIX}`;
  const SHOP_B_DOMAIN = `test-custcomp-b-${TEST_SUFFIX}.myshopify.com`;

  const CUSTOMER_ID_NUM = 123456;
  const CUSTOMER_GID = buildCustomerGid(CUSTOMER_ID_NUM);
  const OTHER_CUSTOMER_ID_NUM = 789012;
  const OTHER_CUSTOMER_GID = buildCustomerGid(OTHER_CUSTOMER_ID_NUM);

  const ACCOUNT_A_ID = `acc-a-${TEST_SUFFIX}`;
  const ACCOUNT_A_OTHER_ID = `acc-a-other-${TEST_SUFFIX}`;
  const ACCOUNT_B_ID = `acc-b-${TEST_SUFFIX}`;
  const IMPORT_A_ID = `import-a-${TEST_SUFFIX}`;
  const IMPORT_B_ID = `import-b-${TEST_SUFFIX}`;

  const SYNTHETIC_EMAIL = "customer@example.com";
  const SYNTHETIC_DISPLAY_NAME = "Example Customer";
  const SYNTHETIC_REMITTER_NAME = "ACME WIDGETS PVT LTD";
  const SYNTHETIC_NARRATION = "NEFT-UTR555123456789-ACME WIDGETS PAYMENT FOR INV001";

  let consoleLogSpy: MockInstance;
  let consoleInfoSpy: MockInstance;
  let consoleWarnSpy: MockInstance;
  let consoleErrorSpy: MockInstance;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_A_ID}, ${SHOP_A_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_B_ID}, ${SHOP_B_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, name, "customerId", "createdAt", "updatedAt"
      ) VALUES (
        ${ACCOUNT_A_ID}, ${SHOP_A_ID}, 'TAGGED_CUSTOMER',
        ${SYNTHETIC_DISPLAY_NAME}, ${CUSTOMER_GID}, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, name, "customerId", "createdAt", "updatedAt"
      ) VALUES (
        ${ACCOUNT_A_OTHER_ID}, ${SHOP_A_ID}, 'TAGGED_CUSTOMER',
        'Other Customer', ${OTHER_CUSTOMER_GID}, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, name, "customerId", "createdAt", "updatedAt"
      ) VALUES (
        ${ACCOUNT_B_ID}, ${SHOP_B_ID}, 'TAGGED_CUSTOMER',
        ${SYNTHETIC_DISPLAY_NAME}, ${CUSTOMER_GID}, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (${IMPORT_A_ID}, ${SHOP_A_ID}, 'test', 'test-a.csv', 10, NOW())
    `;

    await sql`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (${IMPORT_B_ID}, ${SHOP_B_ID}, 'test', 'test-b.csv', 10, NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "Match" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "Payment" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" IN (${ACCOUNT_A_ID}, ${ACCOUNT_A_OTHER_ID}, ${ACCOUNT_B_ID})`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM s8_draft_orders WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM s22_data_requests WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "Shop" WHERE id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM "Match" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "Payment" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" IN (${ACCOUNT_A_ID}, ${ACCOUNT_A_OTHER_ID}, ${ACCOUNT_B_ID})`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM s8_draft_orders WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM s22_data_requests WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;

    await sql`
      UPDATE "BuyerAccount"
      SET name = ${SYNTHETIC_DISPLAY_NAME}, "customerId" = ${CUSTOMER_GID},
          "metafieldSyncedAt" = NULL, "syncPending" = false, "updatedAt" = NOW()
      WHERE id = ${ACCOUNT_A_ID}
    `;
    await sql`
      UPDATE "BuyerAccount"
      SET name = 'Other Customer', "customerId" = ${OTHER_CUSTOMER_GID},
          "metafieldSyncedAt" = NULL, "syncPending" = false, "updatedAt" = NOW()
      WHERE id = ${ACCOUNT_A_OTHER_ID}
    `;
    await sql`
      UPDATE "BuyerAccount"
      SET name = ${SYNTHETIC_DISPLAY_NAME}, "customerId" = ${CUSTOMER_GID},
          "metafieldSyncedAt" = NULL, "syncPending" = false, "updatedAt" = NOW()
      WHERE id = ${ACCOUNT_B_ID}
    `;

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleInfoSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  function getAllConsoleOutput(): string[] {
    const allCalls = [
      ...consoleLogSpy.mock.calls,
      ...consoleInfoSpy.mock.calls,
      ...consoleWarnSpy.mock.calls,
      ...consoleErrorSpy.mock.calls,
    ];
    return allCalls.map(args =>
      args.map((arg: unknown) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg))).join(" ")
    );
  }

  describe("Case 2: customers/data_request exports only Protected Customer Data", () => {
    it("export contains only Name and Email, not bank-statement narration or remitter names", async () => {
      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, email, display_name, created_at, updated_at)
        VALUES (${SHOP_A_ID}, ${CUSTOMER_GID}, '["net-terms"]'::jsonb, true, ${SYNTHETIC_EMAIL}, ${SYNTHETIC_DISPLAY_NAME}, NOW(), NOW())
      `;

      const paymentId = `pmt-export-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "Payment" (id, "shopId", "importId", "valueDate", amount, rail, narration, "payerText", status, "createdAt", "updatedAt")
        VALUES (${paymentId}, ${SHOP_A_ID}, ${IMPORT_A_ID}, NOW(), 5000.00, 'NEFT', ${SYNTHETIC_NARRATION}, ${SYNTHETIC_REMITTER_NAME}, 'matched', NOW(), NOW())
      `;

      const invoiceId = `inv-export-${TEST_SUFFIX}`;
      const orderGidNum = Date.now();
      await sql`
        INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status, "issuedAt", "createdAt", "updatedAt")
        VALUES (${invoiceId}, ${SHOP_A_ID}, ${ACCOUNT_A_ID}, ${'gid://shopify/Order/' + orderGidNum}, '#INV001', 5000.00, 0.00, 'paid', NOW(), NOW(), NOW())
      `;

      const matchId = `match-export-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${matchId}, ${SHOP_A_ID}, ${paymentId}, ${invoiceId}, 5000.00, 95, '[]'::jsonb, 'confirmed', NOW(), NOW())
      `;

      const requestId = `req-export-${TEST_SUFFIX}`;
      const exportResult = await generateCustomerDataExport(sql, SHOP_A_ID, CUSTOMER_GID, requestId);

      expect(exportResult.customerGid).toBe(CUSTOMER_GID);
      expect(exportResult.requestId).toBe(requestId);

      expect(exportResult.data.taggedCustomer?.email).toBe(SYNTHETIC_EMAIL);
      expect(exportResult.data.taggedCustomer?.displayName).toBe(SYNTHETIC_DISPLAY_NAME);

      const exportJson = JSON.stringify(exportResult);

      expect(exportJson).not.toContain(SYNTHETIC_NARRATION);
      expect(exportJson).not.toContain(SYNTHETIC_REMITTER_NAME);
      expect(exportJson).not.toContain("NEFT-UTR");
      expect(exportJson).not.toContain("ACME WIDGETS");

      expect(exportJson).not.toContain("narration");
      expect(exportJson).not.toContain("payerText");

      expect(exportResult.data.invoices).toHaveLength(1);
      expect(exportResult.data.invoices[0].total).toBe("5000.00");
      expect(exportResult.data.invoices[0].name).toBe("#INV001");

      expect(exportResult.data.paymentMatches).toHaveLength(1);
      expect(exportResult.data.paymentMatches[0].amount).toBe("5000.00");
      expect(exportResult.data.paymentMatches[0].state).toBe("confirmed");
    });

    it("logs only allowlisted codes via safeLog, no PII in console output", async () => {
      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, email, display_name, created_at, updated_at)
        VALUES (${SHOP_A_ID}, ${CUSTOMER_GID}, '["net-terms"]'::jsonb, true, ${SYNTHETIC_EMAIL}, ${SYNTHETIC_DISPLAY_NAME}, NOW(), NOW())
      `;

      const requestId = `req-logging-${TEST_SUFFIX}`;
      await generateCustomerDataExport(sql, SHOP_A_ID, CUSTOMER_GID, requestId);

      const allOutput = getAllConsoleOutput().join("\n");

      expect(allOutput).not.toContain(SYNTHETIC_EMAIL);
      expect(allOutput).not.toContain(SYNTHETIC_DISPLAY_NAME);
      expect(allOutput).not.toContain(SHOP_A_DOMAIN);
      expect(allOutput).not.toContain(".myshopify.com");
    });
  });

  describe("Case 3: customers/redact route with real HMAC and real DB", () => {
    const originalEnv = process.env;

    function createSignedRequest(
      body: string,
      topic: string,
      shopDomain: string,
      options: { wrongHmac?: string; omitHmac?: boolean } = {}
    ): Request {
      const hmac = options.wrongHmac ?? (options.omitHmac ? undefined : generateShopifyHmac(body, SYNTHETIC_TEST_SECRET));
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Shopify-API-Version": "2026-10",
        "X-Shopify-Webhook-Id": `wh-custcomp-${Date.now()}`,
        "X-Shopify-Topic": topic,
        "X-Shopify-Shop-Domain": shopDomain,
      };
      if (hmac) {
        headers["X-Shopify-Hmac-Sha256"] = hmac;
      }
      return new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        headers,
        body,
      });
    }

    function createActionArgs(request: Request): ActionFunctionArgs {
      return {
        request,
        params: {},
        context: {
          cloudflare: { env: {}, ctx: {} },
          shopify: {},
          sessionStorage: { deleteAllForShop: vi.fn().mockResolvedValue(0) },
        },
        url: new URL(request.url),
        pattern: "/webhooks/compliance",
      } as unknown as ActionFunctionArgs;
    }

    beforeEach(() => {
      process.env = { ...originalEnv, SHOPIFY_API_SECRET: SYNTHETIC_TEST_SECRET };

      vi.doMock("~/lib/request-context.server", () => ({
        getRequestSql: () => sql,
      }));
    });

    afterEach(() => {
      process.env = originalEnv;
      vi.doUnmock("~/lib/request-context.server");
    });

    it("valid HMAC calls redactCustomer: target customer is redacted, invoices kept", async () => {
      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, email, display_name, created_at, updated_at)
        VALUES (${SHOP_A_ID}, ${CUSTOMER_GID}, '["net-terms"]'::jsonb, true, ${SYNTHETIC_EMAIL}, ${SYNTHETIC_DISPLAY_NAME}, NOW(), NOW())
      `;

      const paymentId = `pmt-e2e-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "Payment" (id, "shopId", "importId", "valueDate", amount, rail, narration, "payerText", status, "createdAt", "updatedAt")
        VALUES (${paymentId}, ${SHOP_A_ID}, ${IMPORT_A_ID}, NOW(), 1000.00, 'NEFT', ${SYNTHETIC_NARRATION}, ${SYNTHETIC_REMITTER_NAME}, 'matched', NOW(), NOW())
      `;

      const invoiceId = `inv-e2e-${TEST_SUFFIX}`;
      const orderGidNum = Date.now();
      await sql`
        INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status, "issuedAt", "createdAt", "updatedAt")
        VALUES (${invoiceId}, ${SHOP_A_ID}, ${ACCOUNT_A_ID}, ${'gid://shopify/Order/' + orderGidNum}, '#E2E001', 1000.00, 500.00, 'open', NOW(), NOW(), NOW())
      `;

      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES (${'match-e2e-' + TEST_SUFFIX}, ${SHOP_A_ID}, ${paymentId}, ${invoiceId}, 500.00, 90, '[]'::jsonb, 'confirmed', NOW(), NOW())
      `;

      await sql`
        INSERT INTO "PayerAlias" (id, "buyerAccountId", "payerKey", "createdAt")
        VALUES (${'alias-e2e-' + TEST_SUFFIX}, ${ACCOUNT_A_ID}, 'acme-widgets-key', NOW())
      `;

      const payload = {
        shop_id: 123,
        shop_domain: SHOP_A_DOMAIN,
        customer: { id: CUSTOMER_ID_NUM },
      };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "customers/redact", SHOP_A_DOMAIN);

      const { action } = await import("../webhooks.compliance");
      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);

      const [payment] = await sql<{ narration: string; payerText: string | null; amount: string }[]>`
        SELECT narration, "payerText", amount::text FROM "Payment" WHERE id = ${paymentId}
      `;
      expect(payment.narration).toBe("[REDACTED]");
      expect(payment.payerText).toBeNull();
      expect(payment.amount).toBe("1000.00");

      const [account] = await sql<{ name: string; customerId: string }[]>`
        SELECT name, "customerId" FROM "BuyerAccount" WHERE id = ${ACCOUNT_A_ID}
      `;
      expect(account.name).toBe("Redacted Customer");
      expect(account.customerId).toContain("_redacted_");

      const [invoice] = await sql<{ total: string; outstanding: string; status: string }[]>`
        SELECT total::text, outstanding::text, status FROM "Invoice" WHERE id = ${invoiceId}
      `;
      expect(invoice.total).toBe("1000.00");
      expect(invoice.outstanding).toBe("500.00");
      expect(invoice.status).toBe("open");

      const taggedRows = await sql<{ id: string }[]>`
        SELECT id FROM s8_tagged_customers WHERE shop_id = ${SHOP_A_ID} AND customer_id = ${CUSTOMER_GID}
      `;
      expect(taggedRows).toHaveLength(0);

      const aliasRows = await sql<{ id: string }[]>`
        SELECT id FROM "PayerAlias" WHERE "buyerAccountId" = ${ACCOUNT_A_ID}
      `;
      expect(aliasRows).toHaveLength(0);
    });

    it("cross-shop isolation: same customer ID in shop B is untouched after shop A redact", async () => {
      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, email, display_name, created_at, updated_at)
        VALUES 
          (${SHOP_A_ID}, ${CUSTOMER_GID}, '["net-terms"]'::jsonb, true, ${SYNTHETIC_EMAIL}, ${SYNTHETIC_DISPLAY_NAME}, NOW(), NOW()),
          (${SHOP_B_ID}, ${CUSTOMER_GID}, '["net-terms"]'::jsonb, true, ${SYNTHETIC_EMAIL}, ${SYNTHETIC_DISPLAY_NAME}, NOW(), NOW())
      `;

      const paymentAId = `pmt-cross-a-${TEST_SUFFIX}`;
      const paymentBId = `pmt-cross-b-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "Payment" (id, "shopId", "importId", "valueDate", amount, rail, narration, "payerText", status, "createdAt", "updatedAt")
        VALUES 
          (${paymentAId}, ${SHOP_A_ID}, ${IMPORT_A_ID}, NOW(), 2000.00, 'NEFT', ${SYNTHETIC_NARRATION}, ${SYNTHETIC_REMITTER_NAME}, 'matched', NOW(), NOW()),
          (${paymentBId}, ${SHOP_B_ID}, ${IMPORT_B_ID}, NOW(), 2000.00, 'NEFT', ${SYNTHETIC_NARRATION}, ${SYNTHETIC_REMITTER_NAME}, 'matched', NOW(), NOW())
      `;

      const invoiceAId = `inv-cross-a-${TEST_SUFFIX}`;
      const invoiceBId = `inv-cross-b-${TEST_SUFFIX}`;
      const orderGidNum = Date.now();
      await sql`
        INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status, "issuedAt", "createdAt", "updatedAt")
        VALUES 
          (${invoiceAId}, ${SHOP_A_ID}, ${ACCOUNT_A_ID}, ${'gid://shopify/Order/' + orderGidNum + 'a'}, '#CROSS-A', 2000.00, 2000.00, 'open', NOW(), NOW(), NOW()),
          (${invoiceBId}, ${SHOP_B_ID}, ${ACCOUNT_B_ID}, ${'gid://shopify/Order/' + orderGidNum + 'b'}, '#CROSS-B', 2000.00, 2000.00, 'open', NOW(), NOW(), NOW())
      `;

      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES 
          (${'match-cross-a-' + TEST_SUFFIX}, ${SHOP_A_ID}, ${paymentAId}, ${invoiceAId}, 2000.00, 90, '[]'::jsonb, 'confirmed', NOW(), NOW()),
          (${'match-cross-b-' + TEST_SUFFIX}, ${SHOP_B_ID}, ${paymentBId}, ${invoiceBId}, 2000.00, 90, '[]'::jsonb, 'confirmed', NOW(), NOW())
      `;

      const payload = {
        shop_id: 123,
        shop_domain: SHOP_A_DOMAIN,
        customer: { id: CUSTOMER_ID_NUM },
      };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "customers/redact", SHOP_A_DOMAIN);

      const { action } = await import("../webhooks.compliance");
      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);

      const [paymentA] = await sql<{ narration: string; payerText: string | null }[]>`
        SELECT narration, "payerText" FROM "Payment" WHERE id = ${paymentAId}
      `;
      expect(paymentA.narration).toBe("[REDACTED]");
      expect(paymentA.payerText).toBeNull();

      const [paymentB] = await sql<{ narration: string; payerText: string | null }[]>`
        SELECT narration, "payerText" FROM "Payment" WHERE id = ${paymentBId}
      `;
      expect(paymentB.narration).toBe(SYNTHETIC_NARRATION);
      expect(paymentB.payerText).toBe(SYNTHETIC_REMITTER_NAME);

      const [accountA] = await sql<{ name: string; customerId: string }[]>`
        SELECT name, "customerId" FROM "BuyerAccount" WHERE id = ${ACCOUNT_A_ID}
      `;
      expect(accountA.name).toBe("Redacted Customer");
      expect(accountA.customerId).toContain("_redacted_");

      const [accountB] = await sql<{ name: string; customerId: string }[]>`
        SELECT name, "customerId" FROM "BuyerAccount" WHERE id = ${ACCOUNT_B_ID}
      `;
      expect(accountB.name).toBe(SYNTHETIC_DISPLAY_NAME);
      expect(accountB.customerId).toBe(CUSTOMER_GID);

      const taggedB = await sql<{ shop_id: string }[]>`
        SELECT shop_id FROM s8_tagged_customers WHERE shop_id = ${SHOP_B_ID} AND customer_id = ${CUSTOMER_GID}
      `;
      expect(taggedB).toHaveLength(1);
    });

    it("other customers in the same shop are untouched", async () => {
      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, email, display_name, created_at, updated_at)
        VALUES 
          (${SHOP_A_ID}, ${CUSTOMER_GID}, '["net-terms"]'::jsonb, true, ${SYNTHETIC_EMAIL}, ${SYNTHETIC_DISPLAY_NAME}, NOW(), NOW()),
          (${SHOP_A_ID}, ${OTHER_CUSTOMER_GID}, '["net-terms"]'::jsonb, true, 'other@example.com', 'Other Customer', NOW(), NOW())
      `;

      const paymentTargetId = `pmt-other-target-${TEST_SUFFIX}`;
      const paymentOtherId = `pmt-other-other-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "Payment" (id, "shopId", "importId", "valueDate", amount, rail, narration, "payerText", status, "createdAt", "updatedAt")
        VALUES 
          (${paymentTargetId}, ${SHOP_A_ID}, ${IMPORT_A_ID}, NOW(), 3000.00, 'NEFT', 'TARGET PAYMENT', 'TARGET CORP', 'matched', NOW(), NOW()),
          (${paymentOtherId}, ${SHOP_A_ID}, ${IMPORT_A_ID}, NOW(), 4000.00, 'NEFT', 'OTHER PAYMENT', 'OTHER CORP', 'matched', NOW(), NOW())
      `;

      const invoiceTargetId = `inv-other-target-${TEST_SUFFIX}`;
      const invoiceOtherId = `inv-other-other-${TEST_SUFFIX}`;
      const orderGidNum = Date.now();
      await sql`
        INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status, "issuedAt", "createdAt", "updatedAt")
        VALUES 
          (${invoiceTargetId}, ${SHOP_A_ID}, ${ACCOUNT_A_ID}, ${'gid://shopify/Order/' + orderGidNum + 't'}, '#TARGET', 3000.00, 3000.00, 'open', NOW(), NOW(), NOW()),
          (${invoiceOtherId}, ${SHOP_A_ID}, ${ACCOUNT_A_OTHER_ID}, ${'gid://shopify/Order/' + orderGidNum + 'o'}, '#OTHER', 4000.00, 4000.00, 'open', NOW(), NOW(), NOW())
      `;

      await sql`
        INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES 
          (${'match-other-target-' + TEST_SUFFIX}, ${SHOP_A_ID}, ${paymentTargetId}, ${invoiceTargetId}, 3000.00, 90, '[]'::jsonb, 'confirmed', NOW(), NOW()),
          (${'match-other-other-' + TEST_SUFFIX}, ${SHOP_A_ID}, ${paymentOtherId}, ${invoiceOtherId}, 4000.00, 90, '[]'::jsonb, 'confirmed', NOW(), NOW())
      `;

      const payload = {
        shop_id: 123,
        shop_domain: SHOP_A_DOMAIN,
        customer: { id: CUSTOMER_ID_NUM },
      };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "customers/redact", SHOP_A_DOMAIN);

      const { action } = await import("../webhooks.compliance");
      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);

      const [paymentTarget] = await sql<{ narration: string; payerText: string | null }[]>`
        SELECT narration, "payerText" FROM "Payment" WHERE id = ${paymentTargetId}
      `;
      expect(paymentTarget.narration).toBe("[REDACTED]");
      expect(paymentTarget.payerText).toBeNull();

      const [paymentOther] = await sql<{ narration: string; payerText: string | null }[]>`
        SELECT narration, "payerText" FROM "Payment" WHERE id = ${paymentOtherId}
      `;
      expect(paymentOther.narration).toBe("OTHER PAYMENT");
      expect(paymentOther.payerText).toBe("OTHER CORP");

      const [accountOther] = await sql<{ name: string; customerId: string }[]>`
        SELECT name, "customerId" FROM "BuyerAccount" WHERE id = ${ACCOUNT_A_OTHER_ID}
      `;
      expect(accountOther.name).toBe("Other Customer");
      expect(accountOther.customerId).toBe(OTHER_CUSTOMER_GID);

      const taggedOther = await sql<{ shop_id: string }[]>`
        SELECT shop_id FROM s8_tagged_customers WHERE shop_id = ${SHOP_A_ID} AND customer_id = ${OTHER_CUSTOMER_GID}
      `;
      expect(taggedOther).toHaveLength(1);
    });

    it("bad HMAC returns 401 and leaves DB byte-for-byte untouched", async () => {
      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, email, display_name, created_at, updated_at)
        VALUES (${SHOP_A_ID}, ${CUSTOMER_GID}, '["net-terms"]'::jsonb, true, ${SYNTHETIC_EMAIL}, ${SYNTHETIC_DISPLAY_NAME}, NOW(), NOW())
      `;

      const paymentId = `pmt-badhmac-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "Payment" (id, "shopId", "importId", "valueDate", amount, rail, narration, "payerText", status, "createdAt", "updatedAt")
        VALUES (${paymentId}, ${SHOP_A_ID}, ${IMPORT_A_ID}, NOW(), 9999.00, 'NEFT', 'ORIGINAL NARRATION BADHMAC', 'ORIGINAL PAYER BADHMAC', 'matched', NOW(), NOW())
      `;

      const [beforePayment] = await sql<{ narration: string; payerText: string | null }[]>`
        SELECT narration, "payerText" FROM "Payment" WHERE id = ${paymentId}
      `;
      const [beforeAccount] = await sql<{ name: string; customerId: string }[]>`
        SELECT name, "customerId" FROM "BuyerAccount" WHERE id = ${ACCOUNT_A_ID}
      `;
      const beforeTagged = await sql<{ id: string }[]>`
        SELECT id FROM s8_tagged_customers WHERE shop_id = ${SHOP_A_ID} AND customer_id = ${CUSTOMER_GID}
      `;

      const payload = {
        shop_id: 123,
        shop_domain: SHOP_A_DOMAIN,
        customer: { id: CUSTOMER_ID_NUM },
      };
      const body = JSON.stringify(payload);
      const wrongHmac = generateShopifyHmac(body, "wrong-secret-not-the-real-one");
      const request = createSignedRequest(body, "customers/redact", SHOP_A_DOMAIN, { wrongHmac });

      const { action } = await import("../webhooks.compliance");

      await expect(action(createActionArgs(request))).rejects.toMatchObject({
        status: 401,
      });

      const [afterPayment] = await sql<{ narration: string; payerText: string | null }[]>`
        SELECT narration, "payerText" FROM "Payment" WHERE id = ${paymentId}
      `;
      const [afterAccount] = await sql<{ name: string; customerId: string }[]>`
        SELECT name, "customerId" FROM "BuyerAccount" WHERE id = ${ACCOUNT_A_ID}
      `;
      const afterTagged = await sql<{ id: string }[]>`
        SELECT id FROM s8_tagged_customers WHERE shop_id = ${SHOP_A_ID} AND customer_id = ${CUSTOMER_GID}
      `;

      expect(afterPayment.narration).toBe(beforePayment.narration);
      expect(afterPayment.payerText).toBe(beforePayment.payerText);
      expect(afterAccount.name).toBe(beforeAccount.name);
      expect(afterAccount.customerId).toBe(beforeAccount.customerId);
      expect(afterTagged).toHaveLength(beforeTagged.length);
    });

    it("redelivering redact webhook is idempotent (same end state, no error)", async () => {
      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, email, display_name, created_at, updated_at)
        VALUES (${SHOP_A_ID}, ${CUSTOMER_GID}, '["net-terms"]'::jsonb, true, ${SYNTHETIC_EMAIL}, ${SYNTHETIC_DISPLAY_NAME}, NOW(), NOW())
      `;

      const paymentId = `pmt-idem-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "Payment" (id, "shopId", "importId", "valueDate", amount, rail, narration, "payerText", status, "createdAt", "updatedAt")
        VALUES (${paymentId}, ${SHOP_A_ID}, ${IMPORT_A_ID}, NOW(), 1500.00, 'NEFT', 'IDEM NARRATION', 'IDEM PAYER', 'matched', NOW(), NOW())
      `;

      const payload = {
        shop_id: 123,
        shop_domain: SHOP_A_DOMAIN,
        customer: { id: CUSTOMER_ID_NUM },
      };
      const body = JSON.stringify(payload);

      const { action } = await import("../webhooks.compliance");

      const request1 = createSignedRequest(body, "customers/redact", SHOP_A_DOMAIN);
      const response1 = await action(createActionArgs(request1));
      expect(response1.status).toBe(200);

      const [afterFirst] = await sql<{ narration: string; customerId: string }[]>`
        SELECT p.narration, a."customerId"
        FROM "Payment" p, "BuyerAccount" a
        WHERE p.id = ${paymentId} AND a.id = ${ACCOUNT_A_ID}
      `;

      const request2 = createSignedRequest(body, "customers/redact", SHOP_A_DOMAIN);
      const response2 = await action(createActionArgs(request2));
      expect(response2.status).toBe(200);

      const [afterSecond] = await sql<{ narration: string; customerId: string }[]>`
        SELECT p.narration, a."customerId"
        FROM "Payment" p, "BuyerAccount" a
        WHERE p.id = ${paymentId} AND a.id = ${ACCOUNT_A_ID}
      `;

      expect(afterSecond.narration).toBe(afterFirst.narration);
      expect(afterSecond.customerId).toBe(afterFirst.customerId);
    });
  });

  describe("Case 4: Redacted accounts excluded from reinstall reset (#416)", () => {
    it("reinstall reset sets syncPending=true for normal accounts but NOT for redacted accounts", async () => {
      const syncedAt = new Date("2026-10-14T10:00:00Z");

      await sql`
        UPDATE "BuyerAccount"
        SET "metafieldSyncedAt" = ${syncedAt}, "syncPending" = false
        WHERE id IN (${ACCOUNT_A_ID}, ${ACCOUNT_A_OTHER_ID})
      `;

      await sql`
        UPDATE "Shop"
        SET "uninstalledAt" = NOW()
        WHERE id = ${SHOP_A_ID}
      `;

      const redactedCustomerId = CUSTOMER_GID + "_redacted_" + Date.now();
      await sql`
        UPDATE "BuyerAccount"
        SET "customerId" = ${redactedCustomerId}, name = 'Redacted Customer'
        WHERE id = ${ACCOUNT_A_ID}
      `;

      const [beforeRedacted] = await sql<{ metafieldSyncedAt: Date | null; syncPending: boolean }[]>`
        SELECT "metafieldSyncedAt", "syncPending" FROM "BuyerAccount" WHERE id = ${ACCOUNT_A_ID}
      `;
      const [beforeNormal] = await sql<{ metafieldSyncedAt: Date | null; syncPending: boolean }[]>`
        SELECT "metafieldSyncedAt", "syncPending" FROM "BuyerAccount" WHERE id = ${ACCOUNT_A_OTHER_ID}
      `;

      expect(beforeRedacted.metafieldSyncedAt).not.toBeNull();
      expect(beforeRedacted.syncPending).toBe(false);
      expect(beforeNormal.metafieldSyncedAt).not.toBeNull();
      expect(beforeNormal.syncPending).toBe(false);

      const { _clearUninstalledAtAndMetafieldErrorsForTesting } = await import("~/lib/after-auth.server");
      const result = await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, SHOP_A_DOMAIN);

      expect(result.wasReinstalled).toBe(true);

      const [afterRedacted] = await sql<{ metafieldSyncedAt: Date | null; syncPending: boolean; customerId: string }[]>`
        SELECT "metafieldSyncedAt", "syncPending", "customerId" FROM "BuyerAccount" WHERE id = ${ACCOUNT_A_ID}
      `;
      const [afterNormal] = await sql<{ metafieldSyncedAt: Date | null; syncPending: boolean }[]>`
        SELECT "metafieldSyncedAt", "syncPending" FROM "BuyerAccount" WHERE id = ${ACCOUNT_A_OTHER_ID}
      `;

      expect(afterRedacted.customerId).toContain("_redacted_");
      expect(afterRedacted.metafieldSyncedAt).not.toBeNull();
      expect(afterRedacted.syncPending).toBe(false);

      expect(afterNormal.metafieldSyncedAt).toBeNull();
      expect(afterNormal.syncPending).toBe(true);
    });

    it("redacted account name and customerId are preserved after reinstall reset", async () => {
      await sql`
        UPDATE "Shop"
        SET "uninstalledAt" = NOW()
        WHERE id = ${SHOP_A_ID}
      `;

      const redactedCustomerId = CUSTOMER_GID + "_redacted_" + Date.now();
      await sql`
        UPDATE "BuyerAccount"
        SET "customerId" = ${redactedCustomerId}, name = 'Redacted Customer',
            "metafieldSyncedAt" = NOW(), "syncPending" = false
        WHERE id = ${ACCOUNT_A_ID}
      `;

      const [before] = await sql<{ customerId: string; name: string }[]>`
        SELECT "customerId", name FROM "BuyerAccount" WHERE id = ${ACCOUNT_A_ID}
      `;

      const { _clearUninstalledAtAndMetafieldErrorsForTesting } = await import("~/lib/after-auth.server");
      await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, SHOP_A_DOMAIN);

      const [after] = await sql<{ customerId: string; name: string }[]>`
        SELECT "customerId", name FROM "BuyerAccount" WHERE id = ${ACCOUNT_A_ID}
      `;

      expect(after.customerId).toBe(before.customerId);
      expect(after.name).toBe(before.name);
      expect(after.name).toBe("Redacted Customer");
      expect(after.customerId).toContain("_redacted_");
    });
  });
});
