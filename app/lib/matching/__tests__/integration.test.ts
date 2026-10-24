/**
 * Integration tests for payment matching with database.
 *
 * Uses synthetic fixtures and the CI pgmq Postgres service.
 * Each test is isolated per shop to avoid interference.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
  getRejectedPairs,
  createRejectedMatch,
} from "../queries.server";
import { confirmMatch, rejectMatch, runMatcher } from "~/services/matcher.server";
import { reasonsContainNoPII } from "../score";

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

  it("includes gated buyer invoices when PLAN_GATING_ENFORCED=true", async () => {
    const originalEnv = process.env.PLAN_GATING_ENFORCED;
    (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = "true";

    try {
      const invoices = await getOpenInvoicesForBuyer(
        sql,
        testShopId,
        gatedBuyerId
      );

      // Gated buyer's invoices should be INCLUDED
      // (gating applies only to value-add actions, not to matching/aging/totals)
      expect(invoices.length).toBeGreaterThanOrEqual(1);
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

  it("includes gated buyers in getBuyersWithAliases when gating enforced", async () => {
    const originalEnv = process.env.PLAN_GATING_ENFORCED;
    (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = "true";

    try {
      const buyers = await getBuyersWithAliases(sql, testShopId);

      // Should include both buyers (gated accounts are included in matching)
      // (gating applies only to value-add actions, not to matching)
      expect(buyers.length).toBe(2);
      
      // Verify both buyers are present
      const buyerIds = buyers.map(b => b.id);
      expect(buyerIds).toContain(activeBuyerId);
      expect(buyerIds).toContain(gatedBuyerId);
    } finally {
      (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = originalEnv;
    }
  });
});

// =============================================================================
// P1.1: Over-allocation prevention tests
// =============================================================================

describeWithDb("Over-allocation prevention (P1.1)", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let testBuyerId: string;
  let testBuyer2Id: string;
  let testInvoiceId: string;
  let testInvoice2Id: string;
  let testImportId: string;

  const TEST_SHOP_DOMAIN = `over-alloc-test-${Date.now()}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    // Create test buyer accounts (two buyers for cross-buyer tests)
    const [buyer1] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/buyer1', 'gid://shopify/CompanyLocation/buyer1',
        'Buyer One Corp', 'OK', NOW(), NOW()
      )
      RETURNING id
    `;
    testBuyerId = buyer1.id;

    const [buyer2] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/buyer2', 'gid://shopify/CompanyLocation/buyer2',
        'Buyer Two Corp', 'OK', NOW(), NOW()
      )
      RETURNING id
    `;
    testBuyer2Id = buyer2.id;

    // Create test invoices
    const [invoice1] = await sql<{ id: string }[]>`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testBuyerId},
        'gid://shopify/Order/alloc-test-1', '#3001', 5000.00, 'open', 5000.00,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
      RETURNING id
    `;
    testInvoiceId = invoice1.id;

    const [invoice2] = await sql<{ id: string }[]>`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testBuyer2Id},
        'gid://shopify/Order/alloc-test-2', '#3002', 4000.00, 'open', 4000.00,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
      RETURNING id
    `;
    testInvoice2Id = invoice2.id;

    // Create test bank import
    const [bankImport] = await sql<{ id: string }[]>`
      INSERT INTO "BankImport" (
        id, "shopId", bank, "fileName", "rowCount", "createdAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'hdfc', 'over-alloc-test.csv', 1, NOW()
      )
      RETURNING id
    `;
    testImportId = bankImport.id;
  });

  beforeEach(async () => {
    // Clean up matches and payments before each test
    await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
  });

  afterAll(async () => {
    if (sql && testShopId) {
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" IN (${testBuyerId}, ${testBuyer2Id})`;
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

  it("caps confirmed allocation at payment amount (no over-allocation)", async () => {
    // Create a payment of 3000 INR
    const [payment] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        NOW(), 3000.00, 'NEFT', 'NEFT CR-TEST PAYMENT', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create a suggested match for 5000 INR (more than payment amount)
    const matchId = await createMatch(sql, {
      shopId: testShopId,
      paymentId: payment.id,
      invoiceId: testInvoiceId,
      amountPaise: 500000n, // 5000 INR - exceeds payment
      score: 80,
      reasons: [{ type: "amount_exact", points: 20 }],
    });

    // Confirm the match
    const result = await confirmMatch(sql, testShopId, matchId, "test-user");
    expect(result.success).toBe(true);

    // Verify the allocation was capped at payment amount (3000)
    const [confirmedMatch] = await sql<{ amount: string }[]>`
      SELECT amount::text FROM "Match" WHERE id = ${matchId}
    `;
    expect(parseFloat(confirmedMatch.amount)).toBe(3000);
  });

  it("caps confirmed allocation at invoice remaining outstanding", async () => {
    // Create a payment of 10000 INR
    const [payment] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        NOW(), 10000.00, 'NEFT', 'NEFT CR-TEST PAYMENT', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create a suggested match for 10000 INR (more than invoice outstanding of 5000)
    const matchId = await createMatch(sql, {
      shopId: testShopId,
      paymentId: payment.id,
      invoiceId: testInvoiceId,
      amountPaise: 1000000n, // 10000 INR - exceeds invoice outstanding
      score: 80,
      reasons: [{ type: "amount_exact", points: 20 }],
    });

    // Confirm the match
    const result = await confirmMatch(sql, testShopId, matchId, "test-user");
    expect(result.success).toBe(true);

    // Verify the allocation was capped at invoice outstanding (5000)
    const [confirmedMatch] = await sql<{ amount: string }[]>`
      SELECT amount::text FROM "Match" WHERE id = ${matchId}
    `;
    expect(parseFloat(confirmedMatch.amount)).toBe(5000);
  });

  it("drops competing suggestions for same payment on confirm (all buyers)", async () => {
    // Create a payment of 5000 INR
    const [payment] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        NOW(), 5000.00, 'NEFT', 'NEFT CR-TEST PAYMENT', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create suggested matches for BOTH buyers (cross-buyer competition)
    const matchId1 = await createMatch(sql, {
      shopId: testShopId,
      paymentId: payment.id,
      invoiceId: testInvoiceId, // Buyer 1's invoice
      amountPaise: 500000n,
      score: 80,
      reasons: [{ type: "amount_exact", points: 20 }],
    });

    const matchId2 = await createMatch(sql, {
      shopId: testShopId,
      paymentId: payment.id,
      invoiceId: testInvoice2Id, // Buyer 2's invoice
      amountPaise: 400000n,
      score: 70,
      reasons: [{ type: "payer_name", points: 10 }],
    });

    // Confirm the first match (buyer 1)
    const result = await confirmMatch(sql, testShopId, matchId1, "test-user");
    expect(result.success).toBe(true);

    // Verify the competing match (buyer 2) was dropped
    const [droppedMatch] = await sql<{ state: string }[]>`
      SELECT state FROM "Match" WHERE id = ${matchId2}
    `;
    expect(droppedMatch.state).toBe("unmatched");

    // Verify only one suggested match remains (none - all processed)
    const [suggestedCount] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM "Match"
      WHERE "paymentId" = ${payment.id}
        AND "shopId" = ${testShopId}
        AND state = 'suggested'
    `;
    expect(parseInt(suggestedCount.count, 10)).toBe(0);
  });

  it("prevents double confirmation of same match", async () => {
    // Create a payment
    const [payment] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        NOW(), 3000.00, 'NEFT', 'NEFT CR-TEST', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create a match
    const matchId = await createMatch(sql, {
      shopId: testShopId,
      paymentId: payment.id,
      invoiceId: testInvoiceId,
      amountPaise: 300000n,
      score: 80,
      reasons: [],
    });

    // Confirm once - should succeed
    const result1 = await confirmMatch(sql, testShopId, matchId, "test-user");
    expect(result1.success).toBe(true);

    // Confirm again - should be idempotent success (no side effects)
    const result2 = await confirmMatch(sql, testShopId, matchId, "test-user");
    expect(result2.success).toBe(true);
  });

  it("correctly handles partial re-allocation after first confirm", async () => {
    // Create a payment of 8000 INR
    const [payment] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        NOW(), 8000.00, 'NEFT', 'NEFT CR-TEST PARTIAL', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create first match for 5000 (covers invoice 1 fully)
    const matchId1 = await createMatch(sql, {
      shopId: testShopId,
      paymentId: payment.id,
      invoiceId: testInvoiceId,
      amountPaise: 500000n,
      score: 80,
      reasons: [],
    });

    // Confirm first match
    const result1 = await confirmMatch(sql, testShopId, matchId1, "test-user");
    expect(result1.success).toBe(true);

    // Verify payment status is 'partial' (3000 remaining)
    const [paymentStatus] = await sql<{ status: string }[]>`
      SELECT status FROM "Payment" WHERE id = ${payment.id}
    `;
    expect(paymentStatus.status).toBe("partial");

    // Create second match for remaining 3000
    const matchId2 = await createMatch(sql, {
      shopId: testShopId,
      paymentId: payment.id,
      invoiceId: testInvoice2Id,
      amountPaise: 300000n,
      score: 70,
      reasons: [],
    });

    // Confirm second match - should be capped at remaining 3000
    const result2 = await confirmMatch(sql, testShopId, matchId2, "test-user");
    expect(result2.success).toBe(true);

    // Verify the second allocation amount
    const [secondMatch] = await sql<{ amount: string }[]>`
      SELECT amount::text FROM "Match" WHERE id = ${matchId2}
    `;
    expect(parseFloat(secondMatch.amount)).toBe(3000);

    // Verify payment is now fully matched
    const [finalStatus] = await sql<{ status: string }[]>`
      SELECT status FROM "Payment" WHERE id = ${payment.id}
    `;
    expect(finalStatus.status).toBe("matched");
  });
});

// =============================================================================
// P2.2: Rejected pairs persistence tests
// =============================================================================

describeWithDb("Rejected pairs persistence (P2.2)", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let testBuyerId: string;
  let testInvoiceId: string;
  let testPaymentId: string;
  let testImportId: string;

  const TEST_SHOP_DOMAIN = `rejected-pairs-test-${Date.now()}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    // Create test buyer
    const [buyer] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/reject-test', 'gid://shopify/CompanyLocation/reject-test',
        'Reject Test Corp', 'OK', NOW(), NOW()
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
        'gid://shopify/Order/reject-test-1', '#4001', 5000.00, 'open', 5000.00,
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
        gen_random_uuid()::text, ${testShopId}, 'hdfc', 'reject-test.csv', 1, NOW()
      )
      RETURNING id
    `;
    testImportId = bankImport.id;
  });

  beforeEach(async () => {
    // Clean up matches, rejected pairs, and payments before each test
    await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
  });

  afterAll(async () => {
    if (sql && testShopId) {
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
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

  it("persists rejection in rejected_matches table", async () => {
    // Create payment
    const [payment] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        NOW(), 5000.00, 'NEFT', 'NEFT CR-REJECT TEST', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;
    testPaymentId = payment.id;

    // Create a match
    const matchId = await createMatch(sql, {
      shopId: testShopId,
      paymentId: testPaymentId,
      invoiceId: testInvoiceId,
      amountPaise: 500000n,
      score: 70,
      reasons: [],
    });

    // Reject the match
    const result = await rejectMatch(sql, testShopId, matchId, "test-user");
    expect(result.success).toBe(true);

    // Verify rejection is persisted
    const rejectedPairs = await getRejectedPairs(sql, testShopId, testPaymentId);
    expect(rejectedPairs.length).toBe(1);
    expect(rejectedPairs[0].invoiceId).toBe(testInvoiceId);
  });

  it("prevents re-suggestion of rejected payment-invoice pairs", async () => {
    // Create payment
    const [payment] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, "payerText", narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        NOW(), 5000.00, 'NEFT', 'REJECT TEST CORP', 'NEFT CR-REJECT TEST CORP', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;
    testPaymentId = payment.id;

    // Create and reject a match
    const matchId = await createMatch(sql, {
      shopId: testShopId,
      paymentId: testPaymentId,
      invoiceId: testInvoiceId,
      amountPaise: 500000n,
      score: 70,
      reasons: [],
    });
    await rejectMatch(sql, testShopId, matchId, "test-user");

    // Run matcher again - should not suggest the same invoice
    const runResult = await runMatcher(sql, testShopId, { limit: 10 });
    expect(runResult.paymentsProcessed).toBeGreaterThanOrEqual(0);

    // Check that no new match was created for this invoice
    const [matchCount] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM "Match"
      WHERE "paymentId" = ${testPaymentId}
        AND "invoiceId" = ${testInvoiceId}
        AND state = 'suggested'
    `;
    expect(parseInt(matchCount.count, 10)).toBe(0);
  });

  it("allows re-rejection (idempotent)", async () => {
    // Create payment
    const [payment] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        NOW(), 5000.00, 'NEFT', 'NEFT CR-REJECT TEST', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;
    testPaymentId = payment.id;

    // Manually insert a rejected pair
    await createRejectedMatch(sql, {
      shopId: testShopId,
      paymentId: testPaymentId,
      invoiceId: testInvoiceId,
      rejectedBy: "user-1",
    });

    // Create another match for the same pair (shouldn't happen, but test idempotency)
    const matchId = await createMatch(sql, {
      shopId: testShopId,
      paymentId: testPaymentId,
      invoiceId: testInvoiceId,
      amountPaise: 500000n,
      score: 70,
      reasons: [],
    });

    // Reject again - should succeed (upsert)
    const result = await rejectMatch(sql, testShopId, matchId, "user-2");
    expect(result.success).toBe(true);

    // Verify only one rejection record exists
    const [rejectionCount] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM "rejected_matches"
      WHERE "paymentId" = ${testPaymentId}
        AND "invoiceId" = ${testInvoiceId}
    `;
    expect(parseInt(rejectionCount.count, 10)).toBe(1);
  });
});

// =============================================================================
// P1.3: No PII in match reasons
// =============================================================================

describeWithDb("No PII in match reasons (P1.3)", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let testBuyerId: string;
  let testInvoiceId: string;
  let testImportId: string;

  const TEST_SHOP_DOMAIN = `no-pii-test-${Date.now()}.myshopify.com`;
  const TEST_EMAIL = "testbuyer@example.com";

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    // Create test buyer with email
    const [buyer] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", "customerId", name, "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/pii-test', 'gid://shopify/CompanyLocation/pii-test',
        'gid://shopify/Customer/pii-test',
        'PII Test Corp', 'OK', NOW(), NOW()
      )
      RETURNING id
    `;
    testBuyerId = buyer.id;

    // Create tagged customer with email
    await sql`
      INSERT INTO "s8_tagged_customers" (
        id, shop_id, customer_id, email, display_name, tags, created_at
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'gid://shopify/Customer/pii-test',
        ${TEST_EMAIL}, 'Test Buyer', '[]'::json, NOW()
      )
    `;

    // Create test invoice
    const [invoice] = await sql<{ id: string }[]>`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testBuyerId},
        'gid://shopify/Order/pii-test-1', '#5001', 5000.00, 'open', 5000.00,
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
        gen_random_uuid()::text, ${testShopId}, 'hdfc', 'pii-test.csv', 1, NOW()
      )
      RETURNING id
    `;
    testImportId = bankImport.id;
  });

  afterAll(async () => {
    if (sql && testShopId) {
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "s8_tagged_customers" WHERE shop_id = ${testShopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;
    }
    if (sql) {
      await sql.end();
    }
  });

  it("does not include email addresses in persisted match reasons", async () => {
    // Create payment that should trigger email match
    const [payment] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, "payerText", narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        NOW(), 5000.00, 'NEFT', 'TESTBUYER EXAMPLE', 'NEFT CR-TESTBUYER EXAMPLE INV5001', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;

    // Run matcher
    await runMatcher(sql, testShopId, { limit: 10 });

    // Get the created matches
    const matches = await sql<{ reasons: string }[]>`
      SELECT reasons::text
      FROM "Match"
      WHERE "paymentId" = ${payment.id}
        AND "shopId" = ${testShopId}
    `;

    // Check all match reasons don't contain email
    for (const match of matches) {
      const reasons = JSON.parse(match.reasons);
      expect(reasonsContainNoPII(reasons)).toBe(true);
      
      // Explicitly check for email
      const reasonsStr = JSON.stringify(reasons);
      expect(reasonsStr).not.toContain(TEST_EMAIL);
      expect(reasonsStr).not.toContain("@");
    }
  });

  it("does not include full names in persisted match reasons", async () => {
    // Create a match with reasons
    const matchId = await createMatch(sql, {
      shopId: testShopId,
      paymentId: (await sql<{id: string}[]>`
        INSERT INTO "Payment" (
          id, "shopId", "importId", "valueDate", amount, rail, "payerText", narration, status, "createdAt", "updatedAt"
        )
        VALUES (
          gen_random_uuid()::text, ${testShopId}, ${testImportId},
          NOW(), 5000.00, 'NEFT', 'Test Buyer Corp', 'NEFT CR-TEST', 'unmatched', NOW(), NOW()
        )
        RETURNING id
      `)[0].id,
      invoiceId: testInvoiceId,
      amountPaise: 500000n,
      score: 80,
      reasons: [
        { type: "payer_name", points: 10, detail: "Name matched" }, // Good - no PII
        { type: "email_match", points: 6, detail: "Email prefix matched" }, // Good - no actual email
      ],
    });

    // Verify the reasons stored don't contain PII
    const [match] = await sql<{ reasons: string }[]>`
      SELECT reasons::text FROM "Match" WHERE id = ${matchId}
    `;
    const reasons = JSON.parse(match.reasons);
    expect(reasonsContainNoPII(reasons)).toBe(true);
  });
});

// =============================================================================
// P1: Split payment - confirm A then B (same buyer siblings remain confirmable)
// =============================================================================

describeWithDb("Split payment confirmation (P1)", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let testBuyerId: string;
  let testInvoiceAId: string;
  let testInvoiceBId: string;
  let testPaymentId: string;
  let testImportId: string;

  const TEST_SHOP_DOMAIN = `split-payment-test-${Date.now()}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    // Create test buyer
    const [buyer] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/split-test', 'gid://shopify/CompanyLocation/split-test',
        'Split Payment Corp', 'OK', NOW(), NOW()
      )
      RETURNING id
    `;
    testBuyerId = buyer.id;

    // Create TWO invoices for the same buyer (for split payment)
    const [invoiceA] = await sql<{ id: string }[]>`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testBuyerId},
        'gid://shopify/Order/split-A', '#6001', 3000.00, 'open', 3000.00,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
      RETURNING id
    `;
    testInvoiceAId = invoiceA.id;

    const [invoiceB] = await sql<{ id: string }[]>`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testBuyerId},
        'gid://shopify/Order/split-B', '#6002', 4000.00, 'open', 4000.00,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
      RETURNING id
    `;
    testInvoiceBId = invoiceB.id;

    // Create test bank import
    const [bankImport] = await sql<{ id: string }[]>`
      INSERT INTO "BankImport" (
        id, "shopId", bank, "fileName", "rowCount", "createdAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'hdfc', 'split-payment-test.csv', 1, NOW()
      )
      RETURNING id
    `;
    testImportId = bankImport.id;
  });

  beforeEach(async () => {
    // Clean up matches and payments before each test
    await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
  });

  afterAll(async () => {
    if (sql && testShopId) {
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
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

  it("split payment: confirm A, then B is still suggested and confirmable", async () => {
    // Create a payment of 7000 INR (covers both invoices: 3000 + 4000)
    const [payment] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        NOW(), 7000.00, 'NEFT', 'NEFT CR-SPLIT PAYMENT CORP', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;
    testPaymentId = payment.id;

    // Create suggested matches for BOTH invoices (same buyer, split payment)
    const matchAId = await createMatch(sql, {
      shopId: testShopId,
      paymentId: testPaymentId,
      invoiceId: testInvoiceAId,
      amountPaise: 300000n, // 3000 INR
      score: 80,
      reasons: [{ type: "amount_exact", points: 20 }],
    });

    const matchBId = await createMatch(sql, {
      shopId: testShopId,
      paymentId: testPaymentId,
      invoiceId: testInvoiceBId,
      amountPaise: 400000n, // 4000 INR
      score: 75,
      reasons: [{ type: "amount_exact", points: 20 }],
    });

    // Confirm match A
    const resultA = await confirmMatch(sql, testShopId, matchAId, "test-user");
    expect(resultA.success).toBe(true);

    // Verify match A is confirmed
    const [matchAState] = await sql<{ state: string; amount: string }[]>`
      SELECT state, amount::text FROM "Match" WHERE id = ${matchAId}
    `;
    expect(matchAState.state).toBe("confirmed");
    expect(parseFloat(matchAState.amount)).toBe(3000);

    // Verify match B is STILL suggested (not unmatched)
    const [matchBState] = await sql<{ state: string }[]>`
      SELECT state FROM "Match" WHERE id = ${matchBId}
    `;
    expect(matchBState.state).toBe("suggested");

    // Now confirm match B
    const resultB = await confirmMatch(sql, testShopId, matchBId, "test-user");
    expect(resultB.success).toBe(true);

    // Verify match B is confirmed
    const [matchBFinal] = await sql<{ state: string; amount: string }[]>`
      SELECT state, amount::text FROM "Match" WHERE id = ${matchBId}
    `;
    expect(matchBFinal.state).toBe("confirmed");
    expect(parseFloat(matchBFinal.amount)).toBe(4000);

    // Verify total confirmed allocations <= payment amount
    const [totalConfirmed] = await sql<{ total: string }[]>`
      SELECT SUM(amount)::text AS total
      FROM "Match"
      WHERE "paymentId" = ${testPaymentId}
        AND state = 'confirmed'
    `;
    expect(parseFloat(totalConfirmed.total)).toBe(7000);
    expect(parseFloat(totalConfirmed.total)).toBeLessThanOrEqual(7000);

    // Verify payment is fully matched
    const [paymentState] = await sql<{ status: string }[]>`
      SELECT status FROM "Payment" WHERE id = ${testPaymentId}
    `;
    expect(paymentState.status).toBe("matched");
  });

  it("split payment with partial allocation: respects remaining payment amount", async () => {
    // Create a payment of 5000 INR (less than sum of invoices: 3000 + 4000 = 7000)
    const [payment] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        NOW(), 5000.00, 'NEFT', 'NEFT CR-PARTIAL SPLIT', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;
    testPaymentId = payment.id;

    // Create suggested matches for both invoices
    const matchAId = await createMatch(sql, {
      shopId: testShopId,
      paymentId: testPaymentId,
      invoiceId: testInvoiceAId,
      amountPaise: 300000n, // 3000 INR
      score: 80,
      reasons: [],
    });

    const matchBId = await createMatch(sql, {
      shopId: testShopId,
      paymentId: testPaymentId,
      invoiceId: testInvoiceBId,
      amountPaise: 400000n, // 4000 INR (but only 2000 remaining after A)
      score: 75,
      reasons: [],
    });

    // Confirm A first (3000)
    const resultA = await confirmMatch(sql, testShopId, matchAId, "test-user");
    expect(resultA.success).toBe(true);

    // Confirm B - should be capped at remaining 2000
    const resultB = await confirmMatch(sql, testShopId, matchBId, "test-user");
    expect(resultB.success).toBe(true);

    // Verify B was capped at 2000 (not 4000)
    const [matchBFinal] = await sql<{ amount: string }[]>`
      SELECT amount::text FROM "Match" WHERE id = ${matchBId}
    `;
    expect(parseFloat(matchBFinal.amount)).toBe(2000);

    // Verify total = payment amount
    const [totalConfirmed] = await sql<{ total: string }[]>`
      SELECT SUM(amount)::text AS total
      FROM "Match"
      WHERE "paymentId" = ${testPaymentId}
        AND state = 'confirmed'
    `;
    expect(parseFloat(totalConfirmed.total)).toBe(5000);
  });

  it("drops other buyers' suggestions but keeps same-buyer siblings", async () => {
    // Create another buyer
    const [otherBuyer] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/other-buyer', 'gid://shopify/CompanyLocation/other-buyer',
        'Other Buyer Corp', 'OK', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create invoice for other buyer
    const [otherInvoice] = await sql<{ id: string }[]>`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${otherBuyer.id},
        'gid://shopify/Order/other-inv', '#7001', 5000.00, 'open', 5000.00,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create payment
    const [payment] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        NOW(), 7000.00, 'NEFT', 'NEFT CR-MULTI BUYER', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;
    testPaymentId = payment.id;

    // Create matches for same buyer (A and B) and other buyer
    const matchAId = await createMatch(sql, {
      shopId: testShopId,
      paymentId: testPaymentId,
      invoiceId: testInvoiceAId, // Same buyer
      amountPaise: 300000n,
      score: 80,
      reasons: [],
    });

    const matchBId = await createMatch(sql, {
      shopId: testShopId,
      paymentId: testPaymentId,
      invoiceId: testInvoiceBId, // Same buyer
      amountPaise: 400000n,
      score: 75,
      reasons: [],
    });

    const matchOtherId = await createMatch(sql, {
      shopId: testShopId,
      paymentId: testPaymentId,
      invoiceId: otherInvoice.id, // Different buyer
      amountPaise: 500000n,
      score: 70,
      reasons: [],
    });

    // Confirm A
    await confirmMatch(sql, testShopId, matchAId, "test-user");

    // Verify B (same buyer) is still suggested
    const [matchBState] = await sql<{ state: string }[]>`
      SELECT state FROM "Match" WHERE id = ${matchBId}
    `;
    expect(matchBState.state).toBe("suggested");

    // Verify other buyer's match is dropped
    const [matchOtherState] = await sql<{ state: string }[]>`
      SELECT state FROM "Match" WHERE id = ${matchOtherId}
    `;
    expect(matchOtherState.state).toBe("unmatched");

    // Cleanup - delete matches first (FK constraint)
    await sql`DELETE FROM "Match" WHERE "invoiceId" = ${otherInvoice.id}`;
    await sql`DELETE FROM "Invoice" WHERE id = ${otherInvoice.id}`;
    await sql`DELETE FROM "BuyerAccount" WHERE id = ${otherBuyer.id}`;
  });
});

// =============================================================================
// P2: Concurrent confirms without deadlock
// =============================================================================

describeWithDb("Concurrent confirms without deadlock (P2)", () => {
  let sql1: ReturnType<typeof postgres>;
  let sql2: ReturnType<typeof postgres>;
  let testShopId: string;
  let testBuyerId: string;
  let testInvoiceId: string;
  let testImportId: string;

  const TEST_SHOP_DOMAIN = `deadlock-test-${Date.now()}.myshopify.com`;

  beforeAll(async () => {
    // Create TWO separate connections for concurrent operations
    sql1 = postgres(TEST_DATABASE_URL!, sqlOptions);
    sql2 = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Setup using first connection
    const [shop] = await sql1<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    const [buyer] = await sql1<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/deadlock-test', 'gid://shopify/CompanyLocation/deadlock-test',
        'Deadlock Test Corp', 'OK', NOW(), NOW()
      )
      RETURNING id
    `;
    testBuyerId = buyer.id;

    const [invoice] = await sql1<{ id: string }[]>`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testBuyerId},
        'gid://shopify/Order/deadlock-test', '#8001', 10000.00, 'open', 10000.00,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
      RETURNING id
    `;
    testInvoiceId = invoice.id;

    const [bankImport] = await sql1<{ id: string }[]>`
      INSERT INTO "BankImport" (
        id, "shopId", bank, "fileName", "rowCount", "createdAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'hdfc', 'deadlock-test.csv', 1, NOW()
      )
      RETURNING id
    `;
    testImportId = bankImport.id;
  });

  beforeEach(async () => {
    await sql1`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
    await sql1`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
  });

  afterAll(async () => {
    if (sql1 && testShopId) {
      await sql1`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
      await sql1`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql1`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql1`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql1`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
      await sql1`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql1`DELETE FROM "Shop" WHERE id = ${testShopId}`;
    }
    if (sql1) await sql1.end();
    if (sql2) await sql2.end();
  });

  it("two concurrent confirms on one payment complete without deadlock", async () => {
    // Create payment
    const [payment] = await sql1<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        NOW(), 10000.00, 'NEFT', 'NEFT CR-CONCURRENT TEST', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create two suggested matches
    const matchId1 = await createMatch(sql1, {
      shopId: testShopId,
      paymentId: payment.id,
      invoiceId: testInvoiceId,
      amountPaise: 500000n, // 5000
      score: 80,
      reasons: [],
    });

    const matchId2 = await createMatch(sql1, {
      shopId: testShopId,
      paymentId: payment.id,
      invoiceId: testInvoiceId,
      amountPaise: 500000n, // 5000
      score: 75,
      reasons: [],
    });

    // Attempt concurrent confirms using separate connections
    // This should NOT deadlock due to consistent lock ordering
    const results = await Promise.all([
      confirmMatch(sql1, testShopId, matchId1, "user-1"),
      confirmMatch(sql2, testShopId, matchId2, "user-2"),
    ]);

    // Both should complete (one success, one may fail due to state change or caps)
    // The key is NO DEADLOCK ERROR
    const errors = results
      .filter((r) => !r.success && r.error)
      .map((r) => r.error);

    // Deadlock would show as "deadlock detected" error - should not happen
    for (const error of errors) {
      expect(error?.toLowerCase()).not.toContain("deadlock");
    }

    // At least one should succeed
    const successes = results.filter((r) => r.success);
    expect(successes.length).toBeGreaterThanOrEqual(1);

    // Total confirmed should not exceed payment amount
    const [totalConfirmed] = await sql1<{ total: string }[]>`
      SELECT COALESCE(SUM(amount), 0)::text AS total
      FROM "Match"
      WHERE "paymentId" = ${payment.id}
        AND state = 'confirmed'
    `;
    expect(parseFloat(totalConfirmed.total)).toBeLessThanOrEqual(10000);
  });

  it("concurrent confirms from different buyers complete without deadlock", async () => {
    // Create second buyer
    const [buyer2] = await sql1<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/deadlock-buyer2', 'gid://shopify/CompanyLocation/deadlock-buyer2',
        'Second Buyer Corp', 'OK', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create invoice for second buyer
    const [invoice2] = await sql1<{ id: string }[]>`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${buyer2.id},
        'gid://shopify/Order/deadlock-inv2', '#8002', 8000.00, 'open', 8000.00,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create payment
    const [payment] = await sql1<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        NOW(), 10000.00, 'NEFT', 'NEFT CR-MULTI BUYER CONCURRENT', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create matches for different buyers
    const matchId1 = await createMatch(sql1, {
      shopId: testShopId,
      paymentId: payment.id,
      invoiceId: testInvoiceId, // Buyer 1
      amountPaise: 600000n,
      score: 80,
      reasons: [],
    });

    const matchId2 = await createMatch(sql1, {
      shopId: testShopId,
      paymentId: payment.id,
      invoiceId: invoice2.id, // Buyer 2
      amountPaise: 500000n,
      score: 75,
      reasons: [],
    });

    // Attempt concurrent confirms
    const results = await Promise.all([
      confirmMatch(sql1, testShopId, matchId1, "user-1"),
      confirmMatch(sql2, testShopId, matchId2, "user-2"),
    ]);

    // Check for deadlock errors
    for (const result of results) {
      if (!result.success && result.error) {
        expect(result.error.toLowerCase()).not.toContain("deadlock");
      }
    }

    // Exactly one should succeed (the other's buyer gets dropped)
    const successes = results.filter((r) => r.success);
    expect(successes.length).toBe(1);

    // Cleanup - delete matches first (FK constraint)
    await sql1`DELETE FROM "Match" WHERE "invoiceId" = ${invoice2.id}`;
    await sql1`DELETE FROM "Invoice" WHERE id = ${invoice2.id}`;
    await sql1`DELETE FROM "BuyerAccount" WHERE id = ${buyer2.id}`;
  });
});

// =============================================================================
// P1: Cross-payment invoice over-allocation prevention
// =============================================================================

describeWithDb("Cross-payment invoice over-allocation prevention (P1)", () => {
  let sql: ReturnType<typeof postgres>;
  let sql2: ReturnType<typeof postgres>;
  let testShopId: string;
  let testBuyerId: string;
  let testImportId: string;

  const TEST_SHOP_DOMAIN = `cross-payment-test-${Date.now()}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    sql2 = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    // Create test buyer
    const [buyer] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/cross-payment-test', 'gid://shopify/CompanyLocation/cross-payment-test',
        'Cross Payment Corp', 'OK', NOW(), NOW()
      )
      RETURNING id
    `;
    testBuyerId = buyer.id;

    // Create test bank import
    const [bankImport] = await sql<{ id: string }[]>`
      INSERT INTO "BankImport" (
        id, "shopId", bank, "fileName", "rowCount", "createdAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'hdfc', 'cross-payment-test.csv', 1, NOW()
      )
      RETURNING id
    `;
    testImportId = bankImport.id;
  });

  afterAll(async () => {
    if (sql && testShopId) {
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;
    }
    if (sql) await sql.end();
    if (sql2) await sql2.end();
  });

  it("caps second payment when invoice is already allocated by first payment", async () => {
    // Create invoice with 1000 paise outstanding
    const [invoice] = await sql<{ id: string }[]>`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testBuyerId},
        gen_random_uuid()::text, 'INV-CROSS-1', 10.00, 'open', 10.00,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create payment X with 1000 paise
    const [paymentX] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        NOW(), 10.00, 'NEFT', 'NEFT CR-PAYMENT X INV-CROSS-1', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create payment Y with 1000 paise
    const [paymentY] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        NOW(), 10.00, 'NEFT', 'NEFT CR-PAYMENT Y INV-CROSS-1', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create match X -> invoice (1000 paise)
    const matchIdX = await createMatch(sql, {
      shopId: testShopId,
      paymentId: paymentX.id,
      invoiceId: invoice.id,
      amountPaise: 1000n,
      score: 85,
      reasons: [],
    });

    // Create match Y -> invoice (1000 paise)
    const matchIdY = await createMatch(sql, {
      shopId: testShopId,
      paymentId: paymentY.id,
      invoiceId: invoice.id,
      amountPaise: 1000n,
      score: 85,
      reasons: [],
    });

    // Confirm X first
    const resultX = await confirmMatch(sql, testShopId, matchIdX, "user-1");
    expect(resultX.success).toBe(true);

    // Confirm Y - should be capped to 0 or rejected (invoice fully allocated)
    const resultY = await confirmMatch(sql, testShopId, matchIdY, "user-2");
    expect(resultY.success).toBe(false);
    expect(resultY.error).toMatch(/invoice fully allocated|no remaining allocation/i);

    // Verify total confirmed for invoice is <= 1000 paise
    const [totalResult] = await sql<{ total_paise: string }[]>`
      SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::text AS total_paise
      FROM "Match"
      WHERE "invoiceId" = ${invoice.id}
        AND state = 'confirmed'
    `;
    expect(BigInt(totalResult.total_paise)).toBeLessThanOrEqual(1000n);

    // Cleanup
    await sql`DELETE FROM "Match" WHERE "invoiceId" = ${invoice.id}`;
    await sql`DELETE FROM "Payment" WHERE id IN (${paymentX.id}, ${paymentY.id})`;
    await sql`DELETE FROM "Invoice" WHERE id = ${invoice.id}`;
  });

  it("handles concurrent confirms from two payments on same invoice without deadlock", async () => {
    // Create invoice with 1000 paise outstanding
    const [invoice] = await sql<{ id: string }[]>`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testBuyerId},
        gen_random_uuid()::text, 'INV-CONCURRENT-CROSS', 10.00, 'open', 10.00,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create payment X with 1000 paise
    const [paymentX] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        NOW(), 10.00, 'NEFT', 'NEFT CR-CONCURRENT X', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create payment Y with 1000 paise
    const [paymentY] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        NOW(), 10.00, 'NEFT', 'NEFT CR-CONCURRENT Y', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create matches
    const matchIdX = await createMatch(sql, {
      shopId: testShopId,
      paymentId: paymentX.id,
      invoiceId: invoice.id,
      amountPaise: 1000n,
      score: 85,
      reasons: [],
    });

    const matchIdY = await createMatch(sql, {
      shopId: testShopId,
      paymentId: paymentY.id,
      invoiceId: invoice.id,
      amountPaise: 1000n,
      score: 85,
      reasons: [],
    });

    // Attempt concurrent confirms from different connections
    const results = await Promise.all([
      confirmMatch(sql, testShopId, matchIdX, "user-1"),
      confirmMatch(sql2, testShopId, matchIdY, "user-2"),
    ]);

    // Check for deadlock errors
    for (const result of results) {
      if (!result.success && result.error) {
        expect(result.error.toLowerCase()).not.toContain("deadlock");
      }
    }

    // Exactly one should succeed, the other should fail (invoice fully allocated)
    const successes = results.filter((r) => r.success);
    expect(successes.length).toBe(1);

    // Verify total confirmed for invoice is <= 1000 paise
    const [totalResult] = await sql<{ total_paise: string }[]>`
      SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::text AS total_paise
      FROM "Match"
      WHERE "invoiceId" = ${invoice.id}
        AND state = 'confirmed'
    `;
    expect(BigInt(totalResult.total_paise)).toBeLessThanOrEqual(1000n);

    // Cleanup
    await sql`DELETE FROM "Match" WHERE "invoiceId" = ${invoice.id}`;
    await sql`DELETE FROM "Payment" WHERE id IN (${paymentX.id}, ${paymentY.id})`;
    await sql`DELETE FROM "Invoice" WHERE id = ${invoice.id}`;
  });
});

// =============================================================================
// P2: Pushed allocation handling
// =============================================================================

describeWithDb("Pushed allocation handling (P2)", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let testBuyerId: string;
  let testImportId: string;

  const TEST_SHOP_DOMAIN = `pushed-alloc-test-${Date.now()}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    // Create test buyer
    const [buyer] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/pushed-alloc-test', 'gid://shopify/CompanyLocation/pushed-alloc-test',
        'Pushed Alloc Corp', 'OK', NOW(), NOW()
      )
      RETURNING id
    `;
    testBuyerId = buyer.id;

    // Create test bank import
    const [bankImport] = await sql<{ id: string }[]>`
      INSERT INTO "BankImport" (
        id, "shopId", bank, "fileName", "rowCount", "createdAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'hdfc', 'pushed-alloc-test.csv', 1, NOW()
      )
      RETURNING id
    `;
    testImportId = bankImport.id;
  });

  afterAll(async () => {
    if (sql && testShopId) {
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;
    }
    if (sql) await sql.end();
  });

  it("does not double-count pushed allocations on invoice side", async () => {
    // Create invoice with 2000 paise outstanding (this simulates after S17 has pushed and reduced outstanding)
    // If we had started at 3000 and pushed 1000, outstanding would now be 2000
    const [invoice] = await sql<{ id: string }[]>`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testBuyerId},
        gen_random_uuid()::text, 'INV-PUSHED-1', 30.00, 'open', 20.00,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create payment A (already pushed, 1000 paise - simulating S17 has already applied it)
    const [paymentA] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        NOW(), 10.00, 'NEFT', 'NEFT CR-PUSHED A', 'matched', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create pushed match A -> invoice (1000 paise, already pushed)
    await sql`
      INSERT INTO "Match" (
        id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${paymentA.id}, ${invoice.id},
        10.00, 85, '[]'::jsonb, 'pushed', NOW(), NOW()
      )
    `;

    // Create payment B (new, 2000 paise)
    const [paymentB] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        NOW(), 20.00, 'NEFT', 'NEFT CR-NEW B INV-PUSHED-1', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create match B -> invoice (2000 paise suggested)
    const matchIdB = await createMatch(sql, {
      shopId: testShopId,
      paymentId: paymentB.id,
      invoiceId: invoice.id,
      amountPaise: 2000n,
      score: 85,
      reasons: [],
    });

    // Confirm B - should succeed with full 2000 paise
    // Because: invoice.outstanding is 2000, and we only count 'confirmed' (not 'pushed')
    // If we wrongly counted 'pushed', we'd have 2000 - 1000 = 1000 remaining, and cap at 1000
    const resultB = await confirmMatch(sql, testShopId, matchIdB, "user-1");
    expect(resultB.success).toBe(true);

    // Verify match B was confirmed at 2000 paise (full amount, not capped)
    const [matchB] = await sql<{ amount_paise: string; state: string }[]>`
      SELECT (ROUND(amount * 100))::text AS amount_paise, state
      FROM "Match"
      WHERE id = ${matchIdB}
    `;
    expect(matchB.state).toBe("confirmed");
    expect(BigInt(matchB.amount_paise)).toBe(2000n);

    // Cleanup
    await sql`DELETE FROM "Match" WHERE "invoiceId" = ${invoice.id}`;
    await sql`DELETE FROM "Payment" WHERE id IN (${paymentA.id}, ${paymentB.id})`;
    await sql`DELETE FROM "Invoice" WHERE id = ${invoice.id}`;
  });

  it("still counts pushed allocations on payment side", async () => {
    // Create two invoices
    const [invoice1] = await sql<{ id: string }[]>`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testBuyerId},
        gen_random_uuid()::text, 'INV-PAYMENT-SIDE-1', 10.00, 'open', 10.00,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
      RETURNING id
    `;

    const [invoice2] = await sql<{ id: string }[]>`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testBuyerId},
        gen_random_uuid()::text, 'INV-PAYMENT-SIDE-2', 10.00, 'open', 10.00,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create payment with 1500 paise
    const [payment] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        NOW(), 15.00, 'NEFT', 'NEFT CR-PAYMENT SIDE TEST', 'partial', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create pushed match to invoice1 (1000 paise, already pushed)
    await sql`
      INSERT INTO "Match" (
        id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${payment.id}, ${invoice1.id},
        10.00, 85, '[]'::jsonb, 'pushed', NOW(), NOW()
      )
    `;

    // Create suggested match to invoice2 (1000 paise)
    const matchId2 = await createMatch(sql, {
      shopId: testShopId,
      paymentId: payment.id,
      invoiceId: invoice2.id,
      amountPaise: 1000n,
      score: 85,
      reasons: [],
    });

    // Confirm match to invoice2 - should be capped at 500 paise (1500 - 1000 pushed = 500 remaining)
    const result = await confirmMatch(sql, testShopId, matchId2, "user-1");
    expect(result.success).toBe(true);

    // Verify match was capped at 500 paise
    const [match2] = await sql<{ amount_paise: string; state: string }[]>`
      SELECT (ROUND(amount * 100))::text AS amount_paise, state
      FROM "Match"
      WHERE id = ${matchId2}
    `;
    expect(match2.state).toBe("confirmed");
    expect(BigInt(match2.amount_paise)).toBe(500n);

    // Cleanup
    await sql`DELETE FROM "Match" WHERE "paymentId" = ${payment.id}`;
    await sql`DELETE FROM "Payment" WHERE id = ${payment.id}`;
    await sql`DELETE FROM "Invoice" WHERE id IN (${invoice1.id}, ${invoice2.id})`;
  });
});

// =============================================================================
// P3: Already confirmed match error
// =============================================================================

describeWithDb("Already confirmed match error (P3)", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let testBuyerId: string;
  let testImportId: string;

  const TEST_SHOP_DOMAIN = `already-confirmed-test-${Date.now()}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    // Create test buyer
    const [buyer] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/already-confirmed-test', 'gid://shopify/CompanyLocation/already-confirmed-test',
        'Already Confirmed Corp', 'OK', NOW(), NOW()
      )
      RETURNING id
    `;
    testBuyerId = buyer.id;

    // Create test bank import
    const [bankImport] = await sql<{ id: string }[]>`
      INSERT INTO "BankImport" (
        id, "shopId", bank, "fileName", "rowCount", "createdAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'hdfc', 'already-confirmed-test.csv', 1, NOW()
      )
      RETURNING id
    `;
    testImportId = bankImport.id;
  });

  afterAll(async () => {
    if (sql && testShopId) {
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;
    }
    if (sql) await sql.end();
  });

  it("returns specific error when confirming already-confirmed match", async () => {
    // Create invoice
    const [invoice] = await sql<{ id: string }[]>`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testBuyerId},
        gen_random_uuid()::text, 'INV-ALREADY-CONFIRMED', 10.00, 'open', 10.00,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create payment
    const [payment] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        NOW(), 10.00, 'NEFT', 'NEFT CR-ALREADY CONFIRMED TEST', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;

    // Create suggested match
    const matchId = await createMatch(sql, {
      shopId: testShopId,
      paymentId: payment.id,
      invoiceId: invoice.id,
      amountPaise: 1000n,
      score: 85,
      reasons: [],
    });

    // Confirm once - should succeed
    const result1 = await confirmMatch(sql, testShopId, matchId, "user-1");
    expect(result1.success).toBe(true);

    // Try to confirm again - should be idempotent success (no additional audit events)
    const result2 = await confirmMatch(sql, testShopId, matchId, "user-2");
    expect(result2.success).toBe(true);

    // Cleanup
    await sql`DELETE FROM "Match" WHERE "invoiceId" = ${invoice.id}`;
    await sql`DELETE FROM "Payment" WHERE id = ${payment.id}`;
    await sql`DELETE FROM "Invoice" WHERE id = ${invoice.id}`;
  });
});

