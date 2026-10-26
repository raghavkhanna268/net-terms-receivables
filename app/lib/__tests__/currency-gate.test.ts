import { describe, it, expect } from "vitest";
import { isCurrencyGateOpen, getEffectiveCurrency } from "../currency-gate.server";

/**
 * #292: Tests for the shared currency gate helper.
 *
 * Verifies fail-closed semantics: only INR is supported,
 * and NULL, undefined, XXX are all treated as unsupported.
 */

describe("isCurrencyGateOpen", () => {
  it("returns true for INR", () => {
    expect(isCurrencyGateOpen("INR")).toBe(true);
  });

  it("returns false for USD", () => {
    expect(isCurrencyGateOpen("USD")).toBe(false);
  });

  it("returns false for EUR", () => {
    expect(isCurrencyGateOpen("EUR")).toBe(false);
  });

  it("returns false for XXX (unknown sentinel)", () => {
    expect(isCurrencyGateOpen("XXX")).toBe(false);
  });

  it("returns false for null (fail-closed)", () => {
    expect(isCurrencyGateOpen(null)).toBe(false);
  });

  it("returns false for undefined (fail-closed)", () => {
    expect(isCurrencyGateOpen(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isCurrencyGateOpen("")).toBe(false);
  });

  it("returns false for lowercase inr (case-sensitive)", () => {
    expect(isCurrencyGateOpen("inr")).toBe(false);
  });
});

describe("getEffectiveCurrency", () => {
  it("returns the currency for valid codes", () => {
    expect(getEffectiveCurrency("INR")).toBe("INR");
    expect(getEffectiveCurrency("USD")).toBe("USD");
    expect(getEffectiveCurrency("EUR")).toBe("EUR");
  });

  it("returns XXX for null", () => {
    expect(getEffectiveCurrency(null)).toBe("XXX");
  });

  it("returns XXX for undefined", () => {
    expect(getEffectiveCurrency(undefined)).toBe("XXX");
  });

  it("returns XXX sentinel as-is", () => {
    expect(getEffectiveCurrency("XXX")).toBe("XXX");
  });
});
