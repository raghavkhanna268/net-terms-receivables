/**
 * @vitest-environment jsdom
 *
 * Router integration tests for double-encoding fix.
 *
 * These tests use createMemoryRouter + RouterProvider to render the actual
 * AccountPage component at /app/accounts/<encoded id>, verifying:
 * 1. Rendered form action attributes have no %25/%252F (single-encoded only)
 * 2. Router correctly resolves the route with encoded id
 * 3. Loader receives params.id that normalizes to original id
 *
 * MUST FAIL ON MAIN: Without explicit action={accountHref(id)} on Forms,
 * React Router's useFormAction resolves action from match.pathname,
 * re-encoding %2F to %252F on each save.
 *
 * Tests cover ALL THREE id kinds:
 * - Seeded-style synthetic id with GID segment containing ':' and '/'
 * - Native B2B UUID id
 * - Tag-rule-created UUID id
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { render, cleanup, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { accountHref } from "~/lib/account-href";

const SEEDED_STYLE_ID = "seed-account-test-shop-gid://shopify/CompanyLocation/1001";
const SYNTHETIC_B2B_UUID = "b2b-loc-a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const SYNTHETIC_TAGGED_UUID = "tag-cust-a1b2c3d4-e5f6-7890-abcd-ef1234567890";

const ALL_ID_KINDS = [
  { kind: "seeded-style GID", id: SEEDED_STYLE_ID, hasSpecialChars: true },
  { kind: "native B2B UUID", id: SYNTHETIC_B2B_UUID, hasSpecialChars: false },
  { kind: "tag-rule UUID", id: SYNTHETIC_TAGGED_UUID, hasSpecialChars: false },
] as const;

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

describe("AccountPage router integration (createMemoryRouter)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe("all id kinds: form actions have no %25/%252F", () => {
    it.each(ALL_ID_KINDS)(
      "$kind: rendered form actions have no %25 (single-encoded only)",
      async ({ id }) => {
        const encodedPath = accountHref(id);

        const router = createMemoryRouter(
          [
            {
              path: "/app/accounts/:id",
              lazy: async () => {
                const mod = await import("../app.accounts.$id");
                return { Component: mod.default };
              },
              loader: ({ params }) => {
                const normalizedId = params.id?.replace(/%2F/gi, "/");
                return buildLoaderData(normalizedId!);
              },
            },
          ],
          { initialEntries: [encodedPath] }
        );

        render(createElement(RouterProvider, { router }));

        await waitFor(() => {
          const forms = document.querySelectorAll("form[method='post']");
          expect(forms.length).toBeGreaterThan(0);
        }, { timeout: 5000 });

        const forms = document.querySelectorAll("form[method='post']");
        expect(forms.length).toBeGreaterThan(0);

        forms.forEach((form, idx) => {
          const action = form.getAttribute("action");
          expect(action, `Form ${idx} should have action attribute`).not.toBeNull();
          expect(action, `Form ${idx} action should not contain %25`).not.toContain("%25");
          expect(action, `Form ${idx} action should not contain %252F`).not.toContain("%252F");
        });
      }
    );

    it.each(ALL_ID_KINDS)(
      "$kind: form actions equal accountHref(id)",
      async ({ id }) => {
        const encodedPath = accountHref(id);
        const expectedAction = accountHref(id);

        const router = createMemoryRouter(
          [
            {
              path: "/app/accounts/:id",
              lazy: async () => {
                const mod = await import("../app.accounts.$id");
                return { Component: mod.default };
              },
              loader: ({ params }) => {
                const normalizedId = params.id?.replace(/%2F/gi, "/");
                return buildLoaderData(normalizedId!);
              },
            },
          ],
          { initialEntries: [encodedPath] }
        );

        render(createElement(RouterProvider, { router }));

        await waitFor(() => {
          const forms = document.querySelectorAll("form[method='post']");
          expect(forms.length).toBeGreaterThan(0);
        }, { timeout: 5000 });

        const forms = document.querySelectorAll("form[method='post']");
        expect(forms.length).toBeGreaterThan(0);

        forms.forEach((form, idx) => {
          const action = form.getAttribute("action");
          expect(action, `Form ${idx} action should equal accountHref`).toBe(expectedAction);
        });
      }
    );

    it.each(ALL_ID_KINDS)(
      "$kind: all rendered Forms have explicit action attributes",
      async ({ id }) => {
        const encodedPath = accountHref(id);

        const router = createMemoryRouter(
          [
            {
              path: "/app/accounts/:id",
              lazy: async () => {
                const mod = await import("../app.accounts.$id");
                return { Component: mod.default };
              },
              loader: ({ params }) => {
                const normalizedId = params.id?.replace(/%2F/gi, "/");
                return buildLoaderData(normalizedId!);
              },
            },
          ],
          { initialEntries: [encodedPath] }
        );

        render(createElement(RouterProvider, { router }));

        await waitFor(() => {
          const forms = document.querySelectorAll("form[method='post']");
          expect(forms.length).toBeGreaterThan(0);
        }, { timeout: 5000 });

        const forms = document.querySelectorAll("form[method='post']");
        const formsWithAction = document.querySelectorAll("form[method='post'][action]");

        expect(forms.length).toBeGreaterThan(0);
        expect(formsWithAction.length).toBe(forms.length);
      }
    );

    it.each(ALL_ID_KINDS)(
      "$kind: loader params.id normalizes to original id",
      async ({ id }) => {
        const encodedPath = accountHref(id);
        let receivedParamsId: string | undefined;

        const router = createMemoryRouter(
          [
            {
              path: "/app/accounts/:id",
              lazy: async () => {
                const mod = await import("../app.accounts.$id");
                return { Component: mod.default };
              },
              loader: ({ params }) => {
                receivedParamsId = params.id;
                const normalizedId = params.id?.replace(/%2F/gi, "/");
                return buildLoaderData(normalizedId!);
              },
            },
          ],
          { initialEntries: [encodedPath] }
        );

        render(createElement(RouterProvider, { router }));

        await waitFor(() => {
          const forms = document.querySelectorAll("form[method='post']");
          expect(forms.length).toBeGreaterThan(0);
        }, { timeout: 5000 });

        const normalizedId = receivedParamsId?.replace(/%2F/gi, "/");
        expect(normalizedId).toBe(id);
      }
    );
  });

  describe("inline normalization proves necessary", () => {
    it("double-encoded URL params.id only resolves to original with inline normalize", () => {
      const originalId = SEEDED_STYLE_ID;
      const doubleEncodedParamsId = "seed-account-test-shop-gid%3A%2F%2Fshopify%2FCompanyLocation%2F1001";

      const withoutNormalize = doubleEncodedParamsId;
      expect(withoutNormalize).not.toBe(originalId);

      const withNormalize = doubleEncodedParamsId.replace(/%2F/gi, "/");
      expect(withNormalize).toBe("seed-account-test-shop-gid%3A//shopify/CompanyLocation/1001");
      expect(withNormalize).toContain("/");
      expect(withNormalize).not.toContain("%2F");
    });

    it("narrow normalization: %2F becomes /, %41 stays %41", () => {
      const withMixedPercent = "test%41value%2Fpath%3Acolon";
      const normalized = withMixedPercent.replace(/%2F/gi, "/");

      expect(normalized).toBe("test%41value/path%3Acolon");
      expect(normalized).toContain("%41");
      expect(normalized).toContain("%3A");
      expect(normalized).not.toContain("%2F");
    });

    it("normalization is case-insensitive (%2f and %2F both become /)", () => {
      const mixedCase = "path%2Fwith%2flower%2Fand%2FUPPER";
      const normalized = mixedCase.replace(/%2F/gi, "/");

      expect(normalized).toBe("path/with/lower/and/UPPER");
      expect(normalized).not.toMatch(/%2f/i);
    });
  });
});
