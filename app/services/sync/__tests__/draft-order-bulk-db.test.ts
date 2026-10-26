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
  processDraftOrderWebhook,
  getPendingExposure,
  getAccountsWithDraftExposure,
} from "../draft-order.server";
import {
  parseDraftOrderBulkJsonl,
  bulkDraftOrderToShopifyDraftOrder,
} from "../bulk-parser.server";
import { processDraftOrderLines } from "../bulk-jsonl-processor.server";
import { getCreditStatusDisplay } from "~/services/credit-status.server";
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
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${"wh-parity-" + TEST_SUFFIX + "%"}`;
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
            totalPriceSet: { shopMoney: { amount: "1000.00", currencyCode: "INR" } },
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
            totalPriceSet: { shopMoney: { amount: "2500.00", currencyCode: "INR" } },
            paymentTerms: { id: "pt2", paymentTermsName: "Net 45", paymentTermsType: "NET" },
          },
          TEST_ACCOUNT_ID
        ),
      ];

      const result = await bulkUpsertDraftOrders(sql, draftOrders);
      expect(result.count).toBe(2);

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
            totalPriceSet: { shopMoney: { amount: "5000.00", currencyCode: "INR" } },
            paymentTerms: { id: "pt3", paymentTermsName: "Net 60", paymentTermsType: "NET" },
          },
          TEST_ACCOUNT_ID
        ),
      ];

      const result = await bulkUpsertDraftOrders(sql, draftOrders);
      expect(result.count).toBe(1);

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
          totalPriceSet: { shopMoney: { amount: "1000.00", currencyCode: "INR" } },
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
          totalPriceSet: { shopMoney: { amount: "1500.00", currencyCode: "INR" } },
          paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
        },
        TEST_ACCOUNT_ID
      );

      const result = await bulkUpsertDraftOrders(sql, [updated]);
      expect(result.count).toBe(1);

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
          totalPriceSet: { shopMoney: { amount: "3000.00", currencyCode: "INR" } },
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
          totalPriceSet: { shopMoney: { amount: "3500.00", currencyCode: "INR" } },
          paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
        },
        TEST_ACCOUNT_ID
      );

      const result = await bulkUpsertDraftOrders(sql, [updated]);
      expect(result.count).toBe(1);

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
        totalPriceSet: { shopMoney: { amount: "7500.00", currencyCode: "INR" } },
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
        totalPriceSet: { shopMoney: { amount: "4000.00", currencyCode: "INR" } },
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

    it("bucket 3: neither company nor customer - tracked with null buyer_account_id", async () => {
      const draftOrder: ShopifyDraftOrder = {
        id: `gid://shopify/DraftOrder/bucket3-neither-${TEST_SUFFIX}`,
        name: "#BUCKET3-NEITHER",
        createdAt: "2026-10-25T12:00:00Z",
        status: "open",
        totalPriceSet: { shopMoney: { amount: "2000.00", currencyCode: "INR" } },
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
        `{"id":"gid://shopify/DraftOrder/e2e-open-${TEST_SUFFIX}","name":"#E2EOPEN","createdAt":"2026-10-25T10:00:00Z","status":"open","totalPriceSet":{"shopMoney":{"amount":"1000.00","currencyCode":"INR"}},"paymentTerms":{"id":"pt1","paymentTermsName":"Net 30","paymentTermsType":"NET"}}`,
        `{"id":"gid://shopify/DraftOrder/e2e-sent-${TEST_SUFFIX}","name":"#E2ESENT","createdAt":"2026-10-25T11:00:00Z","status":"invoice_sent","totalPriceSet":{"shopMoney":{"amount":"2000.00","currencyCode":"INR"}},"paymentTerms":{"id":"pt2","paymentTermsName":"Net 45","paymentTermsType":"NET"}}`,
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

      const result = await bulkUpsertDraftOrders(sql, mappedOrders);
      expect(result.count).toBe(2);

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
      const jsonl = `{"id":"gid://shopify/DraftOrder/rerun-${TEST_SUFFIX}","name":"#RERUN","createdAt":"2026-10-25T10:00:00Z","status":"open","totalPriceSet":{"shopMoney":{"amount":"1000.00","currencyCode":"INR"}},"paymentTerms":{"id":"pt1","paymentTermsName":"Net 30","paymentTermsType":"NET"}}`;

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

  describe("webhook/bulk parity for 'neither' drafts (null buyer_account_id)", () => {
    it("webhook and bulk paths produce equivalent rows for 'neither' draft", async () => {
      const webhookDraftId = `gid://shopify/DraftOrder/parity-webhook-${TEST_SUFFIX}`;
      const bulkDraftId = `gid://shopify/DraftOrder/parity-bulk-${TEST_SUFFIX}`;

      const baseDraftOrder: ShopifyDraftOrder = {
        id: webhookDraftId,
        name: "#PARITY-WH",
        createdAt: "2026-10-25T10:00:00Z",
        status: "open",
        totalPriceSet: { shopMoney: { amount: "3000.00", currencyCode: "INR" } },
        paymentTerms: {
          id: "pt-parity",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
          dueInDays: 30,
        },
      };

      const webhookResult = await processDraftOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "DRAFT_ORDERS_CREATE",
        baseDraftOrder,
        `wh-parity-${TEST_SUFFIX}`
      );
      expect(webhookResult.success).toBe(true);
      expect(webhookResult.action).toBe("created");

      const bulkDraftOrder: ShopifyDraftOrder = {
        ...baseDraftOrder,
        id: bulkDraftId,
        name: "#PARITY-BULK",
      };

      const bulkMapped = await processBulkDraftOrder(sql, TEST_SHOP_DOMAIN, bulkDraftOrder);
      expect(bulkMapped).not.toBeNull();
      expect(bulkMapped!.buyerAccountId).toBeNull();
      await bulkUpsertDraftOrders(sql, [bulkMapped!]);

      const [webhookRow] = await sql<{
        buyer_account_id: string | null;
        total: string;
        has_payment_terms: boolean;
        status: string;
      }[]>`
        SELECT buyer_account_id, total, has_payment_terms, status
        FROM s8_draft_orders WHERE draft_order_id = ${webhookDraftId}
      `;
      const [bulkRow] = await sql<{
        buyer_account_id: string | null;
        total: string;
        has_payment_terms: boolean;
        status: string;
      }[]>`
        SELECT buyer_account_id, total, has_payment_terms, status
        FROM s8_draft_orders WHERE draft_order_id = ${bulkDraftId}
      `;

      expect(webhookRow.buyer_account_id).toBeNull();
      expect(bulkRow.buyer_account_id).toBeNull();
      expect(webhookRow.total).toBe(bulkRow.total);
      expect(webhookRow.has_payment_terms).toBe(bulkRow.has_payment_terms);
      expect(webhookRow.status).toBe(bulkRow.status);
    });

    it("null-buyer draft never counts toward any buyer account exposure", async () => {
      const nullBuyerDraftId = `gid://shopify/DraftOrder/null-exp-${TEST_SUFFIX}`;

      const mapped = mapDraftOrder(
        TEST_SHOP_ID,
        {
          id: nullBuyerDraftId,
          name: "#NULL-EXP",
          createdAt: "2026-10-25T10:00:00Z",
          status: "open",
          totalPriceSet: { shopMoney: { amount: "5000.00", currencyCode: "INR" } },
          paymentTerms: { id: "pt", paymentTermsName: "Net 30", paymentTermsType: "NET" },
        },
        null
      );
      await bulkUpsertDraftOrders(sql, [mapped]);

      const exposureForKnownAccount = await getPendingExposure(sql, TEST_ACCOUNT_ID);
      expect(exposureForKnownAccount).toBe("0.00");

      const [draft] = await sql`
        SELECT buyer_account_id FROM s8_draft_orders WHERE draft_order_id = ${nullBuyerDraftId}
      `;
      expect(draft.buyer_account_id).toBeNull();
    });

    it("null-buyer draft does not trigger any BuyerAccount hold", async () => {
      const nullBuyerDraftId = `gid://shopify/DraftOrder/null-hold-${TEST_SUFFIX}`;

      const mapped = mapDraftOrder(
        TEST_SHOP_ID,
        {
          id: nullBuyerDraftId,
          name: "#NULL-HOLD",
          createdAt: "2026-10-25T10:00:00Z",
          status: "open",
          totalPriceSet: { shopMoney: { amount: "10000.00", currencyCode: "INR" } },
          paymentTerms: { id: "pt", paymentTermsName: "Net 30", paymentTermsType: "NET" },
        },
        null
      );
      await bulkUpsertDraftOrders(sql, [mapped]);

      const holdRows = await sql`
        SELECT id FROM "BuyerAccount"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND "holdState" = 'HELD'
      `;
      expect(holdRows).toHaveLength(0);
    });

    it("null-buyer draft creates no ReminderLog rows", async () => {
      const nullBuyerDraftId = `gid://shopify/DraftOrder/null-rem-${TEST_SUFFIX}`;

      const mapped = mapDraftOrder(
        TEST_SHOP_ID,
        {
          id: nullBuyerDraftId,
          name: "#NULL-REM",
          createdAt: "2026-10-25T10:00:00Z",
          status: "open",
          totalPriceSet: { shopMoney: { amount: "8000.00", currencyCode: "INR" } },
          paymentTerms: { id: "pt", paymentTermsName: "Net 30", paymentTermsType: "NET" },
        },
        null
      );
      await bulkUpsertDraftOrders(sql, [mapped]);

      const reminderRows = await sql`
        SELECT id FROM "ReminderLog"
        WHERE "shopId" = ${TEST_SHOP_ID}
      `;
      expect(reminderRows).toHaveLength(0);
    });
  });

  describe("#292 INR currency guard on bulk path", () => {
    it("processBulkDraftOrder returns null for USD draft (draft_order_currency_not_supported)", async () => {
      const draftOrder: ShopifyDraftOrder = {
        id: `gid://shopify/DraftOrder/usd-bulk-${TEST_SUFFIX}`,
        name: "#USD-BULK",
        createdAt: "2026-10-25T10:00:00Z",
        status: "open",
        totalPriceSet: { shopMoney: { amount: "5000.00", currencyCode: "USD" } },
        paymentTerms: {
          id: "pt-usd",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      const result = await processBulkDraftOrder(sql, TEST_SHOP_DOMAIN, draftOrder);

      expect(result).toBeNull();

      const rows = await sql`
        SELECT draft_order_id FROM s8_draft_orders WHERE draft_order_id = ${draftOrder.id}
      `;
      expect(rows).toHaveLength(0);
    });

    it("processBulkDraftOrder returns null for missing currency (draft_order_currency_missing)", async () => {
      const draftOrder: ShopifyDraftOrder = {
        id: `gid://shopify/DraftOrder/nocurrency-bulk-${TEST_SUFFIX}`,
        name: "#NOCURRENCY-BULK",
        createdAt: "2026-10-25T10:00:00Z",
        status: "open",
        paymentTerms: {
          id: "pt-nocurrency",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      const result = await processBulkDraftOrder(sql, TEST_SHOP_DOMAIN, draftOrder);

      expect(result).toBeNull();

      const rows = await sql`
        SELECT draft_order_id FROM s8_draft_orders WHERE draft_order_id = ${draftOrder.id}
      `;
      expect(rows).toHaveLength(0);
    });

    it("processBulkDraftOrder accepts INR draft", async () => {
      const draftOrder: ShopifyDraftOrder = {
        id: `gid://shopify/DraftOrder/inr-bulk-${TEST_SUFFIX}`,
        name: "#INR-BULK",
        createdAt: "2026-10-25T10:00:00Z",
        status: "open",
        totalPriceSet: { shopMoney: { amount: "5000.00", currencyCode: "INR" } },
        paymentTerms: {
          id: "pt-inr",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      const result = await processBulkDraftOrder(sql, TEST_SHOP_DOMAIN, draftOrder);

      expect(result).not.toBeNull();
      expect(result!.total).toBe("5000.00");
    });
  });

  describe("status casing normalization", () => {
    it("UPPERCASE status from GraphQL is stored as lowercase", async () => {
      const draftOrder: ShopifyDraftOrder = {
        id: `gid://shopify/DraftOrder/upper-open-${TEST_SUFFIX}`,
        name: "#UPPER-OPEN",
        createdAt: "2026-10-25T10:00:00Z",
        status: "OPEN", // GraphQL returns UPPERCASE enum
        totalPriceSet: { shopMoney: { amount: "1500.00", currencyCode: "INR" } },
        paymentTerms: {
          id: "pt-upper",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      const mapped = await processBulkDraftOrder(sql, TEST_SHOP_DOMAIN, draftOrder);
      expect(mapped).not.toBeNull();
      expect(mapped!.status).toBe("open"); // Normalized to lowercase

      await bulkUpsertDraftOrders(sql, [mapped!]);

      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftOrder.id}
      `;
      expect(row.status).toBe("open");
    });

    it("INVOICE_SENT from GraphQL is stored as invoice_sent", async () => {
      const draftOrder: ShopifyDraftOrder = {
        id: `gid://shopify/DraftOrder/upper-sent-${TEST_SUFFIX}`,
        name: "#UPPER-SENT",
        createdAt: "2026-10-25T11:00:00Z",
        status: "INVOICE_SENT", // GraphQL returns UPPERCASE enum
        totalPriceSet: { shopMoney: { amount: "2500.00", currencyCode: "INR" } },
        paymentTerms: {
          id: "pt-upper-sent",
          paymentTermsName: "Net 45",
          paymentTermsType: "NET",
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      const mapped = await processBulkDraftOrder(sql, TEST_SHOP_DOMAIN, draftOrder);
      expect(mapped).not.toBeNull();
      expect(mapped!.status).toBe("invoice_sent"); // Normalized to lowercase

      await bulkUpsertDraftOrders(sql, [mapped!]);

      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftOrder.id}
      `;
      expect(row.status).toBe("invoice_sent");
    });

    it("COMPLETED from GraphQL is stored as completed", async () => {
      const draftOrder: ShopifyDraftOrder = {
        id: `gid://shopify/DraftOrder/upper-completed-${TEST_SUFFIX}`,
        name: "#UPPER-COMPLETED",
        createdAt: "2026-10-25T12:00:00Z",
        status: "COMPLETED", // GraphQL returns UPPERCASE enum
        totalPriceSet: { shopMoney: { amount: "3500.00", currencyCode: "INR" } },
        paymentTerms: {
          id: "pt-upper-completed",
          paymentTermsName: "Net 60",
          paymentTermsType: "NET",
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      const mapped = await processBulkDraftOrder(sql, TEST_SHOP_DOMAIN, draftOrder);
      expect(mapped).not.toBeNull();
      expect(mapped!.status).toBe("completed"); // Normalized to lowercase

      await bulkUpsertDraftOrders(sql, [mapped!]);

      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftOrder.id}
      `;
      expect(row.status).toBe("completed");
    });

    it("existing UPPERCASE row re-processed ends up lowercase and counts toward exposure", async () => {
      const draftId = `gid://shopify/DraftOrder/resync-upper-${TEST_SUFFIX}`;
      const draftAmount = "8500.00";
      const draftAmountPaise = 850000n;

      // Insert row directly with UPPERCASE status (simulating pre-fix webhook data)
      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftId}, ${TEST_ACCOUNT_ID}, '#RESYNC-UPPER', ${draftAmount},
          true, 'OPEN', NOW(), NOW()
        )
      `;

      // Verify it was stored UPPERCASE
      const [beforeRow] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftId}
      `;
      expect(beforeRow.status).toBe("OPEN");

      // UPPERCASE row does NOT count toward exposure per credit-status.server.ts computeExposure
      // which uses: status IN ('open', 'invoice_sent') - case-sensitive match
      // QA2 carry-over (b): use the real exported exposure path (getCreditStatusDisplay)
      const statusBefore = await getCreditStatusDisplay(sql, TEST_ACCOUNT_ID);
      expect(statusBefore).not.toBeNull();
      expect(statusBefore!.exposurePaise).toBe(0n);

      // Re-process through the normalized bulk path
      const draftOrder: ShopifyDraftOrder = {
        id: draftId,
        name: "#RESYNC-UPPER",
        createdAt: "2026-10-25T10:00:00Z",
        status: "OPEN", // GraphQL returns UPPERCASE
        totalPriceSet: { shopMoney: { amount: draftAmount, currencyCode: "INR" } },
        paymentTerms: {
          id: "pt-resync",
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

      const mapped = await processBulkDraftOrder(sql, TEST_SHOP_DOMAIN, draftOrder);
      expect(mapped).not.toBeNull();
      expect(mapped!.status).toBe("open"); // Normalized to lowercase

      await bulkUpsertDraftOrders(sql, [mapped!]);

      // Verify status is now lowercase
      const [afterRow] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftId}
      `;
      expect(afterRow.status).toBe("open");

      // QA2 carry-over (b): use the real exported exposure path (getCreditStatusDisplay)
      // NOW it counts toward exposure because status is lowercase
      const statusAfter = await getCreditStatusDisplay(sql, TEST_ACCOUNT_ID);
      expect(statusAfter).not.toBeNull();
      expect(statusAfter!.exposurePaise).toBe(draftAmountPaise);
    });
  });

  describe("bulk-imported draft exposure counting", () => {
    it("bulk-imported OPEN draft with terms counts toward buyer's pending exposure", async () => {
      const draftId = `gid://shopify/DraftOrder/exp-open-${TEST_SUFFIX}`;
      const draftAmount = "7500.00";

      const draftOrder: ShopifyDraftOrder = {
        id: draftId,
        name: "#EXP-OPEN",
        createdAt: "2026-10-25T10:00:00Z",
        status: "OPEN", // GraphQL UPPERCASE
        totalPriceSet: { shopMoney: { amount: draftAmount, currencyCode: "INR" } },
        paymentTerms: {
          id: "pt-exp",
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

      const mapped = await processBulkDraftOrder(sql, TEST_SHOP_DOMAIN, draftOrder);
      expect(mapped).not.toBeNull();
      await bulkUpsertDraftOrders(sql, [mapped!]);

      const exposure = await getPendingExposure(sql, TEST_ACCOUNT_ID);
      expect(exposure).toBe(draftAmount);
    });

    it("bulk-imported INVOICE_SENT draft counts toward buyer's pending exposure", async () => {
      const draftId = `gid://shopify/DraftOrder/exp-sent-${TEST_SUFFIX}`;
      const draftAmount = "4000.00";

      const draftOrder: ShopifyDraftOrder = {
        id: draftId,
        name: "#EXP-SENT",
        createdAt: "2026-10-25T11:00:00Z",
        status: "INVOICE_SENT", // GraphQL UPPERCASE
        totalPriceSet: { shopMoney: { amount: draftAmount, currencyCode: "INR" } },
        paymentTerms: {
          id: "pt-exp-sent",
          paymentTermsName: "Net 45",
          paymentTermsType: "NET",
          dueInDays: 45,
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      const mapped = await processBulkDraftOrder(sql, TEST_SHOP_DOMAIN, draftOrder);
      expect(mapped).not.toBeNull();
      await bulkUpsertDraftOrders(sql, [mapped!]);

      const exposure = await getPendingExposure(sql, TEST_ACCOUNT_ID);
      expect(exposure).toBe(draftAmount);
    });

    it("bulk-imported COMPLETED draft does NOT count toward exposure", async () => {
      const draftId = `gid://shopify/DraftOrder/exp-completed-${TEST_SUFFIX}`;

      const draftOrder: ShopifyDraftOrder = {
        id: draftId,
        name: "#EXP-COMPLETED",
        createdAt: "2026-10-25T12:00:00Z",
        status: "COMPLETED", // GraphQL UPPERCASE
        totalPriceSet: { shopMoney: { amount: "9000.00", currencyCode: "INR" } },
        paymentTerms: {
          id: "pt-exp-completed",
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

      const mapped = await processBulkDraftOrder(sql, TEST_SHOP_DOMAIN, draftOrder);
      expect(mapped).not.toBeNull();
      await bulkUpsertDraftOrders(sql, [mapped!]);

      const exposure = await getPendingExposure(sql, TEST_ACCOUNT_ID);
      expect(exposure).toBe("0.00");
    });

    it("null-buyer draft with OPEN status does NOT count toward any buyer exposure", async () => {
      const draftId = `gid://shopify/DraftOrder/exp-null-${TEST_SUFFIX}`;

      const draftOrder: ShopifyDraftOrder = {
        id: draftId,
        name: "#EXP-NULL",
        createdAt: "2026-10-25T13:00:00Z",
        status: "OPEN",
        totalPriceSet: { shopMoney: { amount: "6000.00", currencyCode: "INR" } },
        paymentTerms: {
          id: "pt-exp-null",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
          dueInDays: 30,
        },
      };

      const mapped = await processBulkDraftOrder(sql, TEST_SHOP_DOMAIN, draftOrder);
      expect(mapped).not.toBeNull();
      expect(mapped!.buyerAccountId).toBeNull();
      await bulkUpsertDraftOrders(sql, [mapped!]);

      const exposure = await getPendingExposure(sql, TEST_ACCOUNT_ID);
      expect(exposure).toBe("0.00");
    });
  });

  describe("processDraftOrderLines (calls processDraftOrderLines directly)", () => {
    it("only stores INR drafts, skips USD and missing-currency drafts", async () => {
      const jsonlLines = [
        `{"id":"gid://shopify/DraftOrder/pdl-inr-${TEST_SUFFIX}","name":"#PDL-INR","createdAt":"2026-10-25T10:00:00Z","status":"OPEN","totalPriceSet":{"shopMoney":{"amount":"1000.00","currencyCode":"INR"}},"paymentTerms":{"id":"pt1","paymentTermsName":"Net 30","paymentTermsType":"NET"}}`,
        `{"id":"gid://shopify/DraftOrder/pdl-usd-${TEST_SUFFIX}","name":"#PDL-USD","createdAt":"2026-10-25T11:00:00Z","status":"OPEN","totalPriceSet":{"shopMoney":{"amount":"2000.00","currencyCode":"USD"}},"paymentTerms":{"id":"pt2","paymentTermsName":"Net 30","paymentTermsType":"NET"}}`,
        `{"id":"gid://shopify/DraftOrder/pdl-nocurrency-${TEST_SUFFIX}","name":"#PDL-NOCURRENCY","createdAt":"2026-10-25T12:00:00Z","status":"OPEN","paymentTerms":{"id":"pt3","paymentTermsName":"Net 30","paymentTermsType":"NET"}}`,
        `{"id":"gid://shopify/DraftOrder/pdl-inr2-${TEST_SUFFIX}","name":"#PDL-INR2","createdAt":"2026-10-25T13:00:00Z","status":"INVOICE_SENT","totalPriceSet":{"shopMoney":{"amount":"3000.00","currencyCode":"INR"}},"paymentTerms":{"id":"pt4","paymentTermsName":"Net 45","paymentTermsType":"NET"}}`,
      ];

      const upsertedCount = await processDraftOrderLines(sql, TEST_SHOP_DOMAIN, jsonlLines);

      expect(upsertedCount).toBe(2);

      const rows = await sql`
        SELECT draft_order_id, name, status FROM s8_draft_orders
        WHERE shop_id = ${TEST_SHOP_ID}
        ORDER BY name
      `;
      expect(rows).toHaveLength(2);
      expect(rows[0].name).toBe("#PDL-INR");
      expect(rows[0].status).toBe("open"); // Normalized to lowercase
      expect(rows[1].name).toBe("#PDL-INR2");
      expect(rows[1].status).toBe("invoice_sent"); // Normalized to lowercase

      const usdRow = await sql`
        SELECT draft_order_id FROM s8_draft_orders
        WHERE draft_order_id = ${`gid://shopify/DraftOrder/pdl-usd-${TEST_SUFFIX}`}
      `;
      expect(usdRow).toHaveLength(0);

      const noCurrencyRow = await sql`
        SELECT draft_order_id FROM s8_draft_orders
        WHERE draft_order_id = ${`gid://shopify/DraftOrder/pdl-nocurrency-${TEST_SUFFIX}`}
      `;
      expect(noCurrencyRow).toHaveLength(0);
    });

    it("UPPERCASE status JSONL through processLines stores lowercase and counts toward exposure", async () => {
      const jsonlLines = [
        `{"id":"gid://shopify/DraftOrder/pdl-upper-${TEST_SUFFIX}","name":"#PDL-UPPER","createdAt":"2026-10-25T10:00:00Z","status":"OPEN","totalPriceSet":{"shopMoney":{"amount":"5500.00","currencyCode":"INR"}},"paymentTerms":{"id":"pt1","paymentTermsName":"Net 30","paymentTermsType":"NET"},"purchasingEntity":{"__typename":"PurchasingCompany","company":{"id":"${TEST_COMPANY_ID}"},"location":{"id":"${TEST_LOCATION_ID}"}}}`,
      ];

      const upsertedCount = await processDraftOrderLines(sql, TEST_SHOP_DOMAIN, jsonlLines);
      expect(upsertedCount).toBe(1);

      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders
        WHERE draft_order_id = ${`gid://shopify/DraftOrder/pdl-upper-${TEST_SUFFIX}`}
      `;
      expect(row.status).toBe("open"); // Normalized to lowercase

      const exposure = await getPendingExposure(sql, TEST_ACCOUNT_ID);
      expect(exposure).toBe("5500.00");
    });
  });

  describe("#423 bulk reconcile flagging", () => {
    const BULK_423_SUFFIX = Date.now().toString(36) + "-bulk423";
    const BULK_SHOP_DOMAIN = `test-bulk423-${BULK_423_SUFFIX}.myshopify.com`;
    const BULK_SHOP_ID = `shop-bulk423-${BULK_423_SUFFIX}`;
    const BULK_ACCOUNT_A = `account-bulk423-a-${BULK_423_SUFFIX}`;
    const BULK_ACCOUNT_B = `account-bulk423-b-${BULK_423_SUFFIX}`;
    const BULK_COMPANY_A_ID = `gid://shopify/Company/co-bulk423-a-${BULK_423_SUFFIX}`;
    const BULK_LOCATION_A_ID = `gid://shopify/CompanyLocation/loc-bulk423-a-${BULK_423_SUFFIX}`;
    const BULK_COMPANY_B_ID = `gid://shopify/Company/co-bulk423-b-${BULK_423_SUFFIX}`;
    const BULK_LOCATION_B_ID = `gid://shopify/CompanyLocation/loc-bulk423-b-${BULK_423_SUFFIX}`;

    beforeAll(async () => {
      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${BULK_SHOP_ID}, ${BULK_SHOP_DOMAIN}, 'INR', NOW(), NOW())
      `;
      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "createdAt", "updatedAt"
        ) VALUES
        (${BULK_ACCOUNT_A}, ${BULK_SHOP_ID}, 'COMPANY', ${BULK_COMPANY_A_ID}, ${BULK_LOCATION_A_ID}, 'Bulk Test A', NOW(), NOW()),
        (${BULK_ACCOUNT_B}, ${BULK_SHOP_ID}, 'COMPANY', ${BULK_COMPANY_B_ID}, ${BULK_LOCATION_B_ID}, 'Bulk Test B', NOW(), NOW())
      `;
    });

    afterAll(async () => {
      await sql`DELETE FROM s8_draft_orders WHERE shop_id = ${BULK_SHOP_ID}`;
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${BULK_SHOP_DOMAIN}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${BULK_SHOP_ID}`;
      await sql`DELETE FROM "Shop" WHERE id = ${BULK_SHOP_ID}`;
    });

    beforeEach(async () => {
      await sql`DELETE FROM s8_draft_orders WHERE shop_id = ${BULK_SHOP_ID}`;
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${BULK_SHOP_DOMAIN}`;
    });

    async function getRecomputeMessages(): Promise<{ buyerAccountId: string; source: string; read_ct: number }[]> {
      return sql<{ buyerAccountId: string; source: string; read_ct: number }[]>`
        SELECT
          message->>'buyerAccountId' AS "buyerAccountId",
          message->>'source' AS source,
          read_ct
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${BULK_SHOP_DOMAIN}
          AND message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
      `;
    }

    it("bulkUpsertDraftOrders tracks affected accounts on insert", async () => {
      const draftOrders = [
        mapDraftOrder(
          BULK_SHOP_ID,
          {
            id: `gid://shopify/DraftOrder/bulk-flag-1-${BULK_423_SUFFIX}`,
            name: "#BULK-FLAG-1",
            createdAt: "2026-10-25T10:00:00Z",
            status: "open",
            totalPriceSet: { shopMoney: { amount: "1000.00", currencyCode: "INR" } },
            paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
          },
          BULK_ACCOUNT_A
        ),
        mapDraftOrder(
          BULK_SHOP_ID,
          {
            id: `gid://shopify/DraftOrder/bulk-flag-2-${BULK_423_SUFFIX}`,
            name: "#BULK-FLAG-2",
            createdAt: "2026-10-25T10:00:00Z",
            status: "open",
            totalPriceSet: { shopMoney: { amount: "2000.00", currencyCode: "INR" } },
            paymentTerms: { id: "pt2", paymentTermsName: "Net 30", paymentTermsType: "NET" },
          },
          BULK_ACCOUNT_B
        ),
      ];

      const result = await bulkUpsertDraftOrders(sql, draftOrders);

      expect(result.count).toBe(2);
      expect(result.affectedAccountIds.size).toBe(2);
      expect(result.affectedAccountIds.has(BULK_ACCOUNT_A)).toBe(true);
      expect(result.affectedAccountIds.has(BULK_ACCOUNT_B)).toBe(true);
    });

    it("bulkUpsertDraftOrders dedupes same account within batch", async () => {
      const draftOrders = [
        mapDraftOrder(
          BULK_SHOP_ID,
          {
            id: `gid://shopify/DraftOrder/bulk-dedupe-1-${BULK_423_SUFFIX}`,
            name: "#BULK-DEDUPE-1",
            createdAt: "2026-10-25T10:00:00Z",
            status: "open",
            totalPriceSet: { shopMoney: { amount: "1000.00", currencyCode: "INR" } },
            paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
          },
          BULK_ACCOUNT_A
        ),
        mapDraftOrder(
          BULK_SHOP_ID,
          {
            id: `gid://shopify/DraftOrder/bulk-dedupe-2-${BULK_423_SUFFIX}`,
            name: "#BULK-DEDUPE-2",
            createdAt: "2026-10-25T10:00:00Z",
            status: "open",
            totalPriceSet: { shopMoney: { amount: "2000.00", currencyCode: "INR" } },
            paymentTerms: { id: "pt2", paymentTermsName: "Net 30", paymentTermsType: "NET" },
          },
          BULK_ACCOUNT_A // Same account as first draft
        ),
      ];

      const result = await bulkUpsertDraftOrders(sql, draftOrders);

      expect(result.count).toBe(2);
      // D4: dedupe within batch - same account appears once in affectedAccountIds
      expect(result.affectedAccountIds.size).toBe(1);
      expect(result.affectedAccountIds.has(BULK_ACCOUNT_A)).toBe(true);
    });

    it("processDraftOrderLines with origin='reconcile' flags per batch", async () => {
      const jsonlLines = [
        `{"id":"gid://shopify/DraftOrder/pdl-reconcile-${BULK_423_SUFFIX}","name":"#PDL-RECONCILE","createdAt":"2026-10-25T10:00:00Z","status":"OPEN","totalPriceSet":{"shopMoney":{"amount":"5000.00","currencyCode":"INR"}},"paymentTerms":{"id":"pt1","paymentTermsName":"Net 30","paymentTermsType":"NET"},"purchasingEntity":{"__typename":"PurchasingCompany","company":{"id":"${BULK_COMPANY_A_ID}"},"location":{"id":"${BULK_LOCATION_A_ID}"}}}`,
      ];

      await processDraftOrderLines(sql, BULK_SHOP_DOMAIN, jsonlLines, "reconcile");

      const messages = await getRecomputeMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].buyerAccountId).toBe(BULK_ACCOUNT_A);
      expect(messages[0].source).toBe("draft_change");
    });

    it("processDraftOrderLines with origin='initial' does NOT flag per batch", async () => {
      const jsonlLines = [
        `{"id":"gid://shopify/DraftOrder/pdl-initial-${BULK_423_SUFFIX}","name":"#PDL-INITIAL","createdAt":"2026-10-25T10:00:00Z","status":"OPEN","totalPriceSet":{"shopMoney":{"amount":"5000.00","currencyCode":"INR"}},"paymentTerms":{"id":"pt1","paymentTermsName":"Net 30","paymentTermsType":"NET"},"purchasingEntity":{"__typename":"PurchasingCompany","company":{"id":"${BULK_COMPANY_A_ID}"},"location":{"id":"${BULK_LOCATION_A_ID}"}}}`,
      ];

      // D6: Initial sync does NOT flag per batch
      await processDraftOrderLines(sql, BULK_SHOP_DOMAIN, jsonlLines, "initial");

      const messages = await getRecomputeMessages();
      expect(messages).toHaveLength(0);
    });

    it("getAccountsWithDraftExposure returns accounts with open/invoice_sent drafts", async () => {
      // Create drafts with various statuses
      const draftIdOpen = `draft-exp-open-${BULK_423_SUFFIX}`;
      const draftIdSent = `draft-exp-sent-${BULK_423_SUFFIX}`;
      const draftIdCompleted = `draft-exp-completed-${BULK_423_SUFFIX}`;
      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at
        ) VALUES
        (${BULK_SHOP_ID}, ${draftIdOpen}, ${BULK_ACCOUNT_A}, '#EXP-OPEN', '1000.00', true, 'open', NOW()),
        (${BULK_SHOP_ID}, ${draftIdSent}, ${BULK_ACCOUNT_A}, '#EXP-SENT', '2000.00', true, 'invoice_sent', NOW()),
        (${BULK_SHOP_ID}, ${draftIdCompleted}, ${BULK_ACCOUNT_B}, '#EXP-COMPLETED', '3000.00', true, 'completed', NOW())
      `;

      const accounts = await getAccountsWithDraftExposure(sql, BULK_SHOP_DOMAIN);

      // Only account A has open/invoice_sent drafts
      expect(accounts.size).toBe(1);
      expect(accounts.has(BULK_ACCOUNT_A)).toBe(true);
      expect(accounts.has(BULK_ACCOUNT_B)).toBe(false);
    });

    it("two consecutive batches touching same account: debounce prevents duplicate messages", async () => {
      // First batch
      const jsonlLines1 = [
        `{"id":"gid://shopify/DraftOrder/pdl-batch1-${BULK_423_SUFFIX}","name":"#PDL-BATCH1","createdAt":"2026-10-25T10:00:00Z","status":"OPEN","totalPriceSet":{"shopMoney":{"amount":"1000.00","currencyCode":"INR"}},"paymentTerms":{"id":"pt1","paymentTermsName":"Net 30","paymentTermsType":"NET"},"purchasingEntity":{"__typename":"PurchasingCompany","company":{"id":"${BULK_COMPANY_A_ID}"},"location":{"id":"${BULK_LOCATION_A_ID}"}}}`,
      ];

      await processDraftOrderLines(sql, BULK_SHOP_DOMAIN, jsonlLines1, "reconcile");

      // Second batch (same account)
      const jsonlLines2 = [
        `{"id":"gid://shopify/DraftOrder/pdl-batch2-${BULK_423_SUFFIX}","name":"#PDL-BATCH2","createdAt":"2026-10-25T11:00:00Z","status":"OPEN","totalPriceSet":{"shopMoney":{"amount":"2000.00","currencyCode":"INR"}},"paymentTerms":{"id":"pt2","paymentTermsName":"Net 30","paymentTermsType":"NET"},"purchasingEntity":{"__typename":"PurchasingCompany","company":{"id":"${BULK_COMPANY_A_ID}"},"location":{"id":"${BULK_LOCATION_A_ID}"}}}`,
      ];

      await processDraftOrderLines(sql, BULK_SHOP_DOMAIN, jsonlLines2, "reconcile");

      // Should have only one message for account A due to debounce (read_ct = 0 check)
      const messages = await getRecomputeMessages();
      const accountAMessages = messages.filter((m) => m.buyerAccountId === BULK_ACCOUNT_A);
      expect(accountAMessages).toHaveLength(1);
    });
  });
});
