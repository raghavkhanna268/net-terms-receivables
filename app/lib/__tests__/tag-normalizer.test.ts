/**
 * Tests for tag normalization and tag-rule matching parity.
 *
 * (a) Unit tests for normalizeTag
 * (b) Parity tests: both findMatchingTagRule implementations produce same results
 */

import { describe, it, expect } from "vitest";
import { normalizeTag } from "../tag-normalizer";
import { findMatchingTagRule as customerFindMatchingTagRule } from "~/services/sync/customer.server";
import { findMatchingTagRule as invoiceFindMatchingTagRule } from "../invoice-eligibility";

describe("normalizeTag", () => {
  describe("leading/trailing whitespace", () => {
    it("trims leading spaces", () => {
      expect(normalizeTag("  wholesale")).toBe("wholesale");
    });

    it("trims trailing spaces", () => {
      expect(normalizeTag("wholesale  ")).toBe("wholesale");
    });

    it("trims both leading and trailing spaces", () => {
      expect(normalizeTag("  wholesale  ")).toBe("wholesale");
    });

    it("trims leading and trailing tabs", () => {
      expect(normalizeTag("\twholesale\t")).toBe("wholesale");
    });

    it("trims mixed whitespace", () => {
      expect(normalizeTag(" \t wholesale \t ")).toBe("wholesale");
    });
  });

  describe("internal whitespace collapse", () => {
    it("collapses double spaces to single space", () => {
      expect(normalizeTag("whole  sale")).toBe("whole sale");
    });

    it("collapses multiple spaces to single space", () => {
      expect(normalizeTag("whole    sale")).toBe("whole sale");
    });

    it("collapses tabs to single space", () => {
      expect(normalizeTag("whole\tsale")).toBe("whole sale");
    });

    it("collapses mixed internal whitespace", () => {
      expect(normalizeTag("whole \t  sale")).toBe("whole sale");
    });

    it("handles multiple internal whitespace runs", () => {
      expect(normalizeTag("a  b   c")).toBe("a b c");
    });
  });

  describe("case normalization", () => {
    it("lowercases uppercase", () => {
      expect(normalizeTag("WHOLESALE")).toBe("wholesale");
    });

    it("lowercases mixed case", () => {
      expect(normalizeTag("WhoLeSaLe")).toBe("wholesale");
    });

    it("preserves already lowercase", () => {
      expect(normalizeTag("wholesale")).toBe("wholesale");
    });
  });

  describe("combined normalization", () => {
    it("handles all transformations together", () => {
      expect(normalizeTag("  WHOLE  SALE  ")).toBe("whole sale");
    });

    it("handles complex whitespace with mixed case", () => {
      expect(normalizeTag("\t VIP \t Customer \t")).toBe("vip customer");
    });
  });

  describe("edge cases", () => {
    it("returns empty string for empty input", () => {
      expect(normalizeTag("")).toBe("");
    });

    it("returns empty string for whitespace-only input", () => {
      expect(normalizeTag("   ")).toBe("");
    });

    it("returns empty string for tabs-only input", () => {
      expect(normalizeTag("\t\t")).toBe("");
    });

    it("handles single character", () => {
      expect(normalizeTag("a")).toBe("a");
    });

    it("handles single character with spaces", () => {
      expect(normalizeTag(" a ")).toBe("a");
    });
  });
});

describe("Tag-rule matching parity", () => {
  const testCases: Array<{
    name: string;
    customerTags: string[];
    ruleTag: string;
    expectedTag: string | null;
  }> = [
    {
      name: "exact match",
      customerTags: ["wholesale"],
      ruleTag: "wholesale",
      expectedTag: "wholesale",
    },
    {
      name: "leading/trailing spaces on customer tag",
      customerTags: [" wholesale "],
      ruleTag: "wholesale",
      expectedTag: "wholesale",
    },
    {
      name: "leading/trailing spaces on rule tag",
      customerTags: ["wholesale"],
      ruleTag: " wholesale ",
      expectedTag: " wholesale ",
    },
    {
      name: "case difference - customer uppercase",
      customerTags: ["WHOLESALE"],
      ruleTag: "wholesale",
      expectedTag: "wholesale",
    },
    {
      name: "case difference - rule uppercase",
      customerTags: ["wholesale"],
      ruleTag: "WHOLESALE",
      expectedTag: "WHOLESALE",
    },
    {
      name: "mixed case",
      customerTags: ["WholeSale"],
      ruleTag: "wholesale",
      expectedTag: "wholesale",
    },
    {
      name: "internal double space on customer tag",
      customerTags: ["whole  sale"],
      ruleTag: "whole sale",
      expectedTag: "whole sale",
    },
    {
      name: "internal double space on rule tag",
      customerTags: ["whole sale"],
      ruleTag: "whole  sale",
      expectedTag: "whole  sale",
    },
    {
      name: "tab in customer tag",
      customerTags: ["VIP\t"],
      ruleTag: "VIP",
      expectedTag: "VIP",
    },
    {
      name: "tab in rule tag",
      customerTags: ["VIP"],
      ruleTag: "VIP\t",
      expectedTag: "VIP\t",
    },
    {
      name: "multiple internal whitespace variations",
      customerTags: ["gold   tier"],
      ruleTag: "gold tier",
      expectedTag: "gold tier",
    },
    {
      name: "no match - different tags",
      customerTags: ["retail"],
      ruleTag: "wholesale",
      expectedTag: null,
    },
    {
      name: "no match - empty customer tags",
      customerTags: [],
      ruleTag: "wholesale",
      expectedTag: null,
    },
    {
      name: "no match - whitespace-only customer tag does not match real tag",
      customerTags: ["   "],
      ruleTag: "wholesale",
      expectedTag: null,
    },
    {
      name: "multiple customer tags - one matches",
      customerTags: ["retail", "wholesale", "vip"],
      ruleTag: "wholesale",
      expectedTag: "wholesale",
    },
    {
      name: "multiple customer tags - none match",
      customerTags: ["retail", "basic", "new"],
      ruleTag: "wholesale",
      expectedTag: null,
    },
    {
      name: "complex: spaces, case, multiple tags",
      customerTags: [" RETAIL ", "  WholeSale  "],
      ruleTag: "wholesale",
      expectedTag: "wholesale",
    },
  ];

  describe("customer.server.ts findMatchingTagRule", () => {
    for (const tc of testCases) {
      it(tc.name, () => {
        const rules = [{ tag: tc.ruleTag, defaultTermsDays: 30 }];
        const result = customerFindMatchingTagRule(tc.customerTags, rules);
        expect(result?.tag ?? null).toBe(tc.expectedTag);
      });
    }
  });

  describe("invoice-eligibility.ts findMatchingTagRule", () => {
    for (const tc of testCases) {
      it(tc.name, () => {
        const rules = [{ tag: tc.ruleTag, defaultTermsDays: 30 }];
        const result = invoiceFindMatchingTagRule(tc.customerTags, rules);
        expect(result?.tag ?? null).toBe(tc.expectedTag);
      });
    }
  });

  describe("Both matchers produce identical results", () => {
    for (const tc of testCases) {
      it(`parity: ${tc.name}`, () => {
        const rules = [{ tag: tc.ruleTag, defaultTermsDays: 30 }];

        const customerResult = customerFindMatchingTagRule(tc.customerTags, rules);
        const invoiceResult = invoiceFindMatchingTagRule(tc.customerTags, rules);

        expect(customerResult?.tag ?? null).toBe(invoiceResult?.tag ?? null);
        expect(customerResult?.tag ?? null).toBe(tc.expectedTag);
      });
    }
  });

  describe("Rule order semantics (first matching rule wins)", () => {
    it("customer.server.ts returns first matching rule", () => {
      const rules = [
        { tag: "wholesale", defaultTermsDays: 30 },
        { tag: "wholesale", defaultTermsDays: 60 },
      ];
      const result = customerFindMatchingTagRule(["wholesale"], rules);
      expect(result?.defaultTermsDays).toBe(30);
    });

    it("invoice-eligibility.ts returns first matching rule", () => {
      const rules = [
        { tag: "wholesale", defaultTermsDays: 30 },
        { tag: "wholesale", defaultTermsDays: 60 },
      ];
      const result = invoiceFindMatchingTagRule(["wholesale"], rules);
      expect(result?.defaultTermsDays).toBe(30);
    });

    it("first matching rule wins with multiple possible matches", () => {
      const rules = [
        { tag: "gold-tier", defaultTermsDays: 45 },
        { tag: "wholesale", defaultTermsDays: 30 },
        { tag: "vip", defaultTermsDays: 60 },
      ];

      const customerResult = customerFindMatchingTagRule(["vip", "wholesale"], rules);
      const invoiceResult = invoiceFindMatchingTagRule(["vip", "wholesale"], rules);

      expect(customerResult?.tag).toBe("wholesale");
      expect(invoiceResult?.tag).toBe("wholesale");
    });
  });
});
