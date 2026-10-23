/**
 * Integration tests for payment matching with database.
 *
 * Uses synthetic fixtures and the CI pgmq Postgres service.
 * Each test is isolated per shop to avoid interference.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import {
  getUnmatchedPayments,
  getOpenInvoicesForBuyer,
  getBuyersWithAliases,
  createMatch,
  updateMatchState,
  deleteSuggestedMatchesForPayment,
  updatePaymentStatus,
  upsertPayerAlias,
  findBuyerByAlias,
} from "../queries.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("Payment matching integration (DB-backed)", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let testBuyerId: string;
  let testInvoiceId: string;
  let testPaymentId: string;
  let testImportId: string;

  const TEST_SHOP_DOMAIN = `matcher-test-${Date.now()}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    // Create test buyer account
    const [buyer] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/matcher-test', 'gid://shopify/CompanyLocation/matcher-test',
        'Synthetic Corp', 100000, 'OK', NOW(), NOW()
      )
      RETURNING id
    `;
    testBuyerId = buyer.id;

    // Create test invoice
    const [invoice] = await sql<{ id: string }[]>`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testBuyerId},
        'gid://shopify/Order/matcher-test-1', '#1001', 10000.00, 'open', 10000.00,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
      RETURNING id
    `;
    testInvoiceId = invoice.id;

    // Create test bank import
    const [bankImport] = await sql<{ id: string }[]>`
      INSERT INTO "BankImport" (
        id, "shopId", bank, "fileName", "rowCount", "createdAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'hdfc', 'synthetic-test.csv', 1, NOW()
      )
      RETURNING id
    `;
    testImportId = bankImport.id;

    // Create test payment
    const [payment] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, utr, "payerText", narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        NOW(), 10000.00, 'NEFT', 'SYNTN26296000001', 'SYNTHETIC CORP PVT LTD',
        'NEFT CR-SYNTHETIC CORP PVT LTD-INV1001', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;
    testPaymentId = payment.id;
  });

  afterAll(async () => {
    if (sql && testShopId) {
      // Clean up in reverse dependency order
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;
    }
    if (sql) {
      await sql.end();
    }
  });

  it("gets unmatched payments", async () => {
    const result = await getUnmatchedPayments(sql, testShopId, {
      limit: 10,
      offset: 0,
    });

    expect(result.payments.length).toBeGreaterThanOrEqual(1);
    expect(result.payments[0].id).toBe(testPaymentId);
    expect(result.payments[0].amountPaise).toBe(1000000n); // 10000.00 * 100
  });

  it("gets open invoices for buyer", async () => {
    const invoices = await getOpenInvoicesForBuyer(sql, testShopId, testBuyerId);

    expect(invoices.length).toBeGreaterThanOrEqual(1);
    expect(invoices[0].id).toBe(testInvoiceId);
    expect(invoices[0].outstandingPaise).toBe(1000000n);
  });

  it("gets buyers with aliases", async () => {
    // First create an alias
    await upsertPayerAlias(sql, testBuyerId, "synthetic corp");

    const buyers = await getBuyersWithAliases(sql, testShopId);

    expect(buyers.length).toBeGreaterThanOrEqual(1);
    const buyer = buyers.find((b) => b.id === testBuyerId);
    expect(buyer).toBeDefined();
    expect(buyer?.aliases).toContain("synthetic corp");
  });

  it("creates and queries a match", async () => {
    const matchId = await createMatch(sql, {
      shopId: testShopId,
      paymentId: testPaymentId,
      invoiceId: testInvoiceId,
      amountPaise: 1000000n,
      score: 80,
      reasons: [{ type: "amount_exact", points: 20 }],
    });

    expect(matchId).toBeDefined();

    // Verify match was created
    const [match] = await sql<{ id: string; state: string }[]>`
      SELECT id, state FROM "Match" WHERE id = ${matchId}
    `;

    expect(match.state).toBe("suggested");
  });

  it("confirms a match (idempotent)", async () => {
    // Create a new match for this test
    const matchId = await createMatch(sql, {
      shopId: testShopId,
      paymentId: testPaymentId,
      invoiceId: testInvoiceId,
      amountPaise: 500000n,
      score: 70,
      reasons: [{ type: "payer_name", points: 10 }],
    });

    // Confirm it
    const confirmed = await updateMatchState(
      sql,
      testShopId,
      matchId,
      "confirmed",
      "test-user"
    );
    expect(confirmed).toBe(true);

    // Verify state changed
    const [match] = await sql<{ state: string; confirmed_by: string }[]>`
      SELECT state, "confirmedBy" as confirmed_by FROM "Match" WHERE id = ${matchId}
    `;
    expect(match.state).toBe("confirmed");
    expect(match.confirmed_by).toBe("test-user");

    // Attempting to confirm again should fail (already confirmed)
    const confirmedAgain = await updateMatchState(
      sql,
      testShopId,
      matchId,
      "confirmed",
      "test-user"
    );
    expect(confirmedAgain).toBe(false);
  });

  it("rejects a match", async () => {
    // Create a new match for this test
    const matchId = await createMatch(sql, {
      shopId: testShopId,
      paymentId: testPaymentId,
      invoiceId: testInvoiceId,
      amountPaise: 300000n,
      score: 50,
      reasons: [{ type: "amount_partial", points: 10 }],
    });

    // Reject it
    const rejected = await updateMatchState(
      sql,
      testShopId,
      matchId,
      "unmatched",
      "test-user"
    );
    expect(rejected).toBe(true);

    // Verify state changed
    const [match] = await sql<{ state: string }[]>`
      SELECT state FROM "Match" WHERE id = ${matchId}
    `;
    expect(match.state).toBe("unmatched");
  });

  it("deletes suggested matches for a payment", async () => {
    // Create some suggested matches
    await createMatch(sql, {
      shopId: testShopId,
      paymentId: testPaymentId,
      invoiceId: testInvoiceId,
      amountPaise: 100000n,
      score: 60,
      reasons: [],
    });

    // Delete them
    const deleted = await deleteSuggestedMatchesForPayment(
      sql,
      testShopId,
      testPaymentId
    );
    expect(deleted).toBeGreaterThanOrEqual(1);

    // Verify they're gone
    const [remaining] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM "Match"
      WHERE "paymentId" = ${testPaymentId}
        AND "shopId" = ${testShopId}
        AND state = 'suggested'
    `;
    expect(parseInt(remaining.count, 10)).toBe(0);
  });

  it("updates payment status", async () => {
    await updatePaymentStatus(sql, testShopId, testPaymentId, "partial");

    const [payment] = await sql<{ status: string }[]>`
      SELECT status FROM "Payment" WHERE id = ${testPaymentId}
    `;
    expect(payment.status).toBe("partial");

    // Reset for other tests
    await updatePaymentStatus(sql, testShopId, testPaymentId, "unmatched");
  });

  it("upserts and finds payer alias", async () => {
    const aliasKey = "test alias corp";

    // Create alias
    const aliasId = await upsertPayerAlias(sql, testBuyerId, aliasKey);
    expect(aliasId).toBeDefined();

    // Find buyer by alias
    const buyer = await findBuyerByAlias(sql, testShopId, aliasKey);
    expect(buyer).toBeDefined();
    expect(buyer?.id).toBe(testBuyerId);

    // Upsert same alias should not throw
    const sameAliasId = await upsertPayerAlias(sql, testBuyerId, aliasKey);
    expect(sameAliasId).toBeDefined();
  });

  it("returns null for unknown alias", async () => {
    const buyer = await findBuyerByAlias(sql, testShopId, "nonexistent alias");
    expect(buyer).toBeNull();
  });
});

describeWithDb("Gated account exclusion", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let activeBuyerId: string;
  let gatedBuyerId: string;

  const TEST_SHOP_DOMAIN = `gating-matcher-test-${Date.now()}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    // Create active buyer
    const [activeBuyer] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/active-matcher', 'gid://shopify/CompanyLocation/active-matcher',
        'Active Buyer Corp', 'OK', NOW(), NOW()
      )
      RETURNING id
    `;
    activeBuyerId = activeBuyer.id;

    // Create gated buyer
    const [gatedBuyer] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "holdState", gated_at, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/gated-matcher', 'gid://shopify/CompanyLocation/gated-matcher',
        'Gated Buyer Corp', 'OK', NOW(), NOW(), NOW()
      )
      RETURNING id
    `;
    gatedBuyerId = gatedBuyer.id;

    // Create invoices for both buyers
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${activeBuyerId},
        'gid://shopify/Order/active-inv', '#2001', 5000.00, 'open', 5000.00,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${gatedBuyerId},
        'gid://shopify/Order/gated-inv', '#2002', 3000.00, 'open', 3000.00,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    if (sql && testShopId) {
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;
    }
    if (sql) {
      await sql.end();
    }
  });

  it("excludes gated buyer invoices when PLAN_GATING_ENFORCED=true", async () => {
    const originalEnv = process.env.PLAN_GATING_ENFORCED;
    (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = "true";

    try {
      const invoices = await getOpenInvoicesForBuyer(
        sql,
        testShopId,
        gatedBuyerId
      );

      // Gated buyer's invoices should be excluded
      expect(invoices.length).toBe(0);
    } finally {
      (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = originalEnv;
    }
  });

  it("includes gated buyer invoices when PLAN_GATING_ENFORCED=false", async () => {
    const originalEnv = process.env.PLAN_GATING_ENFORCED;
    (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = "false";

    try {
      const invoices = await getOpenInvoicesForBuyer(
        sql,
        testShopId,
        gatedBuyerId
      );

      // Gated buyer's invoices should be included
      expect(invoices.length).toBeGreaterThanOrEqual(1);
    } finally {
      (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = originalEnv;
    }
  });

  it("excludes gated buyers from getBuyersWithAliases when gating enforced", async () => {
    const originalEnv = process.env.PLAN_GATING_ENFORCED;
    (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = "true";

    try {
      const buyers = await getBuyersWithAliases(sql, testShopId);

      // Should only include the active buyer
      expect(buyers.length).toBe(1);
      expect(buyers[0].id).toBe(activeBuyerId);
    } finally {
      (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = originalEnv;
    }
  });
});
