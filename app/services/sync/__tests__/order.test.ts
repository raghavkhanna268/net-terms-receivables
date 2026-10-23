import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { processOrderWebhook, mapOrderToInvoice } from "../order.server";
import type { ShopifyOrder } from "../types";

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
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${"wh-ord-" + TEST_SUFFIX + "%"}`;
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

    it("skips orders without payment terms", async () => {
      const order: ShopifyOrder = {
        id: `gid://shopify/Order/ord-${TEST_SUFFIX}-2`,
        name: "#1002",
        createdAt: "2025-07-15T10:00:00.000Z",
        totalPriceSet: {
          shopMoney: { amount: "1000.00", currencyCode: "INR" },
        },
        paymentTerms: null, // No payment terms
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
      expect(result.skipReason).toContain("no payment terms");

      // No invoice should be created
      const invoices = await sql`
        SELECT * FROM "Invoice" WHERE "orderId" = ${order.id}
      `;
      expect(invoices).toHaveLength(0);
    });

    it("fails when company not yet synced (returns false for retry)", async () => {
      const unknownCompanyId = `gid://shopify/Company/unknown-${TEST_SUFFIX}`;
      const unknownLocationId = `gid://shopify/CompanyLocation/unknown-${TEST_SUFFIX}`;

      const order: ShopifyOrder = {
        id: `gid://shopify/Order/ord-${TEST_SUFFIX}-3`,
        name: "#1003",
        createdAt: "2025-07-15T10:00:00.000Z",
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
      expect(result.error).toContain("Buyer account not found");
      expect(result.error).toContain("Company may not be synced");
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
      const expectedDueAt = new Date(newProcessedAt);
      expectedDueAt.setDate(expectedDueAt.getDate() + 30);
      expect(new Date(invoice.dueAt).toISOString()).toBe(expectedDueAt.toISOString());
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
                  amount: { shopMoney: { amount: "100000.00", currencyCode: "INR" } },
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
      expectedDue.setDate(expectedDue.getDate() + 45);
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

    it("uses processedAt for issuedAt when processedAt is 35 days before createdAt", () => {
      // Simulate a backdated order via orderCreate: processedAt is 35 days before createdAt
      // S6 sync must use processedAt (not createdAt) for issuedAt
      const now = new Date("2025-08-01T12:00:00.000Z");
      const processedAt = new Date(now);
      processedAt.setDate(processedAt.getDate() - 35); // 35 days before createdAt

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
      expectedDueAt.setDate(expectedDueAt.getDate() + 30);
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
});
