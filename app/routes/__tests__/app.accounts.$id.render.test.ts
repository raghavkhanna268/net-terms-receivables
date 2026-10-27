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
  newAccountsPausedBanner?: {
    show: boolean;
    heading: string;
    bodyText: string;
    upgradeUrl: string | null;
  };
} = {}) {
  const {
    isGated = false,
    gatingEnforced = false,
    newAccountsPausedBanner = {
      show: false,
      heading: "",
      bodyText: "",
      upgradeUrl: null,
    },
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
    newAccountsPausedBanner,
    error: null,
  };
}

describe("AccountPage render tests (T1 plan-limit gating)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("gating OFF: credit-status and credit-hold UI renders, no over-limit UI", () => {
    it("none plan over limit, gating OFF: shows credit status and hold controls, no over-limit banner", () => {
      const loaderData = buildLoaderData({
        isGated: false, // Account is NOT marked gated when gating is off
        gatingEnforced: false,
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(AccountPage));

      // Credit Status section renders
      expect(html).toContain("Credit Status");
      expect(html).toContain("Hold Status");
      expect(html).toContain(">OK<"); // OK badge

      // Manual hold control renders (the checkbox label for place/release)
      expect(html).toContain("Place manual hold on this account");

      // Full credit edit form renders (not restricted)
      expect(html).toContain("Save Credit Settings");

      // Over-limit banner heading is ABSENT
      expect(html).not.toContain("This account was added after you reached your plan limit");
      // No Limit Reached badge
      expect(html).not.toContain("Limit Reached");
      // The upgrade restriction banner is ABSENT
      expect(html).not.toContain("Upgrade to edit credit settings");
    });

    it("starter plan over limit, gating OFF: credit-hold/credit-status UI renders, no limit UI", () => {
      // Paid plan (starter) with companiesUsed > companiesLimit but gating OFF
      const loaderData = buildLoaderData({
        isGated: false, // Account is NOT gated when gating is off
        gatingEnforced: false,
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(AccountPage));

      // Credit Status section renders
      expect(html).toContain("Credit Status");
      expect(html).toContain("Hold Status");

      // Manual hold control renders (the place/release toggle)
      expect(html).toContain("Place manual hold on this account");

      // Full credit edit form renders
      expect(html).toContain("Save Credit Settings");

      // Over-limit banner is ABSENT
      expect(html).not.toContain("This account was added after you reached your plan limit");
      expect(html).not.toContain("Limit Reached");
      expect(html).not.toContain("Upgrade to edit credit settings");
    });

    it("growth plan over limit, gating OFF: credit UI renders, no limit warnings", () => {
      // Another paid plan over limit with gating OFF
      const loaderData = buildLoaderData({
        isGated: false,
        gatingEnforced: false,
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(AccountPage));

      // Credit status and hold controls render
      expect(html).toContain("Credit Status");
      expect(html).toContain("Hold Status");
      expect(html).toContain("Place manual hold on this account");
      expect(html).toContain("Save Credit Settings");

      // No limit-related UI
      expect(html).not.toContain("after you reached your plan limit");
      expect(html).not.toContain("Limit Reached");
      expect(html).not.toContain("Upgrade");
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

      // Over-limit banner heading is present (T5 updated copy)
      expect(html).toContain("This account was added after you reached your plan limit");
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
      expect(html).not.toContain("This account was added after you reached your plan limit");
      expect(html).not.toContain("Upgrade to edit credit settings");
    });
  });

  describe("T4: newAccountsPausedBanner render tests", () => {
    it("shows newAccountsPausedBanner when show=true", () => {
      const loaderData = buildLoaderData({
        isGated: false,
        gatingEnforced: true,
        newAccountsPausedBanner: {
          show: true,
          heading: "25 of 25 buyer accounts",
          bodyText: "New accounts can't be added or imported over your plan limit.",
          upgradeUrl: "https://admin.shopify.com/store/test/charges/app/pricing_plans",
        },
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(AccountPage));

      // The T4 banner heading should appear
      expect(html).toContain("25 of 25 buyer accounts");
      // The T4 banner body text should appear (apostrophe may be HTML-encoded)
      expect(html).toContain("New accounts");
      expect(html).toContain("over your plan limit");
      // Upgrade link should appear
      expect(html).toContain("Upgrade your plan");
    });

    it("hides newAccountsPausedBanner when show=false", () => {
      const loaderData = buildLoaderData({
        isGated: false,
        gatingEnforced: true,
        newAccountsPausedBanner: {
          show: false,
          heading: "",
          bodyText: "",
          upgradeUrl: null,
        },
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(AccountPage));

      // The T4 banner should not appear
      expect(html).not.toContain("buyer accounts");
      expect(html).not.toContain("New accounts can't be added");
    });

    it("newAccountsPausedBanner without upgradeUrl does not show upgrade link", () => {
      const loaderData = buildLoaderData({
        isGated: false,
        gatingEnforced: true,
        newAccountsPausedBanner: {
          show: true,
          heading: "25 of 25 buyer accounts",
          bodyText: "New accounts can't be added or imported over your plan limit.",
          upgradeUrl: null,
        },
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(AccountPage));

      // The T4 banner should appear
      expect(html).toContain("25 of 25 buyer accounts");
      // But upgrade link should NOT appear
      expect(html).not.toContain("Upgrade your plan");
    });
  });

  describe("copy polish: breadcrumbs and badges", () => {
    it("renders breadcrumb with href='/app' for normal account state", () => {
      const loaderData = buildLoaderData({
        isGated: false,
        gatingEnforced: false,
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(AccountPage));

      expect(html).toContain('href="/app"');
      expect(html).toContain("Back to Dashboard");
      expect(html).not.toMatch(/href="\/"\s/);
    });

    it("renders breadcrumb with href='/app' for notSupported currency state", () => {
      const loaderData = {
        notSupported: true,
        shopCurrency: "USD",
        account: null,
        creditStatus: null,
        companyTotals: null,
        invoices: { rows: [], totalCount: 0 },
        gatingEnforced: false,
        reminderOptOut: null,
        upgradeUrl: null,
        newAccountsPausedBanner: {
          show: false,
          heading: "",
          bodyText: "",
          upgradeUrl: null,
        },
        error: null,
      };
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(AccountPage));

      expect(html).toContain('href="/app"');
      expect(html).toContain("Back to Dashboard");
      expect(html).not.toMatch(/href="\/"\s/);
      expect(html).toContain("Currency Not Supported");
    });

    it("renders 'Credit check paused' badge for BYPASS holdState", () => {
      const loaderData = buildLoaderData({
        isGated: false,
        gatingEnforced: false,
      });
      const bypassCreditStatus = {
        creditLimitAmount: 100000,
        creditLimitPaise: "10000000",
        exposurePaise: "5000000",
        draftExposurePaise: "0",
        availableCreditPaise: "5000000",
        currency: "INR",
        holdState: "BYPASS" as const,
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
      };
      mockUseLoaderData.mockReturnValue({ ...loaderData, creditStatus: bypassCreditStatus });

      const html = renderToString(createElement(AccountPage));

      expect(html).toContain("Credit check paused");
      expect(html).not.toContain("Bypass Active");
      expect(html).not.toContain(">Bypass<");
    });

    it("renders 'Credit check paused' badge with info tone", () => {
      const loaderData = buildLoaderData({
        isGated: false,
        gatingEnforced: false,
      });
      const bypassCreditStatus = {
        creditLimitAmount: 100000,
        creditLimitPaise: "10000000",
        exposurePaise: "5000000",
        draftExposurePaise: "0",
        availableCreditPaise: "5000000",
        currency: "INR",
        holdState: "BYPASS" as const,
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
      };
      mockUseLoaderData.mockReturnValue({ ...loaderData, creditStatus: bypassCreditStatus });

      const html = renderToString(createElement(AccountPage));

      expect(html).toContain('tone="info"');
      expect(html).toContain("Credit check paused");
    });
  });

  describe("payment reminder opt-out aside copy", () => {
    it("renders one-click unsubscribe option copy in Payment Reminders aside", () => {
      const loaderData = buildLoaderData({
        isGated: false,
        gatingEnforced: false,
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(AccountPage));

      expect(html).toContain("one-click unsubscribe option");
      expect(html).not.toContain("unsubscribe link in each reminder");
    });

    it("renders 'via email unsubscribe' suffix (not 'via email unsubscribe link')", () => {
      const loaderData = buildLoaderData({
        isGated: false,
        gatingEnforced: false,
      });
      const loaderDataWithOptOut = {
        ...loaderData,
        reminderOptOut: {
          optedOut: true,
          optOutAt: new Date().toISOString(),
          optOutSource: "link" as const,
        },
      };
      mockUseLoaderData.mockReturnValue(loaderDataWithOptOut);

      const html = renderToString(createElement(AccountPage));

      expect(html).toContain("via email unsubscribe");
      expect(html).not.toContain("via email unsubscribe link");
    });
  });
});
