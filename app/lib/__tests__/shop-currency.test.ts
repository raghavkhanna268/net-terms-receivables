import { describe, it, expect } from "vitest";
import {
  SUPPORTED_SHOP_CURRENCY,
  NO_CURRENCY_SENTINEL,
  CURRENCY_NOT_SUPPORTED_BANNER_COPY,
  isShopCurrencySupported,
  validateCurrencyCode,
} from "../shop-currency.server";

describe("shop-currency constants", () => {
  it("SUPPORTED_SHOP_CURRENCY is INR", () => {
    expect(SUPPORTED_SHOP_CURRENCY).toBe("INR");
  });

  it("NO_CURRENCY_SENTINEL is XXX", () => {
    expect(NO_CURRENCY_SENTINEL).toBe("XXX");
  });

  it("CURRENCY_NOT_SUPPORTED_BANNER_COPY contains required elements", () => {
    expect(CURRENCY_NOT_SUPPORTED_BANNER_COPY).toContain("Termwise is built for Indian merchants");
    expect(CURRENCY_NOT_SUPPORTED_BANNER_COPY).toContain("INR only");
    expect(CURRENCY_NOT_SUPPORTED_BANNER_COPY).toContain("store owner must change");
    expect(CURRENCY_NOT_SUPPORTED_BANNER_COPY).toContain("Settings → General → Store defaults");
    expect(CURRENCY_NOT_SUPPORTED_BANNER_COPY).toContain("Change store currency");
    expect(CURRENCY_NOT_SUPPORTED_BANNER_COPY).toContain("Shopify asks you to confirm");
  });
});

describe("isShopCurrencySupported", () => {
  it("returns true for INR", () => {
    expect(isShopCurrencySupported("INR")).toBe(true);
  });

  it("returns false for USD", () => {
    expect(isShopCurrencySupported("USD")).toBe(false);
  });

  it("returns false for EUR", () => {
    expect(isShopCurrencySupported("EUR")).toBe(false);
  });

  it("returns false for XXX (no currency sentinel)", () => {
    expect(isShopCurrencySupported("XXX")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isShopCurrencySupported(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isShopCurrencySupported(undefined)).toBe(false);
  });

  it("returns false for lowercase inr", () => {
    expect(isShopCurrencySupported("inr")).toBe(false);
  });
});

describe("validateCurrencyCode", () => {
  it("validates uppercase 3-letter codes", () => {
    expect(validateCurrencyCode("INR")).toBe("INR");
    expect(validateCurrencyCode("USD")).toBe("USD");
    expect(validateCurrencyCode("EUR")).toBe("EUR");
    expect(validateCurrencyCode("XXX")).toBe("XXX");
  });

  it("returns null for lowercase codes", () => {
    expect(validateCurrencyCode("inr")).toBeNull();
    expect(validateCurrencyCode("usd")).toBeNull();
  });

  it("returns null for mixed case codes", () => {
    expect(validateCurrencyCode("Inr")).toBeNull();
    expect(validateCurrencyCode("INr")).toBeNull();
  });

  it("returns null for codes with wrong length", () => {
    expect(validateCurrencyCode("IN")).toBeNull();
    expect(validateCurrencyCode("INRX")).toBeNull();
    expect(validateCurrencyCode("")).toBeNull();
  });

  it("returns null for non-string values", () => {
    expect(validateCurrencyCode(123)).toBeNull();
    expect(validateCurrencyCode(null)).toBeNull();
    expect(validateCurrencyCode(undefined)).toBeNull();
    expect(validateCurrencyCode({})).toBeNull();
    expect(validateCurrencyCode([])).toBeNull();
  });

  it("returns null for codes with numbers", () => {
    expect(validateCurrencyCode("IN1")).toBeNull();
    expect(validateCurrencyCode("123")).toBeNull();
  });
});
