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
import type { BankId, PaymentRail, NormalisedTxn, ParsedNarration } from "../types.js";

const SYNTHETIC_FIXTURES_DIR = join(process.cwd(), "tests/fixtures/banks/synthetic");
const REDACTED_FIXTURES_DIR = join(process.cwd(), "tests/fixtures/redacted");

const S15_THRESHOLD = 95;

const S15_RAILS: PaymentRail[] = ["NEFT", "RTGS", "IMPS", "UPI"];
const EXCLUDED_RAILS: PaymentRail[] = ["CHEQUE", "ACH"];

type BankKey = "hdfc" | "icici" | "sbi" | "axis";

const BANK_IDS: Record<BankKey, BankId> = {
  hdfc: "HDFC",
  icici: "ICICI",
  sbi: "SBI",
  axis: "AXIS",
};

interface ExcludedCounts {
  cheque: number;
  ach: number;
}

interface MeasurementResult {
  bank: BankId;
  fixture: string;
  credits: number;
  excluded: ExcludedCounts;
  measurable: number;
  withBoth: number;
  pct: number;
  threshold: number;
  isClean: boolean;
}

function isExcludedRail(rail: PaymentRail): boolean {
  return EXCLUDED_RAILS.includes(rail);
}

function isS15Rail(rail: PaymentRail): boolean {
  return S15_RAILS.includes(rail);
}

function hasValidReference(txn: NormalisedTxn): boolean {
  return typeof txn.parsed.utr === "string" && txn.parsed.utr.length > 0;
}

/**
 * Measures extraction rate for S15 criterion.
 *
 * Denominator: All credits EXCEPT CHEQUE and ACH (which genuinely have no UTR/RRN).
 * Numerator: Credits with BOTH an S15 rail (NEFT/RTGS/IMPS/UPI) AND a valid reference.
 *
 * Credits with rail=OTHER are counted as misses (they're in the denominator but
 * won't contribute to the numerator since OTHER is not an S15 rail).
 */
export function measureExtraction(
  transactions: NormalisedTxn[],
  bank: BankId,
  fixture: string,
  isClean: boolean
): MeasurementResult {
  const credits = transactions.filter((t) => t.direction === "CR");

  const excluded: ExcludedCounts = {
    cheque: credits.filter((t) => t.parsed.rail === "CHEQUE").length,
    ach: credits.filter((t) => t.parsed.rail === "ACH").length,
  };

  const measurable = credits.filter((t) => !isExcludedRail(t.parsed.rail));

  const withBoth = measurable.filter(
    (t) => isS15Rail(t.parsed.rail) && hasValidReference(t)
  );

  const pct = measurable.length > 0 ? (withBoth.length / measurable.length) * 100 : 0;

  return {
    bank,
    fixture,
    credits: credits.length,
    excluded,
    measurable: measurable.length,
    withBoth: withBoth.length,
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
    `[${result.bank}] ${result.fixture}: credits=${result.credits}, excluded=[cheque=${result.excluded.cheque},ach=${result.excluded.ach}], measurable=${result.measurable}, with_both=${result.withBoth}, pct=${result.pct}%, threshold=${result.threshold}% [${status}]`
  );
}

async function loadAndMeasure(
  filePath: string,
  expectedBank: BankId,
  isClean: boolean,
  displayName?: string
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

  return measureExtraction(result.transactions, expectedBank, displayName ?? fileName, isClean);
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

function makeTestTxn(
  direction: "CR" | "DR",
  rail: PaymentRail,
  utr?: string
): NormalisedTxn {
  const parsed: ParsedNarration = { rail };
  if (utr) {
    parsed.utr = utr;
  }
  return {
    date: "2026-10-01",
    amountPaise: 100000,
    direction,
    narration: "TEST",
    parsed,
    dedupeKey: `test-${Math.random()}`,
    sourceRow: 1,
  };
}

describe("S15 Rail & Reference Extraction Measurement", () => {
  describe("measureExtraction unit tests", () => {
    it("returns 100% when all measurable credits have S15 rail and reference", () => {
      const txns: NormalisedTxn[] = [
        makeTestTxn("CR", "NEFT", "SYNTN26296000001"),
        makeTestTxn("CR", "UPI", "123456789012"),
        makeTestTxn("DR", "NEFT", "SYNTN26296000002"),
      ];

      const result = measureExtraction(txns, "HDFC", "unit-test", true);

      expect(result.credits).toBe(2);
      expect(result.excluded.cheque).toBe(0);
      expect(result.excluded.ach).toBe(0);
      expect(result.measurable).toBe(2);
      expect(result.withBoth).toBe(2);
      expect(result.pct).toBe(100);
    });

    it("excludes CHEQUE and ACH credits from denominator", () => {
      const txns: NormalisedTxn[] = [
        makeTestTxn("CR", "NEFT", "SYNTN26296000001"),
        makeTestTxn("CR", "CHEQUE"),
        makeTestTxn("CR", "ACH"),
      ];

      const result = measureExtraction(txns, "HDFC", "unit-test", true);

      expect(result.credits).toBe(3);
      expect(result.excluded.cheque).toBe(1);
      expect(result.excluded.ach).toBe(1);
      expect(result.measurable).toBe(1);
      expect(result.withBoth).toBe(1);
      expect(result.pct).toBe(100);
    });

    it("counts OTHER rail credits as misses (pct drops)", () => {
      const txns: NormalisedTxn[] = [
        makeTestTxn("CR", "NEFT", "SYNTN26296000001"),
        makeTestTxn("CR", "OTHER"),
      ];

      const result = measureExtraction(txns, "HDFC", "unit-test", true);

      expect(result.credits).toBe(2);
      expect(result.excluded.cheque).toBe(0);
      expect(result.excluded.ach).toBe(0);
      expect(result.measurable).toBe(2);
      expect(result.withBoth).toBe(1);
      expect(result.pct).toBe(50);
    });

    it("counts S15 rail credits without reference as misses (pct drops)", () => {
      const txns: NormalisedTxn[] = [
        makeTestTxn("CR", "NEFT", "SYNTN26296000001"),
        makeTestTxn("CR", "IMPS"),
      ];

      const result = measureExtraction(txns, "HDFC", "unit-test", true);

      expect(result.credits).toBe(2);
      expect(result.measurable).toBe(2);
      expect(result.withBoth).toBe(1);
      expect(result.pct).toBe(50);
    });

    it("returns 0% when all measurable credits are OTHER or missing reference", () => {
      const txns: NormalisedTxn[] = [
        makeTestTxn("CR", "OTHER"),
        makeTestTxn("CR", "NEFT"),
        makeTestTxn("CR", "CHEQUE"),
      ];

      const result = measureExtraction(txns, "HDFC", "unit-test", true);

      expect(result.credits).toBe(3);
      expect(result.excluded.cheque).toBe(1);
      expect(result.measurable).toBe(2);
      expect(result.withBoth).toBe(0);
      expect(result.pct).toBe(0);
    });

    it("returns 0% with empty measurable set (all excluded)", () => {
      const txns: NormalisedTxn[] = [
        makeTestTxn("CR", "CHEQUE"),
        makeTestTxn("CR", "ACH"),
      ];

      const result = measureExtraction(txns, "HDFC", "unit-test", true);

      expect(result.credits).toBe(2);
      expect(result.excluded.cheque).toBe(1);
      expect(result.excluded.ach).toBe(1);
      expect(result.measurable).toBe(0);
      expect(result.pct).toBe(0);
    });
  });

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
          for (let i = 0; i < files.length; i++) {
            const filePath = files[i];
            const fileName = basename(filePath);
            const isClean = isCleanFixture(fileName);
            const displayName = `redacted#${i + 1}`;

            it(`measures ${displayName}${isClean ? "" : " (report only)"}`, async () => {
              const result = await loadAndMeasure(filePath, expectedBank, isClean, displayName);

              expect(result).not.toBeNull();
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

        const redactedFiles = getRedactedFiles(bank);
        for (let i = 0; i < redactedFiles.length; i++) {
          const redactedPath = redactedFiles[i];
          const isClean = isCleanFixture(basename(redactedPath));
          const displayName = `redacted#${i + 1}`;
          const redactedResult = await loadAndMeasure(redactedPath, expectedBank, isClean, displayName);
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
        const totalExcludedCheque = cleanResults.reduce((sum, r) => sum + r.excluded.cheque, 0);
        const totalExcludedAch = cleanResults.reduce((sum, r) => sum + r.excluded.ach, 0);
        const totalMeasurable = cleanResults.reduce((sum, r) => sum + r.measurable, 0);
        const totalWithBoth = cleanResults.reduce((sum, r) => sum + r.withBoth, 0);
        const avgPct = totalMeasurable > 0 ? (totalWithBoth / totalMeasurable) * 100 : 0;

        console.log(
          `${bankId}: credits=${totalCredits}, excluded=[cheque=${totalExcludedCheque},ach=${totalExcludedAch}], measurable=${totalMeasurable}, with_both=${totalWithBoth}, pct=${Math.round(avgPct * 100) / 100}%, threshold=${S15_THRESHOLD}%`
        );
      }

      console.log("=== END SUMMARY ===\n");

      expect(true).toBe(true);
    });
  });
});
