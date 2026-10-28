/**
 * DB test with a synthetic large shop running deleteShop.
 * Logs duration as a number only (no ids).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { deleteShop } from "~/services/compliance";
import { assertNoQueueLeftovers } from "tests/helpers/queue-leftovers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

let measuredDurationMs: number | null = null;

export function getLargeShopDeleteDurationMs(): number | null {
  return measuredDurationMs;
}

describeWithDb("large shop deleteShop duration", () => {
  const largeShopDomain = "test-large-shop-delete.myshopify.com";
  const largeShopId = "test-large-shop-delete-id";
  let sql: ReturnType<typeof postgres>;

  const ORDER_COUNT = 100;
  const INVOICE_COUNT = 100;
  const BUYER_ACCOUNT_COUNT = 20;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) return;
    sql = postgres(TEST_DATABASE_URL, { max: 1 });

    await sql`DELETE FROM "Match" WHERE "shopId" IN (SELECT id FROM "Shop" WHERE domain = ${largeShopDomain})`;
    await sql`DELETE FROM "Payment" WHERE "shopId" IN (SELECT id FROM "Shop" WHERE domain = ${largeShopDomain})`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" IN (SELECT id FROM "Shop" WHERE domain = ${largeShopDomain})`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (SELECT id FROM "Shop" WHERE domain = ${largeShopDomain})`;
    await sql`DELETE FROM webhook_receipts WHERE shop = ${largeShopDomain}`;
    await sql`DELETE FROM "Session" WHERE shop = ${largeShopDomain}`;
    await sql`DELETE FROM "Shop" WHERE id = ${largeShopId}`;

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "uninstalledAt", "createdAt", "updatedAt")
      VALUES (
        ${largeShopId},
        ${largeShopDomain},
        'INR',
        NOW() - INTERVAL '3 days',
        NOW(),
        NOW()
      )
    `;

    for (let i = 0; i < BUYER_ACCOUNT_COUNT; i++) {
      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", name, kind, "customerId", "holdState", "createdAt", "updatedAt"
        ) VALUES (
          ${`ba-large-${i}`},
          ${largeShopId},
          ${`Test Buyer ${i}`},
          'TAGGED_CUSTOMER',
          ${`gid://shopify/Customer/${10000 + i}`},
          'OK',
          NOW(),
          NOW()
        )
      `;
    }

    for (let i = 0; i < INVOICE_COUNT; i++) {
      const buyerAccountIndex = i % BUYER_ACCOUNT_COUNT;
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", name, "orderGid", total, outstanding, status, "issuedAt", "createdAt", "updatedAt"
        ) VALUES (
          ${`inv-large-${i}`},
          ${largeShopId},
          ${`ba-large-${buyerAccountIndex}`},
          ${`#${1000 + i}`},
          ${`gid://shopify/Order/${20000 + i}`},
          1000.00,
          500.00,
          'open',
          NOW() - INTERVAL '30 days',
          NOW(),
          NOW()
        )
      `;
    }

    for (let i = 0; i < 10; i++) {
      await sql`
        INSERT INTO webhook_receipts (shop, webhook_id, topic, received_at)
        VALUES (${largeShopDomain}, ${`wh-receipt-${i}`}, 'SOME_TOPIC', NOW())
      `;
    }
  });

  afterAll(async () => {
    if (!sql) return;

    await sql`DELETE FROM "Match" WHERE "shopId" = ${largeShopId}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${largeShopId}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${largeShopId}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${largeShopId}`;
    await sql`DELETE FROM webhook_receipts WHERE shop = ${largeShopDomain}`;
    await sql`DELETE FROM "Session" WHERE shop = ${largeShopDomain}`;
    await sql`DELETE FROM "Shop" WHERE id = ${largeShopId}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${largeShopDomain}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${largeShopDomain}`;

    await assertNoQueueLeftovers(sql, [largeShopDomain], "large-shop-delete-db.test.ts");

    await sql.end();
  });

  it("deletes large shop with many invoices and buyer accounts, logging duration", async () => {
    const [beforeInvoices] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM "Invoice" WHERE "shopId" = ${largeShopId}
    `;
    expect(parseInt(beforeInvoices.count, 10)).toBe(INVOICE_COUNT);

    const [beforeBuyerAccounts] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM "BuyerAccount" WHERE "shopId" = ${largeShopId}
    `;
    expect(parseInt(beforeBuyerAccounts.count, 10)).toBe(BUYER_ACCOUNT_COUNT);

    const startTime = Date.now();
    const result = await deleteShop(sql, largeShopDomain);
    const endTime = Date.now();
    measuredDurationMs = endTime - startTime;

    console.log(`Large shop deleteShop duration: ${measuredDurationMs}`);

    expect(result.deleted).toBe(true);

    const [afterShop] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM "Shop" WHERE id = ${largeShopId}
    `;
    expect(parseInt(afterShop.count, 10)).toBe(0);

    const [afterInvoices] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM "Invoice" WHERE "shopId" = ${largeShopId}
    `;
    expect(parseInt(afterInvoices.count, 10)).toBe(0);

    const [afterBuyerAccounts] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM "BuyerAccount" WHERE "shopId" = ${largeShopId}
    `;
    expect(parseInt(afterBuyerAccounts.count, 10)).toBe(0);

    const [afterReceipts] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM webhook_receipts WHERE shop = ${largeShopDomain}
    `;
    expect(parseInt(afterReceipts.count, 10)).toBe(0);
  });
});
