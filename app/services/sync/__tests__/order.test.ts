import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import {
  processOrderWebhook,
  mapOrderToInvoice,
  mapOrderToInvoiceWithEligibility,
  getAndResetOutstandingMissingCounter,
} from "../order.server";
import type { ShopifyOrder } from "../types";
import type { EligibilityResult } from "~/lib/invoice-eligibility";
import { assertNoQueueLeftovers } from "../../../../tests/helpers/queue-leftovers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("Order Sync", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36);
  const TEST_SHOP_ID = `shop-ord-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `ord-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `account-ord-${TEST_SUFFIX}`;
  const TEST_COMPANY_ID = `gid://shopify/Company/co-ord-${TEST_SUFFIX}`;
  const TEST_LOCATION_ID = `gid://shopify/CompanyLocation/loc-ord-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    await sql`
      INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, NOW(), NOW())
    `;

    // Create test buyer account (COMPANY)
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "createdAt", "updatedAt"
      ) VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY', ${TEST_COMPANY_ID}, ${TEST_LOCATION_ID}, 'Test Company',
        NOW(), NOW()
      )
    `;

    // Create dedupe table if not exists
    await sql`
      CREATE TABLE IF NOT EXISTS s6_processed_webhooks (
        webhook_id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        resource_gid TEXT NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  });

  afterAll(async () => {
    // Clean up queue messages for this shop before deleting it (prevents flakes in later test files)
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;

    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${"wh-ord-" + TEST_SUFFIX + "%"}`;

    await assertNoQueueLeftovers(sql, [TEST_SHOP_DOMAIN], "order.test.ts");

    await sql.end();
  });

  beforeEach(async () => {
    // Clean up invoices for this shop
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${"wh-ord-" + TEST_SUFFIX + "%"}`;
  });

  describe("processOrderWebhook", () => {
    it("creates Invoice for order with payment terms", async () => {
      const order: ShopifyOrder = {
        id: `gid://shopify/Order/ord-${TEST_SUFFIX}-1`,
        name: "#1001",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PENDING",
        totalPriceSet: {
          shopMoney: { amount: "50000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt1",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
          dueInDays: 30,
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      const result = await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_CREATE",
        order,
        `wh-ord-${TEST_SUFFIX}-1`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("created");
      expect(result.entityId).toBeDefined();

      // Verify invoice was created
      const [invoice] = await sql`
        SELECT * FROM "Invoice" WHERE id = ${result.entityId!}
      `;
      expect(invoice.orderId).toBe(order.id);
      expect(invoice.buyerAccountId).toBe(TEST_ACCOUNT_ID);
      expect(invoice.name).toBe("#1001");
      expect(invoice.total).toBe("50000.00");
      expect(invoice.outstanding).toBe("50000.00");
      expect(invoice.status).toBe("open");
      expect(invoice.dueSource).toBe("schedule");
    });

    // #292: INR order imports unchanged - this test serves as (a) verification
    // The above test "creates Invoice for order with payment terms" uses INR currency
    // and verifies the order is processed normally, creating an Invoice.

    it("#292: skips USD order in INR shop (order_currency_not_supported)", async () => {
      // A USD order in a shop that switched to INR should be skipped
      // The order was created when the shop was USD, so we shouldn't import it as INR
      const order: ShopifyOrder = {
        id: `gid://shopify/Order/ord-${TEST_SUFFIX}-usd`,
        name: "#USD-ORDER",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PENDING",
        totalPriceSet: {
          shopMoney: { amount: "50000.00", currencyCode: "USD" }, // USD, not INR
        },
        paymentTerms: {
          id: "pt-usd",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
          dueInDays: 30,
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      const result = await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_CREATE",
        order,
        `wh-ord-${TEST_SUFFIX}-usd`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toBe("order_currency_not_supported");

      // Verify NO invoice was created
      const invoices = await sql`
        SELECT * FROM "Invoice" WHERE "orderId" = ${order.id}
      `;
      expect(invoices).toHaveLength(0);
    });

    it("#292: skips order with missing currency (order_currency_missing)", async () => {
      // An order without currency code should be skipped (fail-closed)
      const order: ShopifyOrder = {
        id: `gid://shopify/Order/ord-${TEST_SUFFIX}-nocurrency`,
        name: "#NO-CURRENCY-ORDER",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PENDING",
        // No totalPriceSet - missing currency
        paymentTerms: {
          id: "pt-nocurrency",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
          dueInDays: 30,
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      const result = await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_CREATE",
        order,
        `wh-ord-${TEST_SUFFIX}-nocurrency`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toBe("order_currency_missing");

      // Verify NO invoice was created
      const invoicesNoCurrency = await sql`
        SELECT * FROM "Invoice" WHERE "orderId" = ${order.id}
      `;
      expect(invoicesNoCurrency).toHaveLength(0);
    });

    it("skips retail orders (no payment terms, no B2B, no tag) as permanent skip", async () => {
      // A retail order with no payment terms and no company location is a permanent skip
      const order: ShopifyOrder = {
        id: `gid://shopify/Order/ord-${TEST_SUFFIX}-2`,
        name: "#1002",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PENDING",
        totalPriceSet: {
          shopMoney: { amount: "1000.00", currencyCode: "INR" },
        },
        paymentTerms: null, // No payment terms
        // No purchasingEntity (retail order)
      };

      const result = await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_CREATE",
        order,
        `wh-ord-${TEST_SUFFIX}-2`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      // The message explains why it was skipped (retail order)
      expect(result.skipReason).toContain("Retail order");
      // Retryable should be undefined (permanent skip)
      expect(result.retryable).toBeUndefined();

      // No invoice should be created
      const invoices = await sql`
        SELECT * FROM "Invoice" WHERE "orderId" = ${order.id}
      `;
      expect(invoices).toHaveLength(0);
    });

    it("fails with retryable when B2B location not synced yet (company sync pending)", async () => {
      // B2B order with company location but no BuyerAccount yet - should be retryable
      const unknownCompanyId = `gid://shopify/Company/unknown-${TEST_SUFFIX}`;
      const unknownLocationId = `gid://shopify/CompanyLocation/unknown-${TEST_SUFFIX}`;

      const order: ShopifyOrder = {
        id: `gid://shopify/Order/ord-${TEST_SUFFIX}-3`,
        name: "#1003",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PENDING",
        totalPriceSet: {
          shopMoney: { amount: "25000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt2",
          paymentTermsName: "Net 45",
          paymentTermsType: "NET",
          dueInDays: 45,
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: unknownCompanyId },
          location: { id: unknownLocationId },
        },
      };

      const result = await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_CREATE",
        order,
        `wh-ord-${TEST_SUFFIX}-3`
      );

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(true);
      // The error message explains why it failed (BuyerAccount not found)
      expect(result.error).toContain("BuyerAccount");
      // errorCode must be set from eligibility.reason (no raw text for DLQ)
      expect(result.errorCode).toBe("no_buyer_account");
    });

    it("always updates existing invoice even when eligibility would fail", async () => {
      // First create an invoice (simulating it was created when eligible)
      const orderId = `gid://shopify/Order/ord-${TEST_SUFFIX}-update`;
      await sql`
        INSERT INTO "Invoice" (
          "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          "issuedAt", status, "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId}, '#9001', '10000.00', '10000.00',
          NOW(), 'open', NOW(), NOW()
        )
      `;

      // Now process an order update that would NOT be eligible (no payment terms, no company)
      // But since invoice exists, it should still update
      const order: ShopifyOrder = {
        id: orderId,
        name: "#9001-updated",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PENDING",
        totalPriceSet: {
          shopMoney: { amount: "15000.00", currencyCode: "INR" },
        },
        paymentTerms: null, // No payment terms now
        // No purchasingEntity (would be ineligible for creation)
      };

      const result = await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_UPDATED",
        order,
        `wh-ord-${TEST_SUFFIX}-update`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("updated");

      // Verify invoice was updated (name and total changed)
      const [invoice] = await sql`
        SELECT * FROM "Invoice" WHERE "orderId" = ${orderId}
      `;
      expect(invoice.name).toBe("#9001-updated");
      expect(invoice.total).toBe("15000.00");
    });

    it("marks invoice as cancelled on ORDERS_CANCELLED", async () => {
      // Create invoice first
      const orderId = `gid://shopify/Order/ord-${TEST_SUFFIX}-4`;
      await sql`
        INSERT INTO "Invoice" (
          "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          "issuedAt", status, "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId}, '#1004', '10000.00', '10000.00',
          NOW(), 'open', NOW(), NOW()
        )
      `;

      const order: ShopifyOrder = {
        id: orderId,
        name: "#1004",
        createdAt: "2025-07-15T10:00:00.000Z",
        cancelledAt: "2025-07-16T10:00:00.000Z",
        paymentTerms: { id: "pt", paymentTermsName: "Net 30", paymentTermsType: "NET" },
      };

      const result = await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_CANCELLED",
        order,
        `wh-ord-${TEST_SUFFIX}-4`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("updated");

      const [invoice] = await sql`
        SELECT * FROM "Invoice" WHERE "orderId" = ${orderId}
      `;
      expect(invoice.status).toBe("cancelled");
    });

    it("marks invoice as paid on ORDERS_PAID", async () => {
      // Create invoice first
      const orderId = `gid://shopify/Order/ord-${TEST_SUFFIX}-5`;
      await sql`
        INSERT INTO "Invoice" (
          "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          "issuedAt", status, "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId}, '#1005', '20000.00', '20000.00',
          NOW(), 'open', NOW(), NOW()
        )
      `;

      const order: ShopifyOrder = {
        id: orderId,
        name: "#1005",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PAID",
        paymentTerms: { id: "pt", paymentTermsName: "Net 30", paymentTermsType: "NET" },
      };

      const result = await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_PAID",
        order,
        `wh-ord-${TEST_SUFFIX}-5`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("updated");

      const [invoice] = await sql`
        SELECT * FROM "Invoice" WHERE "orderId" = ${orderId}
      `;
      expect(invoice.status).toBe("paid");
      expect(invoice.outstanding).toBe("0.00");
    });

    it("is idempotent - skips duplicate webhooks", async () => {
      const order: ShopifyOrder = {
        id: `gid://shopify/Order/ord-${TEST_SUFFIX}-6`,
        name: "#1006",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PENDING",
        totalPriceSet: {
          shopMoney: { amount: "5000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt",
          paymentTermsName: "Net 15",
          paymentTermsType: "NET",
          dueInDays: 15,
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      const webhookId = `wh-ord-${TEST_SUFFIX}-6`;

      // First call
      const result1 = await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_CREATE",
        order,
        webhookId
      );
      expect(result1.action).toBe("created");

      // Second call with same webhook ID
      const result2 = await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_CREATE",
        order,
        webhookId
      );
      expect(result2.action).toBe("skipped");
      expect(result2.skipReason).toContain("idempotent");
    });

    it("does not downgrade paid invoice status on ORDERS_UPDATED", async () => {
      // Create a paid invoice
      const orderId = `gid://shopify/Order/ord-${TEST_SUFFIX}-paid`;
      await sql`
        INSERT INTO "Invoice" (
          "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          "issuedAt", status, "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId}, '#PAID', '30000.00', '0.00',
          NOW(), 'paid', NOW(), NOW()
        )
      `;

      // Try to update with an order that would set status to 'open'
      const order: ShopifyOrder = {
        id: orderId,
        name: "#PAID",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PENDING", // This would normally set status to 'open'
        totalPriceSet: {
          shopMoney: { amount: "30000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
          dueInDays: 30,
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_UPDATED",
        order,
        `wh-ord-${TEST_SUFFIX}-paid-update`
      );

      // Invoice should still be paid
      const [invoice] = await sql`
        SELECT * FROM "Invoice" WHERE "orderId" = ${orderId}
      `;
      expect(invoice.status).toBe("paid");
      expect(invoice.outstanding).toBe("0.00");
    });

    it("does not downgrade cancelled invoice status on ORDERS_UPDATED", async () => {
      // Create a cancelled invoice
      const orderId = `gid://shopify/Order/ord-${TEST_SUFFIX}-cancelled`;
      await sql`
        INSERT INTO "Invoice" (
          "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          "issuedAt", status, "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId}, '#CANCELLED', '25000.00', '25000.00',
          NOW(), 'cancelled', NOW(), NOW()
        )
      `;

      // Try to update with an order that would set status to 'open'
      const order: ShopifyOrder = {
        id: orderId,
        name: "#CANCELLED",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PENDING",
        totalPriceSet: {
          shopMoney: { amount: "25000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
          dueInDays: 30,
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_UPDATED",
        order,
        `wh-ord-${TEST_SUFFIX}-cancelled-update`
      );

      // Invoice should still be cancelled
      const [invoice] = await sql`
        SELECT * FROM "Invoice" WHERE "orderId" = ${orderId}
      `;
      expect(invoice.status).toBe("cancelled");
    });

    it("does not update issuedAt or dueAt for paid invoice on ORDERS_UPDATED", async () => {
      const orderId = `gid://shopify/Order/ord-${TEST_SUFFIX}-paid-dates`;
      const originalIssuedAt = new Date("2025-06-01T00:00:00.000Z");
      const originalDueAt = new Date("2025-07-01T00:00:00.000Z");
      
      await sql`
        INSERT INTO "Invoice" (
          "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          "issuedAt", "dueAt", "dueSource", status, "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId}, '#PAID-DATES', '30000.00', '0.00',
          ${originalIssuedAt}, ${originalDueAt}, 'schedule', 'paid', NOW(), NOW()
        )
      `;

      // Try to update with different dates
      const order: ShopifyOrder = {
        id: orderId,
        name: "#PAID-DATES",
        createdAt: "2025-08-01T00:00:00.000Z", // Different date
        processedAt: "2025-07-15T00:00:00.000Z", // Different processedAt
        totalPriceSet: {
          shopMoney: { amount: "30000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
          dueInDays: 30,
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_UPDATED",
        order,
        `wh-ord-${TEST_SUFFIX}-paid-dates-update`
      );

      const [invoice] = await sql`
        SELECT * FROM "Invoice" WHERE "orderId" = ${orderId}
      `;
      
      // issuedAt and dueAt should NOT be updated for paid invoices
      expect(new Date(invoice.issuedAt).toISOString()).toBe(originalIssuedAt.toISOString());
      expect(new Date(invoice.dueAt).toISOString()).toBe(originalDueAt.toISOString());
      expect(invoice.status).toBe("paid");
    });

    it("does not update issuedAt or dueAt for cancelled invoice on ORDERS_UPDATED", async () => {
      const orderId = `gid://shopify/Order/ord-${TEST_SUFFIX}-cancelled-dates`;
      const originalIssuedAt = new Date("2025-06-01T00:00:00.000Z");
      const originalDueAt = new Date("2025-07-01T00:00:00.000Z");
      
      await sql`
        INSERT INTO "Invoice" (
          "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          "issuedAt", "dueAt", "dueSource", status, "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId}, '#CANCELLED-DATES', '25000.00', '25000.00',
          ${originalIssuedAt}, ${originalDueAt}, 'schedule', 'cancelled', NOW(), NOW()
        )
      `;

      const order: ShopifyOrder = {
        id: orderId,
        name: "#CANCELLED-DATES",
        createdAt: "2025-08-01T00:00:00.000Z",
        processedAt: "2025-07-15T00:00:00.000Z",
        totalPriceSet: {
          shopMoney: { amount: "25000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
          dueInDays: 30,
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_UPDATED",
        order,
        `wh-ord-${TEST_SUFFIX}-cancelled-dates-update`
      );

      const [invoice] = await sql`
        SELECT * FROM "Invoice" WHERE "orderId" = ${orderId}
      `;
      
      // issuedAt and dueAt should NOT be updated for cancelled invoices
      expect(new Date(invoice.issuedAt).toISOString()).toBe(originalIssuedAt.toISOString());
      expect(new Date(invoice.dueAt).toISOString()).toBe(originalDueAt.toISOString());
      expect(invoice.status).toBe("cancelled");
    });

    it("does not overwrite existing dueAt with null", async () => {
      const orderId = `gid://shopify/Order/ord-${TEST_SUFFIX}-no-null-due`;
      const originalIssuedAt = new Date("2025-06-01T00:00:00.000Z");
      const originalDueAt = new Date("2025-07-01T00:00:00.000Z");
      
      await sql`
        INSERT INTO "Invoice" (
          "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          "issuedAt", "dueAt", "dueSource", status, "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId}, '#NO-NULL-DUE', '20000.00', '20000.00',
          ${originalIssuedAt}, ${originalDueAt}, 'schedule', 'open', NOW(), NOW()
        )
      `;

      // Order with no paymentSchedules and no dueInDays (would produce null dueAt)
      const order: ShopifyOrder = {
        id: orderId,
        name: "#NO-NULL-DUE",
        createdAt: "2025-06-01T00:00:00.000Z",
        processedAt: "2025-06-01T00:00:00.000Z",
        totalPriceSet: {
          shopMoney: { amount: "20000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt",
          paymentTermsName: "Due on Receipt",
          paymentTermsType: "RECEIPT",
          // No dueInDays, no paymentSchedules
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_UPDATED",
        order,
        `wh-ord-${TEST_SUFFIX}-no-null-due-update`
      );

      const [invoice] = await sql`
        SELECT * FROM "Invoice" WHERE "orderId" = ${orderId}
      `;
      
      // dueAt should NOT be overwritten with null
      expect(invoice.dueAt).not.toBeNull();
      expect(new Date(invoice.dueAt).toISOString()).toBe(originalDueAt.toISOString());
    });

    it("updates issuedAt and dueAt for open invoice on ORDERS_UPDATED", async () => {
      const orderId = `gid://shopify/Order/ord-${TEST_SUFFIX}-open-dates`;
      const originalIssuedAt = new Date("2025-06-01T00:00:00.000Z");
      const originalDueAt = new Date("2025-07-01T00:00:00.000Z");
      
      await sql`
        INSERT INTO "Invoice" (
          "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          "issuedAt", "dueAt", "dueSource", status, "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId}, '#OPEN-DATES', '15000.00', '15000.00',
          ${originalIssuedAt}, ${originalDueAt}, 'schedule', 'open', NOW(), NOW()
        )
      `;

      const newProcessedAt = "2025-07-15T00:00:00.000Z";
      const order: ShopifyOrder = {
        id: orderId,
        name: "#OPEN-DATES",
        createdAt: "2025-08-01T00:00:00.000Z",
        processedAt: newProcessedAt, // New processedAt
        displayFinancialStatus: "PENDING",
        totalPriceSet: {
          shopMoney: { amount: "15000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
          dueInDays: 30,
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_UPDATED",
        order,
        `wh-ord-${TEST_SUFFIX}-open-dates-update`
      );

      const [invoice] = await sql`
        SELECT * FROM "Invoice" WHERE "orderId" = ${orderId}
      `;
      
      // issuedAt SHOULD be updated for open invoices
      expect(new Date(invoice.issuedAt).toISOString()).toBe(new Date(newProcessedAt).toISOString());
      // dueAt should be recalculated: processedAt + 30 days
      // The exact time depends on shop timezone (end-of-day in that timezone)
      // so we just verify the date portion is correct
      const actualDueAt = new Date(invoice.dueAt);
      expect(actualDueAt.getUTCFullYear()).toBe(2025);
      expect(actualDueAt.getUTCMonth()).toBe(7); // August (0-indexed)
      expect(actualDueAt.getUTCDate()).toBe(14); // 14th
    });

    it("updates existing invoice when totalOutstandingSet is present", async () => {
      // Create an open invoice first
      const orderId = `gid://shopify/Order/ord-${TEST_SUFFIX}-update-present`;
      await sql`
        INSERT INTO "Invoice" (
          "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          "issuedAt", status, "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId}, '#UPDATE', '50000.00', '50000.00',
          NOW(), 'open', NOW(), NOW()
        )
      `;

      // Update with new outstanding from totalOutstandingSet
      const order: ShopifyOrder = {
        id: orderId,
        name: "#UPDATE",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PARTIALLY_PAID",
        totalPriceSet: {
          shopMoney: { amount: "50000.00", currencyCode: "INR" },
        },
        totalOutstandingSet: {
          shopMoney: { amount: "30000.00", currencyCode: "INR" }, // Reduced outstanding
        },
        paymentTerms: {
          id: "pt",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
          dueInDays: 30,
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      const result = await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_UPDATED",
        order,
        `wh-ord-${TEST_SUFFIX}-update-present`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("updated");

      const [invoice] = await sql`
        SELECT * FROM "Invoice" WHERE "orderId" = ${orderId}
      `;
      expect(invoice.outstanding).toBe("30000.00");
      expect(invoice.status).toBe("open");
    });

    it("preserves paid status and outstanding when totalOutstandingSet is missing", async () => {
      // Create a PAID invoice
      const orderId = `gid://shopify/Order/ord-${TEST_SUFFIX}-paid-missing`;
      await sql`
        INSERT INTO "Invoice" (
          "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          "issuedAt", status, "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId}, '#PAID-MISSING', '50000.00', '0.00',
          NOW(), 'paid', NOW(), NOW()
        )
      `;

      // Update with order that has missing totalOutstandingSet
      const order: ShopifyOrder = {
        id: orderId,
        name: "#PAID-MISSING",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PENDING", // Would normally be open
        totalPriceSet: {
          shopMoney: { amount: "50000.00", currencyCode: "INR" },
        },
        // totalOutstandingSet intentionally missing
        paymentTerms: {
          id: "pt",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
          dueInDays: 30,
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      const result = await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_UPDATED",
        order,
        `wh-ord-${TEST_SUFFIX}-paid-missing`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("updated");

      // Invoice should KEEP paid status and 0 outstanding (not revert to open)
      const [invoice] = await sql`
        SELECT * FROM "Invoice" WHERE "orderId" = ${orderId}
      `;
      expect(invoice.status).toBe("paid");
      expect(invoice.outstanding).toBe("0.00");
    });

    it("sets cancelled status with 0 outstanding when cancelledAt is present", async () => {
      // Create an open invoice first
      const orderId = `gid://shopify/Order/ord-${TEST_SUFFIX}-cancelled-at`;
      await sql`
        INSERT INTO "Invoice" (
          "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          "issuedAt", status, "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId}, '#CANCELLED-AT', '50000.00', '50000.00',
          NOW(), 'open', NOW(), NOW()
        )
      `;

      // Update with cancelledAt set
      const order: ShopifyOrder = {
        id: orderId,
        name: "#CANCELLED-AT",
        createdAt: "2025-07-15T10:00:00.000Z",
        cancelledAt: "2025-07-20T10:00:00.000Z",
        displayFinancialStatus: "PENDING",
        totalPriceSet: {
          shopMoney: { amount: "50000.00", currencyCode: "INR" },
        },
        totalOutstandingSet: {
          shopMoney: { amount: "50000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
          dueInDays: 30,
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      const result = await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_UPDATED",
        order,
        `wh-ord-${TEST_SUFFIX}-cancelled-at`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("updated");

      const [invoice] = await sql`
        SELECT * FROM "Invoice" WHERE "orderId" = ${orderId}
      `;
      expect(invoice.status).toBe("cancelled");
      expect(invoice.outstanding).toBe("0.00");
    });

    it("increments order_outstanding_missing counter when field is missing", async () => {
      // Table created by migration 20261026010000_order_outstanding_missing
      // Clean up any existing counter for this shop
      await sql`DELETE FROM order_outstanding_missing WHERE shop = ${TEST_SHOP_DOMAIN}`;

      // Process an order with missing totalOutstandingSet
      const order: ShopifyOrder = {
        id: `gid://shopify/Order/ord-${TEST_SUFFIX}-counter`,
        name: "#COUNTER",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PENDING",
        totalPriceSet: {
          shopMoney: { amount: "25000.00", currencyCode: "INR" },
        },
        // totalOutstandingSet intentionally missing
        paymentTerms: {
          id: "pt",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
          dueInDays: 30,
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      const result = await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_CREATE",
        order,
        `wh-ord-${TEST_SUFFIX}-counter`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("created");

      // Counter should have been incremented
      const [counter] = await sql<{ count: number }[]>`
        SELECT count FROM order_outstanding_missing
        WHERE shop = ${TEST_SHOP_DOMAIN} AND day = CURRENT_DATE
      `;
      expect(counter?.count).toBeGreaterThanOrEqual(1);
    });
  });

  describe("mapOrderToInvoice", () => {
    it("maps order with payment schedule dueAt", () => {
      const order: ShopifyOrder = {
        id: "gid://shopify/Order/123",
        name: "#1001",
        createdAt: "2025-07-15T10:00:00.000Z",
        totalPriceSet: {
          shopMoney: { amount: "100000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt1",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
          paymentSchedules: {
            edges: [
              {
                node: {
                  id: "ps1",
                  dueAt: "2025-08-14T23:59:59.999Z",
                  issuedAt: "2025-07-15T10:00:00.000Z",
                  amount: { amount: "100000.00", currencyCode: "INR" },
                },
              },
            ],
          },
        },
      };

      const result = mapOrderToInvoice("shop-1", "account-1", order);

      expect(result.orderId).toBe("gid://shopify/Order/123");
      expect(result.total).toBe("100000.00");
      expect(result.outstanding).toBe("100000.00");
      expect(result.dueSource).toBe("schedule");
      expect(result.dueAt).toEqual(new Date("2025-08-14T23:59:59.999Z"));
      expect(result.dueReason).toContain("Payment schedule");
    });

    it("calculates dueAt from dueInDays when no schedule", () => {
      const order: ShopifyOrder = {
        id: "gid://shopify/Order/456",
        name: "#1002",
        createdAt: "2025-07-01T00:00:00.000Z",
        totalPriceSet: {
          shopMoney: { amount: "50000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt2",
          paymentTermsName: "Net 45",
          paymentTermsType: "NET",
          dueInDays: 45,
        },
      };

      const result = mapOrderToInvoice("shop-1", "account-1", order);

      expect(result.dueSource).toBe("schedule");
      expect(result.dueBasis).toBe("paymentTermsDueInDays");
      // 2025-07-01 + 45 days = 2025-08-15
      const expectedDue = new Date("2025-07-01T00:00:00.000Z");
      expectedDue.setUTCDate(expectedDue.getUTCDate() + 45);
      expect(result.dueAt?.toISOString()).toBe(expectedDue.toISOString());
    });

    it("sets status cancelled for cancelled orders", () => {
      const order: ShopifyOrder = {
        id: "gid://shopify/Order/789",
        name: "#1003",
        createdAt: "2025-07-15T10:00:00.000Z",
        cancelledAt: "2025-07-16T10:00:00.000Z",
        totalPriceSet: {
          shopMoney: { amount: "25000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt3",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
      };

      const result = mapOrderToInvoice("shop-1", "account-1", order);

      expect(result.status).toBe("cancelled");
    });

    it("sets status paid and outstanding 0 for paid orders", () => {
      const order: ShopifyOrder = {
        id: "gid://shopify/Order/101",
        name: "#1004",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PAID",
        totalPriceSet: {
          shopMoney: { amount: "75000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt4",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
      };

      const result = mapOrderToInvoice("shop-1", "account-1", order);

      expect(result.status).toBe("paid");
      expect(result.outstanding).toBe("0.00");
    });

    it("sets status cancelled and outstanding 0 for REFUNDED orders", () => {
      const order: ShopifyOrder = {
        id: "gid://shopify/Order/refunded-1",
        name: "#REFUNDED",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "REFUNDED",
        totalPriceSet: {
          shopMoney: { amount: "50000.00", currencyCode: "INR" },
        },
        totalOutstandingSet: {
          shopMoney: { amount: "0.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt-refunded",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
      };

      const result = mapOrderToInvoice("shop-1", "account-1", order);

      expect(result.status).toBe("cancelled");
      expect(result.outstanding).toBe("0.00");
    });

    it("sets status cancelled and outstanding 0 for VOIDED orders", () => {
      const order: ShopifyOrder = {
        id: "gid://shopify/Order/voided-1",
        name: "#VOIDED",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "VOIDED",
        totalPriceSet: {
          shopMoney: { amount: "30000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt-voided",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
      };

      const result = mapOrderToInvoice("shop-1", "account-1", order);

      expect(result.status).toBe("cancelled");
      expect(result.outstanding).toBe("0.00");
    });

    it("uses totalOutstandingSet for PARTIALLY_REFUNDED orders", () => {
      const order: ShopifyOrder = {
        id: "gid://shopify/Order/partial-refund-1",
        name: "#PARTIAL_REFUND",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PARTIALLY_REFUNDED",
        totalPriceSet: {
          shopMoney: { amount: "100000.00", currencyCode: "INR" },
        },
        totalOutstandingSet: {
          shopMoney: { amount: "75000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt-partial",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
      };

      const result = mapOrderToInvoice("shop-1", "account-1", order);

      // Status is open (balance remains)
      expect(result.status).toBe("open");
      // Outstanding comes from totalOutstandingSet
      expect(result.outstanding).toBe("75000.00");
      // Total should remain unchanged
      expect(result.total).toBe("100000.00");
    });

    it("sets status paid when PARTIALLY_REFUNDED has 0 outstanding (paid-then-refunded)", () => {
      // A paid-then-partially-refunded order should not show a receivable
      const order: ShopifyOrder = {
        id: "gid://shopify/Order/paid-then-refunded-1",
        name: "#PAID_THEN_REFUNDED",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PARTIALLY_REFUNDED",
        totalPriceSet: {
          shopMoney: { amount: "100000.00", currencyCode: "INR" },
        },
        totalOutstandingSet: {
          shopMoney: { amount: "0.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt-paid-refunded",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
      };

      const result = mapOrderToInvoice("shop-1", "account-1", order);

      // Outstanding 0 means effectively paid
      expect(result.status).toBe("paid");
      expect(result.outstanding).toBe("0.00");
    });

    it("uses totalOutstandingSet for PARTIALLY_PAID orders", () => {
      const order: ShopifyOrder = {
        id: "gid://shopify/Order/partial-paid-1",
        name: "#PARTIAL_PAID",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PARTIALLY_PAID",
        totalPriceSet: {
          shopMoney: { amount: "100000.00", currencyCode: "INR" },
        },
        totalOutstandingSet: {
          shopMoney: { amount: "40000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt-partial-paid",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
      };

      const result = mapOrderToInvoice("shop-1", "account-1", order);

      expect(result.status).toBe("open");
      expect(result.outstanding).toBe("40000.00");
    });

    it("sets status cancelled and outstanding 0 when cancelledAt is set", () => {
      // P3: cancelledAt takes precedence over other statuses
      const order: ShopifyOrder = {
        id: "gid://shopify/Order/cancelled-1",
        name: "#CANCELLED",
        createdAt: "2025-07-15T10:00:00.000Z",
        cancelledAt: "2025-07-16T10:00:00.000Z",
        displayFinancialStatus: "PENDING", // Even though PENDING, cancelled overrides
        totalPriceSet: {
          shopMoney: { amount: "50000.00", currencyCode: "INR" },
        },
        totalOutstandingSet: {
          shopMoney: { amount: "50000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt-cancelled",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
      };

      const result = mapOrderToInvoice("shop-1", "account-1", order);

      expect(result.status).toBe("cancelled");
      expect(result.outstanding).toBe("0.00");
    });

    it("uses total when totalOutstandingSet is missing (new invoice)", () => {
      // Reset counter before test
      getAndResetOutstandingMissingCounter();

      const order: ShopifyOrder = {
        id: "gid://shopify/Order/missing-outstanding-1",
        name: "#MISSING_OUTSTANDING",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PENDING",
        totalPriceSet: {
          shopMoney: { amount: "75000.00", currencyCode: "INR" },
        },
        // totalOutstandingSet intentionally missing
        paymentTerms: {
          id: "pt-missing",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
      };

      const result = mapOrderToInvoice("shop-1", "account-1", order);

      // Falls back to total for new invoices
      expect(result.outstanding).toBe("75000.00");
      expect(result.status).toBe("open");
      // Counter should have incremented
      expect(getAndResetOutstandingMissingCounter()).toBe(1);
    });

    it("uses processedAt for issuedAt when processedAt is 35 days before createdAt", () => {
      // Simulate a backdated order via orderCreate: processedAt is 35 days before createdAt
      // S6 sync must use processedAt (not createdAt) for issuedAt
      const now = new Date("2025-08-01T12:00:00.000Z");
      const processedAt = new Date(now);
      processedAt.setUTCDate(processedAt.getUTCDate() - 35); // 35 days before createdAt

      const order: ShopifyOrder = {
        id: "gid://shopify/Order/backdated-1",
        name: "#BACKDATED",
        createdAt: now.toISOString(), // When API call was made
        processedAt: processedAt.toISOString(), // Backdated via orderCreate processedAt
        totalPriceSet: {
          shopMoney: { amount: "100000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt-backdated",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
          dueInDays: 30,
        },
      };

      const result = mapOrderToInvoice("shop-1", "account-1", order);

      // issuedAt MUST equal processedAt, NOT createdAt
      expect(result.issuedAt.toISOString()).toBe(processedAt.toISOString());
      expect(result.issuedAt.toISOString()).not.toBe(now.toISOString());

      // Due date should be processedAt + 30 days (5 days before createdAt)
      const expectedDueAt = new Date(processedAt);
      expectedDueAt.setUTCDate(expectedDueAt.getUTCDate() + 30);
      expect(result.dueAt?.toISOString()).toBe(expectedDueAt.toISOString());

      // This order would be 5 days overdue as of createdAt
      expect(result.dueAt!.getTime()).toBeLessThan(now.getTime());
    });

    it("falls back to createdAt when processedAt is null", () => {
      const createdAt = "2025-07-15T10:00:00.000Z";
      const order: ShopifyOrder = {
        id: "gid://shopify/Order/no-processed",
        name: "#NO_PROCESSED",
        createdAt,
        processedAt: null, // Explicitly null
        totalPriceSet: {
          shopMoney: { amount: "50000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt-no-processed",
          paymentTermsName: "Net 15",
          paymentTermsType: "NET",
          dueInDays: 15,
        },
      };

      const result = mapOrderToInvoice("shop-1", "account-1", order);

      // issuedAt should fall back to createdAt
      expect(result.issuedAt.toISOString()).toBe(createdAt);
    });

    it("falls back to createdAt when processedAt is undefined", () => {
      const createdAt = "2025-07-15T10:00:00.000Z";
      const order: ShopifyOrder = {
        id: "gid://shopify/Order/no-processed-2",
        name: "#NO_PROCESSED_2",
        createdAt,
        // processedAt not set (undefined)
        totalPriceSet: {
          shopMoney: { amount: "50000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt-no-processed-2",
          paymentTermsName: "Net 15",
          paymentTermsType: "NET",
          dueInDays: 15,
        },
      };

      const result = mapOrderToInvoice("shop-1", "account-1", order);

      // issuedAt should fall back to createdAt
      expect(result.issuedAt.toISOString()).toBe(createdAt);
    });
  });

  describe("mapOrderToInvoiceWithEligibility", () => {
    const mockEligibility: EligibilityResult = {
      eligible: true,
      reason: "shopify_payment_terms",
      buyerAccountId: "account-1",
      explanation: "Order has payment terms",
      dueDate: {
        dueAt: new Date("2025-08-14T23:59:59.999Z"),
        dueSource: "schedule",
        basis: "paymentTermsDueInDays",
        reason: "Net 30 days",
      },
    };

    it("returns outstandingMissing=true when totalOutstandingSet is missing", () => {
      getAndResetOutstandingMissingCounter();

      const order: ShopifyOrder = {
        id: "gid://shopify/Order/missing-elig-1",
        name: "#MISSING_ELIG",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PENDING",
        totalPriceSet: {
          shopMoney: { amount: "50000.00", currencyCode: "INR" },
        },
        // totalOutstandingSet intentionally missing
        paymentTerms: {
          id: "pt",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
      };

      const { invoiceData, outstandingMissing } = mapOrderToInvoiceWithEligibility(
        "shop-1",
        "account-1",
        order,
        mockEligibility
      );

      expect(outstandingMissing).toBe(true);
      expect(invoiceData.outstanding).toBe("50000.00");
      expect(invoiceData.status).toBe("open");
    });

    it("returns outstandingMissing=false when totalOutstandingSet is present", () => {
      const order: ShopifyOrder = {
        id: "gid://shopify/Order/present-elig-1",
        name: "#PRESENT_ELIG",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PENDING",
        totalPriceSet: {
          shopMoney: { amount: "50000.00", currencyCode: "INR" },
        },
        totalOutstandingSet: {
          shopMoney: { amount: "30000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
      };

      const { invoiceData, outstandingMissing } = mapOrderToInvoiceWithEligibility(
        "shop-1",
        "account-1",
        order,
        mockEligibility
      );

      expect(outstandingMissing).toBe(false);
      expect(invoiceData.outstanding).toBe("30000.00");
      expect(invoiceData.status).toBe("open");
    });

    it("preserves existing paid status when totalOutstandingSet is missing", () => {
      getAndResetOutstandingMissingCounter();

      const order: ShopifyOrder = {
        id: "gid://shopify/Order/preserve-paid-1",
        name: "#PRESERVE_PAID",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PENDING", // Would normally be open
        totalPriceSet: {
          shopMoney: { amount: "50000.00", currencyCode: "INR" },
        },
        // totalOutstandingSet intentionally missing
        paymentTerms: {
          id: "pt",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
      };

      // Simulate existing paid invoice
      const { invoiceData, outstandingMissing } = mapOrderToInvoiceWithEligibility(
        "shop-1",
        "account-1",
        order,
        mockEligibility,
        { outstanding: "0.00", status: "paid" }
      );

      expect(outstandingMissing).toBe(true);
      // Should preserve BOTH existing outstanding AND status
      expect(invoiceData.outstanding).toBe("0.00");
      expect(invoiceData.status).toBe("paid");
    });

    it("preserves existing cancelled status when totalOutstandingSet is missing", () => {
      getAndResetOutstandingMissingCounter();

      const order: ShopifyOrder = {
        id: "gid://shopify/Order/preserve-cancelled-1",
        name: "#PRESERVE_CANCELLED",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PENDING",
        totalPriceSet: {
          shopMoney: { amount: "50000.00", currencyCode: "INR" },
        },
        // totalOutstandingSet intentionally missing
        paymentTerms: {
          id: "pt",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
      };

      // Simulate existing cancelled invoice
      const { invoiceData, outstandingMissing } = mapOrderToInvoiceWithEligibility(
        "shop-1",
        "account-1",
        order,
        mockEligibility,
        { outstanding: "25000.00", status: "cancelled" }
      );

      expect(outstandingMissing).toBe(true);
      // Should preserve BOTH existing outstanding AND status
      expect(invoiceData.outstanding).toBe("25000.00");
      expect(invoiceData.status).toBe("cancelled");
    });

    it("uses totalOutstandingSet even when existing invoice data is provided", () => {
      const order: ShopifyOrder = {
        id: "gid://shopify/Order/override-existing-1",
        name: "#OVERRIDE_EXISTING",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PARTIALLY_PAID",
        totalPriceSet: {
          shopMoney: { amount: "50000.00", currencyCode: "INR" },
        },
        totalOutstandingSet: {
          shopMoney: { amount: "20000.00", currencyCode: "INR" }, // New value from Shopify
        },
        paymentTerms: {
          id: "pt",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
      };

      // Simulate existing invoice with different outstanding
      const { invoiceData, outstandingMissing } = mapOrderToInvoiceWithEligibility(
        "shop-1",
        "account-1",
        order,
        mockEligibility,
        { outstanding: "50000.00", status: "open" }
      );

      expect(outstandingMissing).toBe(false);
      // Should use totalOutstandingSet value, not the existing value
      expect(invoiceData.outstanding).toBe("20000.00");
      expect(invoiceData.status).toBe("open");
    });

    it("sets cancelled status and 0 outstanding when cancelledAt is present regardless of existing data", () => {
      const order: ShopifyOrder = {
        id: "gid://shopify/Order/cancelled-override-1",
        name: "#CANCELLED_OVERRIDE",
        createdAt: "2025-07-15T10:00:00.000Z",
        cancelledAt: "2025-07-20T10:00:00.000Z",
        displayFinancialStatus: "PENDING",
        totalPriceSet: {
          shopMoney: { amount: "50000.00", currencyCode: "INR" },
        },
        totalOutstandingSet: {
          shopMoney: { amount: "50000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
      };

      // Simulate existing open invoice
      const { invoiceData, outstandingMissing } = mapOrderToInvoiceWithEligibility(
        "shop-1",
        "account-1",
        order,
        mockEligibility,
        { outstanding: "50000.00", status: "open" }
      );

      // cancelledAt takes precedence over everything
      expect(outstandingMissing).toBe(false);
      expect(invoiceData.status).toBe("cancelled");
      expect(invoiceData.outstanding).toBe("0.00");
    });

    it("bulk reconcile: preserves existing status=paid when totalOutstandingSet is missing", () => {
      // P2 fix: bulk-jsonl-processor passes existing invoice data to mapOrderToInvoiceWithEligibility
      const order: ShopifyOrder = {
        id: "gid://shopify/Order/bulk-paid-missing-1",
        name: "#BULK_PAID_MISSING",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PARTIALLY_PAID",
        totalPriceSet: {
          shopMoney: { amount: "50000.00", currencyCode: "INR" },
        },
        // totalOutstandingSet intentionally missing (simulates rare API response)
        paymentTerms: {
          id: "pt",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
      };

      // Simulate existing paid invoice being updated via bulk reconcile
      const { invoiceData, outstandingMissing } = mapOrderToInvoiceWithEligibility(
        "shop-1",
        "account-1",
        order,
        mockEligibility,
        { outstanding: "0.00", status: "paid" }
      );

      // Should preserve existing status=paid (not revert to open)
      expect(outstandingMissing).toBe(true);
      expect(invoiceData.status).toBe("paid");
      expect(invoiceData.outstanding).toBe("0.00");
    });

    it("bulk reconcile: preserves existing status=cancelled when totalOutstandingSet is missing", () => {
      // P2 fix: bulk-jsonl-processor passes existing invoice data to mapOrderToInvoiceWithEligibility
      const order: ShopifyOrder = {
        id: "gid://shopify/Order/bulk-cancelled-missing-1",
        name: "#BULK_CANCELLED_MISSING",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PARTIALLY_PAID",
        totalPriceSet: {
          shopMoney: { amount: "50000.00", currencyCode: "INR" },
        },
        // totalOutstandingSet intentionally missing
        paymentTerms: {
          id: "pt",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
      };

      // Simulate existing cancelled invoice being updated via bulk reconcile
      const { invoiceData, outstandingMissing } = mapOrderToInvoiceWithEligibility(
        "shop-1",
        "account-1",
        order,
        mockEligibility,
        { outstanding: "0.00", status: "cancelled" }
      );

      // Should preserve existing status=cancelled (not revert to open)
      expect(outstandingMissing).toBe(true);
      expect(invoiceData.status).toBe("cancelled");
      expect(invoiceData.outstanding).toBe("0.00");
    });
  });
});

/**
 * DB-backed tests for bulk JSONL processor's existing invoice handling.
 * These tests go through the real processOrderLines path to verify the
 * P2 fix: bulk reconcile passes existing invoice data to mapOrderToInvoiceWithEligibility.
 */
import { processOrderLines } from "../bulk-jsonl-processor.server";

describeWithDb("Bulk JSONL Processor - existing invoice handling (DB-backed)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = `bulk-${Date.now().toString(36)}`;
  const TEST_SHOP_ID = `shop-bulk-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `bulk-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `account-bulk-${TEST_SUFFIX}`;
  const TEST_COMPANY_ID = `gid://shopify/Company/co-bulk-${TEST_SUFFIX}`;
  const TEST_LOCATION_ID = `gid://shopify/CompanyLocation/loc-bulk-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop with payment terms enabled
    await sql`
      INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, NOW(), NOW())
    `;

    // Create test buyer account (COMPANY) with explicit terms
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "defaultTermsDays", "defaultTermsSource",
        "createdAt", "updatedAt"
      ) VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY', ${TEST_COMPANY_ID}, ${TEST_LOCATION_ID}, 'Bulk Test Company',
        30, 'explicit',
        NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    // Clean up queue messages for this shop before deleting it (prevents flakes in later test files)
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;

    await sql`DELETE FROM order_outstanding_missing WHERE shop = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;

    await assertNoQueueLeftovers(sql, [TEST_SHOP_DOMAIN], "order.test.ts (bulk)");

    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM order_outstanding_missing WHERE shop = ${TEST_SHOP_DOMAIN}`;
  });

  it("preserves existing paid invoice when totalOutstandingSet is missing in JSONL", async () => {
    const orderId = `gid://shopify/Order/bulk-paid-${TEST_SUFFIX}`;

    // Seed existing paid invoice
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status,
        "issuedAt", "createdAt", "updatedAt"
      ) VALUES (
        gen_random_uuid()::text, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#BULK-PAID', '50000.00', '0.00', 'paid',
        NOW(), NOW(), NOW()
      )
    `;

    // JSONL line for the same order but WITHOUT totalOutstandingSet
    const jsonlLine = JSON.stringify({
      id: orderId,
      name: "#BULK-PAID",
      createdAt: "2025-07-15T10:00:00.000Z",
      displayFinancialStatus: "PARTIALLY_PAID",
      totalPriceSet: { shopMoney: { amount: "50000.00", currencyCode: "INR" } },
      // totalOutstandingSet intentionally missing
      purchasingEntity: {
        __typename: "PurchasingCompany",
        company: { id: TEST_COMPANY_ID },
        location: { id: TEST_LOCATION_ID },
      },
    });

    // Process through real bulk path
    const upserted = await processOrderLines(sql, TEST_SHOP_ID, TEST_SHOP_DOMAIN, [jsonlLine]);
    expect(upserted).toBe(1);

    // Verify invoice is still paid with outstanding 0.00
    const [invoice] = await sql<{ status: string; outstanding: string }[]>`
      SELECT status, outstanding::text FROM "Invoice"
      WHERE "shopId" = ${TEST_SHOP_ID} AND "orderId" = ${orderId}
    `;
    expect(invoice.status).toBe("paid");
    expect(invoice.outstanding).toBe("0.00");

    // Verify counter was incremented by exactly 1
    const [counter] = await sql<{ count: number }[]>`
      SELECT count FROM order_outstanding_missing
      WHERE shop = ${TEST_SHOP_DOMAIN} AND day = CURRENT_DATE
    `;
    expect(counter.count).toBe(1);
  });

  it("preserves existing cancelled invoice when totalOutstandingSet is missing in JSONL", async () => {
    const orderId = `gid://shopify/Order/bulk-cancelled-${TEST_SUFFIX}`;

    // Seed existing cancelled invoice
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status,
        "issuedAt", "createdAt", "updatedAt"
      ) VALUES (
        gen_random_uuid()::text, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#BULK-CANCELLED', '30000.00', '0.00', 'cancelled',
        NOW(), NOW(), NOW()
      )
    `;

    // JSONL line for the same order but WITHOUT totalOutstandingSet
    const jsonlLine = JSON.stringify({
      id: orderId,
      name: "#BULK-CANCELLED",
      createdAt: "2025-07-15T10:00:00.000Z",
      displayFinancialStatus: "PENDING",
      totalPriceSet: { shopMoney: { amount: "30000.00", currencyCode: "INR" } },
      // totalOutstandingSet intentionally missing
      purchasingEntity: {
        __typename: "PurchasingCompany",
        company: { id: TEST_COMPANY_ID },
        location: { id: TEST_LOCATION_ID },
      },
    });

    // Process through real bulk path
    const upserted = await processOrderLines(sql, TEST_SHOP_ID, TEST_SHOP_DOMAIN, [jsonlLine]);
    expect(upserted).toBe(1);

    // Verify invoice is still cancelled with outstanding 0.00
    const [invoice] = await sql<{ status: string; outstanding: string }[]>`
      SELECT status, outstanding::text FROM "Invoice"
      WHERE "shopId" = ${TEST_SHOP_ID} AND "orderId" = ${orderId}
    `;
    expect(invoice.status).toBe("cancelled");
    expect(invoice.outstanding).toBe("0.00");

    // Verify counter was incremented
    const [counter] = await sql<{ count: number }[]>`
      SELECT count FROM order_outstanding_missing
      WHERE shop = ${TEST_SHOP_DOMAIN} AND day = CURRENT_DATE
    `;
    expect(counter.count).toBe(1);
  });

  it("updates existing open invoice normally when totalOutstandingSet is present", async () => {
    const orderId = `gid://shopify/Order/bulk-open-${TEST_SUFFIX}`;

    // Seed existing open invoice with high outstanding
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status,
        "issuedAt", "createdAt", "updatedAt"
      ) VALUES (
        gen_random_uuid()::text, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#BULK-OPEN', '50000.00', '50000.00', 'open',
        NOW(), NOW(), NOW()
      )
    `;

    // JSONL line WITH totalOutstandingSet showing partial payment
    const jsonlLine = JSON.stringify({
      id: orderId,
      name: "#BULK-OPEN",
      createdAt: "2025-07-15T10:00:00.000Z",
      displayFinancialStatus: "PARTIALLY_PAID",
      totalPriceSet: { shopMoney: { amount: "50000.00", currencyCode: "INR" } },
      totalOutstandingSet: { shopMoney: { amount: "25000.00", currencyCode: "INR" } },
      purchasingEntity: {
        __typename: "PurchasingCompany",
        company: { id: TEST_COMPANY_ID },
        location: { id: TEST_LOCATION_ID },
      },
    });

    // Process through real bulk path
    const upserted = await processOrderLines(sql, TEST_SHOP_ID, TEST_SHOP_DOMAIN, [jsonlLine]);
    expect(upserted).toBe(1);

    // Verify invoice was updated with new outstanding
    const [invoice] = await sql<{ status: string; outstanding: string }[]>`
      SELECT status, outstanding::text FROM "Invoice"
      WHERE "shopId" = ${TEST_SHOP_ID} AND "orderId" = ${orderId}
    `;
    expect(invoice.status).toBe("open");
    expect(invoice.outstanding).toBe("25000.00");

    // Verify counter was NOT incremented (field was present)
    const counterRows = await sql<{ count: number }[]>`
      SELECT count FROM order_outstanding_missing
      WHERE shop = ${TEST_SHOP_DOMAIN} AND day = CURRENT_DATE
    `;
    expect(counterRows.length).toBe(0);
  });

  it("increments counter by exact number of missing orders in batch", async () => {
    const orderIds = [
      `gid://shopify/Order/bulk-batch-1-${TEST_SUFFIX}`,
      `gid://shopify/Order/bulk-batch-2-${TEST_SUFFIX}`,
      `gid://shopify/Order/bulk-batch-3-${TEST_SUFFIX}`,
    ];

    // Seed 3 existing paid invoices
    for (const orderId of orderIds) {
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status,
          "issuedAt", "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#BATCH', '10000.00', '0.00', 'paid',
          NOW(), NOW(), NOW()
        )
      `;
    }

    // 3 JSONL lines all missing totalOutstandingSet
    const jsonlLines = orderIds.map((orderId) =>
      JSON.stringify({
        id: orderId,
        name: "#BATCH",
        createdAt: "2025-07-15T10:00:00.000Z",
        displayFinancialStatus: "PARTIALLY_PAID",
        totalPriceSet: { shopMoney: { amount: "10000.00", currencyCode: "INR" } },
        // totalOutstandingSet intentionally missing
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      })
    );

    // Process through real bulk path
    const upserted = await processOrderLines(sql, TEST_SHOP_ID, TEST_SHOP_DOMAIN, jsonlLines);
    expect(upserted).toBe(3);

    // Verify counter was incremented by exactly 3 (not 3 separate increments)
    const [counter] = await sql<{ count: number }[]>`
      SELECT count FROM order_outstanding_missing
      WHERE shop = ${TEST_SHOP_DOMAIN} AND day = CURRENT_DATE
    `;
    expect(counter.count).toBe(3);
  });
});
