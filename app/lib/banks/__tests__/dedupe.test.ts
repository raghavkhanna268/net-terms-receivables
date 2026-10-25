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
  isValidUtrForRail,
} from "../dedupe.js";
import type { NormalisedTxn } from "../types.js";

describe("dedupe", () => {
  describe("isValidUtrForRail", () => {
    describe("NEFT UTRs", () => {
      it("accepts valid NEFT UTR: HDFCN26296123456", () => {
        expect(isValidUtrForRail("HDFCN26296123456", "NEFT")).toBe(true);
      });

      it("accepts valid NEFT UTR: SYNTN26296000001", () => {
        expect(isValidUtrForRail("SYNTN26296000001", "NEFT")).toBe(true);
      });

      it("accepts 17-digit NEFT UTR", () => {
        expect(isValidUtrForRail("HDFCN2629612345678", "NEFT")).toBe(true);
      });

      it("rejects NEFT UTR without N", () => {
        expect(isValidUtrForRail("HDFC26296123456", "NEFT")).toBe(false);
      });

      it("rejects 12-digit RRN for NEFT", () => {
        expect(isValidUtrForRail("123456789012", "NEFT")).toBe(false);
      });
    });

    describe("RTGS UTRs", () => {
      it("accepts valid RTGS UTR: HDFCR26296123456", () => {
        expect(isValidUtrForRail("HDFCR26296123456", "RTGS")).toBe(true);
      });

      it("accepts valid RTGS UTR: SYNTR26296000001", () => {
        expect(isValidUtrForRail("SYNTR26296000001", "RTGS")).toBe(true);
      });

      it("rejects RTGS UTR without R", () => {
        expect(isValidUtrForRail("HDFC26296123456", "RTGS")).toBe(false);
      });

      it("rejects NEFT UTR for RTGS rail", () => {
        expect(isValidUtrForRail("HDFCN26296123456", "RTGS")).toBe(false);
      });
    });

    describe("IMPS/UPI RRNs", () => {
      it("accepts valid 12-digit RRN for IMPS", () => {
        expect(isValidUtrForRail("123456789012", "IMPS")).toBe(true);
      });

      it("accepts valid 12-digit RRN for UPI", () => {
        expect(isValidUtrForRail("987654321098", "UPI")).toBe(true);
      });

      it("rejects 11-digit number for IMPS", () => {
        expect(isValidUtrForRail("12345678901", "IMPS")).toBe(false);
      });

      it("rejects 13-digit number for UPI", () => {
        expect(isValidUtrForRail("1234567890123", "UPI")).toBe(false);
      });

      it("rejects NEFT UTR for UPI rail", () => {
        expect(isValidUtrForRail("HDFCN26296123456", "UPI")).toBe(false);
      });
    });

    describe("ACH/CHEQUE - no valid UTR", () => {
      it("rejects any reference for ACH", () => {
        expect(isValidUtrForRail("654321", "ACH")).toBe(false);
        expect(isValidUtrForRail("123456789012", "ACH")).toBe(false);
      });

      it("rejects cheque number for CHEQUE", () => {
        expect(isValidUtrForRail("000123", "CHEQUE")).toBe(false);
      });

      it("rejects any reference for OTHER", () => {
        expect(isValidUtrForRail("123456", "OTHER")).toBe(false);
      });
    });
  });

  describe("generateDedupeKey", () => {
    it("uses namespaced UTR key for valid NEFT UTR", async () => {
      const key = await generateDedupeKey(
        "2026-10-01",
        5000000,
        "CR",
        "NEFT CR-COMPANY",
        "NEFT",
        "SYNTN26296000001"
      );
      expect(key).toBe("utr:NEFT:CR:SYNTN26296000001");
    });

    it("uses namespaced UTR key for valid RTGS UTR", async () => {
      const key = await generateDedupeKey(
        "2026-10-01",
        5000000,
        "CR",
        "RTGS CR-COMPANY",
        "RTGS",
        "SYNTR26296000001"
      );
      expect(key).toBe("utr:RTGS:CR:SYNTR26296000001");
    });

    it("uses namespaced UTR key for valid UPI RRN", async () => {
      const key = await generateDedupeKey(
        "2026-10-01",
        5000000,
        "DR",
        "UPI-PURCHASE",
        "UPI",
        "987654321098"
      );
      expect(key).toBe("utr:UPI:DR:987654321098");
    });

    it("includes direction in UTR key (CR vs DR)", async () => {
      const keyCR = await generateDedupeKey(
        "2026-10-01",
        5000000,
        "CR",
        "NEFT CR-COMPANY",
        "NEFT",
        "SYNTN26296000001"
      );
      const keyDR = await generateDedupeKey(
        "2026-10-01",
        5000000,
        "DR",
        "NEFT-RETURN",
        "NEFT",
        "SYNTN26296000001"
      );
      expect(keyCR).toBe("utr:NEFT:CR:SYNTN26296000001");
      expect(keyDR).toBe("utr:NEFT:DR:SYNTN26296000001");
      expect(keyCR).not.toBe(keyDR);
    });

    it("generates SHA-256 hash for invalid UTR format", async () => {
      const key = await generateDedupeKey(
        "2026-10-01",
        5000000,
        "CR",
        "NEFT CR-COMPANY",
        "NEFT",
        "123456" // Too short
      );
      expect(key).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it("generates SHA-256 hash for ACH (no valid UTR)", async () => {
      const key = await generateDedupeKey(
        "2026-10-01",
        5000000,
        "DR",
        "ACH D-INSURANCE",
        "ACH",
        "654321"
      );
      expect(key).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it("generates SHA-256 hash for CHEQUE (no valid UTR)", async () => {
      const key = await generateDedupeKey(
        "2026-10-01",
        5000000,
        "DR",
        "CHQ PAID",
        "CHEQUE",
        "000123"
      );
      expect(key).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it("generates consistent hash for same input", async () => {
      const key1 = await generateDedupeKey(
        "2026-10-01",
        5000000,
        "CR",
        "CASH DEPOSIT",
        "OTHER"
      );
      const key2 = await generateDedupeKey(
        "2026-10-01",
        5000000,
        "CR",
        "CASH DEPOSIT",
        "OTHER"
      );
      expect(key1).toBe(key2);
    });

    it("generates different hash when balance differs", async () => {
      const key1 = await generateDedupeKey(
        "2026-10-01",
        5000000,
        "CR",
        "CASH DEPOSIT",
        "OTHER",
        undefined,
        10000000 // Balance 1
      );
      const key2 = await generateDedupeKey(
        "2026-10-01",
        5000000,
        "CR",
        "CASH DEPOSIT",
        "OTHER",
        undefined,
        15000000 // Balance 2
      );
      expect(key1).not.toBe(key2);
    });

    it("generates different hash when refNo differs", async () => {
      const key1 = await generateDedupeKey(
        "2026-10-01",
        5000000,
        "CR",
        "CASH DEPOSIT",
        "OTHER",
        undefined,
        undefined,
        undefined,
        "REF001"
      );
      const key2 = await generateDedupeKey(
        "2026-10-01",
        5000000,
        "CR",
        "CASH DEPOSIT",
        "OTHER",
        undefined,
        undefined,
        undefined,
        "REF002"
      );
      expect(key1).not.toBe(key2);
    });

    it("includes value date in hash", async () => {
      const key1 = await generateDedupeKey(
        "2026-10-01",
        5000000,
        "CR",
        "CASH DEPOSIT",
        "OTHER",
        undefined,
        undefined,
        "2026-10-01"
      );
      const key2 = await generateDedupeKey(
        "2026-10-01",
        5000000,
        "CR",
        "CASH DEPOSIT",
        "OTHER",
        undefined,
        undefined,
        "2026-10-02"
      );
      expect(key1).not.toBe(key2);
    });
  });

  describe("identical transactions with different balances", () => {
    it("keeps both transactions when same-day credits have different balances", async () => {
      // Two identical UPI payments on same day (no unique RRN), different balances
      const txn1 = await createMockTxnAsync(
        "2026-10-15",
        100000, // Rs 1000
        "CR",
        "UPI-SYNTHETIC SENDER-sender@synthetic",
        "UPI",
        undefined, // No RRN
        50000000 // Balance after first credit
      );
      const txn2 = await createMockTxnAsync(
        "2026-10-15",
        100000, // Rs 1000 (same amount)
        "CR",
        "UPI-SYNTHETIC SENDER-sender@synthetic", // Same narration
        "UPI",
        undefined, // No RRN
        51000000 // Different balance
      );

      const result = await dedupeWithinFile([txn1, txn2]);
      expect(result).toHaveLength(2);
      expect(result[0].balancePaise).toBe(50000000);
      expect(result[1].balancePaise).toBe(51000000);
    });
  });

  describe("NEFT/RTGS return with same UTR", () => {
    it("keeps both CR and DR with same UTR", async () => {
      // Original NEFT credit
      const original = await createMockTxnAsync(
        "2026-10-15",
        5000000,
        "CR",
        "NEFT CR-SYNTHETIC COMPANY-PAYMENT",
        "NEFT",
        "SYNTN26296000001",
        10000000
      );
      // NEFT return (DR) with same UTR
      const returned = await createMockTxnAsync(
        "2026-10-16",
        5000000,
        "DR",
        "NEFT-SYNTN26296000001-RETURN",
        "NEFT",
        "SYNTN26296000001",
        5000000
      );

      const result = await dedupeWithinFile([original, returned]);
      expect(result).toHaveLength(2);
      expect(result[0].direction).toBe("CR");
      expect(result[1].direction).toBe("DR");
    });
  });

  describe("dedupeWithinFile", () => {
    it("removes duplicate transactions", async () => {
      const txn1 = await createMockTxnAsync("2026-10-01", 5000000, "CR", "NEFT", "NEFT", "SYNTN26296000001");
      const txn2 = await createMockTxnAsync("2026-10-02", 3000000, "CR", "NEFT", "NEFT", "SYNTN26296000002");
      const txn3 = await createMockTxnAsync("2026-10-01", 5000000, "CR", "NEFT", "NEFT", "SYNTN26296000001"); // dup

      const result = await dedupeWithinFile([txn1, txn2, txn3]);
      expect(result).toHaveLength(2);
    });

    it("keeps all unique transactions", async () => {
      const txn1 = await createMockTxnAsync("2026-10-01", 5000000, "CR", "NEFT", "NEFT", "SYNTN26296000001");
      const txn2 = await createMockTxnAsync("2026-10-02", 3000000, "CR", "NEFT", "NEFT", "SYNTN26296000002");
      const txn3 = await createMockTxnAsync("2026-10-03", 2000000, "DR", "NEFT", "NEFT", "SYNTN26296000003");

      const result = await dedupeWithinFile([txn1, txn2, txn3]);
      expect(result).toHaveLength(3);
    });

    it("returns empty array for empty input", async () => {
      expect(await dedupeWithinFile([])).toHaveLength(0);
    });
  });

  describe("filterExisting", () => {
    it("filters out existing transactions", async () => {
      const txn1 = await createMockTxnAsync("2026-10-01", 5000000, "CR", "NEFT", "NEFT", "SYNTN26296000001");
      const txn2 = await createMockTxnAsync("2026-10-02", 3000000, "CR", "NEFT", "NEFT", "SYNTN26296000002");
      const txn3 = await createMockTxnAsync("2026-10-03", 2000000, "CR", "NEFT", "NEFT", "SYNTN26296000003");

      const existing = new Set([txn1.dedupeKey, txn3.dedupeKey]);
      const result = filterExisting([txn1, txn2, txn3], existing);

      expect(result).toHaveLength(1);
      expect(result[0].dedupeKey).toBe(txn2.dedupeKey);
    });

    it("returns all if no existing keys match", async () => {
      const txn1 = await createMockTxnAsync("2026-10-01", 5000000, "CR", "NEFT", "NEFT", "SYNTN26296000001");
      const txn2 = await createMockTxnAsync("2026-10-02", 3000000, "CR", "NEFT", "NEFT", "SYNTN26296000002");

      const existing = new Set(["utr:NEFT:CR:SYNTN99999999999"]);
      const result = filterExisting([txn1, txn2], existing);

      expect(result).toHaveLength(2);
    });
  });

  describe("dedupeTransactions", () => {
    it("dedupes within file and against existing", async () => {
      const txn1 = await createMockTxnAsync("2026-10-01", 5000000, "CR", "NEFT", "NEFT", "SYNTN26296000001");
      const txn2 = await createMockTxnAsync("2026-10-02", 3000000, "CR", "NEFT", "NEFT", "SYNTN26296000002");
      const txn3 = await createMockTxnAsync("2026-10-01", 5000000, "CR", "NEFT", "NEFT", "SYNTN26296000001"); // dup
      const txn4 = await createMockTxnAsync("2026-10-03", 2000000, "CR", "NEFT", "NEFT", "SYNTN26296000003");

      const existing = new Set([txn2.dedupeKey]); // exists in DB
      const result = await dedupeTransactions([txn1, txn2, txn3, txn4], existing);

      expect(result).toHaveLength(2);
      expect(result.map((t) => t.dedupeKey).sort()).toEqual([txn1.dedupeKey, txn4.dedupeKey].sort());
    });

    it("works without existing keys", async () => {
      const txn1 = await createMockTxnAsync("2026-10-01", 5000000, "CR", "NEFT", "NEFT", "SYNTN26296000001");
      const txn2 = await createMockTxnAsync("2026-10-01", 5000000, "CR", "NEFT", "NEFT", "SYNTN26296000001");

      const result = await dedupeTransactions([txn1, txn2]);
      expect(result).toHaveLength(1);
    });
  });

  describe("extractDedupeKeys", () => {
    it("extracts all keys", async () => {
      const txn1 = await createMockTxnAsync("2026-10-01", 5000000, "CR", "NEFT", "NEFT", "SYNTN26296000001");
      const txn2 = await createMockTxnAsync("2026-10-02", 3000000, "CR", "NEFT", "NEFT", "SYNTN26296000002");

      const keys = extractDedupeKeys([txn1, txn2]);
      expect(keys.size).toBe(2);
      expect(keys.has(txn1.dedupeKey)).toBe(true);
      expect(keys.has(txn2.dedupeKey)).toBe(true);
    });
  });

  describe("arePossibleDuplicates", () => {
    it("returns true for matching valid UTRs", async () => {
      const a = await createMockTxnAsync("2026-10-01", 50000, "CR", "NEFT-SYNTN26296000001", "NEFT", "SYNTN26296000001");
      const b = await createMockTxnAsync("2026-10-01", 50000, "CR", "NEFT-SYNTN26296000001 REF", "NEFT", "SYNTN26296000001");

      expect(arePossibleDuplicates(a, b)).toBe(true);
    });

    it("returns false for different dates", async () => {
      const a = await createMockTxnAsync("2026-10-01", 50000, "CR", "NEFT", "NEFT", "SYNTN26296000001");
      const b = await createMockTxnAsync("2026-10-02", 50000, "CR", "NEFT", "NEFT", "SYNTN26296000001");

      expect(arePossibleDuplicates(a, b)).toBe(false);
    });

    it("returns false for different amounts", async () => {
      const a = await createMockTxnAsync("2026-10-01", 50000, "CR", "NEFT", "NEFT", "SYNTN26296000001");
      const b = await createMockTxnAsync("2026-10-01", 60000, "CR", "NEFT", "NEFT", "SYNTN26296000001");

      expect(arePossibleDuplicates(a, b)).toBe(false);
    });

    it("returns false for different directions", async () => {
      const a = await createMockTxnAsync("2026-10-01", 50000, "CR", "NEFT", "NEFT", "SYNTN26296000001");
      const b = await createMockTxnAsync("2026-10-01", 50000, "DR", "NEFT", "NEFT", "SYNTN26296000001");

      expect(arePossibleDuplicates(a, b)).toBe(false);
    });

    it("requires same direction for UTR match to be duplicate", async () => {
      // Same valid UTR, same date, same amount, but different direction = NOT duplicates
      const credit = await createMockTxnAsync(
        "2026-10-15",
        5000000,
        "CR",
        "NEFT-SYNTN26296000001-PAYMENT",
        "NEFT",
        "SYNTN26296000001"
      );
      const debit = await createMockTxnAsync(
        "2026-10-15",
        5000000,
        "DR",
        "NEFT-SYNTN26296000001-RETURN",
        "NEFT",
        "SYNTN26296000001"
      );

      // Even with matching valid UTR, different direction means not duplicates
      expect(arePossibleDuplicates(credit, debit)).toBe(false);

      // Same direction + same UTR = duplicates
      const credit2 = await createMockTxnAsync(
        "2026-10-15",
        5000000,
        "CR",
        "NEFT-SYNTN26296000001-PAYMENT REF",
        "NEFT",
        "SYNTN26296000001"
      );
      expect(arePossibleDuplicates(credit, credit2)).toBe(true);
    });

    it("returns false for different balances (without UTR)", async () => {
      const a = await createMockTxnAsync("2026-10-01", 50000, "CR", "CASH DEPOSIT", "OTHER", undefined, 100000);
      const b = await createMockTxnAsync("2026-10-01", 50000, "CR", "CASH DEPOSIT", "OTHER", undefined, 150000);

      expect(arePossibleDuplicates(a, b)).toBe(false);
    });
  });
});

// Helper to create mock transaction with async dedupe key
async function createMockTxnAsync(
  date: string,
  amountPaise: number = 50000,
  direction: "CR" | "DR" = "CR",
  narration: string = "Test transaction",
  rail: "NEFT" | "RTGS" | "IMPS" | "UPI" | "ACH" | "CHEQUE" | "OTHER" = "OTHER",
  utr?: string,
  balancePaise?: number
): Promise<NormalisedTxn> {
  const { generateDedupeKey } = await import("../dedupe.js");
  const dedupeKey = await generateDedupeKey(
    date,
    amountPaise,
    direction,
    narration,
    rail,
    utr,
    balancePaise
  );

  return {
    date,
    amountPaise,
    direction,
    narration,
    parsed: { rail, utr },
    dedupeKey,
    sourceRow: 1,
    balancePaise,
  };
}

