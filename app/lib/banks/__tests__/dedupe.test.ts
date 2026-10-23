/**
 * Tests for UTR-based deduplication.
 * Using synthetic test data - not real bank data.
 */

import { describe, it, expect } from "vitest";
import {
  generateDedupeKey,
  dedupeWithinFile,
  filterExisting,
  dedupeTransactions,
  extractDedupeKeys,
  arePossibleDuplicates,
} from "../dedupe.js";
import type { NormalisedTxn } from "../types.js";

describe("dedupe", () => {
  describe("generateDedupeKey", () => {
    it("uses UTR when provided", () => {
      const key = generateDedupeKey(
        "2026-10-01",
        5000000,
        "CR",
        "NEFT CR-COMPANY",
        "HDFC2026100100001"
      );
      expect(key).toBe("utr:HDFC2026100100001");
    });

    it("generates hash when no UTR", () => {
      const key = generateDedupeKey(
        "2026-10-01",
        5000000,
        "CR",
        "NEFT CR-COMPANY",
        undefined
      );
      expect(key).toMatch(/^hash:[a-f0-9]{8}$/);
    });

    it("generates consistent hash for same input", () => {
      const key1 = generateDedupeKey("2026-10-01", 5000000, "CR", "NEFT CR-COMPANY", undefined);
      const key2 = generateDedupeKey("2026-10-01", 5000000, "CR", "NEFT CR-COMPANY", undefined);
      expect(key1).toBe(key2);
    });

    it("generates different hash for different inputs", () => {
      const key1 = generateDedupeKey("2026-10-01", 5000000, "CR", "NEFT CR-COMPANY A", undefined);
      const key2 = generateDedupeKey("2026-10-01", 5000000, "CR", "NEFT CR-COMPANY B", undefined);
      expect(key1).not.toBe(key2);
    });

    it("generates different hash for different amounts", () => {
      const key1 = generateDedupeKey("2026-10-01", 5000000, "CR", "NEFT CR-COMPANY", undefined);
      const key2 = generateDedupeKey("2026-10-01", 6000000, "CR", "NEFT CR-COMPANY", undefined);
      expect(key1).not.toBe(key2);
    });

    it("generates different hash for different directions", () => {
      const key1 = generateDedupeKey("2026-10-01", 5000000, "CR", "TRANSFER", undefined);
      const key2 = generateDedupeKey("2026-10-01", 5000000, "DR", "TRANSFER", undefined);
      expect(key1).not.toBe(key2);
    });
  });

  describe("dedupeWithinFile", () => {
    it("removes duplicate transactions", () => {
      const txns: NormalisedTxn[] = [
        createMockTxn("utr:UTR001", "2026-10-01"),
        createMockTxn("utr:UTR002", "2026-10-02"),
        createMockTxn("utr:UTR001", "2026-10-01"), // duplicate
      ];

      const result = dedupeWithinFile(txns);
      expect(result).toHaveLength(2);
      expect(result.map(t => t.dedupeKey)).toEqual(["utr:UTR001", "utr:UTR002"]);
    });

    it("keeps all unique transactions", () => {
      const txns: NormalisedTxn[] = [
        createMockTxn("utr:UTR001", "2026-10-01"),
        createMockTxn("utr:UTR002", "2026-10-02"),
        createMockTxn("utr:UTR003", "2026-10-03"),
      ];

      const result = dedupeWithinFile(txns);
      expect(result).toHaveLength(3);
    });

    it("returns empty array for empty input", () => {
      expect(dedupeWithinFile([])).toHaveLength(0);
    });
  });

  describe("filterExisting", () => {
    it("filters out existing transactions", () => {
      const txns: NormalisedTxn[] = [
        createMockTxn("utr:UTR001", "2026-10-01"),
        createMockTxn("utr:UTR002", "2026-10-02"),
        createMockTxn("utr:UTR003", "2026-10-03"),
      ];

      const existing = new Set(["utr:UTR001", "utr:UTR003"]);
      const result = filterExisting(txns, existing);

      expect(result).toHaveLength(1);
      expect(result[0].dedupeKey).toBe("utr:UTR002");
    });

    it("returns all if no existing keys match", () => {
      const txns: NormalisedTxn[] = [
        createMockTxn("utr:UTR001", "2026-10-01"),
        createMockTxn("utr:UTR002", "2026-10-02"),
      ];

      const existing = new Set(["utr:UTR999"]);
      const result = filterExisting(txns, existing);

      expect(result).toHaveLength(2);
    });
  });

  describe("dedupeTransactions", () => {
    it("dedupes within file and against existing", () => {
      const txns: NormalisedTxn[] = [
        createMockTxn("utr:UTR001", "2026-10-01"),
        createMockTxn("utr:UTR002", "2026-10-02"),
        createMockTxn("utr:UTR001", "2026-10-01"), // duplicate within file
        createMockTxn("utr:UTR003", "2026-10-03"),
      ];

      const existing = new Set(["utr:UTR002"]); // exists in DB
      const result = dedupeTransactions(txns, existing);

      expect(result).toHaveLength(2);
      expect(result.map(t => t.dedupeKey).sort()).toEqual(["utr:UTR001", "utr:UTR003"]);
    });

    it("works without existing keys", () => {
      const txns: NormalisedTxn[] = [
        createMockTxn("utr:UTR001", "2026-10-01"),
        createMockTxn("utr:UTR001", "2026-10-01"),
      ];

      const result = dedupeTransactions(txns);
      expect(result).toHaveLength(1);
    });
  });

  describe("extractDedupeKeys", () => {
    it("extracts all keys", () => {
      const txns: NormalisedTxn[] = [
        createMockTxn("utr:UTR001", "2026-10-01"),
        createMockTxn("utr:UTR002", "2026-10-02"),
      ];

      const keys = extractDedupeKeys(txns);
      expect(keys.size).toBe(2);
      expect(keys.has("utr:UTR001")).toBe(true);
      expect(keys.has("utr:UTR002")).toBe(true);
    });
  });

  describe("arePossibleDuplicates", () => {
    it("returns true for matching UTRs", () => {
      const a = createMockTxn("utr:UTR001", "2026-10-01", 50000, "CR", "NEFT-UTR001-COMPANY");
      const b = createMockTxn("utr:UTR001", "2026-10-01", 50000, "CR", "NEFT-UTR001-COMPANY LTD");
      a.parsed.utr = "UTR001";
      b.parsed.utr = "UTR001";

      expect(arePossibleDuplicates(a, b)).toBe(true);
    });

    it("returns false for different dates", () => {
      const a = createMockTxn("utr:A", "2026-10-01", 50000, "CR", "NEFT");
      const b = createMockTxn("utr:B", "2026-10-02", 50000, "CR", "NEFT");

      expect(arePossibleDuplicates(a, b)).toBe(false);
    });

    it("returns false for different amounts", () => {
      const a = createMockTxn("utr:A", "2026-10-01", 50000, "CR", "NEFT");
      const b = createMockTxn("utr:B", "2026-10-01", 60000, "CR", "NEFT");

      expect(arePossibleDuplicates(a, b)).toBe(false);
    });

    it("returns false for different directions", () => {
      const a = createMockTxn("utr:A", "2026-10-01", 50000, "CR", "NEFT");
      const b = createMockTxn("utr:B", "2026-10-01", 50000, "DR", "NEFT");

      expect(arePossibleDuplicates(a, b)).toBe(false);
    });

    it("returns true for similar narrations when no UTR", () => {
      const a = createMockTxn("hash:A", "2026-10-01", 50000, "CR", "CASH DEPOSIT AT BRANCH 123");
      const b = createMockTxn("hash:B", "2026-10-01", 50000, "CR", "CASH DEPOSIT AT BRANCH");

      expect(arePossibleDuplicates(a, b)).toBe(true);
    });

    it("returns false for different UTRs", () => {
      const a = createMockTxn("utr:UTR001", "2026-10-01", 50000, "CR", "NEFT");
      const b = createMockTxn("utr:UTR002", "2026-10-01", 50000, "CR", "NEFT");
      a.parsed.utr = "UTR001";
      b.parsed.utr = "UTR002";

      expect(arePossibleDuplicates(a, b)).toBe(false);
    });
  });
});

// Helper to create mock transaction
function createMockTxn(
  dedupeKey: string,
  date: string,
  amountPaise: number = 50000,
  direction: "CR" | "DR" = "CR",
  narration: string = "Test transaction"
): NormalisedTxn {
  return {
    date,
    amountPaise,
    direction,
    narration,
    parsed: { rail: "OTHER" },
    dedupeKey,
    sourceRow: 1,
  };
}
