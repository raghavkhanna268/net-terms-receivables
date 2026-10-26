/**
 * Tests for tag normalization and tag-rule matching parity.
 *
 * (a) Unit tests for normalizeTag
 * (b) Parity tests: both findMatchingTagRule implementations produce same results
 */

import { describe, it, expect } from "vitest";
import { normalizeTag, tagsMatch } from "../tag-normalizer";
import { findMatchingTagRule as customerFindMatchingTagRule } from "~/services/sync/customer.server";
import type { TagRule } from "../due-date";

function invoiceEligibilityFindMatchingTagRule(
  customerTags: string[],
  tagRules: TagRule[]
): TagRule | undefined {
  if (customerTags.length === 0 || tagRules.length === 0) return undefined;
  const normalizedTags = customerTags.map((t) => normalizeTag(t));
  return tagRules.find((rule) => normalizedTags.includes(normalizeTag(rule.tag)));
}

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

describe("tagsMatch", () => {
  it("matches identical tags", () => {
    expect(tagsMatch("wholesale", "wholesale")).toBe(true);
  });

  it("matches with different case", () => {
    expect(tagsMatch("wholesale", "WHOLESALE")).toBe(true);
    expect(tagsMatch("Wholesale", "wholesale")).toBe(true);
  });

  it("matches with leading/trailing spaces", () => {
    expect(tagsMatch(" wholesale ", "wholesale")).toBe(true);
    expect(tagsMatch("wholesale", " wholesale ")).toBe(true);
  });

  it("matches with internal whitespace variation", () => {
    expect(tagsMatch("whole sale", "whole  sale")).toBe(true);
    expect(tagsMatch("whole\tsale", "whole sale")).toBe(true);
  });

  it("does not match different tags", () => {
    expect(tagsMatch("wholesale", "retail")).toBe(false);
  });

  it("does not match empty strings", () => {
    expect(tagsMatch("", "wholesale")).toBe(false);
    expect(tagsMatch("wholesale", "")).toBe(false);
    expect(tagsMatch("", "")).toBe(false);
  });

  it("does not match whitespace-only strings", () => {
    expect(tagsMatch("   ", "wholesale")).toBe(false);
    expect(tagsMatch("wholesale", "   ")).toBe(false);
    expect(tagsMatch("   ", "   ")).toBe(false);
  });
});

describe("Tag-rule matching parity", () => {
  const testCases: Array<{
    name: string;
    customerTags: string[];
    ruleTag: string;
    expectedMatch: boolean;
  }> = [
    {
      name: "exact match",
      customerTags: ["wholesale"],
      ruleTag: "wholesale",
      expectedMatch: true,
    },
    {
      name: "leading/trailing spaces on customer tag",
      customerTags: [" wholesale "],
      ruleTag: "wholesale",
      expectedMatch: true,
    },
    {
      name: "leading/trailing spaces on rule tag",
      customerTags: ["wholesale"],
      ruleTag: " wholesale ",
      expectedMatch: true,
    },
    {
      name: "case difference - customer uppercase",
      customerTags: ["WHOLESALE"],
      ruleTag: "wholesale",
      expectedMatch: true,
    },
    {
      name: "case difference - rule uppercase",
      customerTags: ["wholesale"],
      ruleTag: "WHOLESALE",
      expectedMatch: true,
    },
    {
      name: "mixed case",
      customerTags: ["WholeSale"],
      ruleTag: "wholesale",
      expectedMatch: true,
    },
    {
      name: "internal double space on customer tag",
      customerTags: ["whole  sale"],
      ruleTag: "whole sale",
      expectedMatch: true,
    },
    {
      name: "internal double space on rule tag",
      customerTags: ["whole sale"],
      ruleTag: "whole  sale",
      expectedMatch: true,
    },
    {
      name: "tab in customer tag",
      customerTags: ["VIP\t"],
      ruleTag: "VIP",
      expectedMatch: true,
    },
    {
      name: "tab in rule tag",
      customerTags: ["VIP"],
      ruleTag: "VIP\t",
      expectedMatch: true,
    },
    {
      name: "multiple internal whitespace variations",
      customerTags: ["gold   tier"],
      ruleTag: "gold tier",
      expectedMatch: true,
    },
    {
      name: "no match - different tags",
      customerTags: ["retail"],
      ruleTag: "wholesale",
      expectedMatch: false,
    },
    {
      name: "no match - empty customer tags",
      customerTags: [],
      ruleTag: "wholesale",
      expectedMatch: false,
    },
    {
      name: "no match - whitespace-only customer tag does not match real tag",
      customerTags: ["   "],
      ruleTag: "wholesale",
      expectedMatch: false,
    },
    {
      name: "multiple customer tags - one matches",
      customerTags: ["retail", "wholesale", "vip"],
      ruleTag: "wholesale",
      expectedMatch: true,
    },
    {
      name: "multiple customer tags - none match",
      customerTags: ["retail", "basic", "new"],
      ruleTag: "wholesale",
      expectedMatch: false,
    },
    {
      name: "complex: spaces, case, multiple tags",
      customerTags: [" RETAIL ", "  WholeSale  "],
      ruleTag: "wholesale",
      expectedMatch: true,
    },
  ];

  describe("customer.server.ts findMatchingTagRule", () => {
    for (const tc of testCases) {
      it(tc.name, () => {
        const rules = [{ tag: tc.ruleTag, defaultTermsDays: 30 }];
        const result = customerFindMatchingTagRule(tc.customerTags, rules);
        if (tc.expectedMatch) {
          expect(result).toBeDefined();
          expect(result?.tag).toBe(tc.ruleTag);
        } else {
          expect(result).toBeUndefined();
        }
      });
    }
  });

  describe("invoice-eligibility.ts findMatchingTagRule", () => {
    for (const tc of testCases) {
      it(tc.name, () => {
        const rules: TagRule[] = [{ tag: tc.ruleTag, defaultTermsDays: 30 }];
        const result = invoiceEligibilityFindMatchingTagRule(tc.customerTags, rules);
        if (tc.expectedMatch) {
          expect(result).toBeDefined();
          expect(result?.tag).toBe(tc.ruleTag);
        } else {
          expect(result).toBeUndefined();
        }
      });
    }
  });

  describe("Both matchers produce identical results", () => {
    for (const tc of testCases) {
      it(`parity: ${tc.name}`, () => {
        const rulesForCustomer = [{ tag: tc.ruleTag, defaultTermsDays: 30 }];
        const rulesForInvoice: TagRule[] = [{ tag: tc.ruleTag, defaultTermsDays: 30 }];

        const customerResult = customerFindMatchingTagRule(tc.customerTags, rulesForCustomer);
        const invoiceResult = invoiceEligibilityFindMatchingTagRule(tc.customerTags, rulesForInvoice);

        const customerMatched = customerResult !== undefined;
        const invoiceMatched = invoiceResult !== undefined;

        expect(customerMatched).toBe(invoiceMatched);
        expect(customerMatched).toBe(tc.expectedMatch);
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
      const rules: TagRule[] = [
        { tag: "wholesale", defaultTermsDays: 30 },
        { tag: "wholesale", defaultTermsDays: 60 },
      ];
      const result = invoiceEligibilityFindMatchingTagRule(["wholesale"], rules);
      expect(result?.defaultTermsDays).toBe(30);
    });

    it("first matching rule wins with multiple possible matches", () => {
      const customerRules = [
        { tag: "gold-tier", defaultTermsDays: 45 },
        { tag: "wholesale", defaultTermsDays: 30 },
        { tag: "vip", defaultTermsDays: 60 },
      ];
      const invoiceRules: TagRule[] = [
        { tag: "gold-tier", defaultTermsDays: 45 },
        { tag: "wholesale", defaultTermsDays: 30 },
        { tag: "vip", defaultTermsDays: 60 },
      ];

      const customerResult = customerFindMatchingTagRule(["vip", "wholesale"], customerRules);
      const invoiceResult = invoiceEligibilityFindMatchingTagRule(["vip", "wholesale"], invoiceRules);

      expect(customerResult?.tag).toBe("wholesale");
      expect(invoiceResult?.tag).toBe("wholesale");
    });
  });
});
