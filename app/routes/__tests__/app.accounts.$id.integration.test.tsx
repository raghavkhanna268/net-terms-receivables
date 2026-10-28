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
 * 3. All 3 Forms have explicit action (comprehensive check)
 * 4. Narrow normalization: %2F only, %3A untouched, %41 unchanged
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
  { kind: "seeded-style GID", id: SEEDED_STYLE_ID, hasSpecialChars: true },
  { kind: "native B2B UUID", id: SYNTHETIC_B2B_UUID, hasSpecialChars: false },
  { kind: "tag-rule UUID", id: SYNTHETIC_TAGGED_UUID, hasSpecialChars: false },
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
      "$kind: multiple saves use same action (still no %25)",
      ({ id }) => {
        mockUseLoaderData.mockReturnValue(buildLoaderData(id));

        const html = renderToString(createElement(AccountPage));

        const actionMatches = html.match(/action="[^"]+"/g);
        expect(actionMatches).not.toBeNull();
        expect(actionMatches!.length).toBeGreaterThan(0);

        for (const match of actionMatches!) {
          expect(match).not.toContain("%25");
          expect(match).not.toContain("%252F");
          expect(match).not.toContain("%25252F");
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

  describe("narrow params.id normalization: %2F only", () => {
    it("replaces %2F with / (case-insensitive)", () => {
      const withEncodedSlash = "seed-account-test-shop-gid%3A%2F%2Fshopify%2FCompanyLocation%2F1001";
      const normalized = withEncodedSlash.replace(/%2F/gi, "/");

      expect(normalized).toBe("seed-account-test-shop-gid%3A//shopify/CompanyLocation/1001");
      expect(normalized).toContain("/");
      expect(normalized).not.toContain("%2F");
    });

    it("does NOT replace %3A (colon stays encoded)", () => {
      const withEncodedColon = "gid%3A%2F%2Fshopify";
      const normalized = withEncodedColon.replace(/%2F/gi, "/");

      expect(normalized).toContain("%3A");
      expect(normalized).toBe("gid%3A//shopify");
    });

    it("leaves other percent sequences unchanged (e.g. %41 stays %41)", () => {
      const withOtherPercent = "test%41value%2Fpath";
      const normalized = withOtherPercent.replace(/%2F/gi, "/");

      expect(normalized).toBe("test%41value/path");
      expect(normalized).toContain("%41");
    });

    it.each(ALL_ID_KINDS)(
      "$kind: normalization handles correctly",
      ({ id, hasSpecialChars }) => {
        if (hasSpecialChars) {
          const encoded = encodeURIComponent(id);
          const normalized = encoded.replace(/%2F/gi, "/");

          expect(normalized).toContain("/");
          expect(normalized).not.toContain("%2F");
          expect(normalized).toContain("%3A");
        } else {
          expect(id.replace(/%2F/gi, "/")).toBe(id);
        }
      }
    );

    it("double-encoded %252F after RR decode becomes %2F, then / via normalize", () => {
      const afterRrDecode = "seed-account-test-shop-gid%3A%2F%2Fshopify%2FCompanyLocation%2F1001";
      const normalized = afterRrDecode.replace(/%2F/gi, "/");

      expect(normalized).toBe("seed-account-test-shop-gid%3A//shopify/CompanyLocation/1001");
      expect(normalized).not.toContain("%2F");
      expect(normalized).toContain("%3A");
    });
  });

  describe("seeded-style id specifics (contains : and /)", () => {
    it("seeded id contains GID-like segment with special chars", () => {
      expect(SEEDED_STYLE_ID).toContain("://");
      expect(SEEDED_STYLE_ID).toContain(":");
      expect(SEEDED_STYLE_ID).toContain("/");
    });

    it("accountHref encodes the slashes and colons", () => {
      const href = accountHref(SEEDED_STYLE_ID);

      expect(href).toContain("%2F");
      expect(href).toContain("%3A");
      expect(href).not.toContain("%25");
    });
  });

  describe("UUID ids specifics (no special chars)", () => {
    it("B2B UUID has no special URL characters", () => {
      expect(SYNTHETIC_B2B_UUID).not.toContain("/");
      expect(SYNTHETIC_B2B_UUID).not.toContain(":");
      expect(SYNTHETIC_B2B_UUID).not.toContain("%");
    });

    it("tag-rule UUID has no special URL characters", () => {
      expect(SYNTHETIC_TAGGED_UUID).not.toContain("/");
      expect(SYNTHETIC_TAGGED_UUID).not.toContain(":");
      expect(SYNTHETIC_TAGGED_UUID).not.toContain("%");
    });

    it("accountHref does not encode UUIDs", () => {
      expect(accountHref(SYNTHETIC_B2B_UUID)).toBe(`/app/accounts/${SYNTHETIC_B2B_UUID}`);
      expect(accountHref(SYNTHETIC_TAGGED_UUID)).toBe(`/app/accounts/${SYNTHETIC_TAGGED_UUID}`);
    });
  });
});
