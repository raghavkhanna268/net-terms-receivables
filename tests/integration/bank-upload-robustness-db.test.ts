/**
 * Bank-statement upload robustness DB tests (requires Postgres).
 *
 * Tests that require real database interaction:
 * - Case 2: Invalid inputs through action path → 0 DB rows
 * - Case 6: Concurrent upload deduplication (Promise.all of two real calls)
 *
 * Pure parser tests (cases 3, 4, 5) are in app/lib/banks/__tests__/upload-robustness.test.ts.
 *
 * All fixtures are SYNTHETIC - no real bank data.
 * Uses test-* shop names, example.com emails, made-up narrations and UTR-like refs.
 *
 * NOTE: PR #474 already covers:
 * - Parser empty file handling (parseBankStatement returns 0 transactions, UNKNOWN bank)
 * - Parser header-only handling (parseBankStatement returns 0 transactions)
 * - Duplicate upload detection (sequential, non-concurrent)
 * - HDFC/ICICI happy path parsing
 * - Dedupe key generation
 *
 * This file adds tests NOT in PR #474:
 * - Case 2: Wrong extension, wrong MIME giving clear errors (parser-level validation)
 * - Case 2: Empty/invalid payload through action → 0 DB rows
 * - Case 6: Concurrent upload deduplication via Promise.all
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "../../app/lib/db-light.server.js";
import { assertNoQueueLeftovers } from "../helpers/queue-leftovers.js";
import { action as importAction } from "../../app/routes/app.imports.js";
import { parseBankStatement } from "../../app/lib/banks/index.js";
import { requestContext } from "../../app/lib/request-context.server.js";
import { insertBankImportRows } from "../../app/services/bank-import.server.js";

vi.mock("../../app/services/credit-status-recompute.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    enqueueRecomputeForInvoice: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../app/services/matcher.server", () => ({
  runMatcher: vi.fn(async () => ({
    paymentsProcessed: 0,
    matchesCreated: 0,
    highConfidenceMatches: 0,
    hasMore: false,
  })),
  MAX_PAYMENTS_PER_REQUEST: 100,
}));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

function createMockRequest(body: unknown): Request {
  return new Request("http://localhost/app/imports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createMockContext(shopDomain: string) {
  return {
    shopify: {
      authenticate: {
        admin: vi.fn().mockResolvedValue({
          session: { shop: shopDomain },
        }),
      },
    },
  };
}

async function callImportAction(
  sql: ReturnType<typeof postgres>,
  shopDomain: string,
  body: unknown
): Promise<Response> {
  const request = createMockRequest(body);
  const context = createMockContext(shopDomain);
  const url = new URL(request.url);

  return requestContext.run({ getSql: () => sql }, async () => {
    return importAction({
      request,
      context: context as never,
      params: {},
      url,
      pattern: "/app/imports",
    });
  });
}

function getUtcDateString(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function makeValidNeftUtr(suffix: string): string {
  const paddedSuffix = suffix.replace(/[^0-9]/g, "").padStart(11, "0").slice(0, 11);
  return `HDFCN${paddedSuffix}`;
}

interface ImportResult {
  success: boolean;
  importId?: string;
  error?: string;
  details?: string[];
  counts?: {
    inserted: number;
    duplicates: number;
    rejected: number;
    total: number;
  };
  matcher?: {
    paymentsProcessed: number;
    matchesCreated: number;
    highConfidenceMatches: number;
    hasMore: boolean;
  } | null;
}

describeWithDb("Bank Upload Robustness DB Tests", () => {
  let sql: ReturnType<typeof postgres>;
  const runId = Date.now();
  const shopDomains: string[] = [];
  const createdShopIds: string[] = [];

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    for (let i = 0; i < createdShopIds.length; i++) {
      const shopId = createdShopIds[i];
      const domain = shopDomains[i];
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${domain}`;
      await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${domain}`;
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${shopId}`;
    }
    await assertNoQueueLeftovers(
      sql,
      shopDomains.length > 0 ? shopDomains : [`test-robustness-noop-${runId}.myshopify.com`],
      "bank-upload-robustness-db.test.ts"
    );
    await sql.end();
  });

  async function createTestShop(suffix: string): Promise<{ shopId: string; shopDomain: string }> {
    const domain = `test-robustness-${suffix}-${runId}.myshopify.com`;
    shopDomains.push(domain);

    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${domain}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    createdShopIds.push(shop.id);
    return { shopId: shop.id, shopDomain: domain };
  }

  describe("Case 2: File type validation (parser-level)", () => {
    it("wrong extension (.pdf) returns UNKNOWN bank with clear error", async () => {
      const pdfContent = "Some random PDF-like content that is not a bank statement";
      const file = new File([pdfContent], "statement.pdf", { type: "application/pdf" });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("UNKNOWN");
      expect(result.transactions).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].code).toBe("UNKNOWN_BANK_FORMAT");
    });

    it("wrong extension (.txt) with non-CSV content returns UNKNOWN bank", async () => {
      const txtContent = "This is a plain text file\nNot a bank statement\nJust random text";
      const file = new File([txtContent], "notes.txt", { type: "text/plain" });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("UNKNOWN");
      expect(result.transactions).toHaveLength(0);
    });

    it("wrong MIME type (application/json) returns UNKNOWN bank", async () => {
      const jsonContent = JSON.stringify({ not: "a bank statement" });
      const file = new File([jsonContent], "data.csv", { type: "application/json" });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("UNKNOWN");
      expect(result.transactions).toHaveLength(0);
    });
  });

  describe("Case 2: Invalid action inputs with 0 DB rows", () => {
    afterEach(async () => {
      for (const shopId of createdShopIds) {
        await sql`DELETE FROM "Payment" WHERE "shopId" = ${shopId}`;
        await sql`DELETE FROM "BankImport" WHERE "shopId" = ${shopId}`;
      }
    });

    it("empty credits array: action rejects with clear error and 0 DB rows", async () => {
      const { shopId, shopDomain } = await createTestShop("empty-credits");

      const payload = {
        bank: "HDFC",
        fileName: "empty.csv",
        credits: [],
      };

      const response = await callImportAction(sql, shopDomain, payload);
      expect(response.status).toBe(400);

      const data = (await response.json()) as ImportResult;
      expect(data.success).toBe(false);
      expect(data.error).toContain("Validation failed");

      const [count] = await sql<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM "Payment" WHERE "shopId" = ${shopId}
      `;
      expect(parseInt(count.c, 10)).toBe(0);
    });

    it("invalid bank type: action rejects with clear error and 0 DB rows", async () => {
      const { shopId, shopDomain } = await createTestShop("bad-bank");

      const payload = {
        bank: "KOTAK",
        fileName: "kotak.csv",
        credits: [
          {
            date: getUtcDateString(1),
            amountPaise: 100000,
            rail: "NEFT",
            narration: "NEFT CR-TEST",
          },
        ],
      };

      const response = await callImportAction(sql, shopDomain, payload);
      expect(response.status).toBe(400);

      const [count] = await sql<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM "Payment" WHERE "shopId" = ${shopId}
      `;
      expect(parseInt(count.c, 10)).toBe(0);
    });

    it("invalid rail type: action rejects with clear error and 0 DB rows", async () => {
      const { shopId, shopDomain } = await createTestShop("bad-rail");

      const payload = {
        bank: "HDFC",
        fileName: "badrail.csv",
        credits: [
          {
            date: getUtcDateString(1),
            amountPaise: 100000,
            rail: "SWIFT",
            narration: "SWIFT CR-TEST",
          },
        ],
      };

      const response = await callImportAction(sql, shopDomain, payload);
      expect(response.status).toBe(400);

      const [count] = await sql<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM "Payment" WHERE "shopId" = ${shopId}
      `;
      expect(parseInt(count.c, 10)).toBe(0);
    });

    it("invalid date format: action rejects with clear error and 0 DB rows", async () => {
      const { shopId, shopDomain } = await createTestShop("bad-date");

      const payload = {
        bank: "HDFC",
        fileName: "baddate.csv",
        credits: [
          {
            date: "31-12-2026",
            amountPaise: 100000,
            rail: "NEFT",
            narration: "NEFT CR-TEST",
          },
        ],
      };

      const response = await callImportAction(sql, shopDomain, payload);
      expect(response.status).toBe(400);

      const [count] = await sql<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM "Payment" WHERE "shopId" = ${shopId}
      `;
      expect(parseInt(count.c, 10)).toBe(0);
    });

    it("negative amountPaise: action rejects with clear error and 0 DB rows", async () => {
      const { shopId, shopDomain } = await createTestShop("negative-amt");

      const payload = {
        bank: "HDFC",
        fileName: "negative.csv",
        credits: [
          {
            date: getUtcDateString(1),
            amountPaise: -100000,
            rail: "NEFT",
            narration: "NEFT CR-TEST",
          },
        ],
      };

      const response = await callImportAction(sql, shopDomain, payload);
      expect(response.status).toBe(400);

      const [count] = await sql<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM "Payment" WHERE "shopId" = ${shopId}
      `;
      expect(parseInt(count.c, 10)).toBe(0);
    });
  });

  describe("Case 6: Concurrent upload deduplication (Promise.all)", () => {
    afterEach(async () => {
      for (const shopId of createdShopIds) {
        await sql`DELETE FROM "Payment" WHERE "shopId" = ${shopId}`;
        await sql`DELETE FROM "BankImport" WHERE "shopId" = ${shopId}`;
      }
    });

    it("concurrent uploads of same file via action yield exactly one set of rows", async () => {
      const { shopId, shopDomain } = await createTestShop("concurrent-action");

      const credits = [
        {
          date: getUtcDateString(2),
          amountPaise: 5000000,
          rail: "NEFT",
          utr: makeValidNeftUtr("40404040401"),
          payerName: "TEST-CONCURRENT-CORP",
          narration: "NEFT CR-TEST-CONCURRENT-CORP-INV001",
        },
        {
          date: getUtcDateString(1),
          amountPaise: 3000000,
          rail: "NEFT",
          utr: makeValidNeftUtr("40404040402"),
          payerName: "TEST-CONCURRENT-CORP",
          narration: "NEFT CR-TEST-CONCURRENT-CORP-INV002",
        },
      ];

      const payload = {
        bank: "HDFC",
        fileName: "concurrent-test.csv",
        credits,
      };

      const [response1, response2] = await Promise.all([
        callImportAction(sql, shopDomain, payload),
        callImportAction(sql, shopDomain, payload),
      ]);

      const data1 = (await response1.json()) as ImportResult;
      const data2 = (await response2.json()) as ImportResult;

      expect(data1.success).toBe(true);
      expect(data2.success).toBe(true);

      const totalInserted = (data1.counts?.inserted ?? 0) + (data2.counts?.inserted ?? 0);
      const totalDuplicates = (data1.counts?.duplicates ?? 0) + (data2.counts?.duplicates ?? 0);

      expect(totalInserted).toBe(2);
      expect(totalDuplicates).toBe(2);

      const [paymentCount] = await sql<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM "Payment" WHERE "shopId" = ${shopId}
      `;
      expect(parseInt(paymentCount.c, 10)).toBe(2);

      const [importCount] = await sql<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM "BankImport" WHERE "shopId" = ${shopId}
      `;
      expect(parseInt(importCount.c, 10)).toBe(2);
    });

    it("concurrent insertBankImportRows dedupe via ON CONFLICT", async () => {
      const { shopId } = await createTestShop("concurrent-direct");

      const credits = [
        {
          date: getUtcDateString(3),
          amountPaise: 7500000,
          rail: "NEFT" as const,
          utr: makeValidNeftUtr("50505050501"),
          payerName: "TEST-DIRECT-CONCURRENT",
          narration: "NEFT CR-TEST-DIRECT-CONCURRENT-INV001",
        },
      ];

      const now = new Date();

      const [result1, result2] = await Promise.all([
        sql.begin((tx) =>
          insertBankImportRows(tx, {
            shopId,
            bank: "HDFC",
            fileName: "concurrent-direct-1.csv",
            credits,
            now,
          })
        ),
        sql.begin((tx) =>
          insertBankImportRows(tx, {
            shopId,
            bank: "HDFC",
            fileName: "concurrent-direct-2.csv",
            credits,
            now,
          })
        ),
      ]);

      const totalInserted = result1.inserted + result2.inserted;
      const totalDuplicates = result1.duplicates + result2.duplicates;

      expect(totalInserted).toBe(1);
      expect(totalDuplicates).toBe(1);

      const [paymentCount] = await sql<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM "Payment" 
        WHERE "shopId" = ${shopId} AND utr = ${makeValidNeftUtr("50505050501")}
      `;
      expect(parseInt(paymentCount.c, 10)).toBe(1);
    });
  });
});
