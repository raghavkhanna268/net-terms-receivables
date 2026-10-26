/**
 * #292: Unit tests for shop currency guard decision logic.
 *
 * Tests the decideShopCurrencyUpdate function directly without DB fixtures.
 * This covers NULL stored currency cases that cannot be represented in DB
 * since Shop.currency is NOT NULL in the schema.
 */
import { describe, it, expect } from "vitest";
import { decideShopCurrencyUpdate } from "../shop-currency-guard.server";
import { NO_CURRENCY_SENTINEL, SUPPORTED_SHOP_CURRENCY } from "../shop-currency.server";

describe("decideShopCurrencyUpdate", () => {
  describe("same currency - no change", () => {
    it("INR to INR: allows update, not blocked", () => {
      const result = decideShopCurrencyUpdate({
        storedCurrency: "INR",
        liveCurrency: "INR",
        hasFinancialRows: true,
      });
      expect(result.allowUpdate).toBe(true);
      expect(result.blocked).toBe(false);
      expect(result.effectiveCurrency).toBe("INR");
    });

    it("USD to USD: allows update, not blocked", () => {
      const result = decideShopCurrencyUpdate({
        storedCurrency: "USD",
        liveCurrency: "USD",
        hasFinancialRows: true,
      });
      expect(result.allowUpdate).toBe(true);
      expect(result.blocked).toBe(false);
      expect(result.effectiveCurrency).toBe("USD");
    });
  });

  describe("switching away from INR - always allowed", () => {
    it("INR to USD with rows: allows update", () => {
      const result = decideShopCurrencyUpdate({
        storedCurrency: "INR",
        liveCurrency: "USD",
        hasFinancialRows: true,
      });
      expect(result.allowUpdate).toBe(true);
      expect(result.blocked).toBe(false);
      expect(result.effectiveCurrency).toBe("USD");
    });
  });

  describe("switching TO INR from known currency", () => {
    it("USD to INR with financial rows: BLOCKED", () => {
      const result = decideShopCurrencyUpdate({
        storedCurrency: "USD",
        liveCurrency: "INR",
        hasFinancialRows: true,
      });
      expect(result.allowUpdate).toBe(false);
      expect(result.blocked).toBe(true);
      expect(result.effectiveCurrency).toBe("USD");
    });

    it("USD to INR with zero rows: allows update", () => {
      const result = decideShopCurrencyUpdate({
        storedCurrency: "USD",
        liveCurrency: "INR",
        hasFinancialRows: false,
      });
      expect(result.allowUpdate).toBe(true);
      expect(result.blocked).toBe(false);
      expect(result.effectiveCurrency).toBe("INR");
    });

    it("EUR to INR with financial rows: BLOCKED", () => {
      const result = decideShopCurrencyUpdate({
        storedCurrency: "EUR",
        liveCurrency: "INR",
        hasFinancialRows: true,
      });
      expect(result.allowUpdate).toBe(false);
      expect(result.blocked).toBe(true);
      expect(result.effectiveCurrency).toBe("EUR");
    });
  });

  describe("switching TO INR from XXX (sentinel)", () => {
    it("XXX to INR with financial rows: BLOCKED (fail-closed)", () => {
      const result = decideShopCurrencyUpdate({
        storedCurrency: NO_CURRENCY_SENTINEL,
        liveCurrency: SUPPORTED_SHOP_CURRENCY,
        hasFinancialRows: true,
      });
      expect(result.allowUpdate).toBe(false);
      expect(result.blocked).toBe(true);
      expect(result.effectiveCurrency).toBe(NO_CURRENCY_SENTINEL);
    });

    it("XXX to INR with zero rows: allows update", () => {
      const result = decideShopCurrencyUpdate({
        storedCurrency: NO_CURRENCY_SENTINEL,
        liveCurrency: SUPPORTED_SHOP_CURRENCY,
        hasFinancialRows: false,
      });
      expect(result.allowUpdate).toBe(true);
      expect(result.blocked).toBe(false);
      expect(result.effectiveCurrency).toBe(SUPPORTED_SHOP_CURRENCY);
    });
  });

  describe("NULL stored currency (normalized to XXX by caller)", () => {
    it("simulated NULL (becomes XXX) to INR with financial rows: BLOCKED (fail-closed)", () => {
      // In production, callers normalize NULL to XXX before calling this function
      // e.g. shopRow.currency ?? NO_CURRENCY_SENTINEL
      const nullValue: string | null = null;
      const storedCurrency = nullValue ?? NO_CURRENCY_SENTINEL;
      const result = decideShopCurrencyUpdate({
        storedCurrency,
        liveCurrency: SUPPORTED_SHOP_CURRENCY,
        hasFinancialRows: true,
      });
      expect(result.allowUpdate).toBe(false);
      expect(result.blocked).toBe(true);
      expect(result.effectiveCurrency).toBe(NO_CURRENCY_SENTINEL);
    });

    it("simulated NULL (becomes XXX) to INR with zero rows: allows update", () => {
      const nullValue: string | null = null;
      const storedCurrency = nullValue ?? NO_CURRENCY_SENTINEL;
      const result = decideShopCurrencyUpdate({
        storedCurrency,
        liveCurrency: SUPPORTED_SHOP_CURRENCY,
        hasFinancialRows: false,
      });
      expect(result.allowUpdate).toBe(true);
      expect(result.blocked).toBe(false);
      expect(result.effectiveCurrency).toBe(SUPPORTED_SHOP_CURRENCY);
    });
  });

  describe("edge cases", () => {
    it("already INR stored: allows update regardless of rows", () => {
      const result = decideShopCurrencyUpdate({
        storedCurrency: SUPPORTED_SHOP_CURRENCY,
        liveCurrency: SUPPORTED_SHOP_CURRENCY,
        hasFinancialRows: true,
      });
      expect(result.allowUpdate).toBe(true);
      expect(result.blocked).toBe(false);
    });

    it("stored INR, live non-INR with rows: allows update (switching away)", () => {
      const result = decideShopCurrencyUpdate({
        storedCurrency: SUPPORTED_SHOP_CURRENCY,
        liveCurrency: "USD",
        hasFinancialRows: true,
      });
      expect(result.allowUpdate).toBe(true);
      expect(result.blocked).toBe(false);
      expect(result.effectiveCurrency).toBe("USD");
    });
  });
});
