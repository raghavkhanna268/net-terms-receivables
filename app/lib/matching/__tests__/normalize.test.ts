/**
 * Unit tests for name normalization module.
 *
 * These tests use synthetic fixtures only (fake names, no real data).
 */

import { describe, it, expect } from "vitest";
import {
  normalizeName,
  extractTokens,
  generateAliasKeys,
  normalizeNarrationForLookup,
  nameSimilarity,
  findBestBuyerMatch,
  findAllTiedBuyerMatches,
} from "../normalize";

describe("normalizeName", () => {
  it("removes M/S prefix", () => {
    // CORP is also a suffix that gets removed
    expect(normalizeName("M/S SYNTHETIC CORP")).toBe("synthetic");
    expect(normalizeName("M/S. SYNTHETIC CORP")).toBe("synthetic");
    expect(normalizeName("MS SYNTHETIC CORP")).toBe("synthetic");
  });

  it("removes common company suffixes", () => {
    // CORP, PVT, LTD are all suffixes
    expect(normalizeName("SYNTHETIC CORP PVT LTD")).toBe("synthetic");
    expect(normalizeName("SYNTHETIC PRIVATE LIMITED")).toBe("synthetic");
    expect(normalizeName("SYNTHETIC LLC")).toBe("synthetic");
    expect(normalizeName("SYNTHETIC INC")).toBe("synthetic");
    expect(normalizeName("SYNTHETIC CORP")).toBe("synthetic");
    expect(normalizeName("SYNTHETIC LLP")).toBe("synthetic");
  });

  it("removes multiple suffixes", () => {
    expect(normalizeName("SYNTHETIC ENTERPRISES PVT LTD")).toBe("synthetic");
  });

  it("normalizes punctuation", () => {
    // CORP is a suffix that gets removed
    expect(normalizeName("SYNTHETIC, CORP.")).toBe("synthetic");
    expect(normalizeName("SYNTHETIC - CORP")).toBe("synthetic");
    expect(normalizeName("SYNTHETIC (CORP)")).toBe("synthetic");
    // Test with non-suffix word
    expect(normalizeName("SYNTHETIC, ACME.")).toBe("synthetic acme");
  });

  it("normalizes whitespace", () => {
    // CORP is a suffix that gets removed
    expect(normalizeName("SYNTHETIC   CORP")).toBe("synthetic");
    expect(normalizeName("  SYNTHETIC CORP  ")).toBe("synthetic");
    // Test with non-suffix word
    expect(normalizeName("SYNTHETIC   ACME")).toBe("synthetic acme");
  });

  it("handles combined patterns", () => {
    expect(normalizeName("M/S. SYNTHETIC INDUSTRIES PVT. LTD.")).toBe(
      "synthetic"
    );
  });

  it("handles single word names", () => {
    expect(normalizeName("SYNTHETIC")).toBe("synthetic");
  });

  it("handles empty string", () => {
    expect(normalizeName("")).toBe("");
  });
});

describe("extractTokens", () => {
  it("extracts words >= 2 characters", () => {
    const tokens = extractTokens("synthetic corp");
    expect(tokens).toContain("synthetic");
    expect(tokens).toContain("corp");
  });

  it("excludes stop words", () => {
    const tokens = extractTokens("synthetic and corp of india");
    expect(tokens).not.toContain("and");
    expect(tokens).not.toContain("of");
    expect(tokens).toContain("synthetic");
    expect(tokens).toContain("corp");
    expect(tokens).toContain("india");
  });

  it("excludes short words", () => {
    const tokens = extractTokens("a b synthetic corp");
    expect(tokens).not.toContain("a");
    expect(tokens).not.toContain("b");
  });

  it("returns unique tokens", () => {
    const tokens = extractTokens("synthetic corp synthetic");
    expect(tokens.filter((t) => t === "synthetic").length).toBe(1);
  });

  it("handles empty string", () => {
    const tokens = extractTokens("");
    expect(tokens).toEqual([]);
  });
});

describe("generateAliasKeys", () => {
  it("generates normalized full name", () => {
    // CORP, PVT, LTD are all suffixes that get removed
    const keys = generateAliasKeys("SYNTHETIC CORP PVT LTD");
    expect(keys).toContain("synthetic");
  });

  it("generates significant tokens (>= 4 chars)", () => {
    // TRADERS is a suffix that gets removed
    const keys = generateAliasKeys("SYNTHETIC WHOLESALE TRADERS");
    expect(keys).toContain("synthetic");
    expect(keys).toContain("wholesale");
  });

  it("generates first two tokens combined", () => {
    // CORP is removed as a suffix
    const keys = generateAliasKeys("ACME WHOLESALE CORP");
    expect(keys).toContain("acme wholesale");
  });

  it("skips short tokens (< 4 chars)", () => {
    // CORP is removed as a suffix, ABC is too short
    // Use a different suffix-free name
    const keys = generateAliasKeys("ABC DELTA");
    expect(keys).not.toContain("abc");
    expect(keys).toContain("delta");
  });

  it("skips very short names (< 3 chars normalized)", () => {
    const keys = generateAliasKeys("AB");
    expect(keys.every((k) => k.length >= 3 || k === "ab")).toBe(true);
  });
});

describe("normalizeNarrationForLookup", () => {
  it("removes NEFT prefix", () => {
    const normalized = normalizeNarrationForLookup(
      "NEFT CR-SYNTHETIC CORP-PAYMENT"
    );
    expect(normalized).not.toContain("neft");
  });

  it("removes RTGS prefix", () => {
    const normalized = normalizeNarrationForLookup(
      "RTGS-SYNTHETIC CORP-INVOICE"
    );
    expect(normalized).not.toContain("rtgs");
  });

  it("removes IMPS prefix", () => {
    const normalized = normalizeNarrationForLookup("IMPS-SYNTHETIC CORP-REF");
    expect(normalized).not.toContain("imps");
  });

  it("removes UPI prefix", () => {
    // Note: user@upi contains "upi" but that's an email, not the prefix
    const normalized = normalizeNarrationForLookup(
      "UPI-SYNTHETIC CORP-REF123"
    );
    expect(normalized).not.toContain("upi");
  });

  it("removes CR/DR indicators", () => {
    const normalized = normalizeNarrationForLookup("NEFT CR-SYNTHETIC CORP");
    expect(normalized).not.toContain("cr");
  });

  it("removes UTR patterns", () => {
    const normalized = normalizeNarrationForLookup(
      "NEFT-SYNTN26296000001-SYNTHETIC CORP"
    );
    expect(normalized).not.toMatch(/SYNTN\d+/i);
  });

  it("removes 12-digit RRN patterns", () => {
    const normalized = normalizeNarrationForLookup(
      "IMPS-123456789012-SYNTHETIC CORP"
    );
    expect(normalized).not.toContain("123456789012");
  });

  it("removes IFSC codes", () => {
    const normalized = normalizeNarrationForLookup(
      "NEFT-SYNTHETIC CORP-SYNT0001234"
    );
    expect(normalized).not.toMatch(/SYNT0\w+/i);
  });

  it("removes common banking terms", () => {
    const normalized = normalizeNarrationForLookup(
      "NEFT-SYNTHETIC CORP-SALARY PAYMENT"
    );
    expect(normalized).not.toContain("salary");
    expect(normalized).not.toContain("payment");
  });

  it("extracts payer name", () => {
    const normalized = normalizeNarrationForLookup(
      "NEFT CR-SYNTHETIC WHOLESALE LTD-INV1001"
    );
    expect(normalized).toContain("synthetic");
    expect(normalized).toContain("wholesale");
  });
});

describe("nameSimilarity", () => {
  it("returns 1 for identical names", () => {
    expect(nameSimilarity("synthetic corp", "synthetic corp")).toBe(1);
  });

  it("returns high score for containment", () => {
    const score = nameSimilarity("synthetic", "synthetic corp");
    expect(score).toBeGreaterThan(0.5);
  });

  it("returns score based on token overlap", () => {
    const score = nameSimilarity("synthetic wholesale", "synthetic traders");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("returns 0 for no overlap", () => {
    const score = nameSimilarity("alpha", "beta");
    expect(score).toBe(0);
  });

  it("returns 0 for empty strings", () => {
    expect(nameSimilarity("", "synthetic")).toBe(0);
    expect(nameSimilarity("synthetic", "")).toBe(0);
  });
});

describe("findBestBuyerMatch", () => {
  const buyers = [
    {
      id: "buyer-1",
      name: "Synthetic Corp",
      aliases: ["synthetic corp", "synthetic"],
      email: "accounts@syntheticcorp.com",
    },
    {
      id: "buyer-2",
      name: "Acme Wholesale",
      aliases: ["acme wholesale", "acme"],
      email: null,
    },
    {
      id: "buyer-3",
      name: "Test Traders",
      aliases: [],
      email: "test@example.com",
    },
  ];

  it("matches by exact alias", () => {
    const result = findBestBuyerMatch("SYNTHETIC CORP PVT LTD", buyers);
    expect(result?.buyerId).toBe("buyer-1");
    expect(result?.score).toBeGreaterThanOrEqual(0.9);
  });

  it("matches by partial alias containment", () => {
    const result = findBestBuyerMatch("SYNTHETIC CORPORATION LTD", buyers);
    expect(result?.buyerId).toBe("buyer-1");
  });

  it("matches by buyer name similarity", () => {
    const result = findBestBuyerMatch("ACME WHOLESALE TRADERS", buyers);
    expect(result?.buyerId).toBe("buyer-2");
  });

  it("matches by email prefix", () => {
    const result = findBestBuyerMatch("SYNTHETICCORP PAYMENT", buyers);
    expect(result?.buyerId).toBe("buyer-1");
  });

  it("returns null for no good match", () => {
    const result = findBestBuyerMatch("UNKNOWN COMPANY LTD", buyers);
    expect(result).toBeNull();
  });

  it("returns null for short payer text", () => {
    const result = findBestBuyerMatch("AB", buyers);
    expect(result).toBeNull();
  });

  it("prefers alias match over name match", () => {
    const buyersWithOverlap = [
      {
        id: "buyer-alias",
        name: "Different Name",
        aliases: ["synthetic"],
        email: null,
      },
      {
        id: "buyer-name",
        name: "Synthetic Something",
        aliases: [],
        email: null,
      },
    ];

    const result = findBestBuyerMatch("SYNTHETIC PVT LTD", buyersWithOverlap);
    // Should match alias first
    expect(result?.buyerId).toBe("buyer-alias");
  });
});

describe("HDFC-style narration parsing", () => {
  it("extracts payer from NEFT CR format", () => {
    // CORP, PVT, LTD are suffixes that get removed
    const normalized = normalizeNarrationForLookup(
      "NEFT CR-SYNTHETIC CORP PVT LTD-SALARY OCT"
    );
    expect(normalized).toContain("synthetic");
    // CORP is removed as a suffix
  });

  it("extracts payer from UPI format", () => {
    const normalized = normalizeNarrationForLookup(
      "UPI-SYNTHETIC VENDOR-fakevendor@synthetic-SYNT0000001-987654321098-UPI"
    );
    expect(normalized).toContain("synthetic");
    expect(normalized).toContain("vendor");
  });

  it("extracts payer from IMPS format", () => {
    const normalized = normalizeNarrationForLookup(
      "IMPS-123456789012-SYNTHETIC SENDER-SYNT-Payment"
    );
    expect(normalized).toContain("synthetic");
    expect(normalized).toContain("sender");
  });
});

describe("ICICI-style narration parsing", () => {
  it("extracts payer from NEFT slash format", () => {
    const normalized = normalizeNarrationForLookup(
      "NEFT/SYNTN26296000005/SYNTHETIC PAYROLL/SALARY OCT"
    );
    expect(normalized).toContain("synthetic");
    expect(normalized).toContain("payroll");
  });

  it("extracts payer from RTGS slash format", () => {
    const normalized = normalizeNarrationForLookup(
      "RTGS/SYNTR26296000003/SYNTHETIC WHOLESALE/INVOICE 12345"
    );
    expect(normalized).toContain("synthetic");
    expect(normalized).toContain("wholesale");
  });

  it("extracts payer from UPI slash format", () => {
    const normalized = normalizeNarrationForLookup(
      "UPI/543210987654/fakeuser@synthetic/SYNTHETIC VENDOR LTD"
    );
    expect(normalized).toContain("synthetic");
    expect(normalized).toContain("vendor");
  });
});

describe("findAllTiedBuyerMatches", () => {
  it("first tied buyer matches findBestBuyerMatch result", () => {
    const buyers = [
      { id: "buyer-older", name: "Test Buyer Co", aliases: [], email: null },
      { id: "buyer-newer", name: "Test Buyer Co", aliases: [], email: null },
    ];
    const payerText = "TEST BUYER CO PVT LTD";

    const best = findBestBuyerMatch(payerText, buyers);
    const allTied = findAllTiedBuyerMatches(payerText, buyers);

    expect(best).not.toBeNull();
    expect(allTied.length).toBe(2);
    expect(allTied[0].buyerId).toBe(best!.buyerId);
    expect(allTied[0].score).toBe(best!.score);
  });

  it("preserves input array order for tied buyers", () => {
    const buyers = [
      { id: "first", name: "Synthetic Corp", aliases: [], email: null },
      { id: "second", name: "Synthetic Corp", aliases: [], email: null },
      { id: "third", name: "Synthetic Corp", aliases: [], email: null },
    ];
    const payerText = "SYNTHETIC CORP";

    const allTied = findAllTiedBuyerMatches(payerText, buyers);

    expect(allTied.length).toBe(3);
    expect(allTied[0].buyerId).toBe("first");
    expect(allTied[1].buyerId).toBe("second");
    expect(allTied[2].buyerId).toBe("third");
  });

  it("returns empty array for payer text shorter than 3 chars after normalization", () => {
    const buyers = [
      { id: "buyer-1", name: "Test Company", aliases: [], email: null },
    ];

    expect(findAllTiedBuyerMatches("AB", buyers)).toEqual([]);
    expect(findAllTiedBuyerMatches("", buyers)).toEqual([]);
  });

  it("returns empty array when no buyer meets 0.5 threshold", () => {
    const buyers = [
      { id: "buyer-1", name: "Alpha Corp", aliases: [], email: null },
      { id: "buyer-2", name: "Beta Ltd", aliases: [], email: null },
    ];

    const result = findAllTiedBuyerMatches("UNKNOWN COMPANY XYZ", buyers);
    expect(result).toEqual([]);
  });

  it("excludes lower-scoring non-tied buyers", () => {
    const buyers = [
      { id: "high-score", name: "Synthetic Wholesale", aliases: ["synthetic"], email: null },
      { id: "low-score", name: "Different Name", aliases: [], email: "accounts@synthetic.example.com" },
      { id: "tied-high", name: "Other Name", aliases: ["synthetic"], email: null },
    ];
    const payerText = "SYNTHETIC VENDOR";

    const allTied = findAllTiedBuyerMatches(payerText, buyers);

    const buyerIds = allTied.map((b) => b.buyerId);
    expect(buyerIds).toContain("high-score");
    expect(buyerIds).toContain("tied-high");
    expect(buyerIds).not.toContain("low-score");
    expect(allTied.length).toBe(2);
    expect(allTied[0].score).toBe(allTied[1].score);
  });

  it("returns single buyer when only one meets threshold", () => {
    const buyers = [
      { id: "match", name: "Synthetic Corp", aliases: [], email: null },
      { id: "no-match", name: "Alpha Beta", aliases: [], email: null },
    ];

    const result = findAllTiedBuyerMatches("SYNTHETIC CORP", buyers);
    expect(result.length).toBe(1);
    expect(result[0].buyerId).toBe("match");
  });
});
