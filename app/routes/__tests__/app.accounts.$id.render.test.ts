/**
 * Render tests for AccountPage component (T1 plan-limit gating).
 *
 * Verifies that credit-status and credit-hold UI renders regardless
 * of plan-limit gating status, while over-limit banners only appear
 * when gating is enforced.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement, type ReactNode } from "react";

// Mock react-router hooks and Form component before importing the component
vi.mock("react-router", async () => {
  return {
    useLoaderData: vi.fn(),
    useActionData: vi.fn(() => undefined),
    useNavigation: vi.fn(() => ({ state: "idle", formData: null })),
    data: vi.fn((d) => d),
    Form: ({ children, ...props }: { children: ReactNode; method?: string }) =>
      createElement("form", props, children),
  };
});

// Mock gating.server - do NOT mock log.server.ts
vi.mock("~/services/gating.server", () => ({
  isAccountActive: vi.fn(() => true),
  isGatingEnforced: vi.fn(() => false),
}));

import { useLoaderData } from "react-router";
import AccountPage from "../app.accounts.$id";

const mockUseLoaderData = vi.mocked(useLoaderData);

/**
 * Build fixture loader data for AccountPage.
 */
function buildLoaderData(overrides: {
  isGated?: boolean;
  gatingEnforced?: boolean;
  planKey?: string;
  companiesUsed?: number;
} = {}) {
  const {
    isGated = false,
    gatingEnforced = false,
  } = overrides;

  return {
    account: {
      id: "acct-test-123",
      name: "Test Buyer Corp",
      kind: "COMPANY" as const,
      companyId: "gid://shopify/Company/123",
      defaultTermsDays: 30,
      defaultTermsSource: "explicit" as const,
      isGated,
    },
    upgradeUrl: "https://admin.shopify.com/store/test/charges/app/pricing_plans",
    creditStatus: {
      creditLimitAmount: 100000,
      creditLimitPaise: "10000000",
      exposurePaise: "5000000",
      draftExposurePaise: "0",
      availableCreditPaise: "5000000",
      currency: "INR",
      holdState: "OK" as const,
      manualHold: false,
      holdReasonCode: null,
      holdNote: null,
      isOnHold: false,
      holdReasonDisplay: null,
      isOverLimit: false,
      isOverdue: false,
      utilizationPercent: 50,
      syncPending: false,
      syncErrorCode: null,
      syncState: "synced" as const,
      hasDeadLetteredSync: false,
      syncErrorInfo: null,
    },
    companyTotals: null,
    invoices: { rows: [], totalCount: 0 },
    gatingEnforced,
    reminderOptOut: null,
    error: null,
  };
}

describe("AccountPage render tests (T1 plan-limit gating)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("gating OFF: credit-status and credit-hold UI renders, no over-limit UI", () => {
    it("none plan, gating OFF: shows credit status and hold controls, no over-limit banner", () => {
      const loaderData = buildLoaderData({
        isGated: false, // Account is NOT gated when gating is off
        gatingEnforced: false,
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(AccountPage));

      // Credit Status section renders
      expect(html).toContain("Credit Status");
      expect(html).toContain("Hold Status");
      expect(html).toContain(">OK<"); // OK badge

      // Manual hold control renders (the checkbox label)
      expect(html).toContain("Place manual hold on this account");

      // Full credit edit form renders (not restricted)
      expect(html).toContain("Save Credit Settings");

      // Over-limit banner heading is ABSENT
      expect(html).not.toContain("This account is over your plan limit");
      // No Limit Reached badge
      expect(html).not.toContain("Limit Reached");
      // The upgrade restriction banner is ABSENT
      expect(html).not.toContain("Upgrade to edit credit settings");
    });

    it("starter plan, gating OFF: same assertions", () => {
      const loaderData = buildLoaderData({
        isGated: false, // Account is NOT gated when gating is off
        gatingEnforced: false,
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(AccountPage));

      // Credit Status section renders
      expect(html).toContain("Credit Status");
      expect(html).toContain("Hold Status");

      // Manual hold control renders
      expect(html).toContain("Place manual hold on this account");

      // Full credit edit form renders
      expect(html).toContain("Save Credit Settings");

      // Over-limit banner is ABSENT
      expect(html).not.toContain("This account is over your plan limit");
      expect(html).not.toContain("Limit Reached");
      expect(html).not.toContain("Upgrade to edit credit settings");
    });
  });

  describe("gating ON: over-limit UI appears for gated accounts", () => {
    it("gated account with gating ON: shows over-limit banner", () => {
      const loaderData = buildLoaderData({
        isGated: true, // Account is marked as gated (over limit)
        gatingEnforced: true, // Gating IS enforced
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(AccountPage));

      // Over-limit banner heading is present
      expect(html).toContain("This account is over your plan limit");
      // The gated account shows the "Upgrade to edit" banner with hold-only controls
      expect(html).toContain("Upgrade to edit credit settings");
      // Manual hold control still renders (works on all plans)
      expect(html).toContain("Place manual hold on this account");
    });

    it("non-gated account with gating ON: no over-limit banner", () => {
      const loaderData = buildLoaderData({
        isGated: false, // Account is NOT gated
        gatingEnforced: true, // Gating is enforced but account is within limit
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(AccountPage));

      // Credit Status section renders
      expect(html).toContain("Credit Status");
      expect(html).toContain("Hold Status");

      // Full credit edit form renders (not gated)
      expect(html).toContain("Save Credit Settings");

      // No over-limit banner
      expect(html).not.toContain("This account is over your plan limit");
      expect(html).not.toContain("Upgrade to edit credit settings");
    });
  });
});
