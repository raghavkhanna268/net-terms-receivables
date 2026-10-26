/**
 * DB-backed tests for cancel-outstanding and draft-completed-guard changes.
 *
 * Tests:
 * 1. cancelInvoice sets outstanding = 0.00 and only affects open invoices
 * 2. Draft order upsert guards terminal 'completed' status and freezes total
 *
 * Revert notes:
 * - "cancel webhook sets outstanding to 0" fails if cancelInvoice doesn't set outstanding
 * - "cancel on already-paid invoice leaves it untouched" fails if status guard is removed
 * - "stale draft refetch after completed stays completed" fails if status guard is removed
 * - "stale draft refetch preserves total when completed" fails if total guard is removed
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { processOrderWebhook } from "../order.server";
import {
  processDraftOrderWebhook,
  getPendingExposure,
  bulkUpsertDraftOrders,
  mapDraftOrder,
} from "../draft-order.server";
import type { ShopifyOrder, ShopifyDraftOrder } from "../types";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("Cancel outstanding and draft completed guard (DB-backed)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = `cog-${Date.now().toString(36)}`;
  const TEST_SHOP_ID = `shop-cog-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-cog-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `account-cog-${TEST_SUFFIX}`;
  const TEST_COMPANY_ID = `gid://shopify/Company/co-cog-${TEST_SUFFIX}`;
  const TEST_LOCATION_ID = `gid://shopify/CompanyLocation/loc-cog-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "defaultTermsDays", "defaultTermsSource",
        "createdAt", "updatedAt"
      ) VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${TEST_COMPANY_ID}, ${TEST_LOCATION_ID}, 'Test COG Company',
        30, 'explicit',
        NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s8_draft_orders WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${"wh-cog-" + TEST_SUFFIX + "%"}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s8_draft_orders WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${"wh-cog-" + TEST_SUFFIX + "%"}`;
  });

  describe("cancelInvoice sets outstanding = 0.00", () => {
    /**
     * REVERT NOTE: This test fails if cancelInvoice doesn't set outstanding = '0.00'.
     * The change ensures cancel webhook zeroes outstanding, matching orders/updated cancel mapping.
     */
    it("cancel webhook sets outstanding to 0 (fails if change reverted)", async () => {
      const orderId = `gid://shopify/Order/cancel-out-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status,
          "issuedAt", "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#CANCEL-OUT', '50000.00', '50000.00', 'open',
          NOW(), NOW(), NOW()
        )
      `;

      const order: ShopifyOrder = {
        id: orderId,
        name: "#CANCEL-OUT",
        createdAt: "2026-10-01T10:00:00.000Z",
        cancelledAt: "2026-10-02T10:00:00.000Z",
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
      };

      const result = await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_CANCELLED",
        order,
        `wh-cog-cancel-1-${TEST_SUFFIX}`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("updated");

      const [invoice] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE "orderId" = ${orderId}
      `;
      expect(invoice.status).toBe("cancelled");
      expect(invoice.outstanding).toBe("0.00");
    });

    /**
     * REVERT NOTE: This test fails if cancelInvoice doesn't set outstanding = '0.00'.
     * Verifies cancel webhook first, then orders/updated (cancelled) both result in outstanding = 0.
     */
    it("cancel webhook first, then orders/updated (cancelled): outstanding is 0", async () => {
      const orderId = `gid://shopify/Order/cancel-then-update-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status,
          "issuedAt", "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#CANCEL-UPDATE', '30000.00', '30000.00', 'open',
          NOW(), NOW(), NOW()
        )
      `;

      const cancelOrder: ShopifyOrder = {
        id: orderId,
        name: "#CANCEL-UPDATE",
        createdAt: "2026-10-01T10:00:00.000Z",
        cancelledAt: "2026-10-02T10:00:00.000Z",
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
      };

      await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_CANCELLED",
        cancelOrder,
        `wh-cog-cancel-first-${TEST_SUFFIX}`
      );

      const [afterCancel] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE "orderId" = ${orderId}
      `;
      expect(afterCancel.status).toBe("cancelled");
      expect(afterCancel.outstanding).toBe("0.00");

      const updateOrder: ShopifyOrder = {
        id: orderId,
        name: "#CANCEL-UPDATE",
        createdAt: "2026-10-01T10:00:00.000Z",
        cancelledAt: "2026-10-02T10:00:00.000Z",
        displayFinancialStatus: "VOIDED",
        totalPriceSet: { shopMoney: { amount: "30000.00", currencyCode: "INR" } },
        totalOutstandingSet: { shopMoney: { amount: "0.00", currencyCode: "INR" } },
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
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
        updateOrder,
        `wh-cog-update-after-cancel-${TEST_SUFFIX}`
      );

      const [afterUpdate] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE "orderId" = ${orderId}
      `;
      expect(afterUpdate.status).toBe("cancelled");
      expect(afterUpdate.outstanding).toBe("0.00");
    });

    /**
     * REVERT NOTE: This test fails if cancelInvoice doesn't set outstanding = '0.00'.
     * Verifies orders/updated (cancelled) first, then cancel webhook both result in outstanding = 0.
     */
    it("orders/updated (cancelled) first, then cancel webhook: outstanding is 0", async () => {
      const orderId = `gid://shopify/Order/update-then-cancel-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status,
          "issuedAt", "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#UPDATE-CANCEL', '25000.00', '25000.00', 'open',
          NOW(), NOW(), NOW()
        )
      `;

      const updateOrder: ShopifyOrder = {
        id: orderId,
        name: "#UPDATE-CANCEL",
        createdAt: "2026-10-01T10:00:00.000Z",
        cancelledAt: "2026-10-02T10:00:00.000Z",
        displayFinancialStatus: "VOIDED",
        totalPriceSet: { shopMoney: { amount: "25000.00", currencyCode: "INR" } },
        totalOutstandingSet: { shopMoney: { amount: "0.00", currencyCode: "INR" } },
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
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
        updateOrder,
        `wh-cog-update-first-${TEST_SUFFIX}`
      );

      const [afterUpdate] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE "orderId" = ${orderId}
      `;
      expect(afterUpdate.status).toBe("cancelled");
      expect(afterUpdate.outstanding).toBe("0.00");

      const cancelOrder: ShopifyOrder = {
        id: orderId,
        name: "#UPDATE-CANCEL",
        createdAt: "2026-10-01T10:00:00.000Z",
        cancelledAt: "2026-10-02T10:00:00.000Z",
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
      };

      await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_CANCELLED",
        cancelOrder,
        `wh-cog-cancel-after-update-${TEST_SUFFIX}`
      );

      const [afterCancel] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE "orderId" = ${orderId}
      `;
      expect(afterCancel.status).toBe("cancelled");
      expect(afterCancel.outstanding).toBe("0.00");
    });

    /**
     * REVERT NOTE: This test fails if the AND status = 'open' guard is removed from cancelInvoice.
     * Paid invoices must not be modified by cancel webhook.
     */
    it("cancel on already-paid invoice leaves it untouched (fails if guard reverted)", async () => {
      const orderId = `gid://shopify/Order/cancel-paid-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status,
          "issuedAt", "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#CANCEL-PAID', '40000.00', '0.00', 'paid',
          NOW(), NOW(), NOW()
        )
      `;

      const order: ShopifyOrder = {
        id: orderId,
        name: "#CANCEL-PAID",
        createdAt: "2026-10-01T10:00:00.000Z",
        cancelledAt: "2026-10-02T10:00:00.000Z",
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
      };

      const result = await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_CANCELLED",
        order,
        `wh-cog-cancel-paid-${TEST_SUFFIX}`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");

      const [invoice] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE "orderId" = ${orderId}
      `;
      expect(invoice.status).toBe("paid");
      expect(invoice.outstanding).toBe("0.00");
    });

    it("cancel on already-cancelled invoice leaves it untouched", async () => {
      const orderId = `gid://shopify/Order/cancel-cancelled-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status,
          "issuedAt", "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#CANCEL-CANCELLED', '35000.00', '0.00', 'cancelled',
          NOW(), NOW(), NOW()
        )
      `;

      const order: ShopifyOrder = {
        id: orderId,
        name: "#CANCEL-CANCELLED",
        createdAt: "2026-10-01T10:00:00.000Z",
        cancelledAt: "2026-10-02T10:00:00.000Z",
        paymentTerms: { id: "pt1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
      };

      const result = await processOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "ORDERS_CANCELLED",
        order,
        `wh-cog-cancel-cancelled-${TEST_SUFFIX}`
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");

      const [invoice] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE "orderId" = ${orderId}
      `;
      expect(invoice.status).toBe("cancelled");
      expect(invoice.outstanding).toBe("0.00");
    });
  });

  describe("Draft order completed guard", () => {
    /**
     * REVERT NOTE: This test fails if the status CASE guard is removed from upsertDraftOrder.
     * A stale refetch with status='open' must not downgrade a 'completed' draft.
     */
    it("stale draft refetch after completed stays completed (fails if guard reverted)", async () => {
      const draftOrderId = `gid://shopify/DraftOrder/stale-completed-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftOrderId}, ${TEST_ACCOUNT_ID}, '#STALE-COMPLETED', '20000.00',
          true, 'completed', NOW(), NOW()
        )
      `;

      const staleDraft: ShopifyDraftOrder = {
        id: draftOrderId,
        name: "#STALE-COMPLETED",
        createdAt: "2026-10-01T10:00:00.000Z",
        status: "open",
        totalPriceSet: { shopMoney: { amount: "20000.00", currencyCode: "INR" } },
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

      await processDraftOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "DRAFT_ORDERS_UPDATE",
        staleDraft,
        `wh-cog-stale-draft-${TEST_SUFFIX}`
      );

      const [draft] = await sql<{ status: string; total: string }[]>`
        SELECT status, total::text FROM s8_draft_orders WHERE draft_order_id = ${draftOrderId}
      `;
      expect(draft.status).toBe("completed");

      const exposure = await getPendingExposure(sql, TEST_ACCOUNT_ID);
      expect(exposure).toBe("0.00");
    });

    /**
     * REVERT NOTE: This test fails if the total CASE guard is removed from upsertDraftOrder.
     * A stale refetch must not change total when status is 'completed'.
     */
    it("stale draft refetch preserves total when completed (fails if guard reverted)", async () => {
      const draftOrderId = `gid://shopify/DraftOrder/stale-total-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftOrderId}, ${TEST_ACCOUNT_ID}, '#STALE-TOTAL', '15000.00',
          true, 'completed', NOW(), NOW()
        )
      `;

      const staleDraft: ShopifyDraftOrder = {
        id: draftOrderId,
        name: "#STALE-TOTAL",
        createdAt: "2026-10-01T10:00:00.000Z",
        status: "open",
        totalPriceSet: { shopMoney: { amount: "99999.00", currencyCode: "INR" } },
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

      await processDraftOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "DRAFT_ORDERS_UPDATE",
        staleDraft,
        `wh-cog-stale-total-${TEST_SUFFIX}`
      );

      const [draft] = await sql<{ status: string; total: string }[]>`
        SELECT status, total::text FROM s8_draft_orders WHERE draft_order_id = ${draftOrderId}
      `;
      expect(draft.status).toBe("completed");
      expect(draft.total).toBe("15000.00");
    });

    it("normal draft open to completed transition works", async () => {
      const draftOrderId = `gid://shopify/DraftOrder/open-completed-${TEST_SUFFIX}`;

      const openDraft: ShopifyDraftOrder = {
        id: draftOrderId,
        name: "#OPEN-COMPLETED",
        createdAt: "2026-10-01T10:00:00.000Z",
        status: "open",
        totalPriceSet: { shopMoney: { amount: "18000.00", currencyCode: "INR" } },
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

      await processDraftOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "DRAFT_ORDERS_CREATE",
        openDraft,
        `wh-cog-open-create-${TEST_SUFFIX}`
      );

      const [afterOpen] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftOrderId}
      `;
      expect(afterOpen.status).toBe("open");

      const exposureOpen = await getPendingExposure(sql, TEST_ACCOUNT_ID);
      expect(exposureOpen).toBe("18000.00");

      const completedDraft: ShopifyDraftOrder = {
        ...openDraft,
        status: "completed",
      };

      await processDraftOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "DRAFT_ORDERS_UPDATE",
        completedDraft,
        `wh-cog-open-complete-${TEST_SUFFIX}`
      );

      const [afterComplete] = await sql<{ status: string }[]>`
        SELECT status FROM s8_draft_orders WHERE draft_order_id = ${draftOrderId}
      `;
      expect(afterComplete.status).toBe("completed");

      const exposureComplete = await getPendingExposure(sql, TEST_ACCOUNT_ID);
      expect(exposureComplete).toBe("0.00");
    });

    it("bulk upsert also guards completed status", async () => {
      const draftOrderId = `gid://shopify/DraftOrder/bulk-completed-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftOrderId}, ${TEST_ACCOUNT_ID}, '#BULK-COMPLETED', '22000.00',
          true, 'completed', NOW(), NOW()
        )
      `;

      const staleMapped = mapDraftOrder(
        TEST_SHOP_ID,
        {
          id: draftOrderId,
          name: "#BULK-COMPLETED",
          createdAt: "2026-10-01T10:00:00.000Z",
          status: "open",
          totalPriceSet: { shopMoney: { amount: "88888.00", currencyCode: "INR" } },
          paymentTerms: {
            id: "pt1",
            paymentTermsName: "Net 30",
            paymentTermsType: "NET",
          },
        },
        TEST_ACCOUNT_ID
      );

      await bulkUpsertDraftOrders(sql, [staleMapped]);

      const [draft] = await sql<{ status: string; total: string }[]>`
        SELECT status, total::text FROM s8_draft_orders WHERE draft_order_id = ${draftOrderId}
      `;
      expect(draft.status).toBe("completed");
      expect(draft.total).toBe("22000.00");
    });

    it("completed draft exposure is zero and remains zero after stale refetch", async () => {
      const draftOrderId = `gid://shopify/DraftOrder/exp-completed-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s8_draft_orders (
          shop_id, draft_order_id, buyer_account_id, name, total,
          has_payment_terms, status, created_at, updated_at
        ) VALUES (
          ${TEST_SHOP_ID}, ${draftOrderId}, ${TEST_ACCOUNT_ID}, '#EXP-COMPLETED', '50000.00',
          true, 'completed', NOW(), NOW()
        )
      `;

      const exposureBefore = await getPendingExposure(sql, TEST_ACCOUNT_ID);
      expect(exposureBefore).toBe("0.00");

      const staleDraft: ShopifyDraftOrder = {
        id: draftOrderId,
        name: "#EXP-COMPLETED",
        createdAt: "2026-10-01T10:00:00.000Z",
        status: "open",
        totalPriceSet: { shopMoney: { amount: "50000.00", currencyCode: "INR" } },
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

      await processDraftOrderWebhook(
        sql,
        TEST_SHOP_DOMAIN,
        "DRAFT_ORDERS_UPDATE",
        staleDraft,
        `wh-cog-exp-stale-${TEST_SUFFIX}`
      );

      const exposureAfter = await getPendingExposure(sql, TEST_ACCOUNT_ID);
      expect(exposureAfter).toBe("0.00");
    });
  });
});
