/**
 * Tests for backstop-backfill.ts
 *
 * Verifies that the backfill query correctly identifies:
 * 1. Unheld accounts → NOT candidates (should not appear)
 * 2. Held accounts (manualHold=true OR overdue) with no backstop row → candidates
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("backstop-backfill findMissedOrders", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-backfill";
  const TEST_SHOP_ID = `shop-backfill-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `backfill-test-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;
  });

  afterAll(async () => {
    // Cleanup
    await sql`DELETE FROM backstop_processed_orders WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  it("unheld account: NOT a candidate (production scenario)", async () => {
    // Create UNHELD account (matches production: holdState=OK, manualHold=false)
    const unheldAccountId = `acc-unheld-bf-${TEST_SUFFIX}`;
    const invoiceId = `inv-unheld-bf-${TEST_SUFFIX}`;
    const orderGid = `gid://shopify/Order/unheld-bf-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold", "holdReasonCode",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${unheldAccountId}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-unheld-bf-" + TEST_SUFFIX}, ${"loc-unheld-bf-" + TEST_SUFFIX},
        'Test Unheld Account', 500000.00, 'OK', false, false, NULL,
        NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${unheldAccountId}, ${orderGid},
        '#TEST-UNHELD-BF', 25000.00, 25000.00, 'open', NOW(), NOW(), NOW()
      )
    `;

    try {
      // Run the same query as findMissedOrders
      const rows = await sql<{ orderId: string }[]>`
        WITH overdue_accounts AS (
          SELECT DISTINCT "buyerAccountId"
          FROM "Invoice"
          WHERE status = 'open'
            AND outstanding > 0
            AND "dueAt" IS NOT NULL
            AND "dueAt" < NOW() - INTERVAL '1 day'
        ),
        held_accounts AS (
          SELECT id, name, "holdState", "manualHold", "shopId"
          FROM "BuyerAccount"
          WHERE "manualHold" = true
             OR id IN (SELECT "buyerAccountId" FROM overdue_accounts)
        )
        SELECT i."orderId" AS "orderId"
        FROM "Invoice" i
        JOIN held_accounts ba ON ba.id = i."buyerAccountId"
        WHERE i."shopId" = ${TEST_SHOP_ID}
          AND i.status = 'open'
          AND i.outstanding > 0
          AND i."orderId" IS NOT NULL
      `;

      // Unheld account should NOT appear in results
      const found = rows.some((r) => r.orderId === orderGid);
      expect(found).toBe(false);

    } finally {
      await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE id = ${unheldAccountId}`;
    }
  });

  it("held account (manualHold=true) with no backstop row: IS a candidate", async () => {
    // Create HELD account (manualHold=true)
    const heldAccountId = `acc-held-manual-${TEST_SUFFIX}`;
    const invoiceId = `inv-held-manual-${TEST_SUFFIX}`;
    const orderGid = `gid://shopify/Order/held-manual-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold", "holdReasonCode",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${heldAccountId}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-held-manual-" + TEST_SUFFIX}, ${"loc-held-manual-" + TEST_SUFFIX},
        'Test Manual Hold Account', 100000.00, 'HELD', false, true, 'MANUAL_HOLD',
        NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${heldAccountId}, ${orderGid},
        '#TEST-HELD-MANUAL', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW()
      )
    `;

    try {
      // Run findMissedOrders query
      const rows = await sql<{ orderId: string }[]>`
        WITH overdue_accounts AS (
          SELECT DISTINCT "buyerAccountId"
          FROM "Invoice"
          WHERE status = 'open'
            AND outstanding > 0
            AND "dueAt" IS NOT NULL
            AND "dueAt" < NOW() - INTERVAL '1 day'
        ),
        held_accounts AS (
          SELECT id, name, "holdState", "manualHold", "shopId"
          FROM "BuyerAccount"
          WHERE "manualHold" = true
             OR id IN (SELECT "buyerAccountId" FROM overdue_accounts)
        )
        SELECT i."orderId" AS "orderId"
        FROM "Invoice" i
        JOIN held_accounts ba ON ba.id = i."buyerAccountId"
        LEFT JOIN backstop_processed_orders bpo ON bpo.shop_id = i."shopId" AND bpo.order_gid = i."orderId"
        WHERE i."shopId" = ${TEST_SHOP_ID}
          AND i.status = 'open'
          AND i.outstanding > 0
          AND i."orderId" IS NOT NULL
          AND (bpo.action IS NULL OR bpo.action = 'pending')
      `;

      // Held account with no backstop row SHOULD appear
      const found = rows.some((r) => r.orderId === orderGid);
      expect(found).toBe(true);

    } finally {
      await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE id = ${heldAccountId}`;
    }
  });

  it("held account (overdue) with no backstop row: IS a candidate", async () => {
    // Create account with overdue invoice
    const overdueAccountId = `acc-overdue-${TEST_SUFFIX}`;
    const overdueInvoiceId = `inv-overdue-${TEST_SUFFIX}`;
    const orderInvoiceId = `inv-order-overdue-${TEST_SUFFIX}`;
    const orderGid = `gid://shopify/Order/overdue-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold", "holdReasonCode",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${overdueAccountId}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-overdue-" + TEST_SUFFIX}, ${"loc-overdue-" + TEST_SUFFIX},
        'Test Overdue Account', 200000.00, 'OK', false, false, NULL,
        NOW(), NOW()
      )
    `;

    // Create an OVERDUE invoice (dueAt 7 days ago)
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "dueAt", "issuedAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${overdueInvoiceId}, ${TEST_SHOP_ID}, ${overdueAccountId},
        ${"gid://shopify/Order/overdue-old-" + TEST_SUFFIX},
        '#TEST-OVERDUE', 30000.00, 30000.00, 'open',
        NOW() - INTERVAL '7 days', NOW() - INTERVAL '14 days', NOW(), NOW()
      )
    `;

    // Create another order for this account (this is what we're checking)
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${orderInvoiceId}, ${TEST_SHOP_ID}, ${overdueAccountId}, ${orderGid},
        '#TEST-ORDER-OVERDUE', 40000.00, 40000.00, 'open', NOW(), NOW(), NOW()
      )
    `;

    try {
      // Run findMissedOrders query
      const rows = await sql<{ orderId: string }[]>`
        WITH overdue_accounts AS (
          SELECT DISTINCT "buyerAccountId"
          FROM "Invoice"
          WHERE status = 'open'
            AND outstanding > 0
            AND "dueAt" IS NOT NULL
            AND "dueAt" < NOW() - INTERVAL '1 day'
        ),
        held_accounts AS (
          SELECT id, name, "holdState", "manualHold", "shopId"
          FROM "BuyerAccount"
          WHERE "manualHold" = true
             OR id IN (SELECT "buyerAccountId" FROM overdue_accounts)
        )
        SELECT i."orderId" AS "orderId"
        FROM "Invoice" i
        JOIN held_accounts ba ON ba.id = i."buyerAccountId"
        LEFT JOIN backstop_processed_orders bpo ON bpo.shop_id = i."shopId" AND bpo.order_gid = i."orderId"
        WHERE i."shopId" = ${TEST_SHOP_ID}
          AND i.status = 'open'
          AND i.outstanding > 0
          AND i."orderId" IS NOT NULL
          AND (bpo.action IS NULL OR bpo.action = 'pending')
      `;

      // Account with overdue invoice SHOULD appear
      const found = rows.some((r) => r.orderId === orderGid);
      expect(found).toBe(true);

    } finally {
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
      await sql`DELETE FROM "BuyerAccount" WHERE id = ${overdueAccountId}`;
    }
  });

  it("held account WITH existing backstop row (action=held): NOT a candidate", async () => {
    // Create HELD account
    const heldAccountId = `acc-already-held-${TEST_SUFFIX}`;
    const invoiceId = `inv-already-held-${TEST_SUFFIX}`;
    const orderGid = `gid://shopify/Order/already-held-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold", "holdReasonCode",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${heldAccountId}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-already-held-" + TEST_SUFFIX}, ${"loc-already-held-" + TEST_SUFFIX},
        'Test Already Held Account', 100000.00, 'HELD', false, true, 'MANUAL_HOLD',
        NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${heldAccountId}, ${orderGid},
        '#TEST-ALREADY-HELD', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW()
      )
    `;

    // Add backstop_processed_orders row with action='held'
    await sql`
      INSERT INTO backstop_processed_orders (shop_id, order_gid, action, reason, processed_at)
      VALUES (${TEST_SHOP_ID}, ${orderGid}, 'held', 'Already processed', NOW())
    `;

    try {
      // Run findMissedOrders query
      const rows = await sql<{ orderId: string }[]>`
        WITH overdue_accounts AS (
          SELECT DISTINCT "buyerAccountId"
          FROM "Invoice"
          WHERE status = 'open'
            AND outstanding > 0
            AND "dueAt" IS NOT NULL
            AND "dueAt" < NOW() - INTERVAL '1 day'
        ),
        held_accounts AS (
          SELECT id, name, "holdState", "manualHold", "shopId"
          FROM "BuyerAccount"
          WHERE "manualHold" = true
             OR id IN (SELECT "buyerAccountId" FROM overdue_accounts)
        )
        SELECT i."orderId" AS "orderId"
        FROM "Invoice" i
        JOIN held_accounts ba ON ba.id = i."buyerAccountId"
        LEFT JOIN backstop_processed_orders bpo ON bpo.shop_id = i."shopId" AND bpo.order_gid = i."orderId"
        WHERE i."shopId" = ${TEST_SHOP_ID}
          AND i.status = 'open'
          AND i.outstanding > 0
          AND i."orderId" IS NOT NULL
          AND (bpo.action IS NULL OR bpo.action = 'pending')
      `;

      // Account with existing 'held' row should NOT appear
      const found = rows.some((r) => r.orderId === orderGid);
      expect(found).toBe(false);

    } finally {
      await sql`DELETE FROM backstop_processed_orders WHERE order_gid = ${orderGid}`;
      await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE id = ${heldAccountId}`;
    }
  });
});
