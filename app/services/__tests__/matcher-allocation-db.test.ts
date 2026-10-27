/**
 * DB-backed tests for updateMatchAllocation IN-list query behavior.
 *
 * Tests the `IN ${tx(invoiceIds)}` query path in updateMatchAllocation
 * (matcher.server.ts ~:792) to verify:
 * - Multi-invoice allocation updates exactly the listed invoices
 * - Invoice not in the list is unchanged
 *
 * Uses the shared sqlOptions (fetch_types:false) to exercise the real query behavior.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("updateMatchAllocation IN-list query (DB-backed)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = `match-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const TEST_SHOP_ID = `shop-match-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-match-${TEST_SUFFIX}.example.com`;
  const TEST_ACCOUNT_ID = `acc-match-${TEST_SUFFIX}`;
  const TEST_IMPORT_ID = `import-match-${TEST_SUFFIX}`;
  const TEST_PAYMENT_ID = `pmt-match-${TEST_SUFFIX}`;

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
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-match-" + TEST_SUFFIX}, ${"loc-match-" + TEST_SUFFIX},
        'Test Buyer', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (${TEST_IMPORT_ID}, ${TEST_SHOP_ID}, 'mapped', 'test.csv', 1, NOW())
    `;

    await sql`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, narration, status, "createdAt", "updatedAt"
      ) VALUES (
        ${TEST_PAYMENT_ID}, ${TEST_SHOP_ID}, ${TEST_IMPORT_ID},
        NOW(), 100000.00, 'Test payment for matcher', 'matched', NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "Match" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;

    await sql.end();
  });

  afterEach(async () => {
    await sql`DELETE FROM "Match" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
  });

  it("multi-invoice allocation updates exactly the listed invoices", async () => {
    const { updateMatchAllocation } = await import("../matcher.server");

    const invoice1Id = `inv-multi1-${TEST_SUFFIX}`;
    const invoice2Id = `inv-multi2-${TEST_SUFFIX}`;
    const order1Id = `gid://shopify/Order/multi1-${TEST_SUFFIX}`;
    const order2Id = `gid://shopify/Order/multi2-${TEST_SUFFIX}`;
    const match1Id = `match-multi1-${TEST_SUFFIX}`;
    const match2Id = `match-multi2-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "createdAt", "updatedAt"
      ) VALUES
        (${invoice1Id}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${order1Id},
         '#MULTI-1', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW()),
        (${invoice2Id}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${order2Id},
         '#MULTI-2', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW())
    `;

    await sql`
      INSERT INTO "Match" (
        id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state,
        "createdAt", "updatedAt"
      ) VALUES
        (${match1Id}, ${TEST_SHOP_ID}, ${TEST_PAYMENT_ID}, ${invoice1Id},
         30000.00, 85, '{"test":true}'::jsonb, 'suggested', NOW(), NOW()),
        (${match2Id}, ${TEST_SHOP_ID}, ${TEST_PAYMENT_ID}, ${invoice2Id},
         20000.00, 80, '{"test":true}'::jsonb, 'suggested', NOW(), NOW())
    `;

    const result = await updateMatchAllocation(sql, TEST_SHOP_ID, match1Id, 40000n);

    expect(result.success).toBe(true);

    const [updatedMatch] = await sql<{ amount: string }[]>`
      SELECT amount::text FROM "Match" WHERE id = ${match1Id}
    `;
    expect(updatedMatch.amount).toBe("400.00");

    const [otherMatch] = await sql<{ amount: string }[]>`
      SELECT amount::text FROM "Match" WHERE id = ${match2Id}
    `;
    expect(otherMatch.amount).toBe("20000.00");
  });

  it("invoice not in the allocation list is unchanged", async () => {
    const { updateMatchAllocation } = await import("../matcher.server");

    const invoiceInListId = `inv-inlist-${TEST_SUFFIX}`;
    const invoiceOutListId = `inv-outlist-${TEST_SUFFIX}`;
    const orderInListId = `gid://shopify/Order/inlist-${TEST_SUFFIX}`;
    const orderOutListId = `gid://shopify/Order/outlist-${TEST_SUFFIX}`;
    const matchInListId = `match-inlist-${TEST_SUFFIX}`;

    const separatePaymentId = `pmt-sep-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, narration, status, "createdAt", "updatedAt"
      ) VALUES (
        ${separatePaymentId}, ${TEST_SHOP_ID}, ${TEST_IMPORT_ID},
        NOW(), 50000.00, 'Separate payment', 'matched', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "createdAt", "updatedAt"
      ) VALUES
        (${invoiceInListId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderInListId},
         '#INLIST', 30000.00, 30000.00, 'open', NOW(), NOW(), NOW()),
        (${invoiceOutListId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderOutListId},
         '#OUTLIST', 40000.00, 40000.00, 'open', NOW(), NOW(), NOW())
    `;

    await sql`
      INSERT INTO "Match" (
        id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state,
        "createdAt", "updatedAt"
      ) VALUES
        (${matchInListId}, ${TEST_SHOP_ID}, ${TEST_PAYMENT_ID}, ${invoiceInListId},
         25000.00, 90, '{"test":true}'::jsonb, 'suggested', NOW(), NOW())
    `;

    const [invoiceOutBefore] = await sql<{ outstanding: string }[]>`
      SELECT outstanding::text FROM "Invoice" WHERE id = ${invoiceOutListId}
    `;
    expect(invoiceOutBefore.outstanding).toBe("40000.00");

    const result = await updateMatchAllocation(sql, TEST_SHOP_ID, matchInListId, 20000n);

    expect(result.success).toBe(true);

    const [invoiceOutAfter] = await sql<{ outstanding: string }[]>`
      SELECT outstanding::text FROM "Invoice" WHERE id = ${invoiceOutListId}
    `;
    expect(invoiceOutAfter.outstanding).toBe("40000.00");

    const [updatedMatch] = await sql<{ amount: string }[]>`
      SELECT amount::text FROM "Match" WHERE id = ${matchInListId}
    `;
    expect(updatedMatch.amount).toBe("200.00");

    await sql`DELETE FROM "Payment" WHERE id = ${separatePaymentId}`;
  });

  it("allocation update caps at invoice remaining amount", async () => {
    const { updateMatchAllocation } = await import("../matcher.server");

    const invoiceId = `inv-cap-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/cap-${TEST_SUFFIX}`;
    const matchId = `match-cap-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "createdAt", "updatedAt"
      ) VALUES
        (${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
         '#CAP', 10000.00, 10000.00, 'open', NOW(), NOW(), NOW())
    `;

    await sql`
      INSERT INTO "Match" (
        id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state,
        "createdAt", "updatedAt"
      ) VALUES
        (${matchId}, ${TEST_SHOP_ID}, ${TEST_PAYMENT_ID}, ${invoiceId},
         5000.00, 85, '{"test":true}'::jsonb, 'suggested', NOW(), NOW())
    `;

    const result = await updateMatchAllocation(sql, TEST_SHOP_ID, matchId, 2000000n);

    expect(result.success).toBe(true);

    const [finalMatch] = await sql<{ amount: string }[]>`
      SELECT amount::text FROM "Match" WHERE id = ${matchId}
    `;
    expect(finalMatch.amount).toBe("10000.00");
  });

  it("cross-payment confirmed/pushing matches reduce available allocation", async () => {
    const { updateMatchAllocation } = await import("../matcher.server");

    const invoiceId = `inv-xpay-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/xpay-${TEST_SUFFIX}`;
    
    const payment2Id = `pmt-xpay2-${TEST_SUFFIX}`;
    const payment3Id = `pmt-xpay3-${TEST_SUFFIX}`;
    
    const matchSuggestedId = `match-xpay-sugg-${TEST_SUFFIX}`;
    const matchConfirmedId = `match-xpay-conf-${TEST_SUFFIX}`;
    const matchPushingId = `match-xpay-push-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, narration, status, "createdAt", "updatedAt"
      ) VALUES
        (${payment2Id}, ${TEST_SHOP_ID}, ${TEST_IMPORT_ID},
         NOW(), 50000.00, 'Payment 2 for cross-payment test', 'matched', NOW(), NOW()),
        (${payment3Id}, ${TEST_SHOP_ID}, ${TEST_IMPORT_ID},
         NOW(), 50000.00, 'Payment 3 for cross-payment test', 'matched', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "createdAt", "updatedAt"
      ) VALUES
        (${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
         '#XPAY', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW())
    `;

    await sql`
      INSERT INTO "Match" (
        id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state,
        "createdAt", "updatedAt"
      ) VALUES
        (${matchSuggestedId}, ${TEST_SHOP_ID}, ${TEST_PAYMENT_ID}, ${invoiceId},
         10000.00, 85, '{"test":true}'::jsonb, 'suggested', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "Match" (
        id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state,
        "confirmedBy", "confirmedAt", "createdAt", "updatedAt"
      ) VALUES
        (${matchConfirmedId}, ${TEST_SHOP_ID}, ${payment2Id}, ${invoiceId},
         20000.00, 90, '{"test":true}'::jsonb, 'confirmed', 'user-1', NOW(), NOW(), NOW())
    `;

    await sql`
      INSERT INTO "Match" (
        id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state,
        "createdAt", "updatedAt"
      ) VALUES
        (${matchPushingId}, ${TEST_SHOP_ID}, ${payment3Id}, ${invoiceId},
         15000.00, 88, '{"test":true}'::jsonb, 'pushing', NOW(), NOW())
    `;

    const result = await updateMatchAllocation(sql, TEST_SHOP_ID, matchSuggestedId, 5000000n);

    expect(result.success).toBe(true);

    const [finalMatch] = await sql<{ amount: string }[]>`
      SELECT amount::text FROM "Match" WHERE id = ${matchSuggestedId}
    `;
    expect(finalMatch.amount).toBe("15000.00");

    const [confMatch] = await sql<{ amount: string }[]>`
      SELECT amount::text FROM "Match" WHERE id = ${matchConfirmedId}
    `;
    expect(confMatch.amount).toBe("20000.00");

    const [pushMatch] = await sql<{ amount: string }[]>`
      SELECT amount::text FROM "Match" WHERE id = ${matchPushingId}
    `;
    expect(pushMatch.amount).toBe("15000.00");

    await sql`DELETE FROM "Match" WHERE "paymentId" IN ${sql([payment2Id, payment3Id])}`;
    await sql`DELETE FROM "Payment" WHERE id IN ${sql([payment2Id, payment3Id])}`;
  });

  it("non-existent match returns error", async () => {
    const { updateMatchAllocation } = await import("../matcher.server");

    const result = await updateMatchAllocation(
      sql,
      TEST_SHOP_ID,
      `nonexistent-${TEST_SUFFIX}`,
      10000n
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("already confirmed match cannot be updated", async () => {
    const { updateMatchAllocation } = await import("../matcher.server");

    const invoiceId = `inv-conf-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/conf-${TEST_SUFFIX}`;
    const matchId = `match-conf-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "createdAt", "updatedAt"
      ) VALUES
        (${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
         '#CONF', 20000.00, 20000.00, 'open', NOW(), NOW(), NOW())
    `;

    await sql`
      INSERT INTO "Match" (
        id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state,
        "confirmedBy", "confirmedAt", "createdAt", "updatedAt"
      ) VALUES
        (${matchId}, ${TEST_SHOP_ID}, ${TEST_PAYMENT_ID}, ${invoiceId},
         15000.00, 95, '{"test":true}'::jsonb, 'confirmed', 'user-1', NOW(), NOW(), NOW())
    `;

    const result = await updateMatchAllocation(sql, TEST_SHOP_ID, matchId, 10000n);

    expect(result.success).toBe(false);
    expect(result.error).toContain("not suggested");
  });

  it("multiple invoices for same payment: only target invoice match is updated", async () => {
    const { updateMatchAllocation } = await import("../matcher.server");

    const invoice1Id = `inv-mip1-${TEST_SUFFIX}`;
    const invoice2Id = `inv-mip2-${TEST_SUFFIX}`;
    const invoice3Id = `inv-mip3-${TEST_SUFFIX}`;
    const order1Id = `gid://shopify/Order/mip1-${TEST_SUFFIX}`;
    const order2Id = `gid://shopify/Order/mip2-${TEST_SUFFIX}`;
    const order3Id = `gid://shopify/Order/mip3-${TEST_SUFFIX}`;
    const match1Id = `match-mip1-${TEST_SUFFIX}`;
    const match2Id = `match-mip2-${TEST_SUFFIX}`;
    const match3Id = `match-mip3-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "createdAt", "updatedAt"
      ) VALUES
        (${invoice1Id}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${order1Id},
         '#MIP-1', 30000.00, 30000.00, 'open', NOW(), NOW(), NOW()),
        (${invoice2Id}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${order2Id},
         '#MIP-2', 30000.00, 30000.00, 'open', NOW(), NOW(), NOW()),
        (${invoice3Id}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${order3Id},
         '#MIP-3', 40000.00, 40000.00, 'open', NOW(), NOW(), NOW())
    `;

    await sql`
      INSERT INTO "Match" (
        id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state,
        "createdAt", "updatedAt"
      ) VALUES
        (${match1Id}, ${TEST_SHOP_ID}, ${TEST_PAYMENT_ID}, ${invoice1Id},
         20000.00, 85, '{"test":true}'::jsonb, 'suggested', NOW(), NOW()),
        (${match2Id}, ${TEST_SHOP_ID}, ${TEST_PAYMENT_ID}, ${invoice2Id},
         20000.00, 80, '{"test":true}'::jsonb, 'suggested', NOW(), NOW()),
        (${match3Id}, ${TEST_SHOP_ID}, ${TEST_PAYMENT_ID}, ${invoice3Id},
         20000.00, 75, '{"test":true}'::jsonb, 'suggested', NOW(), NOW())
    `;

    const [match1Before] = await sql<{ amount: string }[]>`
      SELECT amount::text FROM "Match" WHERE id = ${match1Id}
    `;
    const [match2Before] = await sql<{ amount: string }[]>`
      SELECT amount::text FROM "Match" WHERE id = ${match2Id}
    `;
    const [match3Before] = await sql<{ amount: string }[]>`
      SELECT amount::text FROM "Match" WHERE id = ${match3Id}
    `;

    expect(match1Before.amount).toBe("20000.00");
    expect(match2Before.amount).toBe("20000.00");
    expect(match3Before.amount).toBe("20000.00");

    const result = await updateMatchAllocation(sql, TEST_SHOP_ID, match2Id, 25000n);

    expect(result.success).toBe(true);

    const [match1After] = await sql<{ amount: string }[]>`
      SELECT amount::text FROM "Match" WHERE id = ${match1Id}
    `;
    const [match2After] = await sql<{ amount: string }[]>`
      SELECT amount::text FROM "Match" WHERE id = ${match2Id}
    `;
    const [match3After] = await sql<{ amount: string }[]>`
      SELECT amount::text FROM "Match" WHERE id = ${match3Id}
    `;

    expect(match1After.amount).toBe("20000.00");
    expect(match2After.amount).toBe("250.00");
    expect(match3After.amount).toBe("20000.00");
  });
});
