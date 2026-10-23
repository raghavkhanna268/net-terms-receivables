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

    // Confirm again - should fail (already confirmed)
    const result2 = await confirmMatch(sql, testShopId, matchId, "test-user");
    expect(result2.success).toBe(false);
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
        id, shop_id, customer_id, email, name, tags, "createdAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'gid://shopify/Customer/pii-test',
        ${TEST_EMAIL}, 'Test Buyer', ARRAY['wholesale']::text[], NOW()
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
