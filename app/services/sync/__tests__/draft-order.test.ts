import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import {
  processDraftOrderWebhook,
  mapDraftOrder,
  bulkUpsertDraftOrders,
  getPendingExposure,
} from "../draft-order.server";
import type { ShopifyDraftOrder } from "../types";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("Draft Order Sync", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36);
  const TEST_SHOP_ID = `shop-draft-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `draft-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `account-draft-${TEST_SUFFIX}`;
  const TEST_COMPANY_ID = `gid://shopify/Company/co-draft-${TEST_SUFFIX}`;
  const TEST_LOCATION_ID = `gid://shopify/CompanyLocation/loc-draft-${TEST_SUFFIX}`;

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

    // Create draft orders table if not exists
    await sql`
      CREATE TABLE IF NOT EXISTS s8_draft_orders (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        shop_id TEXT NOT NULL,
        draft_order_id TEXT NOT NULL,
        buyer_account_id TEXT,
        name TEXT NOT NULL,
        total NUMERIC(14, 2) NOT NULL,
        has_payment_terms BOOLEAN NOT NULL DEFAULT false,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT s8_draft_orders_shop_draft_unique UNIQUE (shop_id, draft_order_id)
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM s8_draft_orders WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${"wh-draft-" + TEST_SUFFIX + "%"}`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM s8_draft_orders WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${"wh-draft-" + TEST_SUFFIX + "%"}`;
  });

  describe("processDraftOrderWebhook", () => {
    it("creates draft order record when payment terms present", async () => {
      const draftOrder: ShopifyDraftOrder = {
        id: `gid://shopify/DraftOrder/draft-${TEST_SUFFIX}-1`,
        name: "#D1",
        createdAt: "2025-07-15T10:00:00.000Z",
        status: "open",
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

      const result = await processDraftOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "DRAFT_ORDERS_CREATE",
        draftOrder,
        `wh-draft-${TEST_SUFFIX}-1`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("created");
      expect(result.entityId).toBeDefined();

      // Verify draft order was tracked
      const [tracked] = await sql`
        SELECT * FROM s8_draft_orders WHERE id = ${result.entityId!}
      `;
      expect(tracked.draft_order_id).toBe(draftOrder.id);
      expect(tracked.buyer_account_id).toBe(TEST_ACCOUNT_ID);
      expect(tracked.name).toBe("#D1");
      expect(tracked.total).toBe("50000.00");
      expect(tracked.has_payment_terms).toBe(true);
      expect(tracked.status).toBe("open");
    });

    it("skips draft orders without payment terms", async () => {
      const draftOrder: ShopifyDraftOrder = {
        id: `gid://shopify/DraftOrder/draft-${TEST_SUFFIX}-2`,
        name: "#D2",
        createdAt: "2025-07-15T10:00:00.000Z",
        totalPriceSet: {
          shopMoney: { amount: "10000.00", currencyCode: "INR" },
        },
        paymentTerms: null, // No payment terms
      };

      const result = await processDraftOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "DRAFT_ORDERS_CREATE",
        draftOrder,
        `wh-draft-${TEST_SUFFIX}-2`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("no payment terms");

      // No record should be created
      const records = await sql`
        SELECT * FROM s8_draft_orders WHERE draft_order_id = ${draftOrder.id}
      `;
      expect(records).toHaveLength(0);
    });

    it("updates draft order on DRAFT_ORDERS_UPDATE", async () => {
      const draftOrderId = `gid://shopify/DraftOrder/draft-${TEST_SUFFIX}-3`;

      // Create initial record
      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftOrderId}, ${TEST_ACCOUNT_ID}, '#D3', '20000.00',
          true, 'open', NOW()
        )
      `;

      const draftOrder: ShopifyDraftOrder = {
        id: draftOrderId,
        name: "#D3",
        createdAt: "2025-07-15T10:00:00.000Z",
        status: "invoice_sent",
        totalPriceSet: {
          shopMoney: { amount: "25000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt1",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      const result = await processDraftOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "DRAFT_ORDERS_UPDATE",
        draftOrder,
        `wh-draft-${TEST_SUFFIX}-3`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("updated");

      const [updated] = await sql`
        SELECT * FROM s8_draft_orders WHERE draft_order_id = ${draftOrderId}
      `;
      expect(updated.total).toBe("25000.00");
      expect(updated.status).toBe("invoice_sent");
    });

    it("deletes draft order on DRAFT_ORDERS_DELETE", async () => {
      const draftOrderId = `gid://shopify/DraftOrder/draft-${TEST_SUFFIX}-4`;

      // Create record to delete
      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftOrderId}, ${TEST_ACCOUNT_ID}, '#D4', '15000.00',
          true, 'open', NOW()
        )
      `;

      const draftOrder: ShopifyDraftOrder = {
        id: draftOrderId,
        name: "#D4",
        createdAt: "2025-07-15T10:00:00.000Z",
      };

      const result = await processDraftOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "DRAFT_ORDERS_DELETE",
        draftOrder,
        `wh-draft-${TEST_SUFFIX}-4`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("deleted");

      // Record should be gone
      const records = await sql`
        SELECT * FROM s8_draft_orders WHERE draft_order_id = ${draftOrderId}
      `;
      expect(records).toHaveLength(0);
    });

    it("handles delete of non-existent draft order gracefully", async () => {
      const draftOrder: ShopifyDraftOrder = {
        id: `gid://shopify/DraftOrder/nonexistent-${TEST_SUFFIX}`,
        name: "#D99",
        createdAt: "2025-07-15T10:00:00.000Z",
      };

      const result = await processDraftOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "DRAFT_ORDERS_DELETE",
        draftOrder,
        `wh-draft-${TEST_SUFFIX}-nonexistent`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("not found");
    });

    it("is idempotent - skips duplicate webhooks", async () => {
      const draftOrder: ShopifyDraftOrder = {
        id: `gid://shopify/DraftOrder/draft-${TEST_SUFFIX}-idem`,
        name: "#DIDEM",
        createdAt: "2025-07-15T10:00:00.000Z",
        totalPriceSet: {
          shopMoney: { amount: "30000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt1",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      const webhookId = `wh-draft-${TEST_SUFFIX}-idem`;

      // First call
      const result1 = await processDraftOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "DRAFT_ORDERS_CREATE",
        draftOrder,
        webhookId
      );
      expect(result1.action).toBe("created");

      // Second call with same webhook ID
      const result2 = await processDraftOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "DRAFT_ORDERS_CREATE",
        draftOrder,
        webhookId
      );
      expect(result2.action).toBe("skipped");
      expect(result2.skipReason).toContain("idempotent");
    });

    it("tracks draft order without resolved buyer account", async () => {
      const draftOrder: ShopifyDraftOrder = {
        id: `gid://shopify/DraftOrder/draft-${TEST_SUFFIX}-nobuyer`,
        name: "#DNOBUYER",
        createdAt: "2025-07-15T10:00:00.000Z",
        totalPriceSet: {
          shopMoney: { amount: "40000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt1",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
        // Unknown company, buyer account doesn't exist
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: `gid://shopify/Company/unknown-${TEST_SUFFIX}` },
          location: { id: `gid://shopify/CompanyLocation/unknown-${TEST_SUFFIX}` },
        },
      };

      const result = await processDraftOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "DRAFT_ORDERS_CREATE",
        draftOrder,
        `wh-draft-${TEST_SUFFIX}-nobuyer`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("created");

      // Should be tracked but without buyer account
      const [tracked] = await sql`
        SELECT * FROM s8_draft_orders WHERE draft_order_id = ${draftOrder.id}
      `;
      expect(tracked.buyer_account_id).toBeNull();
      expect(tracked.has_payment_terms).toBe(true);
    });
  });

  describe("getPendingExposure", () => {
    it("calculates sum of draft orders for buyer account", async () => {
      // Create multiple draft orders for the account
      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at
        ) VALUES
        (${TEST_SHOP_ID}, 'draft-exp-1', ${TEST_ACCOUNT_ID}, '#E1', '10000.00', true, 'open', NOW()),
        (${TEST_SHOP_ID}, 'draft-exp-2', ${TEST_ACCOUNT_ID}, '#E2', '25000.00', true, 'invoice_sent', NOW()),
        (${TEST_SHOP_ID}, 'draft-exp-3', ${TEST_ACCOUNT_ID}, '#E3', '15000.00', true, 'completed', NOW())
      `;

      const exposure = await getPendingExposure(sql, TEST_ACCOUNT_ID);

      // Should sum open + invoice_sent, but exclude completed
      expect(exposure).toBe("35000.00");
    });

    it("returns 0 for account with no draft orders", async () => {
      const exposure = await getPendingExposure(sql, "nonexistent-account");
      expect(exposure).toBe("0.00");
    });

    it("excludes draft orders without payment terms", async () => {
      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at
        ) VALUES
        (${TEST_SHOP_ID}, 'draft-noterms-1', ${TEST_ACCOUNT_ID}, '#NT1', '50000.00', false, 'open', NOW()),
        (${TEST_SHOP_ID}, 'draft-noterms-2', ${TEST_ACCOUNT_ID}, '#NT2', '20000.00', true, 'open', NOW())
      `;

      const exposure = await getPendingExposure(sql, TEST_ACCOUNT_ID);

      // Should only include the one with payment terms
      expect(exposure).toBe("20000.00");
    });
  });

  describe("mapDraftOrder", () => {
    it("maps draft order with all fields", () => {
      const draftOrder: ShopifyDraftOrder = {
        id: "gid://shopify/DraftOrder/123",
        name: "#D123",
        createdAt: "2025-07-15T10:00:00.000Z",
        status: "open",
        totalPriceSet: {
          shopMoney: { amount: "99000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt1",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
      };

      const result = mapDraftOrder(TEST_SHOP_ID, draftOrder, TEST_ACCOUNT_ID);

      expect(result.shopId).toBe(TEST_SHOP_ID);
      expect(result.draftOrderId).toBe("gid://shopify/DraftOrder/123");
      expect(result.buyerAccountId).toBe(TEST_ACCOUNT_ID);
      expect(result.name).toBe("#D123");
      expect(result.total).toBe("99000.00");
      expect(result.hasPaymentTerms).toBe(true);
      expect(result.status).toBe("open");
    });

    it("handles null buyer account", () => {
      const draftOrder: ShopifyDraftOrder = {
        id: "gid://shopify/DraftOrder/456",
        name: "#D456",
        createdAt: "2025-07-15T10:00:00.000Z",
        paymentTerms: null,
      };

      const result = mapDraftOrder(TEST_SHOP_ID, draftOrder, null);

      expect(result.buyerAccountId).toBeNull();
      expect(result.hasPaymentTerms).toBe(false);
    });
  });

  describe("bulkUpsertDraftOrders", () => {
    it("inserts multiple draft orders in batch", async () => {
      const draftOrders = [
        mapDraftOrder(
          TEST_SHOP_ID,
          {
            id: `gid://shopify/DraftOrder/bulk-${TEST_SUFFIX}-1`,
            name: "#B1",
            createdAt: "2025-07-15T10:00:00.000Z",
            totalPriceSet: { shopMoney: { amount: "1000.00", currencyCode: "INR" } },
            paymentTerms: { id: "pt", paymentTermsName: "Net", paymentTermsType: "NET" },
          },
          TEST_ACCOUNT_ID
        ),
        mapDraftOrder(
          TEST_SHOP_ID,
          {
            id: `gid://shopify/DraftOrder/bulk-${TEST_SUFFIX}-2`,
            name: "#B2",
            createdAt: "2025-07-15T10:00:00.000Z",
            totalPriceSet: { shopMoney: { amount: "2000.00", currencyCode: "INR" } },
            paymentTerms: { id: "pt", paymentTermsName: "Net", paymentTermsType: "NET" },
          },
          TEST_ACCOUNT_ID
        ),
      ];

      const count = await bulkUpsertDraftOrders(sql, draftOrders);

      expect(count).toBe(2);

      const inserted = await sql`
        SELECT * FROM s8_draft_orders
        WHERE draft_order_id IN ${sql([draftOrders[0].draftOrderId, draftOrders[1].draftOrderId])}
      `;
      expect(inserted).toHaveLength(2);
    });

    it("handles empty array", async () => {
      const count = await bulkUpsertDraftOrders(sql, []);
      expect(count).toBe(0);
    });
  });
});
