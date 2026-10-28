/**
 * Tests that Form action attributes are explicitly set to prevent double-encoding.
 *
 * Root cause: React Router's useFormAction resolves '.' from match.pathname.
 * RR's decodePath leaves inner '%2F' as text, then useRoutesImpl does
 * pathname.replace(/%/g,'%25') plus encodeLocation, which gives %252F.
 *
 * Fix: explicit action={accountHref(account.id)} on all Forms.
 *
 * This test verifies:
 * 1. Rendered form has explicit action attribute
 * 2. Action equals accountHref(id) with no %25 (no double-encoding)
 * 3. Works for seeded GID-style ids and real UUID ids
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement, type ReactNode } from "react";
import { accountHref } from "~/lib/account-href";

const SYNTHETIC_GID_ID = "gid://shopify/CompanyLocation/1001";
const SYNTHETIC_B2B_UUID = "b2b-loc-a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const SYNTHETIC_TAGGED_UUID = "tag-cust-a1b2c3d4-e5f6-7890-abcd-ef1234567890";

vi.mock("react-router", async () => {
  return {
    useLoaderData: vi.fn(),
    useActionData: vi.fn(() => undefined),
    useNavigation: vi.fn(() => ({ state: "idle", formData: null })),
    data: vi.fn((d) => d),
    Form: ({ children, action, ...props }: { children: ReactNode; action?: string; method?: string }) =>
      createElement("form", { ...props, action, "data-testid": "credit-form" }, children),
  };
});

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: vi.fn(() => ({})) },
  ApiVersion: { October26: "2026-10" },
}));

vi.mock("@sentry/cloudflare", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  setUser: vi.fn(),
  setContext: vi.fn(),
}));

vi.mock("~/services/gating.server", () => ({
  isAccountActive: vi.fn(() => true),
  isGatingEnforced: vi.fn(() => false),
}));

import { useLoaderData } from "react-router";
import AccountPage from "../app.accounts.$id";

const mockUseLoaderData = vi.mocked(useLoaderData);

function buildLoaderData(accountId: string) {
  return {
    account: {
      id: accountId,
      name: "Test Buyer Corp",
      kind: "COMPANY" as const,
      companyId: "gid://shopify/Company/123",
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
    invoices: { rows: [], totalCount: 0 },
    gatingEnforced: false,
    reminderOptOut: null,
    shopTimezone: "Asia/Kolkata",
    newAccountsPausedBanner: {
      show: false,
      heading: "",
      bodyText: "",
      upgradeUrl: null,
    },
    error: null,
  };
}

describe("AccountPage Form action attribute (double-encoding fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("seeded GID-style id (contains : and /)", () => {
    it("form has explicit action attribute equal to accountHref(id)", () => {
      const expectedAction = accountHref(SYNTHETIC_GID_ID);
      mockUseLoaderData.mockReturnValue(buildLoaderData(SYNTHETIC_GID_ID));

      const html = renderToString(createElement(AccountPage));

      expect(html).toContain(`action="${expectedAction}"`);
    });

    it("form action contains %2F but no %25 (single-encoded, not double)", () => {
      mockUseLoaderData.mockReturnValue(buildLoaderData(SYNTHETIC_GID_ID));

      const html = renderToString(createElement(AccountPage));

      expect(html).toContain("%2F");
      expect(html).not.toContain("%252F");
      expect(html).not.toContain("%25");
    });

    it("form action decodes back to original id path", () => {
      const expectedAction = accountHref(SYNTHETIC_GID_ID);
      mockUseLoaderData.mockReturnValue(buildLoaderData(SYNTHETIC_GID_ID));

      const html = renderToString(createElement(AccountPage));

      const actionMatch = html.match(/action="([^"]+)"/);
      expect(actionMatch).not.toBeNull();
      
      const actionPath = actionMatch![1];
      expect(actionPath).toBe(expectedAction);
      
      const idSegment = actionPath.split("/").pop()!;
      const decodedId = decodeURIComponent(idSegment);
      expect(decodedId).toBe(SYNTHETIC_GID_ID);
    });
  });

  describe("real B2B CompanyLocation account (UUID)", () => {
    it("form has explicit action attribute equal to accountHref(id)", () => {
      const expectedAction = accountHref(SYNTHETIC_B2B_UUID);
      mockUseLoaderData.mockReturnValue(buildLoaderData(SYNTHETIC_B2B_UUID));

      const html = renderToString(createElement(AccountPage));

      expect(html).toContain(`action="${expectedAction}"`);
    });

    it("UUID id needs no encoding, action has no percent signs", () => {
      mockUseLoaderData.mockReturnValue(buildLoaderData(SYNTHETIC_B2B_UUID));

      const html = renderToString(createElement(AccountPage));
      const actionMatch = html.match(/action="([^"]+)"/);
      
      expect(actionMatch).not.toBeNull();
      expect(actionMatch![1]).not.toContain("%");
    });
  });

  describe("real tag-rule account (UUID)", () => {
    it("form has explicit action attribute equal to accountHref(id)", () => {
      const expectedAction = accountHref(SYNTHETIC_TAGGED_UUID);
      mockUseLoaderData.mockReturnValue(buildLoaderData(SYNTHETIC_TAGGED_UUID));

      const html = renderToString(createElement(AccountPage));

      expect(html).toContain(`action="${expectedAction}"`);
    });

    it("UUID id needs no encoding, action has no percent signs", () => {
      mockUseLoaderData.mockReturnValue(buildLoaderData(SYNTHETIC_TAGGED_UUID));

      const html = renderToString(createElement(AccountPage));
      const actionMatch = html.match(/action="([^"]+)"/);
      
      expect(actionMatch).not.toBeNull();
      expect(actionMatch![1]).not.toContain("%");
    });
  });

  describe("seeded id with embedded GID", () => {
    const SEEDED_EMBEDDED_ID = `seed-account-shop123-${SYNTHETIC_GID_ID}`;

    it("form has explicit action with embedded GID properly encoded", () => {
      const expectedAction = accountHref(SEEDED_EMBEDDED_ID);
      mockUseLoaderData.mockReturnValue(buildLoaderData(SEEDED_EMBEDDED_ID));

      const html = renderToString(createElement(AccountPage));

      expect(html).toContain(`action="${expectedAction}"`);
      expect(html).toContain("%2F");
      expect(html).not.toContain("%252F");
    });
  });

  describe("verification: test would fail without explicit action", () => {
    it("without fix, Form would have no action attr (RR default resolution)", () => {
      mockUseLoaderData.mockReturnValue(buildLoaderData(SYNTHETIC_GID_ID));
      const html = renderToString(createElement(AccountPage));

      const actionMatch = html.match(/action="([^"]+)"/);
      expect(actionMatch).not.toBeNull();
      expect(actionMatch![1]).toBe(accountHref(SYNTHETIC_GID_ID));
    });
  });
});
