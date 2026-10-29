/**
 * DB integration tests for importId scoping in runMatcher.
 *
 * These tests verify that when runMatcher is called with an importId:
 * 1. Only payments from that import are processed
 * 2. Match rows from other imports remain untouched
 * 3. Cross-shop isolation still applies (importId from another shop processes nothing)
 *
 * Without importId, behavior is unchanged (shop-wide matching).
 *
 * All data is FICTIONAL - synthetic test domains and made-up identifiers.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "../../app/lib/db-light.server.js";
import { runMatcher } from "../../app/services/matcher.server.js";
import { REVIEWER_DEMO_AMOUNTS, REVIEWER_DEMO_BUYER } from "../fixtures/reviewer-demo";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("runMatcher importId scope isolation", () => {
  let sql: ReturnType<typeof postgres>;
  let shopId: string;
  let buyerId: string;
  let importAId: string;
  let importBId: string;
  let _invoiceId: string;

  const runId = Date.now();
  const SHOP_DOMAIN = `test-import-scope-${runId}.myshopify.com`;

  const buyerIdValue = `buyer-import-scope-${runId}`;
  const invoiceIdValue = `invoice-import-scope-${runId}`;
  const importAIdValue = `import-a-${runId}`;
  const importBIdValue = `import-b-${runId}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { ...sqlOptions, onnotice: () => {} });

    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    shopId = shop.id;

    const [buyer] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${buyerIdValue}, ${shopId}, 'COMPANY',
        'gid://shopify/Company/import-scope-test', 'gid://shopify/CompanyLocation/import-scope-test',
        ${REVIEWER_DEMO_BUYER.name}, 100000, 'OK', NOW(), NOW()
      )
      RETURNING id
    `;
    buyerId = buyer.id;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceIdValue}, ${shopId}, ${buyerId},
        'gid://shopify/Order/import-scope-test', '#5001', ${REVIEWER_DEMO_AMOUNTS.order1}, 'open', ${REVIEWER_DEMO_AMOUNTS.order1},
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;
    _invoiceId = invoiceIdValue;
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM "Match" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${shopId}`;
      await sql.end();
    }
  });

  beforeEach(async () => {
    await sql`DELETE FROM "Match" WHERE "shopId" = ${shopId}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${shopId}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${shopId}`;
  });

  async function seedTwoImportsWithPaymentsAndMatches() {
    await sql`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (${importAIdValue}, ${shopId}, 'hdfc', 'import-a.csv', 1, NOW())
    `;
    importAId = importAIdValue;

    await sql`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (${importBIdValue}, ${shopId}, 'hdfc', 'import-b.csv', 1, NOW())
    `;
    importBId = importBIdValue;

    const paymentAId = `payment-a-${runId}`;
    const paymentBId = `payment-b-${runId}`;

    await sql`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, utr, "payerText", narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        ${paymentAId}, ${shopId}, ${importAId},
        '2026-10-22'::date, ${REVIEWER_DEMO_AMOUNTS.order1}, 'NEFT', 'SYNTA001',
        'TEST BUYER CO', 'NEFT-SYNTA001-TEST BUYER CO-#5001', 'unmatched', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, utr, "payerText", narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        ${paymentBId}, ${shopId}, ${importBId},
        '2026-10-23'::date, ${REVIEWER_DEMO_AMOUNTS.order1}, 'UPI', 'SYNTB002',
        'TEST BUYER CO', 'UPI-SYNTB002-TEST BUYER CO-#5001', 'unmatched', NOW(), NOW()
      )
    `;

    await runMatcher(sql, shopId);

    return { paymentAId, paymentBId };
  }

  async function getMatchesForImport(impId: string) {
    return sql<{ id: string; paymentId: string; score: number; amount: string; state: string }[]>`
      SELECT m.id, m."paymentId", m.score, m.amount::text, m.state
      FROM "Match" m
      JOIN "Payment" p ON p.id = m."paymentId"
      WHERE p."importId" = ${impId}
    `;
  }

  it("runMatcher with importId=B leaves import A's matches untouched", async () => {
    const { paymentAId: _paymentAId } = await seedTwoImportsWithPaymentsAndMatches();

    const matchesABefore = await getMatchesForImport(importAId);
    expect(matchesABefore.length).toBeGreaterThan(0);

    const matchASnapshot = matchesABefore.map((m) => ({
      id: m.id,
      paymentId: m.paymentId,
      score: m.score,
      amount: m.amount,
      state: m.state,
    }));

    await runMatcher(sql, shopId, { importId: importBId });

    const matchesAAfter = await getMatchesForImport(importAId);

    expect(matchesAAfter.length).toBe(matchesABefore.length);
    for (let i = 0; i < matchASnapshot.length; i++) {
      expect(matchesAAfter[i].id).toBe(matchASnapshot[i].id);
      expect(matchesAAfter[i].paymentId).toBe(matchASnapshot[i].paymentId);
      expect(matchesAAfter[i].score).toBe(matchASnapshot[i].score);
      expect(matchesAAfter[i].amount).toBe(matchASnapshot[i].amount);
      expect(matchesAAfter[i].state).toBe(matchASnapshot[i].state);
    }
  });

  it("runMatcher with importId processes only that import's payments", async () => {
    await seedTwoImportsWithPaymentsAndMatches();

    const matchesBBefore = await getMatchesForImport(importBId);
    const matchBIds = new Set(matchesBBefore.map((m) => m.id));

    const result = await runMatcher(sql, shopId, { importId: importBId });

    expect(result.paymentsProcessed).toBe(1);

    const matchesBAfter = await getMatchesForImport(importBId);
    expect(matchesBAfter.length).toBeGreaterThan(0);

    for (const m of matchesBAfter) {
      expect(matchBIds.has(m.id)).toBe(false);
    }
  });

  it("runMatcher without importId processes both imports (shop-wide behavior)", async () => {
    await sql`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (${importAIdValue}, ${shopId}, 'hdfc', 'import-a.csv', 1, NOW())
    `;
    importAId = importAIdValue;

    await sql`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (${importBIdValue}, ${shopId}, 'hdfc', 'import-b.csv', 1, NOW())
    `;
    importBId = importBIdValue;

    const paymentAId = `payment-a-noscope-${runId}`;
    const paymentBId = `payment-b-noscope-${runId}`;

    await sql`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, utr, "payerText", narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        ${paymentAId}, ${shopId}, ${importAId},
        '2026-10-22'::date, ${REVIEWER_DEMO_AMOUNTS.order1}, 'NEFT', 'SYNTANOSCOPE',
        'TEST BUYER CO', 'NEFT-SYNTANOSCOPE-TEST BUYER CO-#5001', 'unmatched', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, utr, "payerText", narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        ${paymentBId}, ${shopId}, ${importBId},
        '2026-10-23'::date, ${REVIEWER_DEMO_AMOUNTS.order1}, 'UPI', 'SYNTBNOSCOPE',
        'TEST BUYER CO', 'UPI-SYNTBNOSCOPE-TEST BUYER CO-#5001', 'unmatched', NOW(), NOW()
      )
    `;

    const result = await runMatcher(sql, shopId);

    expect(result.paymentsProcessed).toBe(2);

    const matchesA = await getMatchesForImport(importAId);
    const matchesB = await getMatchesForImport(importBId);
    expect(matchesA.length).toBeGreaterThan(0);
    expect(matchesB.length).toBeGreaterThan(0);
  });
});

describeWithDb("runMatcher cross-shop importId isolation", () => {
  let sql: ReturnType<typeof postgres>;
  let shopAId: string;
  let shopBId: string;
  let importIdFromShopA: string;

  const runId = Date.now();
  const SHOP_A_DOMAIN = `test-cross-shop-a-${runId}.myshopify.com`;
  const SHOP_B_DOMAIN = `test-cross-shop-b-${runId}.myshopify.com`;

  const buyerAIdValue = `buyer-cross-a-${runId}`;
  const buyerBIdValue = `buyer-cross-b-${runId}`;
  const invoiceAIdValue = `invoice-cross-a-${runId}`;
  const invoiceBIdValue = `invoice-cross-b-${runId}`;
  const importAIdValue = `import-cross-a-${runId}`;
  const importBIdValue = `import-cross-b-${runId}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { ...sqlOptions, onnotice: () => {} });

    const [shopA] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${SHOP_A_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    shopAId = shopA.id;

    const [shopB] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${SHOP_B_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    shopBId = shopB.id;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${buyerAIdValue}, ${shopAId}, 'COMPANY',
        'gid://shopify/Company/cross-a', 'gid://shopify/CompanyLocation/cross-a',
        ${REVIEWER_DEMO_BUYER.name}, 100000, 'OK', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${buyerBIdValue}, ${shopBId}, 'COMPANY',
        'gid://shopify/Company/cross-b', 'gid://shopify/CompanyLocation/cross-b',
        ${REVIEWER_DEMO_BUYER.name}, 100000, 'OK', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceAIdValue}, ${shopAId}, ${buyerAIdValue},
        'gid://shopify/Order/cross-a', '#6001', ${REVIEWER_DEMO_AMOUNTS.order1}, 'open', ${REVIEWER_DEMO_AMOUNTS.order1},
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceBIdValue}, ${shopBId}, ${buyerBIdValue},
        'gid://shopify/Order/cross-b', '#6002', ${REVIEWER_DEMO_AMOUNTS.order1}, 'open', ${REVIEWER_DEMO_AMOUNTS.order1},
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (${importAIdValue}, ${shopAId}, 'hdfc', 'shop-a-import.csv', 1, NOW())
    `;
    importIdFromShopA = importAIdValue;

    await sql`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (${importBIdValue}, ${shopBId}, 'hdfc', 'shop-b-import.csv', 1, NOW())
    `;

    const paymentBId = `payment-cross-b-${runId}`;
    await sql`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, utr, "payerText", narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        ${paymentBId}, ${shopBId}, ${importBIdValue},
        '2026-10-23'::date, ${REVIEWER_DEMO_AMOUNTS.order1}, 'UPI', 'SYNTCROSSB',
        'TEST BUYER CO', 'UPI-SYNTCROSSB-TEST BUYER CO-#6002', 'unmatched', NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM "Match" WHERE "shopId" IN (${shopAId}, ${shopBId})`;
      await sql`DELETE FROM "Payment" WHERE "shopId" IN (${shopAId}, ${shopBId})`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" IN (${shopAId}, ${shopBId})`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" IN (${shopAId}, ${shopBId})`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (${shopAId}, ${shopBId})`;
      await sql`DELETE FROM "Shop" WHERE id IN (${shopAId}, ${shopBId})`;
      await sql.end();
    }
  });

  it("runMatcher on shopB with importId from shopA processes nothing", async () => {
    const result = await runMatcher(sql, shopBId, { importId: importIdFromShopA });

    expect(result.paymentsProcessed).toBe(0);
    expect(result.matchesCreated).toBe(0);

    const matches = await sql<{ id: string }[]>`
      SELECT m.id FROM "Match" m WHERE m."shopId" = ${shopBId}
    `;
    expect(matches.length).toBe(0);
  });

  it("runMatcher on shopB without importId still processes shopB payments", async () => {
    const result = await runMatcher(sql, shopBId);

    expect(result.paymentsProcessed).toBe(1);
    expect(result.matchesCreated).toBeGreaterThan(0);
  });
});
