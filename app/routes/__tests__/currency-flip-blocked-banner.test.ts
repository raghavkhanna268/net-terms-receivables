/**
 * #292: Tests for currency flip blocked banner content.
 *
 * These tests verify that the flip blocked banner copy and support link
 * are correctly configured.
 */
import { describe, it, expect } from "vitest";
import {
  CURRENCY_FLIP_BLOCKED_BANNER_TEXT,
  CURRENCY_FLIP_BLOCKED_BANNER_COPY,
  CURRENCY_NOT_SUPPORTED_BANNER_COPY,
  SUPPORT_EMAIL_MAILTO,
} from "~/lib/shop-currency-copy";

describe("Currency Flip Blocked Banner content", () => {
  it("has distinct copy from the Currency Not Supported banner", () => {
    expect(CURRENCY_FLIP_BLOCKED_BANNER_COPY).not.toBe(CURRENCY_NOT_SUPPORTED_BANNER_COPY);
  });

  it("mentions existing data", () => {
    expect(CURRENCY_FLIP_BLOCKED_BANNER_TEXT).toMatch(/existing.*data|data.*existing/i);
  });

  it("mentions the app is unavailable", () => {
    expect(CURRENCY_FLIP_BLOCKED_BANNER_TEXT).toMatch(/unavailable/i);
  });

  it("mentions currency conversion is not possible", () => {
    expect(CURRENCY_FLIP_BLOCKED_BANNER_TEXT).toMatch(/cannot convert/i);
  });

  it("SUPPORT_EMAIL_MAILTO is a valid mailto link", () => {
    expect(SUPPORT_EMAIL_MAILTO).toMatch(/^mailto:/);
    expect(SUPPORT_EMAIL_MAILTO).toMatch(/@/);
  });

  it("SUPPORT_EMAIL_MAILTO is re-exported from shop-currency-copy", () => {
    expect(typeof SUPPORT_EMAIL_MAILTO).toBe("string");
    expect(SUPPORT_EMAIL_MAILTO.length).toBeGreaterThan("mailto:".length);
  });
});
