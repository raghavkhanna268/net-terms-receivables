/**
 * DB-backed tests for due date normalization (date-only midnight values).
 *
 * Tests that PaymentSchedule dueAt values of exactly 00:00:00.000Z are
 * normalized to shop-local end-of-day (23:59:59.999) during sync, ensuring
 * (dueAt AT TIME ZONE tz)::date equals the intended calendar date.
 *
 * Covers order sync via processOrderWebhook (RECEIPT, NET schedules).
 * The bulk sync orphan-schedule path is tested separately.
 *
 * Uses synthetic test data only (test-* domains, example.com).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { processOrderWebhook } from "../order.server";
import type { ShopifyOrder } from "../types";
import { archiveForeignQueueRows } from "../../../../tests/helpers/archive-foreign-queue-rows";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("Due date normalization for midnight UTC values (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-duenorm";

  const TIMEZONES = [
    { tz: "America/New_York", suffix: "ny", expectedUtc: "2026-11-27T04:59:59.999Z" },
    { tz: "Asia/Kolkata", suffix: "ist", expectedUtc: "2026-11-26T18:29:59.999Z" },
    { tz: "Pacific/Auckland", suffix: "nz", expectedUtc: "2026-11-26T10:59:59.999Z" },
  ] as const;

  const shops: Record<string, { id: string; domain: string; accountId: string; locationId: string; companyId: string }> = {};

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    for (const { tz, suffix } of TIMEZONES) {
      const shopId = `shop-duenorm-${suffix}-${TEST_SUFFIX}`;
      const shopDomain = `test-duenorm-${suffix}-${TEST_SUFFIX}.example.com`;
      const accountId = `acc-duenorm-${suffix}-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/co-duenorm-${suffix}-${TEST_SUFFIX}`;
      const locationId = `gid://shopify/CompanyLocation/loc-duenorm-${suffix}-${TEST_SUFFIX}`;

      shops[suffix] = { id: shopId, domain: shopDomain, accountId, locationId, companyId };

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt")
        VALUES (${shopId}, ${shopDomain}, 'INR', ${tz}, NOW(), NOW())
      `;

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "defaultTermsDays", "defaultTermsSource",
          "createdAt", "updatedAt"
        ) VALUES (
          ${accountId}, ${shopId}, 'COMPANY', ${companyId}, ${locationId}, 'Test Company',
          30, 'explicit', NOW(), NOW()
        )
      `;
    }

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
    for (const { suffix } of TIMEZONES) {
      const shop = shops[suffix];
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${shop.id}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${shop.id}`;
      await sql`DELETE FROM "Shop" WHERE id = ${shop.id}`;
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${"wh-duenorm-" + suffix + "-" + TEST_SUFFIX + "%"}`;
    }
    await sql.end();
  });

  beforeEach(async () => {
    for (const { suffix } of TIMEZONES) {
      const shop = shops[suffix];
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${shop.id}`;
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${"wh-duenorm-" + suffix + "-" + TEST_SUFFIX + "%"}`;
    }
    const ownShopDomains = TIMEZONES.map(({ suffix }) => shops[suffix].domain);
    await archiveForeignQueueRows(sql, ownShopDomains);
  });

  describe("Order webhook path (processOrderWebhook)", () => {
    it.each(TIMEZONES)(
      "normalizes 00:00:00.000Z to local date for $tz (RECEIPT schedule)",
      async ({ tz, suffix, expectedUtc }) => {
        const shop = shops[suffix];
        const orderId = `gid://shopify/Order/ord-receipt-${suffix}-${TEST_SUFFIX}`;

        const order: ShopifyOrder = {
          id: orderId,
          name: "#1001",
          createdAt: "2026-11-15T10:00:00.000Z",
          displayFinancialStatus: "PENDING",
          totalPriceSet: {
            shopMoney: { amount: "50000.00", currencyCode: "INR" },
          },
          paymentTerms: {
            id: "pt1",
            paymentTermsName: "Due on receipt",
            paymentTermsType: "RECEIPT",
            dueInDays: 0,
            paymentSchedules: {
              edges: [
                {
                  node: {
                    id: `gid://shopify/PaymentSchedule/sched-receipt-${suffix}-${TEST_SUFFIX}`,
                    dueAt: "2026-11-26T00:00:00.000Z",
                    completedAt: null,
                  },
                },
              ],
            },
          },
          purchasingEntity: {
            __typename: "PurchasingCompany",
            company: { id: shop.companyId },
            location: { id: shop.locationId },
          },
        };

        const result = await processOrderWebhook(
          sql,
          shop.domain,
          "ORDERS_CREATE",
          order,
          `wh-duenorm-${suffix}-receipt-${TEST_SUFFIX}`
        );

        expect(result.success).toBe(true);

        const [invoice] = await sql<{ dueAt: Date; localDate: string }[]>`
          SELECT
            "dueAt",
            ("dueAt" AT TIME ZONE ${tz})::DATE::TEXT AS "localDate"
          FROM "Invoice"
          WHERE "orderId" = ${orderId}
        `;

        expect(invoice).toBeDefined();
        expect(invoice.localDate).toBe("2026-11-26");
        expect(invoice.dueAt.toISOString()).toBe(expectedUtc);
      }
    );

    it.each(TIMEZONES)(
      "normalizes 00:00:00.000Z to local date for $tz (NET schedule)",
      async ({ tz, suffix, expectedUtc }) => {
        const shop = shops[suffix];
        const orderId = `gid://shopify/Order/ord-net-${suffix}-${TEST_SUFFIX}`;

        const order: ShopifyOrder = {
          id: orderId,
          name: "#1002",
          createdAt: "2026-11-01T10:00:00.000Z",
          displayFinancialStatus: "PENDING",
          totalPriceSet: {
            shopMoney: { amount: "75000.00", currencyCode: "INR" },
          },
          paymentTerms: {
            id: "pt2",
            paymentTermsName: "Net 30",
            paymentTermsType: "NET",
            dueInDays: 30,
            paymentSchedules: {
              edges: [
                {
                  node: {
                    id: `gid://shopify/PaymentSchedule/sched-net-${suffix}-${TEST_SUFFIX}`,
                    dueAt: "2026-11-26T00:00:00.000Z",
                    completedAt: null,
                  },
                },
              ],
            },
          },
          purchasingEntity: {
            __typename: "PurchasingCompany",
            company: { id: shop.companyId },
            location: { id: shop.locationId },
          },
        };

        const result = await processOrderWebhook(
          sql,
          shop.domain,
          "ORDERS_CREATE",
          order,
          `wh-duenorm-${suffix}-net-${TEST_SUFFIX}`
        );

        expect(result.success).toBe(true);

        const [invoice] = await sql<{ dueAt: Date; localDate: string }[]>`
          SELECT
            "dueAt",
            ("dueAt" AT TIME ZONE ${tz})::DATE::TEXT AS "localDate"
          FROM "Invoice"
          WHERE "orderId" = ${orderId}
        `;

        expect(invoice).toBeDefined();
        expect(invoice.localDate).toBe("2026-11-26");
        expect(invoice.dueAt.toISOString()).toBe(expectedUtc);
      }
    );

    it("passes through non-midnight value unchanged", async () => {
      const shop = shops["ny"];
      const orderId = `gid://shopify/Order/ord-nonmid-${TEST_SUFFIX}`;

      const order: ShopifyOrder = {
        id: orderId,
        name: "#1003",
        createdAt: "2026-11-01T10:00:00.000Z",
        displayFinancialStatus: "PENDING",
        totalPriceSet: {
          shopMoney: { amount: "60000.00", currencyCode: "INR" },
        },
        paymentTerms: {
          id: "pt3",
          paymentTermsName: "Net 30",
          paymentTermsType: "NET",
          dueInDays: 30,
          paymentSchedules: {
            edges: [
              {
                node: {
                  id: `gid://shopify/PaymentSchedule/sched-nonmid-${TEST_SUFFIX}`,
                  dueAt: "2026-11-26T10:15:00.000Z",
                  completedAt: null,
                },
              },
            ],
          },
        },
        purchasingEntity: {
          __typename: "PurchasingCompany",
          company: { id: shop.companyId },
          location: { id: shop.locationId },
        },
      };

      const result = await processOrderWebhook(
        sql,
        shop.domain,
        "ORDERS_CREATE",
        order,
        `wh-duenorm-nonmid-${TEST_SUFFIX}`
      );

      expect(result.success).toBe(true);

      const [invoice] = await sql<{ dueAt: Date }[]>`
        SELECT "dueAt" FROM "Invoice" WHERE "orderId" = ${orderId}
      `;

      expect(invoice).toBeDefined();
      expect(invoice.dueAt.toISOString()).toBe("2026-11-26T10:15:00.000Z");
    });
  });
});
