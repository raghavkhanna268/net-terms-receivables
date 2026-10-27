/**
 * Empty State Actions & Breadcrumb Tests
 *
 * Tests for UI polish changes:
 * - Reconcile: empty state contains Run Matcher action
 * - Reminders: empty state contains Enable Reminders when reminders are off
 * - Breadcrumb: all touched app pages have consistent "Back to Dashboard" breadcrumb
 * - Setup Guide: table container uses overflow-x: auto layout
 *
 * Uses render testing pattern matching admin-render-smoke.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement, type ReactNode } from "react";

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: vi.fn(() => ({})), error: vi.fn(() => null) },
  ApiVersion: { October26: "2026-10" },
}));

vi.mock("@sentry/cloudflare", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  setUser: vi.fn(),
  setContext: vi.fn(),
}));

vi.mock("~/services/access-log.server", () => ({
  recordAccess: vi.fn(),
  getActorFromSessionToken: vi.fn().mockReturnValue("test-actor"),
}));

const mockUseLoaderData = vi.fn();
const mockUseActionData = vi.fn(() => undefined);
const mockUseNavigation = vi.fn(() => ({ state: "idle", formData: null }));
const mockUseRevalidator = vi.fn(() => ({ state: "idle", revalidate: vi.fn() }));
const mockUseFetcher = vi.fn(() => ({ state: "idle", data: null, submit: vi.fn() }));

vi.mock("react-router", () => ({
  useLoaderData: mockUseLoaderData,
  useActionData: mockUseActionData,
  useNavigation: mockUseNavigation,
  useRevalidator: mockUseRevalidator,
  useRouteError: vi.fn(() => null),
  useFetcher: mockUseFetcher,
  isRouteErrorResponse: vi.fn(() => false),
  data: vi.fn((d) => d),
  Await: ({
    resolve,
    children,
  }: {
    resolve: unknown;
    children: (data: unknown) => ReactNode;
  }) => {
    if (resolve instanceof Promise) {
      throw new Error("Await received an unresolved Promise.");
    }
    return children(resolve);
  },
  Outlet: () => null,
  Form: ({ children, ...props }: { children: ReactNode; method?: string }) =>
    createElement("form", props, children),
}));

function hasVisibleHeading(html: string): boolean {
  return /<s-page[^>]*\bheading=/.test(html) || /<h1[^>]*>/.test(html);
}

const TAG_RULES_BREADCRUMB_HREF = "/";
const TAG_RULES_BREADCRUMB_LABEL = "Back to Dashboard";

beforeEach(() => {
  vi.clearAllMocks();
  mockUseLoaderData.mockReturnValue({});
  mockUseActionData.mockReturnValue(undefined);
  mockUseNavigation.mockReturnValue({ state: "idle", formData: null });
  mockUseRevalidator.mockReturnValue({ state: "idle", revalidate: vi.fn() });
  mockUseFetcher.mockReturnValue({ state: "idle", data: null, submit: vi.fn() });
});

describe("Reconcile Page Empty State", () => {
  it("empty state contains Run Matcher action button", async () => {
    const mod = await import("../app.reconcile");
    
    mockUseLoaderData.mockReturnValue({
      shopCurrency: "INR",
      payments: [],
      matches: [],
      selectedPayment: null,
      pagination: { page: 1, pageSize: 20, totalCount: 0 },
      view: "suggested",
      error: null,
      tabCounts: { suggested: 0, unmatched: 0, confirmed: 0, pushing: 0 },
      notSupported: false,
    });

    const html = renderToString(createElement(mod.default));

    expect(hasVisibleHeading(html)).toBe(true);
    expect(html).toContain("No pending matches");
    expect(html).toContain('name="intent"');
    expect(html).toContain('value="run_matcher"');
    expect(html).toContain("Run Matcher");
  });

  it("empty state Run Matcher button is absent when matches exist", async () => {
    const mod = await import("../app.reconcile");
    
    mockUseLoaderData.mockReturnValue({
      shopCurrency: "INR",
      payments: [],
      matches: [{
        id: "match-1",
        paymentId: "pay-1",
        invoiceId: "inv-1",
        invoiceName: "INV-001",
        amountPaise: "10000",
        score: 85,
        reasons: [],
        state: "suggested",
        buyerName: "Test Buyer",
      }],
      selectedPayment: null,
      pagination: { page: 1, pageSize: 20, totalCount: 1 },
      view: "suggested",
      error: null,
      tabCounts: { suggested: 1, unmatched: 0, confirmed: 0, pushing: 0 },
      notSupported: false,
    });

    const html = renderToString(createElement(mod.default));

    expect(hasVisibleHeading(html)).toBe(true);
    expect(html).not.toContain("No pending matches");
    expect(html).toContain("INV-001");
  });
});

describe("Reminders Page Empty State", () => {
  it("empty state contains Enable Reminders button when reminders are off", async () => {
    const mod = await import("../app.settings.reminders");
    
    mockUseLoaderData.mockReturnValue({
      error: null,
      settings: { enabled: false },
      rules: [],
      logs: [],
      providerConfigured: true,
      shopTimezone: "Asia/Kolkata",
      statusCounts: { sent: 0, delayed: 0, skippedDailyLimit: 0, skippedOptedOut: 0 },
      delayedReminders: [],
      shopSentToday: 0,
    });

    const html = renderToString(createElement(mod.default));

    expect(hasVisibleHeading(html)).toBe(true);
    expect(html).toContain("No reminder history");
    expect(html).toContain('name="intent"');
    expect(html).toContain('value="toggle_enabled"');
    expect(html).toContain('value="true"');
    expect(html).toContain("Enable Reminders");
  });

  it("empty state does not contain Enable Reminders button when reminders are on", async () => {
    const mod = await import("../app.settings.reminders");
    
    mockUseLoaderData.mockReturnValue({
      error: null,
      settings: { enabled: true },
      rules: [],
      logs: [],
      providerConfigured: true,
      shopTimezone: "Asia/Kolkata",
      statusCounts: { sent: 0, delayed: 0, skippedDailyLimit: 0, skippedOptedOut: 0 },
      delayedReminders: [],
      shopSentToday: 0,
    });

    const html = renderToString(createElement(mod.default));

    expect(hasVisibleHeading(html)).toBe(true);
    expect(html).toContain("No reminder history");
    const emptyStateMatch = html.match(/<s-empty-state[^>]*heading="No reminder history"[^>]*>[\s\S]*?<\/s-empty-state>/);
    expect(emptyStateMatch).toBeTruthy();
    expect(emptyStateMatch![0]).not.toContain("Enable Reminders");
  });
});

describe("Breadcrumb Consistency", () => {
  it("Tag Rules has breadcrumb with correct label and target", async () => {
    const mod = await import("../app.tag-rules");
    
    mockUseLoaderData.mockReturnValue({
      storeMode: "tag_based",
      tagRules: [],
      shopId: "shop-1",
      error: null,
      finishingSetup: false,
      newAccountsPausedBanner: { show: false, heading: "", bodyText: "", upgradeUrl: null },
    });

    const html = renderToString(createElement(mod.default));

    expect(html).toContain(`href="${TAG_RULES_BREADCRUMB_HREF}"`);
    expect(html).toContain(TAG_RULES_BREADCRUMB_LABEL);
  });

  it("Reconcile has breadcrumb matching Tag Rules", async () => {
    const mod = await import("../app.reconcile");
    
    mockUseLoaderData.mockReturnValue({
      shopCurrency: "INR",
      payments: [],
      matches: [],
      selectedPayment: null,
      pagination: { page: 1, pageSize: 20, totalCount: 0 },
      view: "suggested",
      error: null,
      tabCounts: { suggested: 0, unmatched: 0, confirmed: 0, pushing: 0 },
      notSupported: false,
    });

    const html = renderToString(createElement(mod.default));

    expect(html).toContain(`href="${TAG_RULES_BREADCRUMB_HREF}"`);
    expect(html).toContain(TAG_RULES_BREADCRUMB_LABEL);
  });

  it("Reminders has breadcrumb matching Tag Rules", async () => {
    const mod = await import("../app.settings.reminders");
    
    mockUseLoaderData.mockReturnValue({
      error: null,
      settings: { enabled: false },
      rules: [],
      logs: [],
      providerConfigured: true,
      shopTimezone: "Asia/Kolkata",
      statusCounts: { sent: 0, delayed: 0, skippedDailyLimit: 0, skippedOptedOut: 0 },
      delayedReminders: [],
      shopSentToday: 0,
    });

    const html = renderToString(createElement(mod.default));

    expect(html).toContain(`href="${TAG_RULES_BREADCRUMB_HREF}"`);
    expect(html).toContain(TAG_RULES_BREADCRUMB_LABEL);
  });

  it("Setup Guide has breadcrumb matching Tag Rules", async () => {
    const mod = await import("../app.onboarding");
    
    mockUseLoaderData.mockReturnValue({
      error: null,
      state: {
        steps: [],
        isComplete: false,
        completedCount: 0,
        totalCount: 5,
        dismissedAt: null,
      },
      registrationStatus: null,
      initialSyncState: { status: "not_started" },
      newAccountsPausedBanner: { show: false, heading: "", bodyText: "", upgradeUrl: null },
      currencySupported: true,
      currencyFlipBlocked: false,
    });

    const html = renderToString(createElement(mod.default));

    expect(html).toContain(`href="${TAG_RULES_BREADCRUMB_HREF}"`);
    expect(html).toContain(TAG_RULES_BREADCRUMB_LABEL);
  });

  it("Imports has breadcrumb matching Tag Rules", async () => {
    const mod = await import("../app.imports");
    
    mockUseLoaderData.mockReturnValue({
      shopDomain: "test.myshopify.com",
      shopCurrency: "INR",
      maxImportRows: 1000,
      notSupported: false,
    });

    const html = renderToString(createElement(mod.default));

    expect(html).toContain(`href="${TAG_RULES_BREADCRUMB_HREF}"`);
    expect(html).toContain(TAG_RULES_BREADCRUMB_LABEL);
  });

  it("Data Requests has breadcrumb matching Tag Rules", async () => {
    const mod = await import("../app.data-requests");
    
    mockUseLoaderData.mockReturnValue({
      dataRequests: [],
      expiresInDays: 30,
      error: null,
    });

    const html = renderToString(createElement(mod.default));

    expect(html).toContain(`href="${TAG_RULES_BREADCRUMB_HREF}"`);
    expect(html).toContain(TAG_RULES_BREADCRUMB_LABEL);
  });

  it("Plan has breadcrumb matching Tag Rules", async () => {
    const mod = await import("../app.plan");
    
    mockUseLoaderData.mockReturnValue({
      storeHandle: "test-store",
      shopDomain: "test.myshopify.com",
      plan: { key: "starter", name: "Starter", isTest: false },
      usage: { companies: { current: 5, limit: 10 }, importsThisMonth: { current: 2, limit: 100 } },
      gatedCount: 0,
      gatingEnforced: false,
      upgradeUrl: null,
      newAccountsPausedBanner: { show: false, heading: "", bodyText: "", upgradeUrl: null },
      error: null,
    });

    const html = renderToString(createElement(mod.default));

    expect(html).toContain(`href="${TAG_RULES_BREADCRUMB_HREF}"`);
    expect(html).toContain(TAG_RULES_BREADCRUMB_LABEL);
  });
});

describe("Setup Guide Table Layout", () => {
  it("table container uses overflow-x: auto for non-overflow layout", async () => {
    const mod = await import("../app.onboarding");
    
    mockUseLoaderData.mockReturnValue({
      error: null,
      state: {
        steps: [
          { id: "step-1", title: "Step One", description: "Description", status: "pending" },
        ],
        isComplete: false,
        completedCount: 0,
        totalCount: 1,
        dismissedAt: null,
      },
      registrationStatus: null,
      initialSyncState: { status: "not_started" },
      newAccountsPausedBanner: { show: false, heading: "", bodyText: "", upgradeUrl: null },
      currencySupported: true,
      currencyFlipBlocked: false,
    });

    const html = renderToString(createElement(mod.default));

    expect(html).toContain("overflow-x");
    expect(html).toContain("auto");
    expect(html).toContain("<s-table>");
  });
});

describe("Account Page Payment Reminders Copy", () => {
  it("displays updated unsubscribe copy in Payment Reminders aside", async () => {
    const mod = await import("../app.accounts.$id");
    
    mockUseLoaderData.mockReturnValue({
      account: {
        id: "buyer-1",
        name: "Test Buyer",
        kind: "COMPANY",
        companyId: "company-1",
        defaultTermsDays: 30,
        defaultTermsSource: "explicit",
        isGated: false,
      },
      creditStatus: {
        creditLimitAmount: 100000,
        creditLimitPaise: "10000000",
        exposurePaise: "5000000",
        draftExposurePaise: "0",
        availableCreditPaise: "5000000",
        currency: "INR",
        holdState: "OK",
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
        syncState: "synced",
        hasDeadLetteredSync: false,
        syncErrorInfo: null,
      },
      companyTotals: null,
      invoices: { rows: [], totalCount: 0 },
      gatingEnforced: false,
      reminderOptOut: { optedOut: false, optOutAt: null, optOutSource: null },
      upgradeUrl: null,
      newAccountsPausedBanner: { show: false, heading: "", bodyText: "", upgradeUrl: null },
      error: null,
    });

    const html = renderToString(createElement(mod.default));

    expect(html).toContain("one-click unsubscribe option");
    expect(html).not.toContain("unsubscribe link in each reminder");
  });

  it("displays updated opt-out source suffix for email unsubscribe", async () => {
    const mod = await import("../app.accounts.$id");
    
    mockUseLoaderData.mockReturnValue({
      account: {
        id: "buyer-1",
        name: "Test Buyer",
        kind: "COMPANY",
        companyId: "company-1",
        defaultTermsDays: 30,
        defaultTermsSource: "explicit",
        isGated: false,
      },
      creditStatus: {
        creditLimitAmount: 100000,
        creditLimitPaise: "10000000",
        exposurePaise: "5000000",
        draftExposurePaise: "0",
        availableCreditPaise: "5000000",
        currency: "INR",
        holdState: "OK",
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
        syncState: "synced",
        hasDeadLetteredSync: false,
        syncErrorInfo: null,
      },
      companyTotals: null,
      invoices: { rows: [], totalCount: 0 },
      gatingEnforced: false,
      reminderOptOut: {
        optedOut: true,
        optOutAt: "2024-01-15T10:00:00Z",
        optOutSource: "link",
      },
      upgradeUrl: null,
      newAccountsPausedBanner: { show: false, heading: "", bodyText: "", upgradeUrl: null },
      error: null,
    });

    const html = renderToString(createElement(mod.default));

    expect(html).toContain("via email unsubscribe");
    expect(html).not.toContain("via email unsubscribe link");
  });
});

describe("Plan Page Upgrade Copy", () => {
  it("shows upgrade line when gating is enforced", async () => {
    const mod = await import("../app.plan");
    
    mockUseLoaderData.mockReturnValue({
      storeHandle: "test-store",
      shopDomain: "test.myshopify.com",
      plan: { key: "starter", name: "Starter", isTest: false },
      usage: { companies: { current: 5, limit: 10 }, importsThisMonth: { current: 2, limit: 100 } },
      gatedCount: 0,
      gatingEnforced: true,
      upgradeUrl: "https://example.com/upgrade",
      newAccountsPausedBanner: { show: false, heading: "", bodyText: "", upgradeUrl: null },
      error: null,
    });

    const html = renderToString(createElement(mod.default));

    expect(html).toContain("Upgrade to unlock more features and higher limits");
    expect(html).not.toContain("Every plan includes every feature");
  });

  it("shows every-feature line when gating is NOT enforced", async () => {
    const mod = await import("../app.plan");
    
    mockUseLoaderData.mockReturnValue({
      storeHandle: "test-store",
      shopDomain: "test.myshopify.com",
      plan: { key: "starter", name: "Starter", isTest: false },
      usage: { companies: { current: 5, limit: 10 }, importsThisMonth: { current: 2, limit: 100 } },
      gatedCount: 0,
      gatingEnforced: false,
      upgradeUrl: "https://example.com/upgrade",
      newAccountsPausedBanner: { show: false, heading: "", bodyText: "", upgradeUrl: null },
      error: null,
    });

    const html = renderToString(createElement(mod.default));

    expect(html).toContain("Every plan includes every feature. Compare plans to choose the one that fits your store.");
    expect(html).not.toContain("Upgrade to unlock more features and higher limits");
  });
});
