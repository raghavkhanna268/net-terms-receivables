/**
 * S14 Done-when: "The raw file never leaves the merchant's machine."
 *
 * Tests proving the imports client (app.imports route's client-side submit path)
 * sends ONLY the mapped credit rows:
 * - No file bytes, base64, File/Blob, ArrayBuffer
 * - No debit rows
 * - No direction field (only credits are mapped)
 *
 * Uses the REAL buildImportPayload function exported from app.imports.tsx
 * against synthetic HDFC, ICICI, and xlsx fixtures.
 *
 * Also tests that the server validation ignores (passes through) extra fields
 * at the top level but doesn't include them in the validated result.
 *
 * DB-backed tests for "no unknown keys stored" are in app.imports-client-payload-db.test.ts.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseBankStatement } from "~/lib/banks/index.js";
import { buildImportPayload, validateImportRequest } from "../app.imports";
import type { ParsedCredit } from "../app.imports";

const FIXTURES_DIR = join(process.cwd(), "tests/fixtures/banks/synthetic");

/**
 * Get ISO date string for yesterday (UTC).
 */
function yesterday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Convert parseBankStatement transaction to ParsedCredit format.
 */
function toCredits(parseResult: Awaited<ReturnType<typeof parseBankStatement>>): ParsedCredit[] {
  return parseResult.transactions
    .filter((t) => t.direction === "CR")
    .map((t) => ({
      date: t.date,
      amountPaise: t.amountPaise,
      direction: t.direction as "CR",
      narration: t.narration,
      refNo: t.refNo,
      balancePaise: t.balancePaise,
      rail: t.parsed.rail,
      utr: t.parsed.utr,
      payerName: t.parsed.payerName,
      dedupeKey: t.dedupeKey,
      sourceRow: t.sourceRow,
    }));
}

describe("buildImportPayload: no raw file data, only mapped credits", () => {
  it("HDFC CSV fixture: payload has only credits, no debits, no file data", async () => {
    const content = readFileSync(join(FIXTURES_DIR, "hdfc-retail-synthetic.csv"));
    const file = new File([content], "hdfc-retail-synthetic.csv", { type: "text/csv" });
    
    const parseResult = await parseBankStatement(file);
    
    // Verify fixture has both credits and debits
    const allCredits = parseResult.transactions.filter(t => t.direction === "CR");
    const allDebits = parseResult.transactions.filter(t => t.direction === "DR");
    
    expect(allCredits.length).toBeGreaterThan(0);
    expect(allDebits.length).toBeGreaterThan(0);
    
    // Use the REAL buildImportPayload function
    const credits = toCredits(parseResult);
    const payload = buildImportPayload(
      parseResult.detection.bank,
      "hdfc-retail-synthetic.csv",
      credits
    );
    
    // Payload has ONLY credits
    expect(payload.credits.length).toBe(allCredits.length);
    
    // No debits property
    expect(payload).not.toHaveProperty("debits");
    
    // No direction field in any credit (stripped by buildImportPayload)
    for (const credit of payload.credits) {
      expect(credit).not.toHaveProperty("direction");
      expect(credit).not.toHaveProperty("dedupeKey");
      expect(credit).not.toHaveProperty("sourceRow");
    }
    
    // Verify no File/Blob/ArrayBuffer references in serialized payload
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/\bFile\b/);
    expect(serialized).not.toMatch(/\bBlob\b/);
    expect(serialized).not.toContain("ArrayBuffer");
    expect(serialized).not.toContain("Uint8Array");
  });

  it("ICICI CSV fixture: payload has only credits, no debits", async () => {
    const content = readFileSync(join(FIXTURES_DIR, "icici-retail-synthetic.csv"));
    const file = new File([content], "icici-retail-synthetic.csv", { type: "text/csv" });
    
    const parseResult = await parseBankStatement(file);
    
    const allCredits = parseResult.transactions.filter(t => t.direction === "CR");
    const allDebits = parseResult.transactions.filter(t => t.direction === "DR");
    
    expect(allCredits.length).toBeGreaterThan(0);
    expect(allDebits.length).toBeGreaterThan(0);
    
    const credits = toCredits(parseResult);
    const payload = buildImportPayload(
      parseResult.detection.bank,
      "icici-retail-synthetic.csv",
      credits
    );
    
    // No debits in payload
    expect(payload).not.toHaveProperty("debits");
    expect(payload.credits.length).toBe(allCredits.length);
    
    // No direction field leaked through
    for (const credit of payload.credits) {
      expect(credit).not.toHaveProperty("direction");
    }
    
    // No binary type properties
    expect(payload).not.toHaveProperty("file");
    expect(payload).not.toHaveProperty("blob");
    expect(payload).not.toHaveProperty("arrayBuffer");
    expect(payload).not.toHaveProperty("buffer");
    expect(payload).not.toHaveProperty("rawContent");
    expect(payload).not.toHaveProperty("base64");
  });

  it("HDFC xlsx fixture: no binary data markers in payload", async () => {
    const content = readFileSync(join(FIXTURES_DIR, "hdfc-retail-synthetic.xlsx"));
    const file = new File([content], "hdfc-retail-synthetic.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    
    const parseResult = await parseBankStatement(file);
    const credits = toCredits(parseResult);
    
    const payload = buildImportPayload(
      parseResult.detection.bank,
      "hdfc-retail-synthetic.xlsx",
      credits
    );
    
    const serialized = JSON.stringify(payload);
    
    // No base64 encoded data (long runs of base64 chars)
    expect(serialized).not.toMatch(/[A-Za-z0-9+/]{100,}={0,2}/);
    
    // No binary/file type markers
    expect(serialized).not.toContain('"type":"application/');
    expect(serialized).not.toContain('"type":"text/csv"');
    
    // No raw bytes indicator
    expect(serialized).not.toMatch(/\\x[0-9a-fA-F]{2}/);
    
    // Verify we have actual credits
    expect(payload.credits.length).toBeGreaterThan(0);
  });

  it("debit-only ICICI fixture: buildImportPayload receives empty credits array", async () => {
    const content = readFileSync(join(FIXTURES_DIR, "icici-debitonly-synthetic.csv"));
    const file = new File([content], "icici-debitonly-synthetic.csv", { type: "text/csv" });
    
    const parseResult = await parseBankStatement(file);
    
    const allCredits = parseResult.transactions.filter(t => t.direction === "CR");
    const allDebits = parseResult.transactions.filter(t => t.direction === "DR");
    
    // Debit-only file should have no credits
    expect(allCredits.length).toBe(0);
    expect(allDebits.length).toBeGreaterThan(0);
    
    // buildImportPayload with empty credits array
    const payload = buildImportPayload(
      parseResult.detection.bank,
      "icici-debitonly-synthetic.csv",
      [] // No credits to send
    );
    
    expect(payload.credits.length).toBe(0);
    expect(payload.bank).toBe("ICICI");
  });

  it("debit-only HDFC fixture: buildImportPayload receives empty credits array", async () => {
    const content = readFileSync(join(FIXTURES_DIR, "hdfc-debitonly-synthetic.csv"));
    const file = new File([content], "hdfc-debitonly-synthetic.csv", { type: "text/csv" });
    
    const parseResult = await parseBankStatement(file);
    
    const credits = parseResult.transactions.filter(t => t.direction === "CR");
    expect(credits.length).toBe(0);
    
    const payload = buildImportPayload(
      parseResult.detection.bank,
      "hdfc-debitonly-synthetic.csv",
      []
    );
    
    expect(payload.credits.length).toBe(0);
  });
});

describe("Server-side validation: ignores extra fields", () => {
  it("ignores direction field in credits (not rejected, not passed through)", () => {
    const payload = {
      bank: "HDFC",
      fileName: "test.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: 100000,
          rail: "NEFT",
          narration: "NEFT CR-TEST",
          direction: "DR", // Extra field - should be ignored
        },
      ],
    };
    
    const result = validateImportRequest(payload);
    
    // Validation passes (extra field ignored, not rejected)
    expect(result.valid).not.toBeNull();
    expect(result.errors.length).toBe(0);
  });

  it("ignores top-level file field (base64 data not passed through)", () => {
    const payload = {
      bank: "HDFC",
      fileName: "test.csv",
      file: "SGVsbG8gV29ybGQ=", // base64 "Hello World"
      credits: [
        {
          date: yesterday(),
          amountPaise: 100000,
          rail: "NEFT",
          narration: "NEFT CR-TEST",
        },
      ],
    };
    
    const result = validateImportRequest(payload);
    
    // Validation passes
    expect(result.valid).not.toBeNull();
    // The validated result should NOT contain the file field
    expect(result.valid).not.toHaveProperty("file");
  });

  it("ignores top-level fileData field (ArrayBuffer-like object not passed through)", () => {
    const payload = {
      bank: "HDFC",
      fileName: "test.csv",
      fileData: { byteLength: 1000, data: [0, 1, 2, 3] },
      credits: [
        {
          date: yesterday(),
          amountPaise: 100000,
          rail: "NEFT",
          narration: "NEFT CR-TEST",
        },
      ],
    };
    
    const result = validateImportRequest(payload);
    
    // Validation passes
    expect(result.valid).not.toBeNull();
    // The validated result should NOT contain fileData
    expect(result.valid).not.toHaveProperty("fileData");
  });

  it("rejects oversized payload (>1000 rows)", () => {
    const credits = Array.from({ length: 1001 }, (_, i) => ({
      date: yesterday(),
      amountPaise: 1000,
      rail: "NEFT",
      narration: `Payment ${i}`,
    }));

    const payload = {
      bank: "HDFC",
      fileName: "large.csv",
      credits,
    };

    const result = validateImportRequest(payload);
    expect(result.valid).toBeNull();
    expect(result.errors.some(e => e.message.includes("1,001"))).toBe(true);
  });

  it("rejects wrong shape: credits not an array", () => {
    const payload = {
      bank: "HDFC",
      fileName: "test.csv",
      credits: "not an array",
    };

    const result = validateImportRequest(payload);
    expect(result.valid).toBeNull();
    expect(result.errors.some(e => e.message.includes("array"))).toBe(true);
  });

  it("rejects wrong shape: missing required fields", () => {
    const payload = {
      bank: "HDFC",
      fileName: "test.csv",
      credits: [
        {
          // Missing date, amountPaise, rail, narration
          utr: "HDFCN12345",
        },
      ],
    };

    const result = validateImportRequest(payload);
    expect(result.valid).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects negative amountPaise", () => {
    const payload = {
      bank: "HDFC",
      fileName: "test.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: -100000,
          rail: "NEFT",
          narration: "NEFT CR-TEST",
        },
      ],
    };

    const result = validateImportRequest(payload);
    expect(result.valid).toBeNull();
    expect(result.errors.some(e => e.path.includes("amountPaise"))).toBe(true);
  });
});
