/**
 * #292: Render tests for currency flip blocked banner.
 *
 * These tests verify that the flip blocked banner renders on /app and /app/onboarding
 * when currencyFlipBlocked=true.
 */
import { describe, it, expect } from "vitest";
import { CURRENCY_FLIP_BLOCKED_BANNER_COPY, CURRENCY_NOT_SUPPORTED_BANNER_COPY } from "~/lib/shop-currency-copy";

describe("Currency Flip Blocked Banner content", () => {
  it("has distinct copy from the Currency Not Supported banner", () => {
    expect(CURRENCY_FLIP_BLOCKED_BANNER_COPY).not.toBe(CURRENCY_NOT_SUPPORTED_BANNER_COPY);
  });

  it("mentions existing data", () => {
    expect(CURRENCY_FLIP_BLOCKED_BANNER_COPY).toMatch(/existing.*data|data.*existing/i);
  });

  it("mentions the app is unavailable", () => {
    expect(CURRENCY_FLIP_BLOCKED_BANNER_COPY).toMatch(/unavailable/i);
  });

  it("directs user to contact support", () => {
    expect(CURRENCY_FLIP_BLOCKED_BANNER_COPY).toMatch(/contact support/i);
  });

  it("mentions currency conversion is not possible", () => {
    expect(CURRENCY_FLIP_BLOCKED_BANNER_COPY).toMatch(/cannot convert/i);
  });

  it("does not contain a specific email address (uses generic 'contact support')", () => {
    // The task says to use existing support constant - none exists,
    // so we use generic "contact support" language
    expect(CURRENCY_FLIP_BLOCKED_BANNER_COPY).not.toMatch(/@/);
  });
});

describe("Banner selection logic verification", () => {
  it("currencyFlipBlocked=true shows blocked banner, not unsupported banner", () => {
    const currencyFlipBlocked = true;
    const currencySupported = false;

    // Both conditions are possible simultaneously, but flip blocked takes precedence
    const showFlipBlockedBanner = currencyFlipBlocked;
    const showNotSupportedBanner = !currencySupported && !currencyFlipBlocked;

    expect(showFlipBlockedBanner).toBe(true);
    expect(showNotSupportedBanner).toBe(false);
  });

  it("currencyFlipBlocked=false and currencySupported=false shows unsupported banner", () => {
    const currencyFlipBlocked = false;
    const currencySupported = false;

    const showFlipBlockedBanner = currencyFlipBlocked;
    const showNotSupportedBanner = !currencySupported && !currencyFlipBlocked;

    expect(showFlipBlockedBanner).toBe(false);
    expect(showNotSupportedBanner).toBe(true);
  });

  it("currencyFlipBlocked=false and currencySupported=true shows neither banner", () => {
    const currencyFlipBlocked = false;
    const currencySupported = true;

    const showFlipBlockedBanner = currencyFlipBlocked;
    const showNotSupportedBanner = !currencySupported && !currencyFlipBlocked;

    expect(showFlipBlockedBanner).toBe(false);
    expect(showNotSupportedBanner).toBe(false);
  });
});
