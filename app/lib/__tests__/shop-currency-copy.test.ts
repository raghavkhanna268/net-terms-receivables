/**
 * Tests for shop-currency-copy.ts banner copy strings.
 *
 * Test (d): Pin the exact banner copy string to prevent accidental changes.
 */
import { describe, it, expect } from "vitest";
import { CURRENCY_NOT_SUPPORTED_BANNER_COPY } from "../shop-currency-copy";

describe("shop-currency-copy", () => {
  describe("CURRENCY_NOT_SUPPORTED_BANNER_COPY", () => {
    it("contains instruction to reload and click Start sync under Initial Sync", () => {
      expect(CURRENCY_NOT_SUPPORTED_BANNER_COPY).toContain(
        "then reload this page and click **Start sync** under Initial Sync."
      );
    });

    it("pins the exact expected string (fails on revert)", () => {
      expect(CURRENCY_NOT_SUPPORTED_BANNER_COPY).toBe(
        "Termwise is built for Indian merchants and currently supports INR only. " +
        "To use it, the store owner must change the store currency to Indian Rupee (INR) in " +
        "Shopify admin → Settings → General → Store defaults → Currency display → ⋯ → Change store currency, " +
        "then reload this page and click **Start sync** under Initial Sync. If your store already has orders, Shopify asks you to confirm the change."
      );
    });
  });
});
