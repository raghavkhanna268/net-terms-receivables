import { describe, it, expect } from "vitest";
import {
  pluralize,
  pluralizeWithCount,
  SUPPORTED_BANKS,
  BANK_DISPLAY_NAMES,
  formatSupportedBankList,
  IMPORT_ERROR_LABELS,
  getImportErrorLabel,
  formatValidationError,
  formatShopifyGid,
  isShopifyGid,
} from "../copy-helpers";
import type { BankId } from "../banks/types";

/**
 * Copy helpers tests for merchant-facing text.
 * 
 * Tests ensure:
 * - Pluralisation works correctly for "1 day" vs "2 days"
 * - Bank list matches the parser registry (HDFC, ICICI, SBI, Axis)
 * - Parser routing reaches real parsers for all supported banks
 * - Error labels have fallbacks for unknown codes
 * - Shopify GIDs are never rendered raw
 */

describe("pluralize", () => {
  describe("day/days", () => {
    it("returns singular for count 1", () => {
      expect(pluralize(1, "day")).toBe("day");
    });

    it("returns plural for count 0", () => {
      expect(pluralize(0, "day")).toBe("days");
    });

    it("returns plural for count > 1", () => {
      expect(pluralize(5, "day")).toBe("days");
    });

    it("returns singular for count -1", () => {
      expect(pluralize(-1, "day")).toBe("day");
    });

    it("returns plural for count -5", () => {
      expect(pluralize(-5, "day")).toBe("days");
    });
  });

  describe("custom plural forms", () => {
    it("uses custom plural form when provided", () => {
      expect(pluralize(0, "person", "people")).toBe("people");
      expect(pluralize(1, "person", "people")).toBe("person");
      expect(pluralize(2, "person", "people")).toBe("people");
    });
  });
});

describe("pluralizeWithCount", () => {
  it("formats '1 day' correctly", () => {
    expect(pluralizeWithCount(1, "day")).toBe("1 day");
  });

  it("formats '5 days' correctly", () => {
    expect(pluralizeWithCount(5, "day")).toBe("5 days");
  });

  it("formats '0 locations' correctly", () => {
    expect(pluralizeWithCount(0, "location")).toBe("0 locations");
  });

  it("formats '-1 day' correctly", () => {
    expect(pluralizeWithCount(-1, "day")).toBe("-1 day");
  });

  it("handles custom plural forms", () => {
    expect(pluralizeWithCount(2, "person", "people")).toBe("2 people");
  });
});

describe("SUPPORTED_BANKS", () => {
  it("includes exactly the banks in the parser registry", () => {
    expect(SUPPORTED_BANKS).toEqual(["HDFC", "ICICI", "SBI", "AXIS"]);
  });

  it("does not include UNKNOWN", () => {
    expect(SUPPORTED_BANKS).not.toContain("UNKNOWN");
  });

  it("has display names for all supported banks", () => {
    for (const bank of SUPPORTED_BANKS) {
      expect(BANK_DISPLAY_NAMES[bank]).toBeDefined();
      expect(typeof BANK_DISPLAY_NAMES[bank]).toBe("string");
    }
  });

  it("includes all non-UNKNOWN BankId values", () => {
    const allBankIds: BankId[] = ["HDFC", "ICICI", "SBI", "AXIS", "UNKNOWN"];
    const nonUnknownBankIds = allBankIds.filter((b) => b !== "UNKNOWN");
    
    for (const bankId of nonUnknownBankIds) {
      expect(SUPPORTED_BANKS).toContain(bankId);
    }
  });
});

describe("SUPPORTED_BANKS parser routing", () => {
  it("every bank in SUPPORTED_BANKS reaches a real parser (not UNKNOWN_BANK_FORMAT)", async () => {
    const { parseBankStatement } = await import("../banks/index");
    
    for (const bank of SUPPORTED_BANKS) {
      const minimalCsv = `Date,Narration,Amount\n2024-01-01,Test,100`;
      const content = new TextEncoder().encode(minimalCsv).buffer;
      
      const result = await parseBankStatement(content as ArrayBuffer, {
        fileName: `${bank.toLowerCase()}_statement.csv`,
      });
      
      const hasUnknownBankError = result.errors.some(
        (e) => e.code === "UNKNOWN_BANK_FORMAT"
      );
      
      expect(hasUnknownBankError).toBe(false);
    }
  });
});

describe("formatSupportedBankList", () => {
  it("formats all banks with 'or' before the last using display names", () => {
    const result = formatSupportedBankList();
    expect(result).toBe("HDFC, ICICI, SBI or Axis");
  });

  it("uses BANK_DISPLAY_NAMES for all banks", () => {
    const result = formatSupportedBankList();
    for (const bank of SUPPORTED_BANKS) {
      const displayName = BANK_DISPLAY_NAMES[bank];
      expect(result).toContain(displayName);
    }
  });
});

describe("IMPORT_ERROR_LABELS", () => {
  describe("known error codes", () => {
    it("has human-readable labels for ROW_PARSE_FAILED", () => {
      expect(IMPORT_ERROR_LABELS.ROW_PARSE_FAILED).toBe("Couldn't read row");
    });

    it("has human-readable labels for NORMALIZE_FAILED", () => {
      expect(IMPORT_ERROR_LABELS.NORMALIZE_FAILED).toBe("Couldn't process transaction");
    });

    it("has human-readable labels for NO_HEADER_ROW", () => {
      expect(IMPORT_ERROR_LABELS.NO_HEADER_ROW).toBe("Missing header row");
    });

    it("has human-readable labels for COLUMN_MAP_FAILED", () => {
      expect(IMPORT_ERROR_LABELS.COLUMN_MAP_FAILED).toBe("Unrecognised column layout");
    });

    it("has human-readable labels for UNKNOWN_BANK_FORMAT", () => {
      expect(IMPORT_ERROR_LABELS.UNKNOWN_BANK_FORMAT).toBe("Unrecognised bank format");
    });
  });
});

describe("getImportErrorLabel", () => {
  it("returns the label for known error codes", () => {
    expect(getImportErrorLabel("ROW_PARSE_FAILED")).toBe("Couldn't read row");
    expect(getImportErrorLabel("NORMALIZE_FAILED")).toBe("Couldn't process transaction");
  });

  it("falls back to 'Error' for unknown codes", () => {
    expect(getImportErrorLabel("UNKNOWN_CODE")).toBe("Error");
    expect(getImportErrorLabel("SOME_FUTURE_CODE")).toBe("Error");
  });
});

describe("formatValidationError", () => {
  describe("without sourceRowLookup (fallback to Transaction N)", () => {
    it("converts credits.0.amountPaise to 'Transaction 1: amount could not be read'", () => {
      const result = formatValidationError("credits.0.amountPaise", "Amount must be a positive integer");
      expect(result).toBe("Transaction 1: amount could not be read");
    });

    it("converts credits.3.date to 'Transaction 4: date is not a valid date'", () => {
      const result = formatValidationError("credits.3.date", "Date must be YYYY-MM-DD");
      expect(result).toBe("Transaction 4: date is not a valid date");
    });

    it("handles valueDate field", () => {
      const result = formatValidationError("credits.5.valueDate", "Value date must be YYYY-MM-DD");
      expect(result).toBe("Transaction 6: value date is not a valid date");
    });

    it("handles generic 'must be' messages", () => {
      const result = formatValidationError("credits.2.rail", "Rail must be one of: NEFT, RTGS");
      expect(result).toBe("Transaction 3: payment type is invalid");
    });
  });

  describe("with sourceRowLookup (shows spreadsheet row)", () => {
    it("uses sourceRow when available", () => {
      const sourceRowLookup = (idx: number) => {
        const rows = [15, 16, 20, 25];
        return rows[idx];
      };
      
      const result = formatValidationError(
        "credits.2.amountPaise",
        "Amount must be a positive integer",
        sourceRowLookup
      );
      expect(result).toBe("Row 20: amount could not be read");
    });

    it("falls back to Transaction N when sourceRow is undefined", () => {
      const sourceRowLookup = (idx: number) => {
        if (idx === 5) return undefined;
        return idx + 10;
      };
      
      const result = formatValidationError(
        "credits.5.date",
        "Date must be YYYY-MM-DD",
        sourceRowLookup
      );
      expect(result).toBe("Transaction 6: date is not a valid date");
    });
  });

  describe("non-credits paths", () => {
    it("returns message as-is for empty path", () => {
      const result = formatValidationError("", "Request body must be an object");
      expect(result).toBe("Request body must be an object");
    });

    it("returns message as-is for 'credits' path", () => {
      const result = formatValidationError("credits", "At least one credit row is required");
      expect(result).toBe("At least one credit row is required");
    });
  });
});

describe("formatShopifyGid", () => {
  describe("valid GID parsing - returns resource type", () => {
    it("returns 'Customer' for a valid Customer GID", () => {
      expect(formatShopifyGid("gid://shopify/Customer/123456")).toBe("Customer");
    });

    it("returns 'Order' for a valid Order GID", () => {
      expect(formatShopifyGid("gid://shopify/Order/789")).toBe("Order");
    });

    it("returns 'DraftOrder' for a valid DraftOrder GID", () => {
      expect(formatShopifyGid("gid://shopify/DraftOrder/42")).toBe("DraftOrder");
    });

    it("ignores fallback when GID parses successfully (fallback never swallows parsed value)", () => {
      expect(formatShopifyGid("gid://shopify/Customer/123456", "Ignored Fallback")).toBe("Customer");
      expect(formatShopifyGid("gid://shopify/Order/789", "Ignored Fallback")).toBe("Order");
    });
  });

  describe("fallback only when parsing fails", () => {
    it("uses fallback for invalid GID format", () => {
      expect(formatShopifyGid("invalid-gid", "Unknown Customer")).toBe("Unknown Customer");
    });

    it("uses fallback for malformed GID without numeric ID", () => {
      expect(formatShopifyGid("gid://shopify/Customer/", "Fallback")).toBe("Fallback");
    });

    it("uses fallback for non-numeric ID", () => {
      expect(formatShopifyGid("gid://shopify/Customer/abc", "Fallback")).toBe("Fallback");
    });

    it("returns 'Customer' as default fallback for invalid GID without explicit fallback", () => {
      expect(formatShopifyGid("not-a-gid")).toBe("Customer");
    });
  });
});

describe("isShopifyGid", () => {
  it("returns true for valid Shopify GID", () => {
    expect(isShopifyGid("gid://shopify/Customer/123")).toBe(true);
    expect(isShopifyGid("gid://shopify/Order/456")).toBe(true);
  });

  it("returns false for non-GID strings", () => {
    expect(isShopifyGid("123456")).toBe(false);
    expect(isShopifyGid("customer-123")).toBe(false);
    expect(isShopifyGid("")).toBe(false);
  });
});

describe("no raw GID in UI", () => {
  it("formatShopifyGid never returns a string starting with gid://", () => {
    const testGids = [
      "gid://shopify/Customer/123",
      "gid://shopify/Order/456",
      "gid://shopify/DraftOrder/789",
    ];

    for (const gid of testGids) {
      const result = formatShopifyGid(gid);
      expect(result).not.toMatch(/^gid:\/\//);
    }
  });

  it("formatShopifyGid returns resource type without numeric ID", () => {
    const result = formatShopifyGid("gid://shopify/Customer/12345");
    expect(result).toBe("Customer");
    expect(result).not.toContain("12345");
  });
});
