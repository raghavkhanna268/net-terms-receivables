/**
 * Timezone rendering tests for AccountPage due dates.
 *
 * Verifies that invoice due dates and opt-out dates render using
 * the shop's timezone, not a hard-coded fallback.
 *
 * Key scenario: A dueAt at end-of-day in EST (23:59:59.999 on Nov 26)
 * is stored as UTC (04:59:59.999Z on Nov 27). The rendered date must
 * match the shop's local day (Nov 26 for America/New_York).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement, type ReactNode } from "react";

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

vi.mock("~/services/gating.server", () => ({
  isAccountActive: vi.fn(() => true),
  isGatingEnforced: vi.fn(() => false),
}));

import { useLoaderData } from "react-router";
import AccountPage from "../app.accounts.$id";
import { validateTimezone, DEFAULT_TIMEZONE } from "~/lib/aging-dates.server";

const mockUseLoaderData = vi.mocked(useLoaderData);

function buildLoaderData(overrides: {
  shopTimezone?: string;
  invoiceRows?: Array<{
    id: string;
    name: string;
    orderId: string | null;
    dueAt: string | null;
    outstandingPaise: string;
    currency: string;
    daysPastDue: number;
  }>;
  reminderOptOut?: {
    optedOut: boolean;
    optOutAt: string | null;
    optOutSource: "merchant" | "link" | null;
  } | null;
} = {}) {
  const {
    shopTimezone = "Asia/Kolkata",
    invoiceRows = [],
    reminderOptOut = null,
  } = overrides;

  return {
    account: {
      id: "test-acct-123",
      name: "Test Buyer Corp",
      kind: "COMPANY" as const,
      companyId: null,
      defaultTermsDays: 30,
      defaultTermsSource: "explicit" as const,
      isGated: false,
    },
    upgradeUrl: null,
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
    invoices: { rows: invoiceRows, totalCount: invoiceRows.length },
    gatingEnforced: false,
    reminderOptOut,
    shopTimezone,
    newAccountsPausedBanner: {
      show: false,
      heading: "",
      bodyText: "",
      upgradeUrl: null,
    },
    error: null,
  };
}

describe("AccountPage due date timezone rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("invoice due dates render in shop timezone", () => {
    it("America/New_York: end-of-day 26 Nov EST → renders 26/11", () => {
      const loaderData = buildLoaderData({
        shopTimezone: "America/New_York",
        invoiceRows: [
          {
            id: "test-inv-1",
            name: "INV-001",
            orderId: null,
            dueAt: "2026-11-27T04:59:59.999Z",
            outstandingPaise: "100000",
            currency: "INR",
            daysPastDue: 0,
          },
        ],
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(AccountPage));

      expect(html).toContain("26/11/2026");
      expect(html).not.toContain("27/11/2026");
    });

    it("Asia/Kolkata: same instant → renders 27/11", () => {
      const loaderData = buildLoaderData({
        shopTimezone: "Asia/Kolkata",
        invoiceRows: [
          {
            id: "test-inv-1",
            name: "INV-001",
            orderId: null,
            dueAt: "2026-11-27T04:59:59.999Z",
            outstandingPaise: "100000",
            currency: "INR",
            daysPastDue: 0,
          },
        ],
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(AccountPage));

      expect(html).toContain("27/11/2026");
      expect(html).not.toContain("26/11/2026");
    });

    it("Europe/London: same instant → renders 27/11 (GMT)", () => {
      const loaderData = buildLoaderData({
        shopTimezone: "Europe/London",
        invoiceRows: [
          {
            id: "test-inv-1",
            name: "INV-001",
            orderId: null,
            dueAt: "2026-11-27T04:59:59.999Z",
            outstandingPaise: "100000",
            currency: "INR",
            daysPastDue: 0,
          },
        ],
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(AccountPage));

      expect(html).toContain("27/11/2026");
    });

    it("DST: July instant near New York midnight (EDT -04:00) → 14/7 for NY, 15/7 for IST", () => {
      const loaderDataNY = buildLoaderData({
        shopTimezone: "America/New_York",
        invoiceRows: [
          {
            id: "test-inv-dst",
            name: "INV-DST",
            orderId: null,
            dueAt: "2026-07-15T03:59:59.999Z",
            outstandingPaise: "100000",
            currency: "INR",
            daysPastDue: 0,
          },
        ],
      });
      mockUseLoaderData.mockReturnValue(loaderDataNY);

      const htmlNY = renderToString(createElement(AccountPage));
      expect(htmlNY).toContain("14/7/2026");

      const loaderDataIST = buildLoaderData({
        shopTimezone: "Asia/Kolkata",
        invoiceRows: [
          {
            id: "test-inv-dst",
            name: "INV-DST",
            orderId: null,
            dueAt: "2026-07-15T03:59:59.999Z",
            outstandingPaise: "100000",
            currency: "INR",
            daysPastDue: 0,
          },
        ],
      });
      mockUseLoaderData.mockReturnValue(loaderDataIST);

      const htmlIST = renderToString(createElement(AccountPage));
      expect(htmlIST).toContain("15/7/2026");
    });
  });

  describe("validateTimezone fallback", () => {
    it("invalid timezone falls back to Asia/Kolkata", () => {
      expect(validateTimezone("Invalid/Timezone")).toBe(DEFAULT_TIMEZONE);
      expect(validateTimezone(null)).toBe(DEFAULT_TIMEZONE);
      expect(validateTimezone(undefined)).toBe(DEFAULT_TIMEZONE);
      expect(validateTimezone("")).toBe(DEFAULT_TIMEZONE);
    });

    it("valid timezones pass through", () => {
      expect(validateTimezone("America/New_York")).toBe("America/New_York");
      expect(validateTimezone("Asia/Kolkata")).toBe("Asia/Kolkata");
      expect(validateTimezone("Europe/London")).toBe("Europe/London");
      expect(validateTimezone("Pacific/Auckland")).toBe("Pacific/Auckland");
    });
  });

  describe("reminder opt-out date renders in shop timezone", () => {
    it("opt-out date respects shop timezone", () => {
      const loaderData = buildLoaderData({
        shopTimezone: "America/New_York",
        reminderOptOut: {
          optedOut: true,
          optOutAt: "2026-11-27T04:59:59.999Z",
          optOutSource: "merchant",
        },
      });
      mockUseLoaderData.mockReturnValue(loaderData);

      const html = renderToString(createElement(AccountPage));

      expect(html).toContain("Opted out on");
      expect(html).toContain("26/11/2026");
    });
  });
});
