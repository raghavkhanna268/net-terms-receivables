/**
 * DB integration test: Confirm-only bank reconcile flow end-to-end.
 *
 * Tests the REAL functions and route actions for:
 * - Bank upload/import (HDFC and ICICI shapes)
 * - Suggestion/matching service
 * - Confirm / unconfirm / reject actions
 *
 * All data is FICTIONAL with test-* names and example.com emails.
 * NEVER reads real bank statements from /workspace/bank-samples.
 *
 * This test uses the "Sequential DB" project via the *-db.test.ts naming pattern.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import postgres from "postgres";
import { sqlOptions } from "../../app/lib/db-light.server.js";
import {
  runMatcher,
  confirmMatch,
  rejectMatch,
} from "../../app/services/matcher.server.js";
import { applyMatch, unmatchMatch } from "../../app/services/apply.server.js";
import { insertBankImportRows } from "../../app/services/bank-import.server.js";
import { assertNoQueueLeftovers } from "../helpers/queue-leftovers.js";
import * as logModule from "../../app/lib/log.server.js";

// Mock enqueueRecomputeForInvoice (a collaborator, not the code under test).
// Note: This means assertNoQueueLeftovers cannot catch recompute queue issues in this file.
vi.mock("../../app/services/credit-status-recompute.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    enqueueRecomputeForInvoice: vi.fn().mockResolvedValue(undefined),
  };
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

function makeValidNeftUtr(suffix: string): string {
  const paddedSuffix = suffix.replace(/[^0-9]/g, "").padStart(11, "0").slice(0, 11);
  return `HDFCN${paddedSuffix}`;
}

function getUtcDateString(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

interface SyntheticCredit {
  date: string;
  amountPaise: number;
  rail: string;
  utr: string;
  payerName: string;
  narration: string;
}

function makeHdfcCredits(runId: number): SyntheticCredit[] {
  const uniqueSuffix = Math.floor(Math.random() * 100000);
  return [
    {
      date: getUtcDateString(5),
      amountPaise: 1000000,
      rail: "NEFT",
      utr: `HDFCN${String(runId).slice(-6)}${String(uniqueSuffix).padStart(5, "0")}`,
      payerName: "Test Fake Buyer Ltd",
      narration: `NEFT CR-SYNT${runId}01-TEST FAKE BUYER LTD-#1001`,
    },
    {
      date: getUtcDateString(4),
      amountPaise: 500000,
      rail: "NEFT",
      utr: `HDFCN${String(runId).slice(-6)}${String(uniqueSuffix + 1).padStart(5, "0")}`,
      payerName: "Test Fake Buyer Ltd",
      narration: `NEFT CR-TEST FAKE BUYER LTD-#1002`,
    },
  ];
}

function makeIciciCredits(runId: number): SyntheticCredit[] {
  return [
    {
      date: getUtcDateString(5),
      amountPaise: 1000000,
      rail: "IMPS",
      utr: `${runId}30000001`,
      payerName: "Demo Corp Example",
      narration: `IMPS/P2A/${runId}30000001/DEMO CORP EXAMPLE/#1001`,
    },
    {
      date: getUtcDateString(4),
      amountPaise: 500000,
      rail: "IMPS",
      utr: `${runId}30000002`,
      payerName: "Demo Corp Example",
      narration: `IMPS/P2A/${runId}30000002/DEMO CORP EXAMPLE/#1002`,
    },
  ];
}

describeWithDb("Confirm-only bank reconcile flow: DB integration", () => {
  let sql: ReturnType<typeof postgres>;
  let logSpy: MockInstance<typeof logModule.safeLog>;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { ...sqlOptions, onnotice: () => {} });
    logSpy = vi.spyOn(logModule, "safeLog");
  });

  afterAll(async () => {
    if (sql) {
      await sql.end();
    }
    vi.restoreAllMocks();
  });

  describe("1. Happy path: HDFC bank shape", () => {
    const runId = Date.now();
    const TEST_SHOP_DOMAIN = `test-hdfc-happy-${runId}.myshopify.com`;
    let testShopId: string;
    let testBuyerId: string;
    const invoice1Id = `invoice-hdfc-1-${runId}`;
    const invoice2Id = `invoice-hdfc-2-${runId}`;

    beforeAll(async () => {
      const [shop] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
        RETURNING id
      `;
      testShopId = shop.id;

      const buyerId = `buyer-hdfc-${runId}`;
      const [buyer] = await sql<{ id: string }[]>`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "holdState", "createdAt", "updatedAt"
        )
        VALUES (
          ${buyerId}, ${testShopId}, 'COMPANY',
          ${"gid://shopify/Company/hdfc-" + runId},
          ${"gid://shopify/CompanyLocation/hdfc-" + runId},
          'Test Fake Buyer Ltd', 100000, 'OK', NOW(), NOW()
        )
        RETURNING id
      `;
      testBuyerId = buyer.id;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
          "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoice1Id}, ${testShopId}, ${testBuyerId},
          ${"gid://shopify/Order/hdfc-1001-" + runId}, '#1001', 10000, 'open', 10000,
          NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
          "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoice2Id}, ${testShopId}, ${testBuyerId},
          ${"gid://shopify/Order/hdfc-1002-" + runId}, '#1002', 5000, 'open', 5000,
          NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
        )
      `;
    });

    afterEach(async () => {
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerId}`;
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;

      await sql`
        UPDATE "Invoice"
        SET outstanding = total, status = 'open', "updatedAt" = NOW()
        WHERE "shopId" = ${testShopId}
      `;
    });

    afterAll(async () => {
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerId}`;
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;

      await assertNoQueueLeftovers(sql, [TEST_SHOP_DOMAIN], "confirm-only-reconcile-db.test.ts:hdfc");
    });

    it("HDFC: upload, suggestions, confirm match - invoice outstanding unchanged (confirm-only), match amount 10000", async () => {
      const credits = makeHdfcCredits(runId);

      const importResult = await sql.begin((tx) =>
        insertBankImportRows(tx, {
          shopId: testShopId,
          bank: "HDFC",
          fileName: "test-hdfc-synthetic.csv",
          credits,
          now: new Date(),
        })
      );

      expect(importResult.inserted).toBe(2);
      expect(importResult.duplicates).toBe(0);

      const matcherResult = await runMatcher(sql, testShopId);
      expect(matcherResult.paymentsProcessed).toBe(2);
      expect(matcherResult.matchesCreated).toBeGreaterThan(0);

      const suggestedMatches = await sql<{ id: string; invoice_id: string; score: number }[]>`
        SELECT id, "invoiceId" AS invoice_id, score
        FROM "Match"
        WHERE "shopId" = ${testShopId} AND state = 'suggested'
        ORDER BY score DESC
      `;
      expect(suggestedMatches.length).toBeGreaterThan(0);

      const matchToConfirm = suggestedMatches.find((m) => m.invoice_id === invoice1Id);
      expect(matchToConfirm).toBeDefined();

      const confirmResult = await confirmMatch(sql, testShopId, matchToConfirm!.id, "test-user");
      expect(confirmResult.success).toBe(true);

      const [confirmedMatch] = await sql<{ state: string; amount: string }[]>`
        SELECT state, amount::text FROM "Match" WHERE id = ${matchToConfirm!.id}
      `;
      expect(confirmedMatch.state).toBe("confirmed");
      expect(parseFloat(confirmedMatch.amount)).toBe(10000);

      const [invoiceAfter] = await sql<{ outstanding: string; status: string }[]>`
        SELECT outstanding::text, status FROM "Invoice" WHERE id = ${invoice1Id}
      `;
      expect(parseFloat(invoiceAfter.outstanding)).toBe(10000);
      expect(invoiceAfter.status).toBe("open");

      const matchCount = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "Match"
        WHERE "shopId" = ${testShopId} AND "invoiceId" = ${invoice1Id} AND state = 'confirmed'
      `;
      expect(parseInt(matchCount[0].count, 10)).toBe(1);
    });
  });

  describe("1b. Happy path: ICICI bank shape", () => {
    const runId = Date.now() + 1;
    const TEST_SHOP_DOMAIN = `test-icici-happy-${runId}.myshopify.com`;
    let testShopId: string;
    let testBuyerId: string;
    const invoice1Id = `invoice-icici-1-${runId}`;
    const invoice2Id = `invoice-icici-2-${runId}`;

    beforeAll(async () => {
      const [shop] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
        RETURNING id
      `;
      testShopId = shop.id;

      const buyerId = `buyer-icici-${runId}`;
      const [buyer] = await sql<{ id: string }[]>`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "holdState", "createdAt", "updatedAt"
        )
        VALUES (
          ${buyerId}, ${testShopId}, 'COMPANY',
          ${"gid://shopify/Company/icici-" + runId},
          ${"gid://shopify/CompanyLocation/icici-" + runId},
          'Demo Corp Example', 100000, 'OK', NOW(), NOW()
        )
        RETURNING id
      `;
      testBuyerId = buyer.id;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
          "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoice1Id}, ${testShopId}, ${testBuyerId},
          ${"gid://shopify/Order/icici-1001-" + runId}, '#1001', 10000, 'open', 10000,
          NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
          "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoice2Id}, ${testShopId}, ${testBuyerId},
          ${"gid://shopify/Order/icici-1002-" + runId}, '#1002', 5000, 'open', 5000,
          NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
        )
      `;
    });

    afterEach(async () => {
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerId}`;
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;

      await sql`
        UPDATE "Invoice"
        SET outstanding = total, status = 'open', "updatedAt" = NOW()
        WHERE "shopId" = ${testShopId}
      `;
    });

    afterAll(async () => {
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerId}`;
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;

      await assertNoQueueLeftovers(sql, [TEST_SHOP_DOMAIN], "confirm-only-reconcile-db.test.ts:icici");
    });

    it("ICICI: upload, suggestions, confirm match - invoice outstanding unchanged (confirm-only), match amount 10000", async () => {
      const credits = makeIciciCredits(runId);

      const importResult = await sql.begin((tx) =>
        insertBankImportRows(tx, {
          shopId: testShopId,
          bank: "ICICI",
          fileName: "test-icici-synthetic.csv",
          credits,
          now: new Date(),
        })
      );

      expect(importResult.inserted).toBe(2);

      const matcherResult = await runMatcher(sql, testShopId);
      expect(matcherResult.paymentsProcessed).toBe(2);
      expect(matcherResult.matchesCreated).toBeGreaterThan(0);

      const suggestedMatches = await sql<{ id: string; invoice_id: string }[]>`
        SELECT id, "invoiceId" AS invoice_id
        FROM "Match"
        WHERE "shopId" = ${testShopId} AND state = 'suggested'
        ORDER BY score DESC
      `;
      expect(suggestedMatches.length).toBeGreaterThan(0);

      const matchToConfirm = suggestedMatches.find((m) => m.invoice_id === invoice1Id);
      expect(matchToConfirm).toBeDefined();

      const confirmResult = await confirmMatch(sql, testShopId, matchToConfirm!.id, "test-user");
      expect(confirmResult.success).toBe(true);

      const [confirmedMatch] = await sql<{ state: string; amount: string }[]>`
        SELECT state, amount::text FROM "Match" WHERE id = ${matchToConfirm!.id}
      `;
      expect(confirmedMatch.state).toBe("confirmed");
      expect(parseFloat(confirmedMatch.amount)).toBe(10000);

      const [invoiceAfter] = await sql<{ outstanding: string; status: string }[]>`
        SELECT outstanding::text, status FROM "Invoice" WHERE id = ${invoice1Id}
      `;
      expect(parseFloat(invoiceAfter.outstanding)).toBe(10000);
      expect(invoiceAfter.status).toBe("open");

      const matchCount = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "Match"
        WHERE "shopId" = ${testShopId} AND "invoiceId" = ${invoice1Id} AND state = 'confirmed'
      `;
      expect(parseInt(matchCount[0].count, 10)).toBe(1);
    });
  });

  describe("2. Double confirm of same suggestion is idempotent", () => {
    const runId = Date.now() + 2;
    const TEST_SHOP_DOMAIN = `test-idempotent-${runId}.myshopify.com`;
    let testShopId: string;
    let testBuyerId: string;
    const invoice1Id = `invoice-idemp-1-${runId}`;

    beforeAll(async () => {
      const [shop] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
        RETURNING id
      `;
      testShopId = shop.id;

      const buyerId = `buyer-idemp-${runId}`;
      const [buyer] = await sql<{ id: string }[]>`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "holdState", "createdAt", "updatedAt"
        )
        VALUES (
          ${buyerId}, ${testShopId}, 'COMPANY',
          ${"gid://shopify/Company/idemp-" + runId},
          ${"gid://shopify/CompanyLocation/idemp-" + runId},
          'Test Idempotent Co', 100000, 'OK', NOW(), NOW()
        )
        RETURNING id
      `;
      testBuyerId = buyer.id;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
          "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoice1Id}, ${testShopId}, ${testBuyerId},
          ${"gid://shopify/Order/idemp-1001-" + runId}, '#1001', 10000, 'open', 10000,
          NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
        )
      `;
    });

    afterEach(async () => {
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerId}`;
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;

      await sql`
        UPDATE "Invoice"
        SET outstanding = total, status = 'open', "updatedAt" = NOW()
        WHERE "shopId" = ${testShopId}
      `;
    });

    afterAll(async () => {
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerId}`;
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;

      await assertNoQueueLeftovers(sql, [TEST_SHOP_DOMAIN], "confirm-only-reconcile-db.test.ts:idempotent");
    });

    it("double confirm: exactly 1 AuditEvent, match amount 10000, invoice outstanding unchanged at 10000", async () => {
      const credits: SyntheticCredit[] = [
        {
          date: getUtcDateString(5),
          amountPaise: 1000000,
          rail: "NEFT",
          utr: makeValidNeftUtr(`${runId}10`),
          payerName: "Test Idempotent Co",
          narration: `NEFT CR-TEST IDEMPOTENT CO-#1001`,
        },
      ];

      await sql.begin((tx) =>
        insertBankImportRows(tx, {
          shopId: testShopId,
          bank: "HDFC",
          fileName: "test-idempotent.csv",
          credits,
          now: new Date(),
        })
      );

      await runMatcher(sql, testShopId);

      const [match] = await sql<{ id: string }[]>`
        SELECT id FROM "Match"
        WHERE "shopId" = ${testShopId} AND "invoiceId" = ${invoice1Id} AND state = 'suggested'
      `;
      expect(match).toBeDefined();

      const result1 = await confirmMatch(sql, testShopId, match.id, "test-user");
      expect(result1.success).toBe(true);

      const result2 = await confirmMatch(sql, testShopId, match.id, "test-user");
      expect(result2.success).toBe(true);

      const auditEvents = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "AuditEvent"
        WHERE "shopId" = ${testShopId} AND type = 'match.confirmed'
      `;
      expect(parseInt(auditEvents[0].count, 10)).toBe(1);

      const [confirmedMatch] = await sql<{ amount: string }[]>`
        SELECT amount::text FROM "Match"
        WHERE "shopId" = ${testShopId} AND "invoiceId" = ${invoice1Id}
          AND state IN ('confirmed', 'pushed')
      `;
      expect(parseFloat(confirmedMatch.amount)).toBe(10000);

      const [invoice] = await sql<{ outstanding: string; status: string }[]>`
        SELECT outstanding::text, status FROM "Invoice" WHERE id = ${invoice1Id}
      `;
      expect(parseFloat(invoice.outstanding)).toBe(10000);
      expect(invoice.status).toBe("open");
    });
  });

  describe("3. Two concurrent confirms on same statement line", () => {
    const runId = Date.now() + 3;
    const TEST_SHOP_DOMAIN = `test-concurrent-${runId}.myshopify.com`;
    let testShopId: string;
    let testBuyerId: string;
    const invoice1Id = `invoice-conc-1-${runId}`;
    const invoice2Id = `invoice-conc-2-${runId}`;

    beforeAll(async () => {
      const [shop] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
        RETURNING id
      `;
      testShopId = shop.id;

      const buyerId = `buyer-conc-${runId}`;
      const [buyer] = await sql<{ id: string }[]>`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "holdState", "createdAt", "updatedAt"
        )
        VALUES (
          ${buyerId}, ${testShopId}, 'COMPANY',
          ${"gid://shopify/Company/conc-" + runId},
          ${"gid://shopify/CompanyLocation/conc-" + runId},
          'Test Concurrent Co', 100000, 'OK', NOW(), NOW()
        )
        RETURNING id
      `;
      testBuyerId = buyer.id;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
          "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoice1Id}, ${testShopId}, ${testBuyerId},
          ${"gid://shopify/Order/conc-1001-" + runId}, '#1001', 10000, 'open', 10000,
          NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
          "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoice2Id}, ${testShopId}, ${testBuyerId},
          ${"gid://shopify/Order/conc-1002-" + runId}, '#1002', 10000, 'open', 10000,
          NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
        )
      `;
    });

    afterEach(async () => {
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerId}`;
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;

      await sql`
        UPDATE "Invoice"
        SET outstanding = total, status = 'open', "updatedAt" = NOW()
        WHERE "shopId" = ${testShopId}
      `;
    });

    afterAll(async () => {
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerId}`;
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;

      await assertNoQueueLeftovers(sql, [TEST_SHOP_DOMAIN], "confirm-only-reconcile-db.test.ts:concurrent");
    });

    it("concurrent confirms on 2 suggestions for same 10000 payment: total confirmed <= 10000", async () => {
      const credits: SyntheticCredit[] = [
        {
          date: getUtcDateString(5),
          amountPaise: 1000000,
          rail: "NEFT",
          utr: makeValidNeftUtr(`${runId}20`),
          payerName: "Test Concurrent Co",
          narration: `NEFT CR-TEST CONCURRENT CO`,
        },
      ];

      await sql.begin((tx) =>
        insertBankImportRows(tx, {
          shopId: testShopId,
          bank: "HDFC",
          fileName: "test-concurrent.csv",
          credits,
          now: new Date(),
        })
      );

      const [payment] = await sql<{ id: string }[]>`
        SELECT id FROM "Payment" WHERE "shopId" = ${testShopId}
      `;

      await sql`
        INSERT INTO "Match" ("shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
        VALUES
          (${testShopId}, ${payment.id}, ${invoice1Id}, 10000, 80, '{"concurrent": true}'::jsonb, 'suggested', NOW(), NOW()),
          (${testShopId}, ${payment.id}, ${invoice2Id}, 10000, 70, '{"concurrent": true}'::jsonb, 'suggested', NOW(), NOW())
      `;

      const [match1] = await sql<{ id: string }[]>`
        SELECT id FROM "Match"
        WHERE "shopId" = ${testShopId} AND "invoiceId" = ${invoice1Id} AND state = 'suggested'
      `;
      expect(match1).toBeDefined();

      const [match2] = await sql<{ id: string }[]>`
        SELECT id FROM "Match"
        WHERE "shopId" = ${testShopId} AND "invoiceId" = ${invoice2Id} AND state = 'suggested'
      `;
      expect(match2).toBeDefined();

      const results = await Promise.all([
        confirmMatch(sql, testShopId, match1.id, "user-1"),
        confirmMatch(sql, testShopId, match2.id, "user-2"),
      ]);

      const successCount = results.filter((r) => r.success).length;
      expect(successCount).toBeGreaterThanOrEqual(1);

      const confirmedMatches = await sql<{ amount: string }[]>`
        SELECT amount::text FROM "Match"
        WHERE "shopId" = ${testShopId} AND state IN ('confirmed', 'pushed')
      `;

      const totalConfirmed = confirmedMatches.reduce(
        (sum, m) => sum + parseFloat(m.amount),
        0
      );
      expect(totalConfirmed).toBeLessThanOrEqual(10000);
    });
  });

  describe("4. Confirm against cancelled or closed/paid invoice is rejected", () => {
    const runId = Date.now() + 4;
    const TEST_SHOP_DOMAIN = `test-closed-invoice-${runId}.myshopify.com`;
    let testShopId: string;
    let testBuyerId: string;
    const invoiceCancelledId = `invoice-cancelled-${runId}`;
    const invoicePaidId = `invoice-paid-${runId}`;

    beforeAll(async () => {
      const [shop] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
        RETURNING id
      `;
      testShopId = shop.id;

      const buyerId = `buyer-closed-${runId}`;
      const [buyer] = await sql<{ id: string }[]>`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "holdState", "createdAt", "updatedAt"
        )
        VALUES (
          ${buyerId}, ${testShopId}, 'COMPANY',
          ${"gid://shopify/Company/closed-" + runId},
          ${"gid://shopify/CompanyLocation/closed-" + runId},
          'Test Closed Invoice Co', 100000, 'OK', NOW(), NOW()
        )
        RETURNING id
      `;
      testBuyerId = buyer.id;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
          "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceCancelledId}, ${testShopId}, ${testBuyerId},
          ${"gid://shopify/Order/cancelled-" + runId}, '#CANCELLED', 10000, 'cancelled', 10000,
          NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
          "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoicePaidId}, ${testShopId}, ${testBuyerId},
          ${"gid://shopify/Order/paid-" + runId}, '#PAID', 10000, 'paid', 0,
          NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
        )
      `;
    });

    afterEach(async () => {
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerId}`;
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
    });

    afterAll(async () => {
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerId}`;
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;

      await assertNoQueueLeftovers(sql, [TEST_SHOP_DOMAIN], "confirm-only-reconcile-db.test.ts:closed");
    });

    it("apply against cancelled invoice (status cancelled) fails with INVOICE_NOT_OPEN", async () => {
      const credits: SyntheticCredit[] = [
        {
          date: getUtcDateString(5),
          amountPaise: 1000000,
          rail: "NEFT",
          utr: makeValidNeftUtr(`${runId}30`),
          payerName: "Test Closed Invoice Co",
          narration: `NEFT CR-TEST CLOSED CO-#CANCELLED`,
        },
      ];

      await sql.begin((tx) =>
        insertBankImportRows(tx, {
          shopId: testShopId,
          bank: "HDFC",
          fileName: "test-cancelled.csv",
          credits,
          now: new Date(),
        })
      );

      const [payment] = await sql<{ id: string }[]>`
        SELECT id FROM "Payment" WHERE "shopId" = ${testShopId}
      `;

      await sql`
        INSERT INTO "Match" (
          "shopId", "paymentId", "invoiceId", amount, score, reasons, state,
          "createdAt", "updatedAt"
        )
        VALUES (
          ${testShopId}, ${payment.id}, ${invoiceCancelledId}, 10000, 50,
          '{"manual": true}'::jsonb, 'suggested', NOW(), NOW()
        )
      `;

      const [match] = await sql<{ id: string }[]>`
        SELECT id FROM "Match" WHERE "shopId" = ${testShopId} AND state = 'suggested'
      `;

      const confirmResult = await confirmMatch(sql, testShopId, match.id, "test-user");
      expect(confirmResult.success).toBe(true);

      const applyResult = await applyMatch(sql, testShopId, match.id, "test-user");
      expect(applyResult.success).toBe(false);
      expect(applyResult.reasonCode).toBe("INVOICE_NOT_OPEN");

      const pushedMatchCount = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "Match"
        WHERE "shopId" = ${testShopId} AND state = 'pushed'
      `;
      expect(parseInt(pushedMatchCount[0].count, 10)).toBe(0);

      const [invoice] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE id = ${invoiceCancelledId}
      `;
      expect(invoice.status).toBe("cancelled");
      expect(parseFloat(invoice.outstanding)).toBe(10000);
    });

    it("confirm against paid invoice (outstanding=0) fails with 'Invoice fully allocated' error", async () => {
      const credits: SyntheticCredit[] = [
        {
          date: getUtcDateString(5),
          amountPaise: 1000000,
          rail: "NEFT",
          utr: makeValidNeftUtr(`${runId}31`),
          payerName: "Test Closed Invoice Co",
          narration: `NEFT CR-TEST CLOSED CO-#PAID`,
        },
      ];

      await sql.begin((tx) =>
        insertBankImportRows(tx, {
          shopId: testShopId,
          bank: "HDFC",
          fileName: "test-paid.csv",
          credits,
          now: new Date(),
        })
      );

      const [payment] = await sql<{ id: string }[]>`
        SELECT id FROM "Payment" WHERE "shopId" = ${testShopId}
      `;

      await sql`
        INSERT INTO "Match" (
          "shopId", "paymentId", "invoiceId", amount, score, reasons, state,
          "createdAt", "updatedAt"
        )
        VALUES (
          ${testShopId}, ${payment.id}, ${invoicePaidId}, 10000, 50,
          '{"manual": true}'::jsonb, 'suggested', NOW(), NOW()
        )
      `;

      const [match] = await sql<{ id: string }[]>`
        SELECT id FROM "Match" WHERE "shopId" = ${testShopId} AND state = 'suggested'
      `;

      const confirmResult = await confirmMatch(sql, testShopId, match.id, "test-user");
      expect(confirmResult.success).toBe(false);
      expect(confirmResult.error).toBe("Invoice fully allocated");

      const confirmedCount = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "Match"
        WHERE "shopId" = ${testShopId} AND state = 'confirmed'
      `;
      expect(parseInt(confirmedCount[0].count, 10)).toBe(0);
    });
  });

  describe("5. Partial payment leaves correct outstanding and partial status", () => {
    const runId = Date.now() + 5;
    const TEST_SHOP_DOMAIN = `test-partial-${runId}.myshopify.com`;
    let testShopId: string;
    let testBuyerId: string;
    const invoice1Id = `invoice-partial-${runId}`;

    beforeAll(async () => {
      const [shop] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
        RETURNING id
      `;
      testShopId = shop.id;

      const buyerId = `buyer-partial-${runId}`;
      const [buyer] = await sql<{ id: string }[]>`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "holdState", "createdAt", "updatedAt"
        )
        VALUES (
          ${buyerId}, ${testShopId}, 'COMPANY',
          ${"gid://shopify/Company/partial-" + runId},
          ${"gid://shopify/CompanyLocation/partial-" + runId},
          'Test Partial Payment Co', 100000, 'OK', NOW(), NOW()
        )
        RETURNING id
      `;
      testBuyerId = buyer.id;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
          "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoice1Id}, ${testShopId}, ${testBuyerId},
          ${"gid://shopify/Order/partial-1001-" + runId}, '#1001', 10000, 'open', 10000,
          NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
        )
      `;
    });

    afterEach(async () => {
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerId}`;
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;

      await sql`
        UPDATE "Invoice"
        SET outstanding = total, status = 'open', "updatedAt" = NOW()
        WHERE "shopId" = ${testShopId}
      `;
    });

    afterAll(async () => {
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerId}`;
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;

      await assertNoQueueLeftovers(sql, [TEST_SHOP_DOMAIN], "confirm-only-reconcile-db.test.ts:partial");
    });

    it("partial payment confirm: 5000 against 10000 invoice - match amount 5000, payment status matched", async () => {
      const credits: SyntheticCredit[] = [
        {
          date: getUtcDateString(5),
          amountPaise: 500000,
          rail: "NEFT",
          utr: makeValidNeftUtr(`${runId}40`),
          payerName: "Test Partial Payment Co",
          narration: `NEFT CR-TEST PARTIAL PAYMENT CO-#1001`,
        },
      ];

      await sql.begin((tx) =>
        insertBankImportRows(tx, {
          shopId: testShopId,
          bank: "HDFC",
          fileName: "test-partial.csv",
          credits,
          now: new Date(),
        })
      );

      await runMatcher(sql, testShopId);

      const [match] = await sql<{ id: string }[]>`
        SELECT id FROM "Match"
        WHERE "shopId" = ${testShopId} AND "invoiceId" = ${invoice1Id} AND state = 'suggested'
      `;
      expect(match).toBeDefined();

      const confirmResult = await confirmMatch(sql, testShopId, match.id, "test-user");
      expect(confirmResult.success).toBe(true);

      const [confirmedMatch] = await sql<{ state: string; amount: string }[]>`
        SELECT state, amount::text FROM "Match" WHERE id = ${match.id}
      `;
      expect(confirmedMatch.state).toBe("confirmed");
      expect(parseFloat(confirmedMatch.amount)).toBe(5000);

      const [payment] = await sql<{ status: string }[]>`
        SELECT status FROM "Payment" WHERE "shopId" = ${testShopId}
      `;
      expect(payment.status).toBe("matched");

      const [invoice] = await sql<{ status: string; outstanding: string }[]>`
        SELECT status, outstanding::text FROM "Invoice" WHERE id = ${invoice1Id}
      `;
      expect(invoice.status).toBe("open");
      expect(parseFloat(invoice.outstanding)).toBe(10000);
    });
  });

  describe("6. Overpayment: pins current behaviour (capped to outstanding)", () => {
    const runId = Date.now() + 6;
    const TEST_SHOP_DOMAIN = `test-overpay-${runId}.myshopify.com`;
    let testShopId: string;
    let testBuyerId: string;
    const invoice1Id = `invoice-overpay-${runId}`;

    beforeAll(async () => {
      const [shop] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
        RETURNING id
      `;
      testShopId = shop.id;

      const buyerId = `buyer-overpay-${runId}`;
      const [buyer] = await sql<{ id: string }[]>`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "holdState", "createdAt", "updatedAt"
        )
        VALUES (
          ${buyerId}, ${testShopId}, 'COMPANY',
          ${"gid://shopify/Company/overpay-" + runId},
          ${"gid://shopify/CompanyLocation/overpay-" + runId},
          'Test Overpay Co', 100000, 'OK', NOW(), NOW()
        )
        RETURNING id
      `;
      testBuyerId = buyer.id;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
          "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoice1Id}, ${testShopId}, ${testBuyerId},
          ${"gid://shopify/Order/overpay-1001-" + runId}, '#1001', 5000, 'open', 5000,
          NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
        )
      `;
    });

    afterEach(async () => {
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerId}`;
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;

      await sql`
        UPDATE "Invoice"
        SET outstanding = total, status = 'open', "updatedAt" = NOW()
        WHERE "shopId" = ${testShopId}
      `;
    });

    afterAll(async () => {
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerId}`;
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;

      await assertNoQueueLeftovers(sql, [TEST_SHOP_DOMAIN], "confirm-only-reconcile-db.test.ts:overpay");
    });

    it("overpayment confirm is capped to outstanding: 10000 payment against 5000 invoice caps at 5000", async () => {
      const credits: SyntheticCredit[] = [
        {
          date: getUtcDateString(5),
          amountPaise: 1000000,
          rail: "NEFT",
          utr: makeValidNeftUtr(`${runId}50`),
          payerName: "Test Overpay Co",
          narration: `NEFT CR-TEST OVERPAY CO-#1001`,
        },
      ];

      await sql.begin((tx) =>
        insertBankImportRows(tx, {
          shopId: testShopId,
          bank: "HDFC",
          fileName: "test-overpay.csv",
          credits,
          now: new Date(),
        })
      );

      const [payment] = await sql<{ id: string }[]>`
        SELECT id FROM "Payment" WHERE "shopId" = ${testShopId}
      `;

      await sql`
        INSERT INTO "Match" (
          "shopId", "paymentId", "invoiceId", amount, score, reasons, state,
          "createdAt", "updatedAt"
        )
        VALUES (
          ${testShopId}, ${payment.id}, ${invoice1Id}, 10000, 50,
          '{"overpay": true}'::jsonb, 'suggested', NOW(), NOW()
        )
      `;

      const [match] = await sql<{ id: string }[]>`
        SELECT id FROM "Match" WHERE "shopId" = ${testShopId} AND state = 'suggested'
      `;

      const confirmResult = await confirmMatch(sql, testShopId, match.id, "test-user");
      expect(confirmResult.success).toBe(true);

      const [confirmedMatch] = await sql<{ amount: string; state: string }[]>`
        SELECT amount::text, state FROM "Match" WHERE id = ${match.id}
      `;
      expect(parseFloat(confirmedMatch.amount)).toBe(5000);
      expect(confirmedMatch.state).toBe("confirmed");

      const [paymentStatus] = await sql<{ status: string }[]>`
        SELECT status FROM "Payment" WHERE id = ${payment.id}
      `;
      expect(paymentStatus.status).toBe("partial");

      const auditCount = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "AuditEvent"
        WHERE "shopId" = ${testShopId} AND type = 'match.confirmed'
      `;
      expect(parseInt(auditCount[0].count, 10)).toBe(1);
    });
  });

  describe("7. Unconfirm/unmatch: restores invoice outstanding and status", () => {
    const runId = Date.now() + 7;
    const TEST_SHOP_DOMAIN = `test-unmatch-${runId}.myshopify.com`;
    let testShopId: string;
    let testBuyerId: string;
    const invoice1Id = `invoice-unmatch-${runId}`;

    beforeAll(async () => {
      const [shop] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
        RETURNING id
      `;
      testShopId = shop.id;

      const buyerId = `buyer-unmatch-${runId}`;
      const [buyer] = await sql<{ id: string }[]>`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "holdState", "createdAt", "updatedAt"
        )
        VALUES (
          ${buyerId}, ${testShopId}, 'COMPANY',
          ${"gid://shopify/Company/unmatch-" + runId},
          ${"gid://shopify/CompanyLocation/unmatch-" + runId},
          'Test Unmatch Co', 100000, 'OK', NOW(), NOW()
        )
        RETURNING id
      `;
      testBuyerId = buyer.id;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
          "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoice1Id}, ${testShopId}, ${testBuyerId},
          ${"gid://shopify/Order/unmatch-1001-" + runId}, '#1001', 10000, 'open', 10000,
          NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
        )
      `;
    });

    afterEach(async () => {
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerId}`;
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;

      await sql`
        UPDATE "Invoice"
        SET outstanding = total, status = 'open', "updatedAt" = NOW()
        WHERE "shopId" = ${testShopId}
      `;
    });

    afterAll(async () => {
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerId}`;
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;

      await assertNoQueueLeftovers(sql, [TEST_SHOP_DOMAIN], "confirm-only-reconcile-db.test.ts:unmatch");
    });

    it("unmatch of confirmed match: match state unmatched, payment status unmatched", async () => {
      const credits: SyntheticCredit[] = [
        {
          date: getUtcDateString(5),
          amountPaise: 500000,
          rail: "NEFT",
          utr: makeValidNeftUtr(`${runId}60`),
          payerName: "Test Unmatch Co",
          narration: `NEFT CR-TEST UNMATCH CO-#1001`,
        },
      ];

      await sql.begin((tx) =>
        insertBankImportRows(tx, {
          shopId: testShopId,
          bank: "HDFC",
          fileName: "test-unmatch.csv",
          credits,
          now: new Date(),
        })
      );

      await runMatcher(sql, testShopId);

      const [match] = await sql<{ id: string }[]>`
        SELECT id FROM "Match"
        WHERE "shopId" = ${testShopId} AND "invoiceId" = ${invoice1Id} AND state = 'suggested'
      `;
      expect(match).toBeDefined();

      const confirmResult = await confirmMatch(sql, testShopId, match.id, "test-user");
      expect(confirmResult.success).toBe(true);

      const [beforeUnmatch] = await sql<{ status: string }[]>`
        SELECT status FROM "Payment"
        WHERE "shopId" = ${testShopId}
      `;
      expect(beforeUnmatch.status).toBe("matched");

      const unmatchResult = await unmatchMatch(sql, testShopId, match.id, "test-user");
      expect(unmatchResult.success).toBe(true);

      const [afterUnmatch] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${match.id}
      `;
      expect(afterUnmatch.state).toBe("unmatched");

      const [paymentAfter] = await sql<{ status: string }[]>`
        SELECT status FROM "Payment" WHERE "shopId" = ${testShopId}
      `;
      expect(paymentAfter.status).toBe("unmatched");
    });

    it("reject creates rejection record in rejected_matches table", async () => {
      const credits: SyntheticCredit[] = [
        {
          date: getUtcDateString(5),
          amountPaise: 500000,
          rail: "NEFT",
          utr: makeValidNeftUtr(`${runId}61`),
          payerName: "Test Unmatch Co",
          narration: `NEFT CR-TEST UNMATCH CO-#1001`,
        },
      ];

      await sql.begin((tx) =>
        insertBankImportRows(tx, {
          shopId: testShopId,
          bank: "HDFC",
          fileName: "test-reject.csv",
          credits,
          now: new Date(),
        })
      );

      await runMatcher(sql, testShopId);

      const [match] = await sql<{ id: string; payment_id: string }[]>`
        SELECT id, "paymentId" AS payment_id FROM "Match"
        WHERE "shopId" = ${testShopId} AND "invoiceId" = ${invoice1Id} AND state = 'suggested'
      `;
      expect(match).toBeDefined();

      const rejectResult = await rejectMatch(sql, testShopId, match.id, "test-user");
      expect(rejectResult.success).toBe(true);

      const rejectedCount = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "rejected_matches"
        WHERE "shopId" = ${testShopId} AND "paymentId" = ${match.payment_id} AND "invoiceId" = ${invoice1Id}
      `;
      expect(parseInt(rejectedCount[0].count, 10)).toBe(1);
    });
  });

  describe("8. Privacy: no PII in logs or AuditEvent", () => {
    const runId = Date.now() + 8;
    const TEST_SHOP_DOMAIN = `test-privacy-${runId}.myshopify.com`;
    let testShopId: string;
    let testBuyerId: string;
    const invoice1Id = `invoice-privacy-${runId}`;

    const SENSITIVE_REMITTER = "Confidential Remitter Corp Pvt Ltd";
    const SENSITIVE_NARRATION = `NEFT/REF123456/CONFIDENTIAL REMITTER CORP/SENSITIVE INFO/SECRET123`;

    beforeAll(async () => {
      const [shop] = await sql<{ id: string }[]>`
        INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
        VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
        RETURNING id
      `;
      testShopId = shop.id;

      const buyerId = `buyer-privacy-${runId}`;
      const [buyer] = await sql<{ id: string }[]>`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", name,
          "creditLimit", "holdState", "createdAt", "updatedAt"
        )
        VALUES (
          ${buyerId}, ${testShopId}, 'COMPANY',
          ${"gid://shopify/Company/privacy-" + runId},
          ${"gid://shopify/CompanyLocation/privacy-" + runId},
          'Test Privacy Co', 100000, 'OK', NOW(), NOW()
        )
        RETURNING id
      `;
      testBuyerId = buyer.id;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
          "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoice1Id}, ${testShopId}, ${testBuyerId},
          ${"gid://shopify/Order/privacy-1001-" + runId}, '#1001', 10000, 'open', 10000,
          NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
        )
      `;
    });

    afterEach(async () => {
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerId}`;
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;

      await sql`
        UPDATE "Invoice"
        SET outstanding = total, status = 'open', "updatedAt" = NOW()
        WHERE "shopId" = ${testShopId}
      `;

      logSpy.mockClear();
    });

    afterAll(async () => {
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerId}`;
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;

      await assertNoQueueLeftovers(sql, [TEST_SHOP_DOMAIN], "confirm-only-reconcile-db.test.ts:privacy");
    });

    it("positive control: spy captures safeLog calls during real import flow", async () => {
      logSpy.mockClear();

      const credits: SyntheticCredit[] = [
        {
          date: getUtcDateString(5),
          amountPaise: 1000000,
          rail: "NEFT",
          utr: makeValidNeftUtr(`${runId}69`),
          payerName: "Test Privacy Control Co",
          narration: `NEFT CR-TEST PRIVACY CONTROL CO-#1001`,
        },
      ];

      await sql.begin((tx) =>
        insertBankImportRows(tx, {
          shopId: testShopId,
          bank: "HDFC",
          fileName: "test-privacy-control.csv",
          credits,
          now: new Date(),
        })
      );

      expect(logSpy).toHaveBeenCalled();
      expect(logSpy.mock.calls.length).toBeGreaterThan(0);
    });

    it("no remitter name or narration in log calls or AuditEvent rows", async () => {
      logSpy.mockClear();

      const credits: SyntheticCredit[] = [
        {
          date: getUtcDateString(5),
          amountPaise: 1000000,
          rail: "NEFT",
          utr: makeValidNeftUtr(`${runId}70`),
          payerName: SENSITIVE_REMITTER,
          narration: SENSITIVE_NARRATION,
        },
      ];

      await sql.begin((tx) =>
        insertBankImportRows(tx, {
          shopId: testShopId,
          bank: "HDFC",
          fileName: "test-privacy.csv",
          credits,
          now: new Date(),
        })
      );

      await runMatcher(sql, testShopId);

      const [match] = await sql<{ id: string }[]>`
        SELECT id FROM "Match"
        WHERE "shopId" = ${testShopId} AND "invoiceId" = ${invoice1Id} AND state = 'suggested'
      `;
      expect(match).toBeDefined();

      const confirmResult = await confirmMatch(sql, testShopId, match.id, "test-user");
      expect(confirmResult.success).toBe(true);

      expect(logSpy.mock.calls.length).toBeGreaterThan(0);

      const auditEvents = await sql<{ data: unknown }[]>`
        SELECT data FROM "AuditEvent" WHERE "shopId" = ${testShopId}
      `;
      expect(auditEvents.length).toBeGreaterThan(0);

      const allLogCalls = JSON.stringify(logSpy.mock.calls);

      const sensitiveTerms = [
        SENSITIVE_REMITTER.toLowerCase(),
        "confidential remitter",
        SENSITIVE_NARRATION.toLowerCase(),
        "sensitive info",
        "secret123",
      ];

      for (const term of sensitiveTerms) {
        expect(allLogCalls.toLowerCase()).not.toContain(term);
      }

      for (const event of auditEvents) {
        const eventStr = JSON.stringify(event.data).toLowerCase();
        for (const term of sensitiveTerms) {
          expect(eventStr).not.toContain(term);
        }
      }
    });
  });
});
