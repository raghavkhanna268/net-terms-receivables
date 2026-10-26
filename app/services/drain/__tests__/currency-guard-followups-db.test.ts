/**
 * #292 G6: Currency guard follow-up DB tests (QA 2 fail-closed audit).
 *
 * DB-backed tests for:
 * - G8: Terminal topics (PAID, CANCELLED) update existing invoices for non-INR shops
 * - G5: markWebhookProcessed called when skipping non-INR orders
 * - G4: Failed currency read on re-auth sets XXX (no preserve-on-conflict)
 *
 * These tests use the real Postgres database and must run sequentially.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { assertNoQueueLeftovers } from "../../../../tests/helpers/queue-leftovers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("#292 G8 DB: Terminal topics update existing invoices for non-INR shops", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = `g8db-${Date.now().toString(36)}`;
  const TEST_SHOP_ID = `shop-g8db-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-g8db-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `account-g8db-${TEST_SUFFIX}`;
  const TEST_COMPANY_ID = `gid://shopify/Company/co-g8db-${TEST_SUFFIX}`;
  const TEST_LOCATION_ID = `gid://shopify/CompanyLocation/loc-g8db-${TEST_SUFFIX}`;

  beforeEach(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop with non-INR currency (USD)
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'USD', NOW(), NOW())
    `;

    // Create test buyer account
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "createdAt", "updatedAt"
      ) VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY', ${TEST_COMPANY_ID}, ${TEST_LOCATION_ID},
        'Test Company G8', NOW(), NOW()
      )
    `;
  });

  afterEach(async () => {
    // Clean up queue messages enqueued by this test (e.g., CREDIT_STATUS_RECOMPUTE)
    // before deleting the shop/account they reference
    await sql`
      SELECT pgmq.archive('s6_sync', ARRAY(
        SELECT msg_id FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
      ))
    `;
    await sql`
      DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
    `;

    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${"wh-g8db-" + TEST_SUFFIX + "%"}`;

    await assertNoQueueLeftovers(sql, [TEST_SHOP_DOMAIN], "currency-guard-followups-db.test.ts (G8)");

    await sql.end();
  });

  it("ORDERS_PAID marks existing invoice as paid for non-INR shop", async () => {
    const orderId = `gid://shopify/Order/g8db-paid-${TEST_SUFFIX}`;

    // Create existing open invoice
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status,
        "issuedAt", "createdAt", "updatedAt"
      ) VALUES (
        gen_random_uuid()::text, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#G8-PAID', '50000.00', '50000.00', 'open',
        NOW(), NOW(), NOW()
      )
    `;

    // Import the real processOrderWebhook (not mocked)
    const { processOrderWebhook } = await vi.importActual<typeof import("../../sync/order.server")>(
      "../../sync/order.server"
    );

    const order = {
      id: orderId,
      name: "#G8-PAID",
      createdAt: new Date().toISOString(),
      displayFinancialStatus: "PAID",
      paymentTerms: { id: "pt-1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
    };

    const result = await processOrderWebhook(
      sql,
      TEST_SHOP_DOMAIN,
      "ORDERS_PAID",
      order as never,
      `wh-g8db-paid-${TEST_SUFFIX}`
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("updated");

    // Verify invoice is now paid
    const [invoice] = await sql<{ status: string; outstanding: string }[]>`
      SELECT status, outstanding::text FROM "Invoice"
      WHERE "shopId" = ${TEST_SHOP_ID} AND "orderId" = ${orderId}
    `;
    expect(invoice.status).toBe("paid");
    expect(invoice.outstanding).toBe("0.00");
  });

  it("ORDERS_CANCELLED marks existing invoice as cancelled for non-INR shop", async () => {
    const orderId = `gid://shopify/Order/g8db-cancelled-${TEST_SUFFIX}`;

    // Create existing open invoice
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status,
        "issuedAt", "createdAt", "updatedAt"
      ) VALUES (
        gen_random_uuid()::text, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#G8-CANCELLED', '30000.00', '30000.00', 'open',
        NOW(), NOW(), NOW()
      )
    `;

    const { processOrderWebhook } = await vi.importActual<typeof import("../../sync/order.server")>(
      "../../sync/order.server"
    );

    const order = {
      id: orderId,
      name: "#G8-CANCELLED",
      createdAt: new Date().toISOString(),
      cancelledAt: new Date().toISOString(),
      paymentTerms: { id: "pt-1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
    };

    const result = await processOrderWebhook(
      sql,
      TEST_SHOP_DOMAIN,
      "ORDERS_CANCELLED",
      order as never,
      `wh-g8db-cancelled-${TEST_SUFFIX}`
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("updated");

    // Verify invoice is now cancelled
    const [invoice] = await sql<{ status: string }[]>`
      SELECT status FROM "Invoice"
      WHERE "shopId" = ${TEST_SHOP_ID} AND "orderId" = ${orderId}
    `;
    expect(invoice.status).toBe("cancelled");
  });

  it("ORDERS_CREATE writes nothing for non-INR order on INR shop", async () => {
    // Change shop to INR so the shop-level check passes, but order currency is USD
    await sql`UPDATE "Shop" SET currency = 'INR' WHERE id = ${TEST_SHOP_ID}`;

    const orderId = `gid://shopify/Order/g8db-create-${TEST_SUFFIX}`;

    const { processOrderWebhook } = await vi.importActual<typeof import("../../sync/order.server")>(
      "../../sync/order.server"
    );

    const order = {
      id: orderId,
      name: "#G8-CREATE",
      createdAt: new Date().toISOString(),
      displayFinancialStatus: "PENDING",
      totalPriceSet: {
        shopMoney: { amount: "1000.00", currencyCode: "USD" }, // Non-INR order
      },
      paymentTerms: { id: "pt-1", paymentTermsName: "Net 30", paymentTermsType: "NET", dueInDays: 30 },
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
      order as never,
      `wh-g8db-create-${TEST_SUFFIX}`
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.skipReason).toBe("order_currency_not_supported");

    // Verify no invoice was created
    const [invoice] = await sql<{ id: string }[]>`
      SELECT id FROM "Invoice"
      WHERE "shopId" = ${TEST_SHOP_ID} AND "orderId" = ${orderId}
    `;
    expect(invoice).toBeUndefined();
  });
});

describeWithDb("#292 G5 DB: markWebhookProcessed called on non-INR skip", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = `g5db-${Date.now().toString(36)}`;
  const TEST_SHOP_ID = `shop-g5db-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-g5db-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `account-g5db-${TEST_SUFFIX}`;
  const TEST_COMPANY_ID = `gid://shopify/Company/co-g5db-${TEST_SUFFIX}`;
  const TEST_LOCATION_ID = `gid://shopify/CompanyLocation/loc-g5db-${TEST_SUFFIX}`;

  beforeEach(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop with INR currency
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    // Create test buyer account
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "createdAt", "updatedAt"
      ) VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY', ${TEST_COMPANY_ID}, ${TEST_LOCATION_ID},
        'Test Company G5', NOW(), NOW()
      )
    `;
  });

  afterEach(async () => {
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${"wh-g5db-" + TEST_SUFFIX + "%"}`;
    await assertNoQueueLeftovers(sql, [TEST_SHOP_DOMAIN], "currency-guard-followups-db.test.ts (G5)");
    await sql.end();
  });

  it("skipped non-INR order is marked as processed (no retry)", async () => {
    const webhookId = `wh-g5db-skip-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/g5db-skip-${TEST_SUFFIX}`;

    const { processOrderWebhook } = await vi.importActual<typeof import("../../sync/order.server")>(
      "../../sync/order.server"
    );

    const order = {
      id: orderId,
      name: "#G5-SKIP",
      createdAt: new Date().toISOString(),
      displayFinancialStatus: "PENDING",
      totalPriceSet: {
        shopMoney: { amount: "1000.00", currencyCode: "USD" }, // Non-INR
      },
      paymentTerms: { id: "pt-1", paymentTermsName: "Net 30", paymentTermsType: "NET", dueInDays: 30 },
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
      order as never,
      webhookId
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.skipReason).toBe("order_currency_not_supported");

    // Verify webhook was marked as processed (uses migrated schema table)
    const [processed] = await sql<{ webhook_id: string }[]>`
      SELECT webhook_id FROM s6_processed_webhooks
      WHERE webhook_id = ${webhookId}
    `;
    expect(processed).toBeDefined();
    expect(processed.webhook_id).toBe(webhookId);
  });
});

describeWithDb("#292 G4 DB: Failed currency read sets XXX (no preserve-on-conflict)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = `g4db-${Date.now().toString(36)}`;
  const TEST_SHOP_DOMAIN = `test-g4db-${TEST_SUFFIX}.myshopify.com`;

  beforeEach(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterEach(async () => {
    await sql`DELETE FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}`;
    await assertNoQueueLeftovers(sql, [TEST_SHOP_DOMAIN], "currency-guard-followups-db.test.ts (G4)");
    await sql.end();
  });

  it("XXX currency overwrites existing INR (no preserve-on-conflict)", async () => {
    const { upsertShopOnAuth } = await vi.importActual<typeof import("../../../lib/after-auth.server")>(
      "../../../lib/after-auth.server"
    );

    // First create shop with INR
    await upsertShopOnAuth(sql, TEST_SHOP_DOMAIN, "Asia/Kolkata", "INR");

    // Verify shop has INR
    const [shopBefore] = await sql<{ currency: string }[]>`
      SELECT currency FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
    `;
    expect(shopBefore.currency).toBe("INR");

    // Re-auth with failed currency read (XXX)
    await upsertShopOnAuth(sql, TEST_SHOP_DOMAIN, "Asia/Kolkata", "XXX");

    // G4: XXX should NOT preserve INR - should set XXX (fail-closed)
    const [shopAfter] = await sql<{ currency: string }[]>`
      SELECT currency FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
    `;
    expect(shopAfter.currency).toBe("XXX");
  });

  it("valid currency still updates normally", async () => {
    const { upsertShopOnAuth } = await vi.importActual<typeof import("../../../lib/after-auth.server")>(
      "../../../lib/after-auth.server"
    );

    // Create shop with INR
    await upsertShopOnAuth(sql, TEST_SHOP_DOMAIN, "Asia/Kolkata", "INR");

    // Re-auth with different valid currency (simulating actual currency change)
    await upsertShopOnAuth(sql, TEST_SHOP_DOMAIN, "Asia/Kolkata", "USD");

    const [shop] = await sql<{ currency: string }[]>`
      SELECT currency FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
    `;
    expect(shop.currency).toBe("USD");
  });

  it("first auth with XXX (unknown on first read) stays XXX", async () => {
    const { upsertShopOnAuth } = await vi.importActual<typeof import("../../../lib/after-auth.server")>(
      "../../../lib/after-auth.server"
    );

    // First auth with failed currency read (XXX)
    await upsertShopOnAuth(sql, TEST_SHOP_DOMAIN, "Asia/Kolkata", "XXX");

    const [shop] = await sql<{ currency: string }[]>`
      SELECT currency FROM "Shop" WHERE domain = ${TEST_SHOP_DOMAIN}
    `;
    expect(shop.currency).toBe("XXX");
  });
});
