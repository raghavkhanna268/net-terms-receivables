/**
 * DB-backed tests for orphan payment schedule due date refresh.
 *
 * Tests verify:
 * 1. One orphan schedule matches an existing open invoice with different dueAt
 * 2. No match (the schedule's parent order has no invoice)
 * 3. Several rows (at least 3 invoices, one with same dueAt already)
 * 4. A matching invoice whose dueAt is already equal
 *
 * Uses native PostgreSQL with all migrations applied.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { assertNoQueueLeftovers } from "../../../../tests/helpers/queue-leftovers";

vi.mock("../../drain/admin-client.server", () => ({
  adminGraphQL: vi.fn(),
  BULK_OPERATION_STATUS_QUERY: "mock-query",
}));

vi.mock("~/lib/request-context.server", () => ({
  getRequestEnv: vi.fn(() => ({ CUSTOMER_PII_FIELDS: "1" })),
  getRequestSql: vi.fn(() => ({})),
  getRequestWaitUntil: vi.fn(() => () => {}),
  requestContext: { getStore: vi.fn() },
}));

vi.mock("~/shopify.server", () => ({
  sessionStorage: {},
  shopify: {},
}));

vi.mock("~/services/sync/company.server", () => ({
  isWebhookProcessed: vi.fn().mockResolvedValue(false),
  markWebhookProcessed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("~/services/sync/company-location.server", () => ({
  mapCompanyLocationToBuyerAccount: vi.fn(() => ({})),
  bulkUpsertBuyerAccounts: vi.fn().mockResolvedValue(0),
}));

vi.mock("~/services/sync/order.server", () => ({
  mapOrderToInvoiceWithEligibility: vi.fn(() => ({ invoiceData: {}, outstandingMissing: false })),
  bulkUpsertInvoices: vi.fn().mockResolvedValue(0),
}));

vi.mock("~/lib/invoice-eligibility", () => ({
  checkOrderEligibility: vi.fn().mockResolvedValue({ eligible: true, buyerAccountId: "buyer-mock" }),
  getEligibilityContext: vi.fn().mockResolvedValue({ shop: { id: "shop-123" } }),
  isTerminalFinancialStatus: vi.fn().mockReturnValue(false),
}));

vi.mock("~/services/sync/customer.server", () => ({
  processBulkCustomer: vi.fn().mockResolvedValue({ success: true, action: "skipped" }),
  getTagRules: vi.fn().mockResolvedValue([]),
}));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("orphan payment schedule due date refresh (DB-backed)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-orphan";
  const TEST_SHOP_ID = `test-shop-orphan-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-orphan-${TEST_SUFFIX}.example.com`;
  const TEST_ACCOUNT_ID = `test-account-orphan-${TEST_SUFFIX}`;
  const TEST_COMPANY_ID = `gid://shopify/Company/co-orphan-${TEST_SUFFIX}`;
  const TEST_LOCATION_ID = `gid://shopify/CompanyLocation/loc-orphan-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "createdAt", "updatedAt"
      ) VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY', ${TEST_COMPANY_ID}, ${TEST_LOCATION_ID}, 'Test Orphan Company',
        NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_reconcile_stage_claims WHERE shop = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_bulk_operations WHERE shop = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;

    await assertNoQueueLeftovers(sql, [TEST_SHOP_DOMAIN], "bulk-jsonl-orphan-due-refresh-db.test.ts");

    await sql.end();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_reconcile_stage_claims WHERE shop = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_bulk_operations WHERE shop = ${TEST_SHOP_DOMAIN}`;
  });

  describe("orphan schedule due date refresh", () => {
    it("refreshes due date for a matching existing invoice", async () => {
      const { processOrderLines } = await import("../bulk-jsonl-processor.server");

      const orderId = `gid://shopify/Order/orphan-match-${TEST_SUFFIX}`;
      const invoiceId = `inv-orphan-match-${TEST_SUFFIX}`;
      const originalDueAt = new Date("2026-11-01T10:00:00.000Z");
      const newDueAt = "2026-11-15T10:00:00.000Z";

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          "issuedAt", "dueAt", "dueSource", "dueBasis", "dueReason", status
        ) VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId}, '#TEST1',
          1000.00, 1000.00, NOW(), ${originalDueAt}, 'inferred', 'shopDefault', 'Default 30 days', 'open'
        )
      `;

      const orphanScheduleLine = JSON.stringify({
        id: `gid://shopify/PaymentSchedule/ps-orphan-${TEST_SUFFIX}`,
        __parentId: orderId,
        dueAt: newDueAt,
        issuedAt: "2026-10-15T00:00:00Z",
      });

      const result = await processOrderLines(sql, TEST_SHOP_ID, TEST_SHOP_DOMAIN, [orphanScheduleLine]);

      expect(result).toBe(1);

      const [invoice] = await sql<
        { dueAt: Date | null; dueSource: string; dueBasis: string | null; dueReason: string | null }[]
      >`
        SELECT "dueAt", "dueSource", "dueBasis", "dueReason" FROM "Invoice" WHERE id = ${invoiceId}
      `;

      expect(invoice.dueAt?.toISOString()).toBe(new Date(newDueAt).toISOString());
      expect(invoice.dueSource).toBe("schedule");
      expect(invoice.dueBasis).toBeNull();
      expect(invoice.dueReason).toBe("Payment schedule from Shopify (orphan reconcile)");
    });

    it("returns zero when schedule parent order has no invoice", async () => {
      const { processOrderLines } = await import("../bulk-jsonl-processor.server");

      const nonExistentOrderId = `gid://shopify/Order/no-invoice-${TEST_SUFFIX}`;
      const newDueAt = "2026-11-15T10:00:00.000Z";

      const orphanScheduleLine = JSON.stringify({
        id: `gid://shopify/PaymentSchedule/ps-no-match-${TEST_SUFFIX}`,
        __parentId: nonExistentOrderId,
        dueAt: newDueAt,
        issuedAt: "2026-10-15T00:00:00Z",
      });

      const result = await processOrderLines(sql, TEST_SHOP_ID, TEST_SHOP_DOMAIN, [orphanScheduleLine]);

      expect(result).toBe(0);

      const invoices = await sql`
        SELECT id FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}
      `;
      expect(invoices.length).toBe(0);
    });

    it("updates only invoices with differing due dates across multiple rows", async () => {
      const { processOrderLines } = await import("../bulk-jsonl-processor.server");

      const order1Id = `gid://shopify/Order/multi-1-${TEST_SUFFIX}`;
      const order2Id = `gid://shopify/Order/multi-2-${TEST_SUFFIX}`;
      const order3Id = `gid://shopify/Order/multi-3-${TEST_SUFFIX}`;
      const invoice1Id = `inv-multi-1-${TEST_SUFFIX}`;
      const invoice2Id = `inv-multi-2-${TEST_SUFFIX}`;
      const invoice3Id = `inv-multi-3-${TEST_SUFFIX}`;

      const sameDueAt = new Date("2026-11-20T10:00:00.000Z");
      const differentDueAt1 = new Date("2026-11-01T10:00:00.000Z");
      const differentDueAt2 = new Date("2026-11-05T10:00:00.000Z");
      const newDueAt = "2026-11-20T10:00:00.000Z";

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          "issuedAt", "dueAt", "dueSource", status
        ) VALUES
        (${invoice1Id}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${order1Id}, '#MULTI1', 1000.00, 1000.00, NOW(), ${differentDueAt1}, 'inferred', 'open'),
        (${invoice2Id}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${order2Id}, '#MULTI2', 2000.00, 2000.00, NOW(), ${sameDueAt}, 'schedule', 'open'),
        (${invoice3Id}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${order3Id}, '#MULTI3', 3000.00, 3000.00, NOW(), ${differentDueAt2}, 'inferred', 'open')
      `;

      const orphanScheduleLines = [
        JSON.stringify({
          id: `gid://shopify/PaymentSchedule/ps-multi-1-${TEST_SUFFIX}`,
          __parentId: order1Id,
          dueAt: newDueAt,
          issuedAt: "2026-10-15T00:00:00Z",
        }),
        JSON.stringify({
          id: `gid://shopify/PaymentSchedule/ps-multi-2-${TEST_SUFFIX}`,
          __parentId: order2Id,
          dueAt: newDueAt,
          issuedAt: "2026-10-15T00:00:00Z",
        }),
        JSON.stringify({
          id: `gid://shopify/PaymentSchedule/ps-multi-3-${TEST_SUFFIX}`,
          __parentId: order3Id,
          dueAt: newDueAt,
          issuedAt: "2026-10-15T00:00:00Z",
        }),
      ];

      const result = await processOrderLines(sql, TEST_SHOP_ID, TEST_SHOP_DOMAIN, orphanScheduleLines);

      expect(result).toBe(2);

      const invoices = await sql<{ id: string; dueAt: Date | null; dueSource: string }[]>`
        SELECT id, "dueAt", "dueSource" FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID} ORDER BY name
      `;

      const inv1 = invoices.find((i) => i.id === invoice1Id);
      const inv2 = invoices.find((i) => i.id === invoice2Id);
      const inv3 = invoices.find((i) => i.id === invoice3Id);

      expect(inv1?.dueAt?.toISOString()).toBe(new Date(newDueAt).toISOString());
      expect(inv1?.dueSource).toBe("schedule");

      expect(inv2?.dueAt?.toISOString()).toBe(sameDueAt.toISOString());
      expect(inv2?.dueSource).toBe("schedule");

      expect(inv3?.dueAt?.toISOString()).toBe(new Date(newDueAt).toISOString());
      expect(inv3?.dueSource).toBe("schedule");
    });

    it("returns zero when invoice due date already matches schedule", async () => {
      const { processOrderLines } = await import("../bulk-jsonl-processor.server");

      const orderId = `gid://shopify/Order/same-due-${TEST_SUFFIX}`;
      const invoiceId = `inv-same-due-${TEST_SUFFIX}`;
      const matchingDueAt = new Date("2026-11-15T10:00:00.000Z");
      const scheduleDueAt = "2026-11-15T10:00:00.000Z";

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          "issuedAt", "dueAt", "dueSource", "dueBasis", "dueReason", status
        ) VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId}, '#SAME1',
          1000.00, 1000.00, NOW(), ${matchingDueAt}, 'schedule', NULL, 'Payment schedule from Shopify', 'open'
        )
      `;

      const orphanScheduleLine = JSON.stringify({
        id: `gid://shopify/PaymentSchedule/ps-same-${TEST_SUFFIX}`,
        __parentId: orderId,
        dueAt: scheduleDueAt,
        issuedAt: "2026-10-15T00:00:00Z",
      });

      const result = await processOrderLines(sql, TEST_SHOP_ID, TEST_SHOP_DOMAIN, [orphanScheduleLine]);

      expect(result).toBe(0);

      const [invoice] = await sql<{ dueAt: Date | null; dueSource: string; dueReason: string | null }[]>`
        SELECT "dueAt", "dueSource", "dueReason" FROM "Invoice" WHERE id = ${invoiceId}
      `;

      expect(invoice.dueAt?.toISOString()).toBe(matchingDueAt.toISOString());
      expect(invoice.dueSource).toBe("schedule");
      expect(invoice.dueReason).toBe("Payment schedule from Shopify");
    });
  });

  describe("midnight UTC normalization to shop-local end-of-day", () => {
    it("normalizes midnight UTC dueAt to America/New_York end-of-day", async () => {
      const { processOrderLines } = await import("../bulk-jsonl-processor.server");

      const tzSuffix = `${TEST_SUFFIX}-ny`;
      const shopId = `test-shop-ny-${tzSuffix}`;
      const shopDomain = `test-ny-${tzSuffix}.example.com`;
      const accountId = `test-account-ny-${tzSuffix}`;
      const companyId = `gid://shopify/Company/co-ny-${tzSuffix}`;
      const locationId = `gid://shopify/CompanyLocation/loc-ny-${tzSuffix}`;
      const orderId = `gid://shopify/Order/ny-mid-${tzSuffix}`;
      const invoiceId = `inv-ny-mid-${tzSuffix}`;

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt")
        VALUES (${shopId}, ${shopDomain}, 'INR', 'America/New_York', NOW(), NOW())
      `;
      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "createdAt", "updatedAt"
        ) VALUES (
          ${accountId}, ${shopId}, 'COMPANY', ${companyId}, ${locationId}, 'Test NY Company',
          NOW(), NOW()
        )
      `;
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          "issuedAt", "dueAt", "dueSource", status
        ) VALUES (
          ${invoiceId}, ${shopId}, ${accountId}, ${orderId}, '#NYMID1',
          1000.00, 1000.00, NOW(), ${new Date("2026-11-01T00:00:00Z")}, 'inferred', 'open'
        )
      `;

      const orphanScheduleLine = JSON.stringify({
        id: `gid://shopify/PaymentSchedule/ps-ny-mid-${tzSuffix}`,
        __parentId: orderId,
        dueAt: "2026-11-26T00:00:00.000Z",
        issuedAt: "2026-10-15T00:00:00Z",
      });

      const result = await processOrderLines(sql, shopId, shopDomain, [orphanScheduleLine]);
      expect(result).toBe(1);

      const [invoice] = await sql<{ dueAt: Date | null }[]>`
        SELECT "dueAt" FROM "Invoice" WHERE id = ${invoiceId}
      `;

      expect(invoice.dueAt?.toISOString()).toBe("2026-11-27T04:59:59.999Z");

      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${shopId}`;
    });

    it("normalizes midnight UTC dueAt to Asia/Kolkata end-of-day", async () => {
      const { processOrderLines } = await import("../bulk-jsonl-processor.server");

      const tzSuffix = `${TEST_SUFFIX}-kol`;
      const shopId = `test-shop-kol-${tzSuffix}`;
      const shopDomain = `test-kol-${tzSuffix}.example.com`;
      const accountId = `test-account-kol-${tzSuffix}`;
      const companyId = `gid://shopify/Company/co-kol-${tzSuffix}`;
      const locationId = `gid://shopify/CompanyLocation/loc-kol-${tzSuffix}`;
      const orderId = `gid://shopify/Order/kol-mid-${tzSuffix}`;
      const invoiceId = `inv-kol-mid-${tzSuffix}`;

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt")
        VALUES (${shopId}, ${shopDomain}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      `;
      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "createdAt", "updatedAt"
        ) VALUES (
          ${accountId}, ${shopId}, 'COMPANY', ${companyId}, ${locationId}, 'Test Kolkata Company',
          NOW(), NOW()
        )
      `;
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          "issuedAt", "dueAt", "dueSource", status
        ) VALUES (
          ${invoiceId}, ${shopId}, ${accountId}, ${orderId}, '#KOLMID1',
          1000.00, 1000.00, NOW(), ${new Date("2026-11-01T00:00:00Z")}, 'inferred', 'open'
        )
      `;

      const orphanScheduleLine = JSON.stringify({
        id: `gid://shopify/PaymentSchedule/ps-kol-mid-${tzSuffix}`,
        __parentId: orderId,
        dueAt: "2026-11-26T00:00:00.000Z",
        issuedAt: "2026-10-15T00:00:00Z",
      });

      const result = await processOrderLines(sql, shopId, shopDomain, [orphanScheduleLine]);
      expect(result).toBe(1);

      const [invoice] = await sql<{ dueAt: Date | null }[]>`
        SELECT "dueAt" FROM "Invoice" WHERE id = ${invoiceId}
      `;

      expect(invoice.dueAt?.toISOString()).toBe("2026-11-26T18:29:59.999Z");

      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${shopId}`;
    });

    it("normalizes midnight UTC dueAt to Pacific/Auckland end-of-day", async () => {
      const { processOrderLines } = await import("../bulk-jsonl-processor.server");

      const tzSuffix = `${TEST_SUFFIX}-akl`;
      const shopId = `test-shop-akl-${tzSuffix}`;
      const shopDomain = `test-akl-${tzSuffix}.example.com`;
      const accountId = `test-account-akl-${tzSuffix}`;
      const companyId = `gid://shopify/Company/co-akl-${tzSuffix}`;
      const locationId = `gid://shopify/CompanyLocation/loc-akl-${tzSuffix}`;
      const orderId = `gid://shopify/Order/akl-mid-${tzSuffix}`;
      const invoiceId = `inv-akl-mid-${tzSuffix}`;

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt")
        VALUES (${shopId}, ${shopDomain}, 'INR', 'Pacific/Auckland', NOW(), NOW())
      `;
      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "createdAt", "updatedAt"
        ) VALUES (
          ${accountId}, ${shopId}, 'COMPANY', ${companyId}, ${locationId}, 'Test Auckland Company',
          NOW(), NOW()
        )
      `;
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          "issuedAt", "dueAt", "dueSource", status
        ) VALUES (
          ${invoiceId}, ${shopId}, ${accountId}, ${orderId}, '#AKLMID1',
          1000.00, 1000.00, NOW(), ${new Date("2026-11-01T00:00:00Z")}, 'inferred', 'open'
        )
      `;

      const orphanScheduleLine = JSON.stringify({
        id: `gid://shopify/PaymentSchedule/ps-akl-mid-${tzSuffix}`,
        __parentId: orderId,
        dueAt: "2026-11-26T00:00:00.000Z",
        issuedAt: "2026-10-15T00:00:00Z",
      });

      const result = await processOrderLines(sql, shopId, shopDomain, [orphanScheduleLine]);
      expect(result).toBe(1);

      const [invoice] = await sql<{ dueAt: Date | null }[]>`
        SELECT "dueAt" FROM "Invoice" WHERE id = ${invoiceId}
      `;

      expect(invoice.dueAt?.toISOString()).toBe("2026-11-26T10:59:59.999Z");

      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${shopId}`;
    });

    it("passes through non-midnight UTC dueAt unchanged", async () => {
      const { processOrderLines } = await import("../bulk-jsonl-processor.server");

      const tzSuffix = `${TEST_SUFFIX}-nonmid`;
      const shopId = `test-shop-nonmid-${tzSuffix}`;
      const shopDomain = `test-nonmid-${tzSuffix}.example.com`;
      const accountId = `test-account-nonmid-${tzSuffix}`;
      const companyId = `gid://shopify/Company/co-nonmid-${tzSuffix}`;
      const locationId = `gid://shopify/CompanyLocation/loc-nonmid-${tzSuffix}`;
      const orderId = `gid://shopify/Order/nonmid-${tzSuffix}`;
      const invoiceId = `inv-nonmid-${tzSuffix}`;

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt")
        VALUES (${shopId}, ${shopDomain}, 'INR', 'America/New_York', NOW(), NOW())
      `;
      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "createdAt", "updatedAt"
        ) VALUES (
          ${accountId}, ${shopId}, 'COMPANY', ${companyId}, ${locationId}, 'Test NonMidnight Company',
          NOW(), NOW()
        )
      `;
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          "issuedAt", "dueAt", "dueSource", status
        ) VALUES (
          ${invoiceId}, ${shopId}, ${accountId}, ${orderId}, '#NONMID1',
          1000.00, 1000.00, NOW(), ${new Date("2026-11-01T00:00:00Z")}, 'inferred', 'open'
        )
      `;

      const nonMidnightDueAt = "2026-11-26T10:15:00.000Z";
      const orphanScheduleLine = JSON.stringify({
        id: `gid://shopify/PaymentSchedule/ps-nonmid-${tzSuffix}`,
        __parentId: orderId,
        dueAt: nonMidnightDueAt,
        issuedAt: "2026-10-15T00:00:00Z",
      });

      const result = await processOrderLines(sql, shopId, shopDomain, [orphanScheduleLine]);
      expect(result).toBe(1);

      const [invoice] = await sql<{ dueAt: Date | null }[]>`
        SELECT "dueAt" FROM "Invoice" WHERE id = ${invoiceId}
      `;

      expect(invoice.dueAt?.toISOString()).toBe(nonMidnightDueAt);

      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${shopId}`;
    });
  });
});
