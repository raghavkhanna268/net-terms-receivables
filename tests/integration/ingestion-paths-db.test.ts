/**
 * Ingestion path integration tests.
 *
 * Tests the order and draft-order webhook processing paths including:
 * - Idempotency on redelivery
 * - Out-of-order webhook handling
 * - Partial refund and cancel amount adjustments
 * - Non-INR currency fail-closed behavior
 * - Aging bucket boundaries
 * - B2B company vs tag-mode buyer mapping
 * - PII logging guards
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import postgres from "postgres";
import { DateTime } from "luxon";
import { sqlOptions } from "../../app/lib/db-light.server.js";
import { processOrderWebhook } from "../../app/services/sync/order.server.js";
import { processDraftOrderWebhook } from "../../app/services/sync/draft-order.server.js";
import type { ShopifyOrder, ShopifyDraftOrder } from "../../app/services/sync/types.js";
import { syncClockToDb } from "../helpers/db-clock.js";
import {
  orderGid,
  draftOrderGid,
  companyGid,
  companyLocationGid,
  customerGid,
} from "../helpers/gid.js";
import { calculateDaysPastDue } from "../../app/lib/aging-dates.server.js";
import { getBucketForDaysPastDue, type AgingBucketKey } from "../../app/lib/aging.js";
import * as logModule from "../../app/lib/log.server.js";
import * as sentryModule from "../../app/lib/sentry.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("Ingestion Paths Integration", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = `ing-${Date.now().toString(36)}`;
  const TEST_SHOP_DOMAIN = `test-ingestion-${TEST_SUFFIX}.myshopify.com`;
  const TEST_SHOP_ID = `shop-ing-${TEST_SUFFIX}`;
  const TEST_COMPANY_ACCOUNT_ID = `account-co-${TEST_SUFFIX}`;
  const TEST_TAGGED_ACCOUNT_ID = `account-tag-${TEST_SUFFIX}`;
  const TEST_COMPANY_ID = companyGid(`co-${TEST_SUFFIX}`);
  const TEST_LOCATION_ID = companyLocationGid(`loc-${TEST_SUFFIX}`);
  const TEST_CUSTOMER_ID = customerGid(`cust-${TEST_SUFFIX}`);
  const TEST_TAG = "NET30-APPROVED";

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "defaultTermsDays", "defaultTermsSource",
        "createdAt", "updatedAt"
      ) VALUES (
        ${TEST_COMPANY_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${TEST_COMPANY_ID}, ${TEST_LOCATION_ID}, 'Test B2B Company',
        30, 'explicit',
        NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "customerId", name,
        "defaultTermsDays", "defaultTermsSource",
        "createdAt", "updatedAt"
      ) VALUES (
        ${TEST_TAGGED_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER',
        ${TEST_CUSTOMER_ID}, 'Tagged Customer Account',
        30, 'tag',
        NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "AccountSource" ("shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_TAG}, 30, NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s8_draft_orders WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "AccountSource" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${"wh-ing-" + TEST_SUFFIX + "%"}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s8_draft_orders WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${"wh-ing-" + TEST_SUFFIX + "%"}`;
  });

  describe("(1) Idempotency on redelivery", () => {
    it("order create: same webhook ID produces exactly one invoice", async () => {
      const orderId = orderGid(`idem-create-${TEST_SUFFIX}`);
      const webhookId = `wh-ing-idem-create-${TEST_SUFFIX}`;

      const order: ShopifyOrder = {
        id: orderId,
        name: "#IDEM-1",
        createdAt: "2026-10-01T10:00:00.000Z",
        displayFinancialStatus: "PENDING",
        totalPriceSet: { shopMoney: { amount: "10000.00", currencyCode: "INR" } },
        totalOutstandingSet: { shopMoney: { amount: "10000.00", currencyCode: "INR" } },
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET", dueInDays: 30 },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      const result1 = await processOrderWebhook(sql, TEST_SHOP_DOMAIN, "ORDERS_CREATE", order, webhookId);
      expect(result1.success).toBe(true);
      expect(result1.action).toBe("created");

      const result2 = await processOrderWebhook(sql, TEST_SHOP_DOMAIN, "ORDERS_CREATE", order, webhookId);
      expect(result2.success).toBe(true);
      expect(result2.action).toBe("skipped");
      expect(result2.skipReason).toContain("idempotent");

      const invoices = await sql`SELECT * FROM "Invoice" WHERE "orderId" = ${orderId}`;
      expect(invoices).toHaveLength(1);
    });

    it("order update: redelivery doesn't double outstanding", async () => {
      const orderId = orderGid(`idem-update-${TEST_SUFFIX}`);
      const webhookId = `wh-ing-idem-update-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status,
          "issuedAt", "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, ${TEST_SHOP_ID}, ${TEST_COMPANY_ACCOUNT_ID}, ${orderId},
          '#IDEM-UPDATE', '20000.00', '15000.00', 'open', NOW(), NOW(), NOW()
        )
      `;

      const order: ShopifyOrder = {
        id: orderId,
        name: "#IDEM-UPDATE",
        createdAt: "2026-10-01T10:00:00.000Z",
        displayFinancialStatus: "PARTIALLY_PAID",
        totalPriceSet: { shopMoney: { amount: "20000.00", currencyCode: "INR" } },
        totalOutstandingSet: { shopMoney: { amount: "12000.00", currencyCode: "INR" } },
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      await processOrderWebhook(sql, TEST_SHOP_DOMAIN, "ORDERS_UPDATED", order, webhookId);
      await processOrderWebhook(sql, TEST_SHOP_DOMAIN, "ORDERS_UPDATED", order, webhookId);

      const [invoice] = await sql`SELECT outstanding::text FROM "Invoice" WHERE "orderId" = ${orderId}`;
      expect(invoice.outstanding).toBe("12000.00");
    });

    it("order paid: redelivery keeps invoice paid", async () => {
      const orderId = orderGid(`idem-paid-${TEST_SUFFIX}`);
      const webhookId = `wh-ing-idem-paid-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status,
          "issuedAt", "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, ${TEST_SHOP_ID}, ${TEST_COMPANY_ACCOUNT_ID}, ${orderId},
          '#IDEM-PAID', '30000.00', '30000.00', 'open', NOW(), NOW(), NOW()
        )
      `;

      const order: ShopifyOrder = {
        id: orderId,
        name: "#IDEM-PAID",
        createdAt: "2026-10-01T10:00:00.000Z",
        displayFinancialStatus: "PAID",
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
      };

      await processOrderWebhook(sql, TEST_SHOP_DOMAIN, "ORDERS_PAID", order, webhookId);
      await processOrderWebhook(sql, TEST_SHOP_DOMAIN, "ORDERS_PAID", order, webhookId);

      const [invoice] = await sql`SELECT status, outstanding::text FROM "Invoice" WHERE "orderId" = ${orderId}`;
      expect(invoice.status).toBe("paid");
      expect(invoice.outstanding).toBe("0.00");
    });

    it("order cancelled: redelivery keeps invoice cancelled", async () => {
      const orderId = orderGid(`idem-cancel-${TEST_SUFFIX}`);
      const webhookId = `wh-ing-idem-cancel-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status,
          "issuedAt", "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, ${TEST_SHOP_ID}, ${TEST_COMPANY_ACCOUNT_ID}, ${orderId},
          '#IDEM-CANCEL', '25000.00', '25000.00', 'open', NOW(), NOW(), NOW()
        )
      `;

      const order: ShopifyOrder = {
        id: orderId,
        name: "#IDEM-CANCEL",
        createdAt: "2026-10-01T10:00:00.000Z",
        cancelledAt: "2026-10-02T10:00:00.000Z",
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
      };

      await processOrderWebhook(sql, TEST_SHOP_DOMAIN, "ORDERS_CANCELLED", order, webhookId);
      await processOrderWebhook(sql, TEST_SHOP_DOMAIN, "ORDERS_CANCELLED", order, webhookId);

      const [invoice] = await sql`SELECT status FROM "Invoice" WHERE "orderId" = ${orderId}`;
      expect(invoice.status).toBe("cancelled");
    });

    it("draft order create: same webhook ID produces exactly one record", async () => {
      const draftId = draftOrderGid(`idem-draft-${TEST_SUFFIX}`);
      const webhookId = `wh-ing-idem-draft-${TEST_SUFFIX}`;

      const draft: ShopifyDraftOrder = {
        id: draftId,
        name: "#DIDEM-1",
        createdAt: "2026-10-01T10:00:00.000Z",
        status: "OPEN",
        totalPriceSet: { shopMoney: { amount: "5000.00", currencyCode: "INR" } },
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      const result1 = await processDraftOrderWebhook(sql, TEST_SHOP_DOMAIN, "DRAFT_ORDERS_CREATE", draft, webhookId);
      expect(result1.success).toBe(true);
      expect(result1.action).toBe("created");

      const result2 = await processDraftOrderWebhook(sql, TEST_SHOP_DOMAIN, "DRAFT_ORDERS_CREATE", draft, webhookId);
      expect(result2.success).toBe(true);
      expect(result2.action).toBe("skipped");
      expect(result2.skipReason).toContain("idempotent");

      const drafts = await sql`SELECT * FROM s8_draft_orders WHERE draft_order_id = ${draftId}`;
      expect(drafts).toHaveLength(1);
    });
  });

  describe("(2) Last-write-wins webhook handling", () => {
    it("later update overwrites earlier outstanding (last-write-wins)", async () => {
      const orderId = orderGid(`lww-${TEST_SUFFIX}`);

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status,
          "issuedAt", "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, ${TEST_SHOP_ID}, ${TEST_COMPANY_ACCOUNT_ID}, ${orderId},
          '#LWW', '50000.00', '30000.00', 'open', NOW(), NOW(), NOW()
        )
      `;

      const newerOrder: ShopifyOrder = {
        id: orderId,
        name: "#LWW",
        createdAt: "2026-10-01T10:00:00.000Z",
        updatedAt: "2026-10-05T10:00:00.000Z",
        displayFinancialStatus: "PARTIALLY_PAID",
        totalPriceSet: { shopMoney: { amount: "50000.00", currencyCode: "INR" } },
        totalOutstandingSet: { shopMoney: { amount: "20000.00", currencyCode: "INR" } },
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      await processOrderWebhook(sql, TEST_SHOP_DOMAIN, "ORDERS_UPDATED", newerOrder, `wh-ing-lww-new-${TEST_SUFFIX}`);

      const [afterNewer] = await sql`SELECT outstanding::text FROM "Invoice" WHERE "orderId" = ${orderId}`;
      expect(afterNewer.outstanding).toBe("20000.00");

      const olderOrder: ShopifyOrder = {
        ...newerOrder,
        updatedAt: "2026-10-03T10:00:00.000Z",
        totalOutstandingSet: { shopMoney: { amount: "40000.00", currencyCode: "INR" } },
      };

      await processOrderWebhook(sql, TEST_SHOP_DOMAIN, "ORDERS_UPDATED", olderOrder, `wh-ing-lww-old-${TEST_SUFFIX}`);

      const [afterOlder] = await sql`SELECT outstanding::text FROM "Invoice" WHERE "orderId" = ${orderId}`;
      expect(afterOlder.outstanding).toBe("40000.00");
    });

    it("update after paid does not regress to open (terminal state protected)", async () => {
      const orderId = orderGid(`lww-paid-${TEST_SUFFIX}`);

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status,
          "issuedAt", "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, ${TEST_SHOP_ID}, ${TEST_COMPANY_ACCOUNT_ID}, ${orderId},
          '#LWW-PAID', '40000.00', '0.00', 'paid', NOW(), NOW(), NOW()
        )
      `;

      const updateOrder: ShopifyOrder = {
        id: orderId,
        name: "#LWW-PAID",
        createdAt: "2026-10-01T10:00:00.000Z",
        displayFinancialStatus: "PENDING",
        totalPriceSet: { shopMoney: { amount: "40000.00", currencyCode: "INR" } },
        totalOutstandingSet: { shopMoney: { amount: "40000.00", currencyCode: "INR" } },
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      await processOrderWebhook(sql, TEST_SHOP_DOMAIN, "ORDERS_UPDATED", updateOrder, `wh-ing-lww-paid-${TEST_SUFFIX}`);

      const [invoice] = await sql`SELECT status, outstanding::text FROM "Invoice" WHERE "orderId" = ${orderId}`;
      expect(invoice.status).toBe("paid");
      expect(invoice.outstanding).toBe("0.00");
    });
  });

  describe("(3) Partial refund and cancel adjust outstanding exactly", () => {
    it("partial refund adjusts outstanding precisely", async () => {
      const orderId = orderGid(`refund-${TEST_SUFFIX}`);
      const webhookId = `wh-ing-refund-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status,
          "issuedAt", "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, ${TEST_SHOP_ID}, ${TEST_COMPANY_ACCOUNT_ID}, ${orderId},
          '#REFUND', '100000.00', '100000.00', 'open', NOW(), NOW(), NOW()
        )
      `;

      const order: ShopifyOrder = {
        id: orderId,
        name: "#REFUND",
        createdAt: "2026-10-01T10:00:00.000Z",
        displayFinancialStatus: "PARTIALLY_REFUNDED",
        totalPriceSet: { shopMoney: { amount: "100000.00", currencyCode: "INR" } },
        totalOutstandingSet: { shopMoney: { amount: "73456.78", currencyCode: "INR" } },
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      await processOrderWebhook(sql, TEST_SHOP_DOMAIN, "ORDERS_UPDATED", order, webhookId);

      const [invoice] = await sql`SELECT outstanding::text, status FROM "Invoice" WHERE "orderId" = ${orderId}`;
      expect(invoice.outstanding).toBe("73456.78");
      expect(invoice.status).toBe("open");
    });

    it("cancel sets status to cancelled but leaves outstanding unchanged", async () => {
      const orderId = orderGid(`cancel-status-${TEST_SUFFIX}`);
      const webhookId = `wh-ing-cancel-status-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status,
          "issuedAt", "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, ${TEST_SHOP_ID}, ${TEST_COMPANY_ACCOUNT_ID}, ${orderId},
          '#CANCEL-STATUS', '88888.88', '88888.88', 'open', NOW(), NOW(), NOW()
        )
      `;

      const order: ShopifyOrder = {
        id: orderId,
        name: "#CANCEL-STATUS",
        createdAt: "2026-10-01T10:00:00.000Z",
        cancelledAt: "2026-10-02T10:00:00.000Z",
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
      };

      await processOrderWebhook(sql, TEST_SHOP_DOMAIN, "ORDERS_CANCELLED", order, webhookId);

      const [invoice] = await sql`SELECT outstanding::text, status FROM "Invoice" WHERE "orderId" = ${orderId}`;
      expect(invoice.status).toBe("cancelled");
      expect(invoice.outstanding).toBe("88888.88");
    });

    it("cancelled invoice excluded from buyer outstanding totals", async () => {
      const openOrderId = orderGid(`cancel-excl-open-${TEST_SUFFIX}`);
      const cancelledOrderId = orderGid(`cancel-excl-done-${TEST_SUFFIX}`);

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status,
          "issuedAt", "createdAt", "updatedAt"
        ) VALUES 
          (gen_random_uuid()::text, ${TEST_SHOP_ID}, ${TEST_COMPANY_ACCOUNT_ID}, ${openOrderId},
           '#EXCL-OPEN', '25000.00', '25000.00', 'open', NOW(), NOW(), NOW()),
          (gen_random_uuid()::text, ${TEST_SHOP_ID}, ${TEST_COMPANY_ACCOUNT_ID}, ${cancelledOrderId},
           '#EXCL-CANCELLED', '75000.00', '75000.00', 'cancelled', NOW(), NOW(), NOW())
      `;

      const [buyerTotal] = await sql<{ total_paise: string }[]>`
        SELECT COALESCE(SUM((ROUND(outstanding * 100))::bigint), 0)::text AS total_paise
        FROM "Invoice"
        WHERE "buyerAccountId" = ${TEST_COMPANY_ACCOUNT_ID}
          AND status = 'open'
      `;

      expect(buyerTotal.total_paise).toBe("2500000");
    });

    it("fully paid order closes the invoice with zero outstanding", async () => {
      const orderId = orderGid(`full-paid-${TEST_SUFFIX}`);
      const webhookId = `wh-ing-full-paid-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status,
          "issuedAt", "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, ${TEST_SHOP_ID}, ${TEST_COMPANY_ACCOUNT_ID}, ${orderId},
          '#FULL-PAID', '55555.55', '55555.55', 'open', NOW(), NOW(), NOW()
        )
      `;

      const order: ShopifyOrder = {
        id: orderId,
        name: "#FULL-PAID",
        createdAt: "2026-10-01T10:00:00.000Z",
        displayFinancialStatus: "PAID",
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
      };

      await processOrderWebhook(sql, TEST_SHOP_DOMAIN, "ORDERS_PAID", order, webhookId);

      const [invoice] = await sql`SELECT outstanding::text, status FROM "Invoice" WHERE "orderId" = ${orderId}`;
      expect(invoice.outstanding).toBe("0.00");
      expect(invoice.status).toBe("paid");
    });
  });

  describe("(4) Non-INR currency fail-closed behavior", () => {
    it("non-INR order is skipped with order_currency_not_supported", async () => {
      const orderId = orderGid(`usd-${TEST_SUFFIX}`);
      const webhookId = `wh-ing-usd-${TEST_SUFFIX}`;

      const order: ShopifyOrder = {
        id: orderId,
        name: "#USD-ORDER",
        createdAt: "2026-10-01T10:00:00.000Z",
        displayFinancialStatus: "PENDING",
        totalPriceSet: { shopMoney: { amount: "1000.00", currencyCode: "USD" } },
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      const result = await processOrderWebhook(sql, TEST_SHOP_DOMAIN, "ORDERS_CREATE", order, webhookId);

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toBe("order_currency_not_supported");

      const invoices = await sql`SELECT * FROM "Invoice" WHERE "orderId" = ${orderId}`;
      expect(invoices).toHaveLength(0);
    });

    it("order with missing currency is skipped with order_currency_missing", async () => {
      const orderId = orderGid(`no-currency-${TEST_SUFFIX}`);
      const webhookId = `wh-ing-no-currency-${TEST_SUFFIX}`;

      const order: ShopifyOrder = {
        id: orderId,
        name: "#NO-CURRENCY",
        createdAt: "2026-10-01T10:00:00.000Z",
        displayFinancialStatus: "PENDING",
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      const result = await processOrderWebhook(sql, TEST_SHOP_DOMAIN, "ORDERS_CREATE", order, webhookId);

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toBe("order_currency_missing");
    });

    it("non-INR draft order is skipped", async () => {
      const draftId = draftOrderGid(`eur-draft-${TEST_SUFFIX}`);
      const webhookId = `wh-ing-eur-draft-${TEST_SUFFIX}`;

      const draft: ShopifyDraftOrder = {
        id: draftId,
        name: "#EUR-DRAFT",
        createdAt: "2026-10-01T10:00:00.000Z",
        status: "OPEN",
        totalPriceSet: { shopMoney: { amount: "500.00", currencyCode: "EUR" } },
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      const result = await processDraftOrderWebhook(sql, TEST_SHOP_DOMAIN, "DRAFT_ORDERS_CREATE", draft, webhookId);

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toBe("draft_order_currency_not_supported");
    });
  });

  describe("(5) Aging buckets at exact boundaries", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const AGING_BOUNDARY_TESTS: Array<{
      name: string;
      daysPastDue: number;
      expectedBucket: AgingBucketKey;
    }> = [
      { name: "day 0 (due today) -> current", daysPastDue: 0, expectedBucket: "current" },
      { name: "day 1 -> 1-30", daysPastDue: 1, expectedBucket: "1-30" },
      { name: "day 30 -> 1-30", daysPastDue: 30, expectedBucket: "1-30" },
      { name: "day 31 -> 31-60", daysPastDue: 31, expectedBucket: "31-60" },
      { name: "day 60 -> 31-60", daysPastDue: 60, expectedBucket: "31-60" },
      { name: "day 61 -> 61-90", daysPastDue: 61, expectedBucket: "61-90" },
      { name: "day 90 -> 61-90", daysPastDue: 90, expectedBucket: "61-90" },
      { name: "day 91 -> 90+", daysPastDue: 91, expectedBucket: "90+" },
    ];

    for (const { name, daysPastDue, expectedBucket } of AGING_BOUNDARY_TESTS) {
      it(name, async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const dbNow = await syncClockToDb(sql);

        const asOfDate = DateTime.fromJSDate(dbNow, { zone: "Asia/Kolkata" }).startOf("day").toJSDate();
        const dueDate = DateTime.fromJSDate(asOfDate, { zone: "Asia/Kolkata" })
          .minus({ days: daysPastDue })
          .endOf("day")
          .toJSDate();

        const computed = calculateDaysPastDue(dueDate, asOfDate, "Asia/Kolkata");
        const bucket = getBucketForDaysPastDue(computed);

        expect(computed).toBe(daysPastDue);
        expect(bucket).toBe(expectedBucket);
      });
    }

  });

  describe("(6) Buyer mapping: native B2B vs tag-mode", () => {
    it("native B2B company order maps to company BuyerAccount", async () => {
      const orderId = orderGid(`b2b-${TEST_SUFFIX}`);
      const webhookId = `wh-ing-b2b-${TEST_SUFFIX}`;

      const order: ShopifyOrder = {
        id: orderId,
        name: "#B2B-ORDER",
        createdAt: "2026-10-01T10:00:00.000Z",
        displayFinancialStatus: "PENDING",
        totalPriceSet: { shopMoney: { amount: "75000.00", currencyCode: "INR" } },
        totalOutstandingSet: { shopMoney: { amount: "75000.00", currencyCode: "INR" } },
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET", dueInDays: 30 },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      const result = await processOrderWebhook(sql, TEST_SHOP_DOMAIN, "ORDERS_CREATE", order, webhookId);
      expect(result.success).toBe(true);
      expect(result.action).toBe("created");

      const [invoice] = await sql`SELECT "buyerAccountId" FROM "Invoice" WHERE "orderId" = ${orderId}`;
      expect(invoice.buyerAccountId).toBe(TEST_COMPANY_ACCOUNT_ID);
    });

    it("tag-mode draft order maps to tagged customer BuyerAccount", async () => {
      const draftId = draftOrderGid(`tag-draft-${TEST_SUFFIX}`);
      const webhookId = `wh-ing-tag-draft-${TEST_SUFFIX}`;

      const draft: ShopifyDraftOrder = {
        id: draftId,
        name: "#TAG-DRAFT",
        createdAt: "2026-10-01T10:00:00.000Z",
        status: "OPEN",
        totalPriceSet: { shopMoney: { amount: "15000.00", currencyCode: "INR" } },
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET", dueInDays: 30 },
        customer: { id: TEST_CUSTOMER_ID },
      };

      const result = await processDraftOrderWebhook(sql, TEST_SHOP_DOMAIN, "DRAFT_ORDERS_CREATE", draft, webhookId);
      expect(result.success).toBe(true);
      expect(result.action).toBe("created");

      const [draftRecord] = await sql`SELECT buyer_account_id FROM s8_draft_orders WHERE draft_order_id = ${draftId}`;
      expect(draftRecord.buyer_account_id).toBe(TEST_TAGGED_ACCOUNT_ID);
    });
  });

  describe("(7) PII logging guards", () => {
    let safeLogSpy: ReturnType<typeof vi.spyOn>;
    let captureExceptionSpy: ReturnType<typeof vi.spyOn>;

    const PII_BUYER_NAME = "Rajesh Kumar Private Limited";
    const PII_EMAIL = "buyer@example.com";
    const PII_PHONE = "+91-9876543210";
    const PII_AMOUNT = "99999.99";

    beforeEach(() => {
      safeLogSpy = vi.spyOn(logModule, "safeLog");
      captureExceptionSpy = vi.spyOn(sentryModule, "captureExceptionWithTags");
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("order processing logs contain no buyer PII", async () => {
      const orderId = orderGid(`pii-order-${TEST_SUFFIX}`);
      const webhookId = `wh-ing-pii-order-${TEST_SUFFIX}`;

      await sql`
        UPDATE "BuyerAccount"
        SET name = ${PII_BUYER_NAME}
        WHERE id = ${TEST_COMPANY_ACCOUNT_ID}
      `;

      const order: ShopifyOrder = {
        id: orderId,
        name: "#PII-TEST",
        createdAt: "2026-10-01T10:00:00.000Z",
        displayFinancialStatus: "PENDING",
        totalPriceSet: { shopMoney: { amount: PII_AMOUNT, currencyCode: "INR" } },
        totalOutstandingSet: { shopMoney: { amount: PII_AMOUNT, currencyCode: "INR" } },
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET", dueInDays: 30 },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
        customer: {
          id: TEST_CUSTOMER_ID,
          tags: [TEST_TAG],
        },
      };

      await processOrderWebhook(sql, TEST_SHOP_DOMAIN, "ORDERS_CREATE", order, webhookId);

      expect(safeLogSpy.mock.calls.length).toBeGreaterThan(0);

      const loggedEvents = safeLogSpy.mock.calls.map(call => call[1] as string);
      expect(loggedEvents.length).toBeGreaterThan(0);

      for (const call of safeLogSpy.mock.calls) {
        const allArgs = JSON.stringify(call);
        expect(allArgs).not.toContain(PII_BUYER_NAME);
        expect(allArgs).not.toContain(PII_EMAIL);
        expect(allArgs).not.toContain(PII_PHONE);
        expect(allArgs).not.toContain(PII_AMOUNT);
        expect(allArgs).not.toContain("Rajesh");
        expect(allArgs).not.toContain("Kumar");
        expect(allArgs).not.toContain("buyer@");
      }

      for (const call of captureExceptionSpy.mock.calls) {
        const allArgs = JSON.stringify(call);
        expect(allArgs).not.toContain(PII_BUYER_NAME);
        expect(allArgs).not.toContain(PII_EMAIL);
        expect(allArgs).not.toContain(PII_PHONE);
        expect(allArgs).not.toContain(PII_AMOUNT);
      }
    });

    it("draft order processing logs contain no buyer PII", async () => {
      const draftId = draftOrderGid(`pii-draft-${TEST_SUFFIX}`);
      const webhookId = `wh-ing-pii-draft-${TEST_SUFFIX}`;

      await sql`
        UPDATE "BuyerAccount"
        SET name = ${PII_BUYER_NAME}
        WHERE id = ${TEST_TAGGED_ACCOUNT_ID}
      `;

      const draft: ShopifyDraftOrder = {
        id: draftId,
        name: "#PII-DRAFT",
        createdAt: "2026-10-01T10:00:00.000Z",
        status: "OPEN",
        totalPriceSet: { shopMoney: { amount: PII_AMOUNT, currencyCode: "INR" } },
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: TEST_COMPANY_ID },
          location: { id: TEST_LOCATION_ID },
        },
      };

      await processDraftOrderWebhook(sql, TEST_SHOP_DOMAIN, "DRAFT_ORDERS_CREATE", draft, webhookId);

      expect(safeLogSpy.mock.calls.length).toBeGreaterThan(0);

      const loggedEvents = safeLogSpy.mock.calls.map(call => call[1] as string);
      expect(loggedEvents.length).toBeGreaterThan(0);

      for (const call of safeLogSpy.mock.calls) {
        const allArgs = JSON.stringify(call);
        expect(allArgs).not.toContain(PII_BUYER_NAME);
        expect(allArgs).not.toContain(PII_EMAIL);
        expect(allArgs).not.toContain(PII_PHONE);
        expect(allArgs).not.toContain(PII_AMOUNT);
        expect(allArgs).not.toContain("Rajesh");
        expect(allArgs).not.toContain("Kumar");
      }
    });

    it("error scenarios log safe codes without PII", async () => {
      const orderId = orderGid(`pii-error-${TEST_SUFFIX}`);
      const webhookId = `wh-ing-pii-error-${TEST_SUFFIX}`;

      const invalidOrder: ShopifyOrder = {
        id: orderId,
        name: "#PII-ERROR",
        createdAt: "2026-10-01T10:00:00.000Z",
        displayFinancialStatus: "PENDING",
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: companyGid(`nonexistent-${TEST_SUFFIX}`) },
          location: { id: companyLocationGid(`nonexistent-${TEST_SUFFIX}`) },
        },
      };

      await processOrderWebhook(sql, TEST_SHOP_DOMAIN, "ORDERS_CREATE", invalidOrder, webhookId);

      for (const call of safeLogSpy.mock.calls) {
        const allArgs = JSON.stringify(call);
        expect(allArgs).not.toContain(PII_BUYER_NAME);
        expect(allArgs).not.toContain(PII_EMAIL);
        expect(allArgs).not.toContain(PII_PHONE);
      }

      for (const call of captureExceptionSpy.mock.calls) {
        const allArgs = JSON.stringify(call);
        expect(allArgs).not.toContain(PII_BUYER_NAME);
        expect(allArgs).not.toContain(PII_EMAIL);
        expect(allArgs).not.toContain(PII_PHONE);
      }
    });
  });
});
