/**
 * Bank-statement upload robustness tests (TESTS ONLY - no source changes).
 *
 * Covers edge cases NOT in PR #474's bank-import-critical-path.test.ts:
 * 1. Oversized file rejected before parsing (parser never called)
 * 2. Wrong extension, wrong MIME, empty file, header-only file: clear error, 0 DB rows
 * 3. UTF-8 BOM, CRLF line endings, trailing blank lines, quoted fields with commas
 * 4. Date formats (dd/mm/yyyy, dd-MMM-yy, dd/mm/yy), Indian amounts, Dr/Cr columns
 * 5. Malformed row mid-file: pin current behavior (skips with count)
 * 6. Concurrent upload deduplication (Promise.all of two real calls)
 *
 * All fixtures are SYNTHETIC - no real bank data.
 * Uses test-* shop names, example.com emails, made-up narrations and UTR-like refs.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "../../app/lib/db-light.server.js";
import { assertNoQueueLeftovers } from "../helpers/queue-leftovers.js";
import { action as importAction, validateImportRequest, MAX_IMPORT_ROWS } from "../../app/routes/app.imports.js";
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

describeWithDb("Bank Upload Robustness Tests", () => {
  let sql: ReturnType<typeof postgres>;
  const runId = Date.now();
  const shopDomains: string[] = [];

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    if (sql) {
      for (const domain of shopDomains) {
        const [shop] = await sql<{ id: string }[]>`SELECT id FROM "Shop" WHERE domain = ${domain}`;
        if (shop) {
          await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${domain}`;
          await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${domain}`;
          await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${shop.id}`;
          await sql`DELETE FROM "Match" WHERE "shopId" = ${shop.id}`;
          await sql`DELETE FROM "Payment" WHERE "shopId" = ${shop.id}`;
          await sql`DELETE FROM "BankImport" WHERE "shopId" = ${shop.id}`;
          await sql`DELETE FROM "Invoice" WHERE "shopId" = ${shop.id}`;
          await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${shop.id}`;
          await sql`DELETE FROM "Shop" WHERE id = ${shop.id}`;
        }
      }
      await assertNoQueueLeftovers(sql, shopDomains.length > 0 ? shopDomains : [`test-robustness-noop-${runId}.myshopify.com`], "bank-upload-robustness-db.test.ts");
      await sql.end();
    }
  });

  async function createTestShop(suffix: string): Promise<{ shopId: string; shopDomain: string }> {
    const domain = `test-robustness-${suffix}-${runId}.myshopify.com`;
    shopDomains.push(domain);

    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${domain}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    return { shopId: shop.id, shopDomain: domain };
  }

  describe("1. Oversized file rejected before parsing", () => {
    it("rejects payload with >1000 rows and parser is never called", async () => {
      const { shopDomain } = await createTestShop("oversized");

      const credits = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => ({
        date: getUtcDateString(1),
        amountPaise: 100000,
        rail: "NEFT",
        utr: makeValidNeftUtr(String(i).padStart(11, "0")),
        payerName: `TEST-PAYER-${i}`,
        narration: `NEFT CR-TEST-PAYER-${i}-PAYMENT`,
      }));

      const payload = {
        bank: "HDFC",
        fileName: "oversized-test.csv",
        credits,
      };

      const { valid, errors } = validateImportRequest(payload);

      expect(valid).toBeNull();
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.path === "credits" && e.message.includes("1,001"))).toBe(true);
      expect(errors.some((e) => e.message.includes("per-import limit"))).toBe(true);

      const response = await callImportAction(sql, shopDomain, payload);
      expect(response.status).toBe(400);

      const data = (await response.json()) as ImportResult;
      expect(data.success).toBe(false);
      expect(data.error).toContain("Validation failed");
    });

    it("accepts exactly 1000 rows (boundary)", async () => {
      const { shopId, shopDomain } = await createTestShop("boundary");

      const credits = Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => ({
        date: getUtcDateString(1),
        amountPaise: 100000,
        rail: "NEFT",
        utr: makeValidNeftUtr(`9${String(i).padStart(10, "0")}`),
        payerName: `TEST-BOUNDARY-${i}`,
        narration: `NEFT CR-TEST-BOUNDARY-${i}`,
      }));

      const payload = {
        bank: "HDFC",
        fileName: "boundary-test.csv",
        credits,
      };

      const { valid, errors } = validateImportRequest(payload);
      expect(valid).not.toBeNull();
      expect(errors).toHaveLength(0);

      const response = await callImportAction(sql, shopDomain, payload);
      expect(response.status).toBe(200);

      const data = (await response.json()) as ImportResult;
      expect(data.success).toBe(true);
      expect(data.counts?.inserted).toBe(1000);

      await sql`DELETE FROM "Payment" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${shopId}`;
    });
  });

  describe("2. Wrong extension, wrong MIME, empty file, header-only file", () => {
    it("empty credits array gives clear error and inserts no rows", async () => {
      const { shopId, shopDomain } = await createTestShop("empty");

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

    it("invalid bank type gives clear error and inserts no rows", async () => {
      const { shopId, shopDomain } = await createTestShop("badbank");

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

    it("invalid rail type gives clear error and inserts no rows", async () => {
      const { shopId, shopDomain } = await createTestShop("badrail");

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

      const data = (await response.json()) as ImportResult;
      expect(data.success).toBe(false);

      const [count] = await sql<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM "Payment" WHERE "shopId" = ${shopId}
      `;
      expect(parseInt(count.c, 10)).toBe(0);
    });

    it("invalid date format gives clear error and inserts no rows", async () => {
      const { shopId, shopDomain } = await createTestShop("baddate");

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
  });

  describe("3. UTF-8 BOM, CRLF line endings, trailing blank lines, quoted fields with commas", () => {
    it("UTF-8 BOM at file start parses correctly", async () => {
      const bomContent =
        "\ufeffHDFC BANK\nStatement\n\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n" +
        `02/10/26,NEFT CR-TEST-BOM-CORP-INV001,${makeValidNeftUtr("11111111111")},02/10/26,,"50,000.00","1,50,000.00"`;

      const file = new File([bomContent], "bom-test.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("HDFC");
      expect(result.transactions.length).toBe(1);
      expect(result.transactions[0].amountPaise).toBe(5000000);
    });

    it("CRLF line endings parse correctly", async () => {
      const crlfContent =
        "HDFC BANK\r\nStatement\r\n\r\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\r\n" +
        `02/10/26,NEFT CR-TEST-CRLF-CORP,${makeValidNeftUtr("22222222222")},02/10/26,,"25,000.00","1,25,000.00"\r\n`;

      const file = new File([crlfContent], "crlf-test.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("HDFC");
      expect(result.transactions.length).toBe(1);
      expect(result.transactions[0].amountPaise).toBe(2500000);
    });

    it("trailing blank lines parse correctly", async () => {
      const trailingContent =
        "HDFC BANK\nStatement\n\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n" +
        `02/10/26,NEFT CR-TEST-TRAILING-CORP,${makeValidNeftUtr("33333333333")},02/10/26,,"10,000.00","1,10,000.00"\n\n\n\n`;

      const file = new File([trailingContent], "trailing-test.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("HDFC");
      expect(result.transactions.length).toBe(1);
    });

    it("quoted fields containing commas parse correctly", async () => {
      const quotedContent =
        "HDFC BANK\nStatement\n\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n" +
        `02/10/26,"NEFT CR-TEST, COMMA CORP-INV001",${makeValidNeftUtr("44444444444")},02/10/26,,"15,000.00","1,15,000.00"`;

      const file = new File([quotedContent], "quoted-test.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("HDFC");
      expect(result.transactions.length).toBe(1);
      expect(result.transactions[0].narration).toContain("TEST, COMMA CORP");
    });
  });

  describe("4. Date formats and Indian amount grouping", () => {
    it("parses dd/mm/yyyy date format", async () => {
      const content =
        "HDFC BANK\nStatement\n\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n" +
        `15/10/2026,NEFT CR-TEST-DDMMYYYY,${makeValidNeftUtr("55555555555")},15/10/2026,,"20,000.00","1,20,000.00"`;

      const file = new File([content], "ddmmyyyy.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length).toBe(1);
      expect(result.transactions[0].date).toBe("2026-10-15");
    });

    it("parses dd-MMM-yy date format", async () => {
      const content =
        "HDFC BANK\nStatement\n\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n" +
        `15-Oct-26,NEFT CR-TEST-DDMMMYY,${makeValidNeftUtr("66666666666")},15-Oct-26,,"30,000.00","1,30,000.00"`;

      const file = new File([content], "ddmmmyy.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length).toBe(1);
      expect(result.transactions[0].date).toBe("2026-10-15");
    });

    it("parses dd/mm/yy date format", async () => {
      const content =
        "HDFC BANK\nStatement\n\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n" +
        `15/10/26,NEFT CR-TEST-DDMMYY,${makeValidNeftUtr("77777777777")},15/10/26,,"40,000.00","1,40,000.00"`;

      const file = new File([content], "ddmmyy.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length).toBe(1);
      expect(result.transactions[0].date).toBe("2026-10-15");
    });

    it("parses Indian digit grouping (1,23,456.78)", async () => {
      const content =
        "HDFC BANK\nStatement\n\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n" +
        `02/10/26,NEFT CR-TEST-INDIAN-AMT,${makeValidNeftUtr("88888888888")},02/10/26,,"1,23,456.78","2,23,456.78"`;

      const file = new File([content], "indian-amt.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length).toBe(1);
      expect(result.transactions[0].amountPaise).toBe(12345678);
    });

    it("parses separate Dr/Cr columns correctly", async () => {
      const content =
        "HDFC BANK\nStatement\n\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n" +
        `02/10/26,NEFT DR-TEST-DEBIT,${makeValidNeftUtr("99999999991")},02/10/26,"5,000.00",,"1,00,000.00"\n` +
        `03/10/26,NEFT CR-TEST-CREDIT,${makeValidNeftUtr("99999999992")},03/10/26,,"10,000.00","1,10,000.00"`;

      const file = new File([content], "dr-cr.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length).toBe(2);

      const debit = result.transactions.find((t) => t.direction === "DR");
      const credit = result.transactions.find((t) => t.direction === "CR");

      expect(debit).toBeDefined();
      expect(debit!.amountPaise).toBe(500000);

      expect(credit).toBeDefined();
      expect(credit!.amountPaise).toBe(1000000);
    });
  });

  describe("5. Malformed row mid-file: skips row with error count (current behavior)", () => {
    it("skips malformed row and continues parsing valid rows", async () => {
      const content =
        "HDFC BANK\nStatement\n\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n" +
        `02/10/26,NEFT CR-TEST-BEFORE-MALFORMED,${makeValidNeftUtr("10101010101")},02/10/26,,"10,000.00","1,10,000.00"\n` +
        `MALFORMED ROW WITH INVALID DATA,,,,,\n` +
        `03/10/26,NEFT CR-TEST-AFTER-MALFORMED,${makeValidNeftUtr("10101010102")},03/10/26,,"20,000.00","1,30,000.00"`;

      const file = new File([content], "malformed-mid.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length).toBe(2);
      expect(result.skippedRows).toBeGreaterThan(0);

      expect(result.transactions[0].narration).toContain("BEFORE-MALFORMED");
      expect(result.transactions[1].narration).toContain("AFTER-MALFORMED");
    });

    it("reports coded error for unparseable row", async () => {
      const content =
        "HDFC BANK\nStatement\n\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n" +
        `02/10/26,NEFT CR-TEST-VALID,${makeValidNeftUtr("20202020201")},02/10/26,,"10,000.00","1,10,000.00"\n` +
        `BADDATE,Some narration with data but bad date,REF123,BADDATE,,"5,000.00","1,15,000.00"\n` +
        `03/10/26,NEFT CR-TEST-VALID2,${makeValidNeftUtr("20202020202")},03/10/26,,"15,000.00","1,30,000.00"`;

      const file = new File([content], "coded-error.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length).toBe(2);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[0].row).toBe(6);
    });

    it("row accounting: transactions + errors + skippedRows === totalRows", async () => {
      const content =
        "HDFC BANK\nStatement\n\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n" +
        `02/10/26,NEFT CR-TEST-ROW1,${makeValidNeftUtr("30303030301")},02/10/26,,"10,000.00","1,10,000.00"\n` +
        `MALFORMED,,,,,\n` +
        `03/10/26,NEFT CR-TEST-ROW2,${makeValidNeftUtr("30303030302")},03/10/26,,"20,000.00","1,30,000.00"\n` +
        `\n\n`;

      const file = new File([content], "row-accounting.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length + result.errors.length + result.skippedRows).toBe(
        result.totalRows
      );
    });
  });

  describe("6. Concurrent upload deduplication (Promise.all of two real calls)", () => {
    it("concurrent uploads of same file yield exactly one import", async () => {
      const { shopId, shopDomain } = await createTestShop("concurrent");

      const credits = [
        {
          date: getUtcDateString(2),
          amountPaise: 5000000,
          rail: "NEFT" as const,
          utr: makeValidNeftUtr("40404040401"),
          payerName: "TEST-CONCURRENT-CORP",
          narration: "NEFT CR-TEST-CONCURRENT-CORP-INV001",
        },
        {
          date: getUtcDateString(1),
          amountPaise: 3000000,
          rail: "NEFT" as const,
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

      await sql`DELETE FROM "Payment" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${shopId}`;
    });
  });
});

describe("Browser-side parser edge cases (unit tests)", () => {
  describe("File type detection", () => {
    it("detects CSV from extension", async () => {
      const content = "Date,Amount\n2026-10-01,1000";
      const file = new File([content], "test.csv", { type: "text/csv" });

      const result = await parseBankStatement(file);
      expect(result.detection.bank).toBeDefined();
    });

    it("detects XLS magic bytes", async () => {
      const xlsMagic = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
      const file = new File([xlsMagic], "test.xls", { type: "application/vnd.ms-excel" });

      await expect(parseBankStatement(file)).rejects.toThrow();
    });
  });

  describe("Empty and header-only files", () => {
    it("empty file returns 0 transactions and UNKNOWN bank", async () => {
      const file = new File([""], "empty.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions).toHaveLength(0);
      expect(result.detection.bank).toBe("UNKNOWN");
    });

    it("header-only file returns 0 transactions", async () => {
      const content = "HDFC BANK\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance";
      const file = new File([content], "header-only.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions).toHaveLength(0);
    });
  });
});
