/**
 * @vitest-environment jsdom
 *
 * Tests for decodeAccountIdParam helper in app.accounts.$id.tsx.
 *
 * Tests cover:
 * 1. Double-encoded ('%252F') seed-style URL resolves to the right account id
 * 2. Single-encoded and plain UUID ids are unchanged
 * 3. Decode stops at 3 iterations (4x-encoded stays partially encoded)
 * 4. Malformed '%E0%A4%A' value doesn't throw
 * 5. '%41' handling: decode-until-stable turns '%41' into 'A' (encoded ASCII)
 * 6. Router test: Form submit + reload keeps URL single-encoded, same account loads
 *
 * All tests use synthetic ids only (test-* style; no real GIDs or store handles).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { decodeAccountIdParam } from "../app.accounts.$id";
import { accountHref } from "~/lib/account-href";

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

const SEEDED_STYLE_ID = "test-seed-account/gid://shopify/CompanyLocation/1001";
const SYNTHETIC_UUID = "test-uuid-a1b2c3d4-e5f6-7890-abcd-ef1234567890";

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

describe("decodeAccountIdParam helper", () => {
  describe("double-encoded '%252F' (seed-style URL) resolves correctly", () => {
    it("decodes '%252F' to '/' in a seed-style id (loader scenario)", () => {
      const doubleEncoded = "test-seed-account%252Fgid%253A%252F%252Fshopify%252FCompanyLocation%252F1001";
      const result = decodeAccountIdParam(doubleEncoded);
      expect(result).toBe(SEEDED_STYLE_ID);
    });

    it("decodes '%252F' to '/' in a seed-style id (action scenario)", () => {
      const doubleEncoded = encodeURIComponent(encodeURIComponent(SEEDED_STYLE_ID));
      const result = decodeAccountIdParam(doubleEncoded);
      expect(result).toBe(SEEDED_STYLE_ID);
    });
  });

  describe("single-encoded and plain UUID ids are unchanged", () => {
    it("plain UUID id stays unchanged", () => {
      const result = decodeAccountIdParam(SYNTHETIC_UUID);
      expect(result).toBe(SYNTHETIC_UUID);
    });

    it("single-encoded seed-style id decodes once and stops", () => {
      const singleEncoded = encodeURIComponent(SEEDED_STYLE_ID);
      const result = decodeAccountIdParam(singleEncoded);
      expect(result).toBe(SEEDED_STYLE_ID);
    });

    it("plain seed-style id (already decoded) stays unchanged", () => {
      const result = decodeAccountIdParam(SEEDED_STYLE_ID);
      expect(result).toBe(SEEDED_STYLE_ID);
    });
  });

  describe("decode stops at 3 iterations (4x-encoded stays partially encoded)", () => {
    it("4x-encoded value stays partially encoded after 3 decodes", () => {
      const original = SEEDED_STYLE_ID;
      const quadEncoded = encodeURIComponent(
        encodeURIComponent(
          encodeURIComponent(encodeURIComponent(original))
        )
      );

      const result = decodeAccountIdParam(quadEncoded);

      expect(result).not.toBe(original);
      expect(result).toBe(encodeURIComponent(original));
    });

    it("3x-encoded value fully decodes to original", () => {
      const original = SEEDED_STYLE_ID;
      const tripleEncoded = encodeURIComponent(
        encodeURIComponent(encodeURIComponent(original))
      );

      const result = decodeAccountIdParam(tripleEncoded);
      expect(result).toBe(original);
    });
  });

  describe("malformed escape sequence handling", () => {
    it("malformed '%E0%A4%A' value does not throw", () => {
      const malformed = "test-account%E0%A4%A";
      expect(() => decodeAccountIdParam(malformed)).not.toThrow();
    });

    it("malformed '%E0%A4%A' returns input unchanged (last good value)", () => {
      const malformed = "test-account%E0%A4%A";
      const result = decodeAccountIdParam(malformed);
      expect(result).toBe(malformed);
    });

    it("malformed sequence mid-string preserves last good decode", () => {
      const doubleEncodedThenMalformed = encodeURIComponent("test-account%E0%A4%A");
      const result = decodeAccountIdParam(doubleEncodedThenMalformed);
      expect(result).toBe("test-account%E0%A4%A");
    });
  });

  describe("'%41' handling (encoded ASCII)", () => {
    /**
     * '%41' is the percent-encoded form of the ASCII character 'A' (0x41).
     * decode-until-stable will decode '%41' to 'A' because decodeURIComponent
     * correctly decodes all valid percent-encoded sequences.
     *
     * This is expected behavior: the helper decodes all valid sequences,
     * not just path-reserved characters. If a raw '%41' appears in a pasted
     * link, it becomes 'A' after decoding.
     */
    it("'%41' decodes to 'A' (expected: percent-encoded ASCII is decoded)", () => {
      const encoded = "test-%41ccount";
      const result = decodeAccountIdParam(encoded);
      expect(result).toBe("test-Account");
    });

    it("double-encoded '%2541' (which becomes '%41' then 'A') decodes fully", () => {
      const doubleEncoded = "test-%2541ccount";
      const result = decodeAccountIdParam(doubleEncoded);
      expect(result).toBe("test-Account");
    });
  });
});

describe("AccountPage router integration: re-encoded id handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("loader resolves double-encoded seed-style id to correct account", async () => {
    // Router decodes the path once, so to simulate a double-encoded link pasted,
    // we need to triple-encode so that after router decode we have double-encoded
    const tripleEncodedId = encodeURIComponent(encodeURIComponent(encodeURIComponent(SEEDED_STYLE_ID)));
    const tripleEncodedPath = `/app/accounts/${tripleEncodedId}`;

    let loaderReceivedId: string | undefined;
    let loaderDecodedId: string | undefined;

    const router = createMemoryRouter(
      [
        {
          path: "/app/accounts/:id",
          lazy: async () => {
            const mod = await import("../app.accounts.$id");
            return { Component: mod.default };
          },
          loader: ({ params }) => {
            loaderReceivedId = params.id;
            loaderDecodedId = params.id ? decodeAccountIdParam(params.id) : params.id;
            return buildLoaderData(loaderDecodedId!);
          },
        },
      ],
      { initialEntries: [tripleEncodedPath] }
    );

    render(createElement(RouterProvider, { router }));

    await waitFor(() => {
      const heading = document.querySelector("s-page");
      expect(heading).toBeInTheDocument();
    }, { timeout: 5000 });

    // Params.id should be double-encoded (after router decodes once)
    expect(loaderReceivedId).toBe(encodeURIComponent(encodeURIComponent(SEEDED_STYLE_ID)));
    // After our decode helper, it should be the original id
    expect(loaderDecodedId).toBe(SEEDED_STYLE_ID);
    const heading = document.querySelector("s-page");
    expect(heading?.getAttribute("heading")).toBe("Test Buyer Corp");
  });

  it("Form submit and reload: URL stays single-encoded, same account loads", async () => {
    const navigations: string[] = [];
    let actionCalled = false;
    let actionDecodedId: string | undefined;

    const router = createMemoryRouter(
      [
        {
          path: "/app/accounts/:id",
          lazy: async () => {
            const mod = await import("../app.accounts.$id");
            return { Component: mod.default };
          },
          loader: ({ params }) => {
            navigations.push(params.id!);
            const decodedId = params.id ? decodeAccountIdParam(params.id) : params.id;
            return buildLoaderData(decodedId!);
          },
          action: async ({ params, request }) => {
            actionCalled = true;
            actionDecodedId = params.id ? decodeAccountIdParam(params.id) : params.id;
            const formData = await request.formData();
            return {
              success: true,
              action: formData.get("_action"),
            };
          },
        },
      ],
      { initialEntries: [accountHref(SEEDED_STYLE_ID)] }
    );

    render(createElement(RouterProvider, { router }));

    await waitFor(() => {
      const forms = document.querySelectorAll("form[method='post']");
      expect(forms.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const creditForm = document.querySelector("form[method='post']") as HTMLFormElement;
    expect(creditForm).toBeInTheDocument();

    const actionInput = creditForm.querySelector("input[name='_action']") as HTMLInputElement;
    expect(actionInput).toBeInTheDocument();

    fireEvent.submit(creditForm);

    await waitFor(() => {
      expect(actionCalled).toBe(true);
    }, { timeout: 5000 });

    // Action decodes to the original id
    expect(actionDecodedId).toBe(SEEDED_STYLE_ID);

    router.navigate(accountHref(SEEDED_STYLE_ID));

    await waitFor(() => {
      expect(navigations.length).toBeGreaterThanOrEqual(2);
    }, { timeout: 5000 });

    // params.id after navigate should be the original (router decodes once)
    const lastNavId = navigations[navigations.length - 1];
    expect(lastNavId).toBe(SEEDED_STYLE_ID);
    expect(lastNavId).not.toContain("%25");

    const heading = document.querySelector("s-page");
    expect(heading?.getAttribute("heading")).toBe("Test Buyer Corp");
  });

  it("action resolves double-encoded seed-style id correctly", async () => {
    const doubleEncodedId = encodeURIComponent(encodeURIComponent(SEEDED_STYLE_ID));
    const doubleEncodedPath = `/app/accounts/${doubleEncodedId}`;

    let actionDecodedId: string | undefined;

    const router = createMemoryRouter(
      [
        {
          path: "/app/accounts/:id",
          lazy: async () => {
            const mod = await import("../app.accounts.$id");
            return { Component: mod.default };
          },
          loader: ({ params }) => {
            const decodedId = params.id ? decodeAccountIdParam(params.id) : params.id;
            return buildLoaderData(decodedId!);
          },
          action: async ({ params }) => {
            actionDecodedId = params.id ? decodeAccountIdParam(params.id) : params.id;
            return { success: true, action: "updateCredit" };
          },
        },
      ],
      { initialEntries: [doubleEncodedPath] }
    );

    render(createElement(RouterProvider, { router }));

    await waitFor(() => {
      const forms = document.querySelectorAll("form[method='post']");
      expect(forms.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const form = document.querySelector("form[method='post']") as HTMLFormElement;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(actionDecodedId).toBeDefined();
    }, { timeout: 5000 });

    expect(actionDecodedId).toBe(SEEDED_STYLE_ID);
  });
});
