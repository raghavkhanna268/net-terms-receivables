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

/**
 * Copy helpers tests for merchant-facing text.
 * 
 * Tests ensure:
 * - Pluralisation works correctly for "1 day" vs "2 days"
 * - Bank list matches the parser registry (HDFC, ICICI, SBI, Axis)
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
});

describe("formatSupportedBankList", () => {
  it("formats all banks with 'or' before the last", () => {
    const result = formatSupportedBankList();
    expect(result).toBe("HDFC, ICICI, SBI or Axis Bank");
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
  describe("credits path formatting", () => {
    it("converts credits.0.amountPaise to 'Row 1: amount could not be read'", () => {
      const result = formatValidationError("credits.0.amountPaise", "Amount must be a positive integer");
      expect(result).toBe("Row 1: amount could not be read");
    });

    it("converts credits.3.date to 'Row 4: date is not a valid date'", () => {
      const result = formatValidationError("credits.3.date", "Date must be YYYY-MM-DD");
      expect(result).toBe("Row 4: date is not a valid date");
    });

    it("handles valueDate field", () => {
      const result = formatValidationError("credits.5.valueDate", "Value date must be YYYY-MM-DD");
      expect(result).toBe("Row 6: value date is not a valid date");
    });

    it("handles generic 'must be' messages", () => {
      const result = formatValidationError("credits.2.rail", "Rail must be one of: NEFT, RTGS");
      expect(result).toBe("Row 3: payment type is invalid");
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
  it("extracts resource type from a valid GID", () => {
    expect(formatShopifyGid("gid://shopify/Customer/123456")).toBe("Customer");
  });

  it("extracts resource type for Order GID", () => {
    expect(formatShopifyGid("gid://shopify/Order/789")).toBe("Order");
  });

  it("uses fallback when provided for valid GID", () => {
    expect(formatShopifyGid("gid://shopify/Customer/123456", "Buyer")).toBe("Buyer");
  });

  it("uses fallback for invalid GID format", () => {
    expect(formatShopifyGid("invalid-gid", "Customer")).toBe("Customer");
  });

  it("returns 'Customer' for invalid GID without fallback", () => {
    expect(formatShopifyGid("not-a-gid")).toBe("Customer");
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
});
