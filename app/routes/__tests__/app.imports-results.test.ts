/**
 * Tests for bank statement import results UI (S14/S15).
 *
 * Integration tests for each bank (HDFC, SBI, Axis, ICICI):
 * - Parse the synthetic edgecases fixture client-side
 * - Send parsed result to the action using the REAL mapCreditsForImport function
 * - Assert exact imported count, skipped count, and exact ROW_PARSE_FAILED row numbers/codes
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
import {
  action,
  mapCreditsForImport,
  summarizeParseErrors,
  getErrorBadgeTone,
  getErrorDisplayMessage,
  formatErrorRowLabel,
  ERROR_CODE_MESSAGES,
} from "../app.imports";
import type { ParseErrorRow } from "../app.imports";

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
 * Build import payload from parse result using the REAL mapCreditsForImport function.
 * This ensures tests verify the exact same mapping the UI uses.
 */
function buildImportPayload(
  parseResult: ParseResult,
  fileName: string
): { payload: unknown; rawFileIncluded: boolean } {
  const credits = parseResult.transactions
    .filter((t) => t.direction === "CR")
    .map((t) => ({
      date: t.date,
      amountPaise: t.amountPaise,
      balancePaise: t.balancePaise,
      rail: t.parsed.rail,
      utr: t.parsed.utr,
      payerName: t.parsed.payerName,
      narration: t.narration,
      refNo: t.refNo,
    }));
  const mappedCredits = mapCreditsForImport(credits);

  const payload = {
    bank: parseResult.detection.bank,
    fileName,
    credits: mappedCredits,
  };

  const payloadStr = JSON.stringify(payload);
  const hasRawContent =
    payloadStr.includes("Opening Balance") ||
    payloadStr.includes("Closing Balance") ||
    payloadStr.includes("B/F") ||
    payloadStr.includes("HDFC BANK\n") ||
    payloadStr.includes("STATE BANK OF INDIA\n") ||
    payloadStr.includes("AXIS BANK LTD\n") ||
    payloadStr.includes("ICICI BANK\n") ||
    payloadStr.includes("direction") ||
    payloadStr.includes("dedupeKey") ||
    payloadStr.includes("sourceRow");

  return { payload, rawFileIncluded: hasRawContent };
}

// ============================================================================
// Helper Function Unit Tests
// ============================================================================

describe("summarizeParseErrors", () => {
  it("returns empty arrays for 0 errors", () => {
    const result = summarizeParseErrors([]);
    expect(result.initialErrors).toEqual([]);
    expect(result.overflowErrors).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.overflowCount).toBe(0);
    expect(result.hasOverflow).toBe(false);
  });

  it("returns all errors in initialErrors when exactly 10 errors", () => {
    const errors: ParseErrorRow[] = Array.from({ length: 10 }, (_, i) => ({
      row: i + 1,
      code: "ROW_PARSE_FAILED",
      message: `Error ${i}`,
    }));
    const result = summarizeParseErrors(errors);
    expect(result.initialErrors).toHaveLength(10);
    expect(result.overflowErrors).toHaveLength(0);
    expect(result.totalCount).toBe(10);
    expect(result.overflowCount).toBe(0);
    expect(result.hasOverflow).toBe(false);
  });

  it("splits errors correctly when more than 10 (11+ overflow)", () => {
    const errors: ParseErrorRow[] = Array.from({ length: 15 }, (_, i) => ({
      row: i + 1,
      code: "ROW_PARSE_FAILED",
      message: `Error ${i}`,
    }));
    const result = summarizeParseErrors(errors);
    expect(result.initialErrors).toHaveLength(10);
    expect(result.overflowErrors).toHaveLength(5);
    expect(result.totalCount).toBe(15);
    expect(result.overflowCount).toBe(5);
    expect(result.hasOverflow).toBe(true);
    expect(result.initialErrors[0].row).toBe(1);
    expect(result.overflowErrors[0].row).toBe(11);
  });

  it("respects custom initialLimit", () => {
    const errors: ParseErrorRow[] = Array.from({ length: 8 }, (_, i) => ({
      row: i + 1,
      code: "NORMALIZE_FAILED",
      message: `Error ${i}`,
    }));
    const result = summarizeParseErrors(errors, 5);
    expect(result.initialErrors).toHaveLength(5);
    expect(result.overflowErrors).toHaveLength(3);
    expect(result.hasOverflow).toBe(true);
  });
});

describe("getErrorBadgeTone", () => {
  it("returns 'warning' for NORMALIZE_FAILED", () => {
    expect(getErrorBadgeTone("NORMALIZE_FAILED")).toBe("warning");
  });

  it("returns 'critical' for ROW_PARSE_FAILED", () => {
    expect(getErrorBadgeTone("ROW_PARSE_FAILED")).toBe("critical");
  });

  it("returns 'critical' for NO_HEADER_ROW", () => {
    expect(getErrorBadgeTone("NO_HEADER_ROW")).toBe("critical");
  });

  it("returns 'critical' for COLUMN_MAP_FAILED", () => {
    expect(getErrorBadgeTone("COLUMN_MAP_FAILED")).toBe("critical");
  });

  it("returns 'critical' for UNKNOWN_BANK_FORMAT", () => {
    expect(getErrorBadgeTone("UNKNOWN_BANK_FORMAT")).toBe("critical");
  });

  it("returns 'critical' for unknown codes", () => {
    expect(getErrorBadgeTone("SOME_NEW_ERROR")).toBe("critical");
  });
});

describe("formatErrorRowLabel", () => {
  it("returns 'File-level' for row 0 (file-level errors)", () => {
    expect(formatErrorRowLabel(0)).toBe("File-level");
  });

  it("returns 'Row N' for positive row numbers", () => {
    expect(formatErrorRowLabel(1)).toBe("Row 1");
    expect(formatErrorRowLabel(10)).toBe("Row 10");
    expect(formatErrorRowLabel(100)).toBe("Row 100");
  });
});

describe("getErrorDisplayMessage", () => {
  it("returns fixed message for ROW_PARSE_FAILED", () => {
    expect(getErrorDisplayMessage("ROW_PARSE_FAILED")).toBe("Could not parse this row");
  });

  it("returns fixed message for NORMALIZE_FAILED", () => {
    expect(getErrorDisplayMessage("NORMALIZE_FAILED")).toBe("Could not normalize transaction data");
  });

  it("returns fixed message for NO_HEADER_ROW", () => {
    expect(getErrorDisplayMessage("NO_HEADER_ROW")).toBe("Could not find header row in file");
  });

  it("returns fixed message for COLUMN_MAP_FAILED", () => {
    expect(getErrorDisplayMessage("COLUMN_MAP_FAILED")).toBe("Could not map columns to expected format");
  });

  it("returns fixed message for UNKNOWN_BANK_FORMAT", () => {
    expect(getErrorDisplayMessage("UNKNOWN_BANK_FORMAT")).toBe("Unrecognized bank statement format");
  });

  it("returns 'Unknown error' for unmapped codes", () => {
    expect(getErrorDisplayMessage("SOME_NEW_ERROR")).toBe("Unknown error");
  });

  it("never returns raw parser error messages", () => {
    const rawMessages = [
      "Failed to parse row: invalid date format",
      "Could not extract amount from '1,234.56'",
      "SYNTHETIC CORP narration",
    ];
    for (const code of Object.keys(ERROR_CODE_MESSAGES)) {
      const msg = getErrorDisplayMessage(code);
      for (const raw of rawMessages) {
        expect(msg).not.toContain(raw);
      }
    }
  });
});

describe("mapCreditsForImport", () => {
  it("maps credits with all optional fields", () => {
    const credits = [
      {
        date: "2026-10-01",
        amountPaise: 100000,
        balancePaise: 500000,
        rail: "NEFT",
        utr: "HDFCN12345",
        payerName: "Test Corp",
        narration: "NEFT payment",
        refNo: "REF001",
      },
    ];
    const result = mapCreditsForImport(credits);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      date: "2026-10-01",
      amountPaise: 100000,
      balancePaise: 500000,
      rail: "NEFT",
      utr: "HDFCN12345",
      payerName: "Test Corp",
      narration: "NEFT payment",
      refNo: "REF001",
    });
  });

  it("omits undefined optional fields", () => {
    const credits = [
      {
        date: "2026-10-01",
        amountPaise: 100000,
        rail: "IMPS",
        narration: "IMPS payment",
      },
    ];
    const result = mapCreditsForImport(credits);
    expect(result[0]).not.toHaveProperty("balancePaise");
    expect(result[0]).not.toHaveProperty("utr");
    expect(result[0]).not.toHaveProperty("payerName");
    expect(result[0]).not.toHaveProperty("refNo");
  });

  it("never includes direction, dedupeKey, or sourceRow", () => {
    const credits = [
      {
        date: "2026-10-01",
        amountPaise: 100000,
        rail: "UPI",
        narration: "UPI payment",
      },
    ];
    const result = mapCreditsForImport(credits);
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain("direction");
    expect(resultStr).not.toContain("dedupeKey");
    expect(resultStr).not.toContain("sourceRow");
  });
});

// ============================================================================
// Integration Tests per Bank
// ============================================================================

describeWithDb("Import Results UI - Integration Tests per Bank", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let TEST_SHOP_DOMAIN: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    const suffix = Date.now().toString(36) + "results";
    TEST_SHOP_DOMAIN = `test-import-results-${suffix}.myshopify.com`;

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

    it("parses synthetic fixture with exact error rows", () => {
      expect(parseResult.detection.bank).toBe("HDFC");
      expect(parseResult.transactions.length).toBe(13);
      expect(parseResult.errors.length).toBe(6);

      const rowParseFailed = parseResult.errors.filter((e) => e.code === "ROW_PARSE_FAILED");
      const normalizeFailed = parseResult.errors.filter((e) => e.code === "NORMALIZE_FAILED");

      expect(rowParseFailed.map((e) => e.row)).toEqual([20, 21, 22, 30, 32]);
      expect(normalizeFailed.map((e) => e.row)).toEqual([31]);
    });

    it("sends parsed credits to action using real mapCreditsForImport, raw file never included", async () => {
      const { payload, rawFileIncluded } = buildImportPayload(parseResult, "hdfc-edgecases-synthetic.csv");

      expect(rawFileIncluded).toBe(false);

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response.status).toBe(200);

      const data = await parseResponse(response);
      expect(data.success).toBe(true);
    });

    it("action returns exact counts for credits on first import", async () => {
      const { payload } = buildImportPayload(parseResult, "hdfc-edgecases-synthetic.csv");

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      const data = await parseResponse(response);

      const creditCount = parseResult.transactions.filter((t) => t.direction === "CR").length;
      expect(data.counts?.total).toBe(creditCount);
      expect(data.counts?.inserted).toBe(creditCount);
      expect(data.counts?.duplicates).toBe(0);
    });
  });

  describe("SBI integration", () => {
    let parseResult: ParseResult;

    beforeAll(async () => {
      const content = readFileSync(join(FIXTURES_DIR, "sbi-edgecases-synthetic.csv"));
      const file = new File([content], "sbi-edgecases-synthetic.csv", { type: "text/csv" });
      parseResult = await parseBankStatement(file);
    });

    it("parses synthetic fixture with exact error rows", () => {
      expect(parseResult.detection.bank).toBe("SBI");
      expect(parseResult.transactions.length).toBe(13);
      expect(parseResult.errors.length).toBe(7);

      const rowParseFailed = parseResult.errors.filter((e) => e.code === "ROW_PARSE_FAILED");
      const normalizeFailed = parseResult.errors.filter((e) => e.code === "NORMALIZE_FAILED");

      expect(rowParseFailed.map((e) => e.row)).toEqual([20, 21, 22, 30, 31, 33]);
      expect(normalizeFailed.map((e) => e.row)).toEqual([32]);
    });

    it("sends parsed credits to action using real mapCreditsForImport, raw file never included", async () => {
      const { payload, rawFileIncluded } = buildImportPayload(parseResult, "sbi-edgecases-synthetic.csv");

      expect(rawFileIncluded).toBe(false);

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response.status).toBe(200);

      const data = await parseResponse(response);
      expect(data.success).toBe(true);
    });

    it("action returns exact counts for credits on first import", async () => {
      const { payload } = buildImportPayload(parseResult, "sbi-edgecases-synthetic.csv");

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      const data = await parseResponse(response);

      const creditCount = parseResult.transactions.filter((t) => t.direction === "CR").length;
      expect(data.counts?.total).toBe(creditCount);
      expect(data.counts?.inserted).toBe(creditCount);
      expect(data.counts?.duplicates).toBe(0);
    });
  });

  describe("Axis integration", () => {
    let parseResult: ParseResult;

    beforeAll(async () => {
      const content = readFileSync(join(FIXTURES_DIR, "axis-edgecases-synthetic.csv"));
      const file = new File([content], "axis-edgecases-synthetic.csv", { type: "text/csv" });
      parseResult = await parseBankStatement(file);
    });

    it("parses synthetic fixture with exact error rows", () => {
      expect(parseResult.detection.bank).toBe("AXIS");
      expect(parseResult.transactions.length).toBe(13);
      expect(parseResult.errors.length).toBe(7);

      const rowParseFailed = parseResult.errors.filter((e) => e.code === "ROW_PARSE_FAILED");
      const normalizeFailed = parseResult.errors.filter((e) => e.code === "NORMALIZE_FAILED");

      expect(rowParseFailed.map((e) => e.row)).toEqual([20, 21, 22, 30, 31, 33]);
      expect(normalizeFailed.map((e) => e.row)).toEqual([32]);
    });

    it("sends parsed credits to action using real mapCreditsForImport, raw file never included", async () => {
      const { payload, rawFileIncluded } = buildImportPayload(parseResult, "axis-edgecases-synthetic.csv");

      expect(rawFileIncluded).toBe(false);

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response.status).toBe(200);

      const data = await parseResponse(response);
      expect(data.success).toBe(true);
    });

    it("action returns exact counts for credits on first import", async () => {
      const { payload } = buildImportPayload(parseResult, "axis-edgecases-synthetic.csv");

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      const data = await parseResponse(response);

      const creditCount = parseResult.transactions.filter((t) => t.direction === "CR").length;
      expect(data.counts?.total).toBe(creditCount);
      expect(data.counts?.inserted).toBe(creditCount);
      expect(data.counts?.duplicates).toBe(0);
    });
  });

  describe("ICICI integration", () => {
    let parseResult: ParseResult;

    beforeAll(async () => {
      const content = readFileSync(join(FIXTURES_DIR, "icici-edgecases-synthetic.csv"));
      const file = new File([content], "icici-edgecases-synthetic.csv", { type: "text/csv" });
      parseResult = await parseBankStatement(file);
    });

    it("parses synthetic fixture with exact error rows", () => {
      expect(parseResult.detection.bank).toBe("ICICI");
      expect(parseResult.transactions.length).toBe(13);
      expect(parseResult.errors.length).toBe(3);

      const rowParseFailed = parseResult.errors.filter((e) => e.code === "ROW_PARSE_FAILED");
      const normalizeFailed = parseResult.errors.filter((e) => e.code === "NORMALIZE_FAILED");

      expect(rowParseFailed.map((e) => e.row)).toEqual([20, 21]);
      expect(normalizeFailed.map((e) => e.row)).toEqual([19]);
    });

    it("sends parsed credits to action using real mapCreditsForImport, raw file never included", async () => {
      const { payload, rawFileIncluded } = buildImportPayload(parseResult, "icici-edgecases-synthetic.csv");

      expect(rawFileIncluded).toBe(false);

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      expect(response.status).toBe(200);

      const data = await parseResponse(response);
      expect(data.success).toBe(true);
    });

    it("action returns exact counts for credits on first import", async () => {
      const { payload } = buildImportPayload(parseResult, "icici-edgecases-synthetic.csv");

      const response = await callAction(sql, TEST_SHOP_DOMAIN, payload);
      const data = await parseResponse(response);

      const creditCount = parseResult.transactions.filter((t) => t.direction === "CR").length;
      expect(data.counts?.total).toBe(creditCount);
      expect(data.counts?.inserted).toBe(creditCount);
      expect(data.counts?.duplicates).toBe(0);
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

  describe("retail fixture errors", () => {
    it("HDFC retail fixture has exactly 1 error at row 27", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-retail-synthetic.csv"));
      const file = new File([content], "hdfc-retail-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.errors.length).toBe(1);
      expect(result.errors[0].row).toBe(27);
      expect(result.errors[0].code).toBe("ROW_PARSE_FAILED");
    });
  });

  describe("error message safety", () => {
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
    it(`${bank.name}: payload uses real mapCreditsForImport and excludes internal fields`, async () => {
      const content = readFileSync(join(FIXTURES_DIR, bank.file));
      const file = new File([content], bank.file, { type: "text/csv" });
      const result = await parseBankStatement(file);

      const { payload, rawFileIncluded } = buildImportPayload(result, bank.file);
      expect(rawFileIncluded).toBe(false);

      const p = payload as { bank: string; fileName: string; credits: unknown[] };
      expect(p.bank).toBe(result.detection.bank);
      expect(p.fileName).toBe(bank.file);

      for (const credit of p.credits as Record<string, unknown>[]) {
        expect(credit).toHaveProperty("date");
        expect(credit).toHaveProperty("amountPaise");
        expect(credit).toHaveProperty("rail");
        expect(credit).toHaveProperty("narration");

        expect(credit).not.toHaveProperty("direction");
        expect(credit).not.toHaveProperty("dedupeKey");
        expect(credit).not.toHaveProperty("sourceRow");
        expect(credit).not.toHaveProperty("rawFile");
        expect(credit).not.toHaveProperty("rawContent");
      }
    });
  }
});
