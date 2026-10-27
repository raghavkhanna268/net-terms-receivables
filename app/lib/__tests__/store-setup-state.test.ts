/**
 * Tests for store-setup-state.ts helper.
 *
 * Tests the decision table for store setup status:
 * - No shop row → setting_up
 * - Shop with currency XXX → setting_up
 * - Shop with non-INR currency (USD, EUR, etc.) → not_supported
 * - Shop with INR currency → supported
 */
import { describe, it, expect } from "vitest";
import { getStoreSetupStatus, isStoreBlocked } from "../store-setup-state";

describe("store-setup-state", () => {
  describe("getStoreSetupStatus decision table", () => {
    it("returns setting_up when shop row is null", () => {
      expect(getStoreSetupStatus(null)).toBe("setting_up");
    });

    it("returns setting_up when shop row is undefined", () => {
      expect(getStoreSetupStatus(undefined)).toBe("setting_up");
    });

    it("returns setting_up when currency is XXX (placeholder)", () => {
      expect(getStoreSetupStatus({ currency: "XXX" })).toBe("setting_up");
    });

    it("returns setting_up when currency is null", () => {
      expect(getStoreSetupStatus({ currency: null })).toBe("setting_up");
    });

    it("returns not_supported when currency is USD", () => {
      expect(getStoreSetupStatus({ currency: "USD" })).toBe("not_supported");
    });

    it("returns not_supported when currency is EUR", () => {
      expect(getStoreSetupStatus({ currency: "EUR" })).toBe("not_supported");
    });

    it("returns not_supported when currency is GBP", () => {
      expect(getStoreSetupStatus({ currency: "GBP" })).toBe("not_supported");
    });

    it("returns supported when currency is INR", () => {
      expect(getStoreSetupStatus({ currency: "INR" })).toBe("supported");
    });
  });

  describe("isStoreBlocked", () => {
    it("returns true for setting_up", () => {
      expect(isStoreBlocked("setting_up")).toBe(true);
    });

    it("returns true for not_supported", () => {
      expect(isStoreBlocked("not_supported")).toBe(true);
    });

    it("returns false for supported", () => {
      expect(isStoreBlocked("supported")).toBe(false);
    });
  });
});
