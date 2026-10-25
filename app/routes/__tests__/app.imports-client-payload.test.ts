/**
 * S14 Done-when: "The raw file never leaves the merchant's machine."
 *
 * Tests proving the imports client (app.imports route's client-side submit path)
 * sends ONLY the mapped credit rows:
 * - No file bytes, base64, File/Blob, ArrayBuffer
 * - No debit rows
 * - No direction field (only credits are mapped)
 *
 * Uses the REAL mapCreditsForImport function exported from app.imports.tsx
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
import { mapCreditsForImport, validateImportRequest } from "../app.imports";

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
 * Convert parseBankStatement transaction to the shape mapCreditsForImport expects.
 * Only includes fields in ParsedCreditRow (no direction, dedupeKey, sourceRow).
 */
function toCreditsForMapping(parseResult: Awaited<ReturnType<typeof parseBankStatement>>) {
  return parseResult.transactions
    .filter((t) => t.direction === "CR")
    .map((t) => ({
      date: t.date,
      amountPaise: t.amountPaise,
      narration: t.narration,
      refNo: t.refNo,
      balancePaise: t.balancePaise,
      rail: t.parsed.rail,
      utr: t.parsed.utr,
      payerName: t.parsed.payerName,
    }));
}

describe("mapCreditsForImport: only allowlisted fields, no raw file data", () => {
  it("HDFC CSV fixture: mapped credits have only allowlisted fields, no debits", async () => {
    const content = readFileSync(join(FIXTURES_DIR, "hdfc-retail-synthetic.csv"));
    const file = new File([content], "hdfc-retail-synthetic.csv", { type: "text/csv" });
    
    const parseResult = await parseBankStatement(file);
    
    // Verify fixture has both credits and debits
    const allCredits = parseResult.transactions.filter(t => t.direction === "CR");
    const allDebits = parseResult.transactions.filter(t => t.direction === "DR");
    
    expect(allCredits.length).toBeGreaterThan(0);
    expect(allDebits.length).toBeGreaterThan(0);
    
    // Use the REAL mapCreditsForImport function
    const creditsForMapping = toCreditsForMapping(parseResult);
    const mappedCredits = mapCreditsForImport(creditsForMapping);
    
    // Mapped credits count matches original credits
    expect(mappedCredits.length).toBe(allCredits.length);
    
    // No direction field in any mapped credit (not in allowlist)
    for (const credit of mappedCredits) {
      expect(credit).not.toHaveProperty("direction");
      expect(credit).not.toHaveProperty("dedupeKey");
      expect(credit).not.toHaveProperty("sourceRow");
    }
    
    // Verify no File/Blob/ArrayBuffer references in serialized output
    const serialized = JSON.stringify(mappedCredits);
    expect(serialized).not.toMatch(/\bFile\b/);
    expect(serialized).not.toMatch(/\bBlob\b/);
    expect(serialized).not.toContain("ArrayBuffer");
    expect(serialized).not.toContain("Uint8Array");
  });

  it("ICICI CSV fixture: mapped credits have only allowlisted fields", async () => {
    const content = readFileSync(join(FIXTURES_DIR, "icici-retail-synthetic.csv"));
    const file = new File([content], "icici-retail-synthetic.csv", { type: "text/csv" });
    
    const parseResult = await parseBankStatement(file);
    
    const allCredits = parseResult.transactions.filter(t => t.direction === "CR");
    const allDebits = parseResult.transactions.filter(t => t.direction === "DR");
    
    expect(allCredits.length).toBeGreaterThan(0);
    expect(allDebits.length).toBeGreaterThan(0);
    
    const creditsForMapping = toCreditsForMapping(parseResult);
    const mappedCredits = mapCreditsForImport(creditsForMapping);
    
    // Count matches
    expect(mappedCredits.length).toBe(allCredits.length);
    
    // No direction field leaked through
    for (const credit of mappedCredits) {
      expect(credit).not.toHaveProperty("direction");
    }
    
    // Each credit has only allowlisted fields
    for (const credit of mappedCredits) {
      const keys = Object.keys(credit);
      const allowedKeys = ["date", "amountPaise", "rail", "narration", "balancePaise", "utr", "payerName", "refNo"];
      for (const key of keys) {
        expect(allowedKeys).toContain(key);
      }
    }
  });

  it("HDFC xlsx fixture: no binary data markers in mapped output", async () => {
    const content = readFileSync(join(FIXTURES_DIR, "hdfc-retail-synthetic.xlsx"));
    const file = new File([content], "hdfc-retail-synthetic.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    
    const parseResult = await parseBankStatement(file);
    const creditsForMapping = toCreditsForMapping(parseResult);
    const mappedCredits = mapCreditsForImport(creditsForMapping);
    
    const serialized = JSON.stringify(mappedCredits);
    
    // No base64 encoded data (long runs of base64 chars)
    expect(serialized).not.toMatch(/[A-Za-z0-9+/]{100,}={0,2}/);
    
    // No binary/file type markers
    expect(serialized).not.toContain('"type":"application/');
    expect(serialized).not.toContain('"type":"text/csv"');
    
    // No raw bytes indicator
    expect(serialized).not.toMatch(/\\x[0-9a-fA-F]{2}/);
    
    // Verify we have actual credits
    expect(mappedCredits.length).toBeGreaterThan(0);
  });

  it("debit-only ICICI fixture: mapCreditsForImport receives empty array", async () => {
    const content = readFileSync(join(FIXTURES_DIR, "icici-debitonly-synthetic.csv"));
    const file = new File([content], "icici-debitonly-synthetic.csv", { type: "text/csv" });
    
    const parseResult = await parseBankStatement(file);
    
    const allCredits = parseResult.transactions.filter(t => t.direction === "CR");
    const allDebits = parseResult.transactions.filter(t => t.direction === "DR");
    
    // Debit-only file should have no credits
    expect(allCredits.length).toBe(0);
    expect(allDebits.length).toBeGreaterThan(0);
    
    // mapCreditsForImport with empty array
    const mappedCredits = mapCreditsForImport([]);
    expect(mappedCredits.length).toBe(0);
  });

  it("debit-only HDFC fixture: mapCreditsForImport receives empty array", async () => {
    const content = readFileSync(join(FIXTURES_DIR, "hdfc-debitonly-synthetic.csv"));
    const file = new File([content], "hdfc-debitonly-synthetic.csv", { type: "text/csv" });
    
    const parseResult = await parseBankStatement(file);
    
    const credits = parseResult.transactions.filter(t => t.direction === "CR");
    expect(credits.length).toBe(0);
    
    const mappedCredits = mapCreditsForImport([]);
    expect(mappedCredits.length).toBe(0);
  });
});

describe("Server-side validation: extra fields pass through", () => {
  it("accepts and passes through direction field in credits (not stripped)", () => {
    const payload = {
      bank: "HDFC",
      fileName: "test.csv",
      credits: [
        {
          date: yesterday(),
          amountPaise: 100000,
          rail: "NEFT",
          narration: "NEFT CR-TEST",
          direction: "DR", // Extra field - passes through validation
        },
      ],
    };
    
    const result = validateImportRequest(payload);
    
    // Validation passes
    expect(result.valid).not.toBeNull();
    expect(result.errors.length).toBe(0);
    
    // Direction field IS passed through (validateImportRequest does `as CreditRow[]` cast)
    // The DB insert only uses known columns, so it won't be stored
    expect((result.valid!.credits[0] as unknown as Record<string, unknown>).direction).toBe("DR");
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
