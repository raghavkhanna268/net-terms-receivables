/**
 * @vitest-environment jsdom
 */

/**
 * Render tests for ReconcilePage component (#292 currency gate).
 *
 * Verifies that:
 * - INR shop (notSupported=false): actions enabled, no currency banner
 * - Non-INR shop (notSupported=true): shows exactly one currency banner with shared copy
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement, type ReactNode } from "react";

// Mock react-router hooks and Form component before importing the component
vi.mock("react-router", async () => {
  return {
    useLoaderData: vi.fn(),
    useNavigation: vi.fn(() => ({ state: "idle", formData: null })),
    data: vi.fn((d) => d),
    Form: ({ children, ...props }: { children: ReactNode; method?: string }) =>
      createElement("form", props, children),
  };
});

vi.mock("~/services/access-log.server", () => ({
  recordAccess: vi.fn(),
  getActorFromSessionToken: vi.fn().mockReturnValue("test-actor"),
}));

import { useLoaderData } from "react-router";
import ReconcilePage from "../app.reconcile";
import { CURRENCY_NOT_SUPPORTED_BANNER_COPY } from "~/lib/shop-currency-copy";

const mockUseLoaderData = vi.mocked(useLoaderData);

/**
 * Build fixture loader data for ReconcilePage.
 */
function buildLoaderData(overrides: {
  notSupported?: boolean;
  shopCurrency?: string | null;
  payments?: Array<{
    id: string;
    amountPaise: string;
    narration: string;
    payerText: string | null;
    utr: string | null;
    rail: string | null;
  }>;
  error?: string | null;
} = {}) {
  const {
    notSupported = false,
    shopCurrency = "INR",
    payments = [],
    error = null,
  } = overrides;

  return {
    shopCurrency,
    payments,
    matches: [],
    selectedPayment: null,
    pagination: { page: 1, pageSize: 20, totalCount: 0 },
    view: "suggested" as const,
    error,
    tabCounts: { suggested: 0, unmatched: 0, confirmed: 0, pushing: 0 },
    notSupported,
  };
}

describe("ReconcilePage render tests (#292 currency gate)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("INR shop (notSupported=false)", () => {
    it("renders without currency banner and with actions enabled", () => {
      const loaderData = buildLoaderData({
        notSupported: false,
        shopCurrency: "INR",
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(ReconcilePage));

      // Page heading renders
      expect(html).toContain("Payment Reconciliation");

      // NO currency not supported banner
      expect(html).not.toContain("Currency Not Supported");
      expect(html).not.toContain(CURRENCY_NOT_SUPPORTED_BANNER_COPY);

      // Action buttons render and are NOT disabled
      expect(html).toContain("Run Matcher");

      // Parse the HTML and check the button is not disabled using DOM query
      const container = document.createElement("div");
      container.innerHTML = html;
      const runMatcherButton = container.querySelector('s-button[type="submit"]');
      expect(runMatcherButton).not.toBeNull();
      // The button should not be disabled - check attribute is absent or explicitly "false"
      const disabledAttr = runMatcherButton!.getAttribute("disabled");
      expect(disabledAttr === null || disabledAttr === "false").toBe(true);
      // Ensure it's not disabled="true" or disabled=""
      expect(html).not.toContain('disabled="true"');
      expect(html).not.toContain('disabled=""');
    });

    it("renders action bar and tab buttons for INR shop", () => {
      const loaderData = buildLoaderData({
        notSupported: false,
        shopCurrency: "INR",
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(ReconcilePage));

      // Tab buttons render (these are the view switchers)
      expect(html).toContain("Suggested");
      expect(html).toContain("Unmatched");
      expect(html).toContain("Confirmed");
      expect(html).not.toContain("Currency Not Supported");
    });
  });

  describe("non-INR shop (notSupported=true)", () => {
    it("renders exactly one currency banner with shared copy for USD shop", () => {
      const loaderData = buildLoaderData({
        notSupported: true,
        shopCurrency: "USD",
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(ReconcilePage));

      // Page heading renders
      expect(html).toContain("Payment Reconciliation");

      // Exactly one currency not supported banner with the shared copy
      expect(html).toContain("Currency Not Supported");
      expect(html).toContain(CURRENCY_NOT_SUPPORTED_BANNER_COPY);

      // Count occurrences of the banner heading - should be exactly 1
      const bannerMatches = html.match(/Currency Not Supported/g);
      expect(bannerMatches).toHaveLength(1);

      // No payment list or action buttons (early return)
      expect(html).not.toContain("Run Matcher");
    });

    it("renders currency banner for XXX (unknown) shop", () => {
      const loaderData = buildLoaderData({
        notSupported: true,
        shopCurrency: "XXX",
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(ReconcilePage));

      expect(html).toContain("Currency Not Supported");
      expect(html).toContain(CURRENCY_NOT_SUPPORTED_BANNER_COPY);

      // Only one banner
      const bannerMatches = html.match(/Currency Not Supported/g);
      expect(bannerMatches).toHaveLength(1);
    });

    it("renders currency banner for NULL currency shop", () => {
      const loaderData = buildLoaderData({
        notSupported: true,
        shopCurrency: null,
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(ReconcilePage));

      expect(html).toContain("Currency Not Supported");
      expect(html).toContain(CURRENCY_NOT_SUPPORTED_BANNER_COPY);
    });
  });
});
