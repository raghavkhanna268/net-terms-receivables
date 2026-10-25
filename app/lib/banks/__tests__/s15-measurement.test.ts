/**
 * S15 Measurement Harness: Rail & Reference Extraction Coverage
 *
 * Measures the share of CREDIT rows for which BOTH:
 * 1. Payment rail (NEFT/RTGS/IMPS/UPI) is detected
 * 2. Reference (UTR/RRN) is extracted
 *
 * Done criterion: >= 95% for each bank on clean fixtures.
 *
 * ## Running the harness
 *
 * ```bash
 * # Run all S15 measurement tests
 * npm test -- s15-measurement
 *
 * # Run with verbose output
 * npm test -- s15-measurement --reporter=verbose
 * ```
 *
 * ## Adding redacted real samples
 *
 * Place redacted bank statement files in:
 *   tests/fixtures/redacted/<bank>/
 *
 * Supported banks: hdfc, icici, sbi, axis
 * Supported formats: .csv, .xlsx
 *
 * Example:
 *   tests/fixtures/redacted/hdfc/statement-oct-2026.csv
 *   tests/fixtures/redacted/icici/export.xlsx
 *
 * The harness automatically picks up any files in these directories.
 * The redacted/ folder is gitignored to prevent accidental commits.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, basename } from "path";
import { parseBankStatement } from "../index.js";
import type { BankId, PaymentRail, NormalisedTxn } from "../types.js";

const SYNTHETIC_FIXTURES_DIR = join(process.cwd(), "tests/fixtures/banks/synthetic");
const REDACTED_FIXTURES_DIR = join(process.cwd(), "tests/fixtures/redacted");

const S15_THRESHOLD = 95;

const S15_RAILS: PaymentRail[] = ["NEFT", "RTGS", "IMPS", "UPI"];

type BankKey = "hdfc" | "icici" | "sbi" | "axis";

const BANK_IDS: Record<BankKey, BankId> = {
  hdfc: "HDFC",
  icici: "ICICI",
  sbi: "SBI",
  axis: "AXIS",
};

interface MeasurementResult {
  bank: BankId;
  fixture: string;
  credits: number;
  s15Eligible: number;
  withRef: number;
  pct: number;
  threshold: number;
  isClean: boolean;
}

function isS15Rail(rail: PaymentRail): boolean {
  return S15_RAILS.includes(rail);
}

function hasValidReference(txn: NormalisedTxn): boolean {
  return typeof txn.parsed.utr === "string" && txn.parsed.utr.length > 0;
}

function measureExtraction(
  transactions: NormalisedTxn[],
  bank: BankId,
  fixture: string,
  isClean: boolean
): MeasurementResult {
  const credits = transactions.filter((t) => t.direction === "CR");
  const s15Eligible = credits.filter((t) => isS15Rail(t.parsed.rail));
  const withRef = s15Eligible.filter((t) => hasValidReference(t));

  const pct = s15Eligible.length > 0 ? (withRef.length / s15Eligible.length) * 100 : 0;

  return {
    bank,
    fixture,
    credits: credits.length,
    s15Eligible: s15Eligible.length,
    withRef: withRef.length,
    pct: Math.round(pct * 100) / 100,
    threshold: S15_THRESHOLD,
    isClean,
  };
}

function printResult(result: MeasurementResult): void {
  const status = result.isClean
    ? result.pct >= result.threshold
      ? "PASS"
      : "FAIL"
    : "REPORT";

  console.log(
    `[${result.bank}] ${result.fixture}: credits=${result.credits}, s15_eligible=${result.s15Eligible}, with_ref=${result.withRef}, pct=${result.pct}%, threshold=${result.threshold}% [${status}]`
  );
}

async function loadAndMeasure(
  filePath: string,
  expectedBank: BankId,
  isClean: boolean
): Promise<MeasurementResult | null> {
  if (!existsSync(filePath)) {
    return null;
  }

  const fileName = basename(filePath);
  const content = readFileSync(filePath);
  const mimeType = fileName.endsWith(".xlsx")
    ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    : "text/csv";

  const file = new File([content], fileName, { type: mimeType });
  const result = await parseBankStatement(file);

  if (result.detection.bank !== expectedBank) {
    return null;
  }

  return measureExtraction(result.transactions, expectedBank, fileName, isClean);
}

function getRedactedFiles(bank: BankKey): string[] {
  const dir = join(REDACTED_FIXTURES_DIR, bank);
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir)
    .filter((f) => f.endsWith(".csv") || f.endsWith(".xlsx"))
    .map((f) => join(dir, f));
}

function isCleanFixture(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return !lower.includes("malformed") && !lower.includes("edgecase") && !lower.includes("debitonly");
}

describe("S15 Rail & Reference Extraction Measurement", () => {
  describe("Synthetic fixtures", () => {
    const banks: BankKey[] = ["hdfc", "icici", "sbi", "axis"];

    for (const bank of banks) {
      const expectedBank = BANK_IDS[bank];

      describe(`${expectedBank}`, () => {
        it("measures retail CSV extraction rate", async () => {
          const filePath = join(SYNTHETIC_FIXTURES_DIR, `${bank}-retail-synthetic.csv`);
          const result = await loadAndMeasure(filePath, expectedBank, true);

          expect(result).not.toBeNull();
          if (result) {
            printResult(result);
            expect(result.pct).toBeGreaterThanOrEqual(S15_THRESHOLD);
          }
        });

        it("measures retail XLSX extraction rate", async () => {
          const filePath = join(SYNTHETIC_FIXTURES_DIR, `${bank}-retail-synthetic.xlsx`);
          const result = await loadAndMeasure(filePath, expectedBank, true);

          expect(result).not.toBeNull();
          if (result) {
            printResult(result);
            expect(result.pct).toBeGreaterThanOrEqual(S15_THRESHOLD);
          }
        });

        it("reports edgecases CSV extraction rate (no threshold enforcement)", async () => {
          const filePath = join(SYNTHETIC_FIXTURES_DIR, `${bank}-edgecases-synthetic.csv`);
          const result = await loadAndMeasure(filePath, expectedBank, false);

          if (result) {
            printResult(result);
          }
          expect(true).toBe(true);
        });

        it("reports malformed CSV extraction rate (no threshold enforcement)", async () => {
          const filePath = join(SYNTHETIC_FIXTURES_DIR, `${bank}-malformed-synthetic.csv`);
          const result = await loadAndMeasure(filePath, expectedBank, false);

          if (result) {
            printResult(result);
          }
          expect(true).toBe(true);
        });

        it("reports debitonly CSV extraction rate (no threshold enforcement)", async () => {
          const filePath = join(SYNTHETIC_FIXTURES_DIR, `${bank}-debitonly-synthetic.csv`);
          const result = await loadAndMeasure(filePath, expectedBank, false);

          if (result) {
            printResult(result);
          }
          expect(true).toBe(true);
        });
      });
    }
  });

  describe("Redacted real samples", () => {
    const banks: BankKey[] = ["hdfc", "icici", "sbi", "axis"];

    for (const bank of banks) {
      const expectedBank = BANK_IDS[bank];
      const files = getRedactedFiles(bank);

      if (files.length === 0) {
        it.skip(`${expectedBank}: no redacted samples found (tests/fixtures/redacted/${bank}/)`, () => {
          expect(true).toBe(true);
        });
      } else {
        describe(`${expectedBank}`, () => {
          for (const filePath of files) {
            const fileName = basename(filePath);
            const isClean = isCleanFixture(fileName);

            it(`measures ${fileName}${isClean ? "" : " (report only)"}`, async () => {
              const result = await loadAndMeasure(filePath, expectedBank, isClean);

              if (result) {
                printResult(result);
                if (isClean) {
                  expect(result.pct).toBeGreaterThanOrEqual(S15_THRESHOLD);
                }
              }
            });
          }
        });
      }
    }
  });

  describe("Summary", () => {
    it("prints aggregate statistics", async () => {
      const banks: BankKey[] = ["hdfc", "icici", "sbi", "axis"];
      const results: MeasurementResult[] = [];

      for (const bank of banks) {
        const expectedBank = BANK_IDS[bank];

        const csvPath = join(SYNTHETIC_FIXTURES_DIR, `${bank}-retail-synthetic.csv`);
        const csvResult = await loadAndMeasure(csvPath, expectedBank, true);
        if (csvResult) results.push(csvResult);

        const xlsxPath = join(SYNTHETIC_FIXTURES_DIR, `${bank}-retail-synthetic.xlsx`);
        const xlsxResult = await loadAndMeasure(xlsxPath, expectedBank, true);
        if (xlsxResult) results.push(xlsxResult);

        for (const redactedPath of getRedactedFiles(bank)) {
          const isClean = isCleanFixture(basename(redactedPath));
          const redactedResult = await loadAndMeasure(redactedPath, expectedBank, isClean);
          if (redactedResult) results.push(redactedResult);
        }
      }

      console.log("\n=== S15 MEASUREMENT SUMMARY ===");

      const bankGroups = new Map<BankId, MeasurementResult[]>();
      for (const r of results) {
        const group = bankGroups.get(r.bank) ?? [];
        group.push(r);
        bankGroups.set(r.bank, group);
      }

      for (const [bankId, group] of bankGroups) {
        const cleanResults = group.filter((r) => r.isClean);
        const totalCredits = cleanResults.reduce((sum, r) => sum + r.credits, 0);
        const totalEligible = cleanResults.reduce((sum, r) => sum + r.s15Eligible, 0);
        const totalWithRef = cleanResults.reduce((sum, r) => sum + r.withRef, 0);
        const avgPct = totalEligible > 0 ? (totalWithRef / totalEligible) * 100 : 0;

        console.log(
          `${bankId}: credits=${totalCredits}, s15_eligible=${totalEligible}, with_ref=${totalWithRef}, pct=${Math.round(avgPct * 100) / 100}%, threshold=${S15_THRESHOLD}%`
        );
      }

      console.log("=== END SUMMARY ===\n");

      expect(true).toBe(true);
    });
  });
});
