/**
 * DB-backed integration tests for S8 PR-B draft_orders reconcile.
 *
 * Tests:
 * 1. processDraftOrderLines and bulkUpsertDraftOrders against migrated schema
 * 2. Idempotent re-runs for open and invoice_sent drafts
 * 3. s6_bulk_operations accepts bulk_type and reconcile_stage 'draft_orders'
 *
 * Uses native PostgreSQL with pgmq and all migrations applied.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import {
  mapDraftOrder,
  bulkUpsertDraftOrders,
  processBulkDraftOrder,
} from "../draft-order.server";
import {
  parseDraftOrderBulkJsonl,
  bulkDraftOrderToShopifyDraftOrder,
} from "../bulk-parser.server";
import type { ShopifyDraftOrder } from "../types";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("S8 PR-B draft_orders bulk reconcile (DB-backed)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-s8b";
  const TEST_SHOP_ID = `shop-s8b-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-s8b-drafts-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `account-s8b-${TEST_SUFFIX}`;
  const TEST_COMPANY_ID = `gid://shopify/Company/co-s8b-${TEST_SUFFIX}`;
  const TEST_LOCATION_ID = `gid://shopify/CompanyLocation/loc-s8b-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "createdAt", "updatedAt"
      ) VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY', ${TEST_COMPANY_ID}, ${TEST_LOCATION_ID}, 'Test S8B Company',
        NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM s8_draft_orders WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_bulk_operations WHERE shop = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM s8_draft_orders WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_bulk_operations WHERE shop = ${TEST_SHOP_DOMAIN}`;
  });

  describe("s6_bulk_operations CHECK constraints for draft_orders", () => {
    it("accepts bulk_type 'draft_orders'", async () => {
      await expect(
        sql`
          INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin)
          VALUES ('gid://shopify/BulkOperation/s8b-bt-1', ${TEST_SHOP_DOMAIN}, 'draft_orders', 'webhook')
        `
      ).resolves.not.toThrow();
    });

    it("accepts reconcile_stage 'draft_orders'", async () => {
      await expect(
        sql`
          INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage)
          VALUES ('gid://shopify/BulkOperation/s8b-rs-1', ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders')
        `
      ).resolves.not.toThrow();
    });

    it("accepts full draft_orders reconcile row with all fields", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/s8b-full-${TEST_SUFFIX}`;

      await expect(
        sql`
          INSERT INTO s6_bulk_operations (
            bulk_operation_id, shop, bulk_type, origin, reconcile_stage, byte_offset, chunk_size
          ) VALUES (
            ${bulkOpId}, ${TEST_SHOP_DOMAIN}, 'draft_orders', 'reconcile', 'draft_orders', 0, 524288
          )
        `
      ).resolves.not.toThrow();

      const [row] = await sql<{ bulk_type: string; reconcile_stage: string }[]>`
        SELECT bulk_type, reconcile_stage FROM s6_bulk_operations WHERE bulk_operation_id = ${bulkOpId}
      `;

      expect(row.bulk_type).toBe("draft_orders");
      expect(row.reconcile_stage).toBe("draft_orders");
    });
  });

  describe("bulkUpsertDraftOrders", () => {
    it("inserts open draft orders", async () => {
      const draftOrders = [
        mapDraftOrder(
          TEST_SHOP_ID,
          {
            id: `gid://shopify/DraftOrder/bulk-open-${TEST_SUFFIX}-1`,
            name: "#BOPEN1",
            createdAt: "2026-10-25T10:00:00Z",
            status: "open",
            totalPriceSet: { shopMoney: { amount: "1000.00", currencyCode: "USD" } },
            paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
          },
          TEST_ACCOUNT_ID
        ),
        mapDraftOrder(
          TEST_SHOP_ID,
          {
            id: `gid://shopify/DraftOrder/bulk-open-${TEST_SUFFIX}-2`,
            name: "#BOPEN2",
            createdAt: "2026-10-25T11:00:00Z",
            status: "open",
            totalPriceSet: { shopMoney: { amount: "2500.00", currencyCode: "USD" } },
            paymentTerms: { id: "pt2", paymentTermsName: "Net 45", paymentTermsType: "NET" },
          },
          TEST_ACCOUNT_ID
        ),
      ];

      const count = await bulkUpsertDraftOrders(sql, draftOrders);
      expect(count).toBe(2);

      const rows = await sql`
        SELECT draft_order_id, status, total FROM s8_draft_orders WHERE shop_id = ${TEST_SHOP_ID}
      `;
      expect(rows).toHaveLength(2);
      expect(rows[0].status).toBe("open");
      expect(rows[1].status).toBe("open");
    });

    it("inserts invoice_sent draft orders", async () => {
      const draftOrders = [
        mapDraftOrder(
          TEST_SHOP_ID,
          {
            id: `gid://shopify/DraftOrder/bulk-sent-${TEST_SUFFIX}`,
            name: "#BSENT1",
            createdAt: "2026-10-25T12:00:00Z",
            status: "invoice_sent",
            totalPriceSet: { shopMoney: { amount: "5000.00", currencyCode: "USD" } },
            paymentTerms: { id: "pt3", paymentTermsName: "Net 60", paymentTermsType: "NET" },
          },
          TEST_ACCOUNT_ID
        ),
      ];

      const count = await bulkUpsertDraftOrders(sql, draftOrders);
      expect(count).toBe(1);

      const [row] = await sql`
        SELECT status, total FROM s8_draft_orders
        WHERE draft_order_id = ${draftOrders[0].draftOrderId}
      `;
      expect(row.status).toBe("invoice_sent");
      expect(row.total).toBe("5000.00");
    });

    it("idempotent re-run updates existing open drafts", async () => {
      const draftOrderId = `gid://shopify/DraftOrder/bulk-idem-${TEST_SUFFIX}`;

      const initial = mapDraftOrder(
        TEST_SHOP_ID,
        {
          id: draftOrderId,
          name: "#BIDEM",
          createdAt: "2026-10-25T10:00:00Z",
          status: "open",
          totalPriceSet: { shopMoney: { amount: "1000.00", currencyCode: "USD" } },
          paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
        },
        TEST_ACCOUNT_ID
      );

      await bulkUpsertDraftOrders(sql, [initial]);

      const updated = mapDraftOrder(
        TEST_SHOP_ID,
        {
          id: draftOrderId,
          name: "#BIDEM",
          createdAt: "2026-10-25T10:00:00Z",
          status: "open",
          totalPriceSet: { shopMoney: { amount: "1500.00", currencyCode: "USD" } },
          paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
        },
        TEST_ACCOUNT_ID
      );

      const count = await bulkUpsertDraftOrders(sql, [updated]);
      expect(count).toBe(1);

      const rows = await sql`SELECT total FROM s8_draft_orders WHERE draft_order_id = ${draftOrderId}`;
      expect(rows).toHaveLength(1);
      expect(rows[0].total).toBe("1500.00");
    });

    it("idempotent re-run updates invoice_sent drafts to new total", async () => {
      const draftOrderId = `gid://shopify/DraftOrder/bulk-sent-idem-${TEST_SUFFIX}`;

      const initial = mapDraftOrder(
        TEST_SHOP_ID,
        {
          id: draftOrderId,
          name: "#BSENTIDEM",
          createdAt: "2026-10-25T10:00:00Z",
          status: "invoice_sent",
          totalPriceSet: { shopMoney: { amount: "3000.00", currencyCode: "USD" } },
          paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
        },
        TEST_ACCOUNT_ID
      );

      await bulkUpsertDraftOrders(sql, [initial]);

      const updated = mapDraftOrder(
        TEST_SHOP_ID,
        {
          id: draftOrderId,
          name: "#BSENTIDEM",
          createdAt: "2026-10-25T10:00:00Z",
          status: "invoice_sent",
          totalPriceSet: { shopMoney: { amount: "3500.00", currencyCode: "USD" } },
          paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
        },
        TEST_ACCOUNT_ID
      );

      const count = await bulkUpsertDraftOrders(sql, [updated]);
      expect(count).toBe(1);

      const rows = await sql`SELECT total, status FROM s8_draft_orders WHERE draft_order_id = ${draftOrderId}`;
      expect(rows).toHaveLength(1);
      expect(rows[0].total).toBe("3500.00");
      expect(rows[0].status).toBe("invoice_sent");
    });
  });

  describe("processBulkDraftOrder - three-bucket coverage", () => {
    const TEST_CUSTOMER_ID = `gid://shopify/Customer/cust-s8b-${TEST_SUFFIX}`;
    const TEST_CUSTOMER_ACCOUNT_ID = `account-cust-s8b-${TEST_SUFFIX}`;

    beforeAll(async () => {
      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "customerId", name,
          "createdAt", "updatedAt"
        ) VALUES (
          ${TEST_CUSTOMER_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER', ${TEST_CUSTOMER_ID}, 'Test S8B Tagged Customer',
          NOW(), NOW()
        )
      `;
    });

    afterAll(async () => {
      await sql`DELETE FROM "BuyerAccount" WHERE id = ${TEST_CUSTOMER_ACCOUNT_ID}`;
    });

    it("bucket 1: with purchasing company - maps to company/location buyer account", async () => {
      const draftOrder: ShopifyDraftOrder = {
        id: `gid://shopify/DraftOrder/bucket1-co-${TEST_SUFFIX}`,
        name: "#BUCKET1-CO",
        createdAt: "2026-10-25T10:00:00Z",
        status: "open",
        totalPriceSet: { shopMoney: { amount: "7500.00", currencyCode: "USD" } },
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

      const result = await processBulkDraftOrder(sql, TEST_SHOP_DOMAIN, draftOrder);

      expect(result).not.toBeNull();
      expect(result!.shopId).toBe(TEST_SHOP_ID);
      expect(result!.buyerAccountId).toBe(TEST_ACCOUNT_ID);
      expect(result!.hasPaymentTerms).toBe(true);
    });

    it("bucket 2: customer-only - maps via customer to tagged customer buyer account", async () => {
      const draftOrder: ShopifyDraftOrder = {
        id: `gid://shopify/DraftOrder/bucket2-cust-${TEST_SUFFIX}`,
        name: "#BUCKET2-CUST",
        createdAt: "2026-10-25T11:00:00Z",
        status: "invoice_sent",
        totalPriceSet: { shopMoney: { amount: "4000.00", currencyCode: "USD" } },
        paymentTerms: {
          id: "pt2",
          paymentTermsName: "Net 45",
          paymentTermsType: "NET",
          dueInDays: 45,
        },
        customer: { id: TEST_CUSTOMER_ID },
      };

      const result = await processBulkDraftOrder(sql, TEST_SHOP_DOMAIN, draftOrder);

      expect(result).not.toBeNull();
      expect(result!.shopId).toBe(TEST_SHOP_ID);
      expect(result!.buyerAccountId).toBe(TEST_CUSTOMER_ACCOUNT_ID);
      expect(result!.hasPaymentTerms).toBe(true);
      expect(result!.status).toBe("invoice_sent");
    });

    it("bucket 3: neither company nor customer - SKIPPED (no buyer account)", async () => {
      const draftOrder: ShopifyDraftOrder = {
        id: `gid://shopify/DraftOrder/bucket3-neither-${TEST_SUFFIX}`,
        name: "#BUCKET3-NEITHER",
        createdAt: "2026-10-25T12:00:00Z",
        status: "open",
        totalPriceSet: { shopMoney: { amount: "2000.00", currencyCode: "USD" } },
        paymentTerms: {
          id: "pt3",
          paymentTermsName: "Net 60",
          paymentTermsType: "NET",
          dueInDays: 60,
        },
      };

      const result = await processBulkDraftOrder(sql, TEST_SHOP_DOMAIN, draftOrder);

      expect(result).not.toBeNull();
      expect(result!.shopId).toBe(TEST_SHOP_ID);
      expect(result!.buyerAccountId).toBeNull();
      expect(result!.hasPaymentTerms).toBe(true);
    });

    it("returns null for draft order without payment terms (existing skip reason)", async () => {
      const draftOrder: ShopifyDraftOrder = {
        id: `gid://shopify/DraftOrder/noterms-${TEST_SUFFIX}`,
        name: "#BNOTERMS",
        createdAt: "2026-10-25T10:00:00Z",
        status: "open",
        paymentTerms: null,
      };

      const result = await processBulkDraftOrder(sql, TEST_SHOP_DOMAIN, draftOrder);

      expect(result).toBeNull();
    });
  });

  describe("parseDraftOrderBulkJsonl + bulkUpsertDraftOrders integration", () => {
    it("parses JSONL and upserts draft orders end-to-end", async () => {
      const jsonl = [
        `{"id":"gid://shopify/DraftOrder/e2e-open-${TEST_SUFFIX}","name":"#E2EOPEN","createdAt":"2026-10-25T10:00:00Z","status":"open","totalPriceSet":{"shopMoney":{"amount":"1000.00","currencyCode":"USD"}},"paymentTerms":{"id":"pt1","paymentTermsName":"Net 30","paymentTermsType":"NET"}}`,
        `{"id":"gid://shopify/DraftOrder/e2e-sent-${TEST_SUFFIX}","name":"#E2ESENT","createdAt":"2026-10-25T11:00:00Z","status":"invoice_sent","totalPriceSet":{"shopMoney":{"amount":"2000.00","currencyCode":"USD"}},"paymentTerms":{"id":"pt2","paymentTermsName":"Net 45","paymentTermsType":"NET"}}`,
      ].join("\n");

      const { draftOrders, errors } = parseDraftOrderBulkJsonl(jsonl);
      expect(errors).toHaveLength(0);
      expect(draftOrders).toHaveLength(2);

      const mappedOrders = [];
      for (const d of draftOrders) {
        const shopifyDraftOrder = bulkDraftOrderToShopifyDraftOrder(d);
        if (shopifyDraftOrder.paymentTerms) {
          mappedOrders.push(mapDraftOrder(TEST_SHOP_ID, shopifyDraftOrder, TEST_ACCOUNT_ID));
        }
      }

      expect(mappedOrders).toHaveLength(2);

      const count = await bulkUpsertDraftOrders(sql, mappedOrders);
      expect(count).toBe(2);

      const rows = await sql`
        SELECT draft_order_id, name, status, total FROM s8_draft_orders
        WHERE shop_id = ${TEST_SHOP_ID}
        ORDER BY name
      `;
      expect(rows).toHaveLength(2);
      expect(rows[0].name).toBe("#E2EOPEN");
      expect(rows[0].status).toBe("open");
      expect(rows[1].name).toBe("#E2ESENT");
      expect(rows[1].status).toBe("invoice_sent");
    });

    it("re-run is idempotent (no duplicates)", async () => {
      const jsonl = `{"id":"gid://shopify/DraftOrder/rerun-${TEST_SUFFIX}","name":"#RERUN","createdAt":"2026-10-25T10:00:00Z","status":"open","totalPriceSet":{"shopMoney":{"amount":"1000.00","currencyCode":"USD"}},"paymentTerms":{"id":"pt1","paymentTermsName":"Net 30","paymentTermsType":"NET"}}`;

      const { draftOrders } = parseDraftOrderBulkJsonl(jsonl);
      const shopifyDraftOrder = bulkDraftOrderToShopifyDraftOrder(draftOrders[0]);
      const mapped = mapDraftOrder(TEST_SHOP_ID, shopifyDraftOrder, TEST_ACCOUNT_ID);

      await bulkUpsertDraftOrders(sql, [mapped]);
      await bulkUpsertDraftOrders(sql, [mapped]);

      const rows = await sql`
        SELECT draft_order_id FROM s8_draft_orders
        WHERE draft_order_id = ${`gid://shopify/DraftOrder/rerun-${TEST_SUFFIX}`}
      `;
      expect(rows).toHaveLength(1);
    });
  });
});
