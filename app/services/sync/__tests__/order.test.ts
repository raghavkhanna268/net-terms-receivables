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
  });
});
