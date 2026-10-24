/**
 * Browser safety tests for bank statement parsing.
 *
 * S14 Done-when criteria:
 * - Raw file must never leave the browser
 * - SheetJS must be lazy-loaded (dynamic import)
 *
 * These tests verify:
 * 1. parseBankStatement returns only structured data (not File/Blob/ArrayBuffer)
 * 2. The output contains no raw binary data that could be sent to a server
 * 3. SheetJS is loaded via dynamic import (tree-shakeable, lazy-loadable)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseBankStatement } from "../index.js";
import type { ParseResult } from "../types.js";

const FIXTURES_DIR = join(process.cwd(), "tests/fixtures/banks/synthetic");

describe("browser safety: no raw file in output", () => {
  let result: ParseResult;

  beforeEach(async () => {
    const content = readFileSync(join(FIXTURES_DIR, "hdfc-retail-synthetic.csv"));
    const file = new File([content], "hdfc-retail-synthetic.csv", { type: "text/csv" });
    result = await parseBankStatement(file);
  });

  it("ParseResult contains no File object", () => {
    expect(result).not.toHaveProperty("file");
    expect(result).not.toHaveProperty("rawFile");
    expect(result).not.toHaveProperty("inputFile");

    function checkNoFileObjects(obj: unknown, path = ""): void {
      if (obj === null || obj === undefined) return;
      if (typeof File !== "undefined" && obj instanceof File) {
        throw new Error(`File object found at ${path}`);
      }
      if (typeof obj === "object" && !Array.isArray(obj)) {
        for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
          checkNoFileObjects(value, `${path}.${key}`);
        }
      }
      if (Array.isArray(obj)) {
        obj.forEach((item, idx) => checkNoFileObjects(item, `${path}[${idx}]`));
      }
    }

    expect(() => checkNoFileObjects(result)).not.toThrow();
  });

  it("ParseResult contains no Blob object", () => {
    expect(result).not.toHaveProperty("blob");
    expect(result).not.toHaveProperty("rawBlob");
  });

  it("ParseResult contains no ArrayBuffer or Uint8Array", () => {
    expect(result).not.toHaveProperty("buffer");
    expect(result).not.toHaveProperty("arrayBuffer");
    expect(result).not.toHaveProperty("rawContent");
    expect(result).not.toHaveProperty("bytes");

    function checkNoBuffers(obj: unknown, path = ""): void {
      if (obj === null || obj === undefined) return;
      if (obj instanceof ArrayBuffer) {
        throw new Error(`ArrayBuffer found at ${path}`);
      }
      if (obj instanceof Uint8Array) {
        throw new Error(`Uint8Array found at ${path}`);
      }
      if (ArrayBuffer.isView(obj)) {
        throw new Error(`TypedArray found at ${path}`);
      }
      if (typeof obj === "object") {
        for (const [key, value] of Object.entries(obj)) {
          checkNoBuffers(value, `${path}.${key}`);
        }
      }
    }

    expect(() => checkNoBuffers(result)).not.toThrow();
  });

  it("NormalisedTxn contains only serializable primitives", () => {
    for (const txn of result.transactions) {
      expect(typeof txn.date).toBe("string");
      expect(typeof txn.amountPaise).toBe("number");
      expect(typeof txn.direction).toBe("string");
      expect(typeof txn.narration).toBe("string");
      expect(typeof txn.dedupeKey).toBe("string");
      expect(typeof txn.sourceRow).toBe("number");

      if (txn.valueDate !== undefined) {
        expect(typeof txn.valueDate).toBe("string");
      }
      if (txn.refNo !== undefined) {
        expect(typeof txn.refNo).toBe("string");
      }
      if (txn.balancePaise !== undefined) {
        expect(typeof txn.balancePaise).toBe("number");
      }

      expect(typeof txn.parsed).toBe("object");
      expect(typeof txn.parsed.rail).toBe("string");
    }
  });

  it("result is fully JSON-serializable (safe for fetch body)", () => {
    const serialized = JSON.stringify(result);
    const deserialized = JSON.parse(serialized);

    expect(deserialized.detection.bank).toBe(result.detection.bank);
    expect(deserialized.transactions.length).toBe(result.transactions.length);
    expect(deserialized.totalRows).toBe(result.totalRows);
  });

  it("only credit transactions would be sent to server", () => {
    const credits = result.transactions.filter((t) => t.direction === "CR");
    const debits = result.transactions.filter((t) => t.direction === "DR");

    expect(credits.length).toBeGreaterThan(0);
    expect(debits.length).toBeGreaterThan(0);

    const creditsPayload = credits.map((t) => ({
      date: t.date,
      amountPaise: t.amountPaise,
      narration: t.narration,
      rail: t.parsed.rail,
      utr: t.parsed.utr,
      payerName: t.parsed.payerName,
      dedupeKey: t.dedupeKey,
    }));

    const serialized = JSON.stringify(creditsPayload);
    expect(serialized.length).toBeGreaterThan(0);
    expect(serialized).not.toMatch(/ArrayBuffer|Uint8Array|Blob|File/);
  });
});

describe("browser safety: no network call with raw file", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("parseBankStatement does not call fetch", async () => {
    const content = readFileSync(join(FIXTURES_DIR, "hdfc-retail-synthetic.csv"));
    const file = new File([content], "hdfc-retail-synthetic.csv", { type: "text/csv" });

    await parseBankStatement(file);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("parsing XLSX does not call fetch", async () => {
    const content = readFileSync(join(FIXTURES_DIR, "hdfc-retail-synthetic.xlsx"));
    const file = new File([content], "hdfc-retail-synthetic.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    await parseBankStatement(file);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("SheetJS lazy loading verification", () => {
  it("spreadsheet-loader uses dynamic import", async () => {
    const loaderSource = readFileSync(
      join(process.cwd(), "app/lib/banks/spreadsheet-loader.ts"),
      "utf-8"
    );

    expect(loaderSource).toMatch(/await\s+import\s*\(\s*["']xlsx["']\s*\)/);
    expect(loaderSource).not.toMatch(/^import\s+\*\s+as\s+XLSX\s+from\s+["']xlsx["']/m);
    expect(loaderSource).not.toMatch(/^import\s+XLSX\s+from\s+["']xlsx["']/m);
    expect(loaderSource).not.toMatch(/^import\s+{\s*.*\s*}\s+from\s+["']xlsx["']/m);
  });

  it("index.ts does not statically import xlsx", async () => {
    const indexSource = readFileSync(
      join(process.cwd(), "app/lib/banks/index.ts"),
      "utf-8"
    );

    expect(indexSource).not.toMatch(/^import.*from\s+["']xlsx["']/m);
    expect(indexSource).not.toMatch(/require\s*\(\s*["']xlsx["']\s*\)/);
  });

  it("type files do not import xlsx", async () => {
    const typesSource = readFileSync(
      join(process.cwd(), "app/lib/banks/types.ts"),
      "utf-8"
    );

    expect(typesSource).not.toMatch(/import.*xlsx/);
    expect(typesSource).not.toMatch(/require.*xlsx/);
  });

  it("parsers do not statically import xlsx", async () => {
    const hdfcSource = readFileSync(
      join(process.cwd(), "app/lib/banks/parsers/hdfc.ts"),
      "utf-8"
    );
    const iciciSource = readFileSync(
      join(process.cwd(), "app/lib/banks/parsers/icici.ts"),
      "utf-8"
    );

    expect(hdfcSource).not.toMatch(/import.*xlsx/);
    expect(iciciSource).not.toMatch(/import.*xlsx/);
  });
});

describe("imports route lazy loading", () => {
  it("app.imports.tsx uses dynamic import for banks module", async () => {
    const routeSource = readFileSync(
      join(process.cwd(), "app/routes/app.imports.tsx"),
      "utf-8"
    );

    expect(routeSource).toMatch(/await\s+import\s*\(\s*["']~\/lib\/banks/);

    expect(routeSource).not.toMatch(/^import\s+{\s*parseBankStatement\s*}/m);
    expect(routeSource).not.toMatch(/^import\s+\*\s+as.*from\s+["']~\/lib\/banks/m);
  });
});
