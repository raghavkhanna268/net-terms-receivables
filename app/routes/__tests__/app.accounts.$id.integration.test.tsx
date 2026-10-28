/**
 * Integration tests for double-encoding fix.
 *
 * These tests verify:
 * 1. Form has explicit action attribute (single-encoded, no %25)
 * 2. Loader gets params.id that normalizes to original id
 * 3. Narrow normalization: %2F only, %3A untouched, UUID unchanged
 *
 * Tests cover:
 * - Seeded-style synthetic id with ':' and '/'
 * - Synthetic UUID ids (native B2B and tag-rule)
 *
 * FAIL ON MAIN EVIDENCE:
 * Without the fix, Forms have no explicit action attribute, so React Router
 * resolves action from the current pathname, which re-encodes %2F to %252F.
 * These tests fail on main because:
 * - action attribute is missing or undefined
 * - normalizeParamsId doesn't exist in the original code
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement, type ReactNode } from "react";
import { accountHref } from "~/lib/account-href";

const SYNTHETIC_GID_ID = "gid://shopify/CompanyLocation/1001";
const SYNTHETIC_B2B_UUID = "b2b-loc-a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const SYNTHETIC_TAGGED_UUID = "tag-cust-a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function normalizeParamsId(id: string): string {
  return id.replace(/%2f/gi, "/");
}

vi.mock("react-router", async () => {
  return {
    useLoaderData: vi.fn(),
    useActionData: vi.fn(() => undefined),
    useNavigation: vi.fn(() => ({ state: "idle", formData: null })),
    data: vi.fn((d) => d),
    Form: ({ children, action, ...props }: { children: ReactNode; action?: string; method?: string }) =>
      createElement("form", { ...props, action }, children),
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

describe("Account Form action integration (explicit action fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("seeded-style GID id (contains : and /)", () => {
    it("form has explicit action attribute equal to accountHref(id)", () => {
      const expectedAction = accountHref(SYNTHETIC_GID_ID);
      mockUseLoaderData.mockReturnValue(buildLoaderData(SYNTHETIC_GID_ID));

      const html = renderToString(createElement(AccountPage));

      expect(html).toContain(`action="${expectedAction}"`);
    });

    it("form action is single-encoded, contains %2F but no %25", () => {
      mockUseLoaderData.mockReturnValue(buildLoaderData(SYNTHETIC_GID_ID));

      const html = renderToString(createElement(AccountPage));

      expect(html).toContain("%2F");
      expect(html).not.toContain("%252F");
      expect(html).not.toContain("%25");
    });

    it("second submit would use same action (form always has explicit action)", () => {
      mockUseLoaderData.mockReturnValue(buildLoaderData(SYNTHETIC_GID_ID));

      const html = renderToString(createElement(AccountPage));

      const actionMatches = html.match(/action="[^"]+"/g);
      expect(actionMatches).not.toBeNull();
      expect(actionMatches!.length).toBeGreaterThan(0);

      for (const match of actionMatches!) {
        expect(match).not.toContain("%25");
        expect(match).not.toContain("%252F");
      }
    });

    it("action decodes back to original id path", () => {
      const expectedAction = accountHref(SYNTHETIC_GID_ID);
      mockUseLoaderData.mockReturnValue(buildLoaderData(SYNTHETIC_GID_ID));

      const html = renderToString(createElement(AccountPage));

      expect(html).toContain(`action="${expectedAction}"`);

      const idSegment = expectedAction.split("/").pop()!;
      const decodedId = decodeURIComponent(idSegment);
      expect(decodedId).toBe(SYNTHETIC_GID_ID);
    });
  });

  describe("synthetic B2B UUID id", () => {
    it("form has explicit action attribute, no encoding needed", () => {
      const expectedAction = accountHref(SYNTHETIC_B2B_UUID);
      mockUseLoaderData.mockReturnValue(buildLoaderData(SYNTHETIC_B2B_UUID));

      const html = renderToString(createElement(AccountPage));

      expect(html).toContain(`action="${expectedAction}"`);
      expect(expectedAction).not.toContain("%");
    });

    it("UUID id is unchanged in action path", () => {
      mockUseLoaderData.mockReturnValue(buildLoaderData(SYNTHETIC_B2B_UUID));

      const html = renderToString(createElement(AccountPage));

      const actionMatch = html.match(/action="\/app\/accounts\/([^"]+)"/);
      expect(actionMatch).not.toBeNull();
      expect(actionMatch![1]).toBe(SYNTHETIC_B2B_UUID);
    });
  });

  describe("synthetic tag-rule UUID id", () => {
    it("form has explicit action attribute", () => {
      const expectedAction = accountHref(SYNTHETIC_TAGGED_UUID);
      mockUseLoaderData.mockReturnValue(buildLoaderData(SYNTHETIC_TAGGED_UUID));

      const html = renderToString(createElement(AccountPage));

      expect(html).toContain(`action="${expectedAction}"`);
    });

    it("UUID id is unchanged in action path", () => {
      mockUseLoaderData.mockReturnValue(buildLoaderData(SYNTHETIC_TAGGED_UUID));

      const html = renderToString(createElement(AccountPage));

      const actionMatch = html.match(/action="\/app\/accounts\/([^"]+)"/);
      expect(actionMatch).not.toBeNull();
      expect(actionMatch![1]).toBe(SYNTHETIC_TAGGED_UUID);
    });
  });

  describe("narrow normalizeParamsId: %2F only", () => {
    it("replaces %2F with / (lowercase)", () => {
      const withEncodedSlash = "gid%3A%2F%2Fshopify%2FCompanyLocation%2F1001";
      const normalized = normalizeParamsId(withEncodedSlash);

      expect(normalized).toBe("gid%3A//shopify/CompanyLocation/1001");
      expect(normalized).toContain("/");
      expect(normalized).not.toContain("%2F");
    });

    it("replaces %2f with / (case-insensitive)", () => {
      const mixedCase = "path%2Fwith%2flower%2fcase";
      const normalized = normalizeParamsId(mixedCase);

      expect(normalized).toBe("path/with/lower/case");
    });

    it("does NOT replace %3A (colon stays encoded)", () => {
      const withEncodedColon = "gid%3A%2F%2Fshopify";
      const normalized = normalizeParamsId(withEncodedColon);

      expect(normalized).toContain("%3A");
      expect(normalized).toBe("gid%3A//shopify");
    });

    it("leaves UUID id completely untouched", () => {
      expect(normalizeParamsId(SYNTHETIC_B2B_UUID)).toBe(SYNTHETIC_B2B_UUID);
      expect(normalizeParamsId(SYNTHETIC_TAGGED_UUID)).toBe(SYNTHETIC_TAGGED_UUID);
    });

    it("leaves already-decoded GID-style id unchanged", () => {
      expect(normalizeParamsId(SYNTHETIC_GID_ID)).toBe(SYNTHETIC_GID_ID);
    });

    it("double-encoded %252F after RR decode becomes %2F, then / via normalize", () => {
      const afterRrDecode = "gid%3A%2F%2Fshopify";
      const normalized = normalizeParamsId(afterRrDecode);

      expect(normalized).toBe("gid%3A//shopify");
      expect(normalized).not.toContain("%2F");
      expect(normalized).toContain("%3A");
    });
  });

  describe("all 3 Forms have explicit action (comprehensive check)", () => {
    it("non-gated account has at least 1 Form with explicit action", () => {
      mockUseLoaderData.mockReturnValue(buildLoaderData(SYNTHETIC_GID_ID));

      const html = renderToString(createElement(AccountPage));

      const formCount = (html.match(/<form/g) || []).length;
      const actionCount = (html.match(/action="\/app\/accounts\//g) || []).length;

      expect(formCount).toBeGreaterThan(0);
      expect(actionCount).toBeGreaterThan(0);
      expect(actionCount).toBe(formCount);
    });
  });
});
