/**
 * Integration tests for double-encoding fix.
 *
 * Root cause: React Router's useFormAction resolves '.' from match.pathname.
 * RR's decodePath leaves inner '%2F' as text, then useRoutesImpl does
 * pathname.replace(/%/g,'%25') plus encodeLocation, which gives %252F.
 *
 * Fix: explicit action={accountHref(account.id)} on all Forms.
 *
 * These tests verify:
 * 1. Form has explicit action attribute (single-encoded, no %25)
 * 2. Action attribute equals accountHref(id)
 * 3. All Forms have explicit action (comprehensive check)
 *
 * Tests cover ALL THREE id kinds via table-driven it.each:
 * - Seeded-style synthetic id with GID segment containing ':' and '/'
 * - Native B2B UUID id
 * - Tag-rule-created UUID id
 *
 * FAIL ON MAIN EVIDENCE:
 * Without the fix, Forms have no explicit action attribute, so React Router
 * resolves action from the current pathname, which re-encodes %2F to %252F.
 * On main, Forms render as <form method="post"> without action=... attribute.
 * These tests fail because:
 * - action attribute is missing (Form has no explicit action on main)
 * - html.match(/action="..."/g) returns fewer matches than form count
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement, type ReactNode } from "react";
import { accountHref } from "~/lib/account-href";

const SEEDED_STYLE_ID = "seed-account-test-shop-gid://shopify/CompanyLocation/1001";
const SYNTHETIC_B2B_UUID = "b2b-loc-a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const SYNTHETIC_TAGGED_UUID = "tag-cust-a1b2c3d4-e5f6-7890-abcd-ef1234567890";

const ALL_ID_KINDS = [
  { kind: "seeded-style GID", id: SEEDED_STYLE_ID },
  { kind: "native B2B UUID", id: SYNTHETIC_B2B_UUID },
  { kind: "tag-rule UUID", id: SYNTHETIC_TAGGED_UUID },
] as const;

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

  describe("all id kinds: form has explicit action, no double-encoding", () => {
    it.each(ALL_ID_KINDS)(
      "$kind: form has explicit action attribute equal to accountHref(id)",
      ({ id }) => {
        const expectedAction = accountHref(id);
        mockUseLoaderData.mockReturnValue(buildLoaderData(id));

        const html = renderToString(createElement(AccountPage));

        expect(html).toContain(`action="${expectedAction}"`);
      }
    );

    it.each(ALL_ID_KINDS)(
      "$kind: form action contains no %25 (single-encoded, not double)",
      ({ id }) => {
        mockUseLoaderData.mockReturnValue(buildLoaderData(id));

        const html = renderToString(createElement(AccountPage));

        const actionMatches = html.match(/action="[^"]+"/g);
        expect(actionMatches).not.toBeNull();

        for (const match of actionMatches!) {
          expect(match).not.toContain("%25");
          expect(match).not.toContain("%252F");
        }
      }
    );

    it.each(ALL_ID_KINDS)(
      "$kind: action decodes to original id",
      ({ id }) => {
        const expectedAction = accountHref(id);
        mockUseLoaderData.mockReturnValue(buildLoaderData(id));

        const html = renderToString(createElement(AccountPage));

        expect(html).toContain(`action="${expectedAction}"`);

        const idSegment = expectedAction.split("/").pop()!;
        const decodedId = decodeURIComponent(idSegment);
        expect(decodedId).toBe(id);
      }
    );

    it.each(ALL_ID_KINDS)(
      "$kind: all Forms have explicit action (comprehensive check)",
      ({ id }) => {
        mockUseLoaderData.mockReturnValue(buildLoaderData(id));

        const html = renderToString(createElement(AccountPage));

        const formCount = (html.match(/<form/g) || []).length;
        const actionCount = (html.match(/action="\/app\/accounts\//g) || []).length;

        expect(formCount).toBeGreaterThan(0);
        expect(actionCount).toBeGreaterThan(0);
        expect(actionCount).toBe(formCount);
      }
    );
  });

  describe("accountHref encoding", () => {
    it("seeded id encodes slashes and colons", () => {
      const href = accountHref(SEEDED_STYLE_ID);

      expect(href).toContain("%2F");
      expect(href).toContain("%3A");
      expect(href).not.toContain("%25");
    });

    it("UUID ids need no encoding", () => {
      expect(accountHref(SYNTHETIC_B2B_UUID)).toBe(`/app/accounts/${SYNTHETIC_B2B_UUID}`);
      expect(accountHref(SYNTHETIC_TAGGED_UUID)).toBe(`/app/accounts/${SYNTHETIC_TAGGED_UUID}`);
    });
  });
});
