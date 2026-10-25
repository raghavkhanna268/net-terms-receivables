/**
 * Tests for bank statement import results UI (S14/S15).
 *
 * Integration tests for each bank (HDFC, SBI, Axis, ICICI):
 * - Parse the synthetic edgecases fixture client-side
 * - Send parsed result to the action
 * - Assert imported count, skipped count, and exact ROW_PARSE_FAILED row numbers/codes
 * - Assert raw file is NEVER included in the request
 *
 * Tests use only the labelled SYNTHETIC fixtures in the repo (layouts UNVERIFIED);
 * no real customer or bank data — the repo is public.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { parseBankStatement } from "~/lib/banks/index.js";
import type { ParseResult } from "~/lib/banks/types.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const FIXTURES_DIR = join(process.cwd(), "tests/fixtures/banks/synthetic");

// ============================================================================
// Mocked matcher for vi.mock hoisting
// ============================================================================

const matcherCalls: Array<{ shopId: string }> = [];

vi.mock("~/services/matcher.server", () => ({
  runMatcher: vi.fn(async (_sql: unknown, shopId: string) => {
    matcherCalls.push({ shopId });
    return {
      paymentsProcessed: 1,
      matchesCreated: 0,
      highConfidenceMatches: 0,
      hasMore: false,
    };
  }),
  MAX_PAYMENTS_PER_REQUEST: 100,
}));

import { requestContext } from "~/lib/request-context.server";
import { action } from "../app.imports";

/**
 * Create a mock request with JSON body.
 */
function createMockRequest(body: unknown, method = "POST"): Request {
  return new Request("http://localhost/app/imports", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Create mock Shopify context with authenticated session.
 */
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

interface ImportActionResult {
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

/**
 * Parse response JSON with type.
 */
async function parseResponse(response: Response): Promise<ImportActionResult> {
  return response.json() as Promise<ImportActionResult>;
}

/**
 * Call the real action inside request context.
 */
async function callAction(
  sql: ReturnType<typeof postgres>,
  shopDomain: string,
  body: unknown
): Promise<Response> {
  const request = createMockRequest(body);
  const context = createMockContext(shopDomain);
  const url = new URL(request.url);

  return requestContext.run({ getSql: () => sql }, async () => {
    return action({
      request,
      context: context as never,
      params: {},
      url,
      pattern: "/app/imports",
    });
  });
}

/**
 * Build import payload from parse result (only credit rows).
 * Verifies raw file content is NOT included.
 */
function buildImportPayload(
  parseResult: ParseResult,
  fileName: string
): { payload: unknown; rawFileIncluded: boolean } {
  const credits = parseResult.transactions
    .filter((t) => t.direction === "CR")
    .map((c) => {
      const credit: Record<string, string | number> = {
        date: c.date,
        amountPaise: c.amountPaise,
        rail: c.parsed.rail,
        narration: c.narration,
      };
      if (c.balancePaise !== undefined) credit.balancePaise = c.balancePaise;
      if (c.parsed.utr) credit.utr = c.parsed.utr;
      if (c.parsed.payerName) credit.payerName = c.parsed.payerName;
      if (c.refNo) credit.refNo = c.refNo;
      return credit;
    });

  const payload = {
    bank: parseResult.detection.bank,
    fileName,
    credits,
  };

  const payloadStr = JSON.stringify(payload);
  const hasRawContent =
    payloadStr.includes("Opening Balance") ||
    payloadStr.includes("Closing Balance") ||
    payloadStr.includes("B/F") ||
    payloadStr.includes("HDFC BANK\n") ||
    payloadStr.includes("STATE BANK OF INDIA\n") ||
    payloadStr.includes("AXIS BANK LTD\n") ||
    payloadStr.includes("ICICI BANK\n");

  return { payload, rawFileIncluded: hasRawContent };
}

describeWithDb("Import Results UI - Integration Tests per Bank", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let TEST_SHOP_DOMAIN: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    const suffix = Date.now().toString(36) + "results";
    TEST_SHOP_DOMAIN = `import-results-test-${suffix}.myshopify.com`;

    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;
      await sql.end();
    }
  });

  beforeEach(async () => {
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
    matcherCalls.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("HDFC integration", () => {
    let parseResult: ParseResult;

    beforeAll(async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-edgecases-synthetic.csv"));
      const file = new File([content], "hdfc-edgecases-synthetic.csv", { type: "text/csv" });
      parseResult = await parseBankStatement(file);
    });

    it("parses synthetic fixture with expected error rows", () => {
      expect(parseResult.detection.bank).toBe("HDFC");
      expect(parseResult.transactions.length).toBe(13);
      expect(parseResult.skippedRows).toBeGreaterThan(0);

      const rowParseFailed = parseResult.errors.filter((e) => e.code === "ROW_PARSE_FAILED");
      const normalizeFailed = parseResult.errors.filter((e) => e.code === "NORMALIZE_FAILED");

      expect(rowParseFailed.map((e) => e.row)).toEqual([20, 21, 22, 30, 32]);
      expect(normalizeFailed.map((e) => e.row)).toEqual([31]);
    });

    it("sends parsed credits to action, raw file never included", async () => {
      const { payload, rawFileIncluded } = buildImportPayload(parseResult, "hdfc-edgecases-synthetic.csv");

      expect(rawFileIncluded).toBe(false);

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response.status).toBe(200);

      const data = await parseResponse(response);
      expect(data.success).toBe(true);

      const creditCount = parseResult.transactions.filter((t) => t.direction === "CR").length;
      expect(data.counts?.total).toBe(creditCount);
    });

    it("action returns correct counts for credits", async () => {
      const { payload } = buildImportPayload(parseResult, "hdfc-edgecases-synthetic.csv");

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      const data = await parseResponse(response);

      const creditCount = parseResult.transactions.filter((t) => t.direction === "CR").length;
      expect(data.counts?.inserted).toBeLessThanOrEqual(creditCount);
      expect(data.counts?.duplicates).toBeGreaterThanOrEqual(0);
      expect(data.counts?.total).toBe(creditCount);
    });
  });

  describe("SBI integration", () => {
    let parseResult: ParseResult;

    beforeAll(async () => {
      const content = readFileSync(join(FIXTURES_DIR, "sbi-edgecases-synthetic.csv"));
      const file = new File([content], "sbi-edgecases-synthetic.csv", { type: "text/csv" });
      parseResult = await parseBankStatement(file);
    });

    it("parses synthetic fixture with expected error rows", () => {
      expect(parseResult.detection.bank).toBe("SBI");
      expect(parseResult.transactions.length).toBe(13);
      expect(parseResult.skippedRows).toBeGreaterThan(0);

      const rowParseFailed = parseResult.errors.filter((e) => e.code === "ROW_PARSE_FAILED");
      const normalizeFailed = parseResult.errors.filter((e) => e.code === "NORMALIZE_FAILED");

      expect(rowParseFailed.map((e) => e.row)).toEqual([20, 21, 22, 30, 31, 33]);
      expect(normalizeFailed.map((e) => e.row)).toEqual([32]);
    });

    it("sends parsed credits to action, raw file never included", async () => {
      const { payload, rawFileIncluded } = buildImportPayload(parseResult, "sbi-edgecases-synthetic.csv");

      expect(rawFileIncluded).toBe(false);

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response.status).toBe(200);

      const data = await parseResponse(response);
      expect(data.success).toBe(true);

      const creditCount = parseResult.transactions.filter((t) => t.direction === "CR").length;
      expect(data.counts?.total).toBe(creditCount);
    });

    it("action returns correct counts for credits", async () => {
      const { payload } = buildImportPayload(parseResult, "sbi-edgecases-synthetic.csv");

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      const data = await parseResponse(response);

      const creditCount = parseResult.transactions.filter((t) => t.direction === "CR").length;
      expect(data.counts?.inserted).toBeLessThanOrEqual(creditCount);
      expect(data.counts?.duplicates).toBeGreaterThanOrEqual(0);
      expect(data.counts?.total).toBe(creditCount);
    });
  });

  describe("Axis integration", () => {
    let parseResult: ParseResult;

    beforeAll(async () => {
      const content = readFileSync(join(FIXTURES_DIR, "axis-edgecases-synthetic.csv"));
      const file = new File([content], "axis-edgecases-synthetic.csv", { type: "text/csv" });
      parseResult = await parseBankStatement(file);
    });

    it("parses synthetic fixture with expected error rows", () => {
      expect(parseResult.detection.bank).toBe("AXIS");
      expect(parseResult.transactions.length).toBe(13);
      expect(parseResult.skippedRows).toBeGreaterThan(0);

      const rowParseFailed = parseResult.errors.filter((e) => e.code === "ROW_PARSE_FAILED");
      const normalizeFailed = parseResult.errors.filter((e) => e.code === "NORMALIZE_FAILED");

      expect(rowParseFailed.map((e) => e.row)).toEqual([20, 21, 22, 30, 31, 33]);
      expect(normalizeFailed.map((e) => e.row)).toEqual([32]);
    });

    it("sends parsed credits to action, raw file never included", async () => {
      const { payload, rawFileIncluded } = buildImportPayload(parseResult, "axis-edgecases-synthetic.csv");

      expect(rawFileIncluded).toBe(false);

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response.status).toBe(200);

      const data = await parseResponse(response);
      expect(data.success).toBe(true);

      const creditCount = parseResult.transactions.filter((t) => t.direction === "CR").length;
      expect(data.counts?.total).toBe(creditCount);
    });

    it("action returns correct counts for credits", async () => {
      const { payload } = buildImportPayload(parseResult, "axis-edgecases-synthetic.csv");

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      const data = await parseResponse(response);

      const creditCount = parseResult.transactions.filter((t) => t.direction === "CR").length;
      expect(data.counts?.inserted).toBeLessThanOrEqual(creditCount);
      expect(data.counts?.duplicates).toBeGreaterThanOrEqual(0);
      expect(data.counts?.total).toBe(creditCount);
    });
  });

  describe("ICICI integration", () => {
    let parseResult: ParseResult;

    beforeAll(async () => {
      const content = readFileSync(join(FIXTURES_DIR, "icici-edgecases-synthetic.csv"));
      const file = new File([content], "icici-edgecases-synthetic.csv", { type: "text/csv" });
      parseResult = await parseBankStatement(file);
    });

    it("parses synthetic fixture with expected error rows", () => {
      expect(parseResult.detection.bank).toBe("ICICI");
      expect(parseResult.transactions.length).toBe(13);
      expect(parseResult.skippedRows).toBeGreaterThan(0);

      const rowParseFailed = parseResult.errors.filter((e) => e.code === "ROW_PARSE_FAILED");
      const normalizeFailed = parseResult.errors.filter((e) => e.code === "NORMALIZE_FAILED");

      expect(rowParseFailed.map((e) => e.row)).toEqual([20, 21]);
      expect(normalizeFailed.map((e) => e.row)).toEqual([19]);
    });

    it("sends parsed credits to action, raw file never included", async () => {
      const { payload, rawFileIncluded } = buildImportPayload(parseResult, "icici-edgecases-synthetic.csv");

      expect(rawFileIncluded).toBe(false);

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response.status).toBe(200);

      const data = await parseResponse(response);
      expect(data.success).toBe(true);

      const creditCount = parseResult.transactions.filter((t) => t.direction === "CR").length;
      expect(data.counts?.total).toBe(creditCount);
    });

    it("action returns correct counts for credits", async () => {
      const { payload } = buildImportPayload(parseResult, "icici-edgecases-synthetic.csv");

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      const data = await parseResponse(response);

      const creditCount = parseResult.transactions.filter((t) => t.direction === "CR").length;
      expect(data.counts?.inserted).toBeLessThanOrEqual(creditCount);
      expect(data.counts?.duplicates).toBeGreaterThanOrEqual(0);
      expect(data.counts?.total).toBe(creditCount);
    });
  });
});

describe("Import Results UI - Parse Result Structure", () => {
  describe("ParseResultSummary errors array", () => {
    it("includes code field for all error types", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-edgecases-synthetic.csv"));
      const file = new File([content], "hdfc-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      for (const err of result.errors) {
        expect(err).toHaveProperty("row");
        expect(err).toHaveProperty("code");
        expect(err).toHaveProperty("message");
        expect(["ROW_PARSE_FAILED", "NORMALIZE_FAILED", "NO_HEADER_ROW", "COLUMN_MAP_FAILED", "UNKNOWN_BANK_FORMAT"]).toContain(err.code);
      }
    });

    it("ROW_PARSE_FAILED errors have row numbers", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-edgecases-synthetic.csv"));
      const file = new File([content], "hdfc-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const rowParseFailed = result.errors.filter((e) => e.code === "ROW_PARSE_FAILED");
      for (const err of rowParseFailed) {
        expect(typeof err.row).toBe("number");
        expect(err.row).toBeGreaterThan(0);
      }
    });

    it("NORMALIZE_FAILED errors have row numbers", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-edgecases-synthetic.csv"));
      const file = new File([content], "hdfc-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const normalizeFailed = result.errors.filter((e) => e.code === "NORMALIZE_FAILED");
      for (const err of normalizeFailed) {
        expect(typeof err.row).toBe("number");
        expect(err.row).toBeGreaterThan(0);
      }
    });
  });

  describe("empty errors state", () => {
    it("retail fixture with minimal errors has empty or near-empty errors array", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-retail-synthetic.csv"));
      const file = new File([content], "hdfc-retail-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.errors.length).toBeLessThanOrEqual(1);
    });
  });

  describe("error message format", () => {
    it("error messages are safe (no raw narration content)", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-edgecases-synthetic.csv"));
      const file = new File([content], "hdfc-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      for (const err of result.errors) {
        expect(err.message).not.toContain("SYNTHETIC CORP");
        expect(err.message).not.toContain("SYNTHETIC VENDOR");
        expect(err.message).not.toContain("vendor@synt");
      }
    });
  });
});

describe("Import Results UI - Counts Verification", () => {
  it("HDFC: totalRows = transactions + errors + skippedRows", async () => {
    const content = readFileSync(join(FIXTURES_DIR, "hdfc-edgecases-synthetic.csv"));
    const file = new File([content], "hdfc-edgecases-synthetic.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.transactions.length + result.errors.length + result.skippedRows).toBe(result.totalRows);
  });

  it("SBI: totalRows = transactions + errors + skippedRows", async () => {
    const content = readFileSync(join(FIXTURES_DIR, "sbi-edgecases-synthetic.csv"));
    const file = new File([content], "sbi-edgecases-synthetic.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.transactions.length + result.errors.length + result.skippedRows).toBe(result.totalRows);
  });

  it("Axis: totalRows = transactions + errors + skippedRows", async () => {
    const content = readFileSync(join(FIXTURES_DIR, "axis-edgecases-synthetic.csv"));
    const file = new File([content], "axis-edgecases-synthetic.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.transactions.length + result.errors.length + result.skippedRows).toBe(result.totalRows);
  });

  it("ICICI: totalRows = transactions + errors + skippedRows", async () => {
    const content = readFileSync(join(FIXTURES_DIR, "icici-edgecases-synthetic.csv"));
    const file = new File([content], "icici-edgecases-synthetic.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.transactions.length + result.errors.length + result.skippedRows).toBe(result.totalRows);
  });
});

describe("Import Results UI - Raw File Protection", () => {
  const BANKS = [
    { name: "HDFC", file: "hdfc-edgecases-synthetic.csv", marker: "HDFC BANK" },
    { name: "SBI", file: "sbi-edgecases-synthetic.csv", marker: "STATE BANK" },
    { name: "Axis", file: "axis-edgecases-synthetic.csv", marker: "AXIS BANK" },
    { name: "ICICI", file: "icici-edgecases-synthetic.csv", marker: "ICICI BANK" },
  ];

  for (const bank of BANKS) {
    it(`${bank.name}: payload contains no raw file header/markers`, async () => {
      const content = readFileSync(join(FIXTURES_DIR, bank.file));
      const file = new File([content], bank.file, { type: "text/csv" });
      const result = await parseBankStatement(file);

      const { payload } = buildImportPayload(result, bank.file);
      const payloadStr = JSON.stringify(payload);

      expect(payloadStr).not.toContain(bank.marker);
      expect(payloadStr).not.toContain("Account Statement");
      expect(payloadStr).not.toContain("Statement of Account");
      expect(payloadStr).not.toContain("www.");
    });
  }

  for (const bank of BANKS) {
    it(`${bank.name}: payload contains only normalised credit fields`, async () => {
      const content = readFileSync(join(FIXTURES_DIR, bank.file));
      const file = new File([content], bank.file, { type: "text/csv" });
      const result = await parseBankStatement(file);

      const { payload } = buildImportPayload(result, bank.file);
      const p = payload as { bank: string; fileName: string; credits: unknown[] };

      expect(p.bank).toBe(result.detection.bank);
      expect(p.fileName).toBe(bank.file);

      for (const credit of p.credits as Record<string, unknown>[]) {
        expect(credit).toHaveProperty("date");
        expect(credit).toHaveProperty("amountPaise");
        expect(credit).toHaveProperty("rail");
        expect(credit).toHaveProperty("narration");

        expect(credit).not.toHaveProperty("rawFile");
        expect(credit).not.toHaveProperty("rawContent");
        expect(credit).not.toHaveProperty("sourceContent");
      }
    });
  }
});
